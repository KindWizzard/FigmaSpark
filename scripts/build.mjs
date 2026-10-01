import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ensureConfig, DEFAULT_CONFIG } from '../bridge/config.mjs';
import { shellQuote, PROJECT_ROOT } from '../bridge/bootstrap.mjs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const connection = await ensureConfig(process.env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG, Number(process.env.FIGMA_SPARK_PORT || 3847));
await mkdir(new URL('plugin/dist/', root), { recursive: true });
await build({
  entryPoints: [new URL('plugin/src/code.ts', root).pathname],
  outfile: new URL('plugin/dist/code.js', root).pathname,
  bundle: true,
  target: 'es2017',
  format: 'iife',
  platform: 'neutral',
  logLevel: 'warning'
});
const uiBundle = await build({
  entryPoints: [new URL('plugin/src/ui.js', root).pathname],
  bundle: true,
  write: false,
  target: 'es2020',
  format: 'iife',
  platform: 'browser',
  loader: { '.png': 'dataurl' },
  define: {
    __SPARK_PAIRING_CODE__: JSON.stringify(connection.pairingCode),
    __SPARK_BRIDGE_URL__: JSON.stringify(connection.url),
    __SPARK_SERVICE_COMMAND__: JSON.stringify([process.execPath, join(PROJECT_ROOT, 'scripts', 'service.mjs'), 'start'].map(shellQuote).join(' '))
  },
  logLevel: 'warning'
});
const template = await readFile(new URL('plugin/src/ui.html', root), 'utf8');
const css = await readFile(new URL('plugin/src/ui.css', root), 'utf8');
const html = template.replace('/* INLINE_STYLES */', css)
  .replace('/* INLINE_SCRIPT */', uiBundle.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await writeFile(new URL('plugin/dist/ui.html', root), html);
console.log('FigmaSpark built → plugin/dist');
