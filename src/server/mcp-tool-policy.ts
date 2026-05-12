import process from 'node:process';
import type { SettingsAccess } from './settings.js';

export class McpPolicyViolation extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'McpPolicyViolation';
  }
}

export class McpReadOnlyViolation extends McpPolicyViolation {
  constructor(message: string) {
    super(message);
    this.name = 'McpReadOnlyViolation';
  }
}

export type AppPolicyContext = {
  settings?: Pick<SettingsAccess, 'get'>;
  appId: string;
  appName?: string;
};

export type ToolPolicyContext = AppPolicyContext & {
  toolName: string;
  tool?: Record<string, unknown>;
  args?: Record<string, unknown>;
};

export type McpAppExposureDecision = {
  exposed: boolean;
  reason: string;
};

export type McpToolExposureDecision = {
  exposed: boolean;
  readOnlyMode: boolean;
  reason: string;
};

export type McpExposurePolicySnapshot = {
  enabledApps: string[];
  disabledApps: string[];
  enabledTools: string[];
  disabledTools: string[];
  readOnlyMode: boolean;
  readOnlyToolAllowlist: string[];
};

const mutatingToolNamePattern =
  /(^|[._\-\s])(ack|add|alter|assign|bulk|close|create|delete|deploy|destroy|disable|drop|enable|execute|import|index|ingest|insert|merge|open|patch|post|publish|put|reindex|remove|resolve|run|save|schedule|truncate|update|upsert|write)([._\-\s]|$)/i;
const stronglyMutatingDescriptionPattern =
  /\b(delete|drop|truncate|update|upsert|insert|merge|write|persist|save|import|reindex|bulk|ingest|create\s+(?:case|rule|alert|index|data\s*view|api\s*key|dashboard)|modify|mutate)\b/i;
const safeToolNamePattern =
  /(^|[._\-\s])(analy[sz]e|chart|describe|explain|fetch|find|get|graph|inspect|list|map|poll|preview|profile|query|read|render|search|summari[sz]e|visuali[sz]e)([._\-\s]|$)/i;
const mutatingSqlPattern =
  /^\s*(alter|analyze|call|copy|create|delete|drop|execute|grant|insert|merge|optimize|refresh|rename|repair|replace|revoke|set\s+role|truncate|update|use\s+|vacuum)\b/i;
const mutatingMethodPattern = /^(delete|patch|post|put)$/i;
const mutatingOperationPattern = /^(ack|add|alter|assign|bulk|close|create|delete|deploy|destroy|disable|drop|enable|execute|import|index|ingest|insert|merge|open|patch|post|publish|put|reindex|remove|resolve|run|save|schedule|truncate|update|upsert|write)$/i;
const mutatingEndpointPattern =
  /\/(_bulk|_delete_by_query|_update_by_query|_reindex|_ingest|_security|_snapshot|_tasks\/[^/]+\/_cancel|_ilm|_slm|_watcher|_license|_cluster\/settings)\b/i;

export function isMcpReadOnlyModeEnabled(settings?: Pick<SettingsAccess, 'get'>) {
  const raw = settings?.get('MCP_READ_ONLY_MODE') || process.env.MCP_READ_ONLY_MODE || 'true';
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function buildMcpReadOnlyPromptGuidance(settings?: Pick<SettingsAccess, 'get'>) {
  if (!isMcpReadOnlyModeEnabled(settings)) return '';
  return [
    'MCP read-only mode is enabled.',
    'Do not use MCP apps to import, save, create, update, delete, reindex, acknowledge, close, assign, or otherwise mutate external systems.',
    'SQL/ESQL/KQL/tool queries must be read-only metadata or retrieval requests. Do not run DDL, DML, administrative, or write APIs.'
  ].join('\n');
}

export function getMcpExposurePolicy(settings?: Pick<SettingsAccess, 'get'>): McpExposurePolicySnapshot {
  return {
    enabledApps: readPolicyList(settings, 'MCP_ENABLED_APPS'),
    disabledApps: readPolicyList(settings, 'MCP_DISABLED_APPS'),
    enabledTools: readPolicyList(settings, 'MCP_ENABLED_TOOLS'),
    disabledTools: readPolicyList(settings, 'MCP_DISABLED_TOOLS'),
    readOnlyMode: isMcpReadOnlyModeEnabled(settings),
    readOnlyToolAllowlist: readPolicyList(settings, 'MCP_READ_ONLY_TOOL_ALLOWLIST')
  };
}

export function isMcpAppVisible(context: AppPolicyContext) {
  return describeMcpAppExposure(context).exposed;
}

export function describeMcpAppExposure(context: AppPolicyContext): McpAppExposureDecision {
  const disabledApps = readPolicyList(context.settings, 'MCP_DISABLED_APPS');
  if (matchesPolicyPattern(disabledApps, appMatchValues(context))) {
    return { exposed: false, reason: 'App is disabled by MCP_DISABLED_APPS.' };
  }

  const enabledApps = readPolicyList(context.settings, 'MCP_ENABLED_APPS');
  if (enabledApps.length && !matchesPolicyPattern(enabledApps, appMatchValues(context))) {
    return { exposed: false, reason: 'App is not included by MCP_ENABLED_APPS.' };
  }

  return {
    exposed: true,
    reason: enabledApps.length ? 'App is included by MCP_ENABLED_APPS.' : 'No MCP app allowlist is configured.'
  };
}

export function assertMcpAppAllowed(context: AppPolicyContext) {
  const decision = describeMcpAppExposure(context);
  if (!decision.exposed) {
    throw new McpPolicyViolation(`MCP exposure policy blocked ${context.appId}: ${decision.reason}`);
  }
}

export function isMcpToolVisible(context: ToolPolicyContext) {
  return describeMcpToolExposure(context).exposed;
}

export function isMcpToolVisibleInReadOnlyMode(context: ToolPolicyContext) {
  return describeMcpToolExposure(context).exposed;
}

export function describeMcpToolExposure(context: ToolPolicyContext): McpToolExposureDecision {
  const availability = describeMcpToolAvailability(context);
  const readOnlyMode = isMcpReadOnlyModeEnabled(context.settings);
  if (!availability.exposed) {
    return { exposed: false, readOnlyMode, reason: availability.reason };
  }
  if (!readOnlyMode) {
    return { exposed: true, readOnlyMode, reason: 'MCP_READ_ONLY_MODE is disabled.' };
  }
  if (isToolAllowlisted(context)) {
    return { exposed: true, readOnlyMode, reason: 'Tool is allowlisted by MCP_READ_ONLY_TOOL_ALLOWLIST.' };
  }
  if (isLikelyMutatingTool(context.toolName, context.tool)) {
    return { exposed: false, readOnlyMode, reason: 'Blocked by read-only policy because the tool name or description appears mutating.' };
  }
  return { exposed: true, readOnlyMode, reason: 'Allowed by read-only policy.' };
}

export function assertMcpToolCallAllowed(context: ToolPolicyContext) {
  const toolId = formatToolId(context);
  const availability = describeMcpToolAvailability(context);
  if (!availability.exposed) {
    throw new McpPolicyViolation(`MCP exposure policy blocked ${toolId}: ${availability.reason}`);
  }
  if (!isMcpReadOnlyModeEnabled(context.settings)) return;
  if (!isToolAllowlisted(context) && isLikelyMutatingTool(context.toolName, context.tool)) {
    throw new McpReadOnlyViolation(`MCP read-only mode blocked ${toolId} because it appears to mutate external systems.`);
  }
  const reason = findMutatingArgumentReason(context.args || {});
  if (reason) {
    throw new McpReadOnlyViolation(`MCP read-only mode blocked ${toolId}: ${reason}.`);
  }
}

export function isLikelyMutatingTool(toolName: string, tool?: Record<string, unknown>) {
  const normalizedName = normalizeName(toolName);
  const description = typeof tool?.description === 'string' ? tool.description : '';
  const text = `${normalizedName}\n${description}`;

  if (safeToolNamePattern.test(normalizedName) && !/\b(import|delete|drop|update|upsert|save|write|reindex|bulk|ingest)\b/i.test(normalizedName)) {
    return false;
  }
  return mutatingToolNamePattern.test(normalizedName) || stronglyMutatingDescriptionPattern.test(text);
}

function describeMcpToolAvailability(context: ToolPolicyContext): McpAppExposureDecision {
  const appDecision = describeMcpAppExposure(context);
  if (!appDecision.exposed) return appDecision;

  const disabledTools = readPolicyList(context.settings, 'MCP_DISABLED_TOOLS');
  if (matchesPolicyPattern(disabledTools, toolMatchValues(context))) {
    return { exposed: false, reason: 'Tool is disabled by MCP_DISABLED_TOOLS.' };
  }

  const enabledTools = readPolicyList(context.settings, 'MCP_ENABLED_TOOLS');
  if (enabledTools.length && !matchesPolicyPattern(enabledTools, toolMatchValues(context))) {
    return { exposed: false, reason: 'Tool is not included by MCP_ENABLED_TOOLS.' };
  }

  return {
    exposed: true,
    reason: enabledTools.length ? 'Tool is included by MCP_ENABLED_TOOLS.' : 'No MCP tool allowlist is configured.'
  };
}

function findMutatingArgumentReason(args: Record<string, unknown>) {
  for (const item of walkValues(args)) {
    const key = item.key.toLowerCase();
    if (typeof item.value === 'string') {
      const value = item.value.trim();
      if (/^(method|httpmethod|http_method)$/i.test(key) && mutatingMethodPattern.test(value)) {
        return `HTTP method ${value.toUpperCase()} is not read-only`;
      }
      if (/(^|_)(operation|action|verb|command)(_|$)/i.test(key) && mutatingOperationPattern.test(value)) {
        return `operation ${value} is not read-only`;
      }
      if (/(^|_)(path|url|endpoint|api)(_|$)/i.test(key) && mutatingEndpointPattern.test(value)) {
        return `endpoint ${value} is not read-only`;
      }
      if (/(^|_)(sql|query|statement|esql)(_|$)/i.test(key) && containsMutatingSql(value)) {
        return 'the supplied query contains write, DDL, or administrative SQL';
      }
    }
    if (item.value === true && /(^|_)(delete|drop|truncate|update|upsert|insert|merge|save|persist|import|write|overwrite|reindex)(_|$)/i.test(key)) {
      return `argument ${item.key}=true requests a write operation`;
    }
  }
  return '';
}

function containsMutatingSql(value: string) {
  return splitSqlStatements(stripSqlComments(value)).some(statement => mutatingSqlPattern.test(statement));
}

function stripSqlComments(value: string) {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}

function splitSqlStatements(value: string) {
  return value
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

function walkValues(value: unknown, key = '', depth = 0): Array<{ key: string; value: unknown }> {
  if (depth > 5) return [];
  if (!value || typeof value !== 'object') return [{ key, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => walkValues(item, `${key}[${index}]`, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) =>
    walkValues(childValue, key ? `${key}.${childKey}` : childKey, depth + 1)
  );
}

function isToolAllowlisted(context: ToolPolicyContext) {
  const patterns = readPolicyList(context.settings, 'MCP_READ_ONLY_TOOL_ALLOWLIST');
  if (!patterns.length) return false;
  const ids = [formatToolId(context), context.toolName];
  return patterns.some(pattern =>
    ids.some(id => wildcardPattern(pattern).test(id) || wildcardPattern(normalizeName(pattern)).test(normalizeName(id)))
  );
}

function readPolicyList(settings: Pick<SettingsAccess, 'get'> | undefined, key: string) {
  const raw = settings?.get(key) || process.env[key] || '';
  return raw
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function appMatchValues(context: AppPolicyContext) {
  return [context.appId, context.appName || ''].filter(Boolean);
}

function toolMatchValues(context: ToolPolicyContext) {
  return [
    formatToolId(context),
    context.toolName,
    context.appName ? `${context.appName}:${context.toolName}` : ''
  ].filter(Boolean);
}

function matchesPolicyPattern(patterns: string[], values: string[]) {
  if (!patterns.length || !values.length) return false;
  return patterns.some(pattern => values.some(value => wildcardPattern(pattern).test(value)));
}

function wildcardPattern(pattern: string) {
  const escaped = escapeRegExp(pattern.trim())
    .replace(/\\\*/g, '.*')
    .replace(/\\\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatToolId(context: ToolPolicyContext) {
  return `${context.appId}:${context.toolName}`;
}

function normalizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
