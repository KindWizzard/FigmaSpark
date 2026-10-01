import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { ensureConfig, DEFAULT_CONFIG } from '../bridge/config.mjs';

let pluginId, externalManifest;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (!['--plugin-id', '--manifest'].includes(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('Usage: npm run setup -- --plugin-id FIGMA_ID (or --manifest path/to/Figma-created/manifest.json)');
  if (flag === '--plugin-id') pluginId = process.argv[++i];
  else externalManifest = process.argv[++i];
}
if (pluginId && externalManifest) throw new Error('Choose --plugin-id or --manifest.');
const path = new URL('../plugin/manifest.json', import.meta.url);
let current;
try { current = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (externalManifest) pluginId = JSON.parse(await readFile(externalManifest, 'utf8')).id;
pluginId ??= current?.id;
if (!/^\d{6,32}$/.test(pluginId ?? '')) throw new Error('Create a plugin in Figma Desktop → Plugins → Development → New plugin, then run setup with its manifest ID.');
const port = Number(process.env.FIGMA_SPARK_PORT || 3847);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FIGMA_SPARK_PORT.');
await ensureConfig(process.env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG, port);
const manifest = JSON.parse(await readFile(new URL('../plugin/manifest.template.json', import.meta.url), 'utf8'));
manifest.id = pluginId;
manifest.networkAccess.allowedDomains = [`http://localhost:${port}`, `ws://localhost:${port}`];
if (current) {
  const backups = new URL('../.runtime/manifest-backups/', import.meta.url);
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await copyFile(path, new URL(`${Date.now()}.json`, backups));
}
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
await import('./build.mjs');
console.log('Ready: import plugin/manifest.json in Figma, then npm start.');
