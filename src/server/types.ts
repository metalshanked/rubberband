export type McpTransportConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
    }
  | {
      type: 'http';
      url: string;
    };

export type InstalledMcpApp = {
  id: string;
  name: string;
  description?: string;
  transport: McpTransportConfig;
  envPassthrough?: string[];
  skills?: Array<{
    name: string;
    description?: string;
    content: string;
    path?: string;
  }>;
};

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Array<{
    id?: string;
    name?: string;
    mimeType: string;
    dataUrl: string;
    size?: number;
  }>;
};

export type RenderableToolCall = {
  id: string;
  appId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  resourceUri?: string;
  html?: string;
  title: string;
};
