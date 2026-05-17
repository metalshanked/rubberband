import { defineConfig, devices } from '@playwright/test';

const basePath = normalizeBasePath(process.env.BASE_PATH || '');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: 'http://127.0.0.1:18080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'npm run build && node dist/server/index.js',
    url: `http://127.0.0.1:18080${basePath}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: '18080',
      BASE_PATH: basePath,
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
    }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '/' ? '' : withoutTrailingSlash;
}
