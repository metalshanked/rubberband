import { createDeepAgent, StateBackend } from 'deepagents';
import { tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type { SettingsAccess } from './settings.js';
import { buildElasticCcsPromptGuidance } from './elastic-ccs.js';
import { buildMcpReadOnlyPromptGuidance } from './mcp-tool-policy.js';
import { buildElasticProfile, renderElasticProfile } from './elastic-profiler.js';
import { buildTrinoProfile, renderTrinoProfile } from './trino-profiler.js';

type ChatProgress = (message: string, detail?: Record<string, unknown>) => void;
export type AnalysisTarget = 'elastic' | 'trino' | 'all';
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

function createDeepAgentModel(settings: Pick<SettingsAccess, 'get'>) {
  const apiKey = settings.get('OPENAI_API_KEY');
  const baseURL = normalizeOpenAiBaseUrl(settings.get('OPENAI_BASE_URL'));
  const headers = buildDeepAgentHeaders(settings);
  const temperature = readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE') ?? 0;
  const topP = readOptionalNumberSetting(settings, 'OPENAI_TOP_P');
  const maxTokens = readOptionalIntegerSetting(settings, 'OPENAI_MAX_TOKENS');
  const timeout = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || Number(process.env.DEEP_AGENT_LLM_TIMEOUT_MS || 90_000);
  return new ChatOpenAI({
    model: settings.get('OPENAI_MODEL'),
    apiKey,
    temperature,
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
