#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../bridge/config.mjs';

export function parseArgs(args) {
  const options = {}, positionals = [];
  const booleans = new Set(['include-hidden', 'prototype', 'css', 'no-segments', 'no-components', 'refresh', 'segments', 'components', 'help']);
  const known = new Set([...booleans, 'connect', 'session', 'input', 'out', 'params', 'nodes', 'page', 'scope', 'depth', 'max-nodes', 'sample-nodes', 'detail', 'limit', 'offset', 'revision', 'format', 'max-dimension', 'scale', 'types', 'match', 'timeout']);
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (!argument.startsWith('--')) { positionals.push(argument); continue; }
    const key = argument.slice(2);
    if (!known.has(key)) throw new Error(`Unknown option: --${key}`);
    if (booleans.has(key)) { options[key] = true; continue; }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = args[++i];
  }
  return { command: positionals[0], argument: positionals.slice(1).join(' '), options };
}

export function client(config) {
  async function request(path, body, timeoutMs = 20000) {
    let response;
    try {
      response = await fetch(new URL(path, config.url), {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs + 2000)
      });
    } catch (error) { throw Object.assign(new Error(`Local bridge is not reachable. Run npm run service -- start in FigmaSpark. (${error.message})`, { cause: error }), { code: 'BRIDGE_UNAVAILABLE' }); }
    const data = await response.json();
    const jsonBytes = Number(response.headers.get('x-spark-json-bytes'));
    const wireBytes = Number(response.headers.get('content-length'));
    if (jsonBytes) data.transfer = { jsonBytes, wireBytes: wireBytes || jsonBytes, encoding: response.headers.get('content-encoding') || 'identity' };
    if (!response.ok || !data.ok) {
      const error = new Error(data.error?.message ?? `HTTP ${response.status}`);
      error.code = data.error?.code ?? 'HTTP_ERROR';
      throw error;
    }
    return data;
  }
  return {
    status: () => request('/status'),
    rpc: (command, params, sessionId, timeoutMs = 20000) => request('/rpc', { command, params, sessionId, timeoutMs }, timeoutMs)
  };
}

export async function discover(input = 'http://127.0.0.1:3847/connect') {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/connect') {
    throw new Error('Use a local FigmaSpark /connect URL copied by the mascot.');
  }
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const manifest = await response.json();
  if (!response.ok || !manifest.ok || manifest.product !== 'FigmaSpark' || manifest.protocol !== 1 || !manifest.local?.configPath) throw new Error('The local service did not return a compatible FigmaSpark instruction.');
  const config = await readConfig(manifest.local.configPath);
  const local = new URL(config.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) || local.protocol !== url.protocol || local.port !== url.port) throw new Error('Local config does not belong to this FigmaSpark port.');
  return { manifest, config };
}

async function parameters(options, command, argument) {
  let params = {};
  if (options.input) {
    const input = JSON.parse(await readFile(resolve(options.input), 'utf8'));
    params = input.result && !input.requirements && !input.findings && !input.operations ? input.result : input;
  }
  if (options.params) params = { ...params, ...JSON.parse(options.params) };
  const fields = { nodes: 'nodeIds', page: 'pageId', scope: 'scope', depth: 'depth', 'max-nodes': 'maxNodes', 'sample-nodes': 'sampleNodes', detail: 'detail', limit: 'limit', offset: 'offset', revision: 'revision', format: 'format', 'max-dimension': 'maxDimension', scale: 'scale', types: 'types', match: 'match' };
  const numeric = new Set(['depth', 'maxNodes', 'sampleNodes', 'limit', 'offset', 'revision', 'maxDimension', 'scale']);
  for (const [option, field] of Object.entries(fields)) {
    if (options[option] === undefined) continue;
    params[field] = numeric.has(field) ? Number(options[option]) : ['nodeIds', 'types'].includes(field) ? options[option].split(',').map(value => value.trim()).filter(Boolean) : options[option];
  }
  if (options['include-hidden']) params.includeHidden = true;
  if (options.prototype) params.prototype = true;
  if (options.css) params.css = true;
  if (options['no-segments']) params.textSegments = false;
  if (options['no-components']) params.components = false;
  if (options.segments) params.textSegments = true;
  if (options.components) params.components = true;
  if (options.refresh) params.refresh = true;
  if (command === 'search' && argument) params.query = argument;
  return params;
}

async function saveJSON(path, data) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(data, null, 2) + '\n');
  return absolute;
}
async function saveExports(directory, data) {
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: true });
  const images = [];
  for (const image of data.result.images) {
    const extension = { PNG: 'png', JPG: 'jpg', SVG: 'svg' }[image.format];
    if (!extension || typeof image.base64 !== 'string') throw new Error('Invalid export response.');
    const filename = `${image.nodeId.replace(/[^a-zA-Z0-9_-]/g, '-')}.${extension}`;
    const path = join(absolute, filename);
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length !== image.byteLength) throw new Error('Export byte length mismatch.');
    await writeFile(path, bytes);
    const { base64, ...metadata } = image;
    images.push({ ...metadata, path });
  }
  const result = { ...data, result: { ...data.result, images } };
  await saveJSON(join(absolute, 'exports.json'), result);
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const { command, argument, options } = parseArgs(args);
  if (!command || options.help || command === 'help') {
    console.log(`FigmaSpark — direct local Figma access (no MCP)

Usage: node scripts/spark.mjs <command> [options]

Commands:
  connect [LOCAL_URL]   (retrieve live instructions and confirm the selected file)
  status, pair, ping, context, pages, selection, styles, variables
  overview   [--page ID | --nodes ID,ID] [--sample-nodes 160]
  search     "text or layer name" [--scope file | --page ID] [--types TEXT,INSTANCE]
  snapshot   [--nodes ID,ID | --scope page] [--detail summary|review|full] [--out FILE]
  libraries  [--nodes ID,ID] [--limit 30] (referenced definitions, keys, styles, modes)
  capture    [--nodes ID,ID] --out DIRECTORY
  inspect    --nodes ID,ID [--css]
  export     [--nodes ID,ID] --out DIRECTORY [--format PNG|SVG|JPG]
  audit      --input RULES.json [--out review.json]
  report     --input REPORT.json (store findings; present in chat or a saved file)
  last-report [--out FILE]
  focus      [--nodes ID,ID | --page ID]
  patch      --input PATCH.json (requires the native allow-edits entry in Figma)
  bench      [--limit 10]

Common: --connect LOCAL_URL, --session ID, --params JSON, --input JSON, --timeout MS,
        --depth N, --max-nodes N, --limit N, --offset N, --revision N,
        --include-hidden, --prototype, --segments, --components, --refresh
Start with overview, then search and read only relevant frames.
The plugin stays open in the Design file being reviewed.`);
    return;
  }
  const connection = command === 'connect' || options.connect ? await discover(options.connect || argument || undefined) : null;
  const config = connection?.config ?? await readConfig();
  if (command === 'pair') { console.log(config.pairingCode); return; }
  const api = client(config);
  if (command === 'connect') {
    const status = await api.status();
    const selected = status.sessions.find(session => session.id === connection.manifest.sessionId);
    console.log(JSON.stringify({ ok: true, instructions: connection.manifest.connectURL, skill: connection.manifest.skill, local: connection.manifest.local, session: selected ?? null, sessions: selected ? undefined : status.sessions, next: selected ? `overview --session ${selected.id}` : 'Choose a file from sessions, then overview --session ID' }, null, 2));
    return;
  }
  if (command === 'status') { console.log(JSON.stringify(await api.status(), null, 2)); return; }
  const params = await parameters(options, command, argument);
  const timeout = options.timeout ? Number(options.timeout) : 20000;
  const session = options.session || (connection?.manifest.sessionAvailable ? connection.manifest.sessionId : null) || process.env.FIGMA_SPARK_SESSION;
  if (command === 'bench') {
    const count = params.limit ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Benchmark limit must be 1–50.');
    const durations = [];
    for (let i = 0; i < count; i++) durations.push((await api.rpc('ping', {}, session, timeout)).durationMs);
    const sorted = [...durations].sort((a, b) => a - b);
    const result = { command: 'ping', samples: count, minMs: sorted[0], medianMs: sorted[Math.floor(count / 2)], p95Ms: sorted[Math.min(count - 1, Math.ceil(count * .95) - 1)], maxMs: sorted.at(-1), durationsMs: durations };
    if (options.out) await saveJSON(options.out, result);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'capture') {
    const directory = resolve(options.out ?? 'output/capture');
    const captureParams = { limit: 500, ...params };
    const first = await api.rpc('snapshot', captureParams, session, timeout);
    const snapshot = first.result;
    if (snapshot.coverage.changedDuringRead) throw new Error('Design changed while capturing. Repeat the capture.');
    let offset = snapshot.nextOffset;
    while (offset !== null) {
      const page = await api.rpc('snapshot', { ...captureParams, offset, revision: snapshot.revision }, first.sessionId, timeout);
      if (page.result.coverage.changedDuringRead) throw new Error('Design changed while capturing. Repeat the capture.');
      snapshot.nodes.push(...page.result.nodes);
      offset = page.result.nextOffset;
    }
    snapshot.nextOffset = null;
    snapshot.coverage.returned = snapshot.nodes.length;
    const path = await saveJSON(join(directory, 'snapshot.json'), first);
    await saveJSON(join(directory, 'context.json'), snapshot.context);
    const roots = snapshot.rootIds.filter(id => snapshot.nodes.find(node => node.id === id)?.type !== 'PAGE');
    let images = [];
    for (let index = 0; index < roots.length; index += 4) {
      const exports = await api.rpc('export', { nodeIds: roots.slice(index, index + 4), maxDimension: params.maxDimension ?? 1600 }, first.sessionId, timeout);
      const saved = await saveExports(join(directory, 'images'), exports);
      images.push(...saved.result.images);
    }
    const manifest = { ok: true, sessionId: first.sessionId, context: snapshot.context, snapshot: path, coverage: snapshot.coverage, images };
    await saveJSON(join(directory, 'capture.json'), manifest);
    console.log(JSON.stringify(manifest, null, 2)); return;
  }
  let result = await api.rpc(command, params, session, timeout);
  if (command === 'export') result = await saveExports(options.out ?? 'output/exports', result);
  else if (options.out) {
    const path = await saveJSON(options.out, result);
    console.log(JSON.stringify({ ok: true, sessionId: result.sessionId, durationMs: result.durationMs, transfer: result.transfer, cache: result.result?.cache, saved: path, ...(command === 'audit' ? { summary: result.result.findings.map(finding => ({ requirementId: finding.requirementId, status: finding.status })) } : {}) }, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'CLI_ERROR', message: error.message } })); process.exitCode = 1; });
}
