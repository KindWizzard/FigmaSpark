#!/usr/bin/env node
import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../bridge/config.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
export function desktopConfigPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  throw new Error('Use --config PATH for a supported Claude Desktop installation.');
}

export async function installClaudeDesktop({ configPath = desktopConfigPath(), update = false } = {}) {
  const destination = resolve(configPath);
  let previous;
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Claude config must be a regular file, not a symlink.');
    previous = await readFile(destination, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = previous === undefined ? {} : JSON.parse(previous);
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Claude config has an unsupported format; it was left unchanged.');
  const server = { command: process.execPath, args: [join(project, 'bridge', 'claude.mjs')], env: { FIGMA_SPARK_CONFIG: resolve(process.env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG), FIGMA_SPARK_PORT: process.env.FIGMA_SPARK_PORT || '3847' } };
  const existing = config.mcpServers?.['figma-spark'];
  if (existing && JSON.stringify(existing) === JSON.stringify(server)) return { ok: true, installed: destination, alreadyInstalled: true, backup: null, restartRequired: true };
  if (existing && !update) throw new Error('figma-spark is already configured differently. Use --update to replace that entry with a backup.');
  let backup = null;
  if (previous !== undefined) {
    const backupDirectory = join(project, '.runtime', 'claude-backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    backup = join(backupDirectory, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(backup, previous, { mode: 0o600, flag: 'wx' });
  }
  config.mcpServers = { ...config.mcpServers, 'figma-spark': server };
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    let current;
    try { current = await readFile(destination, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== previous) throw new Error('Claude config changed during installation. Retry; the concurrent change was preserved.');
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return { ok: true, installed: destination, alreadyInstalled: false, backup, restartRequired: true };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--update') options.update = true;
    else if (args[i] === '--config' && args[i + 1]) options.configPath = args[++i];
    else throw new Error('Usage: node scripts/install-claude-desktop.mjs [--config PATH] [--update]');
  }
  return installClaudeDesktop(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
