import type { SettingsAccess } from './settings.js';
import { fetchWithMasterTls } from './tls.js';

export type TrinoProfileOptions = {
  maxCatalogs?: number;
  maxTablesPerCatalog?: number;
  maxColumnsPerCatalog?: number;
  maxColumnTablesPerCatalog?: number;
  focusTargets?: TrinoProfileFocusTarget[];
};

export type TrinoProfileFocusTarget = {
  catalog?: string;
  schema?: string;
  table?: string;
  tableType?: string;
};

export type TrinoFocusTable = {
  schema: string;
  name: string;
  type: string;
};

export type TrinoFocusPage<T> = {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
  total?: number;
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

export type TrinoFocusedEvidence = {
  profile: TrinoProfile;
  samples: Array<{
    source: string;
    columns: Array<{ name: string; type: string }>;
    sampleRows: Array<Record<string, string | number | boolean | null>>;
    topValues: Array<{
      column: string;
      values: Array<{ value: string; count: number }>;
    }>;
    notes: string[];
  }>;
};

export type TrinoAutoProbeTarget = {
  catalog: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  timestampColumns: string[];
  dimensionColumns: string[];
  metricColumns: string[];
};

export type TrinoAutoProbeResult = {
  source: string;
  probes: Array<{
    round: number;
    title: string;
    sql: string;
    rows: Array<Record<string, string | number | boolean | null>>;
    notes: string[];
  }>;
};

type TrinoStatementResponse = {
  nextUri?: string;
  columns?: Array<{ name?: string; type?: string }>;
  data?: unknown[][];
  error?: {
    message?: string;
    errorName?: string;
  };
};

export type TrinoReadOnlyProbeResult = {
  sql: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
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
  const maxColumnTablesPerCatalog = clampNumber(options.maxColumnTablesPerCatalog, 0, 200, readSettingNumber(settings, 'TRINO_PROFILER_MAX_COLUMN_TABLES_PER_CATALOG', 12));
  const catalogConcurrency = clampNumber(undefined, 1, 8, readSettingNumber(settings, 'TRINO_PROFILER_CONCURRENCY', 3));
  const cacheTtlMs = clampNumber(undefined, 0, 86_400_000, readSettingNumber(settings, 'TRINO_PROFILER_CACHE_TTL_MS', 86_400_000));
  const includedCatalogs = parseCsvSetting(settings.get('TRINO_PROFILER_INCLUDED_CATALOGS'));
  const excludedCatalogs = parseCsvSetting(settings.get('TRINO_PROFILER_EXCLUDED_CATALOGS') || defaultExcludedCatalogs.join(','));
  const focusTargets = normalizeFocusTargets(options.focusTargets || []);
  const focusedCatalogs = orderedUnique(focusTargets.map(target => target.catalog).filter((item): item is string => Boolean(item)));
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
    focusTargets,
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
  const candidateCatalogs = focusedCatalogs.length
    ? allCatalogs.filter(catalog => focusedCatalogs.includes(catalog.toLowerCase()))
    : filterCatalogs(allCatalogs, includedCatalogs, excludedCatalogs, domainKnowledge);
  const selectedCatalogs = focusedCatalogs.length
    ? orderCatalogsByFocus(candidateCatalogs, focusedCatalogs).slice(0, maxCatalogs)
    : rankCatalogs(candidateCatalogs.length ? candidateCatalogs : allCatalogs, domainKnowledge).slice(0, maxCatalogs);
  const inaccessibleCatalogs: string[] = [];
  let uninspectedTables = 0;
  let uninspectedColumnTables = 0;
  const analyzedTables: TrinoTable[] = [];

  const catalogResults = await mapWithConcurrency(selectedCatalogs, catalogConcurrency, async catalog => {
    const catalogFocusTargets = focusTargets.filter(target => target.catalog === catalog.toLowerCase());
    const tables: TableListing = await listTables(client, catalog, maxTablesPerCatalog, catalogFocusTargets).catch(error => {
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

export async function listTrinoFocusCatalogs(settings: SettingsAccess, query = '', limit = 50, offset = 0) {
  const client = createTrinoClient(settings);
  const boundedLimit = clampNumber(limit, 1, 200, 50);
  const boundedOffset = Math.max(0, Math.trunc(offset));
  const normalizedQuery = query.trim().toLowerCase();
  const rows = await client.query('SHOW CATALOGS');
  const catalogs = rows
    .map(row => String(row[0] || ''))
    .filter(catalog => catalog && (!normalizedQuery || catalog.toLowerCase().includes(normalizedQuery)))
    .sort((a, b) => a.localeCompare(b));
  return {
    connectionLabel: client.connectionLabel,
    catalogs: catalogs.slice(boundedOffset, boundedOffset + boundedLimit),
    limit: boundedLimit,
    offset: boundedOffset,
    hasMore: boundedOffset + boundedLimit < catalogs.length,
    total: catalogs.length
  };
}

export async function listTrinoFocusSchemas(settings: SettingsAccess, catalog: string, query = '', limit = 50, offset = 0) {
  const client = createTrinoClient(settings);
  const boundedLimit = clampNumber(limit, 1, 200, 50);
  const boundedOffset = Math.max(0, Math.trunc(offset));
  const schemaFilter = query.trim() ? `AND lower(schema_name) LIKE lower(${quoteLiteral(`%${escapeLike(query.trim())}%`)}) ESCAPE '\\'` : '';
  const rows = await client.query(
    [
      'SELECT schema_name',
      `FROM ${quoteIdentifier(catalog)}.information_schema.schemata`,
      "WHERE schema_name <> 'information_schema'",
      schemaFilter,
      'ORDER BY schema_name',
      `OFFSET ${boundedOffset}`,
      `LIMIT ${boundedLimit + 1}`
    ].join(' ')
  );
  const schemas = rows.map(row => String(row[0] || '')).filter(Boolean);
  return { catalog, schemas: schemas.slice(0, boundedLimit), limit: boundedLimit, offset: boundedOffset, hasMore: schemas.length > boundedLimit };
}

export async function listTrinoFocusTables(settings: SettingsAccess, catalog: string, schema: string, query = '', limit = 50, offset = 0) {
  const client = createTrinoClient(settings);
  const boundedLimit = clampNumber(limit, 1, 200, 50);
  const boundedOffset = Math.max(0, Math.trunc(offset));
  const tableFilter = query.trim() ? `AND lower(table_name) LIKE lower(${quoteLiteral(`%${escapeLike(query.trim())}%`)}) ESCAPE '\\'` : '';
  const rows = await client.query(
    [
      'SELECT table_schema, table_name, table_type',
      `FROM ${quoteIdentifier(catalog)}.information_schema.tables`,
      `WHERE table_schema = ${quoteLiteral(schema)}`,
      tableFilter,
      'ORDER BY table_name',
      `OFFSET ${boundedOffset}`,
      `LIMIT ${boundedLimit + 1}`
    ].join(' ')
  );
  const tables: TrinoFocusTable[] = rows.map(row => ({
    schema: String(row[0] || ''),
    name: String(row[1] || ''),
    type: String(row[2] || 'TABLE')
  })).filter(table => table.schema && table.name);
  return { catalog, schema, tables: tables.slice(0, boundedLimit), limit: boundedLimit, offset: boundedOffset, hasMore: tables.length > boundedLimit };
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

export async function buildFocusedTrinoEvidence(
  settings: SettingsAccess,
  focusTargets: TrinoProfileFocusTarget[],
  options: {
    maxTables?: number;
    maxSampleRows?: number;
    maxSampleColumns?: number;
    maxTopValueColumns?: number;
    maxTopValues?: number;
  } = {}
): Promise<TrinoFocusedEvidence> {
  const maxTables = clampNumber(options.maxTables, 1, 24, 8);
  const maxSampleRows = clampNumber(options.maxSampleRows, 1, 100, 20);
  const maxSampleColumns = clampNumber(options.maxSampleColumns, 2, 40, 14);
  const maxTopValueColumns = clampNumber(options.maxTopValueColumns, 0, 12, 4);
  const maxTopValues = clampNumber(options.maxTopValues, 1, 30, 8);
  const profile = await buildTrinoProfile(settings, {
    maxCatalogs: Math.max(1, new Set(focusTargets.map(target => target.catalog).filter(Boolean)).size || 1),
    maxTablesPerCatalog: maxTables,
    maxColumnsPerCatalog: maxTables * maxSampleColumns * 4,
    maxColumnTablesPerCatalog: maxTables,
    focusTargets
  });
  const client = createTrinoClient(settings);
  const samples = [];

  for (const table of profile.analyzedTables.slice(0, maxTables)) {
    const source = `${table.catalog}.${table.schema}.${table.name}`;
    const selectedColumns = selectEvidenceColumns(table, maxSampleColumns);
    const notes: string[] = [];
    let sampleRows: Array<Record<string, string | number | boolean | null>> = [];
    const topValues: TrinoFocusedEvidence['samples'][number]['topValues'] = [];

    if (!selectedColumns.length) {
      notes.push('No columns were available for sampling.');
      samples.push({ source, columns: [], sampleRows, topValues, notes });
      continue;
    }

    try {
      const rows = await client.query(
        [
          `SELECT ${selectedColumns.map(column => quoteIdentifier(column.name)).join(', ')}`,
          `FROM ${quoteQualifiedTable(table.catalog, table.schema, table.name)}`,
          `LIMIT ${maxSampleRows}`
        ].join(' ')
      );
      sampleRows = rows.map(row => Object.fromEntries(selectedColumns.map((column, index) => [column.name, normalizeSampleValue(row[index])])) as Record<string, string | number | boolean | null>);
    } catch (error) {
      notes.push(`Sample row query failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const column of selectTopValueColumns(table, maxTopValueColumns)) {
      try {
        const rows = await client.query(
          [
            `SELECT ${quoteIdentifier(column)}, count(*) AS value_count`,
            `FROM ${quoteQualifiedTable(table.catalog, table.schema, table.name)}`,
            `WHERE ${quoteIdentifier(column)} IS NOT NULL`,
            `GROUP BY ${quoteIdentifier(column)}`,
            'ORDER BY value_count DESC',
            `LIMIT ${maxTopValues}`
          ].join(' ')
        );
        topValues.push({
          column,
          values: rows.map(row => ({ value: String(row[0] ?? ''), count: Number(row[1] || 0) || 0 }))
        });
      } catch (error) {
        notes.push(`Top values query failed for ${column}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    samples.push({
      source,
      columns: selectedColumns.map(column => ({ name: column.name, type: column.type })),
      sampleRows,
      topValues,
      notes
    });
  }

  return { profile, samples };
}

export async function buildTrinoAutoProbes(
  settings: SettingsAccess,
  targets: TrinoAutoProbeTarget[],
  options: {
    maxTables?: number;
    maxProbes?: number;
    maxRows?: number;
    rounds?: number;
  } = {}
): Promise<TrinoAutoProbeResult[]> {
  const maxTables = clampNumber(options.maxTables, 1, 40, 12);
  const maxProbes = clampNumber(options.maxProbes, 1, 80, 24);
  const maxRows = clampNumber(options.maxRows, 1, 200, 50);
  const rounds = clampNumber(options.rounds, 1, 3, 2);
  const client = createTrinoClient(settings);
  const results: TrinoAutoProbeResult[] = [];
  let remainingProbes = maxProbes;

  for (const target of targets.slice(0, maxTables)) {
    if (remainingProbes <= 0) break;
    const source = `${target.catalog}.${target.schema}.${target.name}`;
    const probes: TrinoAutoProbeResult['probes'] = [];
    const table = quoteQualifiedTable(target.catalog, target.schema, target.name);
    const dimensions = selectProbeColumns(target.dimensionColumns, target.columns, 4, false);
    const metrics = selectProbeColumns(target.metricColumns, target.columns, 3, true);
    const timestamp = target.timestampColumns.find(column => hasColumn(target, column));

    const planned = [
      {
        round: 1,
        title: 'Row count',
        columns: ['row_count'],
        sql: `SELECT count(*) AS row_count FROM ${table}`
      },
      ...(timestamp
        ? [{
            round: 1,
            title: `Time coverage by ${timestamp}`,
            columns: ['min_time', 'max_time', 'nonnull_rows'],
            sql: [
              `SELECT CAST(min(${quoteIdentifier(timestamp)}) AS varchar) AS min_time,`,
              `CAST(max(${quoteIdentifier(timestamp)}) AS varchar) AS max_time,`,
              `count(${quoteIdentifier(timestamp)}) AS nonnull_rows`,
              `FROM ${table}`
            ].join(' ')
          }]
        : []),
      ...dimensions.slice(0, 3).map(column => ({
        round: 1,
        title: `Top values for ${column}`,
        columns: [column, 'row_count'],
        sql: [
          `SELECT ${quoteIdentifier(column)}, count(*) AS row_count`,
          `FROM ${table}`,
          `WHERE ${quoteIdentifier(column)} IS NOT NULL`,
          `GROUP BY ${quoteIdentifier(column)}`,
          'ORDER BY row_count DESC',
          `LIMIT ${maxRows}`
        ].join(' ')
      })),
      ...metrics.slice(0, 2).map(column => ({
        round: 1,
        title: `Distribution summary for ${column}`,
        columns: ['nonnull_rows', 'min_value', 'max_value', 'avg_value'],
        sql: [
          `SELECT count(${quoteIdentifier(column)}) AS nonnull_rows,`,
          `min(${quoteIdentifier(column)}) AS min_value,`,
          `max(${quoteIdentifier(column)}) AS max_value,`,
          `avg(${quoteIdentifier(column)}) AS avg_value`,
          `FROM ${table}`
        ].join(' ')
      })),
      ...(rounds >= 2 && dimensions[0] && metrics[0]
        ? [{
            round: 2,
            title: `${metrics[0]} by ${dimensions[0]}`,
            columns: [dimensions[0], 'row_count', 'avg_value', 'max_value'],
            sql: [
              `SELECT ${quoteIdentifier(dimensions[0])}, count(*) AS row_count,`,
              `avg(${quoteIdentifier(metrics[0])}) AS avg_value,`,
              `max(${quoteIdentifier(metrics[0])}) AS max_value`,
              `FROM ${table}`,
              `WHERE ${quoteIdentifier(dimensions[0])} IS NOT NULL AND ${quoteIdentifier(metrics[0])} IS NOT NULL`,
              `GROUP BY ${quoteIdentifier(dimensions[0])}`,
              'ORDER BY row_count DESC',
              `LIMIT ${maxRows}`
            ].join(' ')
          }]
        : []),
      ...(rounds >= 2 && timestamp && dimensions[0]
        ? [{
            round: 2,
            title: `${dimensions[0]} recent daily pattern`,
            columns: ['day', dimensions[0], 'row_count'],
            sql: [
              `SELECT CAST(date_trunc('day', ${quoteIdentifier(timestamp)}) AS varchar) AS day,`,
              `${quoteIdentifier(dimensions[0])}, count(*) AS row_count`,
              `FROM ${table}`,
              `WHERE ${quoteIdentifier(timestamp)} IS NOT NULL AND ${quoteIdentifier(dimensions[0])} IS NOT NULL`,
              `GROUP BY 1, 2`,
              'ORDER BY day DESC, row_count DESC',
              `LIMIT ${maxRows}`
            ].join(' ')
          }]
        : [])
    ].slice(0, remainingProbes);

    for (const probe of planned) {
      try {
        const rows = await client.query(probe.sql);
        probes.push({
          round: probe.round,
          title: probe.title,
          sql: probe.sql,
          rows: rows.slice(0, maxRows).map(row => rowToObject(probe.columns, row)),
          notes: []
        });
      } catch (error) {
        probes.push({
          round: probe.round,
          title: probe.title,
          sql: probe.sql,
          rows: [],
          notes: [`Probe failed: ${error instanceof Error ? error.message : String(error)}`]
        });
      }
      remainingProbes -= 1;
      if (remainingProbes <= 0) break;
    }

    results.push({ source, probes });
  }

  return results;
}

export async function runTrinoReadOnlyProbe(settings: SettingsAccess, sql: string, maxRows = 50): Promise<TrinoReadOnlyProbeResult> {
  const boundedRows = clampNumber(maxRows, 1, 200, 50);
  const safeSql = buildSafeReadOnlyProbeSql(sql, boundedRows);
  const client = createTrinoClient(settings);
  const result = await client.queryDetailed(safeSql);
  const columns = result.columns.length
    ? result.columns
    : Array.from({ length: result.rows[0]?.length || 0 }, (_, index) => `col_${index + 1}`);
  const rows = result.rows.slice(0, boundedRows).map(row => rowToObject(columns, row));
  return {
    sql: safeSql,
    columns,
    rows,
    rowCount: rows.length,
    truncated: result.rows.length > boundedRows
  };
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
      return (await this.queryDetailed(sql)).rows;
    },
    async queryDetailed(sql: string) {
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
      const columns = (body.columns || []).map(column => String(column.name || '')).filter(Boolean);
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
      return { columns, rows };
    }
  };
}

function buildSafeReadOnlyProbeSql(sql: string, maxRows: number) {
  const normalized = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(normalized)) throw new Error('Auto analyst probes must start with SELECT or WITH.');
  if (/;/.test(normalized)) throw new Error('Auto analyst probes may contain only one statement.');
  if (/\b(insert|update|delete|merge|drop|alter|create|replace|truncate|grant|revoke|call|execute|prepare|deallocate|set\s+session|reset\s+session|use)\b/i.test(normalized)) {
    throw new Error('Auto analyst probes must be read-only and cannot contain DDL, DML, session changes, or procedure calls.');
  }
  return `SELECT * FROM (${normalized}) auto_analyst_probe LIMIT ${maxRows}`;
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

async function listTables(
  client: ReturnType<typeof createTrinoClient>,
  catalog: string,
  limit: number,
  focusTargets: TrinoProfileFocusTarget[] = []
) {
  const focusFilter = buildTableFocusFilter(focusTargets);
  const schemaFilter = !focusTargets.length && client.defaultSchema ? `AND table_schema = ${quoteLiteral(client.defaultSchema)}` : '';
  const rows = await client.query(
    [
      'SELECT table_schema, table_name, table_type',
      `FROM ${quoteIdentifier(catalog)}.information_schema.tables`,
      "WHERE table_schema <> 'information_schema'",
      focusFilter,
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

function selectEvidenceColumns(table: TrinoProfile['analyzedTables'][number], limit: number) {
  const priority = [
    ...table.timestampColumns,
    ...table.dimensionColumns,
    ...table.metricColumns,
    ...table.columns.map(column => column.name)
  ];
  const selected = new Set<string>();
  for (const name of priority) {
    if (selected.size >= limit) break;
    if (name) selected.add(name);
  }
  return [...selected]
    .map(name => table.columns.find(column => column.name === name))
    .filter((column): column is TrinoColumn => Boolean(column));
}

function selectTopValueColumns(table: TrinoProfile['analyzedTables'][number], limit: number) {
  return [...new Set(table.dimensionColumns.filter(column => !/id$/i.test(column)).slice(0, limit))];
}

function quoteQualifiedTable(catalog: string, schema: string, table: string) {
  return `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function normalizeSampleValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value).slice(0, 500);
}

function selectProbeColumns(preferred: string[], columns: TrinoAutoProbeTarget['columns'], limit: number, numeric: boolean) {
  const byName = new Set(columns.map(column => column.name));
  const fallback = columns
    .filter(column => numeric ? /bigint|integer|double|decimal|real|number|numeric/i.test(column.type) && !/id$/i.test(column.name) : /char|varchar|boolean/i.test(column.type) && !/id$/i.test(column.name))
    .map(column => column.name);
  return orderedUnique([...preferred, ...fallback])
    .filter(column => byName.has(column))
    .slice(0, limit);
}

function hasColumn(target: TrinoAutoProbeTarget, name: string) {
  return target.columns.some(column => column.name === name);
}

function rowToObject(columns: string[], row: unknown[]) {
  return Object.fromEntries(columns.map((column, index) => [column, normalizeSampleValue(row[index])])) as Record<string, string | number | boolean | null>;
}

function rankCatalogs(catalogs: string[], domainKnowledge: string) {
  const preferred = ['hive', 'iceberg', 'delta', 'postgresql', 'mysql', 'oracle', 'sqlserver', 'tpch', 'tpcds'];
  const lowerKnowledge = domainKnowledge.toLowerCase();
  return [...catalogs].sort((a, b) => scoreCatalog(b, preferred, lowerKnowledge) - scoreCatalog(a, preferred, lowerKnowledge) || a.localeCompare(b));
}

function normalizeFocusTargets(targets: TrinoProfileFocusTarget[]) {
  return targets
    .map(target => ({
      catalog: normalizeFocusPart(target.catalog)?.toLowerCase(),
      schema: normalizeFocusPart(target.schema),
      table: normalizeFocusPart(target.table),
      tableType: target.tableType?.trim()
    }))
    .filter(target => target.catalog || target.schema || target.table);
}

function normalizeFocusPart(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '*') return undefined;
  if (trimmed.toLowerCase() === 'auto') throw new Error('Invalid Trino focus target placeholder "auto". Use "*" for wildcard focus targets.');
  return trimmed;
}

function orderedUnique(values: string[]) {
  return [...new Set(values)];
}

function orderCatalogsByFocus(catalogs: string[], focusedCatalogs: string[]) {
  const focusOrder = new Map(focusedCatalogs.map((catalog, index) => [catalog, index]));
  return [...catalogs].sort((a, b) => (focusOrder.get(a.toLowerCase()) ?? 999) - (focusOrder.get(b.toLowerCase()) ?? 999) || a.localeCompare(b));
}

function buildTableFocusFilter(targets: TrinoProfileFocusTarget[]) {
  const clauses = targets
    .map(target => {
      const parts = [
        target.schema ? `table_schema = ${quoteLiteral(target.schema)}` : '',
        target.table ? `table_name = ${quoteLiteral(target.table)}` : ''
      ].filter(Boolean);
      return parts.length ? `(${parts.join(' AND ')})` : '';
    })
    .filter(Boolean);
  return clauses.length ? `AND (${clauses.join(' OR ')})` : '';
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

function escapeLike(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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
