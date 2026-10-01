import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['plugin/src/code.ts'], bundle: true, write: false, target: 'es2017', format: 'iife', platform: 'neutral' });
const script = bundle.outputFiles[0].text;

function fixtureNode(id, extra = {}) {
  return { id, name: 'Original', type: 'RECTANGLE', x: 0, y: 0, width: 100, height: 50, visible: true, opacity: 1, fills: [], resize(width, height) { this.width = width; this.height = height; }, ...extra };
}
function harness(nodes, { loadFont = async () => {}, command = 'connect', extraPages = [] } = {}) {
  let undoCount = 0;
  const waiting = new Map();
  const page = { id: '0:1', name: 'Fixture page', type: 'PAGE', children: nodes, selection: nodes, on() {}, off() {}, async loadAsync() {} };
  const root = { name: 'Fixture', children: [page, ...extraPages] }; page.parent = root;
  for (const other of extraPages) other.parent = root;
  for (const node of nodes) node.parent = page;
  const figma = {
    root, currentPage: page, command, editorType: 'figma', fileKey: undefined, mixed: Symbol('mixed'),
    showUI() {}, on() {}, notify() {}, skipInvisibleInstanceChildren: false,
    clientStorage: { async getAsync() {}, async setAsync() {} },
    ui: { postMessage(message) { if (message.type === 'response') { waiting.get(message.id)?.(message); waiting.delete(message.id); } }, resize() {} },
    async getNodeByIdAsync(id) { return nodes.find(node => node.id === id) ?? null; },
    async loadFontAsync(font) { await loadFont(font); },
    commitUndo() { undoCount++; },
    viewport: { scrollAndZoomIntoView() {} }
  };
  vm.runInNewContext(script, { figma, __html__: '', console, setTimeout, clearTimeout });
  let sequence = 0;
  return {
    figma,
    undoCount: () => undoCount,
    request(command, params) {
      const id = `test-${++sequence}`;
      return new Promise(resolve => { waiting.set(id, resolve); figma.ui.onmessage({ type: 'request', id, command, params }); });
    }
  };
}

test('plugin rejects writes in read-only mode and native edit entry applies an undoable bounded patch', async () => {
  const node = fixtureNode('1:1');
  const plugin = harness([node]);
  const params = { operations: [{ nodeId: node.id, changes: { name: 'Updated', opacity: .5 } }] };
  assert.equal((await plugin.request('patch', params)).error.code, 'WRITE_DISABLED');
  assert.equal(node.name, 'Original');
  plugin.figma.ui.onmessage({ type: 'write-permission', enabled: true });
  assert.equal((await plugin.request('patch', params)).error.code, 'WRITE_DISABLED');
  const editing = harness([node], { command: 'edit' });
  assert.equal((await editing.request('patch', params)).ok, true);
  assert.equal(node.name, 'Updated'); assert.equal(node.opacity, .5); assert.equal(editing.undoCount(), 1);
  assert.equal((await editing.request('context', {})).result.revision, 1);
});

test('all nodes are validated before changing the first node', async () => {
  const first = fixtureNode('1:1'), second = fixtureNode('1:2');
  const plugin = harness([first, second], { command: 'edit' });
  const result = await plugin.request('patch', { operations: [
    { nodeId: first.id, changes: { name: 'Changed' } },
    { nodeId: second.id, expected: { opacity: .2 }, changes: { name: 'Changed' } }
  ] });
  assert.equal(result.error.code, 'STALE_PATCH'); assert.equal(first.name, 'Original');
});

test('expected values include properties not being changed', async () => {
  const node = fixtureNode('1:1');
  const plugin = harness([node], { command: 'edit' });
  const result = await plugin.request('patch', { operations: [{ nodeId: node.id, expected: { name: 'Different title' }, changes: { opacity: .5 } }] });
  assert.equal(result.error.code, 'STALE_PATCH'); assert.equal(node.opacity, 1);
});

test('font loading cannot overwrite a value changed during the await', async () => {
  const node = fixtureNode('1:1', { type: 'TEXT', fontName: { family: 'Inter', style: 'Regular' }, characters: 'Before', fontSize: 12, getRangeAllFontNames() { return [this.fontName]; } });
  const plugin = harness([node], { command: 'edit', loadFont: async () => { node.characters = 'User edit'; } });
  const result = await plugin.request('patch', { operations: [{ nodeId: node.id, expected: { characters: 'Before' }, changes: { fontSize: 24 } }] });
  assert.equal(result.error.code, 'STALE_PATCH'); assert.equal(node.fontSize, 12); assert.equal(node.characters, 'User edit');
});

test('a failing setter restores earlier mutations and both dimensions', async () => {
  const first = fixtureNode('1:1', { resize(width, height) { this.width = width; this.height = width === 200 ? 77 : height; } });
  let secondName = 'Original';
  const second = fixtureNode('1:2');
  Object.defineProperty(second, 'name', { get: () => secondName, set(value) { if (value === 'explode') throw new Error('Setter failed'); secondName = value; } });
  const plugin = harness([first, second], { command: 'edit' });
  const result = await plugin.request('patch', { operations: [{ nodeId: first.id, changes: { name: 'Changed', width: 200 } }, { nodeId: second.id, changes: { name: 'explode' } }] });
  assert.equal(result.ok, false); assert.equal(first.name, 'Original'); assert.equal(first.width, 100); assert.equal(first.height, 50); assert.equal(second.name, 'Original');
});

test('plugin exposes no arbitrary code execution command', async () => {
  const plugin = harness([fixtureNode('1:1')]);
  assert.equal((await plugin.request('execute', { code: 'figma.currentPage.remove()' })).error.code, 'UNKNOWN_COMMAND');
});

test('an already loaded page is read through its index without a network lookup or reload', async () => {
  const screen = fixtureNode('2:1', { type: 'FRAME', children: [] });
  const other = { id: '2:0', name: 'Other page', type: 'PAGE', children: [screen], on() {}, async loadAsync() { throw 'Network is offline'; } }; screen.parent = other;
  const plugin = harness([], { extraPages: [other] });
  const response = await plugin.request('overview', { pageId: other.id });
  assert.equal(response.ok, true);
  assert.equal(response.result.blocks[0].id, screen.id);
  assert.equal(plugin.figma.currentPage.id, '0:1');
});

test('an unloaded page reports the actual Figma connection failure without claiming empty coverage', async () => {
  const other = { id: '2:0', name: 'Unloaded page', type: 'PAGE', on() {}, get children() { throw 'Load this page first'; }, async loadAsync() { throw 'Network is offline'; } };
  const plugin = harness([], { extraPages: [other] });
  const response = await plugin.request('overview', { pageId: other.id });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PAGE_UNAVAILABLE');
  assert.ok(response.error.message.includes('Network is offline'));
});
