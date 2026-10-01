import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { serviceOptions, serviceStatus, startService, stopService } from '../scripts/service.mjs';

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('background bridge survives its launcher and supports idempotent start and safe stop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spark-service-'));
  const env = { ...process.env, FIGMA_SPARK_CONFIG: join(directory, 'connection.json'), FIGMA_SPARK_PORT: String(await unusedPort()) };
  const options = serviceOptions(env);
  t.after(async () => { await stopService(options); await rm(directory, { recursive: true, force: true }); });
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/service.mjs', 'start'], { env, timeout: 10000 });
  const started = JSON.parse(stdout);
  assert.equal(started.state, 'running');
  // execFile has returned: its parent launcher is gone, but the bridge still responds.
  assert.equal((await serviceStatus(options)).pid, started.pid);
  const again = await startService(options);
  assert.equal(again.pid, started.pid);
  assert.equal(again.alreadyRunning, true);
  const record = await readFile(join(directory, 'service.json'), 'utf8');
  assert.ok(!record.includes('token') && !record.includes('pairingCode'));
  const config = JSON.parse(await readFile(env.FIGMA_SPARK_CONFIG, 'utf8'));
  const plugin = new WebSocket(config.url.replace('http:', 'ws:') + '/plugin');
  await once(plugin, 'open');
  const connected = once(plugin, 'message');
  plugin.send(JSON.stringify({ type: 'hello', protocol: 1, token: config.pairingCode, clientId: 'service-lifecycle', context: {} }));
  await connected;
  const closed = once(plugin, 'close');
  await stopService(options);
  await closed;
  assert.equal((await serviceStatus(options)).state, 'stopped');
  const restarted = await startService(options);
  assert.notEqual(restarted.pid, started.pid);
  assert.equal((await serviceStatus(options)).state, 'running');
});

test('service control refuses an unrelated listener without terminating it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spark-occupied-'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"protocol":1}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const options = serviceOptions({ FIGMA_SPARK_CONFIG: join(directory, 'connection.json'), FIGMA_SPARK_PORT: String(server.address().port) });
  await assert.rejects(startService(options), /another or older service/);
  await assert.rejects(stopService(options), /another or older service/);
  assert.equal((await fetch(`http://127.0.0.1:${options.port}/status`)).status, 200);
});
