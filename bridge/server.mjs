import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { ensureConfig, DEFAULT_CONFIG } from './config.mjs';
import { PROTOCOL, SparkError, validateRequest } from './protocol.mjs';
import { PROJECT_ROOT, SKILL_FILES, connectionManifest, connectionMarkdown } from './bootstrap.mjs';
import { join } from 'node:path';

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function figmaOrigin(origin) {
  if (origin === undefined || origin === 'null' || origin === 'file://') return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com'));
  } catch { return false; }
}

export function createBridge({ token, pairingCode, port = 3847, heartbeatMs = 15000, configPath = DEFAULT_CONFIG } = {}) {
  if (!token || !pairingCode) throw new Error('Bridge credentials are required.');
  const sessions = new Map();
  const pending = new Map();
  const recent = [];
  const stats = { commands: 0, errors: 0, receivedBytes: 0, sentBytes: 0, startedAt: new Date().toISOString() };
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 24 * 1024 * 1024,
    perMessageDeflate: { threshold: 4096, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 1 } }
  });

  function sendJSON(res, status, data) {
    const json = Buffer.from(JSON.stringify(data));
    const compress = res.sparkGzip && json.length >= 4096;
    const bytes = compress ? gzipSync(json, { level: 1 }) : json;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes.length, 'X-Spark-JSON-Bytes': json.length, ...(compress ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    res.end(bytes);
  }

  function publicSession(session) {
    return {
      id: session.id, clientId: session.clientId, context: session.context,
      connectedAt: session.connectedAt, lastSeenAt: session.lastSeenAt,
      pending: [...pending.values()].filter(p => p.sessionId === session.id).length
    };
  }

  function bootstrap(sessionId = null) {
    return connectionManifest({ url: `http://127.0.0.1:${server.address()?.port ?? port}`, sessionId, sessionAvailable: sessions.has(sessionId), configPath });
  }

  function sendText(res, type, value) {
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(value);
  }

  function chooseSession(sessionId) {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new SparkError('SESSION_NOT_FOUND', 'The requested Figma session is not connected.', 404);
      return session;
    }
    if (!sessions.size) throw new SparkError('NOT_CONNECTED', 'Open FigmaSpark in a Figma Design file and connect it.', 503);
    if (sessions.size > 1) throw new SparkError('AMBIGUOUS_SESSION', 'Multiple files are connected. Choose a sessionId from status.', 409);
    return sessions.values().next().value;
  }

  function rpc(request) {
    const session = chooseSession(request.sessionId);
    if (session.ws.readyState !== WebSocket.OPEN) throw new SparkError('DISCONNECTED', 'Figma disconnected.', 503);
    if ([...pending.values()].filter(p => p.sessionId === session.id).length >= 32) {
      throw new SparkError('QUEUE_FULL', 'This Figma file already has 32 pending requests.', 429);
    }
    const id = randomUUID();
    const started = performance.now();
    const payload = JSON.stringify({ type: 'request', id, command: request.command, params: request.params });
    stats.commands += 1;
    stats.sentBytes += Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        stats.errors += 1;
        if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'cancel', id }));
        reject(new SparkError('TIMEOUT', 'Figma did not respond before the request timeout. The result was discarded.', 504));
      }, request.timeoutMs);
      pending.set(id, { sessionId: session.id, timer, resolve, reject, started, command: request.command });
      session.ws.send(payload, error => {
        if (!error) return;
        const item = pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(id);
        reject(new SparkError('DISCONNECTED', 'Could not send the request to Figma.', 503));
      });
    });
  }

  async function readJSON(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512 * 1024) throw new SparkError('TOO_LARGE', 'Request exceeds 512 KiB.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SparkError('INVALID_JSON', 'Request must contain valid JSON.'); }
  }

  const server = http.createServer(async (req, res) => {
    res.sparkGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    try {
      if (!validHost(req.headers.host)) throw new SparkError('INVALID_HOST', 'Only loopback hosts are accepted.', 403);
      const requestURL = new URL(req.url, 'http://127.0.0.1');
      const pathname = requestURL.pathname;
      if (req.method === 'GET' && pathname === '/health') {
        return sendJSON(res, 200, { ok: true, product: 'FigmaSpark', protocol: PROTOCOL });
      }
      if (req.method === 'GET' && pathname === '/connect') {
        const sessionId = requestURL.searchParams.get('session');
        if (sessionId && !/^[0-9a-f-]{36}$/.test(sessionId)) throw new SparkError('INVALID_SESSION', 'Use the session ID supplied by the plugin.');
        const manifest = bootstrap(sessionId);
        return requestURL.searchParams.get('format') === 'json' ? sendJSON(res, 200, manifest) : sendText(res, 'text/markdown', connectionMarkdown(manifest));
      }
      const skillPrefix = '/skills/figma-spark/';
      if (req.method === 'GET' && pathname.startsWith(skillPrefix)) {
        const relative = pathname.slice(skillPrefix.length);
        if (!SKILL_FILES.has(relative)) throw new SparkError('NOT_FOUND', 'Unknown skill resource.', 404);
        return sendText(res, SKILL_FILES.get(relative), await readFile(join(PROJECT_ROOT, 'skills', 'figma-spark', relative), 'utf8'));
      }
      if (!sameSecret(req.headers.authorization, `Bearer ${token}`)) {
        throw new SparkError('UNAUTHORIZED', 'Use the local FigmaSpark CLI or an authenticated request.', 401);
      }
      if (req.method === 'GET' && pathname === '/status') {
        return sendJSON(res, 200, { ok: true, protocol: PROTOCOL, transport: { socket: 'persistent-websocket', format: 'json', largeMessages: 'deflate/gzip', compressionThreshold: 4096 }, sessions: [...sessions.values()].map(publicSession), stats, recent });
      }
      if (req.method === 'GET' && pathname === '/preview') {
        return sendText(res, 'text/html', await readFile(new URL('../plugin/dist/ui.html', import.meta.url), 'utf8'));
      }
      if (req.method === 'POST' && pathname === '/rpc') {
        const result = await rpc(validateRequest(await readJSON(req)));
        return sendJSON(res, 200, result);
      }
      throw new SparkError('NOT_FOUND', 'Unknown endpoint.', 404);
    } catch (error) {
      if (!res.destroyed) sendJSON(res, error.status ?? 500, { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } });
    }
  });

  function validHost(host) {
    // Check the host as well as binding loopback to avoid DNS rebinding.
    return ['127.0.0.1', 'localhost', '[::1]'].some(name => host === name || host === `${name}:${server.address()?.port ?? port}`);
  }

  server.requestTimeout = 125000;
  server.keepAliveTimeout = 60000;
  server.on('upgrade', (req, socket, head) => {
    socket.setNoDelay(true);
    if (!validHost(req.headers.host) || !figmaOrigin(req.headers.origin) || req.url !== '/plugin') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    let session;
    let alive = true;
    const authTimer = setTimeout(() => ws.close(4001, 'Authentication timeout'), 5000);
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, heartbeatMs);
    heartbeat.unref();
    ws.on('message', data => {
      stats.receivedBytes += data.length;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { ws.close(4002, 'Invalid JSON'); return; }
      if (!session) {
        if (message.type !== 'hello' || message.protocol !== PROTOCOL || !sameSecret(message.token, pairingCode)) {
          ws.close(4001, 'Invalid connection code');
          return;
        }
        if (typeof message.clientId !== 'string' || message.clientId.length > 100 || !message.context || typeof message.context !== 'object') {
          ws.close(4002, 'Invalid hello');
          return;
        }
        clearTimeout(authTimer);
        // Replace a reconnect of this plugin instance without confusing in-flight replies.
        for (const old of sessions.values()) if (old.clientId === message.clientId) old.ws.close(4000, 'Reconnected');
        session = {
          id: randomUUID(), clientId: message.clientId, context: message.context, ws,
          connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
        };
        sessions.set(session.id, session);
        ws.send(JSON.stringify({ type: 'connected', sessionId: session.id, protocol: PROTOCOL, connectURL: bootstrap(session.id).connectURL }));
        return;
      }
      session.lastSeenAt = new Date().toISOString();
      if (message.type === 'test') {
        rpc({ command: 'ping', params: {}, timeoutMs: 5000, sessionId: session.id })
          .then(result => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'test-result', durationMs: result.durationMs })); })
          .catch(error => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'test-error', message: error.message })); });
        return;
      }
      if (message.type === 'event') {
        if (message.event === 'context') session.context = message.data;
        else if (['selection', 'document', 'page', 'permission'].includes(message.event)) {
          if (message.data?.page) session.context.page = message.data.page;
          if (message.data?.selection) session.context.selection = message.data.selection;
          if (Number.isInteger(message.data?.revision)) session.context.revision = message.data.revision;
          if (typeof message.data?.writeEnabled === 'boolean') session.context.writeEnabled = message.data.writeEnabled;
        }
        return;
      }
      if (message.type !== 'response') return;
      const item = pending.get(message.id);
      if (!item || item.sessionId !== session.id) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      const durationMs = Math.round((performance.now() - item.started) * 10) / 10;
      recent.push({ command: item.command, sessionId: session.id, durationMs, ok: message.ok === true, at: new Date().toISOString() });
      if (recent.length > 30) recent.shift();
      if (message.ok !== true) {
        stats.errors += 1;
        item.reject(new SparkError(message.error?.code ?? 'PLUGIN_ERROR', message.error?.message ?? 'Figma command failed.', 422));
      } else {
        item.resolve({ ok: true, sessionId: session.id, durationMs, executionMs: message.executionMs, result: message.result });
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (!session) return;
      sessions.delete(session.id);
      for (const [id, item] of pending) {
        if (item.sessionId !== session.id) continue;
        clearTimeout(item.timer);
        pending.delete(id);
        item.reject(new SparkError('DISCONNECTED', 'FigmaSpark was closed or disconnected.', 503));
      }
    });
  });

  return {
    server, sessions,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FIGMA_SPARK_PORT || 3847);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FIGMA_SPARK_PORT.');
  const configPath = process.env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG;
  const config = await ensureConfig(configPath, port);
  const bridge = createBridge({ ...config, port, configPath });
  try { await bridge.listen(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const response = await fetch(`${config.url}/status`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(2000) });
      const status = await response.json();
      if (response.ok && status.ok && status.protocol === PROTOCOL) {
        console.log(`FigmaSpark is already running at ${config.url}`);
        process.exit(0);
      }
    } catch {}
    throw new Error(`Port ${port} is used by another service. Close that service or choose another port and update the plugin manifest/UI.`);
  }
  console.log(`FigmaSpark listening on ${config.url}`);
  console.log(`AI instructions: ${config.url}/connect`);
  console.log(`Import plugin/manifest.json in Figma → Plugins → Development.`);
  console.log('Keep this process running while reviewing designs.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await bridge.close(); process.exit(0); });
}
