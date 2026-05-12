import type { SettingsAccess } from './settings.js';
import { fetchWithMasterTls } from './tls.js';

export type TrinoProfileOptions = {
  maxCatalogs?: number;
  maxTablesPerCatalog?: number;
  maxColumnsPerCatalog?: number;
};

type TrinoProfileCacheEntry = {
  expiresAt: number;
  profile: TrinoProfile;
};

type TrinoColumn = {
  schema: string;
  table: string;
  name: string;
  type: string;
};

type TrinoTable = {
  catalog: string;
  schema: string;
  name: string;
  type: string;
  columns: TrinoColumn[];
  domains: string[];
  timestampColumns: string[];
  dimensionColumns: string[];
  metricColumns: string[];
  suggestions: AnalyticsSuggestion[];
};

type AnalyticsSuggestion = {
  question: string;
  action: 'ask' | 'chart' | 'dashboard' | 'summarize';
  source: string;
  confidence: 'high' | 'medium' | 'low';
  requiredColumns: string[];
  rationale: string;
};

export type TrinoProfile = {
  mode: 'deep-analysis';
  generatedAt: string;
  connectionLabel: string;
  boundedBy: {
    maxCatalogs: number;
    maxTablesPerCatalog: number;
    maxColumnsPerCatalog: number;
    maxColumnTablesPerCatalog?: number;
    catalogConcurrency?: number;
    includedCatalogs?: string[];
    excludedCatalogs?: string[];
  };
  domainKnowledge: string;
  catalogs: string[];
  analyzedTables: TrinoTable[];
  skipped: {
    catalogs: number;
    inaccessibleCatalogs: string[];
    uninspectedTables: number;
    uninspectedColumnTables?: number;
  };
  suggestions: AnalyticsSuggestion[];
  caveats: string[];
  cache?: {
    hit: boolean;
    ttlMs: number;
  };
};

type TrinoStatementResponse = {
  nextUri?: string;
  data?: unknown[][];
  error?: {
    message?: string;
    errorName?: string;
  };
};

type TableListing = {
  totalAvailable: number;
  items: Array<{
    schema: string;
    name: string;
    type: string;
  }>;
};

const trinoProfileCache = new Map<string, TrinoProfileCacheEntry>();
const defaultExcludedCatalogs = ['system', 'jmx', 'memory', 'information_schema'];

export async function buildTrinoProfile(settings: SettingsAccess, options: TrinoProfileOptions = {}): Promise<TrinoProfile> {
  const maxCatalogs = clampNumber(options.maxCatalogs, 1, 30, readSettingNumber(settings, 'TRINO_PROFILER_MAX_CATALOGS', 8));
  const maxTablesPerCatalog = clampNumber(options.maxTablesPerCatalog, 1, 200, readSettingNumber(settings, 'TRINO_PROFILER_MAX_TABLES_PER_CATALOG', 30));
  const maxColumnsPerCatalog = clampNumber(options.maxColumnsPerCatalog, 10, 5000, readSettingNumber(settings, 'TRINO_PROFILER_MAX_COLUMNS_PER_CATALOG', 600));
  const maxColumnTablesPerCatalog = clampNumber(undefined, 0, 200, readSettingNumber(settings, 'TRINO_PROFILER_MAX_COLUMN_TABLES_PER_CATALOG', 12));
  const catalogConcurrency = clampNumber(undefined, 1, 8, readSettingNumber(settings, 'TRINO_PROFILER_CONCURRENCY', 3));
  const cacheTtlMs = clampNumber(undefined, 0, 86_400_000, readSettingNumber(settings, 'TRINO_PROFILER_CACHE_TTL_MS', 86_400_000));
  const includedCatalogs = parseCsvSetting(settings.get('TRINO_PROFILER_INCLUDED_CATALOGS'));
  const excludedCatalogs = parseCsvSetting(settings.get('TRINO_PROFILER_EXCLUDED_CATALOGS') || defaultExcludedCatalogs.join(','));
  const domainKnowledge = settings.get('DOMAIN_KNOWLEDGE');
  const client = createTrinoClient(settings);
  const cacheKey = buildProfileCacheKey(settings, {
    maxCatalogs,
    maxTablesPerCatalog,
    maxColumnsPerCatalog,
    maxColumnTablesPerCatalog,
    catalogConcurrency,
    includedCatalogs,
    excludedCatalogs,
    domainKnowledge
  });
  const cached = cacheTtlMs > 0 ? trinoProfileCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cloneProfile(cached.profile),
      cache: { hit: true, ttlMs: cacheTtlMs }
    };
  }

  const allCatalogs = (await client.query('SHOW CATALOGS')).map(row => String(row[0] || '')).filter(Boolean);
  const candidateCatalogs = filterCatalogs(allCatalogs, includedCatalogs, excludedCatalogs, domainKnowledge);
  const selectedCatalogs = rankCatalogs(candidateCatalogs.length ? candidateCatalogs : allCatalogs, domainKnowledge).slice(0, maxCatalogs);
  const inaccessibleCatalogs: string[] = [];
  let uninspectedTables = 0;
  let uninspectedColumnTables = 0;
  const analyzedTables: TrinoTable[] = [];

  const catalogResults = await mapWithConcurrency(selectedCatalogs, catalogConcurrency, async catalog => {
    const tables: TableListing = await listTables(client, catalog, maxTablesPerCatalog).catch(error => {
      inaccessibleCatalogs.push(`${catalog}: ${error instanceof Error ? error.message : String(error)}`);
      return { totalAvailable: 0, items: [] };
    });
    if (!tables.items.length) return [] as TrinoTable[];

    const columnTables = tables.items.slice(0, maxColumnTablesPerCatalog);
    const columns = await listColumns(client, catalog, columnTables, maxColumnsPerCatalog).catch(error => {
      inaccessibleCatalogs.push(`${catalog} columns: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const columnsByTable = groupColumns(columns);
    uninspectedTables += Math.max(0, tables.totalAvailable - tables.items.length);
    uninspectedColumnTables += Math.max(0, tables.items.length - columnTables.length);

    return tables.items.map(table =>
      profileTable(catalog, table.schema, table.name, table.type, columnsByTable.get(`${table.schema}.${table.name}`) || [], domainKnowledge)
    );
  });

  analyzedTables.push(...catalogResults.flat());

  const suggestions = dedupeSuggestions(analyzedTables.flatMap(table => table.suggestions)).slice(0, 18);
  const profile: TrinoProfile = {
    mode: 'deep-analysis',
    generatedAt: new Date().toISOString(),
    connectionLabel: client.connectionLabel,
    boundedBy: { maxCatalogs, maxTablesPerCatalog, maxColumnsPerCatalog, maxColumnTablesPerCatalog, catalogConcurrency, includedCatalogs, excludedCatalogs },
    domainKnowledge,
    catalogs: selectedCatalogs,
    analyzedTables,
    skipped: {
      catalogs: Math.max(0, allCatalogs.length - selectedCatalogs.length),
      inaccessibleCatalogs,
      uninspectedTables,
      uninspectedColumnTables
    },
    suggestions,
    caveats: buildCaveats(allCatalogs.length, selectedCatalogs.length, uninspectedTables, uninspectedColumnTables, domainKnowledge, includedCatalogs, excludedCatalogs)
  };

  if (cacheTtlMs > 0) {
    trinoProfileCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, profile: cloneProfile(profile) });
  }
  return { ...profile, cache: { hit: false, ttlMs: cacheTtlMs } };
}

export function renderTrinoProfile(profile: TrinoProfile) {
  const lines = [
    '# Trino / Starburst Deep Analysis',
    '',
    `Profiled ${profile.analyzedTables.length} candidate tables across ${profile.catalogs.length} catalog${profile.catalogs.length === 1 ? '' : 's'} on ${profile.connectionLabel}.`,
    `Bounds: max ${profile.boundedBy.maxCatalogs} catalogs, ${profile.boundedBy.maxTablesPerCatalog} tables per catalog, ${profile.boundedBy.maxColumnTablesPerCatalog ?? profile.boundedBy.maxTablesPerCatalog} column-inspected tables per catalog, ${profile.boundedBy.maxColumnsPerCatalog} columns per catalog.`,
    profile.cache?.hit ? 'Served from the short-lived profiler cache.' : 'Fresh metadata profile.',
    '',
    '## Recommended analytics questions',
    ...profile.suggestions.map((suggestion, index) => {
      const columns = suggestion.requiredColumns.length ? ` Columns: ${suggestion.requiredColumns.join(', ')}.` : '';
      return `${index + 1}. ${suggestion.question}\n   Source: \`${suggestion.source}\`. Action: ${suggestion.action}. Confidence: ${suggestion.confidence}.${columns}`;
    }),
    '',
    '## Table catalog',
    ...profile.analyzedTables.slice(0, 18).map(table => {
      const source = `${table.catalog}.${table.schema}.${table.name}`;
      const domains = table.domains.length ? table.domains.join(', ') : 'unknown';
      const timestamp = table.timestampColumns[0] || 'none detected';
      const columns = table.columns.length ? table.columns.slice(0, 12).map(column => `${column.name}:${column.type}`).join(', ') : 'uninspected';
      return `- \`${source}\`: ${table.type}, domain ${domains}, timestamp ${timestamp}, columns ${columns}`;
    })
  ];

  if (profile.domainKnowledge) {
    lines.push('', '## Domain knowledge applied', profile.domainKnowledge);
  }
  if (profile.skipped.inaccessibleCatalogs.length) {
    lines.push('', '## Inaccessible metadata', ...profile.skipped.inaccessibleCatalogs.map(item => `- ${item}`));
  }
  if (profile.caveats.length) {
    lines.push('', '## Caveats', ...profile.caveats.map(caveat => `- ${caveat}`));
  }

  return lines.join('\n');
}

function createTrinoClient(settings: SettingsAccess) {
  const prefix = settings.get('STARBURST_HOST') ? 'STARBURST' : 'TRINO';
  const host = settings.get(`${prefix}_HOST`) || settings.get('TRINO_HOST');
  if (!host) throw new Error('Set TRINO_HOST or STARBURST_HOST before running Trino / Starburst analysis.');

  const scheme = settings.get(`${prefix}_SCHEME`) || settings.get('TRINO_SCHEME') || 'http';
  const port = settings.get(`${prefix}_PORT`) || settings.get('TRINO_PORT');
  const baseUrl = `${scheme}://${host}${port ? `:${port}` : ''}`.replace(/\/$/, '');
  const user = settings.get(`${prefix}_USER`) || settings.get('TRINO_USER') || 'rubberband';
  const catalog = settings.get(`${prefix}_CATALOG`) || settings.get('TRINO_CATALOG');
  const schema = settings.get(`${prefix}_SCHEMA`) || settings.get('TRINO_SCHEMA');
  const source = settings.get('TRINO_SOURCE') || 'rubberband';
  const authorization = buildTrinoAuthHeader(settings, prefix);
  const timeoutMs = readSettingNumber(settings, 'TRINO_PROFILER_TIMEOUT_MS', 12_000);
  const statementTimeoutMs = readSettingNumber(settings, 'TRINO_PROFILER_STATEMENT_TIMEOUT_MS', 60_000);
  const maxPagesPerStatement = readSettingNumber(settings, 'TRINO_PROFILER_MAX_PAGES_PER_STATEMENT', 80);

  return {
    connectionLabel: `${prefix === 'STARBURST' ? 'Starburst' : 'Trino'} ${host}`,
    defaultSchema: schema,
    async query(sql: string) {
      const startedAt = Date.now();
      let pageCount = 1;
      let body = await requestStatement(settings, `${baseUrl}/v1/statement`, timeoutMs, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-trino-user': user,
          'x-trino-source': source,
          ...(catalog ? { 'x-trino-catalog': catalog } : {}),
          ...(schema ? { 'x-trino-schema': schema } : {}),
          ...(authorization ? { authorization } : {})
        },
        body: sql
      });
      const rows = [...(body.data || [])];
      while (body.nextUri) {
        if (Date.now() - startedAt > statementTimeoutMs) {
          throw new Error(`Trino profiler statement exceeded ${statementTimeoutMs}ms: ${summarizeSql(sql)}`);
        }
        if (pageCount >= maxPagesPerStatement) {
          throw new Error(`Trino profiler statement exceeded ${maxPagesPerStatement} result pages: ${summarizeSql(sql)}`);
        }
        body = await requestStatement(settings, body.nextUri, timeoutMs, {
          headers: authorization ? { authorization } : undefined
        });
        pageCount += 1;
        rows.push(...(body.data || []));
      }
      return rows;
    }
  };
}

function summarizeSql(sql: string) {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function requestStatement(settings: SettingsAccess, url: string, timeoutMs: number, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithMasterTls(settings, url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Trino request failed (${response.status}): ${body}`);
    }
    const result = (await response.json()) as TrinoStatementResponse;
    if (result.error) {
      throw new Error(result.error.message || result.error.errorName || 'Trino statement failed');
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function listTables(client: ReturnType<typeof createTrinoClient>, catalog: string, limit: number) {
  const schemaFilter = client.defaultSchema ? `AND table_schema = ${quoteLiteral(client.defaultSchema)}` : '';
  const rows = await client.query(
    [
      'SELECT table_schema, table_name, table_type',
      `FROM ${quoteIdentifier(catalog)}.information_schema.tables`,
      "WHERE table_schema <> 'information_schema'",
      schemaFilter,
      'ORDER BY table_schema, table_name',
      `LIMIT ${limit + 1}`
    ].filter(Boolean).join(' ')
  );
  return {
    totalAvailable: rows.length,
    items: rows.slice(0, limit).map(row => ({
      schema: String(row[0] || ''),
      name: String(row[1] || ''),
      type: String(row[2] || 'TABLE')
    }))
  };
}

async function listColumns(
  client: ReturnType<typeof createTrinoClient>,
  catalog: string,
  tables: TableListing['items'],
  limit: number
): Promise<TrinoColumn[]> {
  if (!tables.length) return [];
  const tableFilter = tables
    .map(table => `(table_schema = ${quoteLiteral(table.schema)} AND table_name = ${quoteLiteral(table.name)})`)
    .join(' OR ');
  const rows = await client.query(
    [
      'SELECT table_schema, table_name, column_name, data_type',
      `FROM ${quoteIdentifier(catalog)}.information_schema.columns`,
      `WHERE (${tableFilter})`,
      'ORDER BY table_schema, table_name, ordinal_position',
      `LIMIT ${limit}`
    ].join(' ')
  );
  return rows.map(row => ({
    schema: String(row[0] || ''),
    table: String(row[1] || ''),
    name: String(row[2] || ''),
    type: String(row[3] || 'unknown')
  }));
}

function profileTable(catalog: string, schema: string, name: string, type: string, columns: TrinoColumn[], domainKnowledge: string): TrinoTable {
  const timestampColumns = columns
    .filter(column => /date|time|timestamp/i.test(column.type) || /(^|[._-])(date|time|timestamp|created|event_time)([._-]|$)/i.test(column.name))
    .map(column => column.name)
    .slice(0, 6);
  const metricColumns = columns
    .filter(column => /bigint|integer|double|decimal|real|number|numeric/i.test(column.type) && !/id$/i.test(column.name))
    .map(column => column.name)
    .slice(0, 10);
  const dimensionColumns = columns
    .filter(column => /char|varchar|boolean/i.test(column.type) || /status|state|type|category|region|user|service|host/i.test(column.name))
    .map(column => column.name)
    .slice(0, 14);
  const domains = inferDomains(`${catalog} ${schema} ${name}`, columns.map(column => column.name), domainKnowledge);

  return {
    catalog,
    schema,
    name,
    type,
    columns: columns.slice(0, 80),
    domains,
    timestampColumns,
    dimensionColumns,
    metricColumns,
    suggestions: suggestFromTable(catalog, schema, name, domains, timestampColumns, dimensionColumns, metricColumns)
  };
}

function suggestFromTable(catalog: string, schema: string, table: string, domains: string[], timestamps: string[], dimensions: string[], metrics: string[]) {
  const source = `${catalog}.${schema}.${table}`;
  const timeColumn = timestamps[0];
  const dimension = dimensions[0];
  const metric = metrics[0];
  const suggestions: AnalyticsSuggestion[] = [];

  if (timeColumn && metric) {
    suggestions.push({
      question: `How is ${metric} trending over time in ${source}?`,
      action: 'chart',
      source,
      confidence: 'high',
      requiredColumns: [timeColumn, metric],
      rationale: 'A timestamp column and numeric metric were detected.'
    });
  }
  if (dimension && metric) {
    suggestions.push({
      question: `Which ${dimension} values contribute most to ${metric} in ${source}?`,
      action: 'chart',
      source,
      confidence: timeColumn ? 'high' : 'medium',
      requiredColumns: [dimension, metric, timeColumn].filter(Boolean),
      rationale: 'Categorical dimensions and numeric metrics were detected.'
    });
  }
  if (domains.includes('security')) {
    suggestions.push({
      question: `Which security-related events in ${source} need review by severity or status?`,
      action: 'summarize',
      source,
      confidence: 'medium',
      requiredColumns: [timeColumn, dimension].filter(Boolean),
      rationale: 'Security-like table or column names were detected.'
    });
  }
  if (!suggestions.length) {
    suggestions.push({
      question: `What are the top records and useful dimensions in ${source}?`,
      action: 'ask',
      source,
      confidence: 'low',
      requiredColumns: dimensions.slice(0, 3),
      rationale: 'Only metadata was available, so this is a generic table exploration question.'
    });
  }

  return suggestions;
}

function buildTrinoAuthHeader(settings: Pick<SettingsAccess, 'get'>, prefix: 'TRINO' | 'STARBURST') {
  const token = settings.get(`${prefix}_ACCESS_TOKEN`) || settings.get('TRINO_ACCESS_TOKEN');
  if (token) return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;

  const authType = (settings.get('TRINO_AUTH_TYPE') || '').toLowerCase();
  const user = settings.get(`${prefix}_USER`) || settings.get('TRINO_USER');
  const password = settings.get(`${prefix}_PASSWORD`) || settings.get('TRINO_PASSWORD');
  if (password && authType !== 'none') return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return '';
}

function groupColumns(columns: TrinoColumn[]) {
  const grouped = new Map<string, TrinoColumn[]>();
  for (const column of columns) {
    const key = `${column.schema}.${column.table}`;
    grouped.set(key, [...(grouped.get(key) || []), column]);
  }
  return grouped;
}

function rankCatalogs(catalogs: string[], domainKnowledge: string) {
  const preferred = ['hive', 'iceberg', 'delta', 'postgresql', 'mysql', 'oracle', 'sqlserver', 'tpch', 'tpcds'];
  const lowerKnowledge = domainKnowledge.toLowerCase();
  return [...catalogs].sort((a, b) => scoreCatalog(b, preferred, lowerKnowledge) - scoreCatalog(a, preferred, lowerKnowledge) || a.localeCompare(b));
}

function scoreCatalog(catalog: string, preferred: string[], domainKnowledge: string) {
  const lower = catalog.toLowerCase();
  let score = preferred.includes(lower) ? 40 - preferred.indexOf(lower) : 0;
  if (domainKnowledge.includes(lower)) score += 80;
  if (lower === 'system') score -= 40;
  if (defaultExcludedCatalogs.includes(lower)) score -= 80;
  return score;
}

function inferDomains(source: string, fields: string[], domainKnowledge: string) {
  const haystack = `${source} ${fields.join(' ')} ${domainKnowledge}`.toLowerCase();
  const domains = [];
  if (/alert|security|siem|threat|okta|auth|endpoint|risk/.test(haystack)) domains.push('security');
  if (/metric|apm|trace|service|transaction|span|uptime|observability|latency/.test(haystack)) domains.push('observability');
  if (/log|event|syslog|message/.test(haystack)) domains.push('logs');
  if (/customer|order|product|sales|revenue|invoice|payment|commerce/.test(haystack)) domains.push('business');
  if (/finance|account|balance|trade|transaction/.test(haystack)) domains.push('finance');
  return [...new Set(domains)];
}

function dedupeSuggestions(suggestions: AnalyticsSuggestion[]) {
  const seen = new Set<string>();
  return suggestions.filter(suggestion => {
    const key = `${suggestion.source}:${suggestion.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCaveats(
  totalCatalogs: number,
  selectedCatalogs: number,
  uninspectedTables: number,
  uninspectedColumnTables: number,
  domainKnowledge: string,
  includedCatalogs: string[],
  excludedCatalogs: string[]
) {
  const caveats = [
    'This is a read-only bounded profile. It uses Trino metadata statements and does not scan source table rows.',
    'Recommendations are based on catalog, table, column, and type metadata plus optional domain knowledge.',
    'For large Trino estates, prefer TRINO_PROFILER_INCLUDED_CATALOGS to whitelist business catalogs instead of widening the global bounds.'
  ];
  if (totalCatalogs > selectedCatalogs) caveats.push(`${totalCatalogs - selectedCatalogs} catalogs were not inspected because of include/exclude filters or profiler bounds.`);
  if (uninspectedTables > 0) caveats.push(`${uninspectedTables} tables were listed but not included because of table bounds.`);
  if (uninspectedColumnTables > 0) caveats.push(`${uninspectedColumnTables} listed tables were included by name only; their columns were skipped by the column-table bound.`);
  if (includedCatalogs.length) caveats.push(`Only these catalogs were eligible: ${includedCatalogs.join(', ')}.`);
  else if (excludedCatalogs.length) caveats.push(`Internal or noisy catalogs are skipped by default when present: ${excludedCatalogs.join(', ')}.`);
  if (!domainKnowledge) caveats.push('Add Domain Knowledge in Settings to prioritize custom catalogs, schemas, and table names.');
  return caveats;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function readSettingNumber(settings: Pick<SettingsAccess, 'get'>, key: string, fallback: number) {
  const raw = settings.get(key);
  if (!raw.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  const numeric = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function parseCsvSetting(value: string) {
  return value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function filterCatalogs(catalogs: string[], includedCatalogs: string[], excludedCatalogs: string[], domainKnowledge: string) {
  const included = new Set(includedCatalogs);
  const excluded = new Set(excludedCatalogs);
  const lowerKnowledge = domainKnowledge.toLowerCase();

  return catalogs.filter(catalog => {
    const lower = catalog.toLowerCase();
    if (included.size) return included.has(lower);
    if (excluded.has(lower) && !lowerKnowledge.includes(lower)) return false;
    return true;
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function buildProfileCacheKey(settings: Pick<SettingsAccess, 'get'>, options: Record<string, unknown>) {
  const keys = [
    'TRINO_HOST',
    'TRINO_PORT',
    'TRINO_SCHEME',
    'TRINO_USER',
    'TRINO_CATALOG',
    'TRINO_SCHEMA',
    'STARBURST_HOST',
    'STARBURST_PORT',
    'STARBURST_SCHEME',
    'STARBURST_USER',
    'STARBURST_CATALOG',
    'STARBURST_SCHEMA'
  ];
  return JSON.stringify({
    connection: Object.fromEntries(keys.map(key => [key, settings.get(key)])),
    options
  });
}

function cloneProfile(profile: TrinoProfile): TrinoProfile {
  return JSON.parse(JSON.stringify(profile)) as TrinoProfile;
}
