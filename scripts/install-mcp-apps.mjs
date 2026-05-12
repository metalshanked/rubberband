import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const workspace = process.cwd();
const configPath = path.resolve(workspace, process.env.MCP_APPS_CONFIG || 'mcp-apps.json');
const installRoot = path.resolve(workspace, process.env.MCP_APPS_DIR || 'mcp_apps');
const outputPath = path.resolve(workspace, process.env.MCP_APPS_OUTPUT || 'mcp-apps.installed.json');

function assertInside(child, parent) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside install root: ${child}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
      }
    });
  });
}

async function cleanDirectory(target) {
  assertInside(target, installRoot);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function unpackZip(zipPath, target, stripTopLevel) {
  const staging = `${target}.__zip`;
  await cleanDirectory(staging);

  if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}' -Force`]);
  } else {
    await run('unzip', ['-q', zipPath, '-d', staging]);
  }

  if (stripTopLevel) {
    const entries = await fs.readdir(staging, { withFileTypes: true });
    const dirs = entries.filter(entry => entry.isDirectory());
    if (dirs.length === 1 && entries.length === 1) {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(path.join(staging, dirs[0].name), target);
      await fs.rm(staging, { recursive: true, force: true });
      return;
    }
  }

  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(staging, target);
}

function interpolate(value, appDir) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('${appDir}', appDir).replaceAll('${workspace}', workspace);
}

function isCommitHash(ref) {
  return typeof ref === 'string' && /^[0-9a-f]{40}$/i.test(ref);
}

async function discoverSkills(appDir) {
  const skillsRoot = path.join(appDir, 'skills');
  if (!existsSync(skillsRoot)) return [];

  const skills = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        const content = await fs.readFile(fullPath, 'utf8');
        const relative = path.relative(skillsRoot, path.dirname(fullPath)).replaceAll(path.sep, '/');
        const frontmatter = parseSkillFrontmatter(content);
        skills.push({
          name: frontmatter.name || relative || path.basename(path.dirname(fullPath)),
          description: frontmatter.description || '',
          content: trimSkillContent(content),
          path: path.relative(appDir, fullPath).replaceAll(path.sep, '/')
        });
      }
    }
  }

  await walk(skillsRoot);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillFrontmatter(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines.slice(0, 30)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) result[match[1].toLowerCase()] = match[2].trim();
    if (line.startsWith('# ')) break;
  }
  return result;
}

function trimSkillContent(content) {
  return content
    .replace(/^---\s*[\s\S]*?\s*---\s*/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function installApp(app) {
  const appDir = path.resolve(installRoot, app.id);
  assertInside(appDir, installRoot);
  await cleanDirectory(appDir);

  if (app.source?.type === 'git') {
    const cloneArgs = ['clone', '--depth', '1'];
    if (app.source.ref && !isCommitHash(app.source.ref)) cloneArgs.push('--branch', app.source.ref);
    cloneArgs.push(app.source.url, appDir);
    await run('git', cloneArgs, { cwd: workspace });
    if (isCommitHash(app.source.ref)) {
      await run('git', ['fetch', '--depth', '1', 'origin', app.source.ref], { cwd: appDir });
      await run('git', ['checkout', '--detach', app.source.ref], { cwd: appDir });
    }
  } else if (app.source?.type === 'zip') {
    const zipPath = path.resolve(workspace, app.source.path);
    if (!existsSync(zipPath)) throw new Error(`Zip source not found for ${app.id}: ${zipPath}`);
    await unpackZip(zipPath, appDir, app.source.stripTopLevel !== false);
  } else {
    throw new Error(`Unsupported source type for ${app.id}: ${app.source?.type}`);
  }

  for (const step of app.install || []) {
    const [command, ...args] = step.map(part => interpolate(part, appDir));
    await run(command, args, { cwd: appDir });
  }

  const skills = await discoverSkills(appDir);

  return {
    id: app.id,
    name: app.name || app.id,
    description: app.description || '',
    skills,
    transport: {
      ...app.transport,
      cwd: interpolate(app.transport?.cwd || appDir, appDir),
      command: interpolate(app.transport?.command, appDir),
      args: (app.transport?.args || []).map(arg => interpolate(arg, appDir))
    },
    envPassthrough: app.envPassthrough || []
  };
}

async function main() {
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  await fs.mkdir(installRoot, { recursive: true });

  const installed = [];
  for (const app of config.apps || []) {
    console.log(`Installing MCP app: ${app.id}`);
    installed.push(await installApp(app));
  }

  await fs.writeFile(outputPath, `${JSON.stringify({ apps: installed }, null, 2)}\n`);
  console.log(`Wrote installed app manifest: ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
