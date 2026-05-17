import type { SettingsAccess } from './settings.js';

export type ElasticCcsSettings = {
  searchByDefault: boolean;
  enabled: boolean;
  configuredPatterns: string[];
  targets: string[];
  resolveTimeoutMs: number;
};

const defaultResolveTimeoutMs = 5000;

export function readElasticCcsSettings(settings: Pick<SettingsAccess, 'get'>): ElasticCcsSettings {
  const searchByDefault = isTruthy(settings.get('ELASTIC_CCS_SEARCH_BY_DEFAULT'));
  const configuredPatterns = parseElasticCcsPatterns(settings.get('ELASTIC_CCS_INDEX_PATTERNS'));
  const targets = normalizeElasticCcsTargets(configuredPatterns);
  const resolveTimeoutMs = readPositiveInteger(settings.get('ELASTIC_CCS_RESOLVE_TIMEOUT_MS'), defaultResolveTimeoutMs);

  return {
    searchByDefault,
    enabled: searchByDefault && targets.length > 0,
    configuredPatterns,
    targets,
    resolveTimeoutMs
  };
}

export function buildElasticCcsPromptGuidance(settings: Pick<SettingsAccess, 'get'>) {
  const ccs = readElasticCcsSettings(settings);
  if (!ccs.enabled) return '';

  return [
    `Elastic cross-cluster search is enabled by default for these target expressions: ${ccs.targets.join(', ')}.`,
    'Use these cross-cluster targets for Elastic search, security, observability, dashboard, and profiling requests unless the user explicitly asks for local-only indices or a different target.',
    'The patterns use Elasticsearch wildcard syntax, not regex. Preserve the configured target casing; Rubberband may resolve cluster alias wildcards case-insensitively during profiler preflight.'
  ].join('\n');
}

export function parseElasticCcsPatterns(raw: string) {
  return raw
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function normalizeElasticCcsTargets(patterns: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const pattern of patterns) {
    const value = normalizeElasticCcsTarget(pattern);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function normalizeElasticCcsTarget(pattern: string) {
  const value = pattern.trim();
  if (!value) return '';
  const separator = value.indexOf(':');
  if (separator === -1) return `${value}:*`;
  if (separator === value.length - 1) return `${value}*`;
  return value;
}

export function wildcardToRegExp(pattern: string, caseInsensitive = true) {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+.]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : undefined);
}

function readPositiveInteger(raw: string, fallback: number) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function isTruthy(value: string) {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
