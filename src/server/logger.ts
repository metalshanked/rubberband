type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const configuredLevel = normalizeLevel(process.env.SERVER_LOG_LEVEL) || (isTruthy(process.env.DEBUG_LOGGING) ? 'debug' : 'info');

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    write('debug', message, meta);
  },
  info(message: string, meta?: Record<string, unknown>) {
    write('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    write('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    write('error', message, meta);
  }
};

export function isDebugLoggingEnabled() {
  return levels[configuredLevel] <= levels.debug;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (levels[level] < levels[configuredLevel]) return;
  const payload = {
    at: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {})
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function normalizeLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error' ? normalized : undefined;
}

function isTruthy(value: unknown) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
