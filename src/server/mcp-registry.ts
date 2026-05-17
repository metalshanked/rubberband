import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InstalledMcpApp } from './types.js';
import type { SettingsAccess } from './settings.js';
import { applyMasterTls, fetchWithMasterTls, masterTlsEnv } from './tls.js';
import { readElasticCcsSettings, wildcardToRegExp } from './elastic-ccs.js';
import {
  assertMcpAppAllowed,
  assertMcpToolCallAllowed,
  describeMcpAppExposure,
  describeMcpToolExposure,
  getMcpExposurePolicy,
  isMcpAppVisible,
  isMcpReadOnlyModeEnabled,
  isMcpToolVisible
} from './mcp-tool-policy.js';

type RuntimeApp = InstalledMcpApp & {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error?: string;
  client?: Client;
  tools?: Array<Record<string, unknown>>;
};

type ExposureTool = {
  appId: string;
  appName: string;
  name: string;
  description: string;
  reason: string;
  inputSchema?: unknown;
};

type ExposureApp = {
  id: string;
  name: string;
  description: string;
  status: RuntimeApp['status'];
  exposed: boolean;
  reason: string;
  error?: string;
  toolCount: number;
  exposedToolCount: number;
  hiddenToolCount: number;
};

export class McpRegistry {
  private readonly apps = new Map<string, RuntimeApp>();
  private settings?: SettingsAccess;
  private generatedElasticApiKey?: Promise<string | undefined>;

  static async fromManifest(manifestPath: string, settings?: SettingsAccess) {
    return new McpRegistry(await readInstalledApps(manifestPath), settings);
  }

  constructor(apps: InstalledMcpApp[] = [], settings?: SettingsAccess) {
    this.settings = settings;
    for (const app of apps) {
      this.apps.set(app.id, { ...app, status: 'idle' });
    }
  }

  static async loadApps(manifestPath: string) {
    return readInstalledApps(manifestPath);
  }

  static fromApps(apps: InstalledMcpApp[], settings?: SettingsAccess) {
    return new McpRegistry(apps, settings);
  }

  listApps() {
    return this.visibleApps().map(({ client: _client, ...app }) => app);
  }

  getSkillGuidance(appIds?: string[]) {
    const selected = appIds?.length ? appIds.map(appId => this.apps.get(appId)).filter(isRuntimeApp) : [...this.apps.values()];
    return selected.filter(app => this.isAppAvailable(app)).flatMap(app =>
      (app.skills || []).map(skill => ({
        appId: app.id,
        appName: app.name,
        ...skill
      }))
    );
  }

  async listTools(appId?: string) {
    const apps = appId ? [this.getApp(appId)] : this.visibleApps();
    if (appId) this.assertAppAvailable(apps[0]);
    const tools = [];
    for (const app of apps) {
      try {
        app.tools = await this.loadTools(app);
        app.status = 'connected';
        app.error = undefined;
        for (const tool of app.tools) {
          if (!isMcpToolVisible({ settings: this.settings, appId: app.id, appName: app.name, toolName: String(tool.name || ''), tool })) continue;
          tools.push({ appId: app.id, appName: app.name, ...tool });
        }
      } catch (error) {
        app.status = 'error';
        app.error = error instanceof Error ? error.message : String(error);
        if (appId) throw error;
      }
    }
    return tools;
  }

  async listExposure() {
    const apps = [...this.apps.values()];
    const exposedTools: ExposureTool[] = [];
    const hiddenTools: ExposureTool[] = [];
    const appReports: ExposureApp[] = [];

    for (const app of apps) {
      let rawTools: Array<Record<string, unknown>> = [];
      const appDecision = describeMcpAppExposure({ settings: this.settings, appId: app.id, appName: app.name });
      if (!appDecision.exposed) {
        appReports.push({
          id: app.id,
          name: app.name,
          description: app.description || '',
          status: app.status,
          exposed: false,
          reason: appDecision.reason,
          toolCount: 0,
          exposedToolCount: 0,
          hiddenToolCount: 0
        });
        continue;
      }

      try {
        rawTools = await this.loadTools(app);
        app.status = 'connected';
        app.error = undefined;
      } catch (error) {
        app.status = 'error';
        app.error = error instanceof Error ? error.message : String(error);
      }

      for (const tool of rawTools) {
        const name = String(tool.name || '');
        const decision = describeMcpToolExposure({ settings: this.settings, appId: app.id, appName: app.name, toolName: name, tool });
        const entry = {
          appId: app.id,
          appName: app.name,
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          reason: decision.reason,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
        };
        if (decision.exposed) {
          exposedTools.push(entry);
        } else {
          hiddenTools.push(entry);
        }
      }

      appReports.push({
        id: app.id,
        name: app.name,
        description: app.description || '',
        status: app.status,
        exposed: true,
        reason: appDecision.reason,
        ...(app.error ? { error: app.error } : {}),
        toolCount: rawTools.length,
        exposedToolCount: exposedTools.filter(tool => tool.appId === app.id).length,
        hiddenToolCount: hiddenTools.filter(tool => tool.appId === app.id).length
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      readOnlyMode: isMcpReadOnlyModeEnabled(this.settings),
      policy: getMcpExposurePolicy(this.settings),
      apps: appReports,
      hiddenApps: appReports.filter(app => !app.exposed),
      tools: exposedTools,
      hiddenTools,
      totals: {
        apps: appReports.length,
        exposedApps: appReports.filter(app => app.exposed).length,
        hiddenApps: appReports.filter(app => !app.exposed).length,
        connectedApps: appReports.filter(app => app.status === 'connected').length,
        exposedTools: exposedTools.length,
        hiddenTools: hiddenTools.length
      }
    };
  }

  async callTool(appId: string, name: string, args: Record<string, unknown>) {
    const app = this.getApp(appId);
    this.assertAppAvailable(app);
    const client = await this.ensureClient(appId);
    const tool = await this.findRawTool(app, name);
    const effectiveArgs = this.withElasticCcsDefaultArgs(app, name, args);
    assertMcpToolCallAllowed({ settings: this.settings, appId, appName: app.name, toolName: name, tool, args: effectiveArgs });
    const ccsIndexListing = await this.tryCcsIndexListingTool(app, name, effectiveArgs);
    if (ccsIndexListing) return ccsIndexListing;
    const ccsFieldMetadata = await this.tryCcsFieldMetadataTool(app, name, effectiveArgs);
    if (ccsFieldMetadata) return ccsFieldMetadata;
    const result = await client.callTool({ name, arguments: effectiveArgs });
    const ccsIndexListingFallback = await this.tryCcsIndexListingTool(app, name, effectiveArgs, result);
    if (ccsIndexListingFallback) return ccsIndexListingFallback;
    return (await this.tryCcsFieldMetadataTool(app, name, effectiveArgs, result)) || result;
  }

  async readResource(appId: string, uri: string) {
    this.assertAppAvailable(this.getApp(appId));
    const client = await this.ensureClient(appId);
    return client.readResource({ uri });
  }

  async listResources(appId: string, cursor?: string) {
    this.assertAppAvailable(this.getApp(appId));
    const client = await this.ensureClient(appId);
    return client.listResources({ cursor });
  }

  async listResourceTemplates(appId: string, cursor?: string) {
    this.assertAppAvailable(this.getApp(appId));
    const client = await this.ensureClient(appId);
    return client.listResourceTemplates({ cursor });
  }

  async listPrompts(appId: string, cursor?: string) {
    this.assertAppAvailable(this.getApp(appId));
    const client = await this.ensureClient(appId);
    return client.listPrompts({ cursor });
  }

  async reconnectAll() {
    const apps = [...this.apps.values()];
    await Promise.all(
      apps.map(async app => {
        if (app.client) {
          await app.client.close().catch(() => undefined);
        }
        app.client = undefined;
        app.tools = undefined;
        app.status = 'idle';
        app.error = undefined;
      })
    );
  }

  async closeAll() {
    await this.reconnectAll();
  }

  findTool(appId: string, toolName: string) {
    const app = this.getApp(appId);
    if (!this.isAppAvailable(app)) return undefined;
    return app.tools?.find(tool => tool.name === toolName && isMcpToolVisible({ settings: this.settings, appId: app.id, appName: app.name, toolName, tool }));
  }

  private getApp(appId: string) {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`Unknown MCP app: ${appId}`);
    return app;
  }

  private visibleApps() {
    return [...this.apps.values()].filter(app => this.isAppAvailable(app));
  }

  private isAppAvailable(app: RuntimeApp) {
    return isMcpAppVisible({ settings: this.settings, appId: app.id, appName: app.name });
  }

  private assertAppAvailable(app: RuntimeApp) {
    assertMcpAppAllowed({ settings: this.settings, appId: app.id, appName: app.name });
  }

  private async ensureClient(appId: string) {
    const app = this.getApp(appId);
    if (app.client && app.status === 'connected') return app.client;
    if (app.status === 'connecting') {
      while (app.status === 'connecting') {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (app.client && app.status === 'connected') return app.client;
    }

    app.status = 'connecting';
    app.error = undefined;

    try {
      const client = new Client(
        { name: 'rubberband-mcp-chat', version: '0.1.0' },
        {
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
            elicitation: {}
          }
        }
      );

      client.onerror = error => {
        app.status = 'error';
        app.error = error.message;
      };
      client.onclose = () => {
        app.status = 'idle';
        app.client = undefined;
      };

      if (app.transport.type === 'stdio') {
        const env = await this.buildEnv(app);
        const transport = new StdioClientTransport({
          command: app.transport.command,
          args: app.transport.args || [],
          cwd: app.transport.cwd ? path.resolve(app.transport.cwd) : process.cwd(),
          env
        });
        await client.connect(transport);
      } else {
        applyMasterTls(this.effectiveTlsSettings());
        const transport = new StreamableHTTPClientTransport(new URL(app.transport.url));
        await client.connect(transport);
      }

      app.client = client;
      app.status = 'connected';
      app.error = undefined;
      return client;
    } catch (error) {
      app.status = 'error';
      app.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async loadTools(app: RuntimeApp) {
    if (app.tools) return app.tools;
    const client = await this.ensureClient(app.id);
    const result = await client.listTools({});
    app.tools = result.tools as Array<Record<string, unknown>>;
    return app.tools;
  }

  private async findRawTool(app: RuntimeApp, toolName: string) {
    const tools = await this.loadTools(app);
    return tools.find(tool => tool.name === toolName);
  }

  private async buildEnv(app: RuntimeApp): Promise<Record<string, string>> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && (key === 'PATH' || key === 'Path' || key === 'HOME' || key === 'USERPROFILE' || key === 'SystemRoot')) {
        base[key] = value;
      }
    }
    for (const key of app.envPassthrough || []) {
      const value = this.resolvePassthroughValue(key);
      if (value !== undefined) base[key] = value;
    }
    this.addRubberbandVizContract(base);
    Object.assign(base, masterTlsEnv(this.settings));
    const elasticApiKey = await this.resolveElasticApiKey();
    if (elasticApiKey && !base.ELASTICSEARCH_API_KEY) {
      base.ELASTICSEARCH_API_KEY = elasticApiKey;
    }
    this.addElasticCcsEnv(base);
    this.addElasticCompatibilityAliases(base, elasticApiKey);
    this.addElasticClustersEnv(app, base, elasticApiKey);
    return base;
  }

  private resolvePassthroughValue(key: string) {
    if (key === 'KIBANA_URL') return withKibanaSpace(this.getConfiguredValue('KIBANA_URL'), this.getConfiguredValue('KIBANA_SPACE_ID'));

    const value = this.settings?.get(key) || process.env[key];
    if (value) return value;

    if (key === 'KIBANA_USERNAME') return this.settings?.get('ELASTICSEARCH_USERNAME') || process.env.ELASTICSEARCH_USERNAME;
    if (key === 'KIBANA_PASSWORD') return this.settings?.get('ELASTICSEARCH_PASSWORD') || process.env.ELASTICSEARCH_PASSWORD;
    if (key === 'KIBANA_API_KEY') return this.settings?.get('ELASTICSEARCH_API_KEY') || process.env.ELASTICSEARCH_API_KEY;

    return value;
  }

  private getConfiguredValue(key: string) {
    return this.settings?.get(key) || process.env[key] || '';
  }

  private addElasticCompatibilityAliases(env: Record<string, string>, elasticApiKey?: string) {
    const aliases: Record<string, string> = {
      ES_NODE: this.settings?.get('ELASTICSEARCH_URL') || process.env.ELASTICSEARCH_URL || '',
      ES_CLOUD_ID: this.settings?.get('ELASTICSEARCH_CLOUD_ID') || process.env.ELASTICSEARCH_CLOUD_ID || '',
      ES_USERNAME: this.settings?.get('ELASTICSEARCH_USERNAME') || process.env.ELASTICSEARCH_USERNAME || '',
      ES_PASSWORD: this.settings?.get('ELASTICSEARCH_PASSWORD') || process.env.ELASTICSEARCH_PASSWORD || '',
      ES_API_KEY: elasticApiKey || this.settings?.get('ELASTICSEARCH_API_KEY') || process.env.ELASTICSEARCH_API_KEY || ''
    };

    for (const [key, value] of Object.entries(aliases)) {
      if (value && !env[key]) env[key] = value;
    }
  }

  private addElasticCcsEnv(env: Record<string, string>) {
    for (const key of ['ELASTIC_CCS_SEARCH_BY_DEFAULT', 'ELASTIC_CCS_INDEX_PATTERNS', 'ELASTIC_CCS_RESOLVE_TIMEOUT_MS']) {
      const value = this.settings?.get(key) || process.env[key];
      if (value && !env[key]) env[key] = value;
    }
  }

  private addElasticClustersEnv(app: RuntimeApp, env: Record<string, string>, elasticApiKey?: string) {
    const expectsClustersConfig = app.envPassthrough?.includes('CLUSTERS_JSON') || app.envPassthrough?.includes('CLUSTERS_FILE') || app.id === 'security' || app.id === 'observability';
    if (!expectsClustersConfig) return;

    const clustersFile = this.settings?.get('CLUSTERS_FILE') || process.env.CLUSTERS_FILE || '';
    const clustersJson = this.settings?.get('CLUSTERS_JSON') || process.env.CLUSTERS_JSON || '';
    if (clustersFile && !env.CLUSTERS_FILE) env.CLUSTERS_FILE = clustersFile;
    if (clustersJson && !env.CLUSTERS_JSON) env.CLUSTERS_JSON = clustersJson;
    if (env.CLUSTERS_FILE || env.CLUSTERS_JSON) return;

    const elasticsearchUrl = this.getConfiguredValue('ELASTICSEARCH_URL');
    const kibanaUrl = withKibanaSpace(this.getConfiguredValue('KIBANA_URL'), this.getConfiguredValue('KIBANA_SPACE_ID'));
    const apiKey = elasticApiKey || this.getConfiguredValue('ELASTICSEARCH_API_KEY');
    if (!elasticsearchUrl || !kibanaUrl || !apiKey) return;

    const generated = buildElasticClustersJson({ elasticsearchUrl, kibanaUrl, elasticsearchApiKey: apiKey });
    if (generated) env.CLUSTERS_JSON = generated;
  }

  private addRubberbandVizContract(env: Record<string, string>) {
    const keys = [
      'RUBBERBAND_VIZ_THEME',
      'RUBBERBAND_VIZ_PALETTE',
      'RUBBERBAND_VIZ_DENSITY',
      'RUBBERBAND_VIZ_LEGEND',
      'RUBBERBAND_VIZ_TOOLTIP',
      'RUBBERBAND_VIZ_TIMEZONE',
      'RUBBERBAND_VIZ_NATIVE_FEATURES'
    ];
    for (const key of keys) {
      const value = this.settings?.get(key) || process.env[key];
      if (value && !env[key]) env[key] = value;
    }
  }

  private async resolveElasticApiKey() {
    const configured = this.settings?.get('ELASTICSEARCH_API_KEY') || process.env.ELASTICSEARCH_API_KEY;
    if (configured) return configured;
    if (!isTruthy(this.settings?.get('ELASTICSEARCH_AUTO_CREATE_API_KEY') || process.env.ELASTICSEARCH_AUTO_CREATE_API_KEY || '')) return undefined;

    const username = this.settings?.get('ELASTICSEARCH_USERNAME') || process.env.ELASTICSEARCH_USERNAME;
    const password = this.settings?.get('ELASTICSEARCH_PASSWORD') || process.env.ELASTICSEARCH_PASSWORD;
    const url = this.settings?.get('ELASTICSEARCH_URL') || process.env.ELASTICSEARCH_URL;
    if (!username || !password || !url) return undefined;

    this.generatedElasticApiKey ||= this.createElasticApiKey(url, username, password);
    return this.generatedElasticApiKey;
  }

  private async createElasticApiKey(elasticsearchUrl: string, username: string, password: string) {
    const endpoint = new URL('/_security/api_key', elasticsearchUrl.replace(/\/$/, ''));
    const response = await fetchWithMasterTls(this.effectiveTlsSettings(), endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: `rubberband-mcp-${Date.now()}`,
        expiration: process.env.GENERATED_ELASTICSEARCH_API_KEY_EXPIRATION || '8h'
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Unable to create Elasticsearch API key (${response.status}): ${body}`);
    }

    const body = (await response.json()) as { encoded?: string };
    if (!body.encoded) throw new Error('Elasticsearch API key response did not include encoded credential');
    return body.encoded;
  }

  private effectiveTlsSettings() {
    return this.settings || fallbackTlsSettings();
  }

  private withElasticCcsDefaultArgs(app: RuntimeApp, toolName: string, args: Record<string, unknown>) {
    if (!this.settings || !isElasticApp(app)) return args;
    const ccs = readElasticCcsSettings(this.settings);
    if (!ccs.enabled) return args;
    return applyElasticCcsDefaultArgs(args, ccs.targets, toolName);
  }

  private async tryCcsFieldMetadataTool(app: RuntimeApp, toolName: string, args: Record<string, unknown>, originalResult?: unknown) {
    if (!isElasticFieldMetadataTool(app, toolName)) return undefined;
    const index = readToolIndexArgument(args);
    if (!index || !isRemoteIndexExpression(index)) return undefined;
    if (originalResult && !isCrossClusterUnsupportedResult(originalResult)) return undefined;
    try {
      const elasticApiKey = await this.resolveElasticApiKey();
      return await getCcsFieldsWithFieldCaps(this.settings || fallbackTlsSettings(), index, elasticApiKey);
    } catch (error) {
      if (!originalResult) throw error;
      return undefined;
    }
  }

  private async tryCcsIndexListingTool(app: RuntimeApp, toolName: string, args: Record<string, unknown>, originalResult?: unknown) {
    if (!isElasticIndexListingTool(app, toolName)) return undefined;
    const pattern = readToolIndexArgument(args) || '*';
    if (!isRemoteIndexExpression(pattern)) return undefined;
    if (originalResult && !isCrossClusterUnsupportedResult(originalResult)) return undefined;
    try {
      const elasticApiKey = await this.resolveElasticApiKey();
      return await listCcsIndices(this.settings || fallbackTlsSettings(), pattern, toolName, elasticApiKey);
    } catch (error) {
      if (!originalResult) throw error;
      return undefined;
    }
  }
}

function fallbackTlsSettings() {
  return {
    isInsecureTlsEnabled: () => process.env.ALLOW_INSECURE_TLS === 'true' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  };
}

function isTruthy(value: string) {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isRuntimeApp(app: RuntimeApp | undefined): app is RuntimeApp {
  return Boolean(app);
}

async function readInstalledApps(manifestPath: string) {
  const raw = await fs.readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`MCP app manifest not found at ${manifestPath}; starting with no installed apps.`);
      return '{"apps":[]}';
    }
    throw error;
  });
  const manifest = JSON.parse(raw) as { apps?: InstalledMcpApp[] };
  return manifest.apps || [];
}

export function withKibanaSpace(kibanaUrl: string, spaceId: string) {
  const trimmedUrl = kibanaUrl.trim().replace(/\/$/, '');
  const trimmedSpace = spaceId.trim();
  if (!trimmedUrl || !trimmedSpace) return trimmedUrl || undefined;

  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.pathname === `/s/${trimmedSpace}` || parsed.pathname.startsWith(`/s/${trimmedSpace}/`)) {
      return parsed.toString().replace(/\/$/, '');
    }
    if (parsed.pathname.startsWith('/s/')) return parsed.toString().replace(/\/$/, '');
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/s/${encodeURIComponent(trimmedSpace)}`;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    if (trimmedUrl.includes('/s/')) return trimmedUrl;
    return `${trimmedUrl}/s/${encodeURIComponent(trimmedSpace)}`;
  }
}

export function buildElasticClustersJson({
  elasticsearchUrl,
  kibanaUrl,
  elasticsearchApiKey
}: {
  elasticsearchUrl: string;
  kibanaUrl: string | undefined;
  elasticsearchApiKey: string | undefined;
}) {
  const trimmedElasticsearchUrl = elasticsearchUrl.trim().replace(/\/$/, '');
  const trimmedKibanaUrl = kibanaUrl?.trim().replace(/\/$/, '') || '';
  const trimmedApiKey = elasticsearchApiKey?.trim() || '';
  if (!trimmedElasticsearchUrl || !trimmedKibanaUrl || !trimmedApiKey) return undefined;
  return JSON.stringify([
    {
      name: 'primary',
      elasticsearchUrl: trimmedElasticsearchUrl,
      kibanaUrl: trimmedKibanaUrl,
      elasticsearchApiKey: trimmedApiKey
    }
  ]);
}

type MinimalSettings = Partial<Pick<SettingsAccess, 'get' | 'isInsecureTlsEnabled'>>;

const indexArgumentKeys = ['index', 'indices', 'indexPattern', 'indexPatterns', 'index_pattern', 'index_patterns', 'dataView', 'data_view', 'target', 'pattern'];

function isElasticFieldMetadataTool(app: RuntimeApp, toolName: string) {
  const normalizedTool = toolName.toLowerCase();
  return isElasticApp(app) && ['get_fields', 'get-mapping', 'get_mapping'].includes(normalizedTool);
}

function isElasticIndexListingTool(app: RuntimeApp, toolName: string) {
  const normalizedTool = toolName.toLowerCase();
  return isElasticApp(app) && ['list_indices', 'list-indices'].includes(normalizedTool);
}

function isElasticApp(app: RuntimeApp) {
  const appId = app.id.toLowerCase();
  const appName = app.name.toLowerCase();
  return appId.includes('elastic') || appName.includes('elastic') || ['dashbuilder', 'security', 'observability'].includes(appId);
}

function readToolIndexArgument(args: Record<string, unknown>) {
  for (const key of indexArgumentKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.filter(item => typeof item === 'string' && item.trim()).join(',');
      if (joined) return joined;
    }
  }
  return '';
}

function isRemoteIndexExpression(index: string) {
  const separator = index.indexOf(':');
  if (separator <= 0) return false;
  const slash = index.indexOf('/');
  return slash === -1 || separator < slash;
}

function isCrossClusterUnsupportedResult(result: unknown) {
  const text = JSON.stringify(result);
  return /Cross-cluster calls are not supported in this context|remote indices were requested/i.test(text);
}

export function applyElasticCcsDefaultArgs(args: Record<string, unknown>, targets: string[], toolName = '') {
  if (!targets.length) return args;
  const key = indexArgumentKeys.find(candidate => candidate in args);
  if (!key) {
    return isElasticIndexListingToolName(toolName) ? { ...args, pattern: targets.join(',') } : args;
  }

  const value = args[key];
  const nextValue = applyElasticCcsDefaultValue(value, targets);
  return nextValue === value ? args : { ...args, [key]: nextValue };
}

function isElasticIndexListingToolName(toolName: string) {
  return ['list_indices', 'list-indices'].includes(toolName.toLowerCase());
}

function applyElasticCcsDefaultValue(value: unknown, targets: string[]): unknown {
  if (typeof value === 'string') {
    const next = applyElasticCcsDefaultString(value, targets);
    return next === value ? value : next;
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    if (value.some(item => isRemoteIndexExpression(item))) return value;
    return expandLocalIndexExpressions(value, targets);
  }
  return value;
}

function applyElasticCcsDefaultString(value: string, targets: string[]) {
  const expressions = splitIndexExpressions(value);
  if (!expressions.length || expressions.some(isRemoteIndexExpression)) return value;
  return expandLocalIndexExpressions(expressions, targets).join(',');
}

function splitIndexExpressions(value: string) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function expandLocalIndexExpressions(expressions: string[], targets: string[]) {
  const requested = expressions.length ? expressions : ['*'];
  const expanded = new Set<string>();

  for (const target of targets) {
    const separator = target.indexOf(':');
    if (separator === -1) {
      expanded.add(target);
      continue;
    }
    const cluster = target.slice(0, separator);
    const targetIndex = target.slice(separator + 1) || '*';
    for (const expression of requested) {
      if (isBroadIndexExpression(expression)) {
        expanded.add(target);
      } else if (targetIndex === '*' || targetIndex === expression || wildcardToRegExp(targetIndex).test(expression)) {
        expanded.add(`${cluster}:${expression}`);
      } else {
        expanded.add(target);
      }
    }
  }

  return [...expanded];
}

function isBroadIndexExpression(value: string) {
  return ['', '*', '_all'].includes(value.trim());
}

export async function getCcsFieldsWithFieldCaps(settings: MinimalSettings, index: string, elasticApiKey?: string) {
  const baseUrl = resolveElasticUrl(settings);
  const authHeader = buildElasticAuthHeader(settings, elasticApiKey);
  if (!authHeader) throw new Error('Set ELASTICSEARCH_API_KEY or Elasticsearch username/password before inspecting CCS fields.');
  const response = await fetchWithMasterTls(settings, `${baseUrl}/${encodeURIComponent(index)}/_field_caps?fields=*&ignore_unavailable=true&allow_no_indices=true&filter_path=fields.*.*.type`, {
    headers: { authorization: authHeader },
    signal: AbortSignal.timeout(readTimeoutMs(settings))
  });
  if (!response.ok) throw new Error(`Elasticsearch field_caps request failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { fields?: Record<string, Record<string, { type?: string }>> };
  const fields = fieldCapsToFieldList(body.fields || {});
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(fields, null, 2)
      }
    ]
  };
}

async function listCcsIndices(settings: MinimalSettings, pattern: string, toolName: string, elasticApiKey?: string) {
  const baseUrl = resolveElasticUrl(settings);
  const authHeader = buildElasticAuthHeader(settings, elasticApiKey);
  if (!authHeader) throw new Error('Set ELASTICSEARCH_API_KEY or Elasticsearch username/password before listing CCS indices.');
  const response = await fetchWithMasterTls(settings, `${baseUrl}/${encodeURIComponent(pattern)}/_field_caps?fields=_id&ignore_unavailable=true&allow_no_indices=true&filter_path=indices`, {
    headers: { authorization: authHeader },
    signal: AbortSignal.timeout(readTimeoutMs(settings))
  });
  if (!response.ok) throw new Error(`Elasticsearch CCS index resolution request failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { indices?: string[] };
  const rows = (body.indices || []).sort((a, b) => a.localeCompare(b)).map(index => ({ index }));
  const payload = toolName.toLowerCase() === 'list-indices'
    ? rows.map(row => ({
        index: row.index,
        health: '',
        status: '',
        docsCount: '',
        storeSize: ''
      }))
    : rows;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

export function fieldCapsToFieldList(fields: Record<string, Record<string, { type?: string }>>) {
  return Object.entries(fields)
    .map(([field, caps]) => ({
      field,
      type: Object.values(caps)[0]?.type || Object.keys(caps)[0] || 'unknown'
    }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

function resolveElasticUrl(settings: MinimalSettings) {
  const configured = (settings.get?.('ELASTICSEARCH_URL') || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const cloudUrl = elasticCloudIdToUrl(settings.get?.('ELASTICSEARCH_CLOUD_ID') || '');
  if (cloudUrl) return cloudUrl;
  throw new Error('Set ELASTICSEARCH_URL or ELASTICSEARCH_CLOUD_ID before inspecting CCS fields.');
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

function buildElasticAuthHeader(settings: MinimalSettings, elasticApiKey?: string) {
  const apiKey = elasticApiKey || settings.get?.('ELASTICSEARCH_API_KEY') || '';
  if (apiKey) return /^(apikey|bearer)\s/i.test(apiKey) ? apiKey : `ApiKey ${apiKey}`;
  const username = settings.get?.('ELASTICSEARCH_USERNAME') || '';
  const password = settings.get?.('ELASTICSEARCH_PASSWORD') || '';
  return username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : '';
}

function readTimeoutMs(settings: MinimalSettings) {
  const value = Number(settings.get?.('ELASTIC_PROFILER_TIMEOUT_MS') || '');
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 8000;
}
