import type { SettingsAccess } from './settings.js';
import type { AnalyticsProfileSnapshot } from './analytics-profile-service.js';
import type { FocusTarget, TokenUsage } from './openai-chat.js';
import { buildAuthorizationHeader, resolveChatCompletionsEndpoint, serializeMcpToolResultForModel, shouldExposeMcpToolToModel } from './openai-chat.js';
import type { McpRegistry } from './mcp-registry.js';
import type { RenderableToolCall } from './types.js';
import { runAutoAnalystDeepAgent } from './deep-agent-runner.js';
import { buildFocusedElasticEvidence, type ElasticFocusedEvidence, type ElasticFocusTarget } from './elastic-profiler.js';
import { buildFocusedTrinoEvidence, buildTrinoAutoProbes, type TrinoAutoProbeResult, type TrinoAutoProbeTarget, type TrinoFocusedEvidence, type TrinoProfileFocusTarget } from './trino-profiler.js';
import { fetchWithMasterTls } from './tls.js';

type ChatProgress = (message: string, detail?: Record<string, unknown>) => void;

type AutoReportScopeMode = 'focused' | 'contextual' | 'open';

export type AutoReportRequest = {
  focusTargets?: FocusTarget[];
  tokenBudget?: number;
  scopeMode?: AutoReportScopeMode;
  includeWhySection?: boolean;
  appIds?: string[];
  trinoEvidence?: TrinoFocusedEvidence;
  elasticEvidence?: ElasticFocusedEvidence;
};

type AutoReportPlan = {
  runId: string;
  generatedAt: string;
  scopeMode: AutoReportScopeMode;
  tokenBudget: number;
  contextTokenBudget: number;
  outputTokenBudget: number;
  reviewTokenBudget: number;
  focusTargets: FocusTarget[];
  includedObjects: CandidateObject[];
  skippedObjects: CandidateObject[];
  sources: string[];
  caveats: string[];
  deepAnalysis?: AutoDeepAnalysis;
};

type AutoReportResponse = {
  content: string;
  toolCalls: RenderableToolCall[];
  followUps: string[];
  usage?: TokenUsage;
  report: {
    runId: string;
    scopeMode: AutoReportScopeMode;
    tokenBudget: number;
    includedObjects: number;
    skippedObjects: number;
    supportingArtifacts: number;
    visualizations: number;
    judge: JudgeResult;
  };
};

type AnalyticsProfileReader = {
  snapshot(): AnalyticsProfileSnapshot;
  refreshNow(reason?: string): Promise<void>;
};

type CandidateObject = {
  id: string;
  source: 'elastic' | 'trino';
  kind: string;
  label: string;
  priority: number;
  estimatedTokens: number;
  focusMatched: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
};

type JudgeResult = {
  pass: boolean;
  issues: Array<{
    severity: 'high' | 'medium' | 'low';
    type: string;
    location?: string;
    message: string;
    suggestedFix?: string;
  }>;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
  usage?: Record<string, unknown>;
  model?: string;
};

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ToolMapEntry = {
  appId: string;
  appName: string;
  toolName: string;
  displayName: string;
  resourceUri?: string;
};

type SupportingArtifact = {
  title: string;
  appId: string;
  appName: string;
  toolName: string;
  kind: 'visualization' | 'dashboard' | 'evidence';
  summary: string;
  objectIds: string[];
  previewAvailable: boolean;
};

type SupportingArtifactResult = {
  toolCalls: RenderableToolCall[];
  artifacts: SupportingArtifact[];
  skippedReason?: string;
};

type RenderableUiResource = {
  resourceUri?: string;
  html?: string;
};

type AutoDeepAnalysis = {
  enabled: boolean;
  rounds: number;
  agentNarrative?: string;
  probes: Array<{
    objectId: string;
    source: string;
    round: number;
    title: string;
    queryType: 'trino-sql' | 'elastic-search' | 'web-search' | 'mcp-tool';
    statement: string;
    rows: Array<Record<string, string | number | boolean | null>>;
    notes: string[];
  }>;
  findings: Array<{
    objectId: string;
    title: string;
    summary: string;
    support: string[];
  }>;
  toolCalls?: RenderableToolCall[];
  skipped: string[];
};

const DEFAULT_TOKEN_BUDGET = 8000;
const MIN_TOKEN_BUDGET = 1500;
const MAX_TOKEN_BUDGET = 400_000;

export async function runAutoReport(
  registry: McpRegistry,
  settings: SettingsAccess,
  analyticsProfiles: AnalyticsProfileReader,
  request: AutoReportRequest,
  onProgress: ChatProgress = () => undefined
): Promise<AutoReportResponse> {
  const normalized = normalizeAutoReportRequest({
    ...request,
    tokenBudget: request.tokenBudget ?? readAutoReportTokenBudgetSetting(settings)
  });
  onProgress('Preparing Auto Report', {
    scopeMode: normalized.scopeMode,
    tokenBudget: normalized.tokenBudget,
    focusTargets: normalized.focusTargets.length
  });

  let snapshot = analyticsProfiles.snapshot();
  if (!snapshot.elastic.profile && !snapshot.trino.profile && !snapshot.running) {
    onProgress('Refreshing analytics profile for Auto Report');
    await analyticsProfiles.refreshNow('auto-report').catch(() => undefined);
    snapshot = analyticsProfiles.snapshot();
  }

  const trinoEvidence = await inspectFocusedTrinoObjects(settings, normalized.focusTargets, onProgress);
  if (trinoEvidence) snapshot = mergeTrinoEvidenceSnapshot(snapshot, trinoEvidence);
  const elasticEvidence = await inspectFocusedElasticObjects(settings, normalized.focusTargets, onProgress);
  if (elasticEvidence) snapshot = mergeElasticEvidenceSnapshot(snapshot, elasticEvidence);

  let plan = buildAutoReportPlan(snapshot, { ...normalized, trinoEvidence, elasticEvidence });
  const deepAnalysis = await runAutoDeepAnalysis(registry, settings, plan, normalized.appIds, onProgress);
  plan = { ...plan, deepAnalysis };
  if (!settings.get('OPENAI_API_KEY')) {
    onProgress('Rendering local analyst report');
    const artifacts: SupportingArtifactResult = {
      toolCalls: [],
      artifacts: [],
      skippedReason: 'Supporting visuals were not generated because the language model connection is not configured.'
    };
    const content = renderLocalReport(plan, normalized.includeWhySection, artifacts);
    return {
      content,
      toolCalls: [],
      followUps: buildAutoReportFollowUps(plan),
      report: buildReportMetadata(plan, { pass: true, issues: [] }, artifacts)
    };
  }

  const usage = createTokenUsageAccumulator(settings.get('OPENAI_MODEL'));
  const artifactResult = mergeDeepAnalysisArtifacts(await generateSupportingArtifacts(registry, settings, plan, normalized.appIds, onProgress, usage), deepAnalysis);

  onProgress('Drafting professional analyst report', {
    includedObjects: plan.includedObjects.length,
    skippedObjects: plan.skippedObjects.length,
    supportingArtifacts: artifactResult.artifacts.length
  });
  const draftCompletion = await createAutoReportCompletion(
    settings,
    [
      { role: 'system', content: buildReportSystemPrompt(normalized.includeWhySection) },
      { role: 'user', content: buildDraftPrompt(plan, normalized.includeWhySection, artifactResult) }
    ],
    plan.outputTokenBudget
  );
  usage.add(draftCompletion.usage, draftCompletion.model);
  const draft = draftCompletion.choices?.[0]?.message?.content?.trim() || renderLocalReport(plan, normalized.includeWhySection, artifactResult);

  onProgress('Reviewing report quality');
  const judgeCompletion = await createAutoReportCompletion(
    settings,
    [
      { role: 'system', content: buildJudgeSystemPrompt() },
      { role: 'user', content: buildJudgePrompt(plan, draft) }
    ],
    plan.reviewTokenBudget
  );
  usage.add(judgeCompletion.usage, judgeCompletion.model);
  const judge = parseJudgeResult(judgeCompletion.choices?.[0]?.message?.content || '');

  let content = draft;
  if (!judge.pass && judge.issues.some(issue => issue.severity === 'high' || issue.severity === 'medium')) {
    onProgress('Revising analyst report after review', {
      issues: judge.issues.length
    });
    const revisionCompletion = await createAutoReportCompletion(
      settings,
      [
        { role: 'system', content: buildReportSystemPrompt(normalized.includeWhySection) },
        { role: 'user', content: buildRevisionPrompt(plan, draft, judge, normalized.includeWhySection, artifactResult) }
      ],
      plan.outputTokenBudget
    );
    usage.add(revisionCompletion.usage, revisionCompletion.model);
    content = revisionCompletion.choices?.[0]?.message?.content?.trim() || draft;
  }

  onProgress('Analyst report complete', {
    tokens: usage.snapshot()?.totalTokens,
    reviewPassed: judge.pass,
    visualizations: artifactResult.toolCalls.length
  });
  return {
    content,
    toolCalls: artifactResult.toolCalls,
    followUps: buildAutoReportFollowUps(plan),
    ...(usage.snapshot() ? { usage: usage.snapshot() } : {}),
    report: buildReportMetadata(plan, judge, artifactResult)
  };
}

export function buildAutoReportPlan(snapshot: AnalyticsProfileSnapshot, request: AutoReportRequest): AutoReportPlan {
  const normalized = normalizeAutoReportRequest(request);
  const candidates = rankCandidates(collectCandidateObjects(snapshot, normalized.focusTargets, normalized.trinoEvidence, normalized.elasticEvidence), normalized);
  const selected: CandidateObject[] = [];
  const skipped: CandidateObject[] = [];
  let used = 0;

  for (const candidate of candidates) {
    if (used + candidate.estimatedTokens <= normalized.contextTokenBudget || selected.length === 0) {
      selected.push(candidate);
      used += candidate.estimatedTokens;
    } else {
      skipped.push(candidate);
    }
  }

  const sources = [
    snapshot.elastic.profile ? `Elastic profile generated ${snapshot.elastic.profile.generatedAt}` : '',
    snapshot.trino.profile ? `Trino profile generated ${snapshot.trino.profile.generatedAt}` : ''
  ].filter(Boolean);
  const caveats = [
    ...(snapshot.elastic.profile?.caveats || []),
    ...(snapshot.trino.profile?.caveats || []),
    skipped.length ? `${skipped.length} lower-priority candidate object(s) were excluded by the analysis budget.` : '',
    !snapshot.elastic.profile && !snapshot.trino.profile ? 'No analytics profile data was available for this run.' : ''
  ].filter(Boolean);

  return {
    runId: `auto-report-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    scopeMode: normalized.scopeMode,
    tokenBudget: normalized.tokenBudget,
    contextTokenBudget: normalized.contextTokenBudget,
    outputTokenBudget: normalized.outputTokenBudget,
    reviewTokenBudget: normalized.reviewTokenBudget,
    focusTargets: normalized.focusTargets,
    includedObjects: selected,
    skippedObjects: skipped,
    sources,
    caveats
  };
}

function normalizeAutoReportRequest(request: AutoReportRequest) {
  const tokenBudget = clampNumber(request.tokenBudget, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET);
  const focusTargets = normalizeFocusTargets(request.focusTargets || []).slice(0, 24);
  const scopeMode = request.scopeMode || (focusTargets.length ? 'contextual' : 'open');
  return {
    ...request,
    focusTargets,
    scopeMode,
    tokenBudget,
    contextTokenBudget: Math.max(450, Math.floor(tokenBudget * 0.42)),
    outputTokenBudget: Math.max(500, Math.floor(tokenBudget * 0.34)),
    reviewTokenBudget: Math.max(350, Math.min(1100, Math.floor(tokenBudget * 0.12))),
    includeWhySection: request.includeWhySection !== false,
    trinoEvidence: request.trinoEvidence,
    elasticEvidence: request.elasticEvidence
  };
}

function collectCandidateObjects(
  snapshot: AnalyticsProfileSnapshot,
  focusTargets: FocusTarget[],
  trinoEvidence?: TrinoFocusedEvidence,
  elasticEvidence?: ElasticFocusedEvidence
) {
  const objects: CandidateObject[] = [];
  const elasticProfile = snapshot.elastic.profile;
  if (elasticProfile) {
    for (const index of elasticProfile.analyzedIndices) {
      const sample = elasticEvidence?.samples.find(item => elasticFocusMatchesSample(index.name, item.target));
      const evidence = {
        docs: index.docs,
        health: index.health,
        fields: index.notableFields.slice(0, 16),
        timestampFields: index.timestampFields.slice(0, 8),
        keywordFields: index.keywordFields.slice(0, 8),
        numericFields: index.numericFields.slice(0, 8),
        domains: index.domains,
        suggestions: index.suggestions.slice(0, 3),
        ...(sample
          ? {
              sampleDocuments: sample.sampleDocuments.slice(0, 12),
              topValues: sample.topValues,
              sampleNotes: sample.notes
            }
          : {})
      };
      const focusMatched = focusTargets.some(target => target.source === 'elastic' && wildcardMatches(index.name, target.indexPattern));
      objects.push({
        id: `elastic:${index.name}`,
        source: 'elastic',
        kind: index.kind,
        label: index.name,
        priority: index.score + Math.log10(Math.max(index.docs, 1)) * 8 + (focusMatched ? 250 : 0),
        estimatedTokens: estimateTokens(evidence) + 30,
        focusMatched,
        reasons: [
          focusMatched ? 'matches selected focus item' : '',
          index.docs ? `${index.docs.toLocaleString()} documents` : '',
          index.domains.length ? `domains: ${index.domains.join(', ')}` : '',
          index.suggestions.length ? 'has generated analytics suggestions' : ''
        ].filter(Boolean),
        evidence
      });
    }
  }

  const trinoProfile = snapshot.trino.profile;
  if (trinoProfile) {
    for (const table of trinoProfile.analyzedTables) {
      const label = `${table.catalog}.${table.schema}.${table.name}`;
      const sample = trinoEvidence?.samples.find(item => item.source.toLowerCase() === label.toLowerCase());
      const evidence = {
        type: table.type,
        domains: table.domains,
        columns: table.columns.slice(0, 18).map(column => `${column.name} ${column.type}`),
        timestampColumns: table.timestampColumns,
        dimensionColumns: table.dimensionColumns.slice(0, 12),
        metricColumns: table.metricColumns.slice(0, 12),
        suggestions: table.suggestions.slice(0, 3),
        ...(sample
          ? {
              sampleRows: sample.sampleRows.slice(0, 12),
              topValues: sample.topValues,
              sampleNotes: sample.notes
            }
          : {})
      };
      const focusMatched = focusTargets.some(target => target.source === 'trino' && matchesTrinoFocus(table, target));
      objects.push({
        id: `trino:${label}`,
        source: 'trino',
        kind: table.type,
        label,
        priority: table.columns.length * 4 + table.suggestions.length * 20 + table.domains.length * 8 + (focusMatched ? 250 : 0),
        estimatedTokens: estimateTokens(evidence) + 30,
        focusMatched,
        reasons: [
          focusMatched ? 'matches selected focus item' : '',
          table.domains.length ? `domains: ${table.domains.join(', ')}` : '',
          table.timestampColumns.length ? `time columns: ${table.timestampColumns.join(', ')}` : '',
          table.metricColumns.length ? `metrics: ${table.metricColumns.slice(0, 5).join(', ')}` : ''
        ].filter(Boolean),
        evidence
      });
    }
  }

  return objects;
}

function rankCandidates(candidates: CandidateObject[], request: ReturnType<typeof normalizeAutoReportRequest>) {
  const focused = request.focusTargets.length > 0;
  const filtered =
    request.scopeMode === 'focused' && focused
      ? candidates.filter(candidate => candidate.focusMatched)
      : candidates;
  const fallback = filtered.length ? filtered : candidates;
  return [...fallback].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

async function runAutoDeepAnalysis(
  registry: McpRegistry,
  settings: SettingsAccess,
  plan: AutoReportPlan,
  appIds: string[] | undefined,
  onProgress: ChatProgress
): Promise<AutoDeepAnalysis> {
  if (!isTruthy(settings.get('AUTO_REPORT_DEEP_ANALYSIS_ENABLED'), true)) {
    return { enabled: false, rounds: 0, probes: [], findings: [], skipped: ['Deep analysis is disabled in settings.'] };
  }
  const trinoTargets = buildTrinoProbeTargets(plan);
  const maxProbes = clampNumber(settings.get('AUTO_REPORT_MAX_PROBES'), 1, 80, 24);
  const maxRows = clampNumber(settings.get('AUTO_REPORT_MAX_PROBE_ROWS'), 1, 200, 50);
  const rounds = clampNumber(settings.get('AUTO_REPORT_PROBE_ROUNDS'), 1, 3, 2);
  const skipped: string[] = [];
  if (settings.get('OPENAI_API_KEY') && isTruthy(settings.get('AUTO_REPORT_DEEP_AGENT_ENABLED'), true)) {
    try {
      const agentResult = await runAutoAnalystDeepAgent(
        settings,
        registry,
        {
          runContext: renderPlanForModel(plan),
          appIds,
          maxProbes,
          maxRows,
          rounds
        },
        onProgress
      );
      const findings = buildProbeFindings(agentResult.probes);
      return {
        enabled: true,
        rounds,
        agentNarrative: agentResult.narrative,
        probes: agentResult.probes,
        findings: [
          ...findings,
          ...(agentResult.narrative
            ? [{
                objectId: 'auto-analyst',
                title: 'Exploratory analyst narrative',
                summary: agentResult.narrative.slice(0, 2400),
                support: ['Auto Analyst Deep Agent']
              }]
            : [])
        ].slice(0, 24),
        toolCalls: agentResult.toolCalls,
        skipped: agentResult.skipped
      };
    } catch (error) {
      skipped.push(`Auto Analyst Deep Agent was unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!trinoTargets.length) {
    return {
      enabled: true,
      rounds,
      probes: [],
      findings: [],
      skipped: [
        ...skipped,
        'No Trino objects with inspected columns were available for deterministic query probing.'
      ]
    };
  }

  onProgress('Running deep read-only probes', {
    tables: trinoTargets.length,
    maxProbes,
    rounds
  });
  let results: TrinoAutoProbeResult[] = [];
  try {
    results = await buildTrinoAutoProbes(settings, trinoTargets, {
      maxTables: trinoTargets.length,
      maxProbes,
      maxRows,
      rounds
    });
  } catch (error) {
    skipped.push(`Trino probe execution did not complete: ${error instanceof Error ? error.message : String(error)}`);
  }

  const probes = results.flatMap(result => {
    const objectId = `trino:${result.source}`;
    return result.probes.map(probe => ({
      objectId,
      source: result.source,
      round: probe.round,
      title: probe.title,
      queryType: 'trino-sql' as const,
      statement: probe.sql,
      rows: probe.rows.slice(0, 20),
      notes: probe.notes
    }));
  });
  const findings = buildProbeFindings(probes);
  onProgress('Deep probes complete', {
    probes: probes.length,
    findings: findings.length,
    skipped: skipped.length
  });
  return {
    enabled: true,
    rounds,
    probes,
    findings,
    skipped
  };
}

function buildTrinoProbeTargets(plan: AutoReportPlan): TrinoAutoProbeTarget[] {
  return plan.includedObjects
    .filter(object => object.source === 'trino' && Array.isArray(object.evidence.columns))
    .map(object => {
      const parts = object.label.split('.');
      if (parts.length < 3) return undefined;
      const columns = (object.evidence.columns as unknown[])
        .map(item => parseColumnEvidence(String(item)))
        .filter((column): column is { name: string; type: string } => Boolean(column));
      if (!columns.length) return undefined;
      return {
        catalog: parts[0],
        schema: parts[1],
        name: parts.slice(2).join('.'),
        columns,
        timestampColumns: readStringArray(object.evidence.timestampColumns),
        dimensionColumns: readStringArray(object.evidence.dimensionColumns),
        metricColumns: readStringArray(object.evidence.metricColumns)
      };
    })
    .filter((target): target is TrinoAutoProbeTarget => Boolean(target));
}

function parseColumnEvidence(value: string) {
  const separator = value.indexOf(' ');
  if (separator <= 0) return undefined;
  return {
    name: value.slice(0, separator),
    type: value.slice(separator + 1)
  };
}

function buildProbeFindings(probes: AutoDeepAnalysis['probes']): AutoDeepAnalysis['findings'] {
  const findings: AutoDeepAnalysis['findings'] = [];
  for (const probe of probes) {
    if (probe.notes.length || !probe.rows.length) continue;
    const first = probe.rows[0];
    const values = Object.entries(first).filter(([, value]) => value !== null && value !== '');
    if (!values.length) continue;
    if (/row count/i.test(probe.title)) {
      findings.push({
        objectId: probe.objectId,
        title: `${probe.source} contains ${String(first.row_count ?? values[0][1])} rows in the probed scope`,
        summary: `The row-count probe returned ${formatProbeRow(first)}.`,
        support: [probe.title]
      });
    } else if (/time coverage/i.test(probe.title)) {
      findings.push({
        objectId: probe.objectId,
        title: `${probe.source} has observable time coverage`,
        summary: `The time probe returned ${formatProbeRow(first)}.`,
        support: [probe.title]
      });
    } else if (/top values/i.test(probe.title)) {
      findings.push({
        objectId: probe.objectId,
        title: `${probe.title} identified leading values`,
        summary: `The leading probe row was ${formatProbeRow(first)}.`,
        support: [probe.title]
      });
    } else if (/distribution summary| by |recent daily pattern/i.test(probe.title)) {
      findings.push({
        objectId: probe.objectId,
        title: probe.title,
        summary: `The probe returned ${probe.rows.length} row(s); first row: ${formatProbeRow(first)}.`,
        support: [probe.title]
      });
    }
  }
  return findings.slice(0, 18);
}

function formatProbeRow(row: Record<string, unknown>) {
  return Object.entries(row)
    .slice(0, 6)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

async function inspectFocusedElasticObjects(settings: SettingsAccess, focusTargets: FocusTarget[], onProgress: ChatProgress) {
  const elasticFocusTargets = getElasticFocusTargets(focusTargets);
  if (!elasticFocusTargets.length) return undefined;
  onProgress('Inspecting selected Elastic objects', {
    focusTargets: elasticFocusTargets.length
  });
  try {
    return await buildFocusedElasticEvidence(settings, elasticFocusTargets, {
      maxTargets: Math.max(8, elasticFocusTargets.length),
      maxSampleDocs: 20,
      maxSampleFields: 18,
      maxTopValueFields: 4,
      maxTopValues: 8
    });
  } catch (error) {
    onProgress('Selected Elastic inspection was limited', {
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function getElasticFocusTargets(targets: FocusTarget[]): ElasticFocusTarget[] {
  return targets
    .filter((target): target is Extract<FocusTarget, { source: 'elastic' }> => target.source === 'elastic')
    .map(target => {
      const kind: ElasticFocusTarget['kind'] = target.kind === 'data_stream' || target.kind === 'cross_cluster' ? target.kind : 'index';
      return {
        name: target.indexPattern,
        kind
      };
    })
    .filter(target => target.name.trim());
}

async function inspectFocusedTrinoObjects(settings: SettingsAccess, focusTargets: FocusTarget[], onProgress: ChatProgress) {
  const trinoFocusTargets = getTrinoFocusTargets(focusTargets);
  if (!trinoFocusTargets.length) return undefined;
  const maxFocusTables = clampNumber(settings.get('AUTO_REPORT_MAX_FOCUS_TABLES'), 1, 100, 40);
  onProgress('Inspecting selected warehouse objects', {
    focusTargets: trinoFocusTargets.length,
    maxTables: maxFocusTables
  });
  try {
    return await buildFocusedTrinoEvidence(settings, trinoFocusTargets, {
      maxTables: trinoFocusTargets.some(target => target.table) ? Math.max(8, trinoFocusTargets.length) : maxFocusTables,
      maxSampleRows: 20,
      maxSampleColumns: 16,
      maxTopValueColumns: 4,
      maxTopValues: 8
    });
  } catch (error) {
    onProgress('Selected warehouse inspection was limited', {
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function getTrinoFocusTargets(targets: FocusTarget[]): TrinoProfileFocusTarget[] {
  return targets
    .filter((target): target is Extract<FocusTarget, { source: 'trino' }> => target.source === 'trino')
    .map(target => ({
      catalog: normalizeTrinoFocusPart(target.catalog),
      schema: normalizeTrinoFocusPart(target.schema),
      table: normalizeTrinoFocusPart(target.table),
      tableType: target.tableType
    }))
    .filter(target => target.catalog || target.schema || target.table);
}

function normalizeFocusTargets(targets: FocusTarget[]): FocusTarget[] {
  return targets.map(target => {
    if (target.source !== 'trino') return target;
    const catalog = normalizeTrinoFocusPart(target.catalog);
    const schema = normalizeTrinoFocusPart(target.schema);
    const table = normalizeTrinoFocusPart(target.table);
    return {
      ...target,
      catalog,
      schema,
      table,
      label: target.label || `Trino ${[catalog || '*', schema || '*', table || '*'].join('.')}`
    };
  });
}

function normalizeTrinoFocusPart(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '*') return undefined;
  if (trimmed.toLowerCase() === 'auto') throw new Error('Invalid Trino focus target placeholder "auto". Use "*" for wildcard focus targets.');
  return trimmed;
}

function mergeTrinoEvidenceSnapshot(snapshot: AnalyticsProfileSnapshot, evidence: TrinoFocusedEvidence): AnalyticsProfileSnapshot {
  return {
    ...snapshot,
    trino: {
      ...snapshot.trino,
      status: 'ready',
      lastCompletedAt: evidence.profile.generatedAt,
      lastSuccessfulAt: evidence.profile.generatedAt,
      profile: evidence.profile
    }
  };
}

function mergeElasticEvidenceSnapshot(snapshot: AnalyticsProfileSnapshot, evidence: ElasticFocusedEvidence): AnalyticsProfileSnapshot {
  return {
    ...snapshot,
    elastic: {
      ...snapshot.elastic,
      status: 'ready',
      lastCompletedAt: evidence.profile.generatedAt,
      lastSuccessfulAt: evidence.profile.generatedAt,
      profile: evidence.profile
    }
  };
}

function buildReportSystemPrompt(includeWhySection: boolean) {
  return [
    'You are an expert analytics report writer preparing an external-facing professional report.',
    'Write like a senior human analyst: specific, evidence-backed, professional, and concise.',
    'Use only the provided schema metadata, sample rows, top values, read-only probe results, supporting artifacts, focus items, and caveats. Do not invent row values, incidents, joins, field meanings, or business facts.',
    'Treat read-only probe results as the strongest evidence. Prefer findings supported by executed probes over metadata-only observations.',
    'Every material claim must identify supporting object ids or state that it is an inference from metadata.',
    'When supporting visualizations or dashboards are available, include a "Visuals and Dashboards" section and refer to them by title as included with the report.',
    'Prefer fewer high-quality findings over broad generic coverage.',
    'Use Markdown headings and tables when useful.',
    'Do not use internal product or implementation wording such as Rubberband, Auto Report, MCP, tool call, prompt, token, pipeline, judge, model, revision, prior draft, or review pass.',
    includeWhySection ? 'Include a final "Analysis Basis" appendix that explains scope, selected focus objects, excluded objects, and confidence limits in business-facing language.' : 'Do not include a method appendix unless needed for a caveat.'
  ].join('\n');
}

function buildDraftPrompt(plan: AutoReportPlan, includeWhySection: boolean, artifactResult: SupportingArtifactResult) {
  return JSON.stringify({
    task: 'Create the final external-facing analyst report.',
    requiredSections: [
      'Executive Summary',
      'Visuals and Dashboards',
      'Key Findings',
      'Recommended Actions',
      'Confidence and Caveats',
      ...(includeWhySection ? ['Analysis Basis'] : [])
    ],
    budget: {
      outputTokenBudget: plan.outputTokenBudget,
      contextTokenBudget: plan.contextTokenBudget
    },
    run: renderPlanForModel(plan),
    supportingArtifacts: renderArtifactsForModel(artifactResult)
  });
}

function buildJudgeSystemPrompt() {
  return [
    'You are the Auto Report judge. Review the report strictly.',
    'Return only JSON with this shape: {"pass":true,"issues":[{"severity":"high|medium|low","type":"...","location":"...","message":"...","suggestedFix":"..."}]}.',
    'Fail high or medium issues for unsupported claims, missed focus items, unsafe recommendations, generic filler, contradictions, or an executive summary that is not faithful to the body.'
  ].join('\n');
}

function buildJudgePrompt(plan: AutoReportPlan, draft: string) {
  return JSON.stringify({
    run: renderPlanForModel(plan),
    draft
  });
}

function buildRevisionPrompt(plan: AutoReportPlan, draft: string, judge: JudgeResult, includeWhySection: boolean, artifactResult: SupportingArtifactResult) {
  return JSON.stringify({
    task: 'Revise the analyst report once. Fix required review issues without adding unsupported facts or internal implementation wording.',
    forbiddenOutputTopics: ['prior draft', 'revision', 'review process', 'judge', 'model behavior', 'pipeline internals'],
    includeWhySection,
    run: renderPlanForModel(plan),
    supportingArtifacts: renderArtifactsForModel(artifactResult),
    draft,
    judge
  });
}

function renderPlanForModel(plan: AutoReportPlan) {
  return {
    runId: plan.runId,
    generatedAt: plan.generatedAt,
    scopeMode: plan.scopeMode,
    focusTargets: plan.focusTargets,
    sources: plan.sources,
    includedObjects: plan.includedObjects.map(object => ({
      id: object.id,
      source: object.source,
      kind: object.kind,
      label: object.label,
      reasons: object.reasons,
      evidence: object.evidence
    })),
    skippedObjects: plan.skippedObjects.slice(0, 30).map(object => ({
      id: object.id,
      reason: buildSkippedObjectReason(object, plan),
      estimatedTokens: object.estimatedTokens,
      priority: object.priority,
      objectSignals: object.reasons
    })),
    deepAnalysis: plan.deepAnalysis
      ? {
          enabled: plan.deepAnalysis.enabled,
          rounds: plan.deepAnalysis.rounds,
          agentNarrative: plan.deepAnalysis.agentNarrative,
          findings: plan.deepAnalysis.findings,
          probes: plan.deepAnalysis.probes.slice(0, 40).map(probe => ({
            objectId: probe.objectId,
            round: probe.round,
            title: probe.title,
            queryType: probe.queryType,
            statement: probe.statement,
            rows: probe.rows.slice(0, 8),
            notes: probe.notes
          })),
          skipped: plan.deepAnalysis.skipped
        }
      : undefined,
    caveats: plan.caveats
  };
}

function renderArtifactsForModel(artifactResult: SupportingArtifactResult) {
  return {
    artifacts: artifactResult.artifacts,
    skippedReason: artifactResult.skippedReason
  };
}

function buildSkippedObjectReason(object: CandidateObject, plan: AutoReportPlan) {
  const focusNote = object.focusMatched ? 'It matched the selected focus scope but did not fit in the report context after higher-priority objects.' : 'It ranked below the included focus and high-signal objects.';
  return `${focusNote} Estimated context cost ${object.estimatedTokens} tokens; report context budget ${plan.contextTokenBudget}. Increase AUTO_REPORT_TOKEN_BUDGET or narrow focus if this object must be included.`;
}

function renderLocalReport(plan: AutoReportPlan, includeWhySection: boolean, artifactResult: SupportingArtifactResult) {
  const focus = plan.focusTargets.length ? plan.focusTargets.map(formatFocusTarget).join(', ') : 'No specific focus objects were selected; the report uses the highest-signal profiled objects.';
  const findings = plan.includedObjects.slice(0, 8).map(object => `- **${object.label}** (${object.id}): ${object.reasons.join('; ') || 'selected from analytics profile metadata'}.`);
  const probeFindings = plan.deepAnalysis?.findings.map(finding => `- **${finding.title}** (${finding.objectId}): ${finding.summary}`) || [];
  const visuals = artifactResult.artifacts.filter(artifact => artifact.previewAvailable);
  return [
    '# Analyst Report',
    '',
    '## Executive Summary',
    '',
    plan.includedObjects.length
      ? `This report reviews ${plan.includedObjects.length} high-signal data object(s). ${focus}`
      : 'No profiled data objects were available to analyze. Confirm the source connection settings and refresh the data profile.',
    '',
    '## Visuals and Dashboards',
    '',
    visuals.length
      ? visuals.map(artifact => `- **${artifact.title}**: included with this report.`).join('\n')
      : `- Supporting visuals were not generated. ${artifactResult.skippedReason || 'No selected visualization connector was available.'}`,
    '',
    '## Key Findings',
    '',
    probeFindings.length ? probeFindings.join('\n') : findings.length ? findings.join('\n') : '- No findings were generated because no profile objects were available.',
    '',
    '## Recommended Actions',
    '',
    '- Use the selected objects as the first investigation set.',
    '- Validate metadata-derived hypotheses with bounded read-only queries before making operational decisions.',
    '- Add or refine focus items when the next report should prioritize a narrower business question.',
    '',
    '## Confidence and Caveats',
    '',
    plan.caveats.length ? plan.caveats.map(item => `- ${item}`).join('\n') : '- This report is based on bounded profile context.',
    ...(includeWhySection
      ? [
          '',
          '## Analysis Basis',
          '',
          `- Scope mode: ${plan.scopeMode}.`,
          `- Included objects: ${plan.includedObjects.length}.`,
          `- Skipped objects: ${plan.skippedObjects.length}.`,
          ...(plan.skippedObjects.length ? [`- Skipped reason: ${buildSkippedObjectReason(plan.skippedObjects[0], plan)}`] : []),
          `- Read-only probes: ${plan.deepAnalysis?.probes.length || 0}.`,
          `- Sources: ${plan.sources.join('; ') || 'No profile source was available.'}`
        ]
      : [])
  ].join('\n');
}

function buildAutoReportFollowUps(plan: AutoReportPlan) {
  const top = plan.includedObjects[0];
  return [
    top ? `Run a focused chart for ${top.label}` : 'Refresh the analytics profile',
    'Generate the report with a deeper token budget',
    plan.focusTargets.length ? 'Compare focus items against related objects' : 'Add focus items and rerun Auto Report'
  ];
}

function buildReportMetadata(plan: AutoReportPlan, judge: JudgeResult, artifactResult: SupportingArtifactResult): AutoReportResponse['report'] {
  return {
    runId: plan.runId,
    scopeMode: plan.scopeMode,
    tokenBudget: plan.tokenBudget,
    includedObjects: plan.includedObjects.length,
    skippedObjects: plan.skippedObjects.length,
    supportingArtifacts: artifactResult.artifacts.length,
    visualizations: artifactResult.toolCalls.length,
    judge
  };
}

function mergeDeepAnalysisArtifacts(artifactResult: SupportingArtifactResult, deepAnalysis: AutoDeepAnalysis): SupportingArtifactResult {
  const deepToolCalls = deepAnalysis.toolCalls || [];
  if (!deepToolCalls.length) return artifactResult;
  const deepArtifacts: SupportingArtifact[] = deepToolCalls.map(toolCall => ({
    title: toolCall.title,
    appId: toolCall.appId,
    appName: toolCall.appId,
    toolName: toolCall.toolName,
    kind: /dashboard/i.test(toolCall.title) ? 'dashboard' : 'visualization',
    summary: 'Interactive preview generated during exploratory analysis.',
    objectIds: [],
    previewAvailable: true
  }));
  return {
    ...artifactResult,
    toolCalls: [...deepToolCalls, ...artifactResult.toolCalls],
    artifacts: [...deepArtifacts, ...artifactResult.artifacts],
    skippedReason: artifactResult.skippedReason
  };
}

async function generateSupportingArtifacts(
  registry: McpRegistry,
  settings: SettingsAccess,
  plan: AutoReportPlan,
  appIds: string[] | undefined,
  onProgress: ChatProgress,
  usage: ReturnType<typeof createTokenUsageAccumulator>
): Promise<SupportingArtifactResult> {
  const { tools, toolMap } = await buildReportToolDefinitions(registry, appIds);
  if (!tools.length) {
    return {
      toolCalls: [],
      artifacts: [],
      skippedReason: appIds?.length
        ? 'The selected analysis apps did not expose suitable read-only analytics or visualization capabilities.'
        : 'No analysis apps were selected for supporting visuals or evidence.'
    };
  }

  onProgress('Generating supporting visuals and evidence', {
    selectedTools: tools.length,
    selectedApps: appIds?.length || 0
  });
  const completion = await createAutoReportCompletion(
    settings,
    [
      { role: 'system', content: buildArtifactSystemPrompt() },
      { role: 'user', content: buildArtifactPrompt(plan, [...toolMap.values()]) }
    ],
    Math.max(500, Math.min(1200, plan.reviewTokenBudget)),
    tools
  );
  usage.add(completion.usage, completion.model);
  const requestedToolCalls = completion.choices?.[0]?.message?.tool_calls?.slice(0, 3) || [];
  if (!requestedToolCalls.length) {
    return {
      toolCalls: [],
      artifacts: [],
      skippedReason: 'The selected analysis apps did not provide a reliable visual or evidence query for this scope.'
    };
  }

  const renderableToolCalls: RenderableToolCall[] = [];
  const artifacts: SupportingArtifact[] = [];
  for (const toolCall of requestedToolCalls) {
    const entry = toolMap.get(toolCall.function.name);
    if (!entry) continue;
    const args = parseToolArgs(toolCall.function.arguments);
    onProgress(`Running supporting analysis: ${entry.displayName}`, {
      appId: entry.appId,
      toolName: entry.toolName
    });
    try {
      const result = await registry.callTool(entry.appId, entry.toolName, args);
      const embeddedUiResource = readRenderableUiResource(result);
      const resourceUri = entry.resourceUri || embeddedUiResource?.resourceUri;
      const previewAvailable = Boolean(resourceUri || embeddedUiResource?.html);
      const title = buildArtifactTitle(entry, args, previewAvailable);
      if (previewAvailable) {
        renderableToolCalls.push({
          id: toolCall.id,
          appId: entry.appId,
          toolName: entry.toolName,
          toolInput: args,
          toolResult: result,
          ...(resourceUri ? { resourceUri } : {}),
          ...(embeddedUiResource?.html ? { html: embeddedUiResource.html } : {}),
          title
        });
      }
      artifacts.push({
        title,
        appId: entry.appId,
        appName: entry.appName,
        toolName: entry.toolName,
        kind: inferArtifactKind(entry, previewAvailable),
        summary: summarizeArtifactResult(result, entry, resourceUri, Boolean(embeddedUiResource?.html)),
        objectIds: inferArtifactObjectIds(args, plan),
        previewAvailable
      });
    } catch (error) {
      artifacts.push({
        title: entry.displayName,
        appId: entry.appId,
        appName: entry.appName,
        toolName: entry.toolName,
        kind: 'evidence',
        summary: `The supporting analysis request did not complete: ${error instanceof Error ? error.message : String(error)}`,
        objectIds: [],
        previewAvailable: false
      });
    }
  }

  return {
    toolCalls: renderableToolCalls,
    artifacts,
    ...(renderableToolCalls.length ? {} : { skippedReason: 'The selected apps returned supporting evidence, but no embeddable visualization or dashboard preview.' })
  };
}

function buildArtifactSystemPrompt() {
  return [
    'You create supporting analytics artifacts for a professional data report.',
    'Use the selected read-only tools to generate at most three high-value artifacts.',
    'Prioritize embeddable dashboards, charts, maps, or tables when a visualization tool is available.',
    'Use focus objects as the base scope. Keep queries bounded, aggregate where possible, and avoid broad full-data scans.',
    'If a tool schema cannot be populated from the provided object metadata, do not call it.',
    'Do not invent data sources, fields, schemas, values, or filters.'
  ].join('\n');
}

function buildArtifactPrompt(plan: AutoReportPlan, tools: ToolMapEntry[]) {
  return JSON.stringify({
    task: 'Call suitable tools now to create supporting visuals, dashboards, or compact evidence for the report.',
    maxCalls: 3,
    preferredArtifactTypes: ['dashboard', 'chart', 'relationship map', 'summary table'],
    selectedObjects: plan.includedObjects.slice(0, 12).map(object => ({
      id: object.id,
      source: object.source,
      kind: object.kind,
      label: object.label,
      evidence: object.evidence
    })),
    probeFindings: plan.deepAnalysis?.findings || [],
    probeResults: plan.deepAnalysis?.probes.slice(0, 20).map(probe => ({
      objectId: probe.objectId,
      title: probe.title,
      rows: probe.rows.slice(0, 5)
    })) || [],
    focusTargets: plan.focusTargets,
    availableTools: tools.map(tool => ({
      functionName: sanitizeToolName(`${tool.appId}__${tool.toolName}`),
      appName: tool.appName,
      toolName: tool.toolName,
      displayName: tool.displayName,
      hasPreview: Boolean(tool.resourceUri)
    }))
  });
}

async function buildReportToolDefinitions(registry: McpRegistry, appIds?: string[]) {
  const selectedAppIds = appIds?.filter(Boolean);
  const toolResults = selectedAppIds?.length
    ? await Promise.all(selectedAppIds.map(appId => registry.listTools(appId).catch(() => [])))
    : [];
  const mcpTools = toolResults.flat() as Array<Record<string, unknown>>;
  const toolMap = new Map<string, ToolMapEntry>();
  const tools = [];

  for (const tool of mcpTools) {
    if (!shouldExposeMcpToolToModel(tool)) continue;
    const appId = String(tool.appId || '');
    const appName = String(tool.appName || appId);
    const toolName = String(tool.name || '');
    if (!appId || !toolName) continue;
    const score = scoreReportTool(tool);
    if (score <= 0) continue;
    const openAiName = sanitizeToolName(`${appId}__${toolName}`);
    const resourceUri = readResourceUri(tool);
    toolMap.set(openAiName, {
      appId,
      appName,
      toolName,
      displayName: `${appName}: ${toolName}`,
      resourceUri
    });
    tools.push({
      type: 'function',
      function: {
        name: openAiName,
        description: buildReportToolDescription(tool, score, Boolean(resourceUri)),
        parameters: normalizeJsonSchema(tool.inputSchema)
      }
    });
  }

  const sortedTools = tools
    .map(tool => ({ tool, score: scoreReportTool(mcpTools.find(raw => sanitizeToolName(`${String(raw.appId || '')}__${String(raw.name || '')}`) === (tool.function as { name: string }).name) || {}) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map(item => item.tool);
  return { tools: sortedTools, toolMap };
}

function scoreReportTool(tool: Record<string, unknown>) {
  const haystack = `${String(tool.appId || '')} ${String(tool.appName || '')} ${String(tool.name || '')} ${String(tool.description || '')}`.toLowerCase();
  let score = 0;
  if (readResourceUri(tool)) score += 30;
  if (/\b(dashboard|visuali[sz]e|visualization|viz|chart|graph|map|preview|table)\b/.test(haystack)) score += 25;
  if (/\b(query|sql|esql|search|discover|summarize|summary|profile|analytics|catalog|schema|index)\b/.test(haystack)) score += 12;
  if (/\b(create|update|delete|write|import|assign|acknowledge|close|reindex|insert|drop|alter)\b/.test(haystack)) score -= 40;
  return score;
}

function buildReportToolDescription(tool: Record<string, unknown>, score: number, hasPreview: boolean) {
  return [
    String(tool.description || `${String(tool.name || 'tool')} from ${String(tool.appName || tool.appId || 'selected app')}`),
    hasPreview ? 'This tool can produce an embeddable visual or dashboard preview for the final report.' : '',
    score >= 25 ? 'Use this for report visuals when its schema can be filled from selected objects.' : 'Use this only for compact supporting evidence when it directly supports the report.'
  ].filter(Boolean).join('\n');
}

function buildArtifactTitle(entry: ToolMapEntry, args: Record<string, unknown>, previewAvailable: boolean) {
  const title = [args.title, args.name, args.dashboardTitle, args.chartTitle]
    .find(value => typeof value === 'string' && value.trim());
  if (title) return String(title).trim().slice(0, 120);
  if (previewAvailable && /dashboard/i.test(entry.toolName)) return 'Supporting Dashboard';
  if (previewAvailable) return 'Supporting Visualization';
  return 'Supporting Evidence';
}

function inferArtifactKind(entry: ToolMapEntry, previewAvailable: boolean): SupportingArtifact['kind'] {
  const haystack = `${entry.displayName} ${entry.toolName}`.toLowerCase();
  if (previewAvailable && /dashboard/.test(haystack)) return 'dashboard';
  if (previewAvailable) return 'visualization';
  return 'evidence';
}

function summarizeArtifactResult(result: unknown, entry: ToolMapEntry, resourceUri?: string, hasEmbeddedHtml = false) {
  return serializeMcpToolResultForModel(result, {
    appId: entry.appId,
    toolName: entry.toolName,
    displayName: entry.displayName,
    resourceUri,
    hasEmbeddedHtml
  }).slice(0, 1800);
}

function inferArtifactObjectIds(args: Record<string, unknown>, plan: AutoReportPlan) {
  const text = JSON.stringify(args).toLowerCase();
  return plan.includedObjects
    .filter(object => text.includes(object.label.toLowerCase()) || text.includes(object.id.toLowerCase()))
    .map(object => object.id)
    .slice(0, 6);
}

async function createAutoReportCompletion(settings: SettingsAccess, messages: Array<{ role: 'system' | 'user'; content: string }>, maxTokens: number, tools: unknown[] = []) {
  const endpoint = resolveChatCompletionsEndpoint(settings.get('OPENAI_BASE_URL'));
  const response = await fetchWithMasterTls(settings, endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: buildAuthorizationHeader(settings),
      ...readJsonHeaderObjectSetting(settings, 'OPENAI_EXTRA_HEADERS')
    },
    signal: AbortSignal.timeout(readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || 90_000),
    body: JSON.stringify({
      ...readJsonObjectSetting(settings, 'OPENAI_EXTRA_BODY'),
      model: settings.get('OPENAI_MODEL'),
      messages,
      max_tokens: maxTokens,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE') === undefined ? {} : { temperature: readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE') }),
      ...(readOptionalNumberSetting(settings, 'OPENAI_TOP_P') === undefined ? {} : { top_p: readOptionalNumberSetting(settings, 'OPENAI_TOP_P') })
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }
  return response.json() as Promise<ChatCompletionResponse>;
}

function parseJudgeResult(content: string): JudgeResult {
  const parsed = parseJsonObjectFromText(content);
  const rawIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];
  const issues = rawIssues
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map(item => ({
      severity: readSeverity(item.severity),
      type: typeof item.type === 'string' ? item.type : 'review_issue',
      ...(typeof item.location === 'string' ? { location: item.location } : {}),
      message: typeof item.message === 'string' ? item.message : 'The judge reported an issue.',
      ...(typeof item.suggestedFix === 'string' ? { suggestedFix: item.suggestedFix } : {})
    }));
  const pass = typeof parsed?.pass === 'boolean' ? parsed.pass : !issues.some(issue => issue.severity === 'high' || issue.severity === 'medium');
  return { pass, issues };
}

function readSeverity(value: unknown): JudgeResult['issues'][number]['severity'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function parseJsonObjectFromText(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)].filter(candidate => candidate.startsWith('{'));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
    }
  }
  return undefined;
}

function createTokenUsageAccumulator(defaultModel: string) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  let model = defaultModel || undefined;
  return {
    add(rawUsage: unknown, responseModel?: string) {
      if (responseModel) model = responseModel;
      if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return;
      const usage = rawUsage as Record<string, unknown>;
      const prompt = readTokenNumber(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
      const completion = readTokenNumber(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']);
      const total = readTokenNumber(usage, ['total_tokens', 'totalTokens']);
      if (prompt !== undefined) promptTokens += prompt;
      if (completion !== undefined) completionTokens += completion;
      if (total !== undefined) totalTokens += total;
      else if (prompt !== undefined || completion !== undefined) totalTokens += (prompt || 0) + (completion || 0);
      hasUsage = hasUsage || prompt !== undefined || completion !== undefined || total !== undefined;
    },
    snapshot(): TokenUsage | undefined {
      if (!hasUsage) return undefined;
      return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(model ? { model } : {}),
        source: 'llm'
      };
    }
  };
}

function readTokenNumber(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) return Math.trunc(numericValue);
  }
  return undefined;
}

function readOptionalNumberSetting(settings: Pick<SettingsAccess, 'get'>, key: string) {
  const raw = settings.get(key).trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readOptionalIntegerSetting(settings: Pick<SettingsAccess, 'get'>, key: string) {
  const value = readOptionalNumberSetting(settings, key);
  return value === undefined ? undefined : Math.trunc(value);
}

function readJsonObjectSetting(settings: Pick<SettingsAccess, 'get'>, key: string): Record<string, unknown> {
  const raw = settings.get(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${key} must be a JSON object.`);
  }
}

function readJsonHeaderObjectSetting(settings: Pick<SettingsAccess, 'get'>, key: string) {
  return Object.fromEntries(
    Object.entries(readJsonObjectSetting(settings, key))
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .map(([name, value]) => [name, String(value)])
  ) as Record<string, string>;
}

function parseToolArgs(raw: string) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sanitizeToolName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function normalizeJsonSchema(schema: unknown) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  return schema;
}

function readResourceUri(tool: Record<string, unknown>) {
  const meta = tool._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  return readUiUri(meta?.ui?.resourceUri) || readUiUri(meta?.['ui/resourceUri']);
}

function readRenderableUiResource(value: unknown, seen = new WeakSet<object>()): RenderableUiResource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const resource = readRenderableUiResource(item, seen);
      if (resource) return resource;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const nestedResource = isRecord(record.resource) ? readRenderableUiResource(record.resource, seen) : undefined;
  if (nestedResource) return nestedResource;

  const resourceUri = readUiUri(record.resourceUri) || readUiUri(record['ui/resourceUri']) || readUiUri(record.uri);
  if (isMcpAppHtmlMime(record.mimeType)) {
    const html = readHtmlResourceText(record);
    if (html !== undefined || resourceUri) return { ...(resourceUri ? { resourceUri } : {}), ...(html !== undefined ? { html } : {}) };
  }
  if (record.type === 'resource_link' && resourceUri) return { resourceUri };

  for (const item of Object.values(record)) {
    const resource = readRenderableUiResource(item, seen);
    if (resource) return resource;
  }
  return undefined;
}

function readHtmlResourceText(resource: Record<string, unknown>) {
  if (typeof resource.text === 'string') return resource.text;
  if (typeof resource.blob !== 'string') return undefined;
  try {
    return Buffer.from(resource.blob, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function readUiUri(value: unknown) {
  return typeof value === 'string' && value.startsWith('ui://') ? value : undefined;
}

function isMcpAppHtmlMime(value: unknown) {
  if (typeof value !== 'string') return false;
  const parts = value.toLowerCase().split(';').map(part => part.trim()).filter(Boolean);
  return parts[0] === 'text/html' && parts.includes('profile=mcp-app');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function matchesTrinoFocus(table: { catalog: string; schema: string; name: string }, target: Extract<FocusTarget, { source: 'trino' }>) {
  return (
    (!target.catalog || table.catalog.toLowerCase() === target.catalog.toLowerCase()) &&
    (!target.schema || table.schema.toLowerCase() === target.schema.toLowerCase()) &&
    (!target.table || table.name.toLowerCase() === target.table.toLowerCase())
  );
}

function elasticFocusMatchesSample(indexName: string, sampleTarget: string) {
  return indexName.toLowerCase() === sampleTarget.toLowerCase() || wildcardMatches(indexName, sampleTarget) || wildcardMatches(sampleTarget, indexName);
}

function wildcardMatches(value: string, pattern: string) {
  if (!pattern || pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function formatFocusTarget(target: FocusTarget) {
  if (target.source === 'elastic') return `Elastic ${target.indexPattern}`;
  return `Trino ${[target.catalog || '*', target.schema || '*', target.table || '*'].join('.')}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isTruthy(value: string, fallback: boolean) {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readAutoReportTokenBudgetSetting(settings: Pick<SettingsAccess, 'get'>) {
  return clampNumber(settings.get('AUTO_REPORT_TOKEN_BUDGET'), MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET);
}
