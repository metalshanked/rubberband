import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  buildAuthorizationHeader,
  buildSystemPrompt,
  buildTrinoCatalogMap,
  buildVizContract,
  generateSuggestedFollowUps,
  isTrinoCatalogMapRequest,
  resolveChatCompletionsEndpoint,
  runChat,
  shouldExposeMcpToolToModel,
  summarizeMcpToolResultForDeepAgent
} from '../../src/server/openai-chat.js';
import { applyElasticCcsDefaultArgs, buildElasticClustersJson, fieldCapsToFieldList, getCcsFieldsWithFieldCaps, McpRegistry, withKibanaSpace } from '../../src/server/mcp-registry.js';
import { SettingsStore } from '../../src/server/settings.js';
import { buildElasticProfile } from '../../src/server/elastic-profiler.js';
import { buildElasticCcsPromptGuidance, normalizeElasticCcsTargets } from '../../src/server/elastic-ccs.js';
import { buildTrinoProfile } from '../../src/server/trino-profiler.js';
import { explainError, sanitizeErrorMessage } from '../../src/server/error-explainer.js';
import { AnalyticsProfileService } from '../../src/server/analytics-profile-service.js';
import { testExternalConnection } from '../../src/server/connection-tests.js';
import { buildDemoPlan } from '../../src/server/demo.js';
import {
  assertMcpToolCallAllowed,
  buildMcpReadOnlyPromptGuidance,
  describeMcpAppExposure,
  describeMcpToolExposure,
  isLikelyMutatingTool
} from '../../src/server/mcp-tool-policy.js';

const port = randomInt(18081, 18999);
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcess;

before(async () => {
  server = spawn('node', ['dist/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MCP_APPS_MANIFEST: 'tests/fixtures/empty-manifest.json',
      MCP_ENABLED_APPS: '',
      MCP_DISABLED_APPS: '',
      MCP_ENABLED_TOOLS: '',
      MCP_DISABLED_TOOLS: '',
      MCP_READ_ONLY_MODE: 'true',
      MCP_READ_ONLY_TOOL_ALLOWLIST: '',
      OPENAI_API_KEY: 'test-key-from-env',
      OPENAI_BASE_URL: 'http://127.0.0.1:65535/v1/chat/completions',
      OPENAI_MODEL: 'minimax',
      ALLOW_INSECURE_TLS: 'true'
    },
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });

  await waitForHealth(`${baseUrl}/api/health`);
});

after(() => {
  server?.kill();
});

test('health endpoint responds', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('about endpoint reports app version and build metadata', async () => {
  const response = await fetch(`${baseUrl}/api/about`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    name: string;
    packageName: string;
    version: string;
    license: string;
    build: { builtAt: string; node: string; shortCommit?: string };
  };

  assert.equal(body.name, 'Rubberband');
  assert.equal(body.packageName, 'rubberband-mcp-chat');
  assert.equal(body.version, '0.1.0');
  assert.equal(body.license, 'MIT');
  assert.match(body.build.node, /^v\d+\./);
  assert.ok(body.build.builtAt);
});

test('BASE_PATH serves app and API under the configured path', async () => {
  const nestedPort = randomInt(19000, 19999);
  const nestedBaseUrl = `http://127.0.0.1:${nestedPort}`;
  const nestedBasePath = '/rubberband-test';
  const nestedServer = spawn('node', ['dist/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(nestedPort),
      BASE_PATH: nestedBasePath,
      MCP_APPS_MANIFEST: 'tests/fixtures/empty-manifest.json',
      MCP_ENABLED_APPS: '',
      MCP_DISABLED_APPS: '',
      MCP_ENABLED_TOOLS: '',
      MCP_DISABLED_TOOLS: '',
      MCP_READ_ONLY_MODE: 'true',
      MCP_READ_ONLY_TOOL_ALLOWLIST: '',
      OPENAI_API_KEY: 'test-key-from-env',
      OPENAI_BASE_URL: 'http://127.0.0.1:65535/v1/chat/completions',
      OPENAI_MODEL: 'minimax',
      ALLOW_INSECURE_TLS: 'true'
    },
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });

  try {
    await waitForHealth(`${nestedBaseUrl}${nestedBasePath}/api/health`, nestedServer);

    const health = await fetch(`${nestedBaseUrl}${nestedBasePath}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const rootApi = await fetch(`${nestedBaseUrl}/api/health`);
    assert.equal(rootApi.status, 404);

    const appResponse = await fetch(`${nestedBaseUrl}${nestedBasePath}/`);
    assert.equal(appResponse.status, 200);
    assert.match(await appResponse.text(), /Rubberband/);

    const sandboxResponse = await fetch(`${nestedBaseUrl}${nestedBasePath}/sandbox_proxy.html`);
    assert.equal(sandboxResponse.status, 200);
    assert.match(await sandboxResponse.text(), /MCP App Sandbox/);
  } finally {
    nestedServer.kill();
  }
});

test('settings endpoint reports env-backed LLM fields as locked', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; locked: boolean; value: string }> };

  const apiKey = body.fields.find(field => field.key === 'OPENAI_API_KEY');
  const base = body.fields.find(field => field.key === 'OPENAI_BASE_URL');
  const model = body.fields.find(field => field.key === 'OPENAI_MODEL');

  assert.equal(apiKey?.locked, true);
  assert.equal(apiKey?.value, '');
  assert.equal(base?.locked, true);
  assert.equal(model?.locked, true);
});

test('settings endpoint exposes optional LLM tuning fields', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; type: string; group: string; sensitive?: boolean }> };

  const fields = new Map(body.fields.map(field => [field.key, field]));
  assert.equal(fields.get('OPENAI_TEMPERATURE')?.group, 'llm');
  assert.equal(fields.get('OPENAI_TOP_P')?.type, 'text');
  assert.equal(fields.get('OPENAI_MAX_TOKENS')?.type, 'text');
  assert.equal(fields.get('OPENAI_TIMEOUT_MS')?.type, 'text');
  assert.equal(fields.get('OPENAI_EXTRA_HEADERS')?.type, 'textarea');
  assert.equal(fields.get('OPENAI_EXTRA_HEADERS')?.sensitive, true);
  assert.equal(fields.get('OPENAI_EXTRA_BODY')?.type, 'textarea');
});

test('settings endpoint exposes Elastic CCS controls', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; type: string; group: string }> };
  const fields = new Map(body.fields.map(field => [field.key, field]));

  assert.equal(fields.get('ELASTIC_CCS_SEARCH_BY_DEFAULT')?.type, 'checkbox');
  assert.equal(fields.get('ELASTIC_CCS_SEARCH_BY_DEFAULT')?.group, 'elastic');
  assert.equal(fields.get('ELASTIC_CCS_INDEX_PATTERNS')?.type, 'textarea');
  assert.equal(fields.get('ELASTIC_CCS_RESOLVE_TIMEOUT_MS')?.type, 'text');
});

test('settings endpoint exposes read-only MCP safety controls', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; type: string; group: string; value: string }> };
  const fields = new Map(body.fields.map(field => [field.key, field]));

  assert.equal(fields.get('MCP_READ_ONLY_MODE')?.type, 'checkbox');
  assert.equal(fields.get('MCP_READ_ONLY_MODE')?.group, 'mcp');
  assert.equal(fields.get('MCP_READ_ONLY_MODE')?.value, 'true');
  assert.equal(fields.get('MCP_READ_ONLY_TOOL_ALLOWLIST')?.type, 'textarea');
  assert.equal(fields.get('MCP_ENABLED_APPS')?.type, 'textarea');
  assert.equal(fields.get('MCP_DISABLED_APPS')?.type, 'textarea');
  assert.equal(fields.get('MCP_ENABLED_TOOLS')?.type, 'textarea');
  assert.equal(fields.get('MCP_DISABLED_TOOLS')?.type, 'textarea');
  assert.equal(fields.get('ELASTICSEARCH_AUTO_CREATE_API_KEY')?.type, 'checkbox');
});

test('demo endpoint reports live demo readiness', async () => {
  const response = await fetch(`${baseUrl}/api/demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appIds: [] })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; status: string; prompts: unknown[]; checks: unknown[]; sanity: { ok: boolean; availableApps: number } };

  assert.equal(body.ok, false);
  assert.equal(body.status, 'needs_apps');
  assert.equal(body.sanity.ok, false);
  assert.equal(body.sanity.availableApps, 0);
  assert.equal(body.prompts.length, 0);
  assert.ok(body.checks.length > 0);
});

test('demo planner creates public live-data prompts for selected MCP apps', () => {
  const plan = buildDemoPlan(
    [
      { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
      { id: 'mcp-app-trino', name: 'Trino Visualization', status: 'connected' }
    ],
    [
      { appId: 'dashbuilder', appName: 'Elastic Dashbuilder', name: 'create_chart' },
      { appId: 'mcp-app-trino', appName: 'Trino Visualization', name: 'visualize_query' }
    ],
    ['dashbuilder', 'mcp-app-trino']
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.appIds, ['dashbuilder', 'mcp-app-trino']);
  assert.ok(plan.prompts.length >= 2);
  assert.ok(plan.prompts.every(prompt => prompt.deepAnalysis));
  assert.match(plan.prompts.map(prompt => prompt.prompt).join('\n'), /actual available data|actual queryable data/i);
  assert.doesNotMatch(JSON.stringify(plan), /canned|fake|placeholder|internal/i);
});

test('settings connection test endpoint returns a structured result', async () => {
  const response = await fetch(`${baseUrl}/api/settings/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'llm', values: { OPENAI_BASE_URL: 'http://example.invalid/v1' } })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { target: string; label: string; ok: boolean; message: string; durationMs: number };

  assert.equal(body.target, 'llm');
  assert.equal(body.label, 'LLM');
  assert.equal(body.ok, false);
  assert.equal(typeof body.message, 'string');
  assert.equal(typeof body.durationMs, 'number');
});

test('settings endpoint reports insecure TLS as an env-locked checkbox', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; locked: boolean; value: string; type: string }> };
  const insecureTls = body.fields.find(field => field.key === 'ALLOW_INSECURE_TLS');

  assert.equal(insecureTls?.type, 'checkbox');
  assert.equal(insecureTls?.locked, true);
  assert.equal(insecureTls?.value, 'true');
});

test('LLM connection test sends a bounded chat-completions probe', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: IncomingMessage['headers'] | undefined;
  const server = await startHttpFixture(async (req, res) => {
    requestHeaders = req.headers;
    requestBody = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: 'OK' } }] }));
  });

  try {
    const settings = mapSettings({
      OPENAI_BASE_URL: `${server.url}/v1`,
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_AUTH_SCHEME: 'Bearer',
      OPENAI_MODEL: 'fixture-model',
      OPENAI_EXTRA_HEADERS: '{"X-Fixture":"yes"}',
      OPENAI_EXTRA_BODY: '{"metadata":{"test":"connection"},"max_tokens":99}'
    });
    const result = await testExternalConnection(settings, 'llm');

    assert.equal(result.ok, true);
    assert.equal(result.label, 'LLM');
    assert.equal(requestHeaders?.authorization, 'Bearer fixture-key');
    assert.equal(requestHeaders?.['x-fixture'], 'yes');
    assert.equal(requestBody?.model, 'fixture-model');
    assert.deepEqual(requestBody?.metadata, { test: 'connection' });
    assert.equal(requestBody?.max_tokens, 8);
  } finally {
    await server.close();
  }
});

test('Elasticsearch connection test reads cluster metadata', async () => {
  const server = await startHttpFixture(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cluster_name: 'fixture-cluster', version: { number: '8.99.0' } }));
  });

  try {
    const result = await testExternalConnection(mapSettings({ ELASTICSEARCH_URL: server.url }), 'elastic');

    assert.equal(result.ok, true);
    assert.equal(result.label, 'Elasticsearch');
    assert.match(result.message, /8\.99\.0/);
    assert.equal(result.details?.cluster, 'fixture-cluster');
  } finally {
    await server.close();
  }
});

test('settings endpoint exposes domain knowledge as a runtime textarea', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; locked: boolean; type: string; group: string }> };
  const domainKnowledge = body.fields.find(field => field.key === 'DOMAIN_KNOWLEDGE');

  assert.equal(domainKnowledge?.type, 'textarea');
  assert.equal(domainKnowledge?.group, 'domain');
  assert.equal(domainKnowledge?.locked, false);
});

test('settings endpoint exposes visualization contract defaults', async () => {
  const response = await fetch(`${baseUrl}/api/settings`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { fields: Array<{ key: string; value: string; group: string; type: string }> };

  const theme = body.fields.find(field => field.key === 'RUBBERBAND_VIZ_THEME');
  const native = body.fields.find(field => field.key === 'RUBBERBAND_VIZ_NATIVE_FEATURES');

  assert.equal(theme?.group, 'viz');
  assert.equal(theme?.value, 'light');
  assert.equal(native?.type, 'checkbox');
  assert.equal(native?.value, 'true');
});

test('analytics profile endpoint exposes shared background status', async () => {
  const response = await fetch(`${baseUrl}/api/analytics-profile`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { enabled: boolean; elastic: { status: string }; trino: { status: string } };

  assert.equal(body.enabled, true);
  assert.match(body.elastic.status, /idle|running|ready|stale|error|skipped/);
  assert.match(body.trino.status, /idle|running|ready|stale|error|skipped/);
});

test('apps refresh endpoint reconnects and returns apps plus tools', async () => {
  const response = await fetch(`${baseUrl}/api/apps/refresh`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { apps: unknown[]; tools: unknown[] };

  assert.ok(Array.isArray(body.apps));
  assert.ok(Array.isArray(body.tools));
});

test('mcp exposure endpoint reports visible apps and tools', async () => {
  const response = await fetch(`${baseUrl}/api/mcp/exposure`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    readOnlyMode: boolean;
    apps: Array<{ id: string; exposedToolCount: number; hiddenToolCount: number }>;
    tools: unknown[];
    hiddenTools: unknown[];
    totals: { apps: number; exposedTools: number; hiddenTools: number };
  };

  assert.equal(body.readOnlyMode, true);
  assert.ok(Array.isArray(body.apps));
  assert.ok(Array.isArray(body.tools));
  assert.ok(Array.isArray(body.hiddenTools));
  assert.equal(body.totals.apps, body.apps.length);
  assert.equal(body.totals.exposedTools, body.tools.length);
  assert.equal(body.totals.hiddenTools, body.hiddenTools.length);
  assert.ok(body.apps.some(app => app.id === 'fixture-observability'));
});

test('sanitizes and explains timeout failures without leaking sensitive values', async () => {
  const raw =
    'MCP error -32001: Request timed out while calling https://trino.example.local:8443/v1/statement with authorization Bearer abcdefghijklmnopqrstuvwxyz1234567890 and password=supersecret';
  const sanitized = sanitizeErrorMessage(raw);

  assert.match(sanitized, /Request timed out/);
  assert.doesNotMatch(sanitized, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(sanitized, /supersecret/);
  assert.doesNotMatch(sanitized, /\/v1\/statement/);

  const settings = {
    get: () => '',
    isInsecureTlsEnabled: () => false
  };
  const explanation = await explainError(new Error(raw), settings as never, {
    method: 'POST',
    path: '/api/apps/mcp-app-trino/tools/call',
    appId: 'mcp-app-trino',
    toolName: 'visualize_query'
  });

  assert.equal(explanation.generatedBy, 'local');
  assert.match(explanation.headline, /too long/i);
  assert.match(explanation.suggestedFixes.join(' '), /narrower request/i);
  assert.doesNotMatch(explanation.technicalSummary, /supersecret/);
});

test('uses LLM error explanations with sanitized context only', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody = '';
  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body || '');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                headline: 'The Trino preview timed out.',
                whatHappened: 'Rubberband waited for the selected Trino tool, but it did not finish in time.',
                likelyCauses: ['The request is too broad.'],
                suggestedFixes: ['Limit the request to a catalog or schema.']
              })
            }
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://llm.example.test/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer',
          ERROR_EXPLANATION_TIMEOUT_MS: '2000'
        })[key] || '',
      isInsecureTlsEnabled: () => false
    };

    const explanation = await explainError(new Error('Request timed out with token=secret-value'), settings as never, {
      path: '/api/chat'
    });

    assert.equal(explanation.generatedBy, 'llm');
    assert.match(explanation.headline, /Trino preview/);
    assert.doesNotMatch(requestBody, /secret-value/);
    assert.match(requestBody, /\[redacted\]/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('api callers receive reusable isolated session ids', async () => {
  const first = await fetch(`${baseUrl}/api/apps`);
  const firstSession = first.headers.get('x-rubberband-session-id');
  assert.match(firstSession || '', /^[a-zA-Z0-9._:-]{16,160}$/);

  const same = await fetch(`${baseUrl}/api/apps`, {
    headers: { 'x-rubberband-session-id': firstSession || '' }
  });
  assert.equal(same.headers.get('x-rubberband-session-id'), firstSession);

  const second = await fetch(`${baseUrl}/api/apps`);
  assert.notEqual(second.headers.get('x-rubberband-session-id'), firstSession);
});

test('progress event stream reports chat phases', async () => {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const sessionId = sessionResponse.headers.get('x-rubberband-session-id') || ((await sessionResponse.json()) as { sessionId: string }).sessionId;
  const abort = new AbortController();
  const events = await fetch(`${baseUrl}/api/events?sessionId=${encodeURIComponent(sessionId)}`, { signal: abort.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get('content-type')?.includes('text/event-stream'), true);

  const reader = events.body?.getReader();
  assert.ok(reader);
  const progress = readUntil(reader, 'Checking LLM settings');

  await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rubberband-session-id': sessionId
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      appIds: []
    })
  }).catch(() => undefined);

  assert.match(await progress, /Checking LLM settings/);
  abort.abort();
  await reader.cancel().catch(() => undefined);
});

test('runtime settings are isolated by session store', () => {
  const previousKibanaUrl = process.env.KIBANA_URL;
  delete process.env.KIBANA_URL;
  try {
    const settings = new SettingsStore(path.join(process.cwd(), 'tests/fixtures/no-env-file.env'));
    const alice = settings.createSessionStore();
    const bob = settings.createSessionStore();

    alice.update({ KIBANA_URL: 'https://alice.example.local' });

    assert.equal(alice.get('KIBANA_URL'), 'https://alice.example.local');
    assert.equal(bob.get('KIBANA_URL'), '');
  } finally {
    if (previousKibanaUrl === undefined) {
      delete process.env.KIBANA_URL;
    } else {
      process.env.KIBANA_URL = previousKibanaUrl;
    }
  }
});

test('runtime checkbox settings can override true defaults with false', () => {
  const settings = new SettingsStore(path.join(process.cwd(), 'tests/fixtures/no-env-file.env'));
  const session = settings.createSessionStore();

  assert.equal(session.get('ANALYTICS_PROFILER_ENABLED'), 'true');
  const changedKeys = session.update({ ANALYTICS_PROFILER_ENABLED: false });
  const field = session.snapshot().fields.find(item => item.key === 'ANALYTICS_PROFILER_ENABLED');

  assert.deepEqual(changedKeys, ['ANALYTICS_PROFILER_ENABLED']);
  assert.equal(session.get('ANALYTICS_PROFILER_ENABLED'), 'false');
  assert.equal(field?.value, 'false');
  assert.equal(field?.source, 'runtime');
  assert.equal(session.get('ANALYTICS_PROFILER_SCHEDULE_MS'), '86400000');
  assert.equal(session.get('ANALYTICS_PROFILER_STALE_AFTER_MS'), '86400000');
  assert.equal(session.get('TRINO_PROFILER_CACHE_TTL_MS'), '86400000');
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string) {
  const decoder = new TextDecoder();
  let content = '';
  const timeoutAt = Date.now() + 5000;
  while (Date.now() < timeoutAt) {
    const { done, value } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
    if (content.includes(pattern)) return content;
  }
  throw new Error(`Timed out waiting for progress event: ${pattern}`);
}

test('normalizes LLM base URLs without appending /chat/completions twice', () => {
  assert.equal(resolveChatCompletionsEndpoint('http://litellm.ai/v1'), 'http://litellm.ai/v1/chat/completions');
  assert.equal(
    resolveChatCompletionsEndpoint('http://litellm.ai/v1/chat/completions'),
    'http://litellm.ai/v1/chat/completions'
  );
});

test('builds LiteLLM-compatible authorization header schemes', () => {
  const bearerSettings = { get: (key: string) => (key === 'OPENAI_AUTH_SCHEME' ? 'Bearer' : 'sk-test') };
  const rawSettings = { get: (key: string) => (key === 'OPENAI_AUTH_SCHEME' ? 'none' : 'sk-test') };

  assert.equal(buildAuthorizationHeader(bearerSettings as never), 'Bearer sk-test');
  assert.equal(buildAuthorizationHeader(rawSettings as never), 'sk-test');
});

test('loads installed app skills into selected app system guidance', async () => {
  const registry = await McpRegistry.fromManifest('tests/fixtures/empty-manifest.json');
  const prompt = buildSystemPrompt(registry, ['fixture-observability']);

  assert.match(prompt, /Fixture Observability/);
  assert.match(prompt, /apm-health-summary/);
  assert.match(prompt, /before drilling into dependencies/);
});

test('builds visualization contract prompt guidance', () => {
  const settings = {
    get: (key: string) =>
      ({
        RUBBERBAND_VIZ_THEME: 'dark',
        RUBBERBAND_VIZ_PALETTE: 'rubberband',
        RUBBERBAND_VIZ_DENSITY: 'compact',
        RUBBERBAND_VIZ_LEGEND: 'bottom',
        RUBBERBAND_VIZ_TOOLTIP: 'shared',
        RUBBERBAND_VIZ_TIMEZONE: 'UTC',
        RUBBERBAND_VIZ_NATIVE_FEATURES: 'true'
      })[key] || ''
  };
  const registry = { getSkillGuidance: () => [] };
  const prompt = buildSystemPrompt(registry as never, [], '', buildVizContract(settings));

  assert.match(prompt, /Rubberband visualization contract/);
  assert.match(prompt, /theme: dark/);
  assert.match(prompt, /preferNativeFeatures: true/);
  assert.match(prompt, /Do not suppress native/);
});

test('adds Elastic CCS defaults to Elastic MCP tool descriptions', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody: { tools?: Array<{ function?: { description?: string } }> } | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as typeof requestBody;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => [
        {
          appId: 'dashbuilder',
          appName: 'Elastic Dashbuilder',
          name: 'create_chart',
          description: 'Create an Elastic chart.',
          inputSchema: { type: 'object' }
        }
      ]
    };
    const settings = mapSettings({
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: 'http://127.0.0.1/v1',
      OPENAI_MODEL: 'test-model',
      OPENAI_AUTH_SCHEME: 'Bearer',
      ELASTIC_CCS_SEARCH_BY_DEFAULT: 'true',
      ELASTIC_CCS_INDEX_PATTERNS: 'remote-prod*,analytics-remote:logs-*'
    });

    await runChat(registry as never, settings as never, [{ role: 'user', content: 'make an elastic chart' }]);

    const description = requestBody?.tools?.[0]?.function?.description || '';
    assert.match(description, /Elastic CCS default/);
    assert.match(description, /remote-prod\*:\*/);
    assert.match(description, /analytics-remote:logs-\*/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('read-only MCP policy blocks mutating tools and arguments', () => {
  assert.equal(isLikelyMutatingTool('delete_case', { description: 'Delete a case from Kibana.' }), true);
  assert.equal(isLikelyMutatingTool('create_chart', { description: 'Render a preview chart.' }), false);

  assert.throws(
    () =>
      assertMcpToolCallAllowed({
        settings: mapSettings({ MCP_READ_ONLY_MODE: 'true' }),
        appId: 'security',
        toolName: 'delete_case',
        tool: { name: 'delete_case', description: 'Delete a case.' },
        args: { id: 'case-1' }
      }),
    /read-only mode blocked/
  );

  assert.throws(
    () =>
      assertMcpToolCallAllowed({
        settings: mapSettings({ MCP_READ_ONLY_MODE: 'true' }),
        appId: 'mcp-app-trino',
        toolName: 'visualize_query',
        tool: { name: 'visualize_query', description: 'Visualize a SQL query.' },
        args: { sql: 'delete from sales.orders where orderkey = 1' }
      }),
    /write, DDL, or administrative SQL/
  );

  assert.doesNotThrow(() =>
    assertMcpToolCallAllowed({
      settings: mapSettings({ MCP_READ_ONLY_MODE: 'true' }),
      appId: 'dashbuilder',
      toolName: 'create_chart',
      tool: { name: 'create_chart', description: 'Render a chart preview.' },
      args: { query: 'from logs-* | limit 10' }
    })
  );
});

test('MCP exposure policy supports app and tool allowlists', () => {
  const settings = mapSettings({
    MCP_READ_ONLY_MODE: 'false',
    MCP_ENABLED_APPS: 'dashbuilder,mcp-app-trino',
    MCP_ENABLED_TOOLS: 'dashbuilder:create_chart,mcp-app-trino:*',
    MCP_DISABLED_TOOLS: 'mcp-app-trino:drop_table'
  });

  assert.equal(describeMcpAppExposure({ settings, appId: 'dashbuilder', appName: 'Elastic Dashbuilder' }).exposed, true);
  assert.equal(describeMcpAppExposure({ settings, appId: 'security', appName: 'Elastic Security' }).exposed, false);
  assert.equal(describeMcpToolExposure({ settings, appId: 'dashbuilder', toolName: 'create_chart' }).exposed, true);
  assert.equal(describeMcpToolExposure({ settings, appId: 'dashbuilder', toolName: 'import_dashboard' }).exposed, false);
  assert.equal(describeMcpToolExposure({ settings, appId: 'mcp-app-trino', toolName: 'visualize_query' }).exposed, true);
  assert.equal(describeMcpToolExposure({ settings, appId: 'mcp-app-trino', toolName: 'drop_table' }).exposed, false);

  assert.equal(
    describeMcpAppExposure({
      settings: mapSettings({ MCP_ENABLED_APPS: 'dashbuilder', MCP_DISABLED_APPS: 'dash*' }),
      appId: 'dashbuilder'
    }).exposed,
    false
  );
});

test('model tool exposure hides MCP app-only tools', () => {
  assert.equal(shouldExposeMcpToolToModel({ name: 'app_only' }), false);
  assert.equal(shouldExposeMcpToolToModel({ name: 'render_app', _meta: { visibility: ['app'] } }), false);
  assert.equal(shouldExposeMcpToolToModel({ name: 'create_chart', _meta: { visibility: ['model'] } }), true);
});

test('deep agent tool result summaries omit bulky UI payloads but keep preview hints', () => {
  const html = '<!doctype html><html><body><script>window.secret = true</script><main>Preview</main></body></html>';
  const summary = summarizeMcpToolResultForDeepAgent(
    {
      content: [
        { type: 'text', text: 'Observability preview ready for service latency.' },
        {
          type: 'resource',
          resource: {
            uri: 'ui://observability/latency.html',
            mimeType: 'text/html;profile=mcp-app',
            text: html
          }
        }
      ]
    },
    {
      appId: 'observability',
      toolName: 'observ',
      displayName: 'Elastic Observability: observ',
      resourceUri: 'ui://observability/latency.html',
      hasEmbeddedHtml: true
    }
  );
  const parsed = JSON.parse(summary) as { interactivePreview: boolean; resourceUri: string; text: string };

  assert.equal(parsed.interactivePreview, true);
  assert.equal(parsed.resourceUri, 'ui://observability/latency.html');
  assert.match(parsed.text, /Observability preview ready/);
  assert.doesNotMatch(summary, /window\.secret|<script>|<!doctype html/i);
});

test('registry applies MCP exposure policy to app listings and explicit tool discovery', async () => {
  const registry = McpRegistry.fromApps(
    [
      {
        id: 'dashbuilder',
        name: 'Elastic Dashbuilder',
        transport: { type: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] },
        skills: [{ name: 'dashbuilder-skill', content: 'Use dashbuilder.' }]
      },
      {
        id: 'security',
        name: 'Elastic Security',
        transport: { type: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] },
        skills: [{ name: 'security-skill', content: 'Use security.' }]
      }
    ],
    mapSettings({ MCP_ENABLED_APPS: 'dashbuilder' }) as never
  );

  assert.deepEqual(registry.listApps().map(app => app.id), ['dashbuilder']);
  assert.deepEqual(registry.getSkillGuidance().map(skill => skill.appId), ['dashbuilder']);
  await assert.rejects(() => registry.listTools('security'), /MCP exposure policy blocked security/);
});

test('read-only MCP prompt guidance is included in system prompt', () => {
  const registry = { getSkillGuidance: () => [] };
  const prompt = buildSystemPrompt(registry as never, [], '', '', '', '', buildMcpReadOnlyPromptGuidance(mapSettings({ MCP_READ_ONLY_MODE: 'true' })));

  assert.match(prompt, /MCP tool safety/);
  assert.match(prompt, /read-only mode is enabled/i);
  assert.match(prompt, /Do not use MCP apps to import, save, create, update, delete/i);
});

test('normalizes Elastic CCS target settings for prompt guidance', () => {
  assert.deepEqual(normalizeElasticCcsTargets(['remote-prod*', 'analytics-remote:logs-*', 'logs:']), [
    'remote-prod*:*',
    'analytics-remote:logs-*',
    'logs:*'
  ]);

  const guidance = buildElasticCcsPromptGuidance(
    mapSettings({
      ELASTIC_CCS_SEARCH_BY_DEFAULT: 'true',
      ELASTIC_CCS_INDEX_PATTERNS: 'remote-prod*,analytics-remote:logs-*'
    })
  );

  assert.match(guidance, /remote-prod\*:\*/);
  assert.match(guidance, /analytics-remote:logs-\*/);
  assert.match(guidance, /wildcard syntax, not regex/);
});

test('applies Elastic CCS defaults to local MCP index arguments', () => {
  const targets = normalizeElasticCcsTargets(['remote-prod', 'analytics-remote:logs-*']);

  assert.deepEqual(applyElasticCcsDefaultArgs({ index: '*' }, targets), {
    index: 'remote-prod:*,analytics-remote:logs-*'
  });
  assert.deepEqual(applyElasticCcsDefaultArgs({ index: 'alerts-*' }, targets), {
    index: 'remote-prod:alerts-*,analytics-remote:logs-*'
  });
  assert.deepEqual(applyElasticCcsDefaultArgs({ index: 'remote-prod:alerts-*' }, targets), {
    index: 'remote-prod:alerts-*'
  });
  assert.deepEqual(applyElasticCcsDefaultArgs({}, targets, 'list_indices'), {
    pattern: 'remote-prod:*,analytics-remote:logs-*'
  });
});

test('generates concise suggested follow-up questions from response context', () => {
  const followUps = generateSuggestedFollowUps(
    'Built a bounded Trino catalog relationship map across iceberg and hive.',
    [
      {
        id: 'map-1',
        appId: 'rubberband',
        toolName: 'trino_catalog_map',
        toolInput: {},
        toolResult: {},
        title: 'Trino catalog relationship map'
      }
    ],
    'visualize all trino catalogs'
  );

  assert.ok(followUps.length > 0);
  assert.ok(followUps.length <= 4);
  assert.ok(followUps.some(question => question.endsWith('?')));
  assert.ok(followUps.some(question => !question.endsWith('?')));
  assert.ok(!followUps.some(question => /[.?!]\?$/.test(question)));
  assert.match(followUps.join(' '), /catalog|tables|inspect/i);
});

test('chat responses include suggested follow-ups', async () => {
  const previousFetch = globalThis.fetch;
  let completionCount = 0;
  globalThis.fetch = (async () => {
    completionCount += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Here is a Trino table summary.' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => []
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer'
        })[key] || ''
    };

    const result = await runChat(registry as never, settings as never, [{ role: 'user', content: 'summarize trino tables' }]);

    assert.equal(completionCount, 1);
    assert.ok(result.followUps.length > 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('chat applies optional LLM request tuning, headers, and body extras', async () => {
  const previousFetch = globalThis.fetch;
  let requestHeaders: Record<string, string> | undefined;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_input, init) => {
    requestHeaders = init?.headers as Record<string, string>;
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Configured response' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => []
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer',
          OPENAI_TEMPERATURE: '0.25',
          OPENAI_TOP_P: '0.85',
          OPENAI_MAX_TOKENS: '321',
          OPENAI_TIMEOUT_MS: '15000',
          OPENAI_EXTRA_HEADERS: '{"X-Provider-Route":"analytics","X-Numeric":7,"X-Enabled":true,"Ignored":{"nested":true}}',
          OPENAI_EXTRA_BODY: '{"metadata":{"suite":"api"},"parallel_tool_calls":false,"model":"ignored-model","messages":[]}'
        })[key] || ''
    };

    const result = await runChat(registry as never, settings as never, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.content, 'Configured response');
    assert.equal(requestHeaders?.authorization, 'Bearer test-key');
    assert.equal(requestHeaders?.['X-Provider-Route'], 'analytics');
    assert.equal(requestHeaders?.['X-Numeric'], '7');
    assert.equal(requestHeaders?.['X-Enabled'], 'true');
    assert.equal(requestHeaders?.Ignored, undefined);
    assert.equal(requestBody?.model, 'test-model');
    assert.ok(Array.isArray(requestBody?.messages));
    assert.equal(requestBody?.temperature, 0.25);
    assert.equal(requestBody?.top_p, 0.85);
    assert.equal(requestBody?.max_tokens, 321);
    assert.deepEqual(requestBody?.metadata, { suite: 'api' });
    assert.equal(requestBody?.parallel_tool_calls, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('chat sends image attachments as multimodal OpenAI content parts', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody: { messages?: Array<{ role: string; content: unknown }> } | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as typeof requestBody;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The image shows a chart.' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => []
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer'
        })[key] || ''
    };

    await runChat(registry as never, settings as never, [
      {
        role: 'user',
        content: 'What does this screenshot show?',
        attachments: [
          {
            id: 'image-1',
            name: 'screenshot.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,aW1hZ2U=',
            size: 5
          }
        ]
      }
    ]);

    const userMessage = requestBody?.messages?.find(message => message.role === 'user');
    assert.ok(Array.isArray(userMessage?.content));
    assert.deepEqual((userMessage?.content as Array<{ type: string }>).map(part => part.type), ['text', 'image_url']);
    assert.equal((userMessage?.content as Array<{ image_url?: { url?: string } }>)[1].image_url?.url, 'data:image/png;base64,aW1hZ2U=');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('builds space-qualified Kibana URLs for MCP apps', () => {
  assert.equal(withKibanaSpace('https://kb.example.local', ''), 'https://kb.example.local');
  assert.equal(withKibanaSpace('https://kb.example.local/', 'soc'), 'https://kb.example.local/s/soc');
  assert.equal(withKibanaSpace('https://kb.example.local/s/soc', 'soc'), 'https://kb.example.local/s/soc');
  assert.equal(withKibanaSpace('https://kb.example.local/s/existing', 'soc'), 'https://kb.example.local/s/existing');
});

test('builds Elastic Security clusters JSON from existing Elastic settings', () => {
  const clustersJson = buildElasticClustersJson({
    elasticsearchUrl: 'https://es.example.local/',
    kibanaUrl: withKibanaSpace('https://kb.example.local/', 'soc'),
    elasticsearchApiKey: 'encoded-key'
  });

  assert.deepEqual(JSON.parse(clustersJson || '[]'), [
    {
      name: 'primary',
      elasticsearchUrl: 'https://es.example.local',
      kibanaUrl: 'https://kb.example.local/s/soc',
      elasticsearchApiKey: 'encoded-key'
    }
  ]);
  assert.equal(buildElasticClustersJson({ elasticsearchUrl: 'https://es.example.local', kibanaUrl: '', elasticsearchApiKey: 'encoded-key' }), undefined);
});

test('uses field_caps with ignore_unavailable for CCS field metadata fallback', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async input => {
    requestedUrl = decodeURIComponent(String(input));
    return new Response(
      JSON.stringify({
        fields: {
          '@timestamp': { date: { type: 'date' } },
          'host.name': { keyword: { type: 'keyword' } },
          'event.severity': { long: { type: 'long' } }
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const result = await getCcsFieldsWithFieldCaps(
      mapSettings({
        ELASTICSEARCH_URL: 'https://elastic.example.local',
        ELASTICSEARCH_API_KEY: 'encoded-key'
      }),
      'remote-prod:alerts-2026.04.24-000370'
    );
    const text = result.content[0].text;
    assert.match(requestedUrl, /remote-prod:alerts-2026\.04\.24-000370\/_field_caps/);
    assert.match(requestedUrl, /ignore_unavailable=true/);
    assert.match(requestedUrl, /allow_no_indices=true/);
    assert.match(text, /host\.name/);
    assert.deepEqual(fieldCapsToFieldList({ z: { keyword: { type: 'keyword' } }, a: { date: { type: 'date' } } }), [
      { field: 'a', type: 'date' },
      { field: 'z', type: 'keyword' }
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('chat responses expose only the final UI-producing MCP result', async () => {
  const previousFetch = globalThis.fetch;
  let completionCount = 0;
  globalThis.fetch = (async () => {
    completionCount += 1;
    if (completionCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-chart',
                    type: 'function',
                    function: { name: 'dashbuilder__create_chart', arguments: '{"query":"from logs"}' }
                  },
                  {
                    id: 'call-dashboard',
                    type: 'function',
                    function: { name: 'dashbuilder__view_dashboard', arguments: '{}' }
                  },
                  {
                    id: 'call-chart-final',
                    type: 'function',
                    function: { name: 'dashbuilder__create_chart', arguments: '{"query":"from final"}' }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => [
        {
          appId: 'dashbuilder',
          appName: 'Elastic Dashbuilder',
          name: 'create_chart',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: 'ui://example-mcp-dashbuilder/chart-preview.html' } }
        },
        {
          appId: 'dashbuilder',
          appName: 'Elastic Dashbuilder',
          name: 'view_dashboard',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: 'ui://example-mcp-dashbuilder/dashboard-preview.html' } }
        }
      ],
      callTool: async (_appId: string, name: string) => ({ content: [{ type: 'text', text: name }] })
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer'
        })[key] || ''
    };

    const result = await runChat(registry as never, settings as never, [{ role: 'user', content: 'make dashboard' }]);

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call-chart-final');
    assert.equal(result.toolCalls[0].toolName, 'create_chart');
    assert.equal(result.toolCalls[0].resourceUri, 'ui://example-mcp-dashbuilder/chart-preview.html');
    assert.equal(result.usage?.promptTokens, 30);
    assert.equal(result.usage?.completionTokens, 7);
    assert.equal(result.usage?.totalTokens, 37);
    assert.equal(result.usage?.model, 'test-model');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('chat ignores non-UI tool results that only mention ui resource strings', async () => {
  const previousFetch = globalThis.fetch;
  let completionCount = 0;
  globalThis.fetch = (async () => {
    completionCount += 1;
    if (completionCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-poll',
                    type: 'function',
                    function: { name: 'security__poll_alerts', arguments: '{}' }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => [
        {
          appId: 'security',
          appName: 'Security',
          name: 'poll_alerts',
          inputSchema: { type: 'object' }
        }
      ],
      callTool: async () => ({
        content: [{ type: 'text', text: 'Polling complete. Related note: ui://not-a-preview is plain text here.' }],
        structuredContent: { note: 'ui://not-a-preview is not a renderable resource payload' }
      })
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer'
        })[key] || ''
    };

    const result = await runChat(registry as never, settings as never, [{ role: 'user', content: 'poll alerts' }]);

    assert.equal(result.content, 'Done');
    assert.equal(result.toolCalls.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('chat exposes embedded MCP app HTML resources as renderable previews', async () => {
  const previousFetch = globalThis.fetch;
  let completionCount = 0;
  globalThis.fetch = (async () => {
    completionCount += 1;
    if (completionCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-embedded',
                    type: 'function',
                    function: { name: 'dashbuilder__embedded_preview', arguments: '{}' }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => [
        {
          appId: 'dashbuilder',
          appName: 'Elastic Dashbuilder',
          name: 'embedded_preview',
          inputSchema: { type: 'object' }
        }
      ],
      callTool: async () => ({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'ui://embedded/preview.html',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main><h1>Embedded preview</h1></main>'
            }
          }
        ]
      })
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://127.0.0.1/v1',
          OPENAI_MODEL: 'test-model',
          OPENAI_AUTH_SCHEME: 'Bearer'
        })[key] || ''
    };

    const result = await runChat(registry as never, settings as never, [{ role: 'user', content: 'show preview' }]);

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call-embedded');
    assert.equal(result.toolCalls[0].resourceUri, 'ui://embedded/preview.html');
    assert.equal(result.toolCalls[0].html, '<main><h1>Embedded preview</h1></main>');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('bounded Elastic profiler ranks custom domain indices and suggests analytics', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.includes('/_cat/indices')) {
      return new Response(
        JSON.stringify([
          { index: 'myalertindex-2026.05.09', 'docs.count': '300', 'store.size': '2mb', health: 'green', status: 'open' },
          { index: '.kibana_analytics_8', 'docs.count': '50', 'store.size': '1mb', health: 'green', status: 'open' },
          { index: 'empty-index', 'docs.count': '0', 'store.size': '0b', health: 'green', status: 'open' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/_field_caps')) {
      return new Response(
        JSON.stringify({
          fields: {
            created_at: { date: { type: 'date' } },
            'risk.level': { keyword: { type: 'keyword' } },
            alert_state: { keyword: { type: 'keyword' } },
            host_name: { keyword: { type: 'keyword' } },
            username: { keyword: { type: 'keyword' } },
            ...Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`deep.nested.custom.field_${index}`, { keyword: { type: 'keyword' } }]))
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const settings = {
      get: (key: string) =>
        ({
          ELASTICSEARCH_URL: 'http://elastic.test',
          ELASTICSEARCH_API_KEY: 'encoded-key',
          DOMAIN_KNOWLEDGE: 'myalertindex-* contains custom alerts. created_at is the timestamp. risk.level is severity.'
        })[key] || ''
    };

    const profile = await buildElasticProfile(settings as never, { maxIndices: 10, maxFieldCaps: 3 });

    assert.equal(profile.analyzedIndices[0].name, 'myalertindex-2026.05.09');
    assert.equal(profile.skipped.systemIndices, 1);
    assert.equal(profile.analyzedIndices[0].fieldCount, 145);
    assert.ok(profile.analyzedIndices[0].notableFields.length <= 80);
    assert.ok(profile.analyzedIndices[0].notableFields.includes('risk.level'));
    assert.match(profile.suggestions[0].question, /security alerts|top activity|volume trends/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('bounded Elastic profiler includes resolved CCS targets by default', async () => {
  const previousFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async input => {
    const url = String(input);
    requestedUrls.push(decodeURIComponent(url));
    if (url.includes('/_cat/indices')) {
      return new Response(JSON.stringify([{ index: 'local-events', 'docs.count': '100', 'store.size': '1mb', health: 'green', status: 'open' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/_data_stream')) {
      return new Response(JSON.stringify({ data_streams: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/_remote/info')) {
      return new Response(
        JSON.stringify({
          'remote-prod': { connected: true, skip_unavailable: false },
          'analytics-remote': { connected: false, skip_unavailable: true }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/_resolve/cluster/')) {
      return new Response(
        JSON.stringify({
          clusters: {
            'remote-prod': { connected: true, matching_indices: true, skip_unavailable: false, version: { number: '8.19.0' } },
            'analytics-remote': { connected: false, matching_indices: false, skip_unavailable: true, error: { type: 'connect_exception', reason: 'offline' } }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/_field_caps')) {
      return new Response(
        JSON.stringify({
          fields: {
            '@timestamp': { date: { type: 'date' } },
            'event.category': { keyword: { type: 'keyword' } },
            'host.name': { keyword: { type: 'keyword' } },
            severity: { keyword: { type: 'keyword' } }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const profile = await buildElasticProfile(
      mapSettings({
        ELASTICSEARCH_URL: 'http://elastic.test',
        ELASTICSEARCH_API_KEY: 'encoded-key',
        ELASTIC_CCS_SEARCH_BY_DEFAULT: 'true',
        ELASTIC_CCS_INDEX_PATTERNS: 'remote-prod*,analytics-remote:logs-*',
        ELASTIC_CCS_RESOLVE_TIMEOUT_MS: '5000'
      }) as never,
      { maxIndices: 10, maxFieldCaps: 3 }
    );

    assert.equal(profile.crossCluster?.enabled, true);
    assert.deepEqual(profile.crossCluster?.resolvedTargets, ['remote-prod:*']);
    assert.deepEqual(profile.crossCluster?.skippedTargets, ['analytics-remote:logs-*']);
    assert.equal(profile.analyzedIndices[0].name, 'remote-prod:*');
    assert.equal(profile.analyzedIndices[0].kind, 'cross_cluster');
    assert.equal(profile.skipped.crossClusterTargets, 1);
    assert.doesNotMatch(requestedUrls.join('\n'), /\/_cat\/indices/);
    assert.doesNotMatch(requestedUrls.join('\n'), /\/_data_stream/);
    assert.match(requestedUrls.join('\n'), /\/_resolve\/cluster\/remote-prod:\*,analytics-remote:logs-\*/);
    assert.match(requestedUrls.join('\n'), /\/remote-prod:\*\/_field_caps/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('bounded Trino profiler catalogs tables and suggests analytics', async () => {
  const previousFetch = globalThis.fetch;
  const statements: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/statement')) {
      const sql = String(init?.body || '');
      statements.push(sql);
      if (sql.includes('SHOW CATALOGS')) {
        return new Response(JSON.stringify({ data: [['system'], ['iceberg']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('information_schema.tables')) {
        return new Response(
          JSON.stringify({
            data: [
              ['sales', 'orders', 'BASE TABLE'],
              ['sales', 'customers', 'BASE TABLE']
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (sql.includes('information_schema.columns')) {
        return new Response(
          JSON.stringify({
            data: [
              ['sales', 'orders', 'order_date', 'timestamp'],
              ['sales', 'orders', 'total_amount', 'double'],
              ['sales', 'orders', 'status', 'varchar'],
              ['sales', 'customers', 'customer_id', 'varchar'],
              ['sales', 'customers', 'region', 'varchar']
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const settings = {
      get: (key: string) =>
        ({
          TRINO_HOST: 'trino.test',
          TRINO_PORT: '8080',
          TRINO_SCHEME: 'http',
          TRINO_USER: 'analyst',
          TRINO_AUTH_TYPE: 'none',
          DOMAIN_KNOWLEDGE: 'iceberg.sales.orders contains ecommerce revenue. order_date is the timestamp.'
        })[key] || '',
      isInsecureTlsEnabled: () => false
    };

    const profile = await buildTrinoProfile(settings as never, { maxCatalogs: 2, maxTablesPerCatalog: 10, maxColumnsPerCatalog: 20 });

    assert.deepEqual(profile.catalogs, ['iceberg']);
    assert.equal(profile.analyzedTables[0].name, 'orders');
    assert.ok(profile.analyzedTables[0].timestampColumns.includes('order_date'));
    assert.match(profile.suggestions[0].question, /trending|contribute|top records/i);
    assert.ok(statements.some(statement => statement.includes('"iceberg".information_schema.tables')));
    assert.ok(!statements.some(statement => statement.includes('"system".information_schema.tables')));
    assert.equal(profile.cache?.hit, false);

    const statementCount = statements.length;
    const cachedProfile = await buildTrinoProfile(settings as never, { maxCatalogs: 2, maxTablesPerCatalog: 10, maxColumnsPerCatalog: 20 });
    assert.equal(cachedProfile.cache?.hit, true);
    assert.equal(statements.length, statementCount);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Trino catalog map requests use bounded host-side visualization path', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/statement')) {
      const sql = String(init?.body || '');
      if (sql.includes('SHOW CATALOGS')) {
        return new Response(JSON.stringify({ data: [['iceberg'], ['hive']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('"iceberg".information_schema.tables')) {
        return new Response(JSON.stringify({ data: [['sales', 'orders', 'BASE TABLE']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('"hive".information_schema.tables')) {
        return new Response(JSON.stringify({ data: [['sales', 'customers', 'BASE TABLE']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('information_schema.columns')) {
        return new Response(
          JSON.stringify({
            data: [
              ['sales', 'orders', 'customer_id', 'varchar'],
              ['sales', 'orders', 'order_date', 'timestamp'],
              ['sales', 'customers', 'customer_id', 'varchar'],
              ['sales', 'customers', 'region', 'varchar']
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => {
        throw new Error('MCP tools should not be listed for host-side catalog map');
      },
      callTool: async () => {
        throw new Error('MCP tools should not be called for host-side catalog map');
      }
    };
    const settings = {
      get: (key: string) =>
        ({
          OPENAI_API_KEY: 'test-key',
          TRINO_HOST: 'trino.test',
          TRINO_PORT: '8080',
          TRINO_SCHEME: 'http',
          TRINO_USER: 'analyst',
          TRINO_AUTH_TYPE: 'none',
          TRINO_PROFILER_MAX_CATALOGS: '4',
          TRINO_PROFILER_MAX_TABLES_PER_CATALOG: '5',
          TRINO_PROFILER_MAX_COLUMNS_PER_CATALOG: '20'
        })[key] || '',
      isInsecureTlsEnabled: () => false
    };

    assert.equal(isTrinoCatalogMapRequest('yep give a visualization of all catalogs in trino and how they relate'), true);

    const result = await runChat(
      registry as never,
      settings as never,
      [{ role: 'user', content: 'yep give a visualization of all catalogs in trino and how they relate' }],
      ['mcp-app-trino']
    );

    assert.match(result.content, /bounded Trino catalog relationship map/);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].appId, 'rubberband');
    assert.equal(result.toolCalls[0].toolName, 'trino_catalog_map');
    const toolResult = result.toolCalls[0].toolResult as { kind?: string; map?: { links?: unknown[] } };
    assert.equal(toolResult.kind, 'trinoCatalogMap');
    assert.equal(toolResult.map?.links?.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Trino catalog map chat uses the shared background profile snapshot', async () => {
  const previousFetch = globalThis.fetch;
  const statements: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/statement')) {
      const sql = String(init?.body || '');
      statements.push(sql);
      if (sql.includes('SHOW CATALOGS')) {
        return new Response(JSON.stringify({ data: [['iceberg'], ['hive']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('"iceberg".information_schema.tables')) {
        return new Response(JSON.stringify({ data: [['sales', 'orders', 'BASE TABLE']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('"hive".information_schema.tables')) {
        return new Response(JSON.stringify({ data: [['sales', 'customers', 'BASE TABLE']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (sql.includes('information_schema.columns')) {
        return new Response(
          JSON.stringify({
            data: [
              ['sales', 'orders', 'customer_id', 'varchar'],
              ['sales', 'orders', 'order_date', 'timestamp'],
              ['sales', 'customers', 'customer_id', 'varchar']
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const settings = {
      get: (key: string) =>
        ({
          ANALYTICS_PROFILER_ENABLED: 'true',
          ANALYTICS_PROFILER_RUN_ON_STARTUP: 'false',
          ANALYTICS_PROFILER_TARGETS: 'trino',
          ANALYTICS_PROFILER_SCHEDULE_MS: '0',
          ANALYTICS_PROFILER_STALE_AFTER_MS: '3600000',
          TRINO_HOST: 'trino.test',
          TRINO_PORT: '8080',
          TRINO_SCHEME: 'http',
          TRINO_USER: 'analyst',
          TRINO_AUTH_TYPE: 'none',
          TRINO_PROFILER_MAX_CATALOGS: '4',
          TRINO_PROFILER_MAX_TABLES_PER_CATALOG: '5',
          TRINO_PROFILER_MAX_COLUMNS_PER_CATALOG: '20'
        })[key] || '',
      isInsecureTlsEnabled: () => false,
      getEnvFor: () => ({}),
      snapshot: () => ({ fields: [] }),
      update: () => []
    };
    const service = new AnalyticsProfileService(settings as never);
    await service.refreshNow('test');
    const statementCount = statements.length;

    const registry = {
      getSkillGuidance: () => [],
      listTools: async () => {
        throw new Error('MCP tools should not be listed for host-side catalog map');
      },
      callTool: async () => {
        throw new Error('MCP tools should not be called for host-side catalog map');
      }
    };

    const result = await runChat(
      registry as never,
      settings as never,
      [{ role: 'user', content: 'show a graph of all catalogs in trino and how they relate' }],
      ['mcp-app-trino'],
      () => undefined,
      service
    );

    assert.equal(statements.length, statementCount);
    assert.equal(result.toolCalls[0].toolName, 'trino_catalog_map');
    assert.match(result.content, /background|fresh bounded metadata sample|Trino catalog relationship map/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('builds Trino catalog relationship map from shared metadata', () => {
  const map = buildTrinoCatalogMap({
    mode: 'deep-analysis',
    generatedAt: new Date().toISOString(),
    connectionLabel: 'Trino test',
    boundedBy: { maxCatalogs: 4, maxTablesPerCatalog: 10, maxColumnsPerCatalog: 30 },
    domainKnowledge: '',
    catalogs: ['iceberg', 'hive'],
    analyzedTables: [
      {
        catalog: 'iceberg',
        schema: 'sales',
        name: 'orders',
        type: 'BASE TABLE',
        columns: [{ schema: 'sales', table: 'orders', name: 'customer_id', type: 'varchar' }],
        domains: ['commerce'],
        timestampColumns: [],
        dimensionColumns: ['customer_id'],
        metricColumns: [],
        suggestions: []
      },
      {
        catalog: 'hive',
        schema: 'sales',
        name: 'customers',
        type: 'BASE TABLE',
        columns: [{ schema: 'sales', table: 'customers', name: 'customer_id', type: 'varchar' }],
        domains: ['commerce'],
        timestampColumns: [],
        dimensionColumns: ['customer_id'],
        metricColumns: [],
        suggestions: []
      }
    ],
    skipped: { catalogs: 0, inaccessibleCatalogs: [], uninspectedTables: 0 },
    suggestions: [],
    caveats: []
  });

  assert.equal(map.catalogs.length, 2);
  assert.equal(map.links.length, 1);
  assert.deepEqual(map.links[0].reasons.slice(0, 2), ['domain commerce', 'schema sales']);
});

async function startHttpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const fixture = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(error => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => fixture.close(error => (error ? reject(error) : resolve())))
  };
}

function readRequestBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mapSettings(values: Record<string, string>) {
  return {
    get: (key: string) => values[key] || '',
    isInsecureTlsEnabled: () => false
  };
}

async function waitForHealth(url: string, child?: ChildProcess) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json().catch(() => undefined);
        if ((body as { ok?: unknown } | undefined)?.ok === true) return;
      }
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy at ${url} in time`);
}
