import { createDeepAgent, StateBackend } from 'deepagents';
import { tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type { SettingsAccess } from './settings.js';
import type { McpRegistry } from './mcp-registry.js';
import type { RenderableToolCall } from './types.js';
import { buildElasticCcsPromptGuidance } from './elastic-ccs.js';
import { buildMcpReadOnlyPromptGuidance } from './mcp-tool-policy.js';
import { buildElasticProfile, renderElasticProfile, runElasticReadOnlySearch } from './elastic-profiler.js';
import { buildTrinoProfile, renderTrinoProfile, runTrinoReadOnlyProbe } from './trino-profiler.js';
import { isWebSearchEnabled, runWebSearch } from './web-search.js';

type ChatProgress = (message: string, detail?: Record<string, unknown>) => void;
export type AnalysisTarget = 'elastic' | 'trino' | 'all';
export type AutoAnalystDeepAgentResult = {
  narrative: string;
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
  toolCalls: RenderableToolCall[];
  skipped: string[];
};

const MCP_APP_ROUTING_GUIDANCE = [
  'Selected MCP app routing:',
  '- Use source apps such as Trino, Starburst, Elasticsearch, and domain apps for live data, metadata, and source-specific workflows.',
  '- Use renderer apps such as Data Analytics only after source-backed evidence is collected and bounded.',
  '- For Trino-heavy analysis, Trino / Starburst remains the execution source of truth; Data Analytics can package reviewed rows into polished charts, tables, reports, or dashboards.',
  '- If Data Analytics rendering fails, fall back to the source app native visualization when available, otherwise continue from reviewed rows with provenance and caveats.'
].join('\n');

export async function runRubberbandDeepAgent(
  settings: SettingsAccess,
  request: string,
  tools: unknown[],
  systemPrompt: string,
  onProgress: ChatProgress
) {
  const timeout = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || Number(process.env.DEEP_AGENT_LLM_TIMEOUT_MS || 90_000);
  const agent = createDeepAgent({
    model: createDeepAgentModel(settings),
    backend: new StateBackend(),
    tools: tools as never,
    systemPrompt
  });

  onProgress('Starting Deep Agent');
  const result = await agent.invoke({
    messages: [
      {
        role: 'user',
        content: request
      }
    ]
  }, {
    recursionLimit: readDeepAgentRecursionLimit(),
    signal: AbortSignal.timeout(timeout)
  });
  onProgress('Deep Agent completed');
  return extractDeepAgentText(result) || 'Deep Agent completed, but did not return a text response.';
}

export async function runAnalyticsDeepAgent(settings: SettingsAccess, request: string, target: AnalysisTarget, onProgress: ChatProgress) {
  let lastProfileText = '';
  const tools = [];

  if (target === 'elastic' || target === 'all') {
    tools.push(
      tool(
        async input => {
          onProgress('Deep Agent is profiling Elastic indices');
          const profile = await buildElasticProfile(settings, {
            maxIndices: input.maxIndices,
            maxFieldCaps: input.maxFieldCaps,
            includeSystem: input.includeSystem
          });
          const summary = renderElasticProfile(profile);
          lastProfileText = [lastProfileText, summary].filter(Boolean).join('\n\n');
          return JSON.stringify({
            summary,
            profile
          });
        },
        {
          name: 'profile_elastic_cluster_readonly',
          description:
            'Read-only bounded profiler for the connected Elasticsearch cluster. Uses only metadata and field-capability requests. It never writes data, creates aliases, updates mappings, or scans full documents.',
          schema: z.object({
            maxIndices: z.number().int().min(5).max(200).optional().describe('Maximum candidate indices to rank.'),
            maxFieldCaps: z.number().int().min(3).max(50).optional().describe('Maximum ranked indices to inspect with field capabilities.'),
            includeSystem: z.boolean().optional().describe('Whether to include system indices. Defaults to false.')
          })
        }
      )
    );
  }

  if (target === 'trino' || target === 'all') {
    tools.push(
      tool(
        async input => {
          onProgress('Deep Agent is profiling Trino / Starburst metadata');
          const profile = await buildTrinoProfile(settings, {
            maxCatalogs: input.maxCatalogs,
            maxTablesPerCatalog: input.maxTablesPerCatalog,
            maxColumnsPerCatalog: input.maxColumnsPerCatalog
          });
          const summary = renderTrinoProfile(profile);
          lastProfileText = [lastProfileText, summary].filter(Boolean).join('\n\n');
          return JSON.stringify({
            summary,
            profile
          });
        },
        {
          name: 'profile_trino_starburst_readonly',
          description:
            'Read-only bounded profiler for connected Trino or Starburst. Uses metadata statements against catalogs, information_schema tables, and columns. It does not scan business table rows or write data.',
          schema: z.object({
            maxCatalogs: z.number().int().min(1).max(30).optional().describe('Maximum catalogs to inspect.'),
            maxTablesPerCatalog: z.number().int().min(1).max(200).optional().describe('Maximum tables to list per catalog.'),
            maxColumnsPerCatalog: z.number().int().min(10).max(5000).optional().describe('Maximum columns to inspect per catalog.')
          })
        }
      )
    );
  }

  if (isWebSearchEnabled(settings)) {
    tools.push(
      tool(
        async input => {
          const args: Record<string, unknown> = isRecord(input) ? input : {};
          onProgress('Deep Agent is searching the web', { query: stringArg(args.query) });
          return JSON.stringify(await runWebSearch(settings, {
            query: stringArg(args.query),
            reason: stringArg(args.reason) || 'Deep analysis requested current external context.',
            recencyDays: optionalNumberArg(args.recencyDays),
            maxResults: optionalNumberArg(args.maxResults)
          }));
        },
        {
          name: 'web_search',
          description: 'Search the public web through the configured web-search model for current external context, docs, standards, product details, or source citations.',
          schema: z.object({
            query: z.string(),
            reason: z.string().optional(),
            recencyDays: z.number().int().min(1).optional(),
            maxResults: z.number().int().min(1).max(20).optional()
          })
        }
      )
    );
  }

  const elasticCcsGuidance = target === 'elastic' || target === 'all' ? buildElasticCcsPromptGuidance(settings) : '';
  const mcpSafetyGuidance = buildMcpReadOnlyPromptGuidance(settings);
  const agent = createDeepAgent({
    model: createDeepAgentModel(settings),
    backend: new StateBackend(),
    tools,
    systemPrompt: [
      `You are Rubberband Deep Analysis for ${target === 'all' ? 'Elastic plus Trino / Starburst' : target === 'trino' ? 'Trino / Starburst' : 'Elastic'}.`,
      `You must use ${target === 'elastic' ? 'profile_elastic_cluster_readonly' : target === 'trino' ? 'profile_trino_starburst_readonly' : 'both profile_elastic_cluster_readonly and profile_trino_starburst_readonly'} before making recommendations.`,
      'Only perform read-only analysis. Do not suggest writes, aliases, reindexing, updates, deletes, DDL, DML, or mapping changes as part of this analysis.',
      'Use profiler output and Domain Knowledge only; do not invent indices, tables, fields, columns, counts, values, or join keys.',
      elasticCcsGuidance ? `Elastic CCS defaults:\n${elasticCcsGuidance}` : '',
      isWebSearchEnabled(settings) ? 'Web search is available through the web_search tool when current public context or citations are needed.' : '',
      mcpSafetyGuidance ? `MCP tool safety:\n${mcpSafetyGuidance}` : '',
      'For combined Elastic and Trino / Starburst analysis, identify plausible cross-source questions only when names or fields support the relationship, and label them as candidates until verified by a query tool.',
      'Return a compact report with recommended analytics questions, best index/table pattern, required fields or columns, confidence, and caveats.',
      'Mention that this analysis is bounded and read-only.'
    ].join('\n')
  });

  onProgress('Starting Deep Agent');
  const timeout = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || Number(process.env.DEEP_AGENT_LLM_TIMEOUT_MS || 90_000);
  const result = await agent.invoke({
    messages: [
      {
        role: 'user',
        content: [
          request,
          '',
          settings.get('DOMAIN_KNOWLEDGE') ? `Domain Knowledge:\n${settings.get('DOMAIN_KNOWLEDGE')}` : 'No Domain Knowledge was provided.',
          '',
          'Use bounded defaults unless the user explicitly requested different bounds.'
        ].join('\n')
      }
    ]
  }, {
    recursionLimit: readDeepAgentRecursionLimit(),
    signal: AbortSignal.timeout(timeout)
  });

  onProgress('Deep Agent completed');
  return extractDeepAgentText(result) || lastProfileText || 'Deep analysis completed, but the agent did not return a text report.';
}

export function runElasticDeepAgent(settings: SettingsAccess, request: string, onProgress: ChatProgress) {
  return runAnalyticsDeepAgent(settings, request, 'elastic', onProgress);
}

export async function runAutoAnalystDeepAgent(
  settings: SettingsAccess,
  registry: McpRegistry,
  request: {
    runContext: unknown;
    appIds?: string[];
    maxProbes: number;
    maxRows: number;
    rounds: number;
  },
  onProgress: ChatProgress
): Promise<AutoAnalystDeepAgentResult> {
  const probes: AutoAnalystDeepAgentResult['probes'] = [];
  const skipped: string[] = [];
  const toolCalls: RenderableToolCall[] = [];
  let probeCount = 0;
  let mcpToolRunCount = 0;
  const maxMcpToolCalls = readOptionalIntegerSetting(settings, 'AUTO_REPORT_MAX_MCP_TOOL_CALLS') || 8;

  const tools = [
    tool(
      async input => {
        const args: Record<string, unknown> = isRecord(input) ? input : {};
        if (probeCount >= request.maxProbes) return JSON.stringify({ ok: false, error: 'Auto analyst probe limit reached.' });
        probeCount += 1;
        const title = stringArg(args.title) || 'Trino probe';
        const sql = stringArg(args.sql);
        const objectId = stringArg(args.objectId) || 'trino:unknown';
        onProgress('Auto Analyst running Trino probe', { title, probe: probeCount });
        try {
          const result = await runTrinoReadOnlyProbe(settings, sql, numberArg(args.maxRows, request.maxRows));
          const probe = {
            objectId,
            source: objectId.replace(/^trino:/, ''),
            round: numberArg(args.round, 1),
            title,
            queryType: 'trino-sql' as const,
            statement: result.sql,
            rows: result.rows.slice(0, request.maxRows),
            notes: result.truncated ? ['Result was truncated to the configured probe row limit.'] : []
          };
          probes.push(probe);
          return JSON.stringify({ ok: true, probe });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push(`Trino probe "${title}" failed: ${message}`);
          return JSON.stringify({ ok: false, error: message, guidance: 'Try a simpler bounded SELECT or continue with other evidence.' });
        }
      },
      {
        name: 'run_trino_probe_readonly',
        description:
          'Execute one bounded read-only Trino/Starburst analytical probe. Input sql must be a single SELECT or WITH query. The server rejects DDL, DML, procedure calls, session changes, and multi-statements, then wraps the query with a row limit.',
        schema: z.object({
          objectId: z.string().optional(),
          title: z.string(),
          round: z.number().int().min(1).max(5).optional(),
          sql: z.string(),
          maxRows: z.number().int().min(1).max(200).optional()
        })
      }
    ),
    tool(
      async input => {
        const args: Record<string, unknown> = isRecord(input) ? input : {};
        if (probeCount >= request.maxProbes) return JSON.stringify({ ok: false, error: 'Auto analyst probe limit reached.' });
        probeCount += 1;
        const title = stringArg(args.title) || 'Elastic probe';
        const indexPattern = stringArg(args.indexPattern);
        const objectId = stringArg(args.objectId) || `elastic:${indexPattern || 'unknown'}`;
        const body: Record<string, unknown> = isRecord(args.body) ? args.body : {};
        onProgress('Auto Analyst running Elastic probe', { title, indexPattern, probe: probeCount });
        try {
          const result = await runElasticReadOnlySearch(settings, indexPattern, body, numberArg(args.maxRows, request.maxRows));
          const probe = {
            objectId,
            source: result.indexPattern,
            round: numberArg(args.round, 1),
            title,
            queryType: 'elastic-search' as const,
            statement: JSON.stringify({ indexPattern: result.indexPattern, body: result.body }),
            rows: normalizeElasticProbeRows(result).slice(0, request.maxRows),
            notes: result.truncated ? ['Result was truncated to the configured probe row limit.'] : []
          };
          probes.push(probe);
          return JSON.stringify({ ok: true, probe, aggregations: result.aggregations });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push(`Elastic probe "${title}" failed: ${message}`);
          return JSON.stringify({ ok: false, error: message, guidance: 'Try a simpler bounded _search body or continue with other evidence.' });
        }
      },
      {
        name: 'run_elastic_search_readonly',
        description:
          'Execute one bounded read-only Elasticsearch _search probe against an index pattern. Use this for aggregations, top values, trends, and small evidence samples. The server only calls _search, caps size, disables total hit tracking, and rejects expensive script/runtime/profile keys.',
        schema: z.object({
          objectId: z.string().optional(),
          title: z.string(),
          round: z.number().int().min(1).max(5).optional(),
          indexPattern: z.string(),
          body: z.object({}).passthrough(),
          maxRows: z.number().int().min(0).max(200).optional()
        })
      }
    ),
    ...(isWebSearchEnabled(settings)
      ? [
          tool(
            async input => {
              const args: Record<string, unknown> = isRecord(input) ? input : {};
              const query = stringArg(args.query);
              onProgress('Auto Analyst running web search', { query });
              try {
                const result = await runWebSearch(settings, {
                  query,
                  reason: stringArg(args.reason) || 'Auto Analyst requested current external context.',
                  recencyDays: optionalNumberArg(args.recencyDays),
                  maxResults: optionalNumberArg(args.maxResults)
                });
                probes.push({
                  objectId: 'web-search',
                  source: 'public web',
                  round: numberArg(args.round, 1),
                  title: stringArg(args.title) || `Web search: ${query}`,
                  queryType: 'web-search',
                  statement: query,
                  rows: result.results.map(item => ({
                    title: item.title,
                    url: item.url,
                    snippet: item.snippet,
                    source: item.source || null,
                    publishedAt: item.publishedAt || null
                  })),
                  notes: result.caveats
                });
                return JSON.stringify({ ok: true, result });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                skipped.push(`Web search "${query}" failed: ${message}`);
                return JSON.stringify({ ok: false, error: message });
              }
            },
            {
              name: 'web_search',
              description:
                'Search the public web through the configured web-search model when current external information, documentation, code/project context, standards, product details, or citations are needed.',
              schema: z.object({
                title: z.string().optional(),
                round: z.number().int().min(1).max(5).optional(),
                query: z.string(),
                reason: z.string().optional(),
                recencyDays: z.number().int().min(1).optional(),
                maxResults: z.number().int().min(1).max(20).optional()
              })
            }
          )
        ]
      : []),
    ...(await buildSelectedMcpDeepTools(registry, request.appIds, onProgress, toolCalls, () => {
      mcpToolRunCount += 1;
      return { allowed: mcpToolRunCount <= maxMcpToolCalls, count: mcpToolRunCount, max: maxMcpToolCalls };
    }))
  ];

  const timeout = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || Number(process.env.DEEP_AGENT_LLM_TIMEOUT_MS || 90_000);
  const agent = createDeepAgent({
    model: createDeepAgentModel(settings),
    backend: new StateBackend(),
    tools,
    systemPrompt: [
      'You are an external-facing senior auto analyst. Explore selected data objects creatively, like a human analyst forming hypotheses and testing them.',
      'Use run_trino_probe_readonly for Trino/Starburst objects and run_elastic_search_readonly for Elastic objects. Use web_search when current public context or source citations are needed. Use selected MCP tools when they can provide semantic context, documentation, code context, evidence, or visual/dashboard artifacts.',
      MCP_APP_ROUTING_GUIDANCE,
      'Prefer multiple small, thoughtful probes over one broad query. Use at least one probe for each high-priority focus source when possible.',
      'Do not use internal product wording. Do not mention agent internals, prompts, model behavior, or tool plumbing in the final narrative.',
      'Every insight must be tied to a probe result, selected MCP result, schema/sample evidence, or clearly labeled metadata inference.',
      'Only perform read-only analysis. Never request writes, creates, updates, deletes, reindexing, DDL, DML, acknowledgements, assignments, or external mutations.',
      `Budgets: up to ${request.maxProbes} read-only probes, ${request.rounds} exploration round(s), ${request.maxRows} rows per probe.`,
      settings.get('DOMAIN_KNOWLEDGE') ? `Domain knowledge:\n${settings.get('DOMAIN_KNOWLEDGE')}` : '',
      buildElasticCcsPromptGuidance(settings) ? `Elastic CCS defaults:\n${buildElasticCcsPromptGuidance(settings)}` : '',
      buildMcpReadOnlyPromptGuidance(settings) ? `Selected MCP tool safety:\n${buildMcpReadOnlyPromptGuidance(settings)}` : ''
    ].filter(Boolean).join('\n\n')
  });

  onProgress('Starting Auto Analyst Deep Agent', {
    selectedApps: request.appIds?.length || 0,
    maxProbes: request.maxProbes
  });
  const result = await agent.invoke({
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Explore the selected objects, run read-only probes and selected tools as useful, then return a concise evidence-backed analysis narrative for a final report writer.',
          runContext: request.runContext
        })
      }
    ]
  }, {
    recursionLimit: readAutoAnalystRecursionLimit(settings),
    signal: AbortSignal.timeout(timeout)
  });
  onProgress('Auto Analyst Deep Agent completed', {
    probes: probes.length,
    mcpToolCalls: mcpToolRunCount,
    previews: toolCalls.length
  });

  return {
    narrative: extractDeepAgentText(result),
    probes,
    toolCalls,
    skipped
  };
}

function createDeepAgentModel(settings: Pick<SettingsAccess, 'get'>) {
  const apiKey = settings.get('OPENAI_API_KEY');
  const baseURL = normalizeOpenAiBaseUrl(settings.get('OPENAI_BASE_URL'));
  const headers = buildDeepAgentHeaders(settings);
  const temperature = readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE');
  const topP = readOptionalNumberSetting(settings, 'OPENAI_TOP_P');
  const maxTokens = readOptionalIntegerSetting(settings, 'OPENAI_MAX_TOKENS');
  const timeout = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || Number(process.env.DEEP_AGENT_LLM_TIMEOUT_MS || 90_000);
  return new ChatOpenAI({
    model: settings.get('OPENAI_MODEL'),
    apiKey,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    maxRetries: 1,
    timeout,
    useResponsesApi: false,
    configuration: {
      baseURL,
      defaultHeaders: headers
    }
  });
}

function readDeepAgentRecursionLimit() {
  const value = Number(process.env.DEEP_AGENT_RECURSION_LIMIT || 32);
  return Number.isFinite(value) && value >= 8 ? Math.trunc(value) : 32;
}

function buildDeepAgentHeaders(settings: Pick<SettingsAccess, 'get'>) {
  const extraHeaders = readJsonHeaderObjectSetting(settings, 'OPENAI_EXTRA_HEADERS');
  const scheme = settings.get('OPENAI_AUTH_SCHEME').trim();
  if (!scheme || scheme.toLowerCase() === 'bearer') return Object.keys(extraHeaders).length ? extraHeaders : undefined;
  if (scheme.toLowerCase() === 'none') {
    return { ...extraHeaders, authorization: settings.get('OPENAI_API_KEY') };
  }
  return { ...extraHeaders, authorization: `${scheme} ${settings.get('OPENAI_API_KEY')}` };
}

export function normalizeOpenAiBaseUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized.slice(0, -'/chat/completions'.length) : normalized;
}

function extractDeepAgentText(result: unknown) {
  const messages = (result as { messages?: unknown[] }).messages || [];
  for (const message of [...messages].reverse()) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  if (typeof (result as { content?: unknown }).content === 'string') return String((result as { content: string }).content);
  return '';
}

async function buildSelectedMcpDeepTools(
  registry: McpRegistry,
  appIds: string[] | undefined,
  onProgress: ChatProgress,
  toolCalls: RenderableToolCall[],
  reserveToolRun: () => { allowed: boolean; count: number; max: number }
) {
  const selectedAppIds = appIds?.filter(Boolean) || [];
  if (!selectedAppIds.length) return [];
  const toolResults = await Promise.all(selectedAppIds.map(appId => registry.listTools(appId).catch(() => [])));
  const mcpTools = toolResults.flat() as Array<Record<string, unknown>>;
  return mcpTools
    .filter(shouldExposeAutoMcpTool)
    .map(rawTool => {
      const appId = String(rawTool.appId || '');
      const appName = String(rawTool.appName || appId);
      const toolName = String(rawTool.name || '');
      if (!appId || !toolName) return undefined;
      const deepToolName = sanitizeToolName(`${appId}__${toolName}`);
      const resourceUri = readResourceUri(rawTool);
      return tool(
        async input => {
          const run = reserveToolRun();
          if (!run.allowed) {
            return JSON.stringify({
              ok: false,
              error: `Auto Analyst reached the ${run.max} selected MCP tool-call limit.`,
              guidance: 'Stop calling MCP tools and continue from evidence already collected.'
            });
          }
          const args: Record<string, unknown> = isRecord(input) ? input : {};
          onProgress(`Auto Analyst running selected tool: ${appName}: ${toolName}`, {
            appId,
            toolName,
            toolRun: run.count
          });
          try {
            const result = await registry.callTool(appId, toolName, args);
            const embedded = readRenderableUiResource(result);
            if (resourceUri || embedded) {
              toolCalls.push({
                id: `auto-deep-${run.count}-${deepToolName}`,
                appId,
                toolName,
                toolInput: args,
                toolResult: result,
                ...(resourceUri || embedded?.resourceUri ? { resourceUri: resourceUri || embedded?.resourceUri } : {}),
                ...(embedded?.html ? { html: embedded.html } : {}),
                title: `${appName}: ${toolName}`
              });
            }
            return summarizeMcpResult(result, {
              appId,
              toolName,
              displayName: `${appName}: ${toolName}`,
              resourceUri: resourceUri || embedded?.resourceUri,
              hasEmbeddedHtml: Boolean(embedded?.html)
            });
          } catch (error) {
            return JSON.stringify({
              ok: false,
              tool: `${appId}:${toolName}`,
              error: error instanceof Error ? error.message : String(error),
              guidance: buildSelectedMcpFailureGuidance(appId, appName, toolName)
            });
          }
        },
        {
          name: deepToolName,
          description: [
            String(rawTool.description || `${toolName} from ${appName}`),
            'This is a user-selected MCP tool available to the Auto Analyst. Use it only for read-only supporting evidence, semantic context, docs/code lookup, or report visuals.',
            buildSelectedMcpRoutingHint(rawTool),
            resourceUri ? 'This tool can produce an interactive preview that can be included with the final report.' : '',
            `Input JSON schema: ${truncate(JSON.stringify(rawTool.inputSchema || {}), 1800)}`
          ].filter(Boolean).join('\n'),
          schema: z.object({}).passthrough()
        }
      );
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function buildSelectedMcpRoutingHint(rawTool: Record<string, unknown>) {
  const appId = String(rawTool.appId || '').toLowerCase();
  const appName = String(rawTool.appName || '').toLowerCase();
  const haystack = `${appId} ${appName}`;
  if (haystack.includes('data-analytics') || appName.includes('data analytics')) {
    return 'Data Analytics is a renderer/workflow layer. Use it only after source-backed rows and provenance have been collected from selected source tools.';
  }
  if (haystack.includes('trino') || haystack.includes('starburst')) {
    return 'Trino / Starburst is the source and execution layer for warehouse data. Use it for SQL execution and quick native visuals.';
  }
  if (haystack.includes('confluence') || haystack.includes('semant') || haystack.includes('docs')) {
    return 'This is a knowledge/context server. Use it for definitions, source context, semantic guidance, or documentation, not as a live data execution engine.';
  }
  return '';
}

function buildSelectedMcpFailureGuidance(appId: string, appName: string, toolName: string) {
  const haystack = `${appId} ${appName}`.toLowerCase();
  if ((haystack.includes('data-analytics') || haystack.includes('data analytics')) && /^(validate_artifact|render_artifact|render_chart|render_table)$/i.test(toolName)) {
    return 'Data Analytics rendering failed. Do not retry the same renderer payload; fall back to the source app native visual when available, especially Trino / Starburst for Trino results, or continue from reviewed source rows with SQL/provenance and caveats.';
  }
  return 'This selected tool failed. Try another selected read-only tool if useful, otherwise continue from available evidence.';
}

function shouldExposeAutoMcpTool(rawTool: Record<string, unknown>) {
  const toolName = String(rawTool.name || '').trim().toLowerCase();
  if (!toolName || ['app_only', 'app-only', 'app.only'].includes(toolName)) return false;
  const meta = (rawTool._meta || {}) as Record<string, unknown>;
  const uiMeta = isRecord(meta.ui) ? meta.ui : {};
  const visibility = [
    ...(Array.isArray(meta.visibility) ? meta.visibility : typeof meta.visibility === 'string' ? [meta.visibility] : []),
    ...(Array.isArray(uiMeta.visibility) ? uiMeta.visibility : typeof uiMeta.visibility === 'string' ? [uiMeta.visibility] : [])
  ];
  if (visibility.map(item => String(item).toLowerCase()).includes('app')) return false;
  const haystack = `${String(rawTool.appId || '')} ${String(rawTool.appName || '')} ${toolName} ${String(rawTool.description || '')}`.toLowerCase();
  return !/\b(delete|remove|update|create|write|insert|drop|alter|grant|revoke|assign|acknowledge|close|reindex|import)\b/.test(haystack) || /\b(chart|dashboard|visuali[sz]e|preview|search|query|read|get|list|find|summarize|lookup|semantic|docs|github|confluence)\b/.test(haystack);
}

function normalizeElasticProbeRows(result: { hits: Array<Record<string, unknown>>; aggregations?: unknown }) {
  const rows = result.hits.map(hit => normalizeProbeRecord(hit));
  if (rows.length) return rows;
  if (result.aggregations !== undefined) {
    return [{ aggregations: truncate(JSON.stringify(result.aggregations), 3000) }];
  }
  return [];
}

function normalizeProbeRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 40)
      .map(([key, value]) => [key, normalizeProbeValue(value)])
  ) as Record<string, string | number | boolean | null>;
}

function normalizeProbeValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return truncate(JSON.stringify(value), 500);
}

function stringArg(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberArg(value: unknown, fallback: number) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function optionalNumberArg(value: unknown) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readAutoAnalystRecursionLimit(settings: Pick<SettingsAccess, 'get'>) {
  const configured = readOptionalIntegerSetting(settings, 'AUTO_REPORT_DEEP_AGENT_RECURSION_LIMIT');
  if (configured !== undefined) return Math.max(12, configured);
  return readDeepAgentRecursionLimit();
}

function sanitizeToolName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function readResourceUri(toolDef: Record<string, unknown>) {
  const meta = toolDef._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  return readUiUri(meta?.ui?.resourceUri) || readUiUri(meta?.['ui/resourceUri']);
}

function readRenderableUiResource(value: unknown, seen = new WeakSet<object>()): { resourceUri?: string; html?: string } | undefined {
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
  const nested = isRecord(record.resource) ? readRenderableUiResource(record.resource, seen) : undefined;
  if (nested) return nested;
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

function summarizeMcpResult(
  result: unknown,
  options: { appId: string; toolName: string; displayName?: string; resourceUri?: string; hasEmbeddedHtml?: boolean }
) {
  const interactivePreview = Boolean(options.resourceUri || options.hasEmbeddedHtml);
  return truncate(JSON.stringify({
    ok: true,
    tool: `${options.appId}:${options.toolName}`,
    displayName: options.displayName,
    interactivePreview,
    ...(options.resourceUri ? { resourceUri: options.resourceUri } : {}),
    ...(interactivePreview ? { previewGuidance: 'Interactive preview captured separately for the final report.' } : {}),
    text: collectResultText(result).join('\n').slice(0, 2600),
    resultShape: summarizeResultShape(result)
  }), 4000);
}

function collectResultText(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return looksLikeMarkup(value) || value.startsWith('data:') ? [] : [truncate(value, 900)];
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap(item => collectResultText(item, seen)).slice(0, 12);
  const record = value as Record<string, unknown>;
  if (isMcpAppHtmlMime(record.mimeType)) return [];
  const direct = typeof record.text === 'string' && !looksLikeMarkup(record.text) ? [truncate(record.text, 900)] : [];
  const nested = Object.entries(record)
    .filter(([key]) => !['html', 'blob', 'data', 'dataUrl', 'resource', 'text'].includes(key))
    .flatMap(([, item]) => collectResultText(item, seen));
  return [...direct, ...nested].filter(Boolean).slice(0, 12);
}

function summarizeResultShape(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return typeof value;
  if (depth >= 2) return Array.isArray(value) ? `array(${value.length})` : 'object';
  if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.slice(0, 2).map(item => summarizeResultShape(item, depth + 1)) };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 12).map(([key, item]) => [key, summarizeResultShape(item, depth + 1)]));
}

function readUiUri(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isMcpAppHtmlMime(value: unknown) {
  if (typeof value !== 'string') return false;
  const parts = value.toLowerCase().split(';').map(part => part.trim()).filter(Boolean);
  return parts[0] === 'text/html' && parts.includes('profile=mcp-app');
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

function looksLikeMarkup(value: string) {
  return /<!doctype html|<html|<script|<body|<main|text\/html/i.test(value);
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 20))}\n...[truncated]`;
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
