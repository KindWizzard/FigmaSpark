import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = fileURLToPath(new URL('../.runtime/connection.json', import.meta.url));

export async function readConfig(path = process.env.FIGMA_SPARK_CONFIG || DEFAULT_CONFIG) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config.token || !config.pairingCode || !config.url) throw new Error('Invalid FigmaSpark connection config.');
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('FigmaSpark requires a local HTTP bridge.');
  }
  return config;
}

export async function ensureConfig(path = DEFAULT_CONFIG, port = 3847) {
  try {
    const config = await readConfig(path);
    if (new URL(config.url).port === String(port)) return config;
    throw new Error(`Config uses a different port. Use a separate config file for port ${port}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = {
    url: `http://127.0.0.1:${port}`,
    token: randomBytes(32).toString('base64url'),
    pairingCode: randomBytes(8).toString('hex'),
    protocol: 1
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return config;
}
