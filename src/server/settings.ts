import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export type SettingField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'checkbox' | 'textarea';
  group: 'llm' | 'elastic' | 'kibana' | 'trino' | 'viz' | 'domain' | 'mcp' | 'profiler' | 'advanced';
  sensitive?: boolean;
  locked: boolean;
  hasValue: boolean;
  value: string;
  defaultValue: string;
  source: 'env' | 'runtime' | 'default' | 'empty';
};

export type SettingsSnapshot = {
  fields: SettingField[];
};

export type SettingsAccess = {
  get(key: string): string;
  isInsecureTlsEnabled(): boolean;
  getEnvFor(keys: string[]): Record<string, string>;
  snapshot(): SettingsSnapshot;
  update(values: Record<string, unknown>): string[];
};

const settingDefs: Array<Omit<SettingField, 'locked' | 'hasValue' | 'value' | 'defaultValue' | 'source'>> = [
  { key: 'OPENAI_BASE_URL', label: 'LLM API base URL', type: 'text', group: 'llm' },
  { key: 'OPENAI_API_KEY', label: 'LLM API key', type: 'password', group: 'llm' },
  { key: 'OPENAI_AUTH_SCHEME', label: 'LLM auth scheme', type: 'text', group: 'llm' },
  { key: 'OPENAI_MODEL', label: 'Model', type: 'text', group: 'llm' },
  { key: 'OPENAI_TEMPERATURE', label: 'Temperature', type: 'text', group: 'llm' },
  { key: 'OPENAI_TOP_P', label: 'Top P', type: 'text', group: 'llm' },
  { key: 'OPENAI_MAX_TOKENS', label: 'Max output tokens', type: 'text', group: 'llm' },
  { key: 'OPENAI_TIMEOUT_MS', label: 'LLM request timeout ms', type: 'text', group: 'llm' },
  { key: 'OPENAI_EXTRA_HEADERS', label: 'Extra headers JSON', type: 'textarea', group: 'llm', sensitive: true },
  { key: 'OPENAI_EXTRA_BODY', label: 'Extra request body JSON', type: 'textarea', group: 'llm' },
  { key: 'ELASTICSEARCH_URL', label: 'Elasticsearch URL', type: 'text', group: 'elastic' },
  { key: 'ELASTICSEARCH_CLOUD_ID', label: 'Elastic Cloud ID', type: 'text', group: 'elastic' },
  { key: 'ELASTICSEARCH_USERNAME', label: 'Elasticsearch user', type: 'text', group: 'elastic' },
  { key: 'ELASTICSEARCH_PASSWORD', label: 'Elasticsearch password', type: 'password', group: 'elastic' },
  { key: 'ELASTICSEARCH_API_KEY', label: 'Elasticsearch API key', type: 'password', group: 'elastic' },
  { key: 'ELASTICSEARCH_AUTO_CREATE_API_KEY', label: 'Auto-create Elasticsearch API key', type: 'checkbox', group: 'elastic' },
  { key: 'ELASTIC_CCS_SEARCH_BY_DEFAULT', label: 'Elastic CCS search by default', type: 'checkbox', group: 'elastic' },
  { key: 'ELASTIC_CCS_INDEX_PATTERNS', label: 'Elastic CCS index patterns', type: 'textarea', group: 'elastic' },
  { key: 'ELASTIC_CCS_RESOLVE_TIMEOUT_MS', label: 'Elastic CCS resolve timeout ms', type: 'text', group: 'elastic' },
  { key: 'CLUSTERS_JSON', label: 'Elastic clusters JSON', type: 'textarea', group: 'elastic', sensitive: true },
  { key: 'CLUSTERS_FILE', label: 'Elastic clusters file', type: 'text', group: 'elastic' },
  { key: 'KIBANA_URL', label: 'Kibana URL', type: 'text', group: 'kibana' },
  { key: 'KIBANA_SPACE_ID', label: 'Kibana space ID', type: 'text', group: 'kibana' },
  { key: 'KIBANA_USERNAME', label: 'Kibana user', type: 'text', group: 'kibana' },
  { key: 'KIBANA_PASSWORD', label: 'Kibana password', type: 'password', group: 'kibana' },
  { key: 'KIBANA_API_KEY', label: 'Kibana API key', type: 'password', group: 'kibana' },
  { key: 'TRINO_HOST', label: 'Trino host', type: 'text', group: 'trino' },
  { key: 'TRINO_PORT', label: 'Trino port', type: 'text', group: 'trino' },
  { key: 'TRINO_SCHEME', label: 'Trino scheme', type: 'text', group: 'trino' },
  { key: 'TRINO_SSL', label: 'Trino SSL', type: 'text', group: 'trino' },
  { key: 'TRINO_USER', label: 'Trino user', type: 'text', group: 'trino' },
  { key: 'TRINO_PASSWORD', label: 'Trino password', type: 'password', group: 'trino' },
  { key: 'TRINO_ACCESS_TOKEN', label: 'Trino access token', type: 'password', group: 'trino' },
  { key: 'TRINO_AUTH_TYPE', label: 'Trino auth type', type: 'text', group: 'trino' },
  { key: 'TRINO_CATALOG', label: 'Trino catalog', type: 'text', group: 'trino' },
  { key: 'TRINO_SCHEMA', label: 'Trino schema', type: 'text', group: 'trino' },
  { key: 'TRINO_SOURCE', label: 'Trino source', type: 'text', group: 'trino' },
  { key: 'TRINO_INSECURE_TLS', label: 'Trino insecure TLS', type: 'checkbox', group: 'trino' },
  { key: 'TRINO_CA_CERT_FILE', label: 'Trino CA cert file', type: 'text', group: 'trino' },
  { key: 'TRINO_CA_CERT', label: 'Trino CA cert PEM', type: 'textarea', group: 'trino' },
  { key: 'TRINO_CLIENT_CERT_FILE', label: 'Trino client cert file', type: 'text', group: 'trino' },
  { key: 'TRINO_CLIENT_CERT', label: 'Trino client cert PEM', type: 'textarea', group: 'trino' },
  { key: 'TRINO_CLIENT_KEY_FILE', label: 'Trino client key file', type: 'text', group: 'trino' },
  { key: 'TRINO_CLIENT_KEY', label: 'Trino client key PEM', type: 'textarea', group: 'trino' },
  { key: 'TRINO_CLIENT_KEY_PASSPHRASE', label: 'Trino client key passphrase', type: 'password', group: 'trino' },
  { key: 'STARBURST_HOST', label: 'Starburst host', type: 'text', group: 'trino' },
  { key: 'STARBURST_PORT', label: 'Starburst port', type: 'text', group: 'trino' },
  { key: 'STARBURST_SCHEME', label: 'Starburst scheme', type: 'text', group: 'trino' },
  { key: 'STARBURST_USER', label: 'Starburst user', type: 'text', group: 'trino' },
  { key: 'STARBURST_PASSWORD', label: 'Starburst password', type: 'password', group: 'trino' },
  { key: 'STARBURST_ACCESS_TOKEN', label: 'Starburst access token', type: 'password', group: 'trino' },
  { key: 'STARBURST_CATALOG', label: 'Starburst catalog', type: 'text', group: 'trino' },
  { key: 'STARBURST_SCHEMA', label: 'Starburst schema', type: 'text', group: 'trino' },
  { key: 'STARBURST_INSECURE_TLS', label: 'Starburst insecure TLS', type: 'checkbox', group: 'trino' },
  { key: 'STARBURST_CA_CERT_FILE', label: 'Starburst CA cert file', type: 'text', group: 'trino' },
  { key: 'STARBURST_CLIENT_CERT_FILE', label: 'Starburst client cert file', type: 'text', group: 'trino' },
  { key: 'STARBURST_CLIENT_KEY_FILE', label: 'Starburst client key file', type: 'text', group: 'trino' },
  { key: 'RUBBERBAND_VIZ_THEME', label: 'Viz theme', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_PALETTE', label: 'Viz palette', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_DENSITY', label: 'Viz density', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_LEGEND', label: 'Viz legend placement', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_TOOLTIP', label: 'Viz tooltip mode', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_TIMEZONE', label: 'Viz timezone', type: 'text', group: 'viz' },
  { key: 'RUBBERBAND_VIZ_NATIVE_FEATURES', label: 'Prefer native app features', type: 'checkbox', group: 'viz' },
  { key: 'DOMAIN_KNOWLEDGE', label: 'Domain knowledge', type: 'textarea', group: 'domain' },
  { key: 'MCP_ENABLED_APPS', label: 'MCP enabled apps', type: 'textarea', group: 'mcp' },
  { key: 'MCP_DISABLED_APPS', label: 'MCP disabled apps', type: 'textarea', group: 'mcp' },
  { key: 'MCP_ENABLED_TOOLS', label: 'MCP enabled tools', type: 'textarea', group: 'mcp' },
  { key: 'MCP_DISABLED_TOOLS', label: 'MCP disabled tools', type: 'textarea', group: 'mcp' },
  { key: 'MCP_READ_ONLY_MODE', label: 'MCP read-only mode', type: 'checkbox', group: 'mcp' },
  { key: 'MCP_READ_ONLY_TOOL_ALLOWLIST', label: 'MCP read-only tool allowlist', type: 'textarea', group: 'mcp' },
  { key: 'ANALYTICS_PROFILER_ENABLED', label: 'Analytics profiler enabled', type: 'checkbox', group: 'profiler' },
  { key: 'ANALYTICS_PROFILER_RUN_ON_STARTUP', label: 'Analytics profiler run on startup', type: 'checkbox', group: 'profiler' },
  { key: 'ANALYTICS_PROFILER_TARGETS', label: 'Analytics profiler targets', type: 'text', group: 'profiler' },
  { key: 'ANALYTICS_PROFILER_SCHEDULE_MS', label: 'Analytics profiler schedule ms', type: 'text', group: 'profiler' },
  { key: 'ANALYTICS_PROFILER_STALE_AFTER_MS', label: 'Analytics profiler stale after ms', type: 'text', group: 'profiler' },
  { key: 'ANALYTICS_PROFILER_STORAGE_FILE', label: 'Analytics profiler storage file', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_MAX_INDICES', label: 'Elastic profiler max targets', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_MAX_FIELD_CAPS', label: 'Elastic profiler field-inspected targets', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_MAX_FIELDS_PER_INDEX', label: 'Elastic profiler max fields per target', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_TIMEOUT_MS', label: 'Elastic profiler request timeout ms', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_INCLUDED_PATTERNS', label: 'Elastic profiler included patterns', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_EXCLUDED_PATTERNS', label: 'Elastic profiler excluded patterns', type: 'text', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_INCLUDE_DATA_STREAMS', label: 'Elastic profiler include data streams', type: 'checkbox', group: 'profiler' },
  { key: 'ELASTIC_PROFILER_INCLUDE_SYSTEM', label: 'Elastic profiler include system indices', type: 'checkbox', group: 'profiler' },
  { key: 'TRINO_PROFILER_MAX_CATALOGS', label: 'Trino profiler max catalogs', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_MAX_TABLES_PER_CATALOG', label: 'Trino profiler max tables per catalog', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_MAX_COLUMN_TABLES_PER_CATALOG', label: 'Trino profiler column-inspected tables per catalog', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_MAX_COLUMNS_PER_CATALOG', label: 'Trino profiler max columns per catalog', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_INCLUDED_CATALOGS', label: 'Trino profiler included catalogs', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_EXCLUDED_CATALOGS', label: 'Trino profiler excluded catalogs', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_CONCURRENCY', label: 'Trino profiler metadata concurrency', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_CACHE_TTL_MS', label: 'Trino profiler cache ttl ms', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_TIMEOUT_MS', label: 'Trino profiler timeout ms', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_STATEMENT_TIMEOUT_MS', label: 'Trino profiler statement timeout ms', type: 'text', group: 'profiler' },
  { key: 'TRINO_PROFILER_MAX_PAGES_PER_STATEMENT', label: 'Trino profiler max pages per statement', type: 'text', group: 'profiler' },
  { key: 'ERROR_EXPLANATION_TIMEOUT_MS', label: 'Error explanation timeout ms', type: 'text', group: 'advanced' },
  { key: 'ALLOW_INSECURE_TLS', label: 'Master insecure TLS', type: 'checkbox', group: 'advanced' }
];

const defaults: Record<string, string> = {
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_AUTH_SCHEME: 'Bearer',
  OPENAI_MODEL: 'gpt-4.1-mini',
  OPENAI_TEMPERATURE: '',
  OPENAI_TOP_P: '',
  OPENAI_MAX_TOKENS: '',
  OPENAI_TIMEOUT_MS: '90000',
  OPENAI_EXTRA_HEADERS: '',
  OPENAI_EXTRA_BODY: '',
  ELASTICSEARCH_AUTO_CREATE_API_KEY: '',
  ELASTIC_CCS_SEARCH_BY_DEFAULT: '',
  ELASTIC_CCS_INDEX_PATTERNS: '',
  ELASTIC_CCS_RESOLVE_TIMEOUT_MS: '5000',
  CLUSTERS_JSON: '',
  CLUSTERS_FILE: '',
  RUBBERBAND_VIZ_THEME: 'light',
  RUBBERBAND_VIZ_PALETTE: 'elastic',
  RUBBERBAND_VIZ_DENSITY: 'comfortable',
  RUBBERBAND_VIZ_LEGEND: 'right',
  RUBBERBAND_VIZ_TOOLTIP: 'shared',
  RUBBERBAND_VIZ_TIMEZONE: 'browser',
  RUBBERBAND_VIZ_NATIVE_FEATURES: 'true',
  ANALYTICS_PROFILER_ENABLED: 'true',
  ANALYTICS_PROFILER_RUN_ON_STARTUP: 'true',
  ANALYTICS_PROFILER_TARGETS: 'all',
  ANALYTICS_PROFILER_SCHEDULE_MS: '86400000',
  ANALYTICS_PROFILER_STALE_AFTER_MS: '86400000',
  ANALYTICS_PROFILER_STORAGE_FILE: '.rubberband/analytics-profile.json',
  ELASTIC_PROFILER_MAX_INDICES: '40',
  ELASTIC_PROFILER_MAX_FIELD_CAPS: '12',
  ELASTIC_PROFILER_MAX_FIELDS_PER_INDEX: '80',
  ELASTIC_PROFILER_TIMEOUT_MS: '8000',
  ELASTIC_PROFILER_INCLUDED_PATTERNS: '',
  ELASTIC_PROFILER_EXCLUDED_PATTERNS: '.*,ilm-history-*,slm-history-*',
  ELASTIC_PROFILER_INCLUDE_DATA_STREAMS: 'true',
  ELASTIC_PROFILER_INCLUDE_SYSTEM: '',
  TRINO_PROFILER_MAX_CATALOGS: '8',
  TRINO_PROFILER_MAX_TABLES_PER_CATALOG: '30',
  TRINO_PROFILER_MAX_COLUMN_TABLES_PER_CATALOG: '12',
  TRINO_PROFILER_MAX_COLUMNS_PER_CATALOG: '600',
  TRINO_PROFILER_INCLUDED_CATALOGS: '',
  TRINO_PROFILER_EXCLUDED_CATALOGS: 'system,jmx,memory,information_schema',
  TRINO_PROFILER_CONCURRENCY: '3',
  TRINO_PROFILER_CACHE_TTL_MS: '86400000',
  TRINO_PROFILER_TIMEOUT_MS: '12000',
  TRINO_PROFILER_STATEMENT_TIMEOUT_MS: '60000',
  TRINO_PROFILER_MAX_PAGES_PER_STATEMENT: '80',
  ERROR_EXPLANATION_TIMEOUT_MS: '3500',
  MCP_ENABLED_APPS: '',
  MCP_DISABLED_APPS: '',
  MCP_ENABLED_TOOLS: '',
  MCP_DISABLED_TOOLS: '',
  MCP_READ_ONLY_MODE: 'true',
  MCP_READ_ONLY_TOOL_ALLOWLIST: ''
};

export class SettingsStore {
  private readonly lockedKeys = new Set<string>();

  constructor(private readonly envPath: string) {
    this.loadEnv();
    this.applyProcessTlsSetting();
  }

  get(key: string): string {
    if (key === 'NODE_TLS_REJECT_UNAUTHORIZED') {
      return this.isInsecureTlsEnabled() ? '0' : process.env.NODE_TLS_REJECT_UNAUTHORIZED || '';
    }
    return process.env[key] || defaults[key] || '';
  }

  getEnvFor(keys: string[]) {
    const env: Record<string, string> = {};
    for (const key of keys) {
      const value = this.get(key);
      if (value) env[key] = value;
    }
    return env;
  }

  snapshot(): SettingsSnapshot {
    return this.snapshotWithRuntime(new Map());
  }

  update(values: Record<string, unknown>) {
    return this.updateRuntime(new Map(), values);
  }

  createSessionStore() {
    return new SessionSettingsStore(this);
  }

  snapshotWithRuntime(runtimeValues: Map<string, string>): SettingsSnapshot {
    return {
      fields: settingDefs.map(def => {
        const locked = this.lockedKeys.has(def.key);
        const source = locked ? 'env' : runtimeValues.has(def.key) ? 'runtime' : defaults[def.key] ? 'default' : 'empty';
        const value = def.type === 'checkbox' ? String(this.getCheckboxValue(runtimeValues, def.key)) : this.getWithRuntime(runtimeValues, def.key);
        return {
          ...def,
          locked,
          hasValue: Boolean(value),
          value: (def.type === 'password' || def.sensitive) && locked ? '' : value,
          defaultValue: defaults[def.key] || '',
          source
        };
      })
    };
  }

  updateRuntime(runtimeValues: Map<string, string>, values: Record<string, unknown>) {
    const allowed = new Map(settingDefs.map(def => [def.key, def]));
    const changedKeys: string[] = [];

    for (const [key, rawValue] of Object.entries(values)) {
      const def = allowed.get(key);
      if (!def || this.lockedKeys.has(key)) continue;
      const value = def.type === 'checkbox' ? normalizeBooleanValue(rawValue) : typeof rawValue === 'string' ? normalizeStringValue(key, rawValue) : '';
      const previous = runtimeValues.get(key) || '';
      if (value) {
        runtimeValues.set(key, value);
      } else {
        runtimeValues.delete(key);
      }
      if (previous !== value) changedKeys.push(key);
    }

    return changedKeys;
  }

  getWithRuntime(runtimeValues: Map<string, string>, key: string): string {
    if (key === 'NODE_TLS_REJECT_UNAUTHORIZED') {
      return this.isInsecureTlsEnabled(runtimeValues) ? '0' : process.env.NODE_TLS_REJECT_UNAUTHORIZED || '';
    }
    return runtimeValues.get(key) || this.get(key);
  }

  isInsecureTlsEnabled(runtimeValues?: Map<string, string>) {
    return isTruthy(runtimeValues?.get('ALLOW_INSECURE_TLS')) || isTruthy(process.env.ALLOW_INSECURE_TLS) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  }

  private getCheckboxValue(runtimeValues: Map<string, string>, key: string) {
    if (key === 'ALLOW_INSECURE_TLS') return this.isInsecureTlsEnabled(runtimeValues);
    return isTruthy(this.getWithRuntime(runtimeValues, key));
  }

  private loadEnv() {
    if (fs.existsSync(this.envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(this.envPath));
      for (const [key, value] of Object.entries(parsed)) {
        if (value) {
          process.env[key] = process.env[key] || value;
          this.lockedKeys.add(key);
        }
      }
    }

    for (const def of settingDefs) {
      if (process.env[def.key]) this.lockedKeys.add(def.key);
    }

    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
      this.lockedKeys.add('ALLOW_INSECURE_TLS');
    }
  }

  private applyProcessTlsSetting() {
    if (this.isInsecureTlsEnabled()) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    } else if (!this.lockedKeys.has('ALLOW_INSECURE_TLS')) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }
}

export class SessionSettingsStore implements SettingsAccess {
  private readonly runtimeValues = new Map<string, string>();

  constructor(private readonly base: SettingsStore) {}

  get(key: string): string {
    return this.base.getWithRuntime(this.runtimeValues, key);
  }

  isInsecureTlsEnabled() {
    return this.base.isInsecureTlsEnabled(this.runtimeValues);
  }

  getEnvFor(keys: string[]) {
    const env: Record<string, string> = {};
    for (const key of keys) {
      const value = this.get(key);
      if (value) env[key] = value;
    }
    return env;
  }

  snapshot(): SettingsSnapshot {
    return this.base.snapshotWithRuntime(this.runtimeValues);
  }

  update(values: Record<string, unknown>) {
    return this.base.updateRuntime(this.runtimeValues, values);
  }
}

export function createSettingsStore(rootDir: string) {
  return new SettingsStore(path.resolve(rootDir, '.env'));
}

function isTruthy(value: unknown) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeBooleanValue(value: unknown) {
  if (value === true || isTruthy(value)) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string' && ['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())) return 'false';
  return '';
}

function normalizeStringValue(key: string, value: string) {
  const limit = key === 'DOMAIN_KNOWLEDGE' ? 12_000 : key === 'OPENAI_EXTRA_HEADERS' || key === 'OPENAI_EXTRA_BODY' ? 16_000 : key.startsWith('MCP_') ? 8_000 : 2_000;
  return value.trim().slice(0, limit);
}
