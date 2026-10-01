#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureConfig, DEFAULT_CONFIG } from '../bridge/config.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const entry = join(project, 'bridge', 'server.mjs');

export function serviceOptions(env = process.env) {
  const port = Number(env.FIGMA_SPARK_PORT || 3847);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port from 1024 to 65535.');
  const configPath = resolve(env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG);
  return { port, configPath, directory: dirname(configPath) };
}

async function probe(config) {
  let response;
  try {
    response = await fetch(new URL('/status', config.url), {
      headers: { Authorization: `Bearer ${config.token}`, Connection: 'close' },
      redirect: 'error', signal: AbortSignal.timeout(1000)
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw new Error(`Cannot check the local service: ${error.message}`, { cause: error });
  }
  const status = await response.json().catch(() => null);
  if (!response.ok || !status?.ok || status.protocol !== 1 || status.service?.project !== project || !Number.isInteger(status.service.pid)) {
    throw new Error('The port is occupied by another or older service. Stop it before starting this FigmaSpark version.');
  }
  return status;
}

export async function startService(options = serviceOptions()) {
  const config = await ensureConfig(options.configPath, options.port);
  const running = await probe(config);
  if (running) return { ok: true, state: 'running', alreadyRunning: true, pid: running.service.pid, url: config.url };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const logPath = join(options.directory, 'bridge.log');
  const log = await open(logPath, 'a', 0o600);
  await chmod(logPath, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, FIGMA_SPARK_CONFIG: options.configPath, FIGMA_SPARK_PORT: String(options.port) }
    });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await probe(config);
    if (status) {
      const record = { pid: status.service.pid, url: config.url, configPath: options.configPath, startedAt: status.stats.startedAt };
      const recordPath = join(options.directory, 'service.json');
      await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      await chmod(recordPath, 0o600);
      return { ok: true, state: 'running', alreadyRunning: false, pid: record.pid, url: config.url, logPath };
    }
    await delay(100);
  }
  throw new Error(`FigmaSpark did not start. Check ${logPath}.`);
}

export async function serviceStatus(options = serviceOptions()) {
  const config = await ensureConfig(options.configPath, options.port);
  const status = await probe(config);
  return { ok: true, state: status ? 'running' : 'stopped', ...(status ? { pid: status.service.pid, sessions: status.sessions.length } : {}), url: config.url };
}

export async function stopService(options = serviceOptions()) {
  const config = await ensureConfig(options.configPath, options.port);
  const status = await probe(config);
  if (!status) return { ok: true, state: 'stopped', alreadyStopped: true };
  // The authenticated server identifies itself; never trust a stale PID file.
  process.kill(status.service.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let current;
    try { current = await probe(config); }
    catch (error) {
      // SIGTERM can close a just-accepted HTTP socket while Figma WebSockets drain.
      // Retry until the listener actually refuses connections before declaring it stopped.
      if (!['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(error.cause?.cause?.code)) throw error;
      await delay(100);
      continue;
    }
    if (!current) {
      await rm(join(options.directory, 'service.json'), { force: true });
      return { ok: true, state: 'stopped', pid: status.service.pid };
    }
    if (current.service.pid !== status.service.pid) throw new Error('Another FigmaSpark process took over the port; it was left running.');
    await delay(100);
  }
  throw new Error('The service did not stop within five seconds.');
}

export async function main(args = process.argv.slice(2)) {
  const action = args[0] || 'start';
  if (args.length > 1 || !['start', 'status', 'stop', 'restart'].includes(action)) throw new Error('Usage: node scripts/service.mjs start|status|stop|restart');
  if (action === 'restart') { await stopService(); return startService(); }
  return action === 'start' ? startService() : action === 'stop' ? stopService() : serviceStatus();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
