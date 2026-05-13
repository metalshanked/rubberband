import express from 'express';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpRegistry } from './mcp-registry.js';
import { runChat } from './openai-chat.js';
import { createSettingsStore, type SettingsAccess } from './settings.js';
import { SessionManager } from './session.js';
import { logger } from './logger.js';
import type { ProgressEvent } from './progress.js';
import { explainError, sanitizeErrorMessage } from './error-explainer.js';
import { AnalyticsProfileService } from './analytics-profile-service.js';
import { testExternalConnection, type ConnectionTestTarget } from './connection-tests.js';
import { applyDemoConnectionChecks, buildDemoPlan } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const clientDir = path.resolve(rootDir, 'dist/client');
const manifestPath = path.resolve(rootDir, process.env.MCP_APPS_MANIFEST || 'mcp-apps.installed.json');
const analyticsProfileStoragePath = path.resolve(rootDir, process.env.ANALYTICS_PROFILER_STORAGE_FILE || '.rubberband/analytics-profile.json');
const packageJson = readPackageJson();
const defaultPort = 8765;
const basePath = normalizeBasePath(process.env.BASE_PATH || '');

const chatBodySchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      attachments: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            mimeType: z.string().regex(/^image\//),
            dataUrl: z.string().regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/),
            size: z.number().optional()
          })
        )
        .max(4)
        .optional()
    })
  ),
  appIds: z.array(z.string()).optional(),
  deepAnalysis: z.boolean().optional()
});

const toolBodySchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({})
});

const resourceBodySchema = z.object({
  uri: z.string()
});

const settingsBodySchema = z.object({
  values: z.record(z.string(), z.unknown())
});

const settingsTestBodySchema = z.object({
  target: z.enum(['llm', 'elastic', 'kibana', 'trino', 'starburst']),
  values: z.record(z.string(), z.unknown()).default({})
});

const demoBodySchema = z.object({
  appIds: z.array(z.string()).optional()
});

async function main() {
  const app = express();
  const router = express.Router();
  const settings = createSettingsStore(rootDir);
  const installedApps = await McpRegistry.loadApps(manifestPath);
  const sessions = new SessionManager(installedApps, settings);
  const analyticsProfiles = new AnalyticsProfileService(settings, analyticsProfileStoragePath);
  analyticsProfiles.start();

  app.use(express.json({ limit: '16mb' }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.debug('http request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started
      });
    });
    next();
  });

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/api/about', (_req, res) => {
    res.json(buildAboutInfo());
  });

  router.get('/api/session', (req, res) => {
    const session = sessions.get(req, res);
    res.json({ sessionId: session.id });
  });

  router.get('/api/events', (req, res) => {
    const session = sessions.get(req, res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: ProgressEvent) => {
      res.write(`id: ${event.id}\n`);
      res.write('event: progress\n');
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    res.write('retry: 1500\n\n');
    const unsubscribe = session.progress.subscribe(send);
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25_000);

    logger.debug('opened progress stream', { sessionId: session.id.slice(0, 8) });
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      logger.debug('closed progress stream', { sessionId: session.id.slice(0, 8) });
    });
  });

  router.get('/api/apps', (req, res) => {
    const session = sessions.get(req, res);
    logger.debug('listing apps', { sessionId: session.id.slice(0, 8) });
    res.json({ apps: session.registry.listApps() });
  });

  router.post('/api/apps/refresh', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      logger.info('reloading MCP apps', { sessionId: session.id.slice(0, 8) });
      session.progress.publish('Reloading MCP apps and tools');
      await session.registry.reconnectAll();
      const tools = await session.registry.listTools();
      res.json({ apps: session.registry.listApps(), tools });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/settings', (req, res) => {
    const session = sessions.get(req, res);
    res.json(session.settings.snapshot());
  });

  router.post('/api/settings', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = settingsBodySchema.parse(req.body);
      const changedKeys = session.settings.update(body.values);
      logger.info('settings updated', { sessionId: session.id.slice(0, 8), changedKeys });
      if (changedKeys.some(key => !key.startsWith('OPENAI_'))) {
        session.progress.publish('Reloading MCP apps after settings change');
        await session.registry.reconnectAll();
      }
      if (changedKeys.some(key => key.startsWith('ANALYTICS_PROFILER_') || key.endsWith('_PROFILER_TIMEOUT_MS') || key.startsWith('TRINO_PROFILER_') || key.startsWith('ELASTIC_PROFILER_'))) {
        analyticsProfiles.updateSettings(session.settings);
        void analyticsProfiles.refreshNow('settings');
      }
      res.json({ ...session.settings.snapshot(), changedKeys });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/settings/test', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = settingsTestBodySchema.parse(req.body);
      const candidateSettings = createCandidateSettings(session.settings, body.values);
      logger.info('testing external connection', { sessionId: session.id.slice(0, 8), target: body.target });
      res.json(await testExternalConnection(candidateSettings, body.target));
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/tools', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      session.progress.publish('Discovering MCP tools');
      res.json({ tools: await session.registry.listTools() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/mcp/exposure', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      res.json(await session.registry.listExposure());
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/demo', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = demoBodySchema.parse(req.body || {});
      session.progress.publish('Checking live demo readiness');
      const apps = session.registry.listApps();
      const tools = await session.registry.listTools().catch(() => []);
      const plan = buildDemoPlan(apps, tools as never, body.appIds || []);
      const connectionChecks = plan.ok ? await runDemoConnectionChecks(session.settings, plan.requiredConnections) : [];
      res.json(applyDemoConnectionChecks(plan, connectionChecks));
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/analytics-profile', (_req, res) => {
    res.json(analyticsProfiles.snapshot());
  });

  router.post('/api/analytics-profile/refresh', async (_req, res, next) => {
    try {
      await analyticsProfiles.refreshNow('api');
      res.json(analyticsProfiles.snapshot());
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/apps/:appId/tools/call', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = toolBodySchema.parse(req.body);
      session.progress.publish(`Running ${req.params.appId} tool`);
      const result = await session.registry.callTool(req.params.appId, String(req.query.name || req.body.name), body.arguments);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/apps/:appId/resources/read', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = resourceBodySchema.parse(req.body);
      res.json(await session.registry.readResource(req.params.appId, body.uri));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/apps/:appId/resources/list', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      res.json(await session.registry.listResources(req.params.appId, req.body?.cursor));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/apps/:appId/resources/templates/list', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      res.json(await session.registry.listResourceTemplates(req.params.appId, req.body?.cursor));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/apps/:appId/prompts/list', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      res.json(await session.registry.listPrompts(req.params.appId, req.body?.cursor));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/chat', async (req, res, next) => {
    try {
      const session = sessions.get(req, res);
      const body = chatBodySchema.parse(req.body);
      logger.info('chat started', {
        sessionId: session.id.slice(0, 8),
        messageCount: body.messages.length,
        appIds: body.appIds || [],
        deepAnalysis: body.deepAnalysis === true
      });
      const result = await runChat(session.registry, session.settings, body.messages, body.appIds, (message, detail) => {
        session.progress.publish(message, detail);
      }, analyticsProfiles, { deepAnalysis: body.deepAnalysis === true });
      logger.info('chat completed', {
        sessionId: session.id.slice(0, 8),
        toolCallCount: result.toolCalls?.length || 0
      });
      res.json(result);
    } catch (error) {
      const session = sessions.get(req, res);
      session.progress.publish('Request failed', { error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) }, 'error');
      next(error);
    }
  });

  router.use(express.static(clientDir));
  router.get(/.*/, (req, res) => {
    sessions.get(req, res);
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  if (basePath) {
    app.get('/', (_req, res) => res.redirect(308, `${basePath}/`));
    app.use((req, res, next) => {
      if (req.path === basePath && !req.originalUrl.startsWith(`${basePath}/`)) {
        const suffix = req.originalUrl.slice(basePath.length);
        res.redirect(308, `${basePath}/${suffix.startsWith('?') ? suffix : ''}`);
        return;
      }
      next();
    });
  }
  app.use(basePath || '/', router);

  app.use(async (error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('request failed', { error: message });
    if (res.headersSent) return;
    const statusCode = readHttpStatus(error);
    const session = sessions.get(req, res);
    const explanation = await explainError(error, session.settings, {
      method: req.method,
      path: req.path,
      appId: typeof req.params?.appId === 'string' ? req.params.appId : undefined,
      toolName: typeof req.query?.name === 'string' ? req.query.name : typeof req.body?.name === 'string' ? req.body.name : undefined
    });
    res.status(statusCode).json({ error: explanation.headline, technicalError: explanation.technicalSummary, explanation });
  });

  const port = Number(process.env.PORT || defaultPort);
  const server = app.listen(port, () => {
    console.log(`Rubberband MCP chat listening on http://0.0.0.0:${port}${basePath || '/'}`);
  });
  if (isTruthy(process.env.MCP_EXPOSURE_REPORT_ON_STARTUP || '')) {
    void logStartupMcpExposure(installedApps, settings);
  }

  const shutdown = () => {
    server.close(() => {
      analyticsProfiles.stop();
      void sessions.closeAll().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    throw new Error('BASE_PATH must be a path such as /rubberband, not a full URL.');
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  if (!withoutTrailingSlash || withoutTrailingSlash === '/') return '';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(withoutTrailingSlash)) {
    throw new Error(`Invalid BASE_PATH: ${value}`);
  }
  return withoutTrailingSlash;
}

function createCandidateSettings(base: SettingsAccess, values: Record<string, unknown>) {
  const editableKeys = new Set(base.snapshot().fields.filter(field => !field.locked).map(field => field.key));
  const overrides = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (!editableKeys.has(key)) continue;
    if (typeof value === 'string') {
      overrides.set(key, value.trim());
    } else if (typeof value === 'boolean') {
      overrides.set(key, value ? 'true' : '');
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      overrides.set(key, String(value));
    }
  }

  return {
    get: (key: string) => overrides.get(key) ?? base.get(key),
    isInsecureTlsEnabled: () => (overrides.has('ALLOW_INSECURE_TLS') ? isTruthy(overrides.get('ALLOW_INSECURE_TLS') || '') : base.isInsecureTlsEnabled())
  };
}

function isTruthy(value: string) {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

async function runDemoConnectionChecks(settings: SettingsAccess, targets: ConnectionTestTarget[]) {
  const uniqueTargets = [...new Set(targets)];
  if (!uniqueTargets.length) return [];
  return Promise.all(uniqueTargets.map(target => testExternalConnection(settings, target)));
}

function readHttpStatus(error: unknown) {
  const status = (error as { status?: unknown; statusCode?: unknown } | undefined)?.statusCode ?? (error as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

function readPackageJson() {
  const raw = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  return JSON.parse(raw) as {
    name?: string;
    version?: string;
    description?: string;
    license?: string;
  };
}

function buildAboutInfo() {
  const commit = readBuildValue(['RUBBERBAND_BUILD_COMMIT', 'BUILD_COMMIT', 'GIT_COMMIT', 'SOURCE_COMMIT']) || readGitValue(['rev-parse', 'HEAD']);
  const shortCommit = readBuildValue(['RUBBERBAND_BUILD_SHA', 'BUILD_SHA', 'GIT_SHA']) || (commit ? commit.slice(0, 12) : readGitValue(['rev-parse', '--short=12', 'HEAD']));
  const branch = readBuildValue(['RUBBERBAND_BUILD_BRANCH', 'BUILD_BRANCH', 'GIT_BRANCH']) || readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    name: 'Rubberband',
    packageName: packageJson.name || 'rubberband-mcp-chat',
    version: packageJson.version || '0.0.0',
    description: packageJson.description || '',
    license: packageJson.license || '',
    build: {
      builtAt: readBuildValue(['RUBBERBAND_BUILD_DATE', 'BUILD_DATE', 'BUILD_TIME']) || readDistBuildTime(),
      commit: commit || '',
      shortCommit: shortCommit || '',
      branch: branch === 'HEAD' ? '' : branch || '',
      node: process.version
    }
  };
}

function readBuildValue(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return '';
}

function readDistBuildTime() {
  const candidates = [path.join(clientDir, 'index.html'), fileURLToPath(import.meta.url)];
  for (const candidate of candidates) {
    try {
      return fs.statSync(candidate).mtime.toISOString();
    } catch {
    }
  }
  return '';
}

function readGitValue(args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500
    }).trim();
  } catch {
    return '';
  }
}

async function logStartupMcpExposure(installedApps: Awaited<ReturnType<typeof McpRegistry.loadApps>>, settings: SettingsAccess) {
  const registry = McpRegistry.fromApps(installedApps, settings);
  try {
    const report = await registry.listExposure();
    logger.info('mcp exposure report', {
      readOnlyMode: report.readOnlyMode,
      policy: report.policy,
      totals: report.totals,
      apps: report.apps.map(app => ({
        id: app.id,
        name: app.name,
        status: app.status,
        exposed: app.exposed,
        reason: app.reason,
        exposedToolCount: app.exposedToolCount,
        hiddenToolCount: app.hiddenToolCount,
        ...(app.error ? { error: app.error } : {})
      })),
      hiddenApps: report.hiddenApps.map(app => app.id),
      tools: report.tools.map(tool => `${tool.appId}:${tool.name}`),
      hiddenTools: report.hiddenTools.map(tool => `${tool.appId}:${tool.name}`)
    });
  } catch (error) {
    logger.warn('failed to build mcp exposure report', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await registry.closeAll().catch(() => undefined);
  }
}
