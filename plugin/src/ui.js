import { animatePump } from './pump.js';
import { connectionPrompt } from './onboarding.js';

const canvas = document.getElementById('pump');
const pump = animatePump(canvas);
const preview = window.parent === window;
let socket, sessionId, connectURL, context = {}, reconnectTimer, reconnectAttempt = 0;
let code = __SPARK_PAIRING_CODE__;
let state = 'offline';
const pending = new Map(), samples = [];
const encoder = new TextEncoder();

function toPlugin(message) {
  if (!preview) window.parent.postMessage({ pluginMessage: message }, '*');
}
function setState(value) {
  state = value;
  pump.setState(value);
  const label = { offline: 'Нет связи', connecting: 'Подключение', connected: 'На связи', error: 'Ошибка соединения' }[value];
  canvas.setAttribute('aria-label', label + '. Скопировать инструкции для ИИ');
}
function updateLoad() {
  const now = Date.now();
  while (samples.length && now - samples[0].at > 2000) samples.shift();
  pump.setLoad(samples.reduce((sum, sample) => sum + sample.bytes, 0) / 2, pending.size);
}
function measure(bytes, direction) {
  samples.push({ at: Date.now(), bytes });
  pump.packet(bytes, direction);
  updateLoad();
}
setInterval(updateLoad, 500);

function connect() {
  clearTimeout(reconnectTimer);
  if (!code) { setState('offline'); return; }
  if (socket) { socket.onclose = null; socket.close(); }
  pending.clear();
  sessionId = undefined;
  connectURL = undefined;
  setState('connecting');
  try { socket = new WebSocket(__SPARK_BRIDGE_URL__.replace('http:', 'ws:').replace('127.0.0.1', 'localhost') + '/plugin'); }
  catch { setState('error'); return; }
  const current = socket;
  const timer = setTimeout(() => { if (!sessionId) current.close(); }, 5000);
  socket.onopen = () => {
    current.send(JSON.stringify({ type: 'hello', protocol: 1, token: code, clientId: context.clientId, context }));
  };
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'connected') {
      clearTimeout(timer);
      sessionId = message.sessionId;
      connectURL = message.connectURL;
      reconnectAttempt = 0;
      setState('connected');
      toPlugin({ type: 'settings', settings: { code } });
    } else if (message.type === 'request') {
      pending.set(message.id, performance.now());
      measure(encoder.encode(event.data).length, 'in');
      toPlugin(message);
    } else if (message.type === 'cancel') {
      pending.delete(message.id);
      updateLoad();
      toPlugin(message);
    }
  };
  socket.onerror = () => setState('error');
  socket.onclose = event => {
    clearTimeout(timer);
    if (socket !== current) return;
    sessionId = undefined;
    connectURL = undefined;
    for (const id of pending.keys()) toPlugin({ type: 'cancel', id });
    pending.clear();
    updateLoad();
    setState(event.code === 4001 ? 'error' : 'offline');
    if (event.code === 4001 && __SPARK_PAIRING_CODE__ && code !== __SPARK_PAIRING_CODE__) code = __SPARK_PAIRING_CODE__;
    // Fast first retry, bounded backoff when the bridge is stopped.
    const delay = Math.min(250 * 2 ** Math.min(reconnectAttempt++, 3), 2000);
    reconnectTimer = setTimeout(connect, delay);
  };
}
window.addEventListener('message', event => {
  const message = event.data?.pluginMessage;
  if (!message) return;
  if (message.type === 'init') {
    context = message.context;
    code = message.settings?.code || code;
    if (!preview) connect();
  } else if (message.type === 'event') {
    context = { ...context, ...message.data };
    if (socket?.readyState === WebSocket.OPEN && sessionId) socket.send(JSON.stringify(message));
  } else if (message.type === 'response') {
    if (!pending.has(message.id)) return;
    pending.delete(message.id);
    if (!message.ok) pump.error();
    if (socket?.readyState === WebSocket.OPEN && sessionId) {
      const json = JSON.stringify(message);
      measure(encoder.encode(json).length, 'out');
      socket.send(json);
    }
    updateLoad();
  }
});

function instructions() {
  return connectionPrompt({ url: connectURL || __SPARK_BRIDGE_URL__ + '/connect', online: state === 'connected', startCommand: __SPARK_SERVICE_COMMAND__ });
}
async function copyInstructions() {
  const text = instructions();
  try {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
      document.body.append(input);
      input.focus(); input.select();
      const copied = document.execCommand('copy');
      input.remove(); canvas.focus();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    document.getElementById('feedback').textContent = 'Инструкции скопированы';
    pump.copied();
  } catch {
    document.getElementById('feedback').textContent = 'Не удалось скопировать инструкции';
    pump.error();
  }
}
canvas.onclick = copyInstructions;
canvas.onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyInstructions(); }
};
toPlugin({ type: 'ready' });
if (preview) {
  context = { fileName: 'Предпросмотр FigmaSpark' };
  const params = new URLSearchParams(location.search);
  setState(params.get('state') || 'connected');
  if (params.get('traffic')) measure(Number(params.get('traffic')), 'out');
}
