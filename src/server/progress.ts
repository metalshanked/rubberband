import { logger } from './logger.js';

export type ProgressEvent = {
  id: number;
  at: string;
  level: 'info' | 'debug' | 'error';
  message: string;
  detail?: Record<string, unknown>;
};

type ProgressListener = (event: ProgressEvent) => void;

export class ProgressHub {
  private readonly listeners = new Set<ProgressListener>();
  private lastEvent?: ProgressEvent;
  private nextId = 1;

  constructor(private readonly sessionId: string) {}

  publish(message: string, detail?: Record<string, unknown>, level: ProgressEvent['level'] = 'info') {
    const event: ProgressEvent = {
      id: this.nextId,
      at: new Date().toISOString(),
      level,
      message,
      ...(detail ? { detail } : {})
    };
    this.nextId += 1;
    this.lastEvent = event;
    logger.debug('session progress', { sessionId: shortSessionId(this.sessionId), ...redactDetail(event) });
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: ProgressListener) {
    this.listeners.add(listener);
    if (this.lastEvent) listener(this.lastEvent);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function shortSessionId(sessionId: string) {
  return sessionId.slice(0, 8);
}

function redactDetail(event: ProgressEvent) {
  return {
    id: event.id,
    level: event.level,
    message: event.message,
    detail: event.detail
  };
}
