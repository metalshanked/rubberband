import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRenderer } from '@mcp-ui/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  BarChart3,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Database,
  Download,
  FileText,
  GitBranch,
  History,
  Image as ImageIcon,
  Info,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  Mic,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Table2,
  Trash2,
  ZoomIn,
  ZoomOut,
  X,
  User
} from 'lucide-react';
import './styles.css';

type AppInfo = {
  id: string;
  name: string;
  description?: string;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error?: string;
};

type McpTool = {
  appId: string;
  appName: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: {
    ui?: {
      resourceUri?: string;
    };
  };
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  hidden?: boolean;
  attachments?: ChatAttachment[];
  toolCalls?: RenderableToolCall[];
  followUps?: string[];
  usage?: TokenUsage;
};

type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
  source?: string;
};

type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  width?: number;
  height?: number;
};

type RubberbandSpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      0?: {
        transcript: string;
      };
    };
  };
};

type RubberbandSpeechRecognitionError = Event & {
  error?: string;
};

type RubberbandSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RubberbandSpeechRecognitionEvent) => void) | null;
  onerror: ((event: RubberbandSpeechRecognitionError) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RubberbandSpeechRecognitionConstructor = new () => RubberbandSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: RubberbandSpeechRecognitionConstructor;
    webkitSpeechRecognition?: RubberbandSpeechRecognitionConstructor;
  }
}

type ErrorExplanation = {
  headline: string;
  whatHappened: string;
  likelyCauses: string[];
  suggestedFixes: string[];
  technicalSummary: string;
  generatedBy: 'llm' | 'local';
};

type UserError = {
  message: string;
  technicalError?: string;
  explanation?: ErrorExplanation;
};

type RenderableToolCall = {
  id: string;
  appId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  resourceUri?: string;
  html?: string;
  title: string;
  interactionEvents?: VizInteractionEvent[];
  previewRevision?: number;
};

type DemoResponse = {
  ok: boolean;
  status: 'ready' | 'needs_apps' | 'needs_tools' | 'connection_failed';
  title: string;
  summary: string;
  checks: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }>;
  prompts: Array<{
    label: string;
    narration: string;
    prompt: string;
    appIds: string[];
    deepAnalysis: boolean;
  }>;
  appIds: string[];
  sanity?: {
    ok?: boolean;
    selectedAppIds?: string[];
    availableApps?: number;
    availableTools?: number;
    demoApps?: string[];
  };
};

type ToolResultUpdate = {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  resourceUri?: string;
  html?: string;
};

type TrinoCatalogMapResult = {
  kind: 'trinoCatalogMap';
  map: {
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
  profile?: {
    connectionLabel?: string;
    analyzedTables?: unknown[];
  };
};

type VizInteractionEvent = {
  id: string;
  at: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  chatVisible: boolean;
};

type SettingField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'checkbox' | 'textarea';
  group: 'llm' | 'elastic' | 'kibana' | 'trino' | 'viz' | 'domain' | 'mcp' | 'profiler' | 'advanced';
  sensitive?: boolean;
  locked: boolean;
  hasValue: boolean;
  value: string;
  defaultValue: string;
  source: 'env' | 'runtime' | 'default' | 'empty';
};

type SettingsSnapshot = {
  fields: SettingField[];
};

type AboutInfo = {
  name: string;
  packageName: string;
  version: string;
  description: string;
  license: string;
  build: {
    builtAt: string;
    commit: string;
    shortCommit: string;
    branch: string;
    node: string;
  };
};

type AnalyticsProfileStatus = 'idle' | 'running' | 'ready' | 'stale' | 'error' | 'skipped';

type AnalyticsProfileData = {
  generatedAt?: string;
  connectionLabel?: string;
  totalDiscoveredIndices?: number;
  totalDiscoveredDataStreams?: number;
  analyzedIndices?: unknown[];
  catalogs?: unknown[];
  analyzedTables?: unknown[];
  suggestions?: unknown[];
  skipped?: Record<string, unknown>;
  cache?: {
    hit?: boolean;
    ttlMs?: number;
  };
};

type AnalyticsProfileEntry = {
  target: 'elastic' | 'trino';
  status: AnalyticsProfileStatus;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessfulAt?: string;
  nextRunAt?: string;
  runCount: number;
  error?: string;
  profile?: AnalyticsProfileData;
};

type AnalyticsProfileSnapshot = {
  enabled: boolean;
  scheduleMs: number;
  staleAfterMs: number;
  running: boolean;
  elastic: AnalyticsProfileEntry;
  trino: AnalyticsProfileEntry;
};

type ConnectionTestTarget = 'llm' | 'elastic' | 'kibana' | 'trino' | 'starburst';

type ConnectionTestResult = {
  target: ConnectionTestTarget;
  label: string;
  ok: boolean;
  message: string;
  durationMs: number;
  details?: Record<string, string | number | boolean>;
};

type ServerProgressEvent = {
  id: number;
  at: string;
  level: 'info' | 'debug' | 'error';
  message: string;
};

type SubmitOptions = {
  progressMessage?: string;
  cleanupOnAbortMessageId?: string;
  appIds?: string[];
  deepAnalysis?: boolean;
  suppressError?: boolean;
};

type SubmitResult =
  | {
      ok: true;
      message: ChatMessage;
    }
  | {
      ok: false;
      aborted: boolean;
      error?: UserError;
    };

type StoredConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

type PersistChatStateResult = {
  ok: boolean;
  conversations: StoredConversation[];
  prunedCount: number;
  error?: unknown;
};

type ExportFormat = 'markdown' | 'docx' | 'pdf';

let browserSessionId = '';
const APP_BASE_PATH = resolveAppBasePath();
const CHAT_HISTORY_KEY = 'rubberband.chatHistory.v1';
const ACTIVE_CONVERSATION_KEY = 'rubberband.activeConversationId.v1';
const SIDEBAR_COLLAPSED_KEY = 'rubberband.sidebarCollapsed.v1';
const SELECTED_MCP_APPS_KEY = 'rubberband.selectedMcpApps.v1';
const DEFAULT_INTRO_MESSAGE = 'Ask for a dashboard, SQL chart, Elastic/Kibana workflow, or Trino/Starburst analytics preview.';
const MAX_STORED_CONVERSATIONS = 24;
const HISTORY_STORAGE_FULL_NOTICE = 'Browser history storage is full. Current chat still works, but new history may not be saved. Clear all history to recover.';
const MAX_VIZ_INTERACTIONS_PER_PREVIEW = 12;
const MAX_VIZ_INTERACTIONS_FOR_CONTEXT = 6;
const MAX_CHAT_ATTACHMENTS = 4;
const MAX_CHAT_ATTACHMENT_BYTES = 5_000_000;
const MAX_CHAT_IMAGE_DIMENSION = 1600;

function formatDemoIntroMessage(result: DemoResponse) {
  const appNames = result.sanity?.demoApps?.length ? `${result.sanity.demoApps.length} selected MCP app${result.sanity.demoApps.length === 1 ? '' : 's'}` : 'the selected MCP apps';
  const steps = result.prompts.map((prompt, index) => `${index + 1}. ${prompt.label}${prompt.deepAnalysis ? ' (Deep Analysis)' : ''}`).join('\n');
  return [
    '### Rubberband Live Demo',
    '',
    'Rubberband is a chat workspace for analytics MCP apps. It can discover tools, call them safely in a read-only flow, and render interactive charts or app previews directly inside the conversation.',
    '',
    `For this demo I found ${appNames}. I will start with quick visual steps, then finish with Deep Analysis for a broader read.`,
    '',
    'What I will cover:',
    steps
  ].join('\n');
}

function formatDemoStepMessage(prompt: DemoResponse['prompts'][number], index: number, total: number) {
  const mode = prompt.deepAnalysis ? 'Deep Analysis' : 'normal MCP chat';
  return [`### Step ${index + 1} of ${total}: ${prompt.label}`, '', prompt.narration, '', `Mode: ${mode}.`].join('\n');
}

function formatDemoRecoveryMessage(prompt: DemoResponse['prompts'][number], error?: UserError) {
  const reason = error?.message ? ` Technical note: ${error.message}` : '';
  return [
    `### Step skipped gracefully: ${prompt.label}`,
    '',
    `That step took the scenic route and did not make it back in time. I will keep the demo moving.${reason}`,
    '',
    prompt.deepAnalysis
      ? 'Deep Analysis is designed for broader synthesis, so it can be more sensitive to timeouts or connector limits. The visual demo above is still usable.'
      : 'This usually means the selected app had no quick matching data or a tool timed out. The next step will try a simpler route.'
  ].join('\n');
}

function formatDemoWrapUpMessage(result: DemoResponse, completedSteps: string[], skippedSteps: string[]) {
  const completed = completedSteps.length ? `Completed: ${completedSteps.join(', ')}.` : 'The live steps could not complete this time.';
  const skipped = skippedSteps.length ? `Skipped gracefully: ${skippedSteps.join(', ')}.` : '';
  return [
    '### Demo wrap-up',
    '',
    completed,
    skipped,
    '',
    'What you can try next:',
    '- Ask for a different chart type, such as a bar chart, trend line, table, or graph.',
    '- Select a different MCP app or narrow the question to a known index, catalog, schema, or table.',
    '- Use Deep Analysis when you want a broader read across the available context.',
    '- Export the conversation when you want a shareable Markdown, DOCX, or PDF artifact.',
    '',
    result.prompts.some(prompt => prompt.deepAnalysis)
      ? 'If Deep Analysis had a quiet moment, the regular visual workflow still shows the main Rubberband loop: ask, preview, refine, and share.'
      : 'This is the main Rubberband loop: ask, preview, refine, and share.'
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFallbackDemoMessages(result?: DemoResponse, error?: UserError): ChatMessage[] {
  const reason = result
    ? result.summary
    : error?.message
      ? `The live precheck could not complete: ${error.message}`
      : 'The live precheck could not confirm that connectors and the LLM are available.';
  const checks = result?.checks?.length
    ? `\n\nPrecheck:\n${result.checks.map(check => `- ${check.ok ? 'OK' : 'Needs attention'}: ${check.label} - ${check.detail}`).join('\n')}`
    : '';
  return [
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [
        '### Rubberband Demo',
        '',
        'Rubberband normally runs live analytics through selected MCP apps and renders the resulting visualizations directly in chat.',
        '',
        `Live mode is not available right now. ${reason}`,
        checks,
        '',
        'I will switch to a static feature tour so the demo still shows the core experience without requiring connectors or an LLM.'
      ]
        .filter(Boolean)
        .join('\n')
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [
        '### Step 1 of 3: Chat becomes an interactive preview',
        '',
        'A user asks a plain-language analytics question. Rubberband routes it to selected MCP apps, keeps the operation read-only, and places the visualization in the conversation.'
      ].join('\n'),
      toolCalls: [buildFallbackDemoToolCall('workspace')]
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [
        '### Step 2 of 3: Apps can show charts, dashboards, and graphs',
        '',
        'The same chat surface can host Elastic-style dashboards, Trino or Starburst charts, graph previews, summaries, export, and follow-up analysis.'
      ].join('\n'),
      toolCalls: [buildFallbackDemoToolCall('visuals')]
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [
        '### Step 3 of 3: Live mode adds your data',
        '',
        'When connectors and the LLM are configured, this same presenter flow runs against real selected apps. Quick visual steps run first, and Deep Analysis wraps up with a broader read.'
      ].join('\n'),
      toolCalls: [buildFallbackDemoToolCall('flow')]
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [
        '### Wrap-up: what to try next',
        '',
        'Connect an MCP app and an LLM, then run the demo again for live data.',
        '',
        'Good first prompts:',
        '- Build a chart from a known index or data view.',
        '- Show a Trino catalog or table relationship graph.',
        '- Summarize the current preview and suggest the next investigation.',
        '- Export the chat as Markdown, DOCX, or PDF.'
      ].join('\n')
    }
  ];
}

function buildFallbackDemoToolCall(kind: 'workspace' | 'visuals' | 'flow'): RenderableToolCall {
  return {
    id: `fallback-demo-${kind}-${crypto.randomUUID()}`,
    appId: 'rubberband-demo',
    toolName: `static_${kind}_tour`,
    toolInput: { fallback: true, kind },
    toolResult: { content: [{ type: 'text', text: `Static ${kind} demo preview.` }] },
    resourceUri: `ui://rubberband-demo/${kind}.html`,
    html: fallbackDemoHtml(kind),
    title:
      kind === 'workspace'
        ? 'Rubberband workspace tour'
        : kind === 'visuals'
          ? 'Visualization feature tour'
          : 'Live demo flow tour'
  };
}

function fallbackDemoHtml(kind: 'workspace' | 'visuals' | 'flow') {
  const content =
    kind === 'workspace'
      ? fallbackWorkspaceHtml()
      : kind === 'visuals'
        ? fallbackVisualsHtml()
        : fallbackFlowHtml();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light; --ink:#182531; --muted:#5e6c7a; --line:#d7e0ea; --panel:#ffffff; --bg:#f5f8fb; --green:#18a058; --blue:#3478c6; --pink:#d36086; --gold:#b8860b; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, Segoe UI, Arial, sans-serif; color: var(--ink); background: var(--bg); }
      main { min-height: 100vh; padding: 22px; display: grid; gap: 14px; }
      .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
      h1 { margin: 0; font-size: 25px; line-height: 1.1; letter-spacing: 0; }
      p { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
      .badge { border: 1px solid var(--line); background: white; border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 800; color: var(--blue); white-space: nowrap; }
      .grid { display: grid; grid-template-columns: 1.05fr .95fr; gap: 14px; }
      .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; box-shadow: 0 12px 28px rgba(31, 44, 59, .07); }
      .card strong { display:block; font-size: 22px; margin-bottom: 4px; }
      .card span { color: var(--muted); font-size: 12px; font-weight: 700; }
      .bars { display: flex; align-items: end; height: 230px; gap: 12px; padding: 14px 4px 30px; }
      .bar { flex: 1; min-height: 36px; height: var(--h); border-radius: 7px 7px 3px 3px; background: linear-gradient(180deg, var(--c), #6b7785); position: relative; }
      .bar span { position: absolute; left: 50%; bottom: -26px; transform: translateX(-50%); font-size: 11px; color: var(--muted); font-weight: 800; white-space: nowrap; }
      .lineChart { width: 100%; height: 230px; display: block; }
      .nodeMap { position: relative; height: 290px; background: linear-gradient(135deg, #f8fbfe, #edf3f8); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
      .node { position: absolute; display: grid; place-items: center; width: 96px; height: 96px; border-radius: 50%; color: white; font-weight: 900; box-shadow: 0 12px 26px rgba(31,44,59,.18); text-align:center; padding: 10px; font-size: 13px; }
      .edge { position: absolute; height: 3px; background: #9fb0c1; transform-origin: left center; border-radius: 999px; }
      .n1 { left: 8%; top: 16%; background: var(--blue); } .n2 { left: 42%; top: 9%; background: var(--green); } .n3 { right: 9%; top: 42%; background: var(--pink); } .n4 { left: 31%; bottom: 9%; background: #6f58c9; }
      .e1 { left: 22%; top: 31%; width: 31%; transform: rotate(-8deg); } .e2 { left: 56%; top: 34%; width: 30%; transform: rotate(26deg); } .e3 { left: 42%; top: 55%; width: 26%; transform: rotate(-42deg); } .e4 { left: 24%; top: 49%; width: 28%; transform: rotate(39deg); }
      .flow { display: grid; gap: 10px; }
      .step { display: grid; grid-template-columns: 36px 1fr auto; gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: white; }
      .num { width: 32px; height: 32px; border-radius: 50%; display:grid; place-items:center; background:#e8f2fc; color:var(--blue); font-weight:900; }
      .step strong { display:block; font-size: 14px; }
      .step span { color: var(--muted); font-size: 12px; }
      .mode { font-size: 11px; font-weight: 900; border: 1px solid var(--line); border-radius: 999px; padding: 5px 8px; color: var(--muted); }
      @media (max-width: 760px) { main { padding: 14px; } .grid, .cards { grid-template-columns: 1fr; } .hero { align-items: start; flex-direction: column; } }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

function fallbackWorkspaceHtml() {
  return `<main>
    <div class="hero"><div><h1>Connected Intelligence Workspace</h1><p>One chat surface for MCP apps, live previews, follow-ups, exports, and read-only analytics.</p></div><div class="badge">Static fallback tour</div></div>
    <div class="cards">
      <div class="card"><strong>1</strong><span>chat surface</span></div>
      <div class="card"><strong>4+</strong><span>app families</span></div>
      <div class="card"><strong>0</strong><span>write operations</span></div>
    </div>
    <div class="grid">
      <section class="panel"><h1>What users see</h1><p>Ask a question, get a visual result, iterate without leaving the conversation.</p><div class="bars"><div class="bar" style="--h:62%;--c:var(--blue)"><span>Ask</span></div><div class="bar" style="--h:88%;--c:var(--green)"><span>Preview</span></div><div class="bar" style="--h:74%;--c:var(--pink)"><span>Refine</span></div><div class="bar" style="--h:54%;--c:var(--gold)"><span>Export</span></div></div></section>
      <section class="panel"><h1>What Rubberband coordinates</h1><p>LLM chat, MCP app tools, UI resources, history, settings, and bounded analysis.</p><div class="nodeMap"><div class="edge e1"></div><div class="edge e2"></div><div class="edge e3"></div><div class="edge e4"></div><div class="node n1">Chat</div><div class="node n2">MCP Apps</div><div class="node n3">Preview</div><div class="node n4">Export</div></div></section>
    </div>
  </main>`;
}

function fallbackVisualsHtml() {
  return `<main>
    <div class="hero"><div><h1>Charts, Dashboards, Graphs</h1><p>Rubberband can host app-generated UI previews alongside normal markdown answers.</p></div><div class="badge">Simple inputs, polished outputs</div></div>
    <div class="grid">
      <section class="panel"><h1>Demo-ready visual types</h1><p>Simple views tend to be the most reliable live: trend, top-N, status, relationship graph.</p><svg class="lineChart" viewBox="0 0 520 230" role="img" aria-label="Static line chart"><rect x="0" y="0" width="520" height="230" rx="8" fill="#fff"/><g stroke="#d7e0ea"><line x1="42" x2="500" y1="185" y2="185"/><line x1="42" x2="500" y1="135" y2="135"/><line x1="42" x2="500" y1="85" y2="85"/><line x1="42" x2="500" y1="35" y2="35"/></g><polyline fill="none" stroke="#3478c6" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" points="42,172 110,144 178,156 246,92 314,108 382,62 470,42"/><polyline fill="none" stroke="#18a058" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" points="42,190 110,182 178,132 246,146 314,96 382,116 470,78"/><g fill="#182531" font-size="12" font-weight="800"><text x="42" y="213">Now</text><text x="418" y="213">Actionable</text></g></svg></section>
      <section class="panel"><h1>Presenter script</h1><p>Each live step explains what is happening before the tool call, then the preview lands below it.</p><div class="flow"><div class="step"><div class="num">1</div><div><strong>Quick chart</strong><span>Normal MCP chat path</span></div><div class="mode">fast</div></div><div class="step"><div class="num">2</div><div><strong>Graph or dashboard</strong><span>Simple bounded request</span></div><div class="mode">visual</div></div><div class="step"><div class="num">3</div><div><strong>Deep Analysis</strong><span>Broader synthesis last</span></div><div class="mode">deep</div></div></div></section>
    </div>
  </main>`;
}

function fallbackFlowHtml() {
  return `<main>
    <div class="hero"><div><h1>Reliable Demo Flow</h1><p>When live services are configured, the same sequence runs against selected apps. If one step fails, Rubberband explains and continues.</p></div><div class="badge">Graceful recovery</div></div>
    <div class="flow">
      <div class="step"><div class="num">1</div><div><strong>Precheck</strong><span>Confirm apps, tools, and live connection settings.</span></div><div class="mode">ready</div></div>
      <div class="step"><div class="num">2</div><div><strong>Quick visual</strong><span>Small chart or graph first for a reliable first impression.</span></div><div class="mode">normal</div></div>
      <div class="step"><div class="num">3</div><div><strong>Second angle</strong><span>Show another app or visualization type if available.</span></div><div class="mode">bounded</div></div>
      <div class="step"><div class="num">4</div><div><strong>Deep Analysis</strong><span>Use the broader analysis pass after the simple visuals have landed.</span></div><div class="mode">last</div></div>
      <div class="step"><div class="num">5</div><div><strong>Recover</strong><span>Turn tool errors into plain-language presenter notes and continue.</span></div><div class="mode">safe</div></div>
    </div>
  </main>`;
}

function App() {
  const initialChatState = useMemo(() => loadChatState(), []);
  const initialSelectedAppIds = useMemo(() => loadSelectedMcpAppIds(), []);
  const [chatScale, setChatScale] = useState(() => {
    const raw = window.localStorage.getItem('rubberband.chatScale');
    const saved = raw === null ? NaN : Number(raw);
    return Number.isFinite(saved) && saved >= 0.75 && saved <= 1.15 ? saved : 0.9;
  });
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(initialSelectedAppIds || []);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null);
  const [toolArgsDraft, setToolArgsDraft] = useState('{}');
  const [toolRunResult, setToolRunResult] = useState<string | null>(null);
  const [toolRunError, setToolRunError] = useState<string | null>(null);
  const [toolRunning, setToolRunning] = useState(false);
  const [expandedToolAppIds, setExpandedToolAppIds] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState(initialChatState.activeId);
  const [conversationHistory, setConversationHistory] = useState<StoredConversation[]>(initialChatState.conversations);
  const [messages, setMessages] = useState<ChatMessage[]>(initialChatState.messages);
  const [draft, setDraft] = useState('');
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const [historyStorageNotice, setHistoryStorageNotice] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ history: true, apps: false, tools: true });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot>({ fields: [] });
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [analyticsProfile, setAnalyticsProfile] = useState<AnalyticsProfileSnapshot | null>(null);
  const [analyticsProfileLoading, setAnalyticsProfileLoading] = useState(false);
  const [analyticsProfileRefreshing, setAnalyticsProfileRefreshing] = useState(false);
  const [testingConnection, setTestingConnection] = useState<ConnectionTestTarget | null>(null);
  const [connectionTestResults, setConnectionTestResults] = useState<Partial<Record<ConnectionTestTarget, ConnectionTestResult>>>({});
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [refreshingApps, setRefreshingApps] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [progressMessage, setProgressMessage] = useState('Starting request');
  const [progressExpanded, setProgressExpanded] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<RubberbandSpeechRecognition | null>(null);
  const voiceBaseDraftRef = useRef('');
  const finalVoiceTranscriptRef = useRef('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const didHydrateChatRef = useRef(false);
  const hasStoredSelectedAppIdsRef = useRef(initialSelectedAppIds !== null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const toolsByApp = useMemo(() => groupToolsByApp(tools, apps, selectedAppIds), [tools, apps, selectedAppIds]);
  const selectedToolCount = useMemo(() => tools.filter(tool => selectedAppIds.includes(tool.appId)).length, [tools, selectedAppIds]);
  const selectedTool = useMemo(() => (selectedToolKey ? tools.find(tool => toolKey(tool) === selectedToolKey) || null : null), [selectedToolKey, tools]);
  const progressCanExpand = progressMessage.length > 54;

  useEffect(() => {
    let cancelled = false;
    async function bootstrapSession() {
      try {
        await api<{ sessionId: string }>('/api/session');
        if (cancelled) return;
        setSessionReady(true);
        await refresh();
      } catch (err) {
        if (!cancelled) setError(toUserError(err));
      }
    }
    void bootstrapSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const controller = new AbortController();
    void loadAnalyticsProfileStatus({ signal: controller.signal });
    const timer = window.setInterval(() => {
      void loadAnalyticsProfileStatus({ quiet: true });
    }, analyticsProfile?.running ? 3000 : 10000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [settingsOpen, analyticsProfile?.running]);

  useEffect(() => {
    if (!sessionReady) return;
    const eventUrl = browserSessionId ? appUrl(`/api/events?sessionId=${encodeURIComponent(browserSessionId)}`) : appUrl('/api/events');
    const events = new EventSource(eventUrl);
    const onProgress = (event: MessageEvent<string>) => {
      const progress = JSON.parse(event.data) as ServerProgressEvent;
      if (progress.level !== 'debug') setProgressMessage(progress.message);
    };
    events.addEventListener('progress', onProgress as EventListener);
    events.onerror = () => {
      setProgressMessage('Waiting for server updates');
    };
    return () => {
      events.removeEventListener('progress', onProgress as EventListener);
      events.close();
    };
  }, [sessionReady]);

  useEffect(() => {
    window.localStorage.setItem('rubberband.chatScale', String(chatScale));
  }, [chatScale]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    setProgressExpanded(false);
  }, [progressMessage]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (selectedToolKey && !selectedTool) {
      setSelectedToolKey(null);
      setToolRunResult(null);
      setToolRunError(null);
    }
  }, [selectedToolKey, selectedTool]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!didHydrateChatRef.current) {
      didHydrateChatRef.current = true;
      const result = persistChatState(conversationId, conversationHistory);
      updateHistoryStorageNotice(result);
      if (result.conversations !== conversationHistory) setConversationHistory(result.conversations);
      return;
    }
    setConversationHistory(current => {
      const now = new Date().toISOString();
      const existing = current.find(conversation => conversation.id === conversationId);
      const updatedConversation: StoredConversation = {
        id: conversationId,
        title: deriveConversationTitle(messages),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        messages
      };
      const next = [updatedConversation, ...current.filter(conversation => conversation.id !== conversationId)].slice(0, MAX_STORED_CONVERSATIONS);
      return persistConversationHistory(conversationId, next);
    });
  }, [conversationId, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  async function refresh() {
    const [initialAppsResult, settingsResult, profileResult, aboutResult] = await Promise.all([
      api<{ apps: AppInfo[] }>('/api/apps'),
      api<SettingsSnapshot>('/api/settings'),
      api<AnalyticsProfileSnapshot>('/api/analytics-profile').catch(() => null),
      api<AboutInfo>('/api/about').catch(() => null)
    ]);
    const toolsResult = await api<{ tools: McpTool[] }>('/api/tools').catch(() => ({ tools: [] }));
    const appsResult = await api<{ apps: AppInfo[] }>('/api/apps').catch(() => initialAppsResult);
    applyAppsAndTools(appsResult.apps, toolsResult.tools);
    setSettingsSnapshot(settingsResult);
    setSettingsValues(valuesFromSettings(settingsResult.fields));
    if (profileResult) setAnalyticsProfile(profileResult);
    if (aboutResult) setAboutInfo(aboutResult);
  }

  function applyAppsAndTools(nextApps: AppInfo[], nextTools: McpTool[]) {
    setApps(nextApps);
    setTools(nextTools);
    setSelectedAppIds(current => {
      const availableIds = nextApps.map(app => app.id);
      if (!availableIds.length) return [];
      const next = !hasStoredSelectedAppIdsRef.current && !current.length ? availableIds : current.filter(appId => availableIds.includes(appId));
      persistSelectedMcpAppIds(next);
      hasStoredSelectedAppIdsRef.current = true;
      return next;
    });
  }

  async function sendMessage() {
    const content = draft.trim();
    if ((!content && !pendingAttachments.length) || busy) return;
    stopVoiceInput();

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content || 'Please analyze the attached image.',
      attachments: pendingAttachments.length ? pendingAttachments : undefined
    };
    const nextMessages = [...messages, userMessage];
    setDraft('');
    setPendingAttachments([]);
    setAttachmentNotice(null);
    await submitMessages(nextMessages, { progressMessage: 'Sending message' });
  }

  async function addAttachmentFiles(files: FileList | File[] | null) {
    if (!files?.length) return;
    setAttachmentNotice(null);
    const available = MAX_CHAT_ATTACHMENTS - pendingAttachments.length;
    if (available <= 0) {
      setAttachmentNotice(`Remove an attachment before adding another image. Limit is ${MAX_CHAT_ATTACHMENTS}.`);
      return;
    }

    const next: ChatAttachment[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files).slice(0, available)) {
      if (!file.type.startsWith('image/')) {
        rejected.push(`${file.name || 'pasted item'} is not an image`);
        continue;
      }
      try {
        next.push(await fileToChatAttachment(file));
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (next.length) {
      setPendingAttachments(current => [...current, ...next].slice(0, MAX_CHAT_ATTACHMENTS));
    }
    if (rejected.length) setAttachmentNotice(rejected.slice(0, 2).join('. '));
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments(current => current.filter(attachment => attachment.id !== id));
    setAttachmentNotice(null);
  }

  async function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    await addAttachmentFiles(files);
  }

  async function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    await addAttachmentFiles(files);
  }

  function toggleVoiceInput() {
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    startVoiceInput();
  }

  function startVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAttachmentNotice('Voice input is not supported in this browser. Try Chrome or Edge over localhost/HTTPS.');
      return;
    }

    stopVoiceInput();
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    voiceBaseDraftRef.current = draft;
    finalVoiceTranscriptRef.current = '';

    recognition.onresult = event => {
      let interimTranscript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || '';
        if (!transcript) continue;
        if (result.isFinal) finalVoiceTranscriptRef.current = joinVoiceDraft(finalVoiceTranscriptRef.current, transcript);
        else interimTranscript = joinVoiceDraft(interimTranscript, transcript);
      }
      setDraft(joinVoiceDraft(voiceBaseDraftRef.current, finalVoiceTranscriptRef.current, interimTranscript));
    };
    recognition.onerror = event => {
      const reason = event.error ? ` (${event.error})` : '';
      setAttachmentNotice(`Voice input stopped${reason}. Check microphone permission and try again.`);
      setVoiceListening(false);
    };
    recognition.onend = () => {
      setVoiceListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setVoiceListening(true);
      setAttachmentNotice(null);
      composerRef.current?.focus();
    } catch (err) {
      recognitionRef.current = null;
      setVoiceListening(false);
      setAttachmentNotice(err instanceof Error ? err.message : 'Could not start voice input.');
    }
  }

  function stopVoiceInput() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceListening(false);
      return;
    }
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      recognition.abort();
    }
    recognitionRef.current = null;
    setVoiceListening(false);
  }

  async function submitMessages(nextMessages: ChatMessage[], options: SubmitOptions = {}): Promise<SubmitResult> {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setMessages(nextMessages);
    setBusy(true);
    setError(null);
    setProgressMessage(options.progressMessage || 'Starting request');

    try {
      const result = await api<{ content: string; toolCalls?: RenderableToolCall[]; followUps?: string[]; usage?: unknown }>('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          messages: nextMessages.map(message => ({
            role: message.role,
            content: messageContentForModel(message)
          })),
          appIds: options.appIds ?? selectedAppIds,
          deepAnalysis: options.deepAnalysis ?? deepAnalysis
        })
      });
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.content,
        toolCalls: normalizeRenderableToolCalls(result.toolCalls),
        followUps: result.followUps || [],
        usage: normalizeTokenUsage(result.usage)
      };
      setMessages(current => [...current, assistantMessage]);
      await refresh();
      return { ok: true, message: assistantMessage };
    } catch (err) {
      if (isAbortError(err)) {
        if (options.cleanupOnAbortMessageId) {
          setMessages(current => current.filter(message => message.id !== options.cleanupOnAbortMessageId));
        }
        setProgressMessage('Request canceled');
        return { ok: false, aborted: true };
      } else {
        const userError = toUserError(err);
        if (!options.suppressError) setError(userError);
        return { ok: false, aborted: false, error: userError };
      }
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      setBusy(false);
    }
  }

  function cancelActiveRequest() {
    if (!busy) return;
    setProgressMessage('Canceling request');
    activeRequestRef.current?.abort();
  }

  function editUserMessage(messageId: string) {
    if (busy) return;
    const index = messages.findIndex(message => message.id === messageId);
    const message = messages[index];
    if (!message || message.role !== 'user') return;
    setDraft(message.content);
    setPendingAttachments(message.attachments || []);
    setMessages(messages.slice(0, index));
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function retryFromMessage(messageId: string) {
    if (busy) return;
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0) return;

    const message = messages[index];
    if (message.role === 'assistant') {
      const nextMessages = messages.slice(0, index);
      if (nextMessages.some(item => item.role === 'user')) {
        await submitMessages(nextMessages, { progressMessage: 'Retrying response' });
      }
      return;
    }

    await submitMessages(messages.slice(0, index + 1), { progressMessage: 'Retrying response' });
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(current => (current === message.id ? null : current)), 1200);
  }

  async function exportChat(format: ExportFormat) {
    if (exportingFormat) return;
    const exportMessages = messages.filter(message => !message.hidden);
    if (!exportMessages.length) return;
    setExportMenuOpen(false);
    setExportingFormat(format);
    try {
      await exportConversation(format, exportMessages, deriveConversationTitle(exportMessages));
    } catch (err) {
      setError(toUserError(err));
    } finally {
      setExportingFormat(null);
    }
  }

  async function reloadAppsAndTools() {
    if (refreshingApps) return;
    setRefreshingApps(true);
    setError(null);
    setProgressMessage('Reloading apps and tools');
    try {
      const result = await api<{ apps: AppInfo[]; tools: McpTool[] }>('/api/apps/refresh', { method: 'POST' });
      applyAppsAndTools(result.apps, result.tools);
      setProgressMessage(`Reloaded ${result.apps.length} apps and ${result.tools.length} tools`);
    } catch (err) {
      setError(toUserError(err));
    } finally {
      setRefreshingApps(false);
    }
  }

  async function runLiveDemo() {
    if (busy || demoRunning) return;
    setDemoRunning(true);
    setError(null);
    setProgressMessage('Checking live demo readiness');
    try {
      const result = await api<DemoResponse>('/api/demo', {
        method: 'POST',
        body: JSON.stringify({ appIds: selectedAppIds })
      });
      const prompt = result.prompts[0];
      if (!result.ok || !prompt) {
        setMessages(current => [...current, ...buildFallbackDemoMessages(result)]);
        setProgressMessage('Static demo ready');
        return;
      }

      let demoMessages: ChatMessage[] = [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: formatDemoIntroMessage(result)
        }
      ];
      setMessages(demoMessages);
      const completedSteps: string[] = [];
      const skippedSteps: string[] = [];

      for (const [index, demoPrompt] of result.prompts.entries()) {
        const presenterMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: formatDemoStepMessage(demoPrompt, index, result.prompts.length)
        };
        const requestMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: demoPrompt.prompt,
          hidden: true
        };
        demoMessages = [...demoMessages, presenterMessage, requestMessage];
        const stepResult = await submitMessages(demoMessages, {
          progressMessage: `Running ${demoPrompt.label}`,
          cleanupOnAbortMessageId: requestMessage.id,
          appIds: demoPrompt.appIds.length ? demoPrompt.appIds : result.appIds,
          deepAnalysis: demoPrompt.deepAnalysis,
          suppressError: true
        });
        if (stepResult.ok) {
          demoMessages = [...demoMessages, stepResult.message];
          completedSteps.push(demoPrompt.label);
        } else if (stepResult.aborted) {
          return;
        } else {
          skippedSteps.push(demoPrompt.label);
          const recoveryMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: formatDemoRecoveryMessage(demoPrompt, stepResult.error)
          };
          demoMessages = demoMessages.filter(message => message.id !== requestMessage.id).concat(recoveryMessage);
          setMessages(demoMessages);
        }
      }
      demoMessages = [
        ...demoMessages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: formatDemoWrapUpMessage(result, completedSteps, skippedSteps)
        }
      ];
      setMessages(demoMessages);
      setProgressMessage('Demo complete');
    } catch (err) {
      setMessages(current => [...current, ...buildFallbackDemoMessages(undefined, toUserError(err))]);
      setProgressMessage('Static demo ready');
    } finally {
      setDemoRunning(false);
    }
  }

  function toggleSection(section: string) {
    setCollapsedSections(current => ({ ...current, [section]: !current[section] }));
  }

  function selectToolForTest(tool: McpTool) {
    setExpandedToolAppIds(current => (current.includes(tool.appId) ? current : [...current, tool.appId]));
    setSelectedToolKey(toolKey(tool));
    setToolArgsDraft(defaultArgsForTool(tool));
    setToolRunResult(null);
    setToolRunError(null);
  }

  function toggleToolGroup(appId: string) {
    setExpandedToolAppIds(current => (current.includes(appId) ? current.filter(id => id !== appId) : [...current, appId]));
  }

  async function runSelectedTool() {
    if (!selectedTool || toolRunning) return;

    let args: Record<string, unknown>;
    try {
      args = parseToolRunnerArgs(toolArgsDraft);
    } catch (err) {
      setToolRunResult(null);
      setToolRunError(formatErrorForInline(err));
      return;
    }

    setToolRunning(true);
    setToolRunResult(null);
    setToolRunError(null);
    try {
      const result = await api<unknown>(`/api/apps/${encodeURIComponent(selectedTool.appId)}/tools/call?name=${encodeURIComponent(selectedTool.name)}`, {
        method: 'POST',
        body: JSON.stringify({ arguments: args })
      });
      setToolRunResult(formatToolRunnerResult(result));
    } catch (err) {
      setToolRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setToolRunning(false);
    }
  }

  function selectedAppSummary() {
    const selected = apps.filter(app => selectedAppIds.includes(app.id));
    if (!selected.length) return 'LLM-only chat. Select an MCP app to bring tools into the conversation.';
    if (selected.length === 1) return `Chatting with ${selected[0].name}.`;
    if (selected.length === apps.length && apps.length > 1) return 'All MCP analytics apps are available for this chat.';
    return `Chatting with ${selected.map(app => app.name).join(', ')}.`;
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsNotice(null);
    setError(null);
    try {
      const result = await api<SettingsSnapshot & { changedKeys: string[] }>('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ values: settingsValues })
      });
      setSettingsSnapshot(result);
      setSettingsValues(valuesFromSettings(result.fields));
      setSettingsNotice(result.changedKeys.length ? 'Settings saved. MCP apps were reloaded when needed.' : 'No setting changes to save.');
      await refresh();
    } catch (err) {
      setError(toUserError(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function loadAnalyticsProfileStatus({
    quiet = false,
    signal
  }: {
    quiet?: boolean;
    signal?: AbortSignal;
  } = {}) {
    if (!quiet) setAnalyticsProfileLoading(true);
    try {
      const result = await api<AnalyticsProfileSnapshot>('/api/analytics-profile', { signal });
      setAnalyticsProfile(result);
    } catch (err) {
      if (!quiet && !isAbortError(err)) setError(toUserError(err));
    } finally {
      if (!quiet) setAnalyticsProfileLoading(false);
    }
  }

  async function runAnalyticsProfileRefresh() {
    if (analyticsProfileRefreshing) return;
    setAnalyticsProfileRefreshing(true);
    setSettingsNotice(null);
    setError(null);
    try {
      const result = await api<AnalyticsProfileSnapshot>('/api/analytics-profile/refresh', { method: 'POST' });
      setAnalyticsProfile(result);
      setSettingsNotice('Profiler refresh finished.');
    } catch (err) {
      setError(toUserError(err));
    } finally {
      setAnalyticsProfileRefreshing(false);
    }
  }

  async function testConnection(target: ConnectionTestTarget) {
    if (testingConnection) return;
    setTestingConnection(target);
    setSettingsNotice(null);
    setError(null);
    try {
      const result = await api<ConnectionTestResult>('/api/settings/test', {
        method: 'POST',
        body: JSON.stringify({ target, values: editableValuesFromSettings(settingsSnapshot.fields, settingsValues) })
      });
      setConnectionTestResults(current => ({ ...current, [target]: result }));
    } catch (err) {
      setError(toUserError(err));
    } finally {
      setTestingConnection(null);
    }
  }

  function resetSettingsGroup(group: SettingField['group']) {
    setSettingsValues(current => {
      const next = { ...current };
      for (const field of settingsSnapshot.fields) {
        if (field.group === group && !field.locked) {
          next[field.key] = field.defaultValue || '';
        }
      }
      return next;
    });
    setSettingsNotice(null);
  }

  function toggleSelectedApp(appId: string) {
    setSelectedAppIds(current => {
      const next = current.includes(appId) ? current.filter(id => id !== appId) : [...current, appId];
      persistSelectedMcpAppIds(next);
      hasStoredSelectedAppIdsRef.current = true;
      return next;
    });
  }

  function startNewConversation() {
    if (busy) return;
    const conversation = createConversation();
    stopVoiceInput();
    setDraft('');
    setPendingAttachments([]);
    setConversationId(conversation.id);
    setMessages(conversation.messages);
    setConversationHistory(current => {
      const next = [conversation, ...current].slice(0, MAX_STORED_CONVERSATIONS);
      return persistConversationHistory(conversation.id, next);
    });
  }

  function openConversation(id: string) {
    if (busy || id === conversationId) return;
    const conversation = conversationHistory.find(item => item.id === id);
    if (!conversation) return;
    stopVoiceInput();
    setDraft('');
    setPendingAttachments([]);
    setConversationId(conversation.id);
    setMessages(conversation.messages);
    persistConversationHistory(conversation.id, conversationHistory);
  }

  function deleteConversation(id: string) {
    if (busy) return;
    const remaining = conversationHistory.filter(conversation => conversation.id !== id);
    if (id !== conversationId) {
      setConversationHistory(persistConversationHistory(conversationId, remaining));
      return;
    }

    const nextConversation = remaining[0] || createConversation();
    const next = remaining.length ? remaining : [nextConversation];
    stopVoiceInput();
    setDraft('');
    setPendingAttachments([]);
    setConversationId(nextConversation.id);
    setMessages(nextConversation.messages);
    setConversationHistory(persistConversationHistory(nextConversation.id, next));
  }

  function clearConversationHistory() {
    if (busy) return;
    const conversation = createConversation();
    stopVoiceInput();
    setDraft('');
    setPendingAttachments([]);
    setAttachmentNotice(null);
    setConversationId(conversation.id);
    setMessages(conversation.messages);
    const result = persistChatState(conversation.id, [conversation]);
    setConversationHistory(result.conversations);
    setHistoryStorageNotice(result.ok ? 'Chat history cleared.' : HISTORY_STORAGE_FULL_NOTICE);
  }

  function persistConversationHistory(activeId: string, conversations: StoredConversation[]) {
    const result = persistChatState(activeId, conversations);
    updateHistoryStorageNotice(result);
    return result.conversations;
  }

  function updateHistoryStorageNotice(result: PersistChatStateResult) {
    if (result.prunedCount > 0) {
      const suffix = result.prunedCount === 1 ? 'chat' : 'chats';
      setHistoryStorageNotice(`Browser history storage was full. Rubberband pruned ${result.prunedCount} older ${suffix}.`);
      return;
    }
    setHistoryStorageNotice(result.ok ? null : HISTORY_STORAGE_FULL_NOTICE);
  }

  function renameToolCall(messageId: string, toolCallId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    setMessages(current =>
      current.map(message => {
        if (message.id !== messageId || !message.toolCalls) return message;
        return {
          ...message,
          toolCalls: message.toolCalls.map(toolCall => (toolCall.id === toolCallId ? { ...toolCall, title: trimmed } : toolCall))
        };
      })
    );
  }

  function recordVizInteraction(messageId: string, toolCallId: string, params: unknown) {
    const event = normalizeVizInteraction(params);
    if (!event) return;

    setMessages(current =>
      current.map(message => {
        if (message.id !== messageId || !message.toolCalls) return message;
        return {
          ...message,
          toolCalls: message.toolCalls.map(toolCall => {
            if (toolCall.id !== toolCallId) return toolCall;
            const existing = toolCall.interactionEvents || [];
            const previous = existing.at(-1);
            if (previous && previous.type === event.type && previous.summary === event.summary) {
              return toolCall;
            }
            return {
              ...toolCall,
              interactionEvents: [...existing, event].slice(-MAX_VIZ_INTERACTIONS_PER_PREVIEW)
            };
          })
        };
      })
    );
    if (event.chatVisible) {
      setProgressMessage(`Captured preview interaction: ${event.summary}`);
    }
  }

  function replaceToolCallResult(messageId: string, toolCallId: string, update: ToolResultUpdate) {
    const embeddedUiResource = readRenderableUiResource(update.toolResult);
    const resourceUri = update.resourceUri || embeddedUiResource?.resourceUri;
    const html = update.html ?? embeddedUiResource?.html;
    if (!resourceUri && html === undefined) return;
    setMessages(current =>
      current.map(message => {
        if (message.id !== messageId || !message.toolCalls) return message;
        return {
          ...message,
          toolCalls: message.toolCalls.map(toolCall => {
            if (toolCall.id !== toolCallId) return toolCall;
            const nextResourceUri = resourceUri || toolCall.resourceUri;
            const shouldReloadRenderer = nextResourceUri !== toolCall.resourceUri || html !== toolCall.html;
            return {
              ...toolCall,
              toolName: update.toolName,
              toolInput: update.toolInput,
              toolResult: update.toolResult,
              resourceUri: nextResourceUri,
              html,
              previewRevision: shouldReloadRenderer ? (toolCall.previewRevision || 0) + 1 : toolCall.previewRevision,
              title: `${toolCall.appId}: ${update.toolName}`
            };
          })
        };
      })
    );
    setProgressMessage(`Updated preview from ${update.toolName}`);
  }

  async function requestVisualizationVariant(toolCall: RenderableToolCall, chartType: string) {
    if (busy) return;
    const prompt = [
      `Regenerate "${toolCall.title}" as a ${chartType}.`,
      'Keep the same analytic intent, data source, filters, and dashboard context where possible.',
      `Use ${toolCall.appId}:${toolCall.toolName} or the best available visualization tool to return an updated preview.`,
      `Original tool input: ${truncateForPrompt(JSON.stringify(toolCall.toolInput), 1600)}`
    ].join('\n');
    const requestMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt, hidden: true };
    await submitMessages([...messages, requestMessage], {
      progressMessage: `Regenerating as ${chartType}`,
      cleanupOnAbortMessageId: requestMessage.id
    });
  }

  async function requestVisualizationSummary(toolCall: RenderableToolCall) {
    if (busy) return;
    const interactions = renderVizInteractionContext(toolCall, MAX_VIZ_INTERACTIONS_FOR_CONTEXT);
    const prompt = [
      `Analyze and summarize the visualization "${toolCall.title}".`,
      'Explain what it is measuring, what the main takeaway appears to be, and call out any caveats or follow-up questions.',
      'Use the available tool result/spec/data rather than inventing values that are not present.',
      interactions ? `Recent visualization interactions:\n${interactions}` : '',
      toolCall.resourceUri ? `Preview resource: ${toolCall.resourceUri}` : '',
      `Original tool input: ${truncateForPrompt(JSON.stringify(toolCall.toolInput), 1600)}`,
      `Tool result context: ${truncateForPrompt(JSON.stringify(toolCall.toolResult), 4200)}`
    ]
      .filter(Boolean)
      .join('\n');
    const requestMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt, hidden: true };
    await submitMessages([...messages, requestMessage], {
      progressMessage: 'Summarizing visualization',
      cleanupOnAbortMessageId: requestMessage.id
    });
  }

  async function submitFollowUp(question: string) {
    if (busy) return;
    const content = question.trim();
    if (!content) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content };
    await submitMessages([...messages, userMessage], { progressMessage: 'Sending follow-up' });
  }

  const visibleMessages = messages.filter(message => !message.hidden);

  return (
    <div className={`shell ${sidebarCollapsed ? 'navCollapsed' : ''}`} style={{ '--chat-scale': chatScale } as React.CSSProperties}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <img src={appUrl('/rubberband-mark.svg')} alt="" />
          </div>
          <div className="brandCopy">
            <div className="brandName">Rubberband</div>
            <div className="brandSub">Connected Intelligence Workspace</div>
          </div>
          <button
            className="iconButton navToggle"
            onClick={() => setSidebarCollapsed(value => !value)}
            title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        <section className="sideSection historySection">
          <div className="historyTitleRow">
            <button className="sectionTitle sectionButton" onClick={() => (sidebarCollapsed ? setSidebarCollapsed(false) : toggleSection('history'))} title={sidebarCollapsed ? 'Expand history' : 'Toggle history'}>
              {!sidebarCollapsed ? (collapsedSections.history ? <ChevronRight size={15} /> : <ChevronDown size={15} />) : null}
              <History size={15} />
              <span>History</span>
            </button>
            {!sidebarCollapsed ? (
              <button className="iconButton historyNewButton" onClick={startNewConversation} disabled={busy} title="New chat" aria-label="New chat">
                <Plus size={15} />
              </button>
            ) : null}
          </div>
          {!sidebarCollapsed && historyStorageNotice ? (
            <div className="historyStorageNotice" role="status">
              <span>{historyStorageNotice}</span>
            </div>
          ) : null}
          {!collapsedSections.history && (
            <div className="historyExpanded">
              <div className="historyList">
                {conversationHistory.map(conversation => (
                  <div className={`historyItem ${conversation.id === conversationId ? 'active' : ''}`} key={conversation.id}>
                    <button className="historyOpen" onClick={() => openConversation(conversation.id)} disabled={busy || conversation.id === conversationId} title={conversation.title}>
                      <span>{conversation.title}</span>
                      <em>{formatConversationTime(conversation.updatedAt)}</em>
                    </button>
                    <button className="historyDelete" onClick={() => deleteConversation(conversation.id)} disabled={busy} title="Delete chat" aria-label={`Delete ${conversation.title}`}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="historyFooter">
                <button type="button" className="historyClearTextButton" onClick={clearConversationHistory} disabled={busy || !conversationHistory.length}>
                  clear all history
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="sideSection">
          <button className="sectionTitle sectionButton" onClick={() => (sidebarCollapsed ? setSidebarCollapsed(false) : toggleSection('apps'))} title={sidebarCollapsed ? 'Expand apps' : 'Toggle apps'}>
            {!sidebarCollapsed ? (collapsedSections.apps ? <ChevronRight size={15} /> : <ChevronDown size={15} />) : null}
            <Boxes size={15} />
            <span>Apps</span>
          </button>
          {!collapsedSections.apps && (
            <div className="appList">
              {apps.map(app => (
                <div className="appItem" key={app.id}>
                  <div className="appTop">
                    <label className="appSelect">
                      <input
                        type="checkbox"
                        checked={selectedAppIds.includes(app.id)}
                        onChange={() => toggleSelectedApp(app.id)}
                      />
                      <span>{app.name}</span>
                    </label>
                    <StatusBadge status={app.status} />
                  </div>
                  {app.description ? <p>{app.description}</p> : null}
                  {app.error ? <p className="errorText">{app.error}</p> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="sideSection toolsSection">
          <button className="sectionTitle sectionButton" onClick={() => (sidebarCollapsed ? setSidebarCollapsed(false) : toggleSection('tools'))} title={sidebarCollapsed ? 'Expand tools' : 'Toggle tools'}>
            {!sidebarCollapsed ? (collapsedSections.tools ? <ChevronRight size={15} /> : <ChevronDown size={15} />) : null}
            <Settings size={15} />
            <span>Tools</span>
            {!sidebarCollapsed ? <em>{selectedToolCount || tools.length}</em> : null}
          </button>
          {!collapsedSections.tools && (
            <div className="toolList">
              {toolsByApp.map(group => (
                <div className={`toolGroup ${group.selected ? 'selected' : ''}`} key={group.appId}>
                  <button className="toolGroupHeader" onClick={() => toggleToolGroup(group.appId)} type="button" aria-expanded={expandedToolAppIds.includes(group.appId)}>
                    <span>
                      {expandedToolAppIds.includes(group.appId) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <strong>{group.appName}</strong>
                    </span>
                    <em>{group.tools.length}</em>
                  </button>
                  {expandedToolAppIds.includes(group.appId) ? (
                    <div className="toolGroupBody">
                      {group.tools.map(tool => (
                        <button
                          className={`toolItem ${selectedToolKey === toolKey(tool) ? 'active' : ''}`}
                          key={toolKey(tool)}
                          onClick={() => selectToolForTest(tool)}
                          title={tool.description || tool.name}
                          type="button"
                          aria-pressed={selectedToolKey === toolKey(tool)}
                        >
                          <div>
                            <span>{formatToolName(tool.name)}</span>
                            {tool.description ? <p>{summarizeToolDescription(tool.description)}</p> : null}
                          </div>
                          {tool._meta?.ui?.resourceUri ? <Activity size={13} /> : <FileText size={13} />}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {!tools.length ? <div className="muted">Tools load after an MCP app connects.</div> : null}
            </div>
          )}
        </section>
      </aside>

      {selectedTool ? (
        <aside className="toolRunnerDrawer" role="dialog" aria-modal="false" aria-label={`Test ${formatToolName(selectedTool.name)}`}>
          <div className="toolRunnerHeader">
            <div>
              <span>Test tool</span>
              <p>{selectedTool.appName}</p>
            </div>
            <button
              className="iconButton"
              onClick={() => {
                setSelectedToolKey(null);
                setToolRunResult(null);
                setToolRunError(null);
              }}
              title="Close tool test"
              aria-label="Close tool test"
              type="button"
            >
              <X size={15} />
            </button>
          </div>
          <div className="toolRunnerBody">
            <div className="toolRunnerMeta">
              <strong>{selectedTool.appName}</strong>
              <code>{selectedTool.name}</code>
            </div>
            {selectedTool.inputSchema ? (
              <details className="toolSchema">
                <summary>Input schema</summary>
                <pre>{formatToolSchema(selectedTool.inputSchema)}</pre>
              </details>
            ) : null}
            <label className="toolRunnerField">
              <span>Arguments JSON</span>
              <textarea value={toolArgsDraft} onChange={event => setToolArgsDraft(event.target.value)} rows={8} aria-label="Arguments JSON" spellCheck={false} />
            </label>
            <button className="toolRunButton" onClick={runSelectedTool} disabled={toolRunning} type="button">
              {toolRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
              <span>{toolRunning ? 'Running' : 'Run tool'}</span>
            </button>
            {toolRunError ? <pre className="toolRunnerOutput errorOutput">{toolRunError}</pre> : null}
            {toolRunResult ? <pre className="toolRunnerOutput">{toolRunResult}</pre> : null}
          </div>
        </aside>
      ) : null}

      <main className="chatPane">
        <div className="topbar">
          <p className="chatContext">{selectedAppSummary()}</p>
          <div className="topbarActions">
            <button className="demoButton" onClick={runLiveDemo} disabled={busy || demoRunning} title="Run live demo" aria-label="Run live demo">
              {demoRunning ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              <span>Demo</span>
            </button>
            <div className="exportMenu" ref={exportMenuRef}>
              <button
                className="exportButton"
                onClick={() => setExportMenuOpen(open => !open)}
                disabled={!visibleMessages.length || Boolean(exportingFormat)}
                title="Export chat"
                aria-label="Export chat"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                {exportingFormat ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                <span>Export</span>
                <ChevronDown size={14} />
              </button>
              {exportMenuOpen ? (
                <div className="exportMenuPanel" role="menu">
                  <button type="button" role="menuitem" onClick={() => exportChat('markdown')}>
                    <FileText size={15} />
                    <span>GitHub Markdown ZIP</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => exportChat('docx')}>
                    <FileText size={15} />
                    <span>DOCX</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => exportChat('pdf')}>
                    <FileText size={15} />
                    <span>PDF</span>
                  </button>
                </div>
              ) : null}
            </div>
            <button className="iconButton" onClick={() => setSettingsOpen(true)} title="Settings">
              <Settings size={18} />
            </button>
            <button className="iconButton" onClick={reloadAppsAndTools} disabled={refreshingApps} title="Reload MCP apps and tools" aria-label="Reload MCP apps and tools">
              {refreshingApps ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
            </button>
          </div>
        </div>

        <div className="messages">
          {visibleMessages.map(message => {
            const messageIndex = messages.findIndex(item => item.id === message.id);
            const canRetry = message.role === 'user' || messages.slice(0, messageIndex).some(item => item.role === 'user');
            return (
            <MessageBubble
              key={message.id}
              message={message}
              canRetry={canRetry}
              busy={busy}
              copied={copiedMessageId === message.id}
              onEdit={editUserMessage}
              onRetry={retryFromMessage}
              onCopy={copyMessage}
              onRenameToolCall={renameToolCall}
              onVizInteraction={recordVizInteraction}
              onToolResultUpdate={replaceToolCallResult}
              onVizHelper={requestVisualizationVariant}
              onVizSummary={requestVisualizationSummary}
              onFollowUp={submitFollowUp}
            />
            );
          })}
          {busy ? (
            <div className="message assistant">
              <div className="avatar">
                <Bot size={17} />
              </div>
              <div className={`bubble pending ${progressExpanded ? 'expanded' : ''}`}>
                <Loader2 size={17} className="spin" />
                {progressCanExpand ? (
                  <button
                    className="pendingExpand"
                    type="button"
                    onClick={() => setProgressExpanded(value => !value)}
                    title={progressExpanded ? 'Collapse status' : 'Expand status'}
                    aria-label={progressExpanded ? 'Collapse status' : 'Expand status'}
                    aria-expanded={progressExpanded}
                  >
                    {progressExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : null}
                <span className="pendingText" title={progressMessage}>{progressMessage}</span>
                <button className="pendingCancel" onClick={cancelActiveRequest} title="Cancel request" aria-label="Cancel request">
                  <X size={14} />
                </button>
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        {error ? <ErrorExplainer error={error} /> : null}

        <div className="composer" onDragOver={event => event.preventDefault()} onDrop={handleComposerDrop}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hiddenFileInput"
            onChange={event => {
              void addAttachmentFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />
          {pendingAttachments.length ? (
            <div className="attachmentTray" aria-label="Pending image attachments">
              {pendingAttachments.map(attachment => (
                <div className="attachmentChip" key={attachment.id}>
                  <img src={attachment.dataUrl} alt={attachment.name} />
                  <span title={attachment.name}>{attachment.name}</span>
                  <button onClick={() => removePendingAttachment(attachment.id)} type="button" title={`Remove ${attachment.name}`} aria-label={`Remove ${attachment.name}`}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {attachmentNotice ? <div className="attachmentNotice">{attachmentNotice}</div> : null}
          <div className="composerModes" aria-label="Chat mode">
            <button
              type="button"
              className={`modeSwitch ${deepAnalysis ? 'active' : ''}`}
              onClick={() => setDeepAnalysis(current => !current)}
              role="switch"
              aria-checked={deepAnalysis}
              aria-pressed={deepAnalysis}
              title="Use Deep Agents for bounded read-only analysis"
            >
              <span className="switchTrack" aria-hidden="true">
                <span className="switchThumb" />
              </span>
              <span>Deep Analysis</span>
            </button>
            <button
              type="button"
              className="modeHelpButton"
              aria-label="Deep Analysis help"
              title="Deep Analysis can improve ambiguous, multi-step, or investigative analytics prompts by planning before tool use. Leave it off for direct chart, dashboard, or exact-tool requests where normal chat is faster and more direct."
            >
              <Info size={14} />
            </button>
          </div>
          <button className="attachButton" onClick={() => fileInputRef.current?.click()} disabled={busy || pendingAttachments.length >= MAX_CHAT_ATTACHMENTS} title="Attach image" aria-label="Attach image" type="button">
            <Paperclip size={18} />
          </button>
          <button
            className={`voiceButton ${voiceListening ? 'listening' : ''}`}
            onClick={toggleVoiceInput}
            disabled={busy}
            title={voiceListening ? 'Stop voice input' : 'Start voice input'}
            aria-label={voiceListening ? 'Stop voice input' : 'Start voice input'}
            aria-pressed={voiceListening}
            type="button"
          >
            <Mic size={18} />
          </button>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onPaste={event => {
              void handleComposerPaste(event);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Ask for a dashboard, SQL chart, or analytics preview..."
            rows={2}
          />
          <button className="sendButton" onClick={sendMessage} disabled={busy || (!draft.trim() && !pendingAttachments.length)} title="Send">
            {busy ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
          </button>
        </div>
      </main>
      {settingsOpen ? (
        <SettingsDrawer
          snapshot={settingsSnapshot}
          values={settingsValues}
          saving={settingsSaving}
          notice={settingsNotice}
          aboutInfo={aboutInfo}
          analyticsProfile={analyticsProfile}
          analyticsProfileLoading={analyticsProfileLoading}
          analyticsProfileRefreshing={analyticsProfileRefreshing}
          testingTarget={testingConnection}
          testResults={connectionTestResults}
          onClose={() => setSettingsOpen(false)}
          onChange={(key, value) => setSettingsValues(current => ({ ...current, [key]: value }))}
          onResetGroup={resetSettingsGroup}
          onSave={saveSettings}
          onRefreshAnalyticsProfile={() => loadAnalyticsProfileStatus()}
          onRunAnalyticsProfile={runAnalyticsProfileRefresh}
          onTestConnection={testConnection}
          chatScale={chatScale}
          onChatScaleChange={setChatScale}
        />
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  canRetry,
  busy,
  copied,
  onEdit,
  onRetry,
  onCopy,
  onRenameToolCall,
  onVizInteraction,
  onToolResultUpdate,
  onVizHelper,
  onVizSummary,
  onFollowUp
}: {
  message: ChatMessage;
  canRetry: boolean;
  busy: boolean;
  copied: boolean;
  onEdit: (messageId: string) => void;
  onRetry: (messageId: string) => void;
  onCopy: (message: ChatMessage) => void;
  onRenameToolCall: (messageId: string, toolCallId: string, title: string) => void;
  onVizInteraction: (messageId: string, toolCallId: string, params: unknown) => void;
  onToolResultUpdate: (messageId: string, toolCallId: string, update: ToolResultUpdate) => void;
  onVizHelper: (toolCall: RenderableToolCall, chartType: string) => void;
  onVizSummary: (toolCall: RenderableToolCall) => void;
  onFollowUp: (question: string) => void;
}) {
  const isUser = message.role === 'user';
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="avatar">{isUser ? <User size={17} /> : <Bot size={17} />}</div>
      <div className="messageContent">
        <div className={`bubble ${collapsed ? 'collapsed' : ''}`}>
          <div className="bubbleBody">
            {isUser && message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
            {isUser ? <div className="plainText">{message.content}</div> : <MarkdownMessage content={message.content} />}
          </div>
          <div className="bubbleActions">
            {!isUser && message.usage ? (
              <span className="tokenUsage" aria-label="Token usage" title={formatTokenUsageTitle(message.usage)}>
                {formatTokenUsageBadge(message.usage)}
              </span>
            ) : null}
            <button
              className="bubbleAction"
              onClick={() => setCollapsed(value => !value)}
              title={collapsed ? 'Expand message' : 'Collapse message'}
              aria-label={collapsed ? 'Expand message' : 'Collapse message'}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              <span>{collapsed ? 'Expand' : 'Collapse'}</span>
            </button>
            <button className="bubbleAction" onClick={() => onCopy(message)} title="Copy message">
              {copied ? <Check size={14} /> : <Clipboard size={14} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            {isUser ? (
              <button className="bubbleAction" onClick={() => onEdit(message.id)} disabled={busy} title="Edit message">
                <Pencil size={14} />
                <span>Edit</span>
              </button>
            ) : null}
            {canRetry ? (
              <button className="bubbleAction" onClick={() => onRetry(message.id)} disabled={busy} title={isUser ? 'Retry from this message' : 'Retry response'}>
                <RotateCcw size={14} />
                <span>Retry</span>
              </button>
            ) : null}
          </div>
        </div>
        {!collapsed
          ? message.toolCalls?.map(toolCall => (
              <McpAppFrame
                key={toolCall.id}
                toolCall={toolCall}
                busy={busy}
                onRename={title => onRenameToolCall(message.id, toolCall.id, title)}
                onVizInteraction={params => onVizInteraction(message.id, toolCall.id, params)}
                onToolResultUpdate={update => onToolResultUpdate(message.id, toolCall.id, update)}
                onVizHelper={chartType => onVizHelper(toolCall, chartType)}
                onVizSummary={() => onVizSummary(toolCall)}
              />
            ))
          : null}
        {!collapsed && !isUser && message.followUps?.length ? (
          <div className="followUpChips" aria-label="Suggested follow-up questions">
            {message.followUps.map(question => (
              <button key={question} onClick={() => onFollowUp(question)} disabled={busy} type="button">
                {question}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const images = attachments.filter(attachment => attachment.dataUrl);
  if (!images.length) return null;
  return (
    <div className="messageAttachments" aria-label="Image attachments">
      {images.map(attachment => (
        <a href={attachment.dataUrl} target="_blank" rel="noreferrer" key={attachment.id} title={attachment.name}>
          <img src={attachment.dataUrl} alt={attachment.name} />
          <span>
            <ImageIcon size={13} />
            {attachment.name}
          </span>
        </a>
      ))}
    </div>
  );
}

function SettingsDrawer({
  snapshot,
  values,
  saving,
  notice,
  aboutInfo,
  analyticsProfile,
  analyticsProfileLoading,
  analyticsProfileRefreshing,
  testingTarget,
  testResults,
  onClose,
  onChange,
  onResetGroup,
  onSave,
  onRefreshAnalyticsProfile,
  onRunAnalyticsProfile,
  onTestConnection,
  chatScale,
  onChatScaleChange
}: {
  snapshot: SettingsSnapshot;
  values: Record<string, string>;
  saving: boolean;
  notice: string | null;
  aboutInfo: AboutInfo | null;
  analyticsProfile: AnalyticsProfileSnapshot | null;
  analyticsProfileLoading: boolean;
  analyticsProfileRefreshing: boolean;
  testingTarget: ConnectionTestTarget | null;
  testResults: Partial<Record<ConnectionTestTarget, ConnectionTestResult>>;
  onClose: () => void;
  onChange: (key: string, value: string) => void;
  onResetGroup: (group: SettingField['group']) => void;
  onSave: () => void;
  onRefreshAnalyticsProfile: () => void;
  onRunAnalyticsProfile: () => void;
  onTestConnection: (target: ConnectionTestTarget) => void;
  chatScale: number;
  onChatScaleChange: (value: number) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    about: true,
    ui: true,
    llm: true,
    elastic: true,
    kibana: true,
    trino: true,
    viz: true,
    domain: true,
    mcp: true,
    profiler: true,
    advanced: true
  });
  const groups: Array<{ id: SettingField['group']; title: string; icon: React.ReactNode; tests?: Array<{ target: ConnectionTestTarget; label: string }> }> = [
    { id: 'llm', title: 'LLM', icon: <KeyRound size={15} />, tests: [{ target: 'llm', label: 'Test LLM' }] },
    { id: 'elastic', title: 'Elasticsearch', icon: <Database size={15} />, tests: [{ target: 'elastic', label: 'Test Elastic' }] },
    { id: 'kibana', title: 'Kibana', icon: <Boxes size={15} />, tests: [{ target: 'kibana', label: 'Test Kibana' }] },
    {
      id: 'trino',
      title: 'Trino / Starburst',
      icon: <Table2 size={15} />,
      tests: [
        { target: 'trino', label: 'Test Trino' },
        { target: 'starburst', label: 'Test Starburst' }
      ]
    },
    { id: 'viz', title: 'Visualization Contract', icon: <BarChart3 size={15} /> },
    { id: 'domain', title: 'Domain Knowledge', icon: <FileText size={15} /> },
    { id: 'mcp', title: 'MCP Apps', icon: <Boxes size={15} /> },
    { id: 'advanced', title: 'Advanced', icon: <ShieldAlert size={15} /> }
  ];
  const profilerFields = snapshot.fields.filter(field => field.group === 'profiler');
  const canResetProfiler = profilerFields.some(field => !field.locked);
  const renderSettingField = (field: SettingField) => (
    <label className="field" key={field.key}>
      <span>
        {field.label}
        {field.locked ? <em>locked by env</em> : null}
      </span>
      {field.type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={values[field.key] === 'true'}
          disabled={field.locked}
          onChange={event => onChange(field.key, String(event.target.checked))}
        />
      ) : field.type === 'textarea' ? (
        <textarea
          value={field.locked && field.sensitive ? '' : values[field.key] || ''}
          disabled={field.locked}
          placeholder={settingPlaceholder(field)}
          rows={7}
          onChange={event => onChange(field.key, event.target.value)}
        />
      ) : (
        <input
          type={field.type}
          value={field.locked && (field.type === 'password' || field.sensitive) ? '' : values[field.key] || ''}
          disabled={field.locked}
          placeholder={field.locked && field.hasValue ? 'Configured outside UI' : ''}
          onChange={event => onChange(field.key, event.target.value)}
        />
      )}
    </label>
  );

  return (
    <div className="settingsOverlay" role="dialog" aria-modal="true">
      <div className="settingsPanel">
        <div className="settingsHeader">
          <div>
            <h2>Settings</h2>
            <p>Runtime values apply immediately unless the field is locked by `.env` or process env.</p>
          </div>
          <button className="iconButton" onClick={onClose} title="Close settings">
            <X size={18} />
          </button>
        </div>

        <div className="settingsBody">
          <section className="settingsGroup aboutSettingsGroup">
            <div className="settingsGroupHeader">
              <button
                className="sectionTitle sectionButton settingsGroupTitle"
                onClick={() => setCollapsed(current => ({ ...current, about: !current.about }))}
                title="Toggle About"
              >
                {collapsed.about ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <Info size={15} />
                <span>About</span>
              </button>
            </div>
            {!collapsed.about && <AboutSettings info={aboutInfo} />}
          </section>
          <section className="settingsGroup">
            <div className="settingsGroupHeader">
              <button
                className="sectionTitle sectionButton settingsGroupTitle"
                onClick={() => setCollapsed(current => ({ ...current, ui: !current.ui }))}
                title="Toggle UI"
              >
                {collapsed.ui ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <Settings size={15} />
                <span>UI</span>
              </button>
              <button
                type="button"
                className="iconButton settingsResetButton"
                onClick={() => onChatScaleChange(1)}
                title="Reset UI defaults"
                aria-label="Reset UI defaults"
              >
                <RotateCcw size={14} />
              </button>
            </div>
            {!collapsed.ui && (
              <div className="settingsFields">
                <label className="field">
                  <span>
                    Chat text size
                    <em>{Math.round(chatScale * 100)}%</em>
                  </span>
                  <input
                    type="range"
                    min="0.75"
                    max="1.15"
                    step="0.05"
                    value={chatScale}
                    onChange={event => onChatScaleChange(Number(event.target.value))}
                  />
                </label>
              </div>
            )}
          </section>
          <section className="settingsGroup profilerSettingsGroup">
            <div className="settingsGroupHeader">
              <button
                className="sectionTitle sectionButton settingsGroupTitle"
                onClick={() => setCollapsed(current => ({ ...current, profiler: !current.profiler }))}
                title="Toggle Analytics Profiler"
              >
                {collapsed.profiler ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <Activity size={15} />
                <span>Analytics Profiler</span>
              </button>
              <button
                type="button"
                className="iconButton settingsResetButton"
                onClick={() => onResetGroup('profiler')}
                disabled={!canResetProfiler}
                title="Reset Analytics Profiler defaults"
                aria-label="Reset Analytics Profiler defaults"
              >
                <RotateCcw size={14} />
              </button>
              <div className="profilerActions">
                <button
                  type="button"
                  className="connectionTestButton"
                  onClick={onRefreshAnalyticsProfile}
                  disabled={analyticsProfileLoading || analyticsProfileRefreshing}
                  title="Refresh profiler status"
                  aria-label="Refresh profiler status"
                >
                  {analyticsProfileLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                  <span>Status</span>
                </button>
                <button
                  type="button"
                  className="connectionTestButton"
                  onClick={onRunAnalyticsProfile}
                  disabled={analyticsProfileRefreshing || analyticsProfileLoading || !analyticsProfile?.enabled}
                  title="Run profiler now"
                  aria-label="Run profiler now"
                >
                  {analyticsProfileRefreshing ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                  <span>Run</span>
                </button>
              </div>
            </div>
            {!collapsed.profiler && (
              <div className="profilerBody">
                <ProfilerOverview snapshot={analyticsProfile} loading={analyticsProfileLoading} refreshing={analyticsProfileRefreshing} />
                <div className="profilerTargets">
                  <ProfilerTargetStatus title="Elasticsearch" entry={analyticsProfile?.elastic} />
                  <ProfilerTargetStatus title="Trino / Starburst" entry={analyticsProfile?.trino} />
                </div>
                {profilerFields.length ? <div className="settingsFields profilerFields">{profilerFields.map(field => renderSettingField(field))}</div> : null}
              </div>
            )}
          </section>
          {groups.map(group => {
            const fields = snapshot.fields.filter(field => field.group === group.id);
            const canReset = fields.some(field => !field.locked);
            return (
              <section className="settingsGroup" key={group.id}>
                <div className="settingsGroupHeader">
                  <button
                    className="sectionTitle sectionButton settingsGroupTitle"
                    onClick={() => setCollapsed(current => ({ ...current, [group.id]: !current[group.id] }))}
                    title={`Toggle ${group.title}`}
                  >
                    {collapsed[group.id] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    {group.icon}
                    <span>{group.title}</span>
                  </button>
                  <button
                    type="button"
                    className="iconButton settingsResetButton"
                    onClick={() => onResetGroup(group.id)}
                    disabled={!canReset}
                    title={`Reset ${group.title} defaults`}
                    aria-label={`Reset ${group.title} defaults`}
                  >
                    <RotateCcw size={14} />
                  </button>
                  {group.tests?.length ? (
                    <div className="connectionTestActions">
                      {group.tests.map(test => {
                        const result = testResults[test.target];
                        const busy = testingTarget === test.target;
                        return (
                          <button
                            type="button"
                            key={test.target}
                            className={`connectionTestButton ${result ? (result.ok ? 'success' : 'error') : ''}`}
                            onClick={() => onTestConnection(test.target)}
                            disabled={Boolean(testingTarget)}
                            title={`${test.label} connection`}
                            aria-label={`${test.label} connection`}
                          >
                            {busy ? <Loader2 size={13} className="spin" /> : result ? result.ok ? <Check size={13} /> : <ShieldAlert size={13} /> : <Play size={13} />}
                            <span>{test.label.replace('Test ', '')}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                {group.tests?.map(test => {
                  const result = testResults[test.target];
                  return result ? (
                    <div className={`connectionTestResult ${result.ok ? 'success' : 'error'}`} role="status" key={test.target}>
                      <strong>{result.label}</strong>
                      <span>{result.message}</span>
                      <em>{result.durationMs} ms</em>
                    </div>
                  ) : null;
                })}
                {!collapsed[group.id] && (
                  <div className="settingsFields">
                    {fields.map(field => renderSettingField(field))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {notice ? <div className="settingsNotice">{notice}</div> : null}

        <div className="settingsFooter">
          <button className="secondaryButton" onClick={onClose}>
            Close
          </button>
          <button className="primaryButton" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={17} className="spin" /> : <Save size={17} />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function settingPlaceholder(field: SettingField) {
  if (field.locked && field.hasValue && (field.sensitive || field.type === 'password')) return 'Configured outside UI';
  if (field.locked) return '';
  const placeholders: Record<string, string> = {
    OPENAI_EXTRA_HEADERS: '{\n  "X-Provider-Route": "analytics"\n}',
    OPENAI_EXTRA_BODY: '{\n  "metadata": { "app": "rubberband" }\n}',
    ELASTIC_CCS_INDEX_PATTERNS: 'remote-prod*, analytics-remote:logs-*',
    CLUSTERS_JSON: '[\n  {\n    "name": "primary",\n    "elasticsearchUrl": "https://es.example.local",\n    "kibanaUrl": "https://kb.example.local",\n    "elasticsearchApiKey": "encoded-key"\n  }\n]',
    CLUSTERS_FILE: '/absolute/path/to/clusters.json',
    TRINO_CA_CERT: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
    TRINO_CLIENT_CERT: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
    TRINO_CLIENT_KEY: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
    DOMAIN_KNOWLEDGE: 'Example: orders contains commerce events. order_date is the timestamp. status is fulfillment state. total_amount is revenue.',
    MCP_ENABLED_APPS: 'dashbuilder, security, observability, mcp-app-trino',
    MCP_DISABLED_APPS: 'experimental-*',
    MCP_ENABLED_TOOLS: 'dashbuilder:*, mcp-app-trino:query, mcp-app-trino:visualize_*',
    MCP_DISABLED_TOOLS: 'security:close_case, mcp-app-trino:drop_*',
    MCP_READ_ONLY_TOOL_ALLOWLIST: 'dashbuilder:create_chart'
  };
  return placeholders[field.key] || '';
}

function AboutSettings({ info }: { info: AboutInfo | null }) {
  const rows = info
    ? [
        { label: 'Version', value: info.version },
        { label: 'Package', value: info.packageName },
        { label: 'License', value: info.license || 'Unknown' },
        { label: 'Build time', value: formatDateTime(info.build.builtAt) },
        { label: 'Build commit', value: info.build.shortCommit || 'Unknown' },
        { label: 'Branch', value: info.build.branch || 'Unknown' },
        { label: 'Node runtime', value: info.build.node || 'Unknown' }
      ]
    : [
        { label: 'Version', value: 'Loading' },
        { label: 'Build', value: 'Loading' }
      ];

  return (
    <div className="aboutSettingsBody">
      <div className="aboutAppSummary">
        <img src={appUrl('/rubberband-mark.svg')} alt="" />
        <div>
          <h3>{info?.name || 'Rubberband'}</h3>
          <p>{info?.description || 'Connected Intelligence Workspace'}</p>
        </div>
      </div>
      <dl className="aboutMetaGrid">
        {rows.map(row => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd title={row.value}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ProfilerOverview({
  snapshot,
  loading,
  refreshing
}: {
  snapshot: AnalyticsProfileSnapshot | null;
  loading: boolean;
  refreshing: boolean;
}) {
  if (!snapshot) {
    return (
      <div className="profilerOverview" role="status">
        <span className="profilerBadge neutral">{loading ? 'Loading' : 'Unavailable'}</span>
      </div>
    );
  }

  const running = refreshing || snapshot.running;
  return (
    <div className="profilerOverview" aria-label="Profiler summary">
      <span className={`profilerBadge ${snapshot.enabled ? 'success' : 'neutral'}`}>{snapshot.enabled ? 'Enabled' : 'Disabled'}</span>
      <span className={`profilerBadge ${running ? 'running' : 'neutral'}`}>{running ? 'Running' : 'Idle'}</span>
      <span className="profilerMetaItem">
        <strong>Schedule</strong>
        {formatDuration(snapshot.scheduleMs)}
      </span>
      <span className="profilerMetaItem">
        <strong>Stale after</strong>
        {formatDuration(snapshot.staleAfterMs)}
      </span>
    </div>
  );
}

function ProfilerTargetStatus({ title, entry }: { title: string; entry?: AnalyticsProfileEntry }) {
  if (!entry) {
    return (
      <section className="profilerTarget" aria-label={`${title} profiler status`}>
        <div className="profilerTargetHeader">
          <h3>{title}</h3>
          <span className="profilerBadge neutral">Loading</span>
        </div>
      </section>
    );
  }

  const metrics = profilerMetricRows(entry);
  return (
    <section className="profilerTarget" aria-label={`${title} profiler status`}>
      <div className="profilerTargetHeader">
        <h3>{title}</h3>
        <span className={`profilerBadge ${profilerStatusClass(entry.status)}`}>{formatProfilerStatus(entry.status)}</span>
      </div>
      <dl className="profilerMetaGrid">
        <div>
          <dt>Runs</dt>
          <dd>{formatNumber(entry.runCount)}</dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{formatDateTime(entry.lastSuccessfulAt)}</dd>
        </div>
        <div>
          <dt>Last completed</dt>
          <dd>{formatDateTime(entry.lastCompletedAt)}</dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>{formatDateTime(entry.nextRunAt)}</dd>
        </div>
        {metrics.map(metric => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
      {entry.error ? <p className="profilerError">{entry.error}</p> : null}
    </section>
  );
}

function McpAppFrame({
  toolCall,
  busy,
  onRename,
  onVizInteraction,
  onToolResultUpdate,
  onVizHelper,
  onVizSummary
}: {
  toolCall: RenderableToolCall;
  busy: boolean;
  onRename: (title: string) => void;
  onVizInteraction: (params: unknown) => void;
  onToolResultUpdate: (update: ToolResultUpdate) => void;
  onVizHelper: (chartType: string) => void;
  onVizSummary: () => void;
}) {
  const [height, setHeight] = useState(620);
  const [expanded, setExpanded] = useState(false);
  const [fitToFrame, setFitToFrame] = useState(true);
  const [showVizHelpers, setShowVizHelpers] = useState(false);
  const [previewPanMode, setPreviewPanMode] = useState(false);
  const [previewView, setPreviewView] = useState({ x: 0, y: 0, scale: 1 });
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(toolCall.title);
  const onToolResultUpdateRef = useRef(onToolResultUpdate);
  const sizeChangeTimeoutRef = useRef<number | null>(null);
  const previewPanRef = useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const proxy = useMemo(
    () =>
      createBrowserMcpProxy(toolCall.appId, update => {
        const embeddedUiResource = readRenderableUiResource(update.toolResult);
        const resourceUri = update.resourceUri || embeddedUiResource?.resourceUri;
        const html = update.html ?? embeddedUiResource?.html;
        if (!resourceUri && html === undefined) return;
        window.setTimeout(() => {
          onToolResultUpdateRef.current({ ...update, resourceUri, html });
        }, 0);
      }),
    [toolCall.appId]
  );
  const sandboxUrl = useMemo(() => new URL(appUrl('/sandbox_proxy.html'), window.location.origin), []);
  const sandbox = useMemo(() => ({ url: sandboxUrl }), [sandboxUrl]);
  const catalogMapResult = readTrinoCatalogMapResult(toolCall.toolResult);

  useEffect(() => {
    onToolResultUpdateRef.current = onToolResultUpdate;
  }, [onToolResultUpdate]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  useEffect(() => {
    setDraftTitle(toolCall.title);
  }, [toolCall.title]);

  useEffect(() => {
    setPreviewPanMode(false);
    setPreviewView({ x: 0, y: 0, scale: 1 });
  }, [toolCall.id, toolCall.previewRevision]);

  useEffect(() => {
    return () => {
      if (sizeChangeTimeoutRef.current) window.clearTimeout(sizeChangeTimeoutRef.current);
    };
  }, []);

  const handleSizeChanged = useCallback((params: unknown) => {
    if (expanded) return;
    const nextHeight = Number((params as { height?: unknown }).height);
    if (!Number.isFinite(nextHeight)) return;
    const boundedHeight = Math.max(420, Math.min(nextHeight, 1100));
    if (sizeChangeTimeoutRef.current) window.clearTimeout(sizeChangeTimeoutRef.current);
    sizeChangeTimeoutRef.current = window.setTimeout(() => {
      setHeight(current => (Math.abs(current - boundedHeight) < 24 ? current : boundedHeight));
      sizeChangeTimeoutRef.current = null;
    }, 160);
  }, [expanded]);

  const handleOpenLink = useCallback(async ({ url }: { url: string }) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return { isError: false };
  }, []);

  const handleMessage = useCallback(async (params: unknown) => {
    onVizInteraction(params);
    return { isError: false };
  }, [onVizInteraction]);

  const handleRendererError = useCallback((err: unknown) => {
    console.error(err);
  }, []);

  function saveTitle() {
    onRename(draftTitle);
    setEditingTitle(false);
  }

  function zoomPreview(direction: 'in' | 'out') {
    setPreviewView(current => ({
      ...current,
      scale: direction === 'in' ? Math.min(3, current.scale * 1.18) : Math.max(0.35, current.scale / 1.18)
    }));
  }

  function resetPreviewView() {
    setPreviewView({ x: 0, y: 0, scale: 1 });
  }

  function onPreviewWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!previewPanMode) return;
    event.preventDefault();
    const nextScale = event.deltaY < 0 ? Math.min(3, previewView.scale * 1.08) : Math.max(0.35, previewView.scale / 1.08);
    setPreviewView(current => ({ ...current, scale: nextScale }));
  }

  function onPreviewPanPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!previewPanMode || event.button !== 0) return;
    event.preventDefault();
    previewPanRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: previewView.x, viewY: previewView.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPreviewPanPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = previewPanRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPreviewView(current => ({
      ...current,
      x: drag.viewX + event.clientX - drag.startX,
      y: drag.viewY + event.clientY - drag.startY
    }));
  }

  function stopPreviewPan(event: React.PointerEvent<HTMLDivElement>) {
    if (previewPanRef.current?.pointerId === event.pointerId) previewPanRef.current = null;
  }

  return (
    <div className={`appFrame ${expanded ? 'expanded' : ''}`} data-export-tool-call-id={toolCall.id}>
      <div className="appFrameHeader">
        <div className="appFrameTitle">
          {editingTitle ? (
            <input
              value={draftTitle}
              onChange={event => setDraftTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={event => {
                if (event.key === 'Enter') saveTitle();
                if (event.key === 'Escape') {
                  setDraftTitle(toolCall.title);
                  setEditingTitle(false);
                }
              }}
              autoFocus
            />
          ) : (
            <span>{toolCall.title}</span>
          )}
          {toolCall.resourceUri ? <code>{toolCall.resourceUri}</code> : null}
        </div>
        <div className="appFrameActions">
          <button
            className={`iconButton appFrameButton ${showVizHelpers ? 'active' : ''}`}
            onClick={() => setShowVizHelpers(value => !value)}
            title={showVizHelpers ? 'Hide preview tools' : 'Show preview tools'}
            aria-label={showVizHelpers ? 'Hide preview tools' : 'Show preview tools'}
            aria-expanded={showVizHelpers}
          >
            <Settings size={15} />
          </button>
          <button className="iconButton appFrameButton" onClick={() => setEditingTitle(true)} title="Rename preview" aria-label="Rename preview">
            <Pencil size={15} />
          </button>
          <button
            className="iconButton appFrameButton"
            onClick={() => setExpanded(value => !value)}
            title={expanded ? 'Exit expanded review' : 'Expand review'}
            aria-label={expanded ? 'Exit expanded review' : 'Expand review'}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      {showVizHelpers ? (
        <div className="vizHelperBar" aria-label="Visualization helpers">
          <button onClick={onVizSummary} disabled={busy} title="Summarize visualization" aria-label="Summarize visualization">
            <FileText size={14} />
            Summary
          </button>
          <button onClick={() => setHeight(480)} title="Use compact preview height" aria-label="Use compact preview height">Compact</button>
          <button onClick={() => setHeight(720)} title="Use tall preview height" aria-label="Use tall preview height">Tall</button>
          <button
            className={fitToFrame ? 'active' : ''}
            onClick={() => setFitToFrame(value => !value)}
            title={fitToFrame ? 'Use native preview scale' : 'Fit preview to review area'}
            aria-label={fitToFrame ? 'Use native preview scale' : 'Fit preview to review area'}
          >
            <ZoomIn size={14} />
            Fit
          </button>
          {!catalogMapResult ? (
            <>
              <button
                className={previewPanMode ? 'active' : ''}
                onClick={() => setPreviewPanMode(value => !value)}
                title={previewPanMode ? 'Disable preview pan and zoom' : 'Enable preview pan and zoom'}
                aria-label={previewPanMode ? 'Disable preview pan and zoom' : 'Enable preview pan and zoom'}
              >
                <Move size={14} />
                Pan
              </button>
              <button onClick={() => zoomPreview('out')} title="Zoom preview out" aria-label="Zoom preview out">
                <ZoomOut size={14} />
              </button>
              <button onClick={() => zoomPreview('in')} title="Zoom preview in" aria-label="Zoom preview in">
                <ZoomIn size={14} />
              </button>
              <button onClick={resetPreviewView} title="Reset preview pan and zoom" aria-label="Reset preview pan and zoom">
                <RotateCcw size={14} />
              </button>
            </>
          ) : null}
          <button onClick={() => onVizHelper('bar chart')} disabled={busy} title="Regenerate as a bar chart" aria-label="Regenerate as a bar chart">
            <BarChart3 size={14} />
            Bar
          </button>
          <button onClick={() => onVizHelper('line chart')} disabled={busy} title="Regenerate as a line chart" aria-label="Regenerate as a line chart">
            <Activity size={14} />
            Line
          </button>
          <button onClick={() => onVizHelper('metric visualization')} disabled={busy} title="Regenerate as a metric visualization" aria-label="Regenerate as a metric visualization">
            <BarChart3 size={14} />
            Metric
          </button>
          <button onClick={() => onVizHelper('graph visualization')} disabled={busy} title="Regenerate as a graph visualization" aria-label="Regenerate as a graph visualization">
            <GitBranch size={14} />
            Graph
          </button>
          <button onClick={() => onVizHelper('data table')} disabled={busy} title="Regenerate as a data table" aria-label="Regenerate as a data table">
            <Table2 size={14} />
            Table
          </button>
        </div>
      ) : null}
      {toolCall.interactionEvents?.length ? (
        <div className="vizInteractionTrace" aria-label="Recent visualization interactions">
          <span>Recent</span>
          {toolCall.interactionEvents.slice(-3).map(event => (
            <code key={event.id} title={event.at}>
              {event.summary}
            </code>
          ))}
        </div>
      ) : null}
      <div className={`renderer ${expanded && fitToFrame ? 'fitToFrame' : ''}`} style={{ height: expanded ? undefined : height }}>
        {catalogMapResult ? (
          <TrinoCatalogMapPreview result={catalogMapResult} />
        ) : (
          <div className={`previewViewport ${previewPanMode ? 'panMode' : ''}`} onWheel={onPreviewWheel}>
            <div
              className="previewStage"
              style={{ transform: `translate(${previewView.x}px, ${previewView.y}px) scale(${previewView.scale})` }}
            >
              <AppRenderer
                key={`${toolCall.id}:${toolCall.previewRevision || 0}`}
                toolName={toolCall.toolName}
                toolResourceUri={toolCall.resourceUri}
                html={toolCall.html}
                sandbox={sandbox}
                toolInput={toolCall.toolInput}
                toolResult={toolCall.toolResult as never}
                onCallTool={proxy.callTool as never}
                onReadResource={proxy.readResource as never}
                onListResources={proxy.listResources as never}
                onListResourceTemplates={proxy.listResourceTemplates as never}
                onListPrompts={proxy.listPrompts as never}
                onSizeChanged={handleSizeChanged}
                onOpenLink={handleOpenLink}
                onMessage={handleMessage}
                onError={handleRendererError}
              />
            </div>
            {previewPanMode ? (
              <div
                className="previewPanOverlay"
                aria-label="Preview pan surface"
                onPointerDown={onPreviewPanPointerDown}
                onPointerMove={onPreviewPanPointerMove}
                onPointerUp={stopPreviewPan}
                onPointerCancel={stopPreviewPan}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function TrinoCatalogMapPreview({ result }: { result: TrinoCatalogMapResult }) {
  const catalogs = result.map.catalogs;
  const links = result.map.links;
  const initialPositions = useMemo(() => computeCatalogPositions(catalogs.map(catalog => catalog.id)), [catalogs]);
  const [positions, setPositions] = useState(initialPositions);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ kind: 'node'; id: string } | { kind: 'pan'; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tableCount = catalogs.reduce((sum, catalog) => sum + catalog.tableCount, 0);

  useEffect(() => {
    setPositions(initialPositions);
    setView({ x: 0, y: 0, scale: 1 });
  }, [initialPositions]);

  function svgPoint(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: point.x, y: point.y };
    const transformed = point.matrixTransform(matrix.inverse());
    return {
      x: (transformed.x - view.x) / view.scale,
      y: (transformed.y - view.y) / view.scale
    };
  }

  function onNodePointerDown(event: React.PointerEvent<SVGGElement>, id: string) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind: 'node', id };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    dragRef.current = { kind: 'pan', x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'node') {
      const point = svgPoint(event);
      setPositions(current => new Map(current).set(drag.id, { x: Math.max(60, Math.min(840, point.x)), y: Math.max(60, Math.min(360, point.y)) }));
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  function stopDrag(event: React.PointerEvent<SVGSVGElement | SVGGElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: React.WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const nextScale = Math.max(0.45, Math.min(2.8, view.scale * (event.deltaY < 0 ? 1.1 : 0.9)));
    setView(current => ({ ...current, scale: nextScale }));
  }

  function resetGraphView() {
    setPositions(initialPositions);
    setView({ x: 0, y: 0, scale: 1 });
  }

  return (
    <div className="catalogMapPreview">
      <div className="catalogMapSummary">
        <div>
          <strong>{catalogs.length}</strong>
          <span>Catalogs</span>
        </div>
        <div>
          <strong>{tableCount}</strong>
          <span>Profiled tables</span>
        </div>
        <div>
          <strong>{links.length}</strong>
          <span>Relationships</span>
        </div>
        <div>
          <strong>{result.map.skipped.catalogs}</strong>
          <span>Skipped catalogs</span>
        </div>
      </div>
      <div className="catalogMapCanvas">
        <div className="catalogMapToolbar" aria-label="Graph controls">
          <button type="button" onClick={() => setView(current => ({ ...current, scale: Math.min(2.8, current.scale * 1.18) }))}>Zoom in</button>
          <button type="button" onClick={() => setView(current => ({ ...current, scale: Math.max(0.45, current.scale / 1.18) }))}>Zoom out</button>
          <button type="button" onClick={resetGraphView}>Reset</button>
        </div>
        <svg
          ref={svgRef}
          viewBox="0 0 900 420"
          role="img"
          aria-label="Trino catalog relationship map"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onWheel={onWheel}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <defs>
              <marker id="catalogArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" />
              </marker>
            </defs>
            {links.map(link => {
              const source = positions.get(link.source);
              const target = positions.get(link.target);
              if (!source || !target) return null;
              return (
                <line
                  key={`${link.source}:${link.target}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  strokeWidth={Math.min(5, 1.5 + link.strength / 2)}
                  markerEnd="url(#catalogArrow)"
                />
              );
            })}
            {catalogs.map(catalog => {
              const position = positions.get(catalog.id) || { x: 450, y: 210 };
              return (
                <g
                  className="catalogNode"
                  key={catalog.id}
                  transform={`translate(${position.x} ${position.y})`}
                  onPointerDown={event => onNodePointerDown(event, catalog.id)}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                >
                  <circle r={44 + Math.min(16, catalog.tableCount)} />
                  <text y="-6">{truncateLabel(catalog.id, 15)}</text>
                  <text y="13">{catalog.tableCount} tables</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="catalogMapDetails">
        <section>
          <h4>Catalogs</h4>
          {catalogs.map(catalog => (
            <article key={catalog.id}>
              <strong>{catalog.id}</strong>
              <p>
                {catalog.tableCount} tables across {catalog.schemaCount} schema{catalog.schemaCount === 1 ? '' : 's'}
              </p>
              {catalog.domains.length ? <em>{catalog.domains.join(', ')}</em> : null}
              {catalog.sampleTables.length ? <code>{catalog.sampleTables.join(', ')}</code> : null}
            </article>
          ))}
        </section>
        <section>
          <h4>Inferred Relationships</h4>
          {links.length ? (
            links.slice(0, 12).map(link => (
              <article key={`${link.source}:${link.target}`}>
                <strong>
                  {link.source} {'->'} {link.target}
                </strong>
                <p>{link.reasons.join(', ')}</p>
              </article>
            ))
          ) : (
            <p className="catalogMapEmpty">No cross-catalog links were inferred from the bounded metadata sample.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function readTrinoCatalogMapResult(value: unknown): TrinoCatalogMapResult | null {
  if (!isRecord(value) || value.kind !== 'trinoCatalogMap' || !isRecord(value.map)) return null;
  if (!Array.isArray(value.map.catalogs) || !Array.isArray(value.map.links) || !isRecord(value.map.skipped)) return null;
  return value as TrinoCatalogMapResult;
}

function computeCatalogPositions(ids: string[]) {
  const positions = new Map<string, { x: number; y: number }>();
  if (!ids.length) return positions;
  if (ids.length === 1) {
    positions.set(ids[0], { x: 450, y: 210 });
    return positions;
  }
  const radiusX = 310;
  const radiusY = 145;
  ids.forEach((id, index) => {
    const angle = -Math.PI / 2 + (index / ids.length) * Math.PI * 2;
    positions.set(id, {
      x: Math.round(450 + Math.cos(angle) * radiusX),
      y: Math.round(210 + Math.sin(angle) * radiusY)
    });
  });
  return positions;
}

function truncateLabel(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function truncateForPrompt(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function messageContentForModel(message: ChatMessage) {
  const context = renderMessageVizInteractionContext(message);
  return context ? `${message.content}\n\n${context}` : message.content;
}

async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const dataUrl = await normalizeImageDataUrl(image, file.type, file.size);
  const byteSize = dataUrlByteSize(dataUrl);
  if (byteSize > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name || 'Image'} is too large after compression. Keep images under ${Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1_000_000)} MB.`);
  }

  return {
    id: crypto.randomUUID(),
    name: file.name || `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) || file.type || 'image/png',
    size: byteSize,
    dataUrl,
    width: image.naturalWidth,
    height: image.naturalHeight
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}.`));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode pasted image.'));
    image.src = dataUrl;
  });
}

async function normalizeImageDataUrl(image: HTMLImageElement, mimeType: string, originalSize: number) {
  const scale = Math.min(1, MAX_CHAT_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const needsCompression = originalSize > MAX_CHAT_ATTACHMENT_BYTES || scale < 1;
  if (!needsCompression) return image.src;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare image attachment.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const outputType = mimeType === 'image/png' && originalSize <= MAX_CHAT_ATTACHMENT_BYTES ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(outputType, 0.86);
}

function dataUrlByteSize(dataUrl: string) {
  const base64 = dataUrl.split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

function joinVoiceDraft(...parts: string[]) {
  return parts
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function renderMessageVizInteractionContext(message: ChatMessage) {
  const sections = (message.toolCalls || [])
    .map(toolCall => {
      const context = renderVizInteractionContext(toolCall, MAX_VIZ_INTERACTIONS_FOR_CONTEXT);
      return context ? `Preview "${toolCall.title}" recent interactions:\n${context}` : '';
    })
    .filter(Boolean);
  return sections.length ? `Recent visualization interaction context for follow-up references:\n${sections.join('\n\n')}` : '';
}

function normalizeRenderableToolCalls(toolCalls?: RenderableToolCall[]) {
  if (!toolCalls?.length) return [];
  return [toolCalls[toolCalls.length - 1]];
}

function normalizeTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const promptTokens = readTokenCount(usage.promptTokens);
  const completionTokens = readTokenCount(usage.completionTokens);
  const totalTokens = readTokenCount(usage.totalTokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(typeof usage.model === 'string' && usage.model.trim() ? { model: usage.model.trim() } : {}),
    ...(typeof usage.source === 'string' && usage.source.trim() ? { source: usage.source.trim() } : {})
  };
}

function readTokenCount(value: unknown) {
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.trunc(numericValue) : undefined;
}

function formatTokenUsageBadge(usage: TokenUsage) {
  if (usage.totalTokens !== undefined) return `${formatNumber(usage.totalTokens)} tokens`;
  const parts = [
    usage.promptTokens === undefined ? '' : `${formatNumber(usage.promptTokens)} in`,
    usage.completionTokens === undefined ? '' : `${formatNumber(usage.completionTokens)} out`
  ].filter(Boolean);
  return parts.join(' / ') || 'tokens';
}

function formatTokenUsageTitle(usage: TokenUsage) {
  const parts = [
    usage.totalTokens === undefined ? '' : `total ${formatNumber(usage.totalTokens)}`,
    usage.promptTokens === undefined ? '' : `prompt ${formatNumber(usage.promptTokens)}`,
    usage.completionTokens === undefined ? '' : `completion ${formatNumber(usage.completionTokens)}`,
    usage.model ? `model ${usage.model}` : ''
  ].filter(Boolean);
  return parts.length ? `Token usage: ${parts.join(', ')}` : 'Token usage';
}

function renderVizInteractionContext(toolCall: RenderableToolCall, limit: number) {
  const events = (toolCall.interactionEvents || []).filter(event => event.chatVisible).slice(-limit);
  return events.map(event => `- ${event.type}: ${event.summary}`).join('\n');
}

function normalizeVizInteraction(params: unknown): VizInteractionEvent | null {
  const source = unwrapVizInteraction(params);
  if (!source) return null;

  const type = readFirstString(source, ['type', 'event', 'name', 'action']) || 'interaction';
  if (isNoisyVizEvent(type)) return null;

  const chatVisible = readBoolean(source, ['chatVisible', 'chat_visible', 'includeInChat']) ?? isAnalyticalVizEvent(type);
  if (!chatVisible && !isAnalyticalVizEvent(type)) return null;

  const details = compactVizDetails(readDetails(source));
  const summary = readFirstString(source, ['summary', 'label', 'title', 'description']) || summarizeVizEvent(type, details);
  if (!summary) return null;

  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: truncateForPrompt(type, 80),
    summary: truncateForPrompt(summary, 260),
    details,
    chatVisible
  };
}

function unwrapVizInteraction(params: unknown): Record<string, unknown> | null {
  if (!isRecord(params)) return null;
  for (const key of ['message', 'event', 'payload', 'data', 'params']) {
    const value = params[key];
    if (isRecord(value) && (hasAnyKey(value, ['type', 'event', 'name', 'action', 'summary']) || readBoolean(value, ['chatVisible', 'chat_visible', 'includeInChat']) !== undefined)) {
      return value;
    }
  }
  return params;
}

function readDetails(source: Record<string, unknown>) {
  for (const key of ['details', 'payload', 'data', 'selection', 'filter', 'filters', 'query', 'arguments', 'value']) {
    const value = source[key];
    if (value !== undefined && !['summary', 'label', 'title', 'description'].includes(key)) return value;
  }
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !['type', 'event', 'name', 'action', 'summary', 'label', 'title', 'description', 'chatVisible', 'chat_visible', 'includeInChat'].includes(key))
  );
}

function compactVizDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { value: truncateForPrompt(String(value), 160) };

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && typeof item !== 'function')
    .slice(0, 8)
    .map(([key, item]) => [key, compactVizValue(item)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactVizValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 6).map(compactVizValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 6).map(([key, item]) => [key, compactVizValue(item)]));
  }
  const serialized = typeof value === 'string' ? value : String(value);
  return serialized.length > 160 ? truncateForPrompt(serialized, 160) : value;
}

function summarizeVizEvent(type: string, details?: Record<string, unknown>) {
  const pairs = Object.entries(details || {})
    .slice(0, 4)
    .map(([key, value]) => `${key}=${formatVizValue(value)}`)
    .filter(Boolean);
  return pairs.length ? `${humanizeVizEventType(type)} (${pairs.join(', ')})` : humanizeVizEventType(type);
}

function formatVizValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(formatVizValue).filter(Boolean).slice(0, 4).join(', ')}]`;
  if (isRecord(value)) return truncateForPrompt(JSON.stringify(value), 100);
  return truncateForPrompt(String(value), 100);
}

function humanizeVizEventType(type: string) {
  return type.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Visualization interaction';
}

function readFirstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readBoolean(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) return value.toLowerCase() === 'true';
  }
  return undefined;
}

function isAnalyticalVizEvent(type: string) {
  return /selection|select|filter|query|sql|rerun|drill|brush|row|point|time|range|catalog|schema|table|dimension|metric/i.test(type);
}

function isNoisyVizEvent(type: string) {
  return /resize|height|ready|mount|unmount|heartbeat|log|debug|hover|mousemove|pointer|focus|blur/i.test(type);
}

function hasAnyKey(value: Record<string, unknown>, keys: string[]) {
  return keys.some(key => key in value);
}

function readRenderableUiResource(value: unknown, seen = new WeakSet<object>()): { resourceUri?: string; html?: string } | undefined {
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
    const bytes = Uint8Array.from(atob(resource.blob), char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
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

function StatusBadge({ status }: { status: AppInfo['status'] }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function ErrorExplainer({ error }: { error: UserError }) {
  const explanation = error.explanation;
  if (!explanation) {
    return <div className="errorBar">{error.message}</div>;
  }

  return (
    <section className="errorBar explainedError" aria-label="Failure explanation">
      <div className="explainedErrorHeader">
        <ShieldAlert size={17} />
        <div>
          <strong>{explanation.headline || error.message}</strong>
          <span>{explanation.generatedBy === 'llm' ? 'Explained with sanitized LLM context' : 'Explained locally'}</span>
        </div>
      </div>
      <p>{explanation.whatHappened}</p>
      <div className="explainedErrorGrid">
        <div>
          <h4>Likely causes</h4>
          <ul>
            {explanation.likelyCauses.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>What to try</h4>
          <ul>
            {explanation.suggestedFixes.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <details>
        <summary>Sanitized technical detail</summary>
        <code>{explanation.technicalSummary || error.technicalError || error.message}</code>
      </details>
    </section>
  );
}

function toolKey(tool: McpTool) {
  return `${tool.appId}:${tool.name}`;
}

function groupToolsByApp(tools: McpTool[], apps: AppInfo[], selectedAppIds: string[]) {
  const appNames = new Map(apps.map(app => [app.id, app.name]));
  const selected = new Set(selectedAppIds);
  const grouped = new Map<string, McpTool[]>();
  for (const tool of tools) {
    grouped.set(tool.appId, [...(grouped.get(tool.appId) || []), tool]);
  }
  return [...grouped.entries()]
    .map(([appId, appTools]) => ({
      appId,
      appName: appNames.get(appId) || appTools[0]?.appName || appId,
      selected: selected.has(appId),
      tools: [...appTools].sort((a, b) => scoreTool(b) - scoreTool(a) || a.name.localeCompare(b.name))
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || a.appName.localeCompare(b.appName));
}

function scoreTool(tool: McpTool) {
  let score = tool._meta?.ui?.resourceUri ? 20 : 0;
  if (/view|visual|dashboard|chart|preview|observe|triage|health|summary/i.test(tool.name)) score += 10;
  return score;
}

function formatToolName(name: string) {
  return name.replace(/[_-]+/g, ' ');
}

function summarizeToolDescription(description: string) {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized.length > 92 ? `${normalized.slice(0, 89)}...` : normalized;
}

function defaultArgsForTool(tool: McpTool) {
  const defaults = inferToolArgDefaults(tool.inputSchema);
  return JSON.stringify(defaults, null, 2);
}

function inferToolArgDefaults(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!isRecord(value)) continue;
    if ('default' in value) defaults[key] = value.default;
  }
  return defaults;
}

function parseToolRunnerArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error('Arguments JSON must be an object.');
  return parsed;
}

function formatToolSchema(schema: unknown) {
  return truncateForPrompt(JSON.stringify(schema, null, 2), 2200);
}

function formatToolRunnerResult(result: unknown) {
  return truncateForPrompt(JSON.stringify(result, null, 2), 6000);
}

function createConversation(messages = defaultMessages()): StoredConversation {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: deriveConversationTitle(messages),
    createdAt: now,
    updatedAt: now,
    messages
  };
}

function defaultMessages(): ChatMessage[] {
  return [];
}

function deriveConversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find(message => message.role === 'user' && !message.hidden && message.content.trim());
  if (!firstUserMessage) return 'New chat';
  const normalized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return normalized.length > 58 ? `${normalized.slice(0, 55)}...` : normalized;
}

function loadChatState() {
  const fallback = createConversation();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_HISTORY_KEY) || '[]') as Partial<StoredConversation>[];
    const conversations = parsed
      .filter(isStoredConversation)
      .map(conversation => ({
        ...conversation,
        messages: removeDefaultIntroMessage(conversation.messages),
        title: conversation.title || deriveConversationTitle(removeDefaultIntroMessage(conversation.messages))
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_STORED_CONVERSATIONS);
    if (!conversations.length) {
      persistChatState(fallback.id, [fallback]);
      return { activeId: fallback.id, conversations: [fallback], messages: fallback.messages };
    }

    const storedActiveId = window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    const activeConversation = conversations.find(conversation => conversation.id === storedActiveId) || conversations[0];
    persistChatState(activeConversation.id, conversations);
    return {
      activeId: activeConversation.id,
      conversations,
      messages: activeConversation.messages
    };
  } catch {
    persistChatState(fallback.id, [fallback]);
    return { activeId: fallback.id, conversations: [fallback], messages: fallback.messages };
  }
}

function loadSelectedMcpAppIds(): string[] | null {
  try {
    const raw = window.localStorage.getItem(SELECTED_MCP_APPS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return null;
  }
}

function persistSelectedMcpAppIds(appIds: string[]) {
  try {
    window.localStorage.setItem(SELECTED_MCP_APPS_KEY, JSON.stringify(appIds));
  } catch (err) {
    console.warn('Unable to persist selected MCP apps', err);
  }
}

function removeDefaultIntroMessage(messages: ChatMessage[]) {
  return messages.filter(message => !(message.role === 'assistant' && message.content === DEFAULT_INTRO_MESSAGE && !message.toolCalls?.length));
}

function isStoredConversation(value: Partial<StoredConversation>): value is StoredConversation {
  return Boolean(
    value &&
      typeof value.id === 'string' &&
      typeof value.createdAt === 'string' &&
      typeof value.updatedAt === 'string' &&
      Array.isArray(value.messages) &&
      value.messages.every(isChatMessage)
  );
}

function isChatMessage(value: Partial<ChatMessage>): value is ChatMessage {
  return Boolean(
    value &&
      (value.role === 'user' || value.role === 'assistant') &&
      typeof value.content === 'string' &&
      (value.attachments === undefined || Array.isArray(value.attachments))
  );
}

function persistChatState(activeId: string, conversations: StoredConversation[]): PersistChatStateResult {
  const bounded = conversations.slice(0, MAX_STORED_CONVERSATIONS);
  let lastError: unknown;
  for (let count = bounded.length; count >= 1; count -= 1) {
    const candidate = selectConversationsForStorage(activeId, bounded, count);
    try {
      window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, candidate.some(conversation => conversation.id === activeId) ? activeId : candidate[0]?.id || activeId);
      window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(candidate.map(stripTransientAttachmentData)));
      return {
        ok: true,
        conversations: candidate,
        prunedCount: bounded.length - candidate.length
      };
    } catch (err) {
      lastError = err;
      if (!isQuotaExceededError(err)) break;
    }
  }

  console.warn('Unable to persist chat history', lastError);
  return {
    ok: false,
    conversations: bounded,
    prunedCount: 0,
    error: lastError
  };
}

function selectConversationsForStorage(activeId: string, conversations: StoredConversation[], count: number) {
  const sorted = [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = conversations.find(conversation => conversation.id === activeId);
  if (!active) return sorted.slice(0, count);
  return [active, ...sorted.filter(conversation => conversation.id !== activeId).slice(0, Math.max(0, count - 1))];
}

function isQuotaExceededError(error: unknown) {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014;
}

function stripTransientAttachmentData(conversation: StoredConversation): StoredConversation {
  return {
    ...conversation,
    messages: conversation.messages.map(message => {
      if (!message.attachments?.length) return message;
      return {
        ...message,
        attachments: undefined
      };
    })
  };
}

function formatConversationTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) return 'now';
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createBrowserMcpProxy(
  appId: string,
  onToolResult?: (update: ToolResultUpdate) => void
) {
  return {
    callTool: async ({ name, arguments: toolArgs }: { name: string; arguments?: Record<string, unknown> }) => {
      const normalizedArgs = toolArgs || {};
      const result = await api(`/api/apps/${encodeURIComponent(appId)}/tools/call?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify({ arguments: normalizedArgs })
      });
      const embeddedUiResource = readRenderableUiResource(result);
      onToolResult?.({ toolName: name, toolInput: normalizedArgs, toolResult: result, resourceUri: embeddedUiResource?.resourceUri, html: embeddedUiResource?.html });
      return result;
    },
    readResource: async ({ uri }: { uri: string }) => {
      return api(`/api/apps/${encodeURIComponent(appId)}/resources/read`, {
        method: 'POST',
        body: JSON.stringify({ uri })
      });
    },
    listResources: async (params?: { cursor?: string }) => {
      return api(`/api/apps/${encodeURIComponent(appId)}/resources/list`, {
        method: 'POST',
        body: JSON.stringify(params || {})
      });
    },
    listResourceTemplates: async (params?: { cursor?: string }) => {
      return api(`/api/apps/${encodeURIComponent(appId)}/resources/templates/list`, {
        method: 'POST',
        body: JSON.stringify(params || {})
      });
    },
    listPrompts: async (params?: { cursor?: string }) => {
      return api(`/api/apps/${encodeURIComponent(appId)}/prompts/list`, {
        method: 'POST',
        body: JSON.stringify(params || {})
      });
    }
  };
}

type ExportImage = {
  id: string;
  name: string;
  fileName: string;
  dataUrl: string;
  mimeType: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
};

type ExportAssets = {
  images: ExportImage[];
  byMessage: Map<string, ExportImage[]>;
  byToolCall: Map<string, ExportImage[]>;
};

type DocxModule = typeof import('docx');
type DocxParagraph = InstanceType<DocxModule['Paragraph']>;
type DocxTable = InstanceType<DocxModule['Table']>;
type DocxChild = DocxParagraph | DocxTable;

type ExportInline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

type ExportBlock =
  | { type: 'heading'; depth: number; inlines: ExportInline[] }
  | { type: 'paragraph'; inlines: ExportInline[] }
  | { type: 'blockquote'; inlines: ExportInline[] }
  | { type: 'list'; ordered: boolean; items: ExportInline[][] }
  | { type: 'table'; headers: ExportInline[][]; rows: ExportInline[][][] }
  | { type: 'code'; text: string }
  | { type: 'rule' };

async function exportConversation(format: ExportFormat, messages: ChatMessage[], title: string) {
  const assets = await collectExportAssets(messages);
  const baseName = slugifyFileName(title || 'rubberband-chat');
  const exportStamp = formatExportTimestamp(new Date());
  const stampedBaseName = `${baseName}-${exportStamp}`;
  if (format === 'markdown') {
    await exportMarkdownZip(messages, assets, title, stampedBaseName);
  } else if (format === 'docx') {
    await exportDocx(messages, assets, title, stampedBaseName);
  } else {
    await exportPdf(messages, assets, title, stampedBaseName);
  }
}

async function collectExportAssets(messages: ChatMessage[]): Promise<ExportAssets> {
  const images: ExportImage[] = [];
  const byMessage = new Map<string, ExportImage[]>();
  const byToolCall = new Map<string, ExportImage[]>();
  const seen = new Set<string>();

  async function addImage(dataUrl: string, name: string, target: Map<string, ExportImage[]>, targetId: string) {
    if (!dataUrl.startsWith('data:image/') || seen.has(`${targetId}:${dataUrl.slice(0, 96)}`)) return;
    seen.add(`${targetId}:${dataUrl.slice(0, 96)}`);
    const image = await createExportImage(dataUrl, name, images.length + 1);
    images.push(image);
    target.set(targetId, [...(target.get(targetId) || []), image]);
  }

  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      if (attachment.dataUrl) await addImage(attachment.dataUrl, attachment.name || 'attachment', byMessage, message.id);
    }

    for (const toolCall of message.toolCalls || []) {
      const frameImage = await captureToolCallFrame(toolCall);
      if (frameImage) await addImage(frameImage, `${toolCall.title || toolCall.toolName} preview`, byToolCall, toolCall.id);
      for (const embeddedImage of extractImageDataUrls(toolCall.toolResult)) {
        await addImage(embeddedImage, `${toolCall.title || toolCall.toolName} image`, byToolCall, toolCall.id);
      }
    }
  }

  return { images, byMessage, byToolCall };
}

async function captureToolCallFrame(toolCall: RenderableToolCall) {
  const frame = [...document.querySelectorAll<HTMLElement>('.appFrame[data-export-tool-call-id]')].find(element => element.dataset.exportToolCallId === toolCall.id);
  if (!frame) return undefined;
  const { toPng } = await import('html-to-image');
  return toPng(frame, {
    backgroundColor: '#ffffff',
    cacheBust: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    filter: node => !(node instanceof HTMLElement && (node.classList.contains('appFrameActions') || node.classList.contains('bubbleActions')))
  }).catch(() => undefined);
}

async function exportMarkdownZip(messages: ChatMessage[], assets: ExportAssets, title: string, baseName: string) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const markdown = renderMarkdownExport(messages, assets, title);
  zip.file('chat.md', markdown);
  for (const image of assets.images) {
    zip.file(`assets/${image.fileName}`, image.bytes);
  }
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${baseName}-markdown.zip`);
}

async function exportDocx(messages: ChatMessage[], assets: ExportAssets, title: string, baseName: string) {
  const docx = await import('docx');
  const { Document, HeadingLevel, Packer, Paragraph } = docx;
  const children: DocxChild[] = [
    new Paragraph({ text: cleanExportText(title || 'Rubberband Chat'), heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `Exported ${new Date().toLocaleString()}` })
  ];

  for (const message of messages) {
    children.push(new Paragraph({ text: message.role === 'user' ? 'User' : 'Assistant', heading: HeadingLevel.HEADING_1 }));
    appendDocxMarkdownBlocks(children, message.content, docx);
    appendDocxImages(children, assets.byMessage.get(message.id) || [], docx);
    for (const toolCall of message.toolCalls || []) {
      children.push(new Paragraph({ text: `Visualization: ${cleanExportText(toolCall.title || toolCall.toolName)}`, heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ text: `${cleanExportText(toolCall.appId)} / ${cleanExportText(toolCall.toolName)}` }));
      appendDocxImages(children, assets.byToolCall.get(toolCall.id) || [], docx);
    }
  }

  const document = new Document({ sections: [{ children }] });
  downloadBlob(await Packer.toBlob(document), `${baseName}.docx`);
}

async function exportPdf(messages: ChatMessage[], assets: ExportAssets, title: string, baseName: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 48;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - margin) return;
    pdf.addPage();
    y = margin;
  };
  const writeText = (text: string, size = 10, style: 'normal' | 'bold' | 'italic' = 'normal') => {
    pdf.setFont('helvetica', style);
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(toPdfText(text) || ' ', contentWidth) as string[];
    ensureSpace(lines.length * (size + 4));
    pdf.text(lines, margin, y);
    y += lines.length * (size + 4) + 8;
  };
  const writeMarkdownBlocks = (content: string) => {
    for (const block of parseExportMarkdown(content)) {
      if (block.type === 'heading') {
        writeText(inlinesToPlainText(block.inlines), block.depth <= 2 ? 12 : 11, 'bold');
      } else if (block.type === 'paragraph') {
        writeText(inlinesToPlainText(block.inlines), 10);
      } else if (block.type === 'blockquote') {
        writeText(inlinesToPlainText(block.inlines), 10, 'italic');
      } else if (block.type === 'list') {
        block.items.forEach((item, index) => writeText(`${block.ordered ? `${index + 1}.` : '-'} ${inlinesToPlainText(item)}`, 10));
      } else if (block.type === 'table') {
        writePdfTable(block);
      } else if (block.type === 'code') {
        writeText(block.text, 9);
      } else {
        ensureSpace(10);
        pdf.setDrawColor(210, 218, 226);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 12;
      }
    }
  };
  const writePdfTable = (table: Extract<ExportBlock, { type: 'table' }>) => {
    const columnCount = Math.max(table.headers.length, ...table.rows.map(row => row.length), 1);
    const columnWidth = contentWidth / columnCount;
    const rows = [table.headers, ...table.rows];
    for (const [rowIndex, row] of rows.entries()) {
      pdf.setFont('helvetica', rowIndex === 0 ? 'bold' : 'normal');
      pdf.setFontSize(8);
      const cellLines = Array.from({ length: columnCount }, (_, index) => {
        const text = toPdfText(inlinesToPlainText(row[index] || []));
        return pdf.splitTextToSize(text || ' ', columnWidth - 10) as string[];
      });
      const rowHeight = Math.max(22, Math.max(...cellLines.map(lines => lines.length)) * 11 + 10);
      ensureSpace(rowHeight);
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const x = margin + columnIndex * columnWidth;
        if (rowIndex === 0) {
          pdf.setFillColor(241, 245, 249);
          pdf.rect(x, y, columnWidth, rowHeight, 'F');
        }
        pdf.setDrawColor(203, 213, 225);
        pdf.rect(x, y, columnWidth, rowHeight);
        pdf.setTextColor(31, 41, 55);
        pdf.text(cellLines[columnIndex], x + 5, y + 13);
      }
      y += rowHeight;
    }
    y += 10;
  };
  const writeImages = (images: ExportImage[]) => {
    for (const image of images) {
      const size = fitImageSize(image, contentWidth, 330);
      ensureSpace(size.height + 24);
      pdf.addImage(image.dataUrl, image.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG', margin, y, size.width, size.height);
      y += size.height + 18;
    }
  };

  writeText(title || 'Rubberband Chat', 18, 'bold');
  writeText(`Exported ${new Date().toLocaleString()}`, 9);
  for (const message of messages) {
    writeText(message.role === 'user' ? 'User' : 'Assistant', 13, 'bold');
    writeMarkdownBlocks(message.content);
    writeImages(assets.byMessage.get(message.id) || []);
    for (const toolCall of message.toolCalls || []) {
      writeText(`Visualization: ${toolCall.title || toolCall.toolName}`, 12, 'bold');
      writeText(`${toolCall.appId} / ${toolCall.toolName}`, 9);
      writeImages(assets.byToolCall.get(toolCall.id) || []);
    }
  }
  pdf.save(`${baseName}.pdf`);
}

function renderMarkdownExport(messages: ChatMessage[], assets: ExportAssets, title: string) {
  const lines = [`# ${title || 'Rubberband Chat'}`, '', `Exported ${new Date().toISOString()}`, ''];
  for (const message of messages) {
    lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '', message.content || '', '');
    for (const image of assets.byMessage.get(message.id) || []) {
      lines.push(`![${escapeMarkdownAlt(image.name)}](assets/${image.fileName})`, '');
    }
    for (const toolCall of message.toolCalls || []) {
      lines.push(`### Visualization: ${toolCall.title || toolCall.toolName}`, '', `- App: \`${toolCall.appId}\``, `- Tool: \`${toolCall.toolName}\``, '');
      for (const image of assets.byToolCall.get(toolCall.id) || []) {
        lines.push(`![${escapeMarkdownAlt(image.name)}](assets/${image.fileName})`, '');
      }
      lines.push('<details><summary>Tool input</summary>', '', '```json', JSON.stringify(toolCall.toolInput || {}, null, 2), '```', '', '</details>', '');
    }
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}

function appendDocxMarkdownBlocks(children: DocxChild[], content: string, docx: DocxModule) {
  const { HeadingLevel, Paragraph } = docx;
  for (const block of parseExportMarkdown(content)) {
    if (block.type === 'heading') {
      children.push(new Paragraph({ children: docxRunsFromInlines(block.inlines, docx), heading: docxHeadingLevel(block.depth, HeadingLevel) }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({ children: docxRunsFromInlines(block.inlines, docx) }));
    } else if (block.type === 'blockquote') {
      children.push(new Paragraph({ children: docxRunsFromInlines(block.inlines, docx, { italic: true }), indent: { left: 360 } }));
    } else if (block.type === 'list') {
      block.items.forEach((item, index) => {
        children.push(new Paragraph({ children: docxRunsFromInlines([{ text: `${block.ordered ? `${index + 1}.` : '-'} ` }, ...item], docx) }));
      });
    } else if (block.type === 'table') {
      children.push(createDocxTable(block, docx));
    } else if (block.type === 'code') {
      children.push(new Paragraph({ children: docxRunsFromInlines([{ text: block.text, code: true }], docx) }));
    } else {
      children.push(new Paragraph({ text: '' }));
    }
  }
}

function docxRunsFromInlines(inlines: ExportInline[], docx: DocxModule, defaults: Partial<ExportInline> = {}) {
  const { TextRun } = docx;
  const runs = inlines
    .map(span => ({ ...defaults, ...span, text: cleanExportText(span.text, { trim: false }) }))
    .filter(span => span.text.trim())
    .map(span =>
      new TextRun({
        text: span.text,
        bold: Boolean(span.bold),
        italics: Boolean(span.italic),
        font: span.code ? 'Consolas' : undefined
      })
    );
  return runs.length ? runs : [new TextRun(' ')];
}

function docxHeadingLevel(depth: number, headingLevel: DocxModule['HeadingLevel']) {
  if (depth <= 1) return headingLevel.HEADING_1;
  if (depth === 2) return headingLevel.HEADING_2;
  if (depth === 3) return headingLevel.HEADING_3;
  return headingLevel.HEADING_4;
}

function createDocxTable(table: Extract<ExportBlock, { type: 'table' }>, docx: DocxModule): DocxTable {
  const { BorderStyle, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, WidthType } = docx;
  const columnCount = Math.max(table.headers.length, ...table.rows.map(row => row.length), 1);
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' };
  const rows = [table.headers, ...table.rows].map((row, rowIndex) =>
    new TableRow({
      tableHeader: rowIndex === 0,
      children: Array.from({ length: columnCount }, (_, columnIndex) =>
        new TableCell({
          width: { size: 100 / columnCount, type: WidthType.PERCENTAGE },
          margins: { top: 120, bottom: 120, left: 120, right: 120 },
          shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' } : undefined,
          borders: { top: border, bottom: border, left: border, right: border },
          children: [new Paragraph({ children: docxRunsFromInlines(row[columnIndex] || [{ text: '' }], docx, { bold: rowIndex === 0 }) })]
        })
      )
    })
  );
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT
  });
}

function appendDocxImages(children: DocxChild[], images: ExportImage[], docx: DocxModule) {
  const { ImageRun, Paragraph } = docx;
  for (const image of images) {
    const size = fitImageSize(image, 520, 340);
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: image.mimeType === 'image/jpeg' ? 'jpg' : 'png',
            data: image.bytes,
            transformation: { width: Math.round(size.width), height: Math.round(size.height) },
            altText: { title: image.name, description: image.name, name: image.name }
          })
        ]
      })
    );
  }
}

function parseExportMarkdown(content: string): ExportBlock[] {
  const lines = cleanMarkdownSource(content).split('\n');
  const blocks: ExportBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*(```+|~~~+)\s*[\w-]*\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: cleanExportText(codeLines.join('\n')) });
      continue;
    }

    if (index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
      const headers = splitMarkdownTableRow(line).map(parseInlineMarkdown);
      index += 2;
      const rows: ExportInline[][][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|') && !isBlockStart(lines[index])) {
        rows.push(splitMarkdownTableRow(lines[index]).map(parseInlineMarkdown));
        index += 1;
      }
      if (headers.length) blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: 'heading', depth: heading[1].length, inlines: parseInlineMarkdown(heading[2]) });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', inlines: parseInlineMarkdown(quoteLines.join(' ')) });
      continue;
    }

    const listMatch = line.match(/^\s{0,3}((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items: ExportInline[][] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s{0,3}((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
        if (!itemMatch || /\d/.test(itemMatch[1]) !== ordered) break;
        items.push(parseInlineMarkdown(itemMatch[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) && !(index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1]))) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', inlines: parseInlineMarkdown(paragraphLines.join(' ')) });
  }

  return blocks;
}

function parseInlineMarkdown(value: string): ExportInline[] {
  const text = cleanInlineMarkdown(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const spans: ExportInline[] = [];
  let index = 0;

  const pushText = (raw: string, options: Omit<ExportInline, 'text'> = {}) => {
    const cleaned = cleanExportText(raw.replace(/\\([\\`*_[\]()#>!|])/g, '$1'), { trim: false });
    if (cleaned.trim()) spans.push({ text: cleaned, ...options });
  };

  while (index < text.length) {
    const codeStart = text.indexOf('`', index);
    const boldStarStart = text.indexOf('**', index);
    const boldUnderscoreStart = text.indexOf('__', index);
    const markers = [codeStart, boldStarStart, boldUnderscoreStart].filter(position => position >= 0);
    const nextMarker = markers.length ? Math.min(...markers) : -1;
    if (nextMarker < 0) {
      pushText(text.slice(index));
      break;
    }
    if (nextMarker > index) pushText(text.slice(index, nextMarker));

    if (nextMarker === codeStart) {
      const end = text.indexOf('`', nextMarker + 1);
      if (end < 0) {
        pushText(text.slice(nextMarker));
        break;
      }
      pushText(text.slice(nextMarker + 1, end), { code: true });
      index = end + 1;
      continue;
    }

    const marker = nextMarker === boldStarStart ? '**' : '__';
    const end = text.indexOf(marker, nextMarker + marker.length);
    if (end < 0) {
      pushText(text.slice(nextMarker));
      break;
    }
    pushText(text.slice(nextMarker + marker.length, end), { bold: true });
    index = end + marker.length;
  }

  return spans.length ? spans : [{ text: cleanExportText(value) }];
}

function isBlockStart(line: string) {
  return (
    /^\s*(```+|~~~+)/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}((?:[-*+])|(?:\d+[.)]))\s+/.test(line) ||
    /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
  );
}

function isMarkdownTableSeparator(line: string) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function splitMarkdownTableRow(line: string) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && value[value.length - 2] !== '\\') value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && index + 1 < value.length) {
      cell += value[index + 1];
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function inlinesToPlainText(inlines: ExportInline[]) {
  return cleanExportText(inlines.map(span => span.text).join(''));
}

function cleanMarkdownSource(value: string) {
  return value.replace(/\r\n?/g, '\n');
}

function cleanInlineMarkdown(value: string) {
  return decodeBasicHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '');
}

function cleanExportText(value: string, options: { trim?: boolean } = {}) {
  const cleaned = stripUnsupportedExportGlyphs(cleanInlineMarkdown(value))
    .replace(/\u00a0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[ \t]+/g, ' ');
  return options.trim === false ? cleaned : cleaned.trim();
}

function toPdfText(value: string) {
  return cleanExportText(value);
}

function stripUnsupportedExportGlyphs(value: string) {
  return removeUnpairedSurrogates(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200d\ufe0e\ufe0f]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}

function removeUnpairedSurrogates(value: string) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    output += value[index];
  }
  return output;
}

function decodeBasicHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function formatExportTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
}

async function createExportImage(dataUrl: string, name: string, index: number): Promise<ExportImage> {
  const normalized = await normalizeExportImageDataUrl(dataUrl);
  const dimensions = await readImageDimensions(normalized);
  const mimeType = normalized.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const safeName = slugifyFileName(name || `image-${index}`);
  return {
    id: `image-${index}`,
    name,
    fileName: `${String(index).padStart(2, '0')}-${safeName}.${ext}`,
    dataUrl: normalized,
    mimeType,
    bytes: dataUrlToBytes(normalized),
    width: dimensions.width,
    height: dimensions.height
  };
}

async function normalizeExportImageDataUrl(dataUrl: string) {
  if (dataUrl.startsWith('data:image/png') || dataUrl.startsWith('data:image/jpeg')) return dataUrl;
  return convertImageDataUrlToPng(dataUrl);
}

function extractImageDataUrls(value: unknown, seen = new Set<unknown>()): string[] {
  if (!value || seen.has(value)) return [];
  if (typeof value === 'string') return value.startsWith('data:image/') ? [value] : [];
  if (typeof value !== 'object') return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap(item => extractImageDataUrls(item, seen));
  return Object.values(value as Record<string, unknown>).flatMap(item => extractImageDataUrls(item, seen));
}

function readImageDimensions(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1200, height: image.naturalHeight || 720 });
    image.onerror = () => reject(new Error('Could not read exported image dimensions.'));
    image.src = dataUrl;
  });
}

function convertImageDataUrlToPng(dataUrl: string) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || 1200;
      canvas.height = image.naturalHeight || 720;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not prepare image export canvas.'));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not normalize exported image.'));
    image.src = dataUrl;
  });
}

function dataUrlToBytes(dataUrl: string) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function fitImageSize(image: Pick<ExportImage, 'width' | 'height'>, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { width: image.width * scale, height: image.height * scale };
}

function splitParagraphs(content: string) {
  return content.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugifyFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'rubberband-chat';
}

function escapeMarkdownAlt(value: string) {
  return value.replace(/[[\]\\]/g, '\\$&');
}

function profilerMetricRows(entry: AnalyticsProfileEntry) {
  const profile = entry.profile;
  if (!profile) return [] as Array<{ label: string; value: string }>;

  if (entry.target === 'elastic') {
    return [
      { label: 'Generated', value: formatDateTime(profile.generatedAt) },
      { label: 'Profiled targets', value: formatNumber(profile.analyzedIndices?.length || 0) },
      { label: 'Discovered indices', value: formatNumber(profile.totalDiscoveredIndices || 0) },
      { label: 'Data streams', value: formatNumber(profile.totalDiscoveredDataStreams || 0) },
      { label: 'Suggestions', value: formatNumber(profile.suggestions?.length || 0) },
      { label: 'Skipped', value: skippedSummary(profile.skipped) }
    ].filter(metric => metric.value && metric.value !== '0');
  }

  return [
    { label: 'Generated', value: formatDateTime(profile.generatedAt) },
    { label: 'Connection', value: profile.connectionLabel || 'Unknown' },
    { label: 'Catalogs', value: formatNumber(profile.catalogs?.length || 0) },
    { label: 'Profiled tables', value: formatNumber(profile.analyzedTables?.length || 0) },
    { label: 'Suggestions', value: formatNumber(profile.suggestions?.length || 0) },
    { label: 'Skipped', value: skippedSummary(profile.skipped) },
    { label: 'Cache', value: profile.cache ? `${profile.cache.hit ? 'Hit' : 'Miss'} (${formatDuration(profile.cache.ttlMs || 0)})` : '' }
  ].filter(metric => metric.value && metric.value !== '0');
}

function skippedSummary(skipped?: Record<string, unknown>) {
  if (!skipped) return '';
  const parts = Object.entries(skipped)
    .map(([key, value]) => {
      if (Array.isArray(value)) return value.length ? `${labelFromCamelCase(key)} ${value.length}` : '';
      if (typeof value === 'number') return value > 0 ? `${labelFromCamelCase(key)} ${formatNumber(value)}` : '';
      if (typeof value === 'boolean') return value ? labelFromCamelCase(key) : '';
      if (typeof value === 'string') return value ? `${labelFromCamelCase(key)} ${value}` : '';
      return '';
    })
    .filter(Boolean);
  return parts.join(', ');
}

function profilerStatusClass(status: AnalyticsProfileStatus) {
  if (status === 'ready') return 'success';
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'stale' || status === 'skipped') return 'warning';
  return 'neutral';
}

function formatProfilerStatus(status: AnalyticsProfileStatus) {
  return labelFromCamelCase(status);
}

function labelFromCamelCase(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function formatDateTime(value?: string) {
  if (!value) return 'None';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Off';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function valuesFromSettings(fields: SettingField[]) {
  return Object.fromEntries(fields.map(field => [field.key, field.value || '']));
}

function editableValuesFromSettings(fields: SettingField[], values: Record<string, string>) {
  return Object.fromEntries(
    fields
      .filter(field => !field.locked)
      .map(field => {
        const value = values[field.key] || '';
        return [field.key, value === (field.defaultValue || '') ? '' : value];
      })
  );
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(appUrl(url), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(browserSessionId ? { 'x-rubberband-session-id': browserSessionId } : {}),
      ...(init.headers || {})
    }
  });
  const sessionId = response.headers.get('x-rubberband-session-id');
  if (sessionId) browserSessionId = sessionId;
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new RubberbandApiError(body?.error || `${response.status} ${response.statusText}`, body?.technicalError, body?.explanation);
  }
  return response.json() as Promise<T>;
}

function appUrl(url: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  const normalizedUrl = url.startsWith('/') ? url : `/${url}`;
  return `${APP_BASE_PATH}${normalizedUrl}`;
}

function resolveAppBasePath() {
  const viteBase = import.meta.env.BASE_URL;
  if (viteBase && viteBase !== './' && viteBase !== '/') return normalizeBasePath(viteBase);
  return normalizeBasePath(new URL('.', window.location.href).pathname);
}

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/' || trimmed === './') return '';
  const pathname = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? new URL(trimmed).pathname : trimmed;
  const withoutTrailing = pathname.replace(/\/+$/, '');
  if (!withoutTrailing || withoutTrailing === '/' || withoutTrailing === '.') return '';
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`;
}

class RubberbandApiError extends Error {
  constructor(
    message: string,
    readonly technicalError?: string,
    readonly explanation?: ErrorExplanation
  ) {
    super(message);
    this.name = 'RubberbandApiError';
  }
}

function toUserError(error: unknown): UserError {
  if (error instanceof RubberbandApiError) {
    return {
      message: error.message,
      technicalError: error.technicalError,
      explanation: error.explanation
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error)
  };
}

function formatErrorForInline(error: unknown) {
  const userError = toUserError(error);
  if (!userError.explanation) return userError.message;
  return [
    userError.explanation.headline,
    '',
    userError.explanation.whatHappened,
    '',
    'Likely causes:',
    ...userError.explanation.likelyCauses.map(item => `- ${item}`),
    '',
    'What to try:',
    ...userError.explanation.suggestedFixes.map(item => `- ${item}`),
    '',
    `Technical detail: ${userError.explanation.technicalSummary}`
  ].join('\n');
}

createRoot(document.getElementById('root')!).render(<App />);
