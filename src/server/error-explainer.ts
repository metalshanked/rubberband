import type { SettingsAccess } from './settings.js';
import { fetchWithMasterTls } from './tls.js';

export type ErrorExplanation = {
  headline: string;
  whatHappened: string;
  likelyCauses: string[];
  suggestedFixes: string[];
  technicalSummary: string;
  generatedBy: 'llm' | 'local';
};

type ExplainContext = {
  method?: string;
  path?: string;
  appId?: string;
  toolName?: string;
};

const REDACTION = '[redacted]';
const DEFAULT_TIMEOUT_MS = 3500;

export async function explainError(error: unknown, settings: SettingsAccess, context: ExplainContext = {}): Promise<ErrorExplanation> {
  const sanitized = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
  const local = explainErrorLocally(sanitized, context);
  if (!settings.get('OPENAI_API_KEY')) return local;

  try {
    const llm = await explainErrorWithLlm(sanitized, settings, context);
    return llm || local;
  } catch {
    return local;
  }
}

export function sanitizeErrorMessage(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTION}`)
    .replace(/(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["'\s:=]+[^"',\s}]+/gi, match => {
      const separator = match.match(/["'\s:=]+/)?.[0] || '=';
      return match.split(separator)[0] + separator + REDACTION;
    })
    .replace(/https?:\/\/[^\s"',)]+/gi, url => redactUrl(url))
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTION)
    .replace(/"[^"]{220,}"/g, `"${REDACTION}"`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function explainErrorLocally(message: string, context: ExplainContext): ErrorExplanation {
  const lower = message.toLowerCase();
  const subject = context.toolName ? `${context.appId || 'MCP app'}:${context.toolName}` : context.path || 'request';

  if (lower.includes('mcp read-only mode blocked')) {
    return {
      headline: 'Rubberband blocked a write-capable MCP operation.',
      whatHappened: `${subject} looked like it could mutate an external system, so Rubberband stopped it before the tool ran.`,
      likelyCauses: ['The selected MCP app exposed a save/import/update/delete tool.', 'The request included write SQL, DDL, an administrative API, or a mutating HTTP method.'],
      suggestedFixes: ['Use a read-only query or preview-only tool.', 'Ask for a visualization or summary without importing, saving, or updating external systems.', 'Use read-only service credentials for an additional upstream safety boundary.'],
      technicalSummary: message,
      generatedBy: 'local'
    };
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      headline: 'The request took too long and was stopped.',
      whatHappened: `Rubberband waited for ${subject}, but it did not finish before the timeout.`,
      likelyCauses: [
        'The selected MCP app or upstream data source is doing too much work for one request.',
        'The query may be scanning broad metadata, many tables, or a slow remote system.',
        'The app process may be busy, blocked, or waiting on network I/O.'
      ],
      suggestedFixes: [
        'Try a narrower request with a specific catalog, schema, table, or time range.',
        'Use Rubberband analysis/profiler options for broad discovery before asking for a visualization.',
        'Check the MCP app logs and increase app-side timeout only after confirming the request is bounded.'
      ],
      technicalSummary: message,
      generatedBy: 'local'
    };
  }

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
    return {
      headline: 'Rubberband could not authenticate or was not allowed to access the resource.',
      whatHappened: `${subject} rejected the request before returning data.`,
      likelyCauses: ['Expired or missing credentials.', 'The configured user or API key lacks permission.', 'A Kibana/Trino/Elastic space, catalog, or schema setting points somewhere restricted.'],
      suggestedFixes: ['Check the relevant credentials in Settings.', 'Confirm the service account has read access to the requested resource.', 'Reload MCP apps after changing auth settings.'],
      technicalSummary: message,
      generatedBy: 'local'
    };
  }

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed') || lower.includes('network')) {
    return {
      headline: 'Rubberband could not reach a required service.',
      whatHappened: `${subject} failed while trying to connect to an upstream service.`,
      likelyCauses: ['The service URL or host is incorrect.', 'The service is down or unreachable from this machine.', 'A proxy, VPN, firewall, or TLS setting is blocking the connection.'],
      suggestedFixes: ['Verify the host/port/base URL in Settings.', 'Open the service URL from this machine or test it with a small request.', 'Check proxy, VPN, and TLS settings.'],
      technicalSummary: message,
      generatedBy: 'local'
    };
  }

  return {
    headline: 'Rubberband hit an error while handling the request.',
    whatHappened: `${subject} failed before Rubberband could complete the workflow.`,
    likelyCauses: ['A selected MCP app returned an error.', 'The request may need narrower inputs or missing settings.', 'An upstream service returned an unexpected response.'],
    suggestedFixes: ['Check Settings for the selected app and data source.', 'Retry with a smaller, more specific request.', 'Use the Tools test drawer to run the suspected tool with minimal arguments.'],
    technicalSummary: message || 'No technical message was available.',
    generatedBy: 'local'
  };
}

async function explainErrorWithLlm(message: string, settings: SettingsAccess, context: ExplainContext): Promise<ErrorExplanation | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readTimeout(settings));
  try {
    const response = await fetchWithMasterTls(settings, resolveChatCompletionsEndpoint(settings.get('OPENAI_BASE_URL')), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: buildAuthorizationHeader(settings)
      },
      body: JSON.stringify({
        model: settings.get('OPENAI_MODEL'),
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You explain Rubberband app failures to non-expert users. Use only the sanitized error and route metadata. Do not infer private data, repeat secrets, mention hidden stack traces, or ask for broad logs. Return strict JSON with headline, whatHappened, likelyCauses, suggestedFixes.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              sanitizedError: message,
              context: sanitizeContext(context)
            })
          }
        ],
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalizeLlmExplanation(JSON.parse(content), message);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLlmExplanation(value: unknown, technicalSummary: string): ErrorExplanation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const likelyCauses = readStringList(record.likelyCauses);
  const suggestedFixes = readStringList(record.suggestedFixes);
  const headline = sanitizeText(String(record.headline || 'Rubberband hit an error while handling the request.'), 140);
  const whatHappened = sanitizeText(String(record.whatHappened || ''), 420);
  if (!headline || !whatHappened || !likelyCauses.length || !suggestedFixes.length) return null;
  return {
    headline,
    whatHappened,
    likelyCauses,
    suggestedFixes,
    technicalSummary,
    generatedBy: 'llm'
  };
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(item => sanitizeText(String(item), 260)).filter(Boolean).slice(0, 4);
}

function sanitizeText(value: string, maxLength: number) {
  return sanitizeErrorMessage(value).slice(0, maxLength);
}

function sanitizeContext(context: ExplainContext) {
  return {
    method: context.method,
    path: context.path,
    appId: context.appId,
    toolName: context.toolName
  };
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname ? '/...' : ''}`;
  } catch {
    return REDACTION;
  }
}

function readTimeout(settings: SettingsAccess) {
  const value = Number(settings.get('ERROR_EXPLANATION_TIMEOUT_MS'));
  return Number.isFinite(value) && value > 500 ? value : DEFAULT_TIMEOUT_MS;
}

function resolveChatCompletionsEndpoint(baseUrl: string) {
  const normalized = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function buildAuthorizationHeader(settings: Pick<SettingsAccess, 'get'>) {
  const apiKey = settings.get('OPENAI_API_KEY');
  const scheme = settings.get('OPENAI_AUTH_SCHEME').trim() || 'Bearer';
  if (scheme.toLowerCase() === 'none') return apiKey;
  if (apiKey.toLowerCase().startsWith(`${scheme.toLowerCase()} `)) return apiKey;
  return `${scheme} ${apiKey}`;
}
