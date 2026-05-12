import type express from 'express';
import crypto from 'node:crypto';
import type { McpRegistry } from './mcp-registry.js';
import type { SessionSettingsStore, SettingsStore } from './settings.js';
import type { InstalledMcpApp } from './types.js';
import { McpRegistry as Registry } from './mcp-registry.js';
import { logger } from './logger.js';
import { ProgressHub } from './progress.js';

export type RubberbandSession = {
  id: string;
  settings: SessionSettingsStore;
  registry: McpRegistry;
  progress: ProgressHub;
  lastSeen: number;
};

const SESSION_COOKIE = 'rubberband_session';
const SESSION_HEADER = 'x-rubberband-session-id';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._:-]{16,160}$/;

export class SessionManager {
  private readonly sessions = new Map<string, RubberbandSession>();
  private lastCleanup = 0;

  constructor(
    private readonly apps: InstalledMcpApp[],
    private readonly settings: SettingsStore,
    private readonly ttlMs = Number(process.env.SESSION_TTL_MS || DEFAULT_TTL_MS)
  ) {}

  get(req: express.Request, res: express.Response) {
    this.cleanupIfNeeded();

    const requestedId = this.readRequestedSessionId(req);
    const id = requestedId || crypto.randomUUID();
    let session = this.sessions.get(id);

    if (!session) {
      const sessionSettings = this.settings.createSessionStore();
      session = {
        id,
        settings: sessionSettings,
        registry: Registry.fromApps(this.apps, sessionSettings),
        progress: new ProgressHub(id),
        lastSeen: Date.now()
      };
      this.sessions.set(id, session);
      logger.debug('created session', { sessionId: id.slice(0, 8) });
    }

    session.lastSeen = Date.now();
    this.writeSessionHeaders(req, res, session.id);
    return session;
  }

  async closeAll() {
    await Promise.all([...this.sessions.values()].map(session => session.registry.closeAll()));
    this.sessions.clear();
  }

  private readRequestedSessionId(req: express.Request) {
    const queryValue = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    if (queryValue && SESSION_ID_PATTERN.test(queryValue)) return queryValue;

    const headerValue = req.header(SESSION_HEADER);
    if (headerValue && SESSION_ID_PATTERN.test(headerValue)) return headerValue;

    const cookieValue = readCookie(req.header('cookie') || '', SESSION_COOKIE);
    if (cookieValue && SESSION_ID_PATTERN.test(cookieValue)) return cookieValue;

    return undefined;
  }

  private writeSessionHeaders(req: express.Request, res: express.Response, sessionId: string) {
    res.setHeader('X-Rubberband-Session-Id', sessionId);
    const secure = req.secure || req.header('x-forwarded-proto') === 'https';
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: this.ttlMs
    });
  }

  private cleanupIfNeeded() {
    const now = Date.now();
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;

    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > this.ttlMs) {
        this.sessions.delete(id);
        logger.debug('expired session', { sessionId: id.slice(0, 8) });
        void session.registry.closeAll();
      }
    }
  }
}

function readCookie(cookieHeader: string, name: string) {
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}
