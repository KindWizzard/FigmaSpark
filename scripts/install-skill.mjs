import { cp, mkdir, writeFile, readFile, lstat, rename, rm, mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../bridge/config.mjs';

export const PROJECT = fileURLToPath(new URL('../', import.meta.url));

export function installOptions(args, userHome = homedir()) {
  let editor = 'codex', destination, update = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--update') { update = true; continue; }
    if (!['--editor', '--dest'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: install-skill.mjs [--editor codex|cursor|claude] [--dest SKILL_DIRECTORY] [--update]');
    if (args[i] === '--editor') editor = args[++i];
    else destination = resolve(args[++i]);
  }
  const folders = { codex: '.agents', cursor: '.cursor', claude: '.claude' };
  if (!folders[editor]) throw new Error('Unknown editor. Use --dest for another Agent Skills editor.');
  return { editor, destination: destination ?? join(userHome, folders[editor], 'skills', 'figma-spark'), update };
}

export async function installSkill({ destination, editor = 'codex', update = false, project = PROJECT }) {
  let existing;
  try { existing = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Destination must be a regular skill directory.');
  if (existing && !update) throw new Error(`Skill already exists: ${destination}. Use --update to back it up and update it.`);
  if (existing && !/^name:\s*figma-spark\s*$/m.test(await readFile(join(destination, 'SKILL.md'), 'utf8'))) throw new Error('Destination is not a figma-spark skill.');
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), '.figma-spark-stage-'));
  let backup;
  let backupReady = false;
  try {
    await cp(join(project, 'skills', 'figma-spark'), stage, { recursive: true });
    const config = await readConfig().catch(() => ({ url: 'http://127.0.0.1:3847' }));
    await writeFile(join(stage, '.figma-spark-install.json'), JSON.stringify({ product: 'FigmaSpark', version: '0.2.0', project, bridgeURL: config.url, editor }, null, 2) + '\n', { mode: 0o600 });
    if (existing) {
      backup = join(project, '.runtime', 'skill-backups', `${Date.now()}-${randomUUID()}`);
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await cp(destination, backup, { recursive: true, errorOnExist: true, force: false });
      backupReady = true;
      await rm(destination, { recursive: true });
    }
    await rename(stage, destination);
    return { ok: true, editor, installed: destination, backup: backup ?? null, next: 'Use figma-spark in your editor. If it is not discovered, reload the editor.' };
  } catch (error) {
    if (backupReady) {
      await rm(destination, { recursive: true, force: true });
      await cp(backup, destination, { recursive: true });
    }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installSkill(installOptions(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
