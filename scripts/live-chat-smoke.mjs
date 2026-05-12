import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import process from 'node:process';

const port = Number(process.env.LIVE_SMOKE_PORT || randomInt(19000, 19999));
const baseUrl = `http://127.0.0.1:${port}`;
const basePath = normalizeBasePath(process.env.BASE_PATH || '');

async function waitForHealth(child) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}${basePath}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  throw new Error('Server did not become healthy in time');
}

async function main() {
  const child = spawn('node', ['dist/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MCP_APPS_MANIFEST: 'tests/fixtures/empty-manifest.json'
    },
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });

  try {
    await waitForHealth(child);
    const response = await fetch(`${baseUrl}${basePath}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Reply with one short sentence that says the live LLM smoke test worked.' }]
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Chat failed with ${response.status}`);
    if (!body.content || typeof body.content !== 'string') throw new Error('Chat returned no assistant content');
    process.stdout.write('Live chat smoke passed.\n');
  } finally {
    child.kill();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '/' ? '' : withoutTrailingSlash;
}
