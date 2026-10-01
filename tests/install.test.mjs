import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { installSkill, installOptions } from '../scripts/install-skill.mjs';

test('editor installation paths use the requested local skill scope', () => {
  assert.equal(installOptions(['--editor', 'codex'], '/example').destination, '/example/.agents/skills/figma-spark');
  assert.equal(installOptions(['--editor', 'cursor'], '/example').destination, '/example/.cursor/skills/figma-spark');
  assert.equal(installOptions(['--editor', 'claude'], '/example').destination, '/example/.claude/skills/figma-spark');
  assert.throws(() => installOptions(['--editor', 'other']), /Unknown editor/);
});

test('installed skill runs its CLI; replacement is explicit and preserves a backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spark-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'skills', 'figma-spark');
  const result = await installSkill({ destination });
  assert.equal(result.installed, destination);
  assert.equal(result.backup, null);
  const marker = await readFile(join(destination, '.figma-spark-install.json'), 'utf8');
  assert.ok(!marker.includes('pairingCode') && !marker.includes('token'));
  if (process.platform !== 'win32') assert.equal((await lstat(join(destination, '.figma-spark-install.json'))).mode & 0o777, 0o600);
  const { stdout } = await promisify(execFile)(process.execPath, [join(destination, 'scripts', 'spark.mjs'), 'help']);
  assert.ok(stdout.includes('overview') && stdout.includes('connect [LOCAL_URL]'));
  await assert.rejects(installSkill({ destination }), /already exists/);
  await writeFile(join(destination, 'local-note.txt'), 'Keep my local note');
  const update = await installSkill({ destination, update: true });
  t.after(() => rm(update.backup, { recursive: true, force: true }));
  assert.equal(await readFile(join(update.backup, 'local-note.txt'), 'utf8'), 'Keep my local note');
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), await readFile('skills/figma-spark/SKILL.md', 'utf8'));
});
