import type { SettingsAccess } from './settings.js';
import { readElasticCcsSettings, type ElasticCcsSettings, wildcardToRegExp } from './elastic-ccs.js';
import { fetchWithMasterTls } from './tls.js';

export type ElasticProfileOptions = {
  maxIndices?: number;
  maxFieldCaps?: number;
  includeSystem?: boolean;
};

export type ElasticFocusTarget = {
  name: string;
  kind: 'index' | 'data_stream' | 'cross_cluster';
  docs?: number;
  health?: string;
  backingIndices?: number;
};

type CatIndex = {
  index?: string;
  'docs.count'?: string;
  'store.size'?: string;
  health?: string;
  status?: string;
};

type DataStreamListing = {
  data_streams?: Array<{
    name?: string;
    status?: string;
    template?: string;
    indices?: unknown[];
  }>;
};

type RemoteInfoResponse = Record<string, {
  connected?: boolean;
  skip_unavailable?: boolean;
  mode?: string;
}>;

type ResolveClusterResponse = {
  clusters?: Record<string, {
    connected?: boolean;
    matching_indices?: boolean;
    skip_unavailable?: boolean;
    version?: { number?: string };
    error?: unknown;
  }>;
};

type ProfiledIndex = {
  name: string;
  kind: 'index' | 'data_stream' | 'cross_cluster';
  docs: number;
  storeSize?: string;
  health?: string;
  system: boolean;
  backingIndices?: number;
  score: number;
  domains: string[];
  timestampFields: string[];
  keywordFields: string[];
  numericFields: string[];
  notableFields: string[];
  fieldCount: number;
  suggestions: AnalyticsSuggestion[];
};

type AnalyticsSuggestion = {
  question: string;
  action: 'ask' | 'chart' | 'dashboard' | 'summarize';
  indexPattern: string;
  confidence: 'high' | 'medium' | 'low';
  requiredFields: string[];
  rationale: string;
};

export type ElasticCrossClusterResolution = {
  enabled: boolean;
  searchByDefault: boolean;
  configuredPatterns: string[];
  normalizedTargets: string[];
  resolvedTargets: string[];
  skippedTargets: string[];
  clusters: Record<string, {
    connected?: boolean;
    matchingIndices?: boolean;
    skipUnavailable?: boolean;
    version?: string;
    error?: string;
  }>;
  error?: string;
};

export type ElasticProfile = {
  mode: 'deep-analysis';
  generatedAt: string;
  boundedBy: {
    maxIndices: number;
    maxFieldCaps: number;
    includeSystem: boolean;
    includeDataStreams: boolean;
    includedPatterns: string[];
    excludedPatterns: string[];
    crossClusterSearchByDefault: boolean;
    crossClusterTargets: string[];
  };
  domainKnowledge: string;
  totalDiscoveredIndices: number;
  totalDiscoveredDataStreams: number;
  totalDiscoveredCrossClusterTargets: number;
  crossCluster?: ElasticCrossClusterResolution;
  analyzedIndices: ProfiledIndex[];
  skipped: {
    systemIndices: number;
    emptyIndices: number;
    dataStreams: number;
    uninspectedIndices: number;
    crossClusterTargets: number;
  };
  suggestions: AnalyticsSuggestion[];
  caveats: string[];
};

const defaultExcludedPatterns = ['.*', 'ilm-history-*', 'slm-history-*'];

export async function buildElasticProfile(settings: SettingsAccess, options: ElasticProfileOptions = {}): Promise<ElasticProfile> {
  const maxIndices = clampNumber(options.maxIndices, 5, 200, readSettingNumber(settings, 'ELASTIC_PROFILER_MAX_INDICES', 40));
  const maxFieldCaps = clampNumber(options.maxFieldCaps, 3, maxIndices, readSettingNumber(settings, 'ELASTIC_PROFILER_MAX_FIELD_CAPS', 12));
  const maxFieldsPerIndex = readSettingNumber(settings, 'ELASTIC_PROFILER_MAX_FIELDS_PER_INDEX', 80);
  const includeSystem = options.includeSystem ?? isTruthy(settings.get('ELASTIC_PROFILER_INCLUDE_SYSTEM'), false);
  const includeDataStreams = isTruthy(settings.get('ELASTIC_PROFILER_INCLUDE_DATA_STREAMS'), true);
  const includedPatterns = parseCsvSetting(settings.get('ELASTIC_PROFILER_INCLUDED_PATTERNS'));
  const excludedPatterns = parseCsvSetting(settings.get('ELASTIC_PROFILER_EXCLUDED_PATTERNS') || defaultExcludedPatterns.join(','));
  const domainKnowledge = settings.get('DOMAIN_KNOWLEDGE');
  const ccsSettings = readElasticCcsSettings(settings);
  const useLocalDiscovery = !ccsSettings.enabled;
  const client = createElasticClient(settings);

  const indices = useLocalDiscovery ? await client.get<CatIndex[]>('/_cat/indices?format=json&h=index,docs.count,store.size,health,status&s=docs.count:desc') : [];
  const dataStreams = useLocalDiscovery && includeDataStreams
    ? await client.get<DataStreamListing>('/_data_stream?expand_wildcards=open,hidden').catch(() => ({ data_streams: [] }))
    : { data_streams: [] };
  const crossCluster = ccsSettings.enabled
    ? await resolveCrossClusterTargets(client, ccsSettings)
    : buildDisabledCrossClusterResolution(ccsSettings);
  const dataStreamNames = new Set((dataStreams.data_streams || []).map(stream => stream.name).filter(Boolean) as string[]);
  const nonEmpty = indices.filter(item => Number(item['docs.count'] || 0) > 0);
  const visibleIndices = nonEmpty.filter(item => {
    const name = String(item.index || '');
    if (!name) return false;
    if (!includeSystem && isSystemIndex(name)) return false;
    if (matchesAnyPattern(name, excludedPatterns)) return false;
    if (includedPatterns.length && !matchesAnyPattern(name, includedPatterns)) return false;
    return !isDataStreamBackingIndex(name, dataStreamNames);
  });
  const visibleDataStreams = includeDataStreams
    ? (dataStreams.data_streams || []).filter(stream => {
        const name = String(stream.name || '');
        if (!name) return false;
        if (!includeSystem && isSystemIndex(name)) return false;
        if (matchesAnyPattern(name, excludedPatterns)) return false;
        if (includedPatterns.length && !matchesAnyPattern(name, includedPatterns)) return false;
        return true;
      })
    : [];
  const crossClusterCandidates = crossCluster.resolvedTargets.map(target => ({
    name: target,
    kind: 'cross_cluster' as const,
    docs: 0,
    health: 'resolved',
    system: false,
    score: scoreIndex(target, 0, domainKnowledge) + 100
  }));
  const ranked = [
    ...crossClusterCandidates,
    ...visibleDataStreams.map(stream => {
      const name = String(stream.name || '');
      const docs = estimateDataStreamDocs(name, nonEmpty);
      return {
        name,
        kind: 'data_stream' as const,
        docs,
        health: stream.status,
        system: isSystemIndex(name),
        backingIndices: stream.indices?.length || 0,
        score: scoreIndex(name, docs, domainKnowledge) + 20
      };
    }),
    ...visibleIndices.map(item => ({
      name: String(item.index || ''),
      kind: 'index' as const,
      docs: Number(item['docs.count'] || 0),
      storeSize: item['store.size'],
      health: item.health,
      system: isSystemIndex(String(item.index || '')),
      score: scoreIndex(String(item.index || ''), Number(item['docs.count'] || 0), domainKnowledge)
    }))
  ]
    .filter(item => item.name)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxIndices);

  const inspected = await Promise.all(
    ranked.slice(0, maxFieldCaps).map(async item => {
      const fields = await getFieldCaps(client, item.name).catch(() => ({ fields: {} as Record<string, Record<string, { type?: string }>> }));
      return profileIndex(item, fields.fields || {}, maxFieldsPerIndex);
    })
  );

  const uninspected = ranked.slice(maxFieldCaps).map(item => ({
    ...item,
    domains: inferDomainsFromName(item.name, domainKnowledge),
    timestampFields: [],
    keywordFields: [],
    numericFields: [],
    notableFields: [],
    fieldCount: 0,
    suggestions: suggestFromIndexName(item.name, domainKnowledge)
  }));

  const analyzedIndices = [...inspected, ...uninspected];
  const suggestions = dedupeSuggestions(analyzedIndices.flatMap(index => index.suggestions)).slice(0, 18);

  return {
    mode: 'deep-analysis',
    generatedAt: new Date().toISOString(),
    boundedBy: {
      maxIndices,
      maxFieldCaps,
      includeSystem,
      includeDataStreams,
      includedPatterns,
      excludedPatterns,
      crossClusterSearchByDefault: ccsSettings.searchByDefault,
      crossClusterTargets: ccsSettings.targets
    },
    domainKnowledge,
    totalDiscoveredIndices: indices.length,
    totalDiscoveredDataStreams: dataStreams.data_streams?.length || 0,
    totalDiscoveredCrossClusterTargets: crossCluster.resolvedTargets.length,
    ...(crossCluster.enabled || crossCluster.configuredPatterns.length ? { crossCluster } : {}),
    analyzedIndices,
    skipped: {
      systemIndices: includeSystem ? 0 : nonEmpty.filter(item => isSystemIndex(String(item.index || ''))).length,
      emptyIndices: indices.length - nonEmpty.length,
      dataStreams: includeDataStreams ? Math.max(0, (dataStreams.data_streams?.length || 0) - visibleDataStreams.length) : dataStreams.data_streams?.length || 0,
      uninspectedIndices: Math.max(0, ranked.length - maxFieldCaps),
      crossClusterTargets: crossCluster.skippedTargets.length
    },
    suggestions,
    caveats: buildCaveats(indices.length + (dataStreams.data_streams?.length || 0), ranked.length, maxFieldCaps, domainKnowledge, maxFieldsPerIndex, includedPatterns, excludedPatterns, crossCluster)
  };
}

export async function searchElasticFocusTargets(settings: SettingsAccess, query: string, limit = 50) {
  const normalized = query.trim();
  if (!normalized) return { targets: [] as ElasticFocusTarget[] };
  const boundedLimit = clampNumber(limit, 1, 200, 50);
  const client = createElasticClient(settings);
  const [indices, dataStreams] = await Promise.all([
    client.get<CatIndex[]>('/_cat/indices?format=json&h=index,docs.count,health,status&s=index').catch(() => []),
    client.get<DataStreamListing>('/_data_stream?expand_wildcards=open,hidden').catch(() => ({ data_streams: [] }))
  ]);
  const matcher = buildFocusMatcher(normalized);
  const targets: ElasticFocusTarget[] = [
    ...indices
      .map(item => ({
        name: String(item.index || ''),
        kind: 'index' as const,
        docs: Number(item['docs.count'] || 0),
        health: item.health
      }))
      .filter(item => item.name && matcher(item.name)),
    ...(dataStreams.data_streams || [])
      .map(stream => ({
        name: String(stream.name || ''),
        kind: 'data_stream' as const,
        health: stream.status,
        backingIndices: stream.indices?.length || 0
      }))
      .filter(item => item.name && matcher(item.name))
  ];
  if (normalized.includes(':')) {
    targets.unshift({ name: normalized, kind: 'cross_cluster' });
  }
  return {
    targets: dedupeFocusTargets(targets).slice(0, boundedLimit)
  };
}

export function renderElasticProfile(profile: ElasticProfile) {
  const lines = [
    '# Elastic Deep Analysis',
    '',
    `Profiled ${profile.analyzedIndices.length} candidate Elastic targets out of ${profile.totalDiscoveredIndices} discovered indices, ${profile.totalDiscoveredDataStreams} data streams, and ${profile.totalDiscoveredCrossClusterTargets || 0} resolved cross-cluster targets.`,
    `Bounds: max ${profile.boundedBy.maxIndices} targets, field inspection on ${profile.boundedBy.maxFieldCaps}, data streams ${profile.boundedBy.includeDataStreams ? 'included' : 'skipped'}, system indices ${profile.boundedBy.includeSystem ? 'included' : 'skipped'}.`,
    ...(profile.crossCluster?.enabled
      ? [`Cross-cluster search defaults: ${profile.crossCluster.resolvedTargets.length} resolved target(s) from ${profile.crossCluster.normalizedTargets.join(', ')}.`]
      : []),
    '',
    '## Recommended analytics questions',
    ...profile.suggestions.map((suggestion, index) => {
      const fields = suggestion.requiredFields.length ? ` Fields: ${suggestion.requiredFields.join(', ')}.` : '';
      return `${index + 1}. ${suggestion.question}\n   Index: \`${suggestion.indexPattern}\`. Action: ${suggestion.action}. Confidence: ${suggestion.confidence}.${fields}`;
    }),
    '',
    '## Index catalog',
    ...profile.analyzedIndices.slice(0, 12).map(index => {
      const domains = index.domains.length ? index.domains.join(', ') : 'unknown';
      const timestamp = index.timestampFields[0] || 'none detected';
      const sample = index.notableFields.length ? `, notable fields ${index.notableFields.slice(0, 12).join(', ')}` : '';
      const backing = index.kind === 'data_stream' ? `, ${index.backingIndices || 0} backing indices` : '';
      const docs = index.kind === 'cross_cluster' ? 'remote docs not counted' : `${index.docs.toLocaleString()} docs`;
      return `- \`${index.name}\` (${index.kind}): ${docs}${backing}, domain ${domains}, timestamp ${timestamp}, ${index.fieldCount || 'uninspected'} fields${sample}`;
    })
  ];

  if (profile.domainKnowledge) {
    lines.push('', '## Domain knowledge applied', profile.domainKnowledge);
  }
  if (profile.caveats.length) {
    lines.push('', '## Caveats', ...profile.caveats.map(caveat => `- ${caveat}`));
  }

  return lines.join('\n');
}

function createElasticClient(settings: SettingsAccess) {
  const baseUrl = settings.get('ELASTICSEARCH_URL').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Set ELASTICSEARCH_URL before running Elastic instance analysis.');
  const authHeader = buildElasticAuthHeader(settings);
  if (!authHeader) throw new Error('Set ELASTICSEARCH_API_KEY or Elasticsearch username/password before running Elastic instance analysis.');
  const requestTimeoutMs = readSettingNumber(settings, 'ELASTIC_PROFILER_TIMEOUT_MS', 8000);

  return {
    async get<T>(path: string, timeoutMs = requestTimeoutMs): Promise<T> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchWithMasterTls(settings, `${baseUrl}${path}`, {
          headers: { authorization: authHeader },
          signal: controller.signal
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Elasticsearch request failed (${response.status}): ${body}`);
        }
        return response.json() as Promise<T>;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

function buildElasticAuthHeader(settings: Pick<SettingsAccess, 'get'>) {
  const apiKey = settings.get('ELASTICSEARCH_API_KEY');
  if (apiKey) return apiKey.toLowerCase().startsWith('apikey ') ? apiKey : `ApiKey ${apiKey}`;

  const username = settings.get('ELASTICSEARCH_USERNAME');
  const password = settings.get('ELASTICSEARCH_PASSWORD');
  if (username && password) return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  return '';
}

function buildFocusMatcher(query: string) {
  const lowerQuery = query.toLowerCase();
  if (/[*?]/.test(query)) {
    const matcher = wildcardToRegExp(query, true);
    return (value: string) => matcher.test(value);
  }
  return (value: string) => value.toLowerCase().includes(lowerQuery);
}

function dedupeFocusTargets(targets: ElasticFocusTarget[]) {
  const seen = new Set<string>();
  return targets.filter(target => {
    const key = `${target.kind}:${target.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveCrossClusterTargets(client: ReturnType<typeof createElasticClient>, ccsSettings: ElasticCcsSettings): Promise<ElasticCrossClusterResolution> {
  const expandedTargets = await expandCrossClusterTargets(client, ccsSettings.targets, ccsSettings.resolveTimeoutMs).catch(() => ccsSettings.targets);
  const expression = expandedTargets.join(',');

  try {
    const response = await client.get<ResolveClusterResponse>(
      `/_resolve/cluster/${encodeURIComponent(expression)}?ignore_unavailable=true&allow_no_indices=true&expand_wildcards=open,hidden&timeout=${ccsSettings.resolveTimeoutMs}ms`,
      ccsSettings.resolveTimeoutMs
    );
    const clusters = normalizeResolvedClusters(response);
    const resolvedTargets = expandedTargets.filter(target => isResolvedCrossClusterTarget(target, clusters));
    const skippedTargets = expandedTargets.filter(target => !resolvedTargets.includes(target));
    return {
      enabled: true,
      searchByDefault: ccsSettings.searchByDefault,
      configuredPatterns: ccsSettings.configuredPatterns,
      normalizedTargets: ccsSettings.targets,
      resolvedTargets,
      skippedTargets,
      clusters
    };
  } catch (error) {
    return {
      enabled: true,
      searchByDefault: ccsSettings.searchByDefault,
      configuredPatterns: ccsSettings.configuredPatterns,
      normalizedTargets: ccsSettings.targets,
      resolvedTargets: expandedTargets,
      skippedTargets: [],
      clusters: {},
      error: errorMessage(error)
    };
  }
}

function buildDisabledCrossClusterResolution(ccsSettings: ElasticCcsSettings): ElasticCrossClusterResolution {
  return {
    enabled: false,
    searchByDefault: ccsSettings.searchByDefault,
    configuredPatterns: ccsSettings.configuredPatterns,
    normalizedTargets: ccsSettings.targets,
    resolvedTargets: [],
    skippedTargets: [],
    clusters: {}
  };
}

async function expandCrossClusterTargets(client: ReturnType<typeof createElasticClient>, targets: string[], timeoutMs: number) {
  const remoteInfo = await client.get<RemoteInfoResponse>('/_remote/info', timeoutMs);
  const aliases = Object.keys(remoteInfo);
  const expanded: string[] = [];
  for (const target of targets) {
    const parts = splitCrossClusterTarget(target);
    if (!parts) {
      expanded.push(target);
      continue;
    }
    const matches = aliases.filter(alias => wildcardToRegExp(parts.cluster, true).test(alias));
    if (!matches.length) {
      expanded.push(target);
      continue;
    }
    for (const alias of matches) {
      expanded.push(`${alias}:${parts.indices}`);
    }
  }
  return dedupeStrings(expanded);
}

function normalizeResolvedClusters(response: ResolveClusterResponse) {
  const clusters: ElasticCrossClusterResolution['clusters'] = {};
  for (const [alias, value] of Object.entries(response.clusters || {})) {
    clusters[alias] = {
      connected: value.connected,
      matchingIndices: value.matching_indices,
      skipUnavailable: value.skip_unavailable,
      version: value.version?.number,
      error: value.error === undefined ? undefined : errorMessage(value.error)
    };
  }
  return clusters;
}

function isResolvedCrossClusterTarget(target: string, clusters: ElasticCrossClusterResolution['clusters']) {
  const parts = splitCrossClusterTarget(target);
  if (!parts) return false;
  const aliases = Object.keys(clusters).filter(alias => wildcardToRegExp(parts.cluster, true).test(alias));
  return aliases.some(alias => {
    const cluster = clusters[alias];
    return cluster.connected !== false && cluster.matchingIndices !== false && !cluster.error;
  });
}

function splitCrossClusterTarget(target: string) {
  const separator = target.indexOf(':');
  if (separator <= 0) return undefined;
  return {
    cluster: target.slice(0, separator),
    indices: target.slice(separator + 1) || '*'
  };
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter(value => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as { reason?: unknown; type?: unknown };
    if (typeof record.reason === 'string' && typeof record.type === 'string') return `${record.type}: ${record.reason}`;
    if (typeof record.reason === 'string') return record.reason;
    if (typeof record.type === 'string') return record.type;
  }
  return String(error);
}

async function getFieldCaps(client: ReturnType<typeof createElasticClient>, index: string) {
  return client.get<{ fields?: Record<string, Record<string, { type?: string }>> }>(
    `/${encodeURIComponent(index)}/_field_caps?fields=*&ignore_unavailable=true&filter_path=fields.*.*.type`
  );
}

function profileIndex(
  item: Pick<ProfiledIndex, 'name' | 'kind' | 'docs' | 'storeSize' | 'health' | 'system' | 'backingIndices' | 'score'>,
  fields: Record<string, Record<string, { type?: string }>>,
  maxFieldsPerIndex: number
): ProfiledIndex {
  const typedFields = Object.entries(fields).map(([name, caps]) => ({
    name,
    type: Object.values(caps)[0]?.type || 'unknown'
  }));
  const timestampFields = typedFields.filter(field => field.type === 'date' || /(^|[._-])(@timestamp|timestamp|time|created|event_time)([._-]|$)/i.test(field.name)).map(field => field.name).slice(0, 6);
  const keywordFields = typedFields.filter(field => ['keyword', 'constant_keyword', 'ip', 'boolean'].includes(field.type)).map(field => field.name).slice(0, 14);
  const numericFields = typedFields.filter(field => ['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long'].includes(field.type)).map(field => field.name).slice(0, 10);
  const notableFields = selectNotableFields(typedFields, maxFieldsPerIndex);
  const domains = inferDomains(item.name, notableFields, '');

  return {
    ...item,
    score: item.score + domains.length * 15 + timestampFields.length * 8,
    domains,
    timestampFields,
    keywordFields,
    numericFields,
    notableFields,
    fieldCount: typedFields.length,
    suggestions: suggestFromFields(item.name, domains, timestampFields, keywordFields, numericFields)
  };
}

function suggestFromFields(index: string, domains: string[], timestamps: string[], keywords: string[], numerics: string[]) {
  const timeField = timestamps[0] || '@timestamp';
  const suggestions: AnalyticsSuggestion[] = [];
  const has = (patterns: RegExp[]) => keywords.find(field => patterns.some(pattern => pattern.test(field)));
  const severity = has([/severity/i, /risk/i, /level/i]);
  const host = has([/^host\.name$/i, /host/i, /hostname/i]);
  const user = has([/^user\.name$/i, /user/i, /actor/i, /principal/i]);
  const service = has([/^service\.name$/i, /service/i, /app/i]);
  const event = has([/^event\.(category|dataset|action)$/i, /event/i, /type/i]);

  if (severity || domains.includes('security')) {
    suggestions.push({
      question: `Which security alerts or events in ${index} are most important over the last 7 days?`,
      action: 'summarize',
      indexPattern: index,
      confidence: severity ? 'high' : 'medium',
      requiredFields: [timeField, severity, host, user].filter(Boolean) as string[],
      rationale: 'Security-like fields were detected.'
    });
  }
  if (host || user || event) {
    suggestions.push({
      question: `Show top activity in ${index} by ${[host, user, event].filter(Boolean).slice(0, 2).join(' and ')} over time.`,
      action: 'chart',
      indexPattern: index,
      confidence: timestamps.length ? 'high' : 'medium',
      requiredFields: [timeField, host, user, event].filter(Boolean) as string[],
      rationale: 'Categorical entity fields and a time field were detected.'
    });
  }
  if (service || domains.includes('observability')) {
    suggestions.push({
      question: `Which services in ${index} have the highest error volume or latency trend?`,
      action: 'dashboard',
      indexPattern: index,
      confidence: service && numerics.length ? 'high' : 'medium',
      requiredFields: [timeField, service, numerics[0]].filter(Boolean) as string[],
      rationale: 'Service or numeric observability fields were detected.'
    });
  }
  if (!suggestions.length) {
    suggestions.push(...suggestFromIndexName(index, ''));
  }
  return suggestions;
}

function suggestFromIndexName(index: string, domainKnowledge: string): AnalyticsSuggestion[] {
  const domains = inferDomainsFromName(index, domainKnowledge);
  const domain = domains[0] || 'data';
  return [
    {
      question: `What are the volume trends and top categories in ${index} over the last 7 days?`,
      action: 'chart',
      indexPattern: index,
      confidence: domain === 'data' ? 'low' : 'medium',
      requiredFields: [],
      rationale: `Index name suggests ${domain}.`
    }
  ];
}

function inferDomains(index: string, fields: string[], domainKnowledge: string) {
  const haystack = `${index} ${fields.join(' ')} ${domainKnowledge}`.toLowerCase();
  const domains = [];
  if (/alert|security|siem|threat|okta|auth|endpoint/.test(haystack)) domains.push('security');
  if (/metric|apm|trace|service|transaction|span|uptime|observability/.test(haystack)) domains.push('observability');
  if (/log|event|syslog|message/.test(haystack)) domains.push('logs');
  if (/kubernetes|k8s|container|pod/.test(haystack)) domains.push('kubernetes');
  if (/ecommerce|order|customer|product|sales/.test(haystack)) domains.push('business');
  return [...new Set(domains)];
}

function inferDomainsFromName(index: string, domainKnowledge: string) {
  return inferDomains(index, [], domainKnowledge);
}

function scoreIndex(index: string, docs: number, domainKnowledge: string) {
  let score = Math.log10(Math.max(docs, 1)) * 10;
  if (domainKnowledge && domainKnowledge.toLowerCase().includes(index.toLowerCase())) score += 80;
  if (inferDomainsFromName(index, domainKnowledge).length) score += 30;
  if (isSystemIndex(index)) score -= 60;
  return score;
}

function isSystemIndex(index: string) {
  return index.startsWith('.') || index.startsWith('ilm-history') || index.startsWith('slm-history');
}

function isDataStreamBackingIndex(index: string, dataStreamNames: Set<string>) {
  if (!index.startsWith('.ds-')) return false;
  for (const dataStream of dataStreamNames) {
    if (index.startsWith(`.ds-${dataStream}-`)) return true;
  }
  return false;
}

function estimateDataStreamDocs(dataStream: string, indices: CatIndex[]) {
  const prefix = `.ds-${dataStream}-`;
  return indices
    .filter(item => String(item.index || '').startsWith(prefix))
    .reduce((sum, item) => sum + Number(item['docs.count'] || 0), 0);
}

function matchesAnyPattern(value: string, patterns: string[]) {
  return patterns.some(pattern => wildcardToRegExp(pattern).test(value));
}

function dedupeSuggestions(suggestions: AnalyticsSuggestion[]) {
  const seen = new Set<string>();
  return suggestions.filter(suggestion => {
    const key = `${suggestion.indexPattern}:${suggestion.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCaveats(
  total: number,
  ranked: number,
  fieldCaps: number,
  domainKnowledge: string,
  maxFieldsPerIndex: number,
  includedPatterns: string[],
  excludedPatterns: string[],
  crossCluster?: ElasticCrossClusterResolution
) {
  const caveats = [
    'This is a read-only bounded profile. It does not scan full documents, create aliases, or write data.',
    'Recommendations are based on index inventory, field capabilities, index names, and optional domain knowledge.'
  ];
  if (ranked > fieldCaps) caveats.push(`${ranked - fieldCaps} candidate indices were ranked but not field-inspected due to profiler bounds.`);
  if (total > ranked) caveats.push('Lower-ranked indices were excluded from this pass; increase profiler limits or add domain knowledge to prioritize them.');
  if (includedPatterns.length) caveats.push(`Only targets matching included patterns were considered: ${includedPatterns.join(', ')}.`);
  if (excludedPatterns.length) caveats.push(`Targets matching excluded patterns were skipped: ${excludedPatterns.join(', ')}.`);
  if (crossCluster?.enabled && crossCluster.resolvedTargets.length) {
    caveats.push(`Cross-cluster targets were included by default: ${crossCluster.resolvedTargets.join(', ')}.`);
  }
  if (crossCluster?.enabled && crossCluster.skippedTargets.length) {
    caveats.push(`Cross-cluster resolve preflight skipped unavailable targets: ${crossCluster.skippedTargets.join(', ')}.`);
  }
  if (crossCluster?.enabled && crossCluster.error) {
    caveats.push(`Cross-cluster resolve preflight failed; configured targets were included unverified: ${crossCluster.error}.`);
  }
  if (!domainKnowledge) caveats.push('Add Domain Knowledge in Settings to prioritize custom indices and improve field-role inference.');
  caveats.push(`Wide schemas are summarized: each inspected target reports total field count but only up to ${maxFieldsPerIndex} notable field names.`);
  return caveats;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function readSettingNumber(settings: Pick<SettingsAccess, 'get'>, key: string, fallback: number) {
  const raw = settings.get(key) || process.env[key] || '';
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseCsvSetting(raw: string) {
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isTruthy(value: string, fallback: boolean) {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function selectNotableFields(fields: Array<{ name: string; type: string }>, maxFieldsPerIndex: number) {
  const priorityPatterns = [
    /(^|[._-])@timestamp$/i,
    /timestamp|created|event_time|time/i,
    /severity|risk|score|level/i,
    /status|state|outcome|result/i,
    /alert|rule|threat|mitre/i,
    /host|hostname|container|pod|service/i,
    /user|actor|principal|account/i,
    /source|destination|src|dst|ip|geo/i,
    /event|category|dataset|action|type/i,
    /message|reason|description|summary/i,
    /duration|latency|bytes|count|error/i
  ];
  const scored = fields.map(field => ({
    field,
    score:
      priorityPatterns.reduce((sum, pattern, index) => sum + (pattern.test(field.name) ? priorityPatterns.length - index : 0), 0) +
      (field.name.split('.').length <= 3 ? 3 : 0)
  }));
  return scored
    .sort((a, b) => b.score - a.score || a.field.name.localeCompare(b.field.name))
    .slice(0, maxFieldsPerIndex)
    .map(item => item.field.name);
}
