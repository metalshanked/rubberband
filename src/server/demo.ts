import type { ConnectionTestResult, ConnectionTestTarget } from './connection-tests.js';

type DemoApp = {
  id: string;
  name: string;
  status?: string;
};

type DemoTool = {
  appId: string;
  appName?: string;
  name: string;
  description?: string;
  _meta?: {
    ui?: {
      resourceUri?: string;
    };
  };
};

export type DemoCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

export type DemoPrompt = {
  label: string;
  prompt: string;
  appIds: string[];
  deepAnalysis: boolean;
};

export type DemoPlan = {
  ok: boolean;
  status: 'ready' | 'needs_apps' | 'needs_tools' | 'connection_failed';
  title: string;
  summary: string;
  checks: DemoCheck[];
  prompts: DemoPrompt[];
  selectedAppIds: string[];
  appIds: string[];
  requiredConnections: ConnectionTestTarget[];
  sanity: {
    ok: boolean;
    selectedAppIds: string[];
    availableApps: number;
    availableTools: number;
    demoApps: string[];
  };
};

type AppKind = 'elastic' | 'security' | 'observability' | 'trino' | 'starburst' | 'generic';

export function buildDemoPlan(apps: DemoApp[], tools: DemoTool[], selectedAppIds: string[] = []): DemoPlan {
  const selected = selectedAppIds.length ? apps.filter(app => selectedAppIds.includes(app.id)) : apps.filter(app => app.status !== 'error');
  const candidates = selected.length ? selected : apps.filter(app => app.status !== 'error');
  const appIds = candidates.map(app => app.id);
  const selectedTools = tools.filter(tool => !appIds.length || appIds.includes(tool.appId));
  const previewTools = selectedTools.filter(isUsefulDemoTool);
  const prompts = buildDemoPrompts(candidates, selectedTools);
  const needsApps = candidates.length === 0;
  const needsTools = !needsApps && selectedTools.length === 0;
  const requiredConnections = needsApps || needsTools ? [] : inferRequiredConnections(candidates);
  const ok = !needsApps && !needsTools && prompts.length > 0;

  return {
    ok,
    status: needsApps ? 'needs_apps' : needsTools ? 'needs_tools' : 'ready',
    title: ok ? 'Live demo ready' : needsApps ? 'Select an MCP app to run a live demo' : 'Live demo needs MCP tools',
    summary: ok
      ? `Ready to run a live data demo with ${formatList(candidates.map(app => app.name || app.id))}.`
      : needsApps
        ? 'No available MCP apps were found for a live demo.'
        : 'The selected apps are available, but Rubberband could not discover tools for them.',
    checks: [
      {
        label: 'MCP apps',
        ok: candidates.length > 0,
        detail: candidates.length ? `${candidates.length} app${candidates.length === 1 ? '' : 's'} ready` : 'No apps available'
      },
      {
        label: 'MCP tools',
        ok: selectedTools.length > 0,
        detail: selectedTools.length ? `${selectedTools.length} exposed tool${selectedTools.length === 1 ? '' : 's'}` : 'No tools discovered'
      },
      {
        label: 'Interactive previews',
        ok: previewTools.length > 0,
        detail: previewTools.length ? `${previewTools.length} likely visualization tool${previewTools.length === 1 ? '' : 's'}` : 'Will use the best available app tool'
      }
    ],
    prompts,
    selectedAppIds,
    appIds,
    requiredConnections,
    sanity: {
      ok,
      selectedAppIds,
      availableApps: apps.length,
      availableTools: tools.length,
      demoApps: appIds
    }
  };
}

export function applyDemoConnectionChecks(plan: DemoPlan, connectionChecks: ConnectionTestResult[]): DemoPlan {
  if (!connectionChecks.length) return plan;
  const checks = [
    ...plan.checks,
    ...connectionChecks.map(check => ({
      label: check.label,
      ok: check.ok,
      detail: check.ok ? check.message : `Connection check failed: ${check.message}`
    }))
  ];
  const failed = connectionChecks.filter(check => !check.ok);
  if (!failed.length) {
    return { ...plan, checks, sanity: { ...plan.sanity, ok: plan.ok } };
  }

  return {
    ...plan,
    ok: false,
    status: 'connection_failed',
    title: 'Live demo needs connection settings',
    summary: `Rubberband found the selected apps, but ${formatList(failed.map(check => check.label))} did not pass the live connection check.`,
    checks,
    sanity: { ...plan.sanity, ok: false }
  };
}

function buildDemoPrompts(apps: DemoApp[], tools: DemoTool[]): DemoPrompt[] {
  const groups = groupAppsByKind(apps);
  const prompts: DemoPrompt[] = [];

  if (groups.security.length) {
    prompts.push({
      label: 'Security live triage',
      appIds: groups.security.map(app => app.id),
      deepAnalysis: true,
      prompt: [
        'Create a live, read-only security analytics demo using the selected Elastic Security MCP app.',
        'Discover usable security data first, then generate the best interactive preview you can: severity trends, top affected hosts/users, and a short analyst takeaway.',
        'Use actual available data and MCP app previews where possible. If the selected data source has no matching records, show the closest useful live security view instead.'
      ].join('\n')
    });
  }

  if (groups.observability.length) {
    prompts.push({
      label: 'Observability live view',
      appIds: groups.observability.map(app => app.id),
      deepAnalysis: true,
      prompt: [
        'Create a live, read-only observability demo using the selected Elastic Observability MCP app.',
        'Find available logs, metrics, traces, or service data, then produce an interactive preview showing health, trend, and the most useful breakdown.',
        'Use actual available data and keep the result concise enough to present live.'
      ].join('\n')
    });
  }

  if (groups.elastic.length) {
    prompts.push({
      label: 'Elastic dashboard',
      appIds: groups.elastic.map(app => app.id),
      deepAnalysis: true,
      prompt: [
        'Create a live, read-only Elastic analytics dashboard demo from the selected app.',
        'First discover a suitable index, data view, or sample data source, then generate an interactive visualization preview with a time trend and top breakdowns.',
        'Choose the most visually useful available data; do not invent values.'
      ].join('\n')
    });
  }

  const trinoApps = [...groups.trino, ...groups.starburst];
  if (trinoApps.length) {
    prompts.push({
      label: 'Warehouse analytics',
      appIds: trinoApps.map(app => app.id),
      deepAnalysis: true,
      prompt: [
        'Create a live, read-only Trino or Starburst analytics demo from the selected MCP app.',
        'Discover accessible catalogs and tables, pick a table or relationship that can produce a useful chart or graph, and generate an interactive visualization preview.',
        'Use actual queryable data or metadata only, and keep the query bounded for a live demo.'
      ].join('\n')
    });
  }

  const usedAppIds = new Set(prompts.flatMap(prompt => prompt.appIds));
  const genericApps = groups.generic.filter(app => !usedAppIds.has(app.id));
  if (!prompts.length && genericApps.length) {
    prompts.push({
      label: 'MCP app preview',
      appIds: genericApps.map(app => app.id),
      deepAnalysis: true,
      prompt: [
        'Create a live, read-only Rubberband demo using the selected MCP app.',
        'Discover what the app can safely show, then generate the best interactive preview or concise analysis available from live tools.',
        'Do not invent data.'
      ].join('\n')
    });
  }

  return prompts
    .map(prompt => ({ ...prompt, appIds: prompt.appIds.filter(appId => tools.some(tool => tool.appId === appId)) }))
    .filter(prompt => prompt.appIds.length > 0)
    .slice(0, 4);
}

function groupAppsByKind(apps: DemoApp[]) {
  const groups: Record<AppKind, DemoApp[]> = {
    elastic: [],
    security: [],
    observability: [],
    trino: [],
    starburst: [],
    generic: []
  };
  for (const app of apps) groups[classifyApp(app)].push(app);
  return groups;
}

function classifyApp(app: DemoApp): AppKind {
  const haystack = `${app.id} ${app.name}`.toLowerCase();
  if (/starburst/.test(haystack)) return 'starburst';
  if (/trino/.test(haystack)) return 'trino';
  if (/security|soc|siem|threat/.test(haystack)) return 'security';
  if (/observability|apm|sre|kubernetes|logs|metrics|traces/.test(haystack)) return 'observability';
  if (/elastic|kibana|dashbuilder/.test(haystack)) return 'elastic';
  return 'generic';
}

function inferRequiredConnections(apps: DemoApp[]): ConnectionTestTarget[] {
  const targets = new Set<ConnectionTestTarget>(['llm']);
  for (const app of apps) {
    const kind = classifyApp(app);
    if (kind === 'elastic' || kind === 'security' || kind === 'observability') {
      targets.add('elastic');
      targets.add('kibana');
    }
    if (kind === 'trino') targets.add('trino');
    if (kind === 'starburst') targets.add('starburst');
  }
  return [...targets];
}

function isUsefulDemoTool(tool: DemoTool) {
  const haystack = `${tool.name} ${tool.description || ''} ${tool.appName || ''}`.toLowerCase();
  return Boolean(tool._meta?.ui?.resourceUri) || /visual|viz|chart|dashboard|graph|preview|query|sql|esql|discover|search|catalog|map/.test(haystack);
}

function formatList(values: string[]) {
  const cleaned = values.filter(Boolean);
  if (cleaned.length <= 1) return cleaned[0] || 'the selected connection';
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`;
}
