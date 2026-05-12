import { buildAuthorizationHeader, resolveChatCompletionsEndpoint } from './openai-chat.js';
import type { SettingsAccess } from './settings.js';
import { fetchWithMasterTls } from './tls.js';
import { sanitizeErrorMessage } from './error-explainer.js';
import { withKibanaSpace } from './mcp-registry.js';

export type ConnectionTestTarget = 'llm' | 'elastic' | 'kibana' | 'trino' | 'starburst';

export type ConnectionTestResult = {
  target: ConnectionTestTarget;
  label: string;
  ok: boolean;
  message: string;
  durationMs: number;
  details?: Record<string, string | number | boolean>;
};

type TestSettings = Pick<SettingsAccess, 'get' | 'isInsecureTlsEnabled'>;

export async function testExternalConnection(settings: TestSettings, target: ConnectionTestTarget): Promise<ConnectionTestResult> {
  const started = Date.now();
  const label = connectionLabel(target);
  try {
    const result = await runConnectionTest(settings, target);
    return {
      target,
      label,
      ok: true,
      durationMs: Date.now() - started,
      ...result
    };
  } catch (error) {
    return {
      target,
      label,
      ok: false,
      durationMs: Date.now() - started,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
    };
  }
}

function runConnectionTest(settings: TestSettings, target: ConnectionTestTarget) {
  if (target === 'llm') return testLlm(settings);
  if (target === 'elastic') return testElastic(settings);
  if (target === 'kibana') return testKibana(settings);
  if (target === 'starburst') return testTrinoLike(settings, 'STARBURST');
  return testTrinoLike(settings, 'TRINO');
}

async function testLlm(settings: TestSettings) {
  const baseUrl = settings.get('OPENAI_BASE_URL').trim();
  const model = settings.get('OPENAI_MODEL').trim();
  if (!baseUrl) throw new Error('Set OPENAI_BASE_URL before testing the LLM connection.');
  if (!model) throw new Error('Set OPENAI_MODEL before testing the LLM connection.');

  const endpoint = resolveChatCompletionsEndpoint(baseUrl);
  const extraHeaders = readJsonHeaderObjectSetting(settings, 'OPENAI_EXTRA_HEADERS');
  const extraBody = readJsonObjectSetting(settings, 'OPENAI_EXTRA_BODY');
  const temperature = readOptionalNumberSetting(settings, 'OPENAI_TEMPERATURE');
  const topP = readOptionalNumberSetting(settings, 'OPENAI_TOP_P');
  const maxTokens = readOptionalIntegerSetting(settings, 'OPENAI_MAX_TOKENS');
  const timeoutMs = readOptionalIntegerSetting(settings, 'OPENAI_TIMEOUT_MS') || 15_000;
  const auth = buildAuthorizationHeader(settings);
  const response = await fetchWithMasterTls(settings, endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
      ...extraHeaders
    },
    body: JSON.stringify({
      ...extraBody,
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      max_tokens: Math.max(1, Math.min(maxTokens || 8, 8))
    })
  });
  if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { choices?: unknown[]; model?: string };
  if (!Array.isArray(body.choices)) throw new Error('LLM response did not include choices.');
  return {
    message: `LLM responded from ${hostLabel(endpoint)}.`,
    details: {
      endpoint: hostLabel(endpoint),
      model: String(body.model || model)
    }
  };
}

async function testElastic(settings: TestSettings) {
  const baseUrl = resolveElasticUrl(settings);
  const auth = buildElasticAuthHeader(settings);
  const response = await fetchWithMasterTls(settings, `${baseUrl}/`, {
    signal: AbortSignal.timeout(readOptionalIntegerSetting(settings, 'ELASTIC_PROFILER_TIMEOUT_MS') || 8_000),
    headers: auth ? { authorization: auth } : undefined
  });
  if (!response.ok) throw new Error(`Elasticsearch request failed (${response.status}): ${await response.text()}`);
  const body = (await response.json().catch(() => ({}))) as { cluster_name?: string; version?: { number?: string } };
  return {
    message: `Elasticsearch responded${body.version?.number ? ` with ${body.version.number}` : ''}.`,
    details: {
      endpoint: hostLabel(baseUrl),
      ...(body.cluster_name ? { cluster: body.cluster_name } : {}),
      ...(body.version?.number ? { version: body.version.number } : {})
    }
  };
}

async function testKibana(settings: TestSettings) {
  const kibanaUrl = withKibanaSpace(settings.get('KIBANA_URL'), settings.get('KIBANA_SPACE_ID'));
  if (!kibanaUrl) throw new Error('Set KIBANA_URL before testing the Kibana connection.');
  const auth = buildKibanaAuthHeader(settings);
  const response = await fetchWithMasterTls(settings, `${kibanaUrl}/api/status`, {
    signal: AbortSignal.timeout(8_000),
    headers: {
      'kbn-xsrf': 'rubberband-connection-test',
      ...(auth ? { authorization: auth } : {})
    }
  });
  if (!response.ok) throw new Error(`Kibana request failed (${response.status}): ${await response.text()}`);
  const body = (await response.json().catch(() => ({}))) as { status?: { overall?: { level?: string; state?: string } }; version?: { number?: string } };
  const status = body.status?.overall?.level || body.status?.overall?.state || 'available';
  return {
    message: `Kibana status is ${status}.`,
    details: {
      endpoint: hostLabel(kibanaUrl),
      status,
      ...(body.version?.number ? { version: body.version.number } : {})
    }
  };
}

async function testTrinoLike(settings: TestSettings, prefix: 'TRINO' | 'STARBURST') {
  const label = prefix === 'STARBURST' ? 'Starburst' : 'Trino';
  const baseUrl = buildTrinoBaseUrl(settings, prefix);
  const headers = buildTrinoHeaders(settings, prefix);
  const timeoutMs = readOptionalIntegerSetting(settings, `${prefix}_PROFILER_TIMEOUT_MS`) || readOptionalIntegerSetting(settings, 'TRINO_PROFILER_TIMEOUT_MS') || 12_000;
  const result = await requestTrinoPage(settings, `${baseUrl}/v1/statement`, timeoutMs, {
    method: 'POST',
    headers,
    body: 'SELECT 1'
  });
  if (result.error) throw new Error(result.error.message || result.error.errorName || `${label} statement failed`);
  if (result.nextUri && !result.data?.length) {
    const next = await requestTrinoPage(settings, result.nextUri, timeoutMs, { headers: pickAuthorization(headers) });
    if (next.error) throw new Error(next.error.message || next.error.errorName || `${label} statement failed`);
  }
  return {
    message: `${label} accepted a SELECT 1 statement.`,
    details: {
      endpoint: hostLabel(baseUrl),
      user: String(headers['x-trino-user'] || '')
    }
  };
}

async function requestTrinoPage(settings: TestSettings, url: string, timeoutMs: number, init: RequestInit) {
  const response = await fetchWithMasterTls(settings, url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Trino request failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ data?: unknown[]; nextUri?: string; error?: { message?: string; errorName?: string } }>;
}

function resolveElasticUrl(settings: TestSettings) {
  const configured = settings.get('ELASTICSEARCH_URL').trim().replace(/\/$/, '');
  if (configured) return configured;
  const cloudUrl = elasticCloudIdToUrl(settings.get('ELASTICSEARCH_CLOUD_ID'));
  if (cloudUrl) return cloudUrl;
  throw new Error('Set ELASTICSEARCH_URL or ELASTICSEARCH_CLOUD_ID before testing Elasticsearch.');
}

function elasticCloudIdToUrl(cloudId: string) {
  const encoded = cloudId.trim().split(':').at(-1);
  if (!encoded) return '';
  try {
    const [host, elasticId] = Buffer.from(encoded, 'base64').toString('utf8').split('$');
    return host && elasticId ? `https://${elasticId}.${host}` : '';
  } catch {
    return '';
  }
}

function buildElasticAuthHeader(settings: TestSettings) {
  const apiKey = settings.get('ELASTICSEARCH_API_KEY').trim();
  if (apiKey) return /^(apikey|bearer)\s/i.test(apiKey) ? apiKey : `ApiKey ${apiKey}`;
  const username = settings.get('ELASTICSEARCH_USERNAME');
  const password = settings.get('ELASTICSEARCH_PASSWORD');
  return username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : '';
}

function buildKibanaAuthHeader(settings: TestSettings) {
  const apiKey = settings.get('KIBANA_API_KEY').trim() || settings.get('ELASTICSEARCH_API_KEY').trim();
  if (apiKey) return /^(apikey|bearer)\s/i.test(apiKey) ? apiKey : `ApiKey ${apiKey}`;
  const username = settings.get('KIBANA_USERNAME') || settings.get('ELASTICSEARCH_USERNAME');
  const password = settings.get('KIBANA_PASSWORD') || settings.get('ELASTICSEARCH_PASSWORD');
  return username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : '';
}

function buildTrinoBaseUrl(settings: TestSettings, prefix: 'TRINO' | 'STARBURST') {
  const host = settings.get(`${prefix}_HOST`).trim();
  if (!host) throw new Error(`Set ${prefix}_HOST before testing ${prefix === 'STARBURST' ? 'Starburst' : 'Trino'}.`);
  const explicitScheme = settings.get(`${prefix}_SCHEME`).trim();
  const ssl = isTruthy(settings.get(`${prefix}_SSL`)) || isTruthy(settings.get(`${prefix}_INSECURE_TLS`));
  const scheme = explicitScheme || (ssl ? 'https' : 'http');
  const port = settings.get(`${prefix}_PORT`).trim();
  return `${scheme}://${host}${port ? `:${port}` : ''}`.replace(/\/$/, '');
}

function buildTrinoHeaders(settings: TestSettings, prefix: 'TRINO' | 'STARBURST') {
  const user = settings.get(`${prefix}_USER`) || settings.get('TRINO_USER') || 'rubberband';
  const source = settings.get('TRINO_SOURCE') || 'rubberband';
  const catalog = settings.get(`${prefix}_CATALOG`) || (prefix === 'TRINO' ? settings.get('TRINO_CATALOG') : '');
  const schema = settings.get(`${prefix}_SCHEMA`) || (prefix === 'TRINO' ? settings.get('TRINO_SCHEMA') : '');
  const authorization = buildTrinoAuthHeader(settings, prefix);
  return {
    'content-type': 'text/plain; charset=utf-8',
    'x-trino-user': user,
    'x-trino-source': source,
    ...(catalog ? { 'x-trino-catalog': catalog } : {}),
    ...(schema ? { 'x-trino-schema': schema } : {}),
    ...(authorization ? { authorization } : {})
  } as Record<string, string>;
}

function buildTrinoAuthHeader(settings: TestSettings, prefix: 'TRINO' | 'STARBURST') {
  const token = settings.get(`${prefix}_ACCESS_TOKEN`) || settings.get('TRINO_ACCESS_TOKEN');
  if (token) return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  const authType = settings.get(`${prefix}_AUTH_TYPE`) || settings.get('TRINO_AUTH_TYPE');
  const user = settings.get(`${prefix}_USER`) || settings.get('TRINO_USER');
  const password = settings.get(`${prefix}_PASSWORD`) || settings.get('TRINO_PASSWORD');
  if (user && password && /basic|password|ldap/i.test(authType || '')) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  return '';
}

function pickAuthorization(headers: Record<string, string>) {
  return headers.authorization ? { authorization: headers.authorization } : undefined;
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

function connectionLabel(target: ConnectionTestTarget) {
  if (target === 'llm') return 'LLM';
  if (target === 'elastic') return 'Elasticsearch';
  if (target === 'kibana') return 'Kibana';
  if (target === 'starburst') return 'Starburst';
  return 'Trino';
}

function hostLabel(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

function isTruthy(value: string) {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
