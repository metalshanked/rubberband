import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import process from 'node:process';

const image = process.env.DOCKER_IMAGE || 'rubberband-mcp-chat:test';
const port = Number(process.env.DOCKER_SMOKE_PORT || randomInt(18100, 18999));
const container = `rubberband-mcp-chat-smoke-${Date.now()}`;
const basePath = normalizeBasePath(process.env.BASE_PATH || '');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stderr}`));
    });
  });
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}${basePath}/api/health`;
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Container did not become healthy at ${url}`);
}

async function main() {
  await run('docker', ['build', '-t', image, '.']);
  const containerId = await capture('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-p',
    `${port}:8765`,
    '--env-file',
    '.env',
    image
  ]);
  console.log(`Started Docker smoke container ${containerId}`);

  try {
    await waitForHealth();
    const response = await fetch(`http://127.0.0.1:${port}${basePath}/api/settings`);
    if (!response.ok) throw new Error(`Settings endpoint failed with ${response.status}`);
    console.log(`Docker smoke passed at http://127.0.0.1:${port}${basePath || '/'}`);
  } finally {
    await run('docker', ['stop', container]).catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '/' ? '' : withoutTrailingSlash;
}
