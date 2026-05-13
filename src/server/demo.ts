type DemoApp = {
  id: string;
  name: string;
  status?: string;
};

type DemoTool = {
  appId: string;
  appName?: string;
  name: string;
};

type DemoToolCall = {
  id: string;
  appId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  resourceUri?: string;
  html?: string;
  title: string;
};

export function buildDemoPayload(apps: DemoApp[], tools: DemoTool[], selectedAppIds: string[] = []) {
  const selected = selectedAppIds.length ? apps.filter(app => selectedAppIds.includes(app.id)) : apps;
  const candidates = selected.length ? selected : apps;
  const availableNames = candidates.map(app => app.name || app.id);
  const appKinds = new Set(candidates.map(classifyApp));
  const toolCalls: DemoToolCall[] = [];
  const questions: string[] = [];

  if (appKinds.has('elastic') || appKinds.has('security') || appKinds.has('observability')) {
    questions.push(
      'Show critical security activity over the last 24 hours and highlight the riskiest hosts.',
      'Build an executive incident dashboard with severity, trend, and affected entities.',
      'Find unusual authentication or endpoint activity and turn it into an investigation view.'
    );
    toolCalls.push(buildElasticDemo());
  }

  if (appKinds.has('trino')) {
    questions.push(
      'Map the most important Trino catalogs and show relationships between business domains.',
      'Create a revenue and order quality dashboard from warehouse tables.',
      'Find tables that look joinable and suggest a starter analytics query.'
    );
    toolCalls.push(buildTrinoDemo());
  }

  if (!toolCalls.length) {
    questions.push(
      'Discover available MCP apps and suggest the best first analytics workflow.',
      'Create an example dashboard preview from the selected app capabilities.',
      'Summarize what this Rubberband workspace can demonstrate safely.'
    );
    toolCalls.push(buildGenericDemo(candidates[0]));
  }

  if (toolCalls.length === 1 && tools.some(tool => !toolCalls.some(call => call.appId === tool.appId))) {
    toolCalls.push(buildGenericDemo(candidates.find(app => app.id !== toolCalls[0].appId)));
  }

  return {
    content: [
      '# Rubberband Live Demo',
      '',
      `Sanity check: ${candidates.length ? `${candidates.length} selected or available app${candidates.length === 1 ? '' : 's'} detected` : 'LLM-only workspace detected'}.`,
      availableNames.length ? `Apps in this demo: ${availableNames.join(', ')}.` : 'No MCP apps are currently selected; showing the generic Rubberband experience.',
      '',
      '## Canned Questions',
      ...questions.slice(0, 6).map((question, index) => `${index + 1}. ${question}`),
      '',
      '## What To Show',
      '- Interactive previews render directly in chat.',
      '- Graph-style demos support pan and zoom from the preview controls.',
      '- App-native graph interactions remain available inside MCP app previews.',
      '- All demo content is local and read-only; it does not query external systems.'
    ].join('\n'),
    followUps: questions.slice(0, 4),
    toolCalls,
    sanity: {
      ok: true,
      selectedAppIds,
      availableApps: apps.length,
      availableTools: tools.length,
      demoApps: candidates.map(app => app.id)
    }
  };
}

function classifyApp(app: DemoApp) {
  const haystack = `${app.id} ${app.name}`.toLowerCase();
  if (/trino|starburst/.test(haystack)) return 'trino';
  if (/security|soc|siem/.test(haystack)) return 'security';
  if (/observability|apm|sre|kubernetes/.test(haystack)) return 'observability';
  if (/elastic|kibana|dashbuilder/.test(haystack)) return 'elastic';
  return 'generic';
}

function buildElasticDemo(): DemoToolCall {
  return {
    id: `demo-elastic-${Date.now()}`,
    appId: 'demo-elastic',
    toolName: 'demo_security_dashboard',
    toolInput: { demo: true, question: 'Show high-risk activity and investigation paths.' },
    toolResult: { content: [{ type: 'text', text: 'Demo Elastic security dashboard preview.' }] },
    resourceUri: 'ui://rubberband-demo/elastic-security-dashboard.html',
    html: demoHtml('Elastic Security Demo', 'Risk triage', ['Critical alerts', 'Endpoint activity', 'Auth anomalies'], '#d36086'),
    title: 'Elastic security triage preview'
  };
}

function buildTrinoDemo(): DemoToolCall {
  return {
    id: `demo-trino-${Date.now()}`,
    appId: 'rubberband',
    toolName: 'trino_catalog_map',
    toolInput: { demo: true, request: 'Map warehouse catalog relationships.' },
    title: 'Trino catalog relationship demo',
    toolResult: {
      kind: 'trinoCatalogMap',
      map: {
        catalogs: [
          { id: 'sales', tableCount: 18, schemaCount: 3, domains: ['commerce'], sampleTables: ['orders.fact_orders', 'customers.dim_customer'] },
          { id: 'lakehouse', tableCount: 26, schemaCount: 4, domains: ['product', 'commerce'], sampleTables: ['events.clickstream', 'products.catalog'] },
          { id: 'finance', tableCount: 11, schemaCount: 2, domains: ['finance'], sampleTables: ['billing.invoices', 'ledger.entries'] }
        ],
        links: [
          { source: 'sales', target: 'lakehouse', strength: 7, reasons: ['customer_id', 'product_id', 'commerce domain'] },
          { source: 'sales', target: 'finance', strength: 5, reasons: ['order_id', 'invoice_id'] },
          { source: 'lakehouse', target: 'finance', strength: 3, reasons: ['product revenue rollups'] }
        ],
        skipped: { catalogs: 0, uninspectedTables: 0, inaccessibleCatalogs: [] }
      }
    }
  };
}

function buildGenericDemo(app?: DemoApp): DemoToolCall {
  return {
    id: `demo-generic-${Date.now()}`,
    appId: app?.id || 'rubberband-demo',
    toolName: 'demo_preview',
    toolInput: { demo: true },
    toolResult: { content: [{ type: 'text', text: 'Demo MCP app preview.' }] },
    resourceUri: 'ui://rubberband-demo/workspace-preview.html',
    html: demoHtml('MCP Apps Demo', app?.name || 'Rubberband workspace', ['Discover tools', 'Generate preview', 'Iterate in chat'], '#54b399'),
    title: `${app?.name || 'Rubberband'} demo preview`
  };
}

function demoHtml(title: string, subtitle: string, labels: string[], accent: string) {
  const bars = labels.map((label, index) => `<div class="bar" style="--h:${48 + index * 18}%;--d:${index * 80}ms"><span>${escapeHtml(label)}</span></div>`).join('');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; color: #22303c; background: #f7fafc; }
      main { display: grid; grid-template-columns: 1fr 1.2fr; gap: 18px; min-height: 100vh; padding: 24px; box-sizing: border-box; }
      section { border: 1px solid #d8e2ec; border-radius: 8px; background: white; padding: 18px; box-shadow: 0 12px 28px rgba(35, 48, 60, 0.08); }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 0 0 16px; color: #5a6875; }
      .metrics { display: grid; gap: 10px; }
      .metric { display: flex; justify-content: space-between; border: 1px solid #e1e8ef; border-radius: 6px; padding: 10px; }
      .metric strong { color: ${accent}; }
      .chart { display: flex; align-items: end; gap: 12px; height: 260px; padding-top: 20px; }
      .bar { position: relative; flex: 1; height: var(--h); min-height: 42px; border-radius: 7px 7px 3px 3px; background: linear-gradient(180deg, ${accent}, #7a869a); animation: rise 520ms ease-out both; animation-delay: var(--d); }
      .bar span { position: absolute; left: 50%; bottom: -34px; transform: translateX(-50%); width: 130px; text-align: center; font-size: 12px; font-weight: 700; color: #465563; }
      .nodeLayer { position: relative; height: 260px; }
      .node { position: absolute; display: grid; place-items: center; width: 86px; height: 86px; border-radius: 50%; color: white; background: ${accent}; font-weight: 800; box-shadow: 0 12px 28px rgba(35,48,60,.18); }
      .n1 { left: 8%; top: 18%; } .n2 { right: 12%; top: 8%; background: #6092c0; } .n3 { left: 42%; bottom: 8%; background: #54b399; }
      .edge { position: absolute; height: 2px; background: #9aa9b8; transform-origin: left center; }
      .e1 { left: 24%; top: 31%; width: 45%; transform: rotate(-8deg); } .e2 { left: 25%; top: 48%; width: 38%; transform: rotate(31deg); } .e3 { left: 55%; top: 54%; width: 30%; transform: rotate(-35deg); }
      @keyframes rise { from { transform: scaleY(.35); opacity: .55; } to { transform: scaleY(1); opacity: 1; } }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <div class="metrics">
          <div class="metric"><span>Read-only check</span><strong>OK</strong></div>
          <div class="metric"><span>Preview generated</span><strong>Live</strong></div>
          <div class="metric"><span>Workflow fit</span><strong>High</strong></div>
        </div>
        <div class="chart">${bars}</div>
      </section>
      <section>
        <h1>Relationship view</h1>
        <p>Use Rubberband preview controls for host-level pan and zoom.</p>
        <div class="nodeLayer">
          <div class="edge e1"></div><div class="edge e2"></div><div class="edge e3"></div>
          <div class="node n1">Data</div><div class="node n2">Signals</div><div class="node n3">Action</div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}
