#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The source skill works inside a clone; installation adds a non-secret pointer.
const args = process.argv.slice(2);
let marker = {};
try { marker = JSON.parse(await readFile(new URL('../.figma-spark-install.json', import.meta.url), 'utf8')); } catch {}
let entrypoint = marker.project ? resolve(marker.project, 'scripts/spark.mjs') : fileURLToPath(new URL('../../../scripts/spark.mjs', import.meta.url));
try { await access(entrypoint); }
catch {
  const index = args.indexOf('--connect');
  const input = index >= 0 ? args[index + 1] : args[0] === 'connect' ? args[1] : undefined;
  const url = new URL(input || '/connect', marker.bridgeURL || 'http://127.0.0.1:3847');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/connect') throw new Error('FigmaSpark discovery requires a loopback /connect URL.');
  url.searchParams.set('format', 'json');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const manifest = await response.json();
  if (!response.ok || manifest.product !== 'FigmaSpark' || manifest.protocol !== 1 || !manifest.local?.cli) throw new Error('Start the local FigmaSpark service to locate its CLI.');
  entrypoint = manifest.local.cli;
}
const { main } = await import(pathToFileURL(entrypoint).href);
main(args).catch(error => { console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'CLI_ERROR', message: error.message } })); process.exitCode = 1; });
