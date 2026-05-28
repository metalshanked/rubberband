import type { SettingsAccess } from './settings.js';
import { fetchWithMasterTls } from './tls.js';

export type WebSearchRequest = {
  query: string;
  reason?: string;
  recencyDays?: number;
  maxResults?: number;
};

export type WebSearchResult = {
  query: string;
  generatedAt: string;
  summary: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source?: string;
    publishedAt?: string;
  }>;
  caveats: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
};

export function isWebSearchEnabled(settings: Pick<SettingsAccess, 'get'>) {
  return isTruthy(settings.get('WEB_SEARCH_ENABLED'), false) && Boolean(settings.get('WEB_SEARCH_MODEL') || settings.get('OPENAI_MODEL'));
}

export async function runWebSearch(settings: SettingsAccess, request: WebSearchRequest): Promise<WebSearchResult> {
  if (!isWebSearchEnabled(settings)) throw new Error('Web search is disabled. Enable WEB_SEARCH_ENABLED and set WEB_SEARCH_MODEL.');
  const query = request.query.trim();
  if (!query) throw new Error('Web search query is required.');
  const maxResults = clampNumber(request.maxResults, 1, 20, readSettingNumber(settings, 'WEB_SEARCH_MAX_RESULTS', 8));
  const timeoutMs = readSettingNumber(settings, 'WEB_SEARCH_TIMEOUT_MS', 30_000);
  const endpoint = resolveChatCompletionsEndpoint(settings.get('WEB_SEARCH_BASE_URL') || settings.get('OPENAI_BASE_URL'));
  const response = await fetchWithMasterTls(settings, endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: buildAuthorizationHeader(settings, 'WEB_SEARCH'),
      ...readJsonHeaderObjectSetting(settings, 'OPENAI_EXTRA_HEADERS')
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      ...readJsonObjectSetting(settings, 'OPENAI_EXTRA_BODY'),
      model: settings.get('WEB_SEARCH_MODEL') || settings.get('OPENAI_MODEL'),
      messages: [
        {
          role: 'system',
          content: [
            'You are a web research model with browsing or search grounding enabled by the provider.',
            'Search the public web when needed and return only JSON.',
            'Prefer primary sources and recent authoritative pages. Do not fabricate URLs or publication dates.',
            'Return this exact shape: {"summary":"...","results":[{"title":"...","url":"https://...","snippet":"...","source":"...","publishedAt":"..."}],"caveats":["..."]}.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            query,
            reason: request.reason || 'Agent requested current web context.',
            recencyDays: request.recencyDays,
            maxResults,
            currentDate: new Date().toISOString().slice(0, 10)
          })
        }
      ],
      temperature: 0.2,
      max_tokens: Math.max(800, Math.min(4000, maxResults * 450))
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Web search model request failed (${response.status}): ${body}`);
  }
  const completion = (await response.json()) as ChatCompletionResponse;
  const content = completion.choices?.[0]?.message?.content || '';
  return normalizeWebSearchResult(query, content);
}

function normalizeWebSearchResult(query: string, content: string): WebSearchResult {
  const parsed = parseJsonObjectFromText(content);
  const results = Array.isArray(parsed?.results)
    ? parsed.results
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
        .map(item => ({
          title: readString(item.title) || readString(item.name) || 'Untitled result',
          url: readString(item.url) || readString(item.link),
          snippet: readString(item.snippet) || readString(item.summary) || readString(item.description),
          ...(readString(item.source) ? { source: readString(item.source) } : {}),
          ...(readString(item.publishedAt) || readString(item.published_at) ? { publishedAt: readString(item.publishedAt) || readString(item.published_at) } : {})
        }))
        .filter(item => item.url && /^https?:\/\//i.test(item.url))
        .slice(0, 20)
    : [];
  return {
    query,
    generatedAt: new Date().toISOString(),
    summary: readString(parsed?.summary) || content.trim().slice(0, 2000),
    results,
    caveats: Array.isArray(parsed?.caveats) ? parsed.caveats.map(item => String(item)).filter(Boolean).slice(0, 8) : []
  };
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

function resolveChatCompletionsEndpoint(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function buildAuthorizationHeader(settings: Pick<SettingsAccess, 'get'>, prefix: 'OPENAI' | 'WEB_SEARCH' = 'OPENAI') {
  const scheme = (settings.get(`${prefix}_AUTH_SCHEME`) || settings.get('OPENAI_AUTH_SCHEME')).trim();
  const apiKey = settings.get(`${prefix}_API_KEY`) || settings.get('OPENAI_API_KEY');
  if (!scheme || scheme.toLowerCase() === 'bearer') return `Bearer ${apiKey}`;
  if (scheme.toLowerCase() === 'none') return apiKey;
  return `${scheme} ${apiKey}`;
}

function readJsonObjectSetting(settings: Pick<SettingsAccess, 'get'>, key: string): Record<string, unknown> {
  const raw = settings.get(key).trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${key} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function readJsonHeaderObjectSetting(settings: Pick<SettingsAccess, 'get'>, key: string) {
  return Object.fromEntries(
    Object.entries(readJsonObjectSetting(settings, key))
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .map(([name, value]) => [name, String(value)])
  ) as Record<string, string>;
}

function readSettingNumber(settings: Pick<SettingsAccess, 'get'>, key: string, fallback: number) {
  const value = Number(settings.get(key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function isTruthy(value: string, fallback: boolean) {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
