import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_LOAD, desktopSettingsPath, fileKeyFromPath, openTabs, resolveTab, findFileKey, figmaURL, bringToFront, sessionVisibility } from '../scripts/desktop.mjs';

const settings = { windows: [{ tabs: [
  { path: '/file/rUciRbAWtggayhJywgfWqE', title: 'Счета и транзакции' },
  { path: '/design/ZZpHDjjrzLTzEOhnxrG5YO/Deposits', title: 'Депозиты и выводы' },
  { path: '/design/AAAA1111/branch/BBBB2222', title: 'Игроки' },
  { path: '/file/CCCC3333', title: 'Копия' },
  { path: '/file/DDDD4444', title: 'Копия' },
  { path: '/files/team/123', title: 'Home' }
] }] };

test('the Figma connection timeout of a background tab is recognized', () => {
  assert.ok(BACKGROUND_LOAD.test('Unable to establish connection to Figma after 10 seconds. Please check your internet connection.'));
  assert.ok(!BACKGROUND_LOAD.test('Node not found'));
});

test('tab paths give file keys, branches win over the main file', () => {
  assert.equal(fileKeyFromPath('/file/rUciRbAWtggayhJywgfWqE'), 'rUciRbAWtggayhJywgfWqE');
  assert.equal(fileKeyFromPath('/design/ZZpHDjjrzLTzEOhnxrG5YO/Deposits'), 'ZZpHDjjrzLTzEOhnxrG5YO');
  assert.equal(fileKeyFromPath('/design/AAAA1111/branch/BBBB2222'), 'BBBB2222');
  assert.equal(fileKeyFromPath('/files/team/123'), null);
  assert.equal(fileKeyFromPath(undefined), null);
});

test('an open tab is resolved by file name only when the name is unique', () => {
  const tabs = openTabs(settings);
  assert.equal(tabs.length, 5);
  assert.deepEqual(resolveTab(tabs, 'Счета и транзакции'), { fileKey: 'rUciRbAWtggayhJywgfWqE' });
  assert.deepEqual(resolveTab(tabs, 'Игроки'), { fileKey: 'BBBB2222' });
  assert.match(resolveTab(tabs, 'Копия').reason, /Several open/);
  assert.match(resolveTab(tabs, 'Нет такого').reason, /No open Figma Desktop tab/);
  assert.deepEqual(openTabs({}), []);
});

test('desktop settings are read from the platform location or an override', async t => {
  assert.equal(desktopSettingsPath('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/Figma/settings.json');
  assert.equal(desktopSettingsPath('win32', { APPDATA: 'C:\\Roaming' }, 'C:\\Users\\u'), join('C:\\Roaming', 'Figma', 'settings.json'));
  assert.equal(desktopSettingsPath('linux', {}, '/home/u'), null);
  assert.equal(desktopSettingsPath('linux', { FIGMA_DESKTOP_SETTINGS: '/x.json' }, '/home/u'), '/x.json');
  const directory = await mkdtemp(join(tmpdir(), 'figma-spark-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings.json');
  await writeFile(path, JSON.stringify(settings));
  assert.deepEqual(await findFileKey('Депозиты и выводы', path), { fileKey: 'ZZpHDjjrzLTzEOhnxrG5YO' });
  assert.match((await findFileKey('Игроки', join(directory, 'missing.json'))).reason, /unreadable/);
  assert.match((await findFileKey('Игроки', null)).reason, /macOS and Windows/);
});

test('figma links carry the node id in URL form', () => {
  assert.equal(figmaURL('rUciRbAWtggayhJywgfWqE', '1823:16153'), 'figma://file/rUciRbAWtggayhJywgfWqE?node-id=1823-16153');
  assert.equal(figmaURL('rUciRbAWtggayhJywgfWqE'), 'figma://file/rUciRbAWtggayhJywgfWqE');
  assert.throws(() => figmaURL('../evil', '1:2'), /Invalid Figma file key/);
});

function fakeApi(pages, context = {}) {
  const calls = [];
  return {
    calls,
    async rpc(command, params, session) {
      calls.push({ command, session });
      const page = pages.length > 1 ? pages.shift() : pages[0];
      return { ok: true, result: { fileName: 'Счета и транзакции', fileKey: null, page, ...context } };
    }
  };
}

test('bringToFront opens the file tab on the page and waits until the editor shows it', async () => {
  const opened = [];
  const api = fakeApi([{ id: '1:2' }, { id: '1:2' }, { id: '1823:16153' }]);
  const moved = await bringToFront(api, 'session-1', { pageId: '1823:16153' }, {
    find: async name => (name === 'Счета и транзакции' ? { fileKey: 'rUciRbAWtggayhJywgfWqE' } : { reason: 'missing' }),
    open: async url => { opened.push(url); }, sleep: async () => {}
  });
  assert.deepEqual(opened, ['figma://file/rUciRbAWtggayhJywgfWqE?node-id=1823-16153']);
  assert.equal(moved.page.id, '1823:16153');
  assert.ok(api.calls.every(call => call.command === 'context' && call.session === 'session-1'));
});

test('a known plugin fileKey skips the desktop lookup; a node link waits for the page change', async () => {
  const opened = [];
  const api = fakeApi([{ id: '1:2' }, { id: '5:5' }], { fileKey: 'KEY123' });
  const moved = await bringToFront(api, undefined, { nodeId: '5:10' }, {
    find: async () => { throw new Error('must not read desktop state'); },
    open: async url => { opened.push(url); }, sleep: async () => {}
  });
  assert.deepEqual(opened, ['figma://file/KEY123?node-id=5-10']);
  assert.equal(moved.page.id, '5:5');
});

test('bringToFront reports a missing tab and a page that never opens', async () => {
  await assert.rejects(bringToFront(fakeApi([{ id: '1:2' }]), 's', { pageId: '9:9' }, { find: async () => ({ reason: 'No open Figma Desktop tab is named "X".' }), open: async () => {}, sleep: async () => {} }), error => error.code === 'TAB_NOT_FOUND' && /Open the file tab/.test(error.message));
  await assert.rejects(bringToFront(fakeApi([{ id: '1:2' }]), 's', { pageId: '9:9' }, { timeoutMs: 30, find: async () => ({ fileKey: 'K1' }), open: async () => {}, sleep: () => new Promise(resolve => setTimeout(resolve, 5)) }), error => error.code === 'PAGE_UNAVAILABLE');
});

test('visibility comes from bridge status and stays unknown for older plugins', async () => {
  const api = visible => ({ async status() { return { sessions: [{ id: 's1', visible }, { id: 's2', visible: true }] }; } });
  assert.equal(await sessionVisibility(api(false), 's1'), false);
  assert.equal(await sessionVisibility(api(null), 's1'), null);
  assert.equal(await sessionVisibility(api(false), undefined), null);
  assert.equal(await sessionVisibility({ async status() { return { sessions: [{ id: 'only', visible: true }] }; } }, undefined), true);
  assert.equal(await sessionVisibility({ async status() { throw new Error('down'); } }, 's1'), null);
  assert.equal(await sessionVisibility({}, 's1'), null);
});

test('a page that never opens in a hidden Figma window asks to bring the window forward', async () => {
  const api = { ...fakeApi([{ id: '1:2' }]), async status() { return { sessions: [{ id: 's', visible: false }] }; } };
  await assert.rejects(bringToFront(api, 's', { pageId: '9:9' }, { timeoutMs: 30, find: async () => ({ fileKey: 'K1' }), open: async () => {}, sleep: () => new Promise(resolve => setTimeout(resolve, 5)) }), error => error.code === 'PAGE_UNAVAILABLE' && /stays hidden/.test(error.message));
});
