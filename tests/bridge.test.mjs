import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import http from 'node:http';
import { createBridge } from '../bridge/server.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, client } from '../scripts/spark.mjs';

const token = 'test-agent-token';
const pairingCode = 'test-plugin-code';
const bridges = [];
after(async () => { for (const bridge of bridges) await bridge.close(); });

async function setup() {
  const bridge = createBridge({ token, pairingCode, port: 0, heartbeatMs: 3000 });
  bridges.push(bridge);
  const address = await bridge.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const call = async (path, body, auth = token) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const plugin = async (clientId = 'client-one') => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/plugin', { origin: 'null' });
    await once(ws, 'open');
    const connected = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: pairingCode, clientId, context: { fileName: 'Fixture', page: { id: '0:1', name: 'Page 1' } } }));
    const [data] = await connected;
    const message = JSON.parse(data.toString());
    return { ws, sessionId: message.sessionId, connectURL: message.connectURL };
  };
  return { bridge, url, call, plugin };
}

test('HTTP commands require local authentication and reject DNS rebinding', async () => {
  const { url, call } = await setup();
  assert.equal((await call('/health', null, '')).status, 200);
  assert.equal((await call('/status', null, 'wrong')).status, 401);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(url + '/status', { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await call('/rpc', { command: 'execute', params: { code: 'evil' } })).data.error.code, 'UNKNOWN_COMMAND');
});

test('connection code and Figma origin are validated', async () => {
  const { url } = await setup();
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/plugin', { origin: 'null' });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'wrong', clientId: 'x', context: {} }));
  assert.equal((await closed)[0], 4001);
  const hostile = new WebSocket(url.replace('http:', 'ws:') + '/plugin', { origin: 'https://evil.example' });
  const [error] = await once(hostile, 'error');
  assert.match(error.message, /403/);
});

test('routes concurrent requests by ID and returns measured round-trip time', async () => {
  const { call, plugin } = await setup();
  const { ws } = await plugin();
  const requests = [];
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'request') return;
    requests.push(message);
    if (requests.length === 2) for (const request of [...requests].reverse()) ws.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { command: request.command } }));
  });
  const results = await Promise.all([call('/rpc', { command: 'context' }), call('/rpc', { command: 'selection' })]);
  assert.deepEqual(results.map(r => r.data.result.command), ['context', 'selection']);
  assert.ok(results.every(r => r.data.durationMs >= 0 && r.status === 200));
});

test('requires explicit file choice when multiple Figma files are connected', async () => {
  const { call, plugin } = await setup();
  const first = await plugin('one'); await plugin('two');
  assert.equal((await call('/rpc', { command: 'ping' })).data.error.code, 'AMBIGUOUS_SESSION');
  first.ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'request') first.ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: 'first' }));
  });
  assert.equal((await call('/rpc', { command: 'ping', sessionId: first.sessionId })).data.result, 'first');
});

test('timeout cancels a queued command; disconnect rejects in-flight requests', async () => {
  const { call, plugin } = await setup();
  const { ws } = await plugin();
  const cancel = new Promise(resolve => ws.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'cancel') resolve(message); }));
  const result = await call('/rpc', { command: 'snapshot', timeoutMs: 100 });
  assert.equal(result.status, 504);
  assert.equal((await cancel).type, 'cancel');
  ws.on('message', data => { if (JSON.parse(data.toString()).type === 'request') ws.close(); });
  const disconnected = await call('/rpc', { command: 'context' });
  assert.equal(disconnected.data.error.code, 'DISCONNECTED');
});

test('a response from another session cannot satisfy a request', async () => {
  const { call, plugin } = await setup();
  const first = await plugin('one'), second = await plugin('two');
  first.ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'request') return;
    second.ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: 'wrong file' }));
    setTimeout(() => first.ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: 'correct file' })), 20);
  });
  const result = await call('/rpc', { command: 'context', sessionId: first.sessionId });
  assert.equal(result.data.result, 'correct file');
});

test('self-test travels through the bridge and the plugin handler', async () => {
  const { plugin } = await setup();
  const { ws } = await plugin();
  const result = new Promise(resolve => ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'request') ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: { pong: true } }));
    if (message.type === 'test-result') resolve(message);
  }));
  ws.send(JSON.stringify({ type: 'test' }));
  assert.ok((await result).durationMs >= 0);
});

test('large JSON responses use negotiated compression and remain readable to the CLI', async () => {
  const { call, plugin } = await setup();
  const { ws } = await plugin();
  assert.ok(ws.extensions.includes('permessage-deflate'));
  const text = 'Players / Apply filters / '.repeat(1000);
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'request') ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result: { text } }));
  });
  const result = await call('/rpc', { command: 'overview' });
  assert.equal(result.data.result.text, text);
});

test('hosted instructions and skill are discoverable without exposing credentials or design content', async () => {
  const { url, call, plugin } = await setup();
  const { sessionId, connectURL } = await plugin();
  assert.equal(new URL(connectURL).searchParams.get('session'), sessionId);
  const response = await fetch(connectURL);
  assert.match(response.headers.get('content-type'), /text\/markdown/);
  const text = await response.text();
  assert.ok(text.includes('/skills/figma-spark/SKILL.md'));
  assert.ok(text.includes(sessionId));
  assert.ok(!text.includes(token) && !text.includes(pairingCode) && !text.includes('Fixture'));
  const manifest = await (await fetch(connectURL + '&format=json')).json();
  assert.equal(manifest.sessionAvailable, true);
  assert.equal(manifest.workflow.first, 'overview');
  assert.equal(manifest.workflow.defaultBatchSize, 100);
  const skill = await fetch(manifest.skill.url);
  assert.equal(skill.status, 200);
  assert.match(await skill.text(), /^---\nname: figma-spark/);
  assert.equal((await fetch(url + '/skills/figma-spark/scripts/spark.mjs')).status, 200);
  assert.equal((await fetch(url + '/skills/figma-spark/not-a-resource')).status, 404);
  assert.equal((await call('/status', null, '')).status, 401);
  assert.equal((await call('/preview', null, '')).status, 401);
  assert.equal((await fetch(url + '/connect?session=wrong')).status, 400);
});

test('discovery loads local credentials and scopes a read to the session in the copied URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spark-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'connection.json');
  const bridge = createBridge({ token, pairingCode, port: 0, configPath });
  bridges.push(bridge);
  const address = await bridge.listen();
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(configPath, JSON.stringify({ url, token, pairingCode }), { mode: 0o600 });
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/plugin', { origin: 'null' });
  await once(ws, 'open');
  const connected = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: pairingCode, clientId: 'discovery-fixture', context: { fileName: 'Expected file' } }));
  const [bytes] = await connected;
  const message = JSON.parse(bytes.toString());
  ws.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.type === 'request') ws.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { first: request.command } }));
  });
  const connection = await discover(message.connectURL);
  assert.equal(connection.config.token, token);
  assert.equal(connection.manifest.sessionId, message.sessionId);
  const overview = await client(connection.config).rpc('overview', {}, connection.manifest.sessionId);
  assert.equal(overview.result.first, 'overview');
  await assert.rejects(discover('https://example.com/connect'), /local FigmaSpark/);
  ws.close();
  await once(ws, 'close');
  const stale = await (await fetch(message.connectURL + '&format=json')).json();
  assert.equal(stale.sessionAvailable, false);
});
