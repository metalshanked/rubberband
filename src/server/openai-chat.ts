import type { ChatMessage, RenderableToolCall } from './types.js';
import type { McpRegistry } from './mcp-registry.js';
import type { SettingsAccess } from './settings.js';
import { type AnalysisTarget, runAnalyticsDeepAgent, runRubberbandDeepAgent } from './deep-agent-runner.js';
import type { TrinoProfile, TrinoProfileFocusTarget } from './trino-profiler.js';
import { fetchWithMasterTls } from './tls.js';
import type { AnalyticsProfileSnapshot } from './analytics-profile-service.js';
import { buildElasticCcsPromptGuidance } from './elastic-ccs.js';
import { buildMcpReadOnlyPromptGuidance } from './mcp-tool-policy.js';
import { sanitizeErrorMessage } from './error-explainer.js';
import { isWebSearchEnabled, runWebSearch } from './web-search.js';
import { tool as langchainTool } from 'langchain';
import { z } from 'zod';

type OpenAiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | OpenAiContentPart[] | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
  source: 'llm';
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
  usage?: Record<string, unknown>;
  model?: string;
};

type ToolMapEntry = {
  appId: string;
  toolName: string;
  displayName: string;
  resourceUri?: string;
};

type RenderableUiResource = {
  resourceUri?: string;
  html?: string;
};

type ChatProgress = (message: string, detail?: Record<string, unknown>) => void;

type AnalyticsProfileReader = {
  snapshot(): AnalyticsProfileSnapshot;
  getPromptContext(): string;
  renderProfile(target: AnalysisTarget): string;
  refreshNow(reason?: string): Promise<void>;
};

export type ChatRunOptions = {
  deepAnalysis?: boolean;
  focusTargets?: FocusTarget[];
};

export type FocusTarget =
  | {
      source: 'trino';
      catalog?: string;
      schema?: string;
      table?: string;
      tableType?: string;
      label?: string;
    }
  | {
      source: 'elastic';
      indexPattern: string;
      kind?: string;
      label?: string;
    };

export type TrinoCatalogMap = {
  catalogs: Array<{
    id: string;
    tableCount: number;
    schemaCount: number;
    domains: string[];
    sampleTables: string[];
  }>;
  links: Array<{
    source: string;
    target: string;
    strength: number;
    reasons: string[];
  }>;
  skipped: {
    catalogs: number;
    uninspectedTables: number;
    inaccessibleCatalogs: string[];
  };
};

const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 16);
const MAX_TOOL_RESULT_CHARS = Number(process.env.MAX_TOOL_RESULT_CHARS || 12000);
const MAX_DEEP_AGENT_TOOL_CALLS = Number(process.env.MAX_DEEP_AGENT_TOOL_CALLS || 24);
const MAX_DEEP_AGENT_RESULT_CHARS = Number(process.env.MAX_DEEP_AGENT_RESULT_CHARS || 4000);
const MAX_SKILLS_PER_APP = Number(process.env.MAX_SKILLS_PER_APP || 8);
const MAX_SKILL_CHARS = Number(process.env.MAX_SKILL_CHARS || 2600);
const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 40);
const MAX_CONTEXT_MESSAGE_CHARS = Number(process.env.MAX_CONTEXT_MESSAGE_CHARS || 3000);

const MCP_APP_ROUTING_GUIDANCE = [
  'MCP app routing:',
  '- Treat source apps such as Trino, Starburst, Elasticsearch, and domain apps as the source of truth for live data, metadata, and domain-specific workflows.',
  '- Treat renderer apps such as Data Analytics as presentation and artifact engines. Use them after source-backed data has been obtained, reviewed, bounded, and paired with provenance such as runnable SQL or source metadata.',
  '- For Trino-heavy requests, use Trino / Starburst tools for SQL execution and simple native visuals. Use Data Analytics for polished analytical charts, tables, dashboards, reports, artifact validation, and semantic workflow guidance.',
  '- For domain workflows such as Elastic Security, Observability, Kibana dashboards, or alert/case work, prefer the native domain UI app instead of recreating the same view through a generic renderer.',
  '- Knowledge or headless MCP servers such as docs, Confluence, semantic catalogs, or code/context servers provide evidence and definitions; they do not replace source query execution or UI rendering.',
  '- Avoid duplicate previews. If multiple UI apps can render the same result, choose one final preview: domain-native for domain operations, Trino-native for quick SQL visuals, and Data Analytics for polished reports or presentation-grade artifacts.',
  '- If Data Analytics rendering or validation fails, do not repeatedly retry the same renderer call. Fall back to the source app native visualization when available, especially Trino / Starburst for Trino results; otherwise answer from the reviewed source rows with SQL/provenance and caveats.'
].join('\n');

export async function runChat(
  registry: McpRegistry,
  settings: SettingsAccess,
  messages: ChatMessage[],
  appIds?: string[],
  onProgress: ChatProgress = () => undefined,
  analyticsProfiles?: AnalyticsProfileReader,
  options: ChatRunOptions = {}
) {
  onProgress('Checking LLM settings', {
    requestMessages: messages.length,
    selectedApps: appIds?.length || 0,
    deepAnalysis: options.deepAnalysis === true,
    focusTargets: options.focusTargets?.length || 0
  });
  const apiKey = settings.get('OPENAI_API_KEY');
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  const analysisTarget = parseDeepAnalysisTarget(latestUserMessage);
  const focusTargets = normalizeFocusTargets(options.focusTargets || []);
  const focusContext = renderFocusPromptContext(focusTargets);
  const trinoFocusTargets = getTrinoFocusTargets(focusTargets);

  if (trinoFocusTargets.length && isFocusedTrinoMetadataRequest(latestUserMessage)) {
    return runFocusedTrinoMetadata(settings, latestUserMessage, onProgress, trinoFocusTargets);
  }

  if (!options.deepAnalysis && isTrinoCatalogMapRequest(latestUserMessage)) {
    return runTrinoCatalogMap(settings, latestUserMessage, onProgress, analyticsProfiles, trinoFocusTargets);
  }

  if (options.deepAnalysis) {
    return runDeepAgentToolChat(registry, settings, messages, appIds, onProgress, analyticsProfiles, focusContext);
  }

  if (analysisTarget) {
    return runDeepAnalysis(settings, latestUserMessage, analysisTarget, onProgress, analyticsProfiles, { focusContext, focusTargets: trinoFocusTargets });
  }

  if (!apiKey) {
    onProgress('Discovering MCP tools', { selectedApps: appIds?.length || 0 });
    const tools = await registry.listTools().catch(() => []);
    onProgress('Waiting for LLM API key', { discoveredTools: tools.length, requiredSetting: 'OPENAI_API_KEY' });
    const content = 'Set OPENAI_API_KEY to enable model-driven chat. MCP discovery is working; available tools are listed in the sidebar.';
    const toolCalls = [] as RenderableToolCall[];
    return {
      content,
      toolCalls,
      followUps: generateSuggestedFollowUps(content, toolCalls, latestUserMessage),
      toolCount: tools.length
    };
  }

  onProgress('Preparing MCP tools', { selectedApps: appIds?.length || 0 });
  const { tools, toolMap } = await buildOpenAiTools(registry, appIds, settings);
  onProgress(tools.length ? `Loaded ${tools.length} MCP tools` : 'No MCP tools selected', { toolCount: tools.length });
  const openAiMessages: OpenAiMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(
        registry,
        appIds,
        settings.get('DOMAIN_KNOWLEDGE'),
        buildVizContract(settings),
        analyticsProfiles?.getPromptContext(),
        buildElasticCcsPromptGuidance(settings),
        buildMcpReadOnlyPromptGuidance(settings),
        focusContext,
        isWebSearchEnabled(settings) ? 'A web_search tool is available for current public web context and source citations. Use it when the answer depends on recent or external information not present in selected data/tools.' : ''
      )
    },
    ...compactChatMessages(messages).map(message => ({ role: message.role, content: openAiContentForMessage(message) }))
  ];

  const renderableToolCalls: RenderableToolCall[] = [];
  const renderableToolCallIndexes = new Map<string, number>();
  let latestRenderableToolCall: RenderableToolCall | undefined;
  let finalContent = '';
  const tokenUsage = createTokenUsageAccumulator(settings.get('OPENAI_MODEL'));

  for (let turn = 0; turn < MAX_TOOL_LOOPS; turn += 1) {
    onProgress(turn === 0 ? 'Calling LLM' : 'Sending tool results to LLM', {
      turn: turn + 1,
      model: settings.get('OPENAI_MODEL'),
      messageCount: openAiMessages.length,
      toolDefinitions: tools.length
    });
    const completion = await createChatCompletion(settings, openAiMessages, tools);
    tokenUsage.add(completion.usage, completion.model);
    const choice = completion.choices?.[0]?.message;
    if (!choice) throw new Error('Model returned no message');

    if (!choice.tool_calls?.length) {
      onProgress('Rendering final answer', { turn: turn + 1, toolResults: renderableToolCalls.length });
      finalContent = choice.content || '';
      break;
    }

    onProgress(`LLM requested ${choice.tool_calls.length} tool call${choice.tool_calls.length === 1 ? '' : 's'}`, {
      requestedTools: choice.tool_calls.map(toolCall => toolCall.function.name).slice(0, 8)
    });
    openAiMessages.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: choice.tool_calls
    });

    for (const toolCall of choice.tool_calls) {
      const entry = toolMap.get(toolCall.function.name);
      if (!entry) {
        onProgress(`Skipping unknown tool ${toolCall.function.name}`);
        openAiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Unknown tool: ${toolCall.function.name}`
        });
        continue;
      }

      const args = parseToolArgs(toolCall.function.arguments);
      onProgress(`Running ${entry.displayName}`, {
        appId: entry.appId,
        toolName: entry.toolName,
        input: summarizeProgressPayload(args)
      });
      const invalidSqlPlaceholder = findLiteralAutoSqlPlaceholder(args);
      if (invalidSqlPlaceholder) {
        onProgress(`${entry.displayName} blocked invalid focus placeholder`, {
          appId: entry.appId,
          toolName: entry.toolName,
          placeholder: invalidSqlPlaceholder
        });
        openAiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: false,
            tool: `${entry.appId}:${entry.toolName}`,
            error: `Invalid SQL object placeholder: ${invalidSqlPlaceholder}`,
            guidance: 'The focus placeholder is a wildcard, not a SQL identifier. Do not query a table named auto or *. Discover or choose a concrete table/view inside the focused catalog/schema, then retry with that exact object name.'
          })
        });
        continue;
      }
      let result: unknown;
      try {
        result = isWebSearchTool(entry)
          ? await runWebSearch(settings, {
              query: String(args.query || ''),
              reason: typeof args.reason === 'string' ? args.reason : undefined,
              recencyDays: readOptionalIntegerArg(args.recencyDays),
              maxResults: readOptionalIntegerArg(args.maxResults)
            })
          : await registry.callTool(entry.appId, entry.toolName, args);
      } catch (error) {
        const sanitizedError = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
        onProgress(`${entry.displayName} failed; asking the model to recover`, {
          appId: entry.appId,
          toolName: entry.toolName,
          error: sanitizedError
        });
        openAiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: false,
            tool: `${entry.appId}:${entry.toolName}`,
            error: sanitizedError,
            guidance: buildToolFailureGuidance(entry)
          })
        });
        continue;
      }
      onProgress(`Received result from ${entry.displayName}`, {
        appId: entry.appId,
        toolName: entry.toolName,
        preview: Boolean(entry.resourceUri || readRenderableUiResource(result)),
        result: summarizeProgressPayload(result)
      });

      const embeddedUiResource = readRenderableUiResource(result);
      const serializedResult = serializeMcpToolResultForModel(result, {
        appId: entry.appId,
        toolName: entry.toolName,
        displayName: entry.displayName,
        resourceUri: entry.resourceUri || embeddedUiResource?.resourceUri,
        hasEmbeddedHtml: Boolean(embeddedUiResource?.html)
      });
      openAiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: serializedResult });
      if (entry.resourceUri || embeddedUiResource) {
        const resourceUri = entry.resourceUri || embeddedUiResource?.resourceUri;
        const renderableToolCall: RenderableToolCall = {
          id: toolCall.id,
          appId: entry.appId,
          toolName: entry.toolName,
          toolInput: args,
          toolResult: result,
          ...(resourceUri ? { resourceUri } : {}),
          ...(embeddedUiResource?.html ? { html: embeddedUiResource.html } : {}),
          title: entry.displayName
        };
        latestRenderableToolCall = renderableToolCall;
        const key = renderableToolCallKey(renderableToolCall);
        const existingIndex = renderableToolCallIndexes.get(key);
        if (existingIndex === undefined) {
          renderableToolCallIndexes.set(key, renderableToolCalls.length);
          renderableToolCalls.push(renderableToolCall);
        } else {
          renderableToolCalls[existingIndex] = renderableToolCall;
        }
      }
    }
  }

  if (!finalContent) {
    onProgress('Stopped after tool-call limit', { maxToolLoops: MAX_TOOL_LOOPS });
    finalContent = latestRenderableToolCall
      ? 'I stopped after reaching the tool-call limit, but the latest generated preview is available below.'
      : 'I reached the tool-call limit before the model produced a final answer.';
  }

  const toolCalls = latestRenderableToolCall ? [latestRenderableToolCall] : [];
  const usage = tokenUsage.snapshot();
  const followUps = await generateResponseFollowUps(settings, finalContent, toolCalls, latestUserMessage, onProgress);
  onProgress('Done', {
    toolCalls: toolCalls.length,
    followUps: followUps.length,
    tokens: usage?.totalTokens
  });
  return {
    content: finalContent,
    toolCalls,
    followUps,
    ...(usage ? { usage } : {})
  };
}

async function runDeepAgentToolChat(
  registry: McpRegistry,
  settings: SettingsAccess,
  messages: ChatMessage[],
  appIds: string[] | undefined,
  onProgress: ChatProgress,
  analyticsProfiles?: AnalyticsProfileReader,
  focusContext = ''
) {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  if (!settings.get('OPENAI_API_KEY')) {
    onProgress('Waiting for LLM API key');
    const content = 'Set OPENAI_API_KEY to use Deep Analysis. MCP discovery can still work, but Deep Agents need an LLM.';
    const toolCalls = [] as RenderableToolCall[];
    return { content, toolCalls, followUps: generateSuggestedFollowUps(content, toolCalls, latestUserMessage) };
  }

  onProgress('Preparing MCP tools for Deep Agent', { selectedApps: appIds?.length || 0 });
  const { tools: mcpTools, toolMap } = await buildOpenAiTools(registry, appIds, settings);
  const renderableToolCalls: RenderableToolCall[] = [];
  const renderableToolCallIndexes = new Map<string, number>();
  let latestRenderableToolCall: RenderableToolCall | undefined;
  let toolRunCount = 0;

  const deepTools = mcpTools.map(openAiTool => {
    const definition = (openAiTool as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function || {};
    const toolName = String(definition.name || '');
    const entry = toolMap.get(toolName);
    if (!entry) return undefined;
    const schemaHint = truncate(JSON.stringify(definition.parameters || {}), 2200);
    const ccsGuidance = isElasticToolMapEntry(entry) ? buildElasticCcsPromptGuidance(settings) : '';
    return langchainTool(
      async input => {
        const args = isRecord(input) ? input : {};
        if (toolRunCount >= MAX_DEEP_AGENT_TOOL_CALLS) {
          return JSON.stringify({
            ok: false,
            error: `Deep Analysis reached the ${MAX_DEEP_AGENT_TOOL_CALLS} MCP tool-call limit.`,
            guidance: 'Stop calling tools and produce the best final answer from the results already available.'
          });
        }
        toolRunCount += 1;
        onProgress(`Deep Agent running ${entry.displayName}`, {
          appId: entry.appId,
          toolName: entry.toolName,
          input: summarizeProgressPayload(args),
          toolRun: toolRunCount
        });
        const invalidSqlPlaceholder = findLiteralAutoSqlPlaceholder(args);
        if (invalidSqlPlaceholder) {
          return JSON.stringify({
            ok: false,
            tool: `${entry.appId}:${entry.toolName}`,
            error: `Invalid SQL object placeholder: ${invalidSqlPlaceholder}`,
            guidance: 'The focus placeholder is a wildcard, not a SQL identifier. Do not query a table named auto or *. Discover or choose a concrete table/view inside the focused catalog/schema, then retry with that exact object name.'
          });
        }
        let result: unknown;
        try {
          result = isWebSearchTool(entry)
            ? await runWebSearch(settings, {
                query: String(args.query || ''),
                reason: typeof args.reason === 'string' ? args.reason : undefined,
                recencyDays: readOptionalIntegerArg(args.recencyDays),
                maxResults: readOptionalIntegerArg(args.maxResults)
              })
            : await registry.callTool(entry.appId, entry.toolName, args);
        } catch (error) {
          return JSON.stringify({
            ok: false,
            tool: `${entry.appId}:${entry.toolName}`,
            error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
            guidance: buildToolFailureGuidance(entry)
          });
        }
        onProgress(`Deep Agent received result from ${entry.displayName}`, {
          appId: entry.appId,
          toolName: entry.toolName,
          preview: Boolean(entry.resourceUri || readRenderableUiResource(result)),
          result: summarizeProgressPayload(result)
        });

        const embeddedUiResource = readRenderableUiResource(result);
        if (entry.resourceUri || embeddedUiResource) {
          const resourceUri = entry.resourceUri || embeddedUiResource?.resourceUri;
          const renderableToolCall: RenderableToolCall = {
            id: `deep-${toolRunCount}-${toolName}`,
            appId: entry.appId,
            toolName: entry.toolName,
            toolInput: args,
            toolResult: result,
            ...(resourceUri ? { resourceUri } : {}),
            ...(embeddedUiResource?.html ? { html: embeddedUiResource.html } : {}),
            title: entry.displayName
          };
          latestRenderableToolCall = renderableToolCall;
          const key = renderableToolCallKey(renderableToolCall);
          const existingIndex = renderableToolCallIndexes.get(key);
          if (existingIndex === undefined) {
            renderableToolCallIndexes.set(key, renderableToolCalls.length);
            renderableToolCalls.push(renderableToolCall);
          } else {
            renderableToolCalls[existingIndex] = renderableToolCall;
          }
        }

        return summarizeMcpToolResultForDeepAgent(result, {
          appId: entry.appId,
          toolName: entry.toolName,
          displayName: entry.displayName,
          resourceUri: entry.resourceUri || embeddedUiResource?.resourceUri,
          hasEmbeddedHtml: Boolean(embeddedUiResource?.html)
        });
      },
      {
        name: toolName,
        description: [
          String(definition.description || entry.displayName),
          'Use this selected MCP app tool when it directly helps the user request.',
          entry.resourceUri ? 'This tool can produce an interactive MCP Apps UI preview. For visualization requests, prefer calling it over describing a chart.' : '',
          ccsGuidance ? `Elastic CCS default: ${ccsGuidance}` : '',
          schemaHint ? `Input JSON schema: ${schemaHint}` : ''
        ]
          .filter(Boolean)
          .join('\n'),
        schema: z.object({}).passthrough()
      }
    );
  });
  const availableDeepTools = deepTools.filter((item): item is NonNullable<typeof item> => Boolean(item));

  const systemPrompt = [
    'You are Rubberband Deep Analysis, an agentic analytics assistant inside a custom MCP Apps host.',
    'You can use the selected MCP tools to answer normal chat requests, including dashboards, charts, SQL analytics, Elastic, Kibana, Trino, Starburst, security, observability, and interactive previews.',
    'For chart, dashboard, visualization, or preview requests, call the relevant MCP tool and produce the interactive result. Do not only describe a chart when a selected MCP visualization tool can create it.',
    MCP_APP_ROUTING_GUIDANCE,
    'For broad investigation requests, reason step by step and use tools as needed, but keep the final answer concise.',
    'Only perform read-only analysis. Do not ask tools to import, save, create, update, delete, reindex, acknowledge, close, assign, run DDL/DML, or otherwise mutate external systems.',
    analyticsProfiles?.getPromptContext() ? `Background analytics profile context:\n${analyticsProfiles.getPromptContext()}` : '',
    focusContext ? `Focus analysis targets:\n${focusContext}` : '',
    settings.get('DOMAIN_KNOWLEDGE') ? `Domain Knowledge:\n${settings.get('DOMAIN_KNOWLEDGE')}` : '',
    buildElasticCcsPromptGuidance(settings) ? `Elastic CCS defaults:\n${buildElasticCcsPromptGuidance(settings)}` : '',
    buildMcpReadOnlyPromptGuidance(settings) ? `MCP tool safety:\n${buildMcpReadOnlyPromptGuidance(settings)}` : '',
    'When an MCP tool returns an interactive preview, mention that the preview is available below and summarize what it shows.'
  ]
    .filter(Boolean)
    .join('\n\n');

  const request = compactChatMessages(messages)
    .map(message => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');
  const content = await runRubberbandDeepAgent(settings, request, availableDeepTools, systemPrompt, onProgress);
  onProgress('Done');
  const toolCalls = latestRenderableToolCall ? [latestRenderableToolCall] : [];
  return { content, toolCalls, followUps: generateSuggestedFollowUps(content, toolCalls, latestUserMessage) };
}

async function runDeepAnalysis(
  settings: SettingsAccess,
  request: string,
  target: AnalysisTarget,
  onProgress: ChatProgress,
  analyticsProfiles?: AnalyticsProfileReader,
  options: { forceDeepAgent?: boolean; focusContext?: string; focusTargets?: TrinoProfileFocusTarget[] } = {}
) {
  if (options.focusTargets?.length) {
    const profileText = applyFocusContextToProfile(await runProfileFallback(settings, request, target, onProgress, options.focusTargets), options.focusContext);
    onProgress('Done');
    const toolCalls = [] as RenderableToolCall[];
    return { content: profileText, toolCalls, followUps: generateSuggestedFollowUps(profileText, toolCalls, request) };
  }

  if (analyticsProfiles && !options.forceDeepAgent) {
    onProgress('Reading background analytics profile');
    const content = applyFocusContextToProfile(analyticsProfiles.renderProfile(target), options.focusContext);
    const snapshot = analyticsProfiles.snapshot();
    const relevantStatuses = target === 'all' ? [snapshot.elastic.status, snapshot.trino.status] : [snapshot[target].status];
    if (relevantStatuses.some(status => status === 'idle' || status === 'error' || status === 'stale' || status === 'skipped') && !snapshot.running) {
      void analyticsProfiles.refreshNow('chat-profile-request');
    }
    onProgress('Done');
    const toolCalls = [] as RenderableToolCall[];
    return { content, toolCalls, followUps: generateSuggestedFollowUps(content, toolCalls, request) };
  }

  if (!settings.get('OPENAI_API_KEY')) {
    const profileText = applyFocusContextToProfile(await runProfileFallback(settings, request, target, onProgress), options.focusContext);
    onProgress('Done');
    const toolCalls = [] as RenderableToolCall[];
    return { content: profileText, toolCalls, followUps: generateSuggestedFollowUps(profileText, toolCalls, request) };
  }

  const content = await runAnalyticsDeepAgent(settings, request, target, onProgress);
  onProgress('Done');

  const toolCalls = [] as RenderableToolCall[];
  return {
    content,
    toolCalls,
    followUps: generateSuggestedFollowUps(content, toolCalls, request)
  };
}

async function runProfileFallback(settings: SettingsAccess, request: string, target: AnalysisTarget, onProgress: ChatProgress, focusTargets: TrinoProfileFocusTarget[] = []) {
  const sections = [];
  if (target === 'elastic' || target === 'all') {
    const { buildElasticProfile, renderElasticProfile } = await import('./elastic-profiler.js');
    onProgress('Running bounded Elastic profiler');
    sections.push(renderElasticProfile(await buildElasticProfile(settings, parseElasticProfileOptions(request))));
  }
  if (target === 'trino' || target === 'all') {
    const { buildTrinoProfile, renderTrinoProfile } = await import('./trino-profiler.js');
    onProgress('Running bounded Trino / Starburst profiler');
    sections.push(renderTrinoProfile(await buildTrinoProfile(settings, { ...parseTrinoProfileOptions(request), focusTargets })));
  }
  if (target === 'all') {
    sections.push(renderFederatedProfileNote());
  }
  return sections.join('\n\n');
}

async function runFocusedTrinoMetadata(settings: SettingsAccess, request: string, onProgress: ChatProgress, focusTargets: TrinoProfileFocusTarget[]) {
  const { buildTrinoProfile } = await import('./trino-profiler.js');
  onProgress('Running focused Trino / Starburst metadata lookup');
  const profile = await buildTrinoProfile(settings, { ...parseTrinoProfileOptions(request), focusTargets });
  const sourceLines = profile.analyzedTables.slice(0, 30).map(table => {
    const columns = table.columns.length ? `; columns ${table.columns.slice(0, 8).map(column => column.name).join(', ')}` : '';
    return `- \`${table.catalog}.${table.schema}.${table.name}\` (${table.type}${columns})`;
  });
  const focusLabel = focusTargets
    .map(formatTrinoFocusPath)
    .join(', ');
  const boundsLine = profile.skipped.uninspectedTables || profile.skipped.uninspectedColumnTables
    ? `Bounds: skipped ${profile.skipped.uninspectedTables} table(s) and ${profile.skipped.uninspectedColumnTables || 0} column inspection(s).`
    : '';
  const content = [
    `Focused Trino / Starburst metadata for ${focusLabel}:`,
    '',
    sourceLines.length ? sourceLines.join('\n') : 'No matching tables or views were found within the selected focus target.',
    ...(boundsLine ? ['', boundsLine] : [])
  ].filter(Boolean).join('\n');
  onProgress('Done');
  const toolCalls = [] as RenderableToolCall[];
  return { content, toolCalls, followUps: generateSuggestedFollowUps(content, toolCalls, request) };
}

async function runTrinoCatalogMap(
  settings: SettingsAccess,
  request: string,
  onProgress: ChatProgress,
  analyticsProfiles?: AnalyticsProfileReader,
  focusTargets: TrinoProfileFocusTarget[] = []
) {
  const { buildTrinoProfile } = await import('./trino-profiler.js');
  onProgress(analyticsProfiles ? 'Reading background Trino catalog profile' : 'Building bounded Trino catalog map');
  const backgroundProfile = analyticsProfiles?.snapshot().trino.profile;
  if (analyticsProfiles && !backgroundProfile && !focusTargets.length) {
    void analyticsProfiles.refreshNow('chat-catalog-map-request');
    const content = 'The shared Trino catalog profile is not ready yet. Rubberband has started or queued a background profiler run; try the catalog map again after it completes.';
    const toolCalls = [] as RenderableToolCall[];
    onProgress('Done');
    return { content, toolCalls, followUps: generateSuggestedFollowUps(content, toolCalls, request) };
  }
  const profile = (!focusTargets.length && backgroundProfile) || await buildTrinoProfile(settings, {
      ...parseTrinoProfileOptions(request),
      maxCatalogs: parseTrinoProfileOptions(request).maxCatalogs || readSettingBound(settings, 'TRINO_PROFILER_MAX_CATALOGS'),
      focusTargets
    });
  const map = buildTrinoCatalogMap(profile);
  onProgress('Rendering Trino catalog map');

  const content = renderTrinoCatalogMapSummary(profile, map);
  const toolCalls = [
      {
        id: `rubberband-trino-catalog-map-${Date.now()}`,
        appId: 'rubberband',
        toolName: 'trino_catalog_map',
        toolInput: { request },
        toolResult: {
          kind: 'trinoCatalogMap',
          profile,
          map
        },
        title: 'Trino catalog relationship map'
      }
    ] as RenderableToolCall[];

  return {
    content,
    toolCalls,
    followUps: generateSuggestedFollowUps(content, toolCalls, request)
  };
}

export function buildSystemPrompt(registry: Pick<McpRegistry, 'getSkillGuidance'>, appIds?: string[], domainKnowledge = '', vizContract = '', analyticsProfileContext = '', elasticCcsGuidance = '', mcpSafetyGuidance = '', focusContext = '', webSearchGuidance = '') {
  const base = [
    'You are a concise analytics assistant inside Rubberband, a custom MCP Apps host. Use selected MCP app tools when the user asks about dashboards, SQL analytics, Elasticsearch or Kibana data, Trino or Starburst warehouses, security workflows, observability, alerts, APM, Kubernetes, anomalies, import/export, or interactive previews. Keep visualization and dashboard tool calls bounded: prefer aggregate queries, explicit top-N limits, concrete index/data-view/table targets, and a time range when available. If a broad dashboard request fails or times out, recover with one focused read-only visualization instead of repeating the same broad call. After tool calls, summarize what changed, what you observed, and any required configuration. Prefer one meaningful tool call at a time, then narrate the result before drilling deeper. Once a useful final visualization, dashboard, or interactive app preview is produced, stop calling tools and provide a concise final answer.',
    MCP_APP_ROUTING_GUIDANCE
  ].join('\n\n');

  const skills = registry.getSkillGuidance(appIds);
  const domainSection = domainKnowledge
    ? `\n\nUser-provided domain knowledge:\n${truncate(domainKnowledge, 4000)}\nUse this as guidance for index names, custom schemas, and field meanings, but do not claim facts that require querying data unless a tool result supports them.`
    : '';
  const vizSection = vizContract
    ? `\n\nRubberband visualization contract:\n${vizContract}\nApply these as presentation defaults when an MCP app/tool supports them. Do not suppress native Kibana, Elastic, Trino, or Starburst functionality to force parity; unsupported contract items may be ignored.`
    : '';
  const analyticsProfileSection = analyticsProfileContext
    ? `\n\nShared background analytics profile:\n${truncate(analyticsProfileContext, 5000)}\nUse this as cached metadata context. Treat it as a snapshot, not live query results. If the user needs current values or rows, call the selected MCP app tools.`
    : '';
  const elasticCcsSection = elasticCcsGuidance
    ? `\n\nElastic cross-cluster search defaults:\n${truncate(elasticCcsGuidance, 2000)}`
    : '';
  const mcpSafetySection = mcpSafetyGuidance
    ? `\n\nMCP tool safety:\n${truncate(mcpSafetyGuidance, 2000)}`
    : '';
  const focusSection = focusContext
    ? `\n\nFocus analysis targets:\n${truncate(focusContext, 3000)}\nPrefer these targets for discovery, profiling, visualizations, and tool calls unless the user explicitly asks to broaden the search. In Trino / Starburst targets, * is a wildcard placeholder, not a SQL identifier. Never put auto or * in a SQL table path. If a target is catalog.schema.*, first discover or select a concrete table/view in that catalog and schema, then query the exact object.`
    : '';
  const webSearchSection = webSearchGuidance ? `\n\nWeb search:\n${truncate(webSearchGuidance, 1000)}` : '';
  if (!skills.length) return `${base}${domainSection}${vizSection}${analyticsProfileSection}${elasticCcsSection}${mcpSafetySection}${focusSection}${webSearchSection}`;

  const grouped = new Map<string, typeof skills>();
  for (const skill of skills) {
    const key = `${skill.appId}:${skill.appName}`;
    grouped.set(key, [...(grouped.get(key) || []), skill]);
  }

  const sections = [];
  for (const [key, appSkills] of grouped) {
    const [, appName] = key.split(':');
    const selected = appSkills.slice(0, MAX_SKILLS_PER_APP);
    sections.push(
      `\n\nSelected app guidance for ${appName}:\n` +
        selected
          .map(skill => {
            const header = `Skill: ${skill.name}${skill.description ? ` - ${skill.description}` : ''}`;
            return `${header}\n${truncate(skill.content, MAX_SKILL_CHARS)}`;
          })
          .join('\n\n')
    );
  }

  return `${base}${domainSection}${vizSection}${analyticsProfileSection}${elasticCcsSection}${mcpSafetySection}${focusSection}${webSearchSection}${sections.join('')}`;
}

function renderFocusPromptContext(targets: FocusTarget[]) {
  const lines = targets.map(target => {
    if (target.source === 'trino') {
      return `- Trino / Starburst: ${formatTrinoFocusPath(target)} (${target.tableType || 'any type'})`;
    }
    return `- Elasticsearch: ${target.indexPattern}${target.kind ? ` (${target.kind})` : ''}`;
  });
  return lines.join('\n');
}

function formatTrinoFocusPath(target: Pick<Extract<FocusTarget, { source: 'trino' }>, 'catalog' | 'schema' | 'table'> | TrinoProfileFocusTarget) {
  return [target.catalog || '*', target.schema || '*', target.table || '*'].join('.');
}

function applyFocusContextToProfile(content: string, focusContext = '') {
  return focusContext ? `Focus analysis targets:\n${focusContext}\n\n${content}` : content;
}

export function buildVizContract(settings: Pick<SettingsAccess, 'get'>) {
  const entries = [
    ['theme', settings.get('RUBBERBAND_VIZ_THEME')],
    ['palette', settings.get('RUBBERBAND_VIZ_PALETTE')],
    ['density', settings.get('RUBBERBAND_VIZ_DENSITY')],
    ['legend', settings.get('RUBBERBAND_VIZ_LEGEND')],
    ['tooltip', settings.get('RUBBERBAND_VIZ_TOOLTIP')],
    ['timezone', settings.get('RUBBERBAND_VIZ_TIMEZONE')],
    ['preferNativeFeatures', settings.get('RUBBERBAND_VIZ_NATIVE_FEATURES') || 'true']
  ].filter(([, value]) => value);
  if (!entries.length) return '';
  return entries.map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

async function buildOpenAiTools(registry: McpRegistry, appIds?: string[], settings?: Pick<SettingsAccess, 'get'>) {
  const selectedAppIds = appIds?.filter(Boolean);
  const toolResults = appIds !== undefined
    ? selectedAppIds?.length
    ? await Promise.all(selectedAppIds.map(appId => registry.listTools(appId).catch(() => [])))
      : []
    : [await registry.listTools()];
  const mcpTools = toolResults.flat() as Array<Record<string, unknown>>;
  const toolMap = new Map<string, ToolMapEntry>();
  const tools = [];

  for (const tool of mcpTools) {
    const appId = String(tool.appId);
    const toolName = String(tool.name);
    if (!shouldExposeMcpToolToModel(tool)) continue;

    const openAiName = sanitizeToolName(`${appId}__${toolName}`);
    const resourceUri = readResourceUri(tool);
    const ccsGuidance = settings && isElasticMcpTool(tool) ? buildElasticCcsPromptGuidance(settings) : '';
    toolMap.set(openAiName, {
      appId,
      toolName,
      displayName: `${String(tool.appName || appId)}: ${toolName}`,
      resourceUri
    });

    tools.push({
      type: 'function',
      function: {
        name: openAiName,
        description: buildMcpToolDescription(tool, ccsGuidance),
        parameters: normalizeJsonSchema(tool.inputSchema)
      }
    });
  }

  if (settings && isWebSearchEnabled(settings)) {
    const openAiName = 'rubberband_web_search';
    toolMap.set(openAiName, {
      appId: 'rubberband-web',
      toolName: 'web_search',
      displayName: 'Web Search'
    });
    tools.push({
      type: 'function',
      function: {
        name: openAiName,
        description:
          'Search the public web through the configured web-search model when current external information, documentation, news, product details, or source citations are needed. Returns structured results with titles, URLs, snippets, summary, and caveats.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Specific web search query.' },
            reason: { type: 'string', description: 'Why web search is needed for the current task.' },
            recencyDays: { type: 'integer', description: 'Optional recency window in days.' },
            maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum results to return.' }
          },
          required: ['query']
        }
      }
    });
  }

  return { tools, toolMap };
}

function isWebSearchTool(entry: ToolMapEntry) {
  return entry.appId === 'rubberband-web' && entry.toolName === 'web_search';
}

function isElasticMcpTool(tool: Record<string, unknown>) {
  const appId = String(tool.appId || '').toLowerCase();
  const appName = String(tool.appName || '').toLowerCase();
  return appId.includes('elastic') || appName.includes('elastic') || ['dashbuilder', 'security', 'observability'].includes(appId);
}

function isTrinoMcpTool(tool: Record<string, unknown>) {
  const appId = String(tool.appId || '').toLowerCase();
  const appName = String(tool.appName || '').toLowerCase();
  return appId.includes('trino') || appName.includes('trino') || appId.includes('starburst') || appName.includes('starburst');
}

function isDataAnalyticsMcpTool(tool: Record<string, unknown>) {
  const appId = String(tool.appId || '').toLowerCase();
  const appName = String(tool.appName || '').toLowerCase();
  return appId === 'data-analytics' || appId.includes('data-analytics') || appName.includes('data analytics');
}

function isDataAnalyticsToolEntry(entry: ToolMapEntry) {
  const appId = entry.appId.toLowerCase();
  const displayName = entry.displayName.toLowerCase();
  return appId === 'data-analytics' || appId.includes('data-analytics') || displayName.includes('data analytics');
}

function isDataAnalyticsRendererToolName(toolName: string) {
  return /^(validate_artifact|render_artifact|render_chart|render_table)$/i.test(toolName);
}

function buildMcpToolDescription(tool: Record<string, unknown>, ccsGuidance = '') {
  const description = [String(tool.description || `${String(tool.name || 'tool')} from ${String(tool.appId || 'app')}`)];
  if (ccsGuidance) description.push(`Elastic CCS default: ${ccsGuidance}`);
  if (isTrinoMcpTool(tool)) {
    description.push(
      'Use this as a Trino / Starburst source and quick visualization tool. For polished Data Analytics artifacts, first get bounded rows and runnable SQL/provenance from this tool, then pass only reviewed compact results to a renderer app.'
    );
  }
  if (isDataAnalyticsMcpTool(tool)) {
    description.push(
      'Use Data Analytics as a renderer/workflow layer, not as the source of truth. Only call render_chart, render_table, validate_artifact, or render_artifact after source-backed rows, metric definitions, and provenance have been obtained from selected source or knowledge tools. If rendering fails, fall back to the source app native visual or answer from reviewed rows.'
    );
  }
  if (isTrinoDashboardVizTool(tool)) {
    description.push(
      'For multi-panel dashboard requests, prefer one visualize_query call with panels instead of separate chart calls. Each panel can carry its own SQL, chart type, field mappings, sizing, and row limit.'
    );
  }
  return description.filter(Boolean).join('\n');
}

function buildToolFailureGuidance(entry: ToolMapEntry) {
  if (isDataAnalyticsToolEntry(entry) && isDataAnalyticsRendererToolName(entry.toolName)) {
    return [
      'The Data Analytics renderer failed. Do not repeat the same renderer call with the same payload.',
      'If the underlying data came from Trino / Starburst and a Trino visualization tool is selected, fall back to that source app for a simpler native chart/table using the same SQL/result intent.',
      'If no native source renderer is available, answer from the reviewed source rows and include the runnable SQL/provenance, bounds, and caveats.',
      'Do not fabricate replacement rows or metric values.'
    ].join(' ');
  }
  return 'This MCP tool failed. Do not repeat the same broad call. If useful, try one narrower read-only tool call with explicit bounds such as one visualization, top-N, a concrete index/data view, or a time range; otherwise explain the limitation from available context.';
}

function isTrinoDashboardVizTool(tool: Record<string, unknown>) {
  return (
    String(tool.appId || '').toLowerCase() === 'mcp-app-trino' &&
    String(tool.name || '').toLowerCase() === 'visualize_query' &&
    jsonSchemaHasProperty(tool.inputSchema, 'panels')
  );
}

function jsonSchemaHasProperty(schema: unknown, propertyName: string): boolean {
  if (!isRecord(schema)) return false;
  const properties = schema.properties;
  if (isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, propertyName)) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(branch => jsonSchemaHasProperty(branch, propertyName))) return true;
  }
  return false;
}

function isElasticToolMapEntry(entry: ToolMapEntry) {
  const appId = entry.appId.toLowerCase();
  const displayName = entry.displayName.toLowerCase();
  return appId.includes('elastic') || displayName.includes('elastic') || ['dashbuilder', 'security', 'observability'].includes(appId);
}

export function shouldExposeMcpToolToModel(tool: Record<string, unknown>) {
  const toolName = String(tool.name || '').trim().toLowerCase();
  if (!toolName || ['app_only', 'app-only', 'app.only'].includes(toolName)) return false;

  const meta = (tool._meta || {}) as Record<string, unknown>;
  const uiMeta = isRecord(meta.ui) ? meta.ui : {};
  const visibility = [
    ...(Array.isArray(meta.visibility) ? meta.visibility : typeof meta.visibility === 'string' ? [meta.visibility] : []),
    ...(Array.isArray(uiMeta.visibility) ? uiMeta.visibility : typeof uiMeta.visibility === 'string' ? [uiMeta.visibility] : [])
  ];
  return !visibility.map(item => String(item).toLowerCase()).includes('app');
}

async function createChatCompletion(settings: SettingsAccess, messages: OpenAiMessage[], tools: unknown[]) {
  const endpoint = resolveChatCompletionsEndpoint(settings.get('OPENAI_BASE_URL'));
  const model = settings.get('OPENAI_MODEL');
  const extraHeaders = readJsonHeaderObjectSetting(settings, 'OPENAI_EXTRA_HEADERS');
  const extraBody = readJsonObjectSetting(settings, 'OPENAI_EXTRA_BODY');
  const temperature = readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE');
  const topP = readOptionalNumberSetting(settings, 'OPENAI_TOP_P');
  const maxTokens = readOptionalIntegerSetting(settings, 'OPENAI_MAX_TOKENS');
  const timeoutMs = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS');
  const response = await fetchWithMasterTls(settings, endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: buildAuthorizationHeader(settings),
      ...extraHeaders
    },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    body: JSON.stringify({
      ...extraBody,
      model,
      messages,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

function createTokenUsageAccumulator(defaultModel: string) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  let hasTotalTokens = false;
  let model = defaultModel || undefined;

  return {
    add(rawUsage: unknown, responseModel?: string) {
      if (responseModel) model = responseModel;
      const usage = readTokenUsage(rawUsage);
      if (!usage) return;
      if (usage.promptTokens !== undefined) {
        promptTokens += usage.promptTokens;
        hasPromptTokens = true;
      }
      if (usage.completionTokens !== undefined) {
        completionTokens += usage.completionTokens;
        hasCompletionTokens = true;
      }
      if (usage.totalTokens !== undefined) {
        totalTokens += usage.totalTokens;
        hasTotalTokens = true;
      } else if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
        totalTokens += (usage.promptTokens || 0) + (usage.completionTokens || 0);
        hasTotalTokens = true;
      }
    },
    snapshot(): TokenUsage | undefined {
      if (!hasPromptTokens && !hasCompletionTokens && !hasTotalTokens) return undefined;
      return {
        ...(hasPromptTokens ? { promptTokens } : {}),
        ...(hasCompletionTokens ? { completionTokens } : {}),
        ...(hasTotalTokens ? { totalTokens } : {}),
        ...(model ? { model } : {}),
        source: 'llm'
      };
    }
  };
}

async function generateResponseFollowUps(
  settings: SettingsAccess,
  content: string,
  toolCalls: RenderableToolCall[],
  request: string,
  onProgress: ChatProgress = () => undefined
) {
  const fallback = generateSuggestedFollowUps(content, toolCalls, request);
  if (!settings.get('OPENAI_API_KEY') || settings.get('OPENAI_FOLLOW_UPS_ENABLED').toLowerCase() !== 'true') return fallback;

  try {
    onProgress('Drafting follow-up questions');
    const completion = await createChatCompletion(
      settings,
      [
        {
          role: 'system',
          content: [
            'You generate short, high-signal follow-up prompts for an analytics chat UI.',
            'Use the actual user request, assistant response, and tool results. Do not use generic canned questions.',
            'Return only JSON: {"followUps":["..."]}.',
            'Rules: 3 or 4 items, each under 90 characters, concrete, actionable, no markdown, no numbering.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            request: truncate(request, 1000),
            response: truncate(content, 2600),
            visualizations: toolCalls.map(toolCall => ({
              appId: toolCall.appId,
              toolName: toolCall.toolName,
              title: toolCall.title,
              input: summarizeFollowUpToolInput(toolCall.toolInput),
              resultText: collectMcpResultText(toolCall.toolResult).join('\n').slice(0, 1200)
            }))
          })
        }
      ],
      []
    );
    const generated = parseModelFollowUps(completion.choices?.[0]?.message?.content || '', request);
    return generated.length ? generated : fallback;
  } catch {
    return fallback;
  }
}

function parseModelFollowUps(content: string, request = '') {
  const parsed = parseJsonObjectFromText(content);
  const raw = Array.isArray(parsed?.followUps) ? parsed.followUps : Array.isArray(parsed?.follow_ups) ? parsed.follow_ups : Array.isArray(parsed?.questions) ? parsed.questions : [];
  return dedupeFollowUps(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim())
      .filter(item => item.length >= 8 && item.length <= 120)
  )
    .filter(question => !questionOverlapsRequest(question, request))
    .slice(0, 4);
}

function parseJsonObjectFromText(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)].filter(candidate => candidate.startsWith('{'));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function summarizeFollowUpToolInput(input: Record<string, unknown>) {
  const panels = Array.isArray(input.panels) ? input.panels.filter(isRecord) : [];
  if (panels.length) {
    return {
      panels: panels.slice(0, 6).map((panel, index) => ({
        title: typeof panel.title === 'string' ? panel.title : `Panel ${index + 1}`,
        chartType: typeof panel.chartType === 'string' ? panel.chartType : typeof panel.type === 'string' ? panel.type : undefined,
        sql: typeof panel.sql === 'string' ? truncate(panel.sql.replace(/\s+/g, ' ').trim(), 260) : undefined
      }))
    };
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .slice(0, 12)
      .map(([key, value]) => [key, typeof value === 'string' ? truncate(value.replace(/\s+/g, ' ').trim(), 260) : value])
  );
}

function readTokenUsage(rawUsage: unknown): Omit<TokenUsage, 'model' | 'source'> | undefined {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const promptTokens = readTokenNumber(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
  const completionTokens = readTokenNumber(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']);
  const totalTokens = readTokenNumber(usage, ['total_tokens', 'totalTokens']);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
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

export function buildAuthorizationHeader(settings: Pick<SettingsAccess, 'get'>) {
  const apiKey = settings.get('OPENAI_API_KEY');
  const scheme = settings.get('OPENAI_AUTH_SCHEME').trim();
  if (!scheme || scheme.toLowerCase() === 'none') return apiKey;
  if (apiKey.toLowerCase().startsWith(`${scheme.toLowerCase()} `)) return apiKey;
  return `${scheme} ${apiKey}`;
}

export function resolveChatCompletionsEndpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function readOptionalIntegerArg(value: unknown) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
}

function findLiteralAutoSqlPlaceholder(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (typeof value === 'string') {
    return readLiteralAutoSqlPlaceholder(value);
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLiteralAutoSqlPlaceholder(item, seen);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^(table|tablename|table_name|view|viewname|view_name)$/i.test(key)) {
      const normalized = item.trim().replace(/^"|"$/g, '').toLowerCase();
      if (normalized === 'auto' || normalized === '*' || normalized.endsWith('.auto') || normalized.endsWith('."auto"') || normalized.endsWith('.*')) return item;
    }
    const found = findLiteralAutoSqlPlaceholder(item, seen);
    if (found) return found;
  }
  return undefined;
}

function readLiteralAutoSqlPlaceholder(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const pathMatch = normalized.match(/((?:"[^"]+"|[A-Za-z_][\w$-]*|\*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$-]*|\*)){1,2})/i);
  if (pathMatch) {
    const path = pathMatch[1].replace(/\s+/g, '');
    const parts = path.split('.').map(part => part.replace(/^"|"$/g, '').toLowerCase());
    const last = parts.at(-1);
    if (last === 'auto' || last === '*') return path;
  }
  if (!/\b(from|join)\b/i.test(normalized)) return undefined;
  const match = normalized.match(/\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][\w$-]*|\*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$-]*|\*)){0,2})/i);
  if (!match) return undefined;
  const path = match[1].replace(/\s+/g, '');
  const parts = path.split('.').map(part => part.replace(/^"|"$/g, '').toLowerCase());
  const last = parts.at(-1);
  return last === 'auto' || last === '*' ? path : undefined;
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

export function summarizeMcpToolResultForDeepAgent(
  result: unknown,
  options: { appId: string; toolName: string; displayName?: string; resourceUri?: string; hasEmbeddedHtml?: boolean }
) {
  const text = collectMcpResultText(result).join('\n').replace(/\s+\n/g, '\n').trim();
  const interactivePreview = Boolean(options.resourceUri || options.hasEmbeddedHtml);
  return truncate(
    JSON.stringify({
      ok: true,
      tool: `${options.appId}:${options.toolName}`,
      displayName: options.displayName,
      interactivePreview,
      ...(options.resourceUri ? { resourceUri: options.resourceUri } : {}),
      ...(interactivePreview
        ? {
            previewGuidance:
              'Rubberband captured the interactive MCP Apps UI preview separately. Mention that it is available below; do not recreate the UI from raw HTML.'
          }
        : {}),
      ...(text ? { text: truncate(text, 2600) } : {}),
      resultShape: summarizeResultShape(result)
    }),
    MAX_DEEP_AGENT_RESULT_CHARS
  );
}

export function serializeMcpToolResultForModel(
  result: unknown,
  options: { appId: string; toolName: string; displayName?: string; resourceUri?: string; hasEmbeddedHtml?: boolean }
) {
  const raw = JSON.stringify(result) ?? 'null';
  const hasInteractivePreview = Boolean(options.resourceUri || options.hasEmbeddedHtml);
  if (!hasInteractivePreview && raw.length <= MAX_TOOL_RESULT_CHARS && !/text\/html;profile=mcp-app|<!doctype html|<html|<script|<body|<main/i.test(raw)) {
    return raw;
  }
  return summarizeMcpToolResultForDeepAgent(result, options);
}

function collectMcpResultText(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') {
    if (looksLikeBulkyMarkup(value) || value.startsWith('data:')) return [];
    return [truncate(value, 900)];
  }
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) return value.flatMap(item => collectMcpResultText(item, seen)).slice(0, 12);

  const record = value as Record<string, unknown>;
  if (isMcpAppHtmlMime(record.mimeType)) return [];
  const directText = typeof record.text === 'string' && !looksLikeBulkyMarkup(record.text) ? [truncate(record.text, 900)] : [];
  const nestedText = Object.entries(record)
    .filter(([key]) => !['html', 'blob', 'data', 'dataUrl', 'resource', 'text'].includes(key))
    .flatMap(([, item]) => collectMcpResultText(item, seen));
  return [...directText, ...nestedText].filter(Boolean).slice(0, 12);
}

function summarizeResultShape(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return typeof value;
  if (depth >= 2) return Array.isArray(value) ? `array(${value.length})` : 'object';
  if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.slice(0, 3).map(item => summarizeResultShape(item, depth + 1)) };
  const record = value as Record<string, unknown>;
  return {
    type: 'object',
    keys: Object.keys(record).slice(0, 16),
    fields: Object.fromEntries(Object.entries(record).slice(0, 8).map(([key, item]) => [key, summarizeResultShape(item, depth + 1)]))
  };
}

function looksLikeBulkyMarkup(value: string) {
  const normalized = value.slice(0, 500).toLowerCase();
  return /<!doctype html|<html|<script|<style|<svg|<body|<main/.test(normalized) || value.length > 2000;
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

function renderableToolCallKey(toolCall: Pick<RenderableToolCall, 'appId' | 'toolName' | 'resourceUri'>) {
  return `${toolCall.appId}:${toolCall.toolName}:${toolCall.resourceUri || 'embedded-ui'}`;
}

function parseDeepAnalysisTarget(content: string): AnalysisTarget | undefined {
  const normalized = content.toLowerCase();
  if (!isDeepAnalysisRequest(normalized)) return undefined;
  return inferAnalysisTarget(content);
}

function inferAnalysisTarget(content: string, appIds: string[] = []): AnalysisTarget {
  const normalized = content.toLowerCase();
  const explicit = normalized.match(/rubberband analysis target:\s*(elastic|trino|starburst|all|federated|both)/);
  if (explicit) {
    if (explicit[1] === 'starburst') return 'trino';
    if (explicit[1] === 'federated' || explicit[1] === 'both') return 'all';
    return explicit[1] as AnalysisTarget;
  }
  if (/\b(all|both|federated|cross-source|cross source)\b/.test(normalized)) return 'all';
  if (/\b(trino|starburst|sql warehouse|warehouse|catalog|schema|table)\b/.test(normalized)) return 'trino';
  if (
    (normalized.includes('elastic') && normalized.includes('suggest') && normalized.includes('question')) ||
    (normalized.includes('cluster') && normalized.includes('analytics') && normalized.includes('suggest')) ||
    /\b(analy[sz]e .*elastic|profile .*elastic|index recommender|index catalog|elastic|elasticsearch|kibana|indices|data stream|field caps|ecs|security|observability|apm|alert|case|rule|anomal(y|ies))\b/.test(normalized)
  ) {
    return 'elastic';
  }
  const selected = new Set(appIds.map(appId => appId.toLowerCase()));
  const hasElasticApp = ['dashbuilder', 'security', 'observability'].some(appId => selected.has(appId));
  const hasTrinoApp = selected.has('mcp-app-trino');
  if (hasElasticApp && !hasTrinoApp) return 'elastic';
  if (hasTrinoApp && !hasElasticApp) return 'trino';
  return 'all';
}

export function isTrinoCatalogMapRequest(content: string) {
  const normalized = content.toLowerCase();
  return (
    /\b(trino|starburst)\b/.test(normalized) &&
    /\bcatalogs?\b/.test(normalized) &&
    /\b(visuali[sz]e|visualization|viz|map|graph|relationship|relationships|relate|related|lineage|connect|connected)\b/.test(normalized)
  );
}

function isFocusedTrinoMetadataRequest(content: string) {
  const normalized = content.toLowerCase();
  if (!/\b(tables?|views?|schemas?|catalogs?)\b/.test(normalized)) return false;
  return !/\b(visuali[sz]e|visualization|viz|chart|dashboard|graph|plot)\b/.test(normalized);
}

function isDeepAnalysisRequest(normalized: string) {
  return /\b(deep analysis|profile|analy[sz]e|index recommender|index catalog|table catalog|canned analytics|suggest(ed)? questions)\b/.test(normalized);
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

function parseElasticProfileOptions(content: string) {
  const maxIndices = readBound(content, /max(?:imum)?\s+(\d+)\s+indices/i);
  const maxFieldCaps = readBound(content, /(?:inspect|field(?:s)?|field caps)\s+(\d+)/i);
  return {
    maxIndices,
    maxFieldCaps,
    includeSystem: /\binclude system\b|\bsystem indices\b/i.test(content)
  };
}

function parseTrinoProfileOptions(content: string) {
  return {
    maxCatalogs: readBound(content, /max(?:imum)?\s+(\d+)\s+catalogs/i),
    maxTablesPerCatalog: readBound(content, /max(?:imum)?\s+(\d+)\s+tables/i),
    maxColumnsPerCatalog: readBound(content, /max(?:imum)?\s+(\d+)\s+columns/i)
  };
}

function readSettingBound(settings: SettingsAccess, key: string) {
  const value = Number(settings.get(key));
  return Number.isFinite(value) ? value : undefined;
}

export function buildTrinoCatalogMap(profile: TrinoProfile): TrinoCatalogMap {
  const byCatalog = new Map<string, TrinoProfile['analyzedTables']>();
  for (const catalog of profile.catalogs) byCatalog.set(catalog, []);
  for (const table of profile.analyzedTables) {
    byCatalog.set(table.catalog, [...(byCatalog.get(table.catalog) || []), table]);
  }

  const catalogs = [...byCatalog.entries()].map(([catalog, tables]) => {
    const schemas = new Set(tables.map(table => table.schema));
    const domains = mostCommon(tables.flatMap(table => table.domains).filter(domain => domain !== 'unknown'), 5);
    return {
      id: catalog,
      tableCount: tables.length,
      schemaCount: schemas.size,
      domains,
      sampleTables: tables.slice(0, 5).map(table => `${table.schema}.${table.name}`)
    };
  });

  const links: TrinoCatalogMap['links'] = [];
  for (let i = 0; i < catalogs.length; i += 1) {
    for (let j = i + 1; j < catalogs.length; j += 1) {
      const left = byCatalog.get(catalogs[i].id) || [];
      const right = byCatalog.get(catalogs[j].id) || [];
      const relationship = inferCatalogRelationship(left, right);
      if (relationship.strength > 0) {
        links.push({
          source: catalogs[i].id,
          target: catalogs[j].id,
          ...relationship
        });
      }
    }
  }

  return {
    catalogs,
    links: links.sort((a, b) => b.strength - a.strength || a.source.localeCompare(b.source)).slice(0, 40),
    skipped: profile.skipped
  };
}

function inferCatalogRelationship(left: TrinoProfile['analyzedTables'], right: TrinoProfile['analyzedTables']) {
  const leftDomains = new Set(left.flatMap(table => table.domains).filter(domain => domain !== 'unknown'));
  const rightDomains = new Set(right.flatMap(table => table.domains).filter(domain => domain !== 'unknown'));
  const sharedDomains = intersect(leftDomains, rightDomains).slice(0, 4);

  const leftSchemas = new Set(left.map(table => table.schema.toLowerCase()));
  const rightSchemas = new Set(right.map(table => table.schema.toLowerCase()));
  const sharedSchemas = intersect(leftSchemas, rightSchemas).slice(0, 4);

  const leftColumns = relevantColumnNames(left);
  const rightColumns = relevantColumnNames(right);
  const sharedColumns = intersect(leftColumns, rightColumns).slice(0, 6);

  const reasons = [
    ...sharedDomains.map(value => `domain ${value}`),
    ...sharedSchemas.map(value => `schema ${value}`),
    ...sharedColumns.map(value => `column ${value}`)
  ];

  return {
    strength: sharedDomains.length * 3 + sharedSchemas.length * 2 + sharedColumns.length,
    reasons: reasons.slice(0, 8)
  };
}

function relevantColumnNames(tables: TrinoProfile['analyzedTables']) {
  const ignored = new Set(['id', 'name', 'type', 'status', 'description', 'created_at', 'updated_at']);
  return new Set(
    tables
      .flatMap(table => table.columns.map(column => column.name.toLowerCase()))
      .filter(column => column.length > 2 && !ignored.has(column) && !/^[_\d]+$/.test(column))
  );
}

function intersect(left: Set<string>, right: Set<string>) {
  return [...left].filter(value => right.has(value)).sort();
}

function mostCommon(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function renderTrinoCatalogMapSummary(profile: TrinoProfile, map: TrinoCatalogMap) {
  const lines = [
    `Built a bounded Trino catalog relationship map for ${map.catalogs.length} catalog${map.catalogs.length === 1 ? '' : 's'} on ${profile.connectionLabel}.`,
    `It uses metadata only: ${profile.analyzedTables.length} profiled table${profile.analyzedTables.length === 1 ? '' : 's'}, max ${profile.boundedBy.maxTablesPerCatalog} tables per catalog, max ${profile.boundedBy.maxColumnTablesPerCatalog ?? profile.boundedBy.maxTablesPerCatalog} column-inspected tables per catalog.`,
    profile.cache?.hit ? 'This was served from the short-lived profiler cache.' : 'This was a fresh bounded metadata sample.',
    map.links.length
      ? `Inferred ${map.links.length} cross-catalog relationship candidate${map.links.length === 1 ? '' : 's'} from shared domains, schemas, and column names.`
      : 'No cross-catalog relationships were inferred from the bounded metadata sample.',
    ''
  ];

  if (map.links.length) {
    lines.push(
      'Top inferred relationships:',
      ...map.links.slice(0, 6).map(link => `- ${link.source} -> ${link.target}: ${link.reasons.join(', ')}`)
    );
  }
  if (profile.skipped.catalogs || profile.skipped.uninspectedTables) {
    lines.push('', `Bounds caveat: skipped ${profile.skipped.catalogs} catalog(s), ${profile.skipped.uninspectedTables} table(s), and ${profile.skipped.uninspectedColumnTables || 0} column table scan(s). For production scale, set included catalogs in Settings before raising global limits.`);
  }
  return lines.join('\n');
}

function renderFederatedProfileNote() {
  return [
    '# Federated Analytics Note',
    '',
    'Rubberband can support federated analysis when both Elastic and Trino / Starburst apps are selected, but the safe workflow is staged:',
    '1. Profile each source with bounded read-only metadata.',
    '2. Identify candidate relationships from index/table/field/column names and Domain Knowledge.',
    '3. Use the selected MCP apps to run source-specific queries or visualizations.',
    '4. Treat cross-source joins as candidate designs until a Trino connector, materialized view, or explicit app tool can query both sides.'
  ].join('\n');
}

export function generateSuggestedFollowUps(content: string, toolCalls: RenderableToolCall[] = [], request = '') {
  const candidates: string[] = [];
  const combined = `${request}\n${content}\n${toolCalls.map(toolCall => `${toolCall.appId} ${toolCall.toolName} ${toolCall.title}`).join('\n')}`.toLowerCase();

  if (toolCalls.some(toolCall => toolCall.toolName === 'trino_catalog_map') || /catalog relationship|catalog map/.test(combined)) {
    candidates.push(
      'Which catalog relationships are strongest?',
      'Show the most useful tables in each catalog.',
      'Which catalogs should I inspect next?'
    );
  }

  if (/\btrino|starburst|sql|catalog|schema|table\b/.test(combined)) {
    candidates.push(
      'Create a SQL visualization from the best candidate table.',
      'Find time-series tables I can chart.',
      'Suggest joins that are safe to validate in Trino.'
    );
  }

  if (/\belastic|kibana|index|esql|alert|observability|security\b/.test(combined)) {
    candidates.push(
      'Create an Elastic visualization for this.',
      'Which indices should I inspect first?',
      'Find anomalies or outliers worth investigating.'
    );
  }

  if (/\bfederated|cross-source|cross source|both sources|elastic and trino\b/.test(combined)) {
    candidates.push(
      'Compare this against the other selected source.',
      'What would a safe federated query plan look like?',
      'Which fields look usable for cross-source matching?'
    );
  }

  if (toolCalls.length) {
    candidates.push(
      'Summarize the visualization in plain English.',
      'Regenerate this as a different chart.',
      'Show the underlying data or query.'
    );
  }

  candidates.push('What should I ask next?', 'Make this more actionable.');

  return dedupeFollowUps(candidates)
    .filter(question => !questionOverlapsRequest(question, request))
    .slice(0, 4);
}

function dedupeFollowUps(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeFollowUpPrompt(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeFollowUpPrompt(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  if (!normalized) return '';
  return isQuestionPrompt(normalized) ? `${normalized}?` : normalized;
}

function isQuestionPrompt(value: string) {
  return /^(what|which|how|why|where|when|who|can|could|should|would|is|are|do|does|did)\b/i.test(value);
}

function questionOverlapsRequest(question: string, request: string) {
  if (!request.trim()) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedQuestion = normalize(question);
  const normalizedRequest = normalize(request);
  return normalizedRequest.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedRequest);
}

function readBound(content: string, pattern: RegExp) {
  const match = content.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function compactChatMessages(messages: ChatMessage[]) {
  const selected = messages.slice(-MAX_CONTEXT_MESSAGES).map(message => ({
    role: message.role,
    content: truncate(message.content, MAX_CONTEXT_MESSAGE_CHARS),
    attachments: message.attachments
  }));
  const omitted = messages.length - selected.length;
  if (omitted <= 0) return selected;
  return [
    {
      role: 'system' as const,
      content: `${omitted} older chat message${omitted === 1 ? ' was' : 's were'} omitted by Rubberband context management. Use the visible recent conversation and current request as authoritative.`
    },
    ...selected
  ];
}

function openAiContentForMessage(message: ChatMessage): string | OpenAiContentPart[] {
  const attachments = (message.attachments || []).filter(attachment => attachment.mimeType.startsWith('image/') && attachment.dataUrl.startsWith('data:image/')).slice(0, 4);
  if (!attachments.length || message.role !== 'user') return message.content;

  const text = message.content.trim() || 'Please analyze the attached image.';
  return [
    { type: 'text', text },
    ...attachments.map(attachment => ({
      type: 'image_url' as const,
      image_url: {
        url: attachment.dataUrl,
        detail: 'auto' as const
      }
    }))
  ];
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function summarizeProgressPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), 220);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(0, 3).map(item => summarizeProgressPayload(item, depth + 1))
    };
  }
  if (!isRecord(value)) return truncate(String(value), 160);
  if (depth >= 2) return truncate(JSON.stringify(value), 240);

  const entries = Object.entries(value)
    .filter(([key]) => !isSensitiveProgressKey(key))
    .slice(0, 8)
    .map(([key, item]) => [key, summarizeProgressPayload(item, depth + 1)]);
  return Object.fromEntries(entries);
}

function isSensitiveProgressKey(key: string) {
  return /token|secret|password|authorization|api[_-]?key|credential/i.test(key);
}
