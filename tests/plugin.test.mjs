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

test('a page of a background file tab reports how to load it', async () => {
  const timeout = 'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';
  const unloaded = { id: '9:1', name: 'Unloaded', type: 'PAGE', on() {}, off() {}, get children() { throw new Error('Page is not loaded'); }, async loadAsync() { throw new Error(timeout); } };
  const plugin = harness([fixtureNode('1:1')], { extraPages: [unloaded] });
  plugin.figma.setCurrentPageAsync = async () => { throw new Error(timeout); };
  const read = await plugin.request('overview', { pageId: '9:1' });
  assert.equal(read.error.code, 'PAGE_UNAVAILABLE');
  assert.match(read.error.message, /Unloaded/);
  assert.match(read.error.message, /file tab is in front and its window is visible: run focus --page 9:1/);
  const focus = await plugin.request('focus', { pageId: '9:1' });
  assert.equal(focus.error.code, 'PAGE_UNAVAILABLE');
  const other = { id: '9:2', name: 'Broken', type: 'PAGE', on() {}, off() {}, get children() { throw new Error('Page is not loaded'); }, async loadAsync() { throw new Error('Page was deleted'); } };
  const plain = harness([fixtureNode('1:1')], { extraPages: [other] });
  const failure = await plain.request('overview', { pageId: '9:2' });
  assert.equal(failure.error.code, 'PAGE_UNAVAILABLE');
  assert.doesNotMatch(failure.error.message, /file tab is in front/);
});


function container(id, extra = {}) {
  const node = fixtureNode(id, { type: 'FRAME', children: [], ...extra });
  node.appendChild = child => { child.parent?.children && child.parent.children.splice(child.parent.children.indexOf(child), 1); node.children.push(child); child.parent = node; };
  node.insertChild = (index, child) => { child.parent?.children && child.parent.children.splice(child.parent.children.indexOf(child), 1); node.children.splice(index, 0, child); child.parent = node; };
  node.findAll = () => node.children;
  return node;
}

test('patch accepts gradients, constraints and in-place text replacement', async () => {
  const rect = fixtureNode('1:1', { constraints: { horizontal: 'MIN', vertical: 'MIN' }, rotation: 0 });
  let text = 'At 1X2 we play';
  const runs = [];
  const label = fixtureNode('1:2', { type: 'TEXT', fontName: { family: 'Inter', style: 'Regular' }, getRangeAllFontNames() { return [this.fontName]; },
    get characters() { return text; },
    insertCharacters(start, chars) { runs.push(['insert', start, chars]); text = text.slice(0, start) + chars + text.slice(start); },
    deleteCharacters(start, end) { runs.push(['delete', start, end]); text = text.slice(0, start) + text.slice(end); } });
  const plugin = harness([rect, label], { command: 'edit' });
  const gradient = { type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 }, extra: 'dropped' }] };
  const result = await plugin.request('patch', { operations: [
    { nodeId: rect.id, changes: { fills: [gradient], constraints: { horizontal: 'SCALE', vertical: 'SCALE' }, rotation: 12 } },
    { nodeId: label.id, changes: { textReplace: [{ from: '1X2', to: 'AstroBet' }] } }
  ] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(rect.fills[0].type, 'GRADIENT_LINEAR'); assert.equal(rect.fills[0].gradientStops[1].extra, undefined);
  assert.equal(JSON.stringify(rect.constraints), JSON.stringify({ horizontal: 'SCALE', vertical: 'SCALE' })); assert.equal(rect.rotation, 12);
  assert.equal(text, 'At AstroBet we play');
  assert.equal(runs[0][0], 'insert');
});

test('patch rejects image paints and unknown text', async () => {
  const rect = fixtureNode('1:1');
  const plugin = harness([rect], { command: 'edit' });
  assert.equal((await plugin.request('patch', { operations: [{ nodeId: rect.id, changes: { fills: [{ type: 'IMAGE', imageHash: 'x' }] } }] })).error.code, 'INVALID_PATCH');
});

test('build creates from SVG, makes a component, swaps an instance and removes layers last', async () => {
  const frame = container('1:1');
  const old = fixtureNode('1:3', { name: 'Old', type: 'VECTOR', remove() { this.removed = true; frame.children.splice(frame.children.indexOf(this), 1); } });
  const instance = fixtureNode('1:4', { type: 'INSTANCE', name: 'Logo', async getMainComponentAsync() { return this.main; }, swapComponent(component) { this.main = component; } });
  instance.main = { id: '0:9', type: 'COMPONENT' };
  frame.children.push(old, instance); old.parent = frame; instance.parent = frame;
  const nodes = [frame, old, instance];
  const plugin = harness(nodes, { command: 'edit' });
  plugin.figma.createNodeFromSvg = svg => { const made = container('9:1', { name: 'svg', remove() { this.removed = true; } }); made.svg = svg; made.rescale = function (f) { this.width *= f; this.height *= f; }; nodes.push(made); return made; };
  plugin.figma.createComponentFromNode = source => { const component = { ...source, id: '9:2', type: 'COMPONENT', remove() { this.removed = true; } }; nodes.push(component); return component; };
  const result = await plugin.request('build', { steps: [
    { action: 'createSvg', parentId: frame.id, svg: '<svg viewBox="0 0 10 10"><path d="M0 0H10V10Z"/></svg>', as: 'mark', fitWidth: 200, name: 'Mark' },
    { action: 'componentize', nodeId: '$mark', as: 'logo', description: 'AstroBet' },
    { action: 'swap', nodeId: instance.id, componentId: '$logo', expectedComponentId: '0:9' },
    { action: 'remove', nodeId: old.id, expected: { name: 'Old', type: 'VECTOR' } }
  ] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.result.refs.logo, '9:2');
  assert.equal(instance.main.id, '9:2');
  assert.equal(old.removed, true);
  assert.equal(plugin.undoCount(), 1);
});

test('build refuses scripts in SVG, unexpected removals and rolls back created layers', async () => {
  const frame = container('1:1');
  const nodes = [frame];
  const plugin = harness(nodes, { command: 'edit' });
  let made;
  plugin.figma.createNodeFromSvg = () => { made = container('9:1', { remove() { this.removed = true; } }); return made; };
  const script = await plugin.request('build', { steps: [{ action: 'createSvg', parentId: frame.id, svg: '<svg><script>alert(1)</script></svg>' }] });
  assert.equal(script.error.code, 'INVALID_BUILD');
  const stale = await plugin.request('build', { steps: [
    { action: 'createSvg', parentId: frame.id, svg: '<svg/>' },
    { action: 'remove', nodeId: frame.id, expected: { name: 'Something else', type: 'FRAME' } }
  ] });
  assert.equal(stale.error.code, 'STALE_PATCH');
  assert.equal(made.removed, true);
  const readOnly = harness([frame]);
  assert.equal((await readOnly.request('build', { steps: [{ action: 'remove', nodeId: frame.id }] })).error.code, 'WRITE_DISABLED');
});


test('a missing font can be swapped for an available one on the range it covers', async () => {
  let text = 'Use italics: 1X2';
  const fonts = [{ family: 'Brand', style: 'Regular' }, { family: 'Brand', style: 'Bold Italic' }];
  const ranges = [{ start: 0, end: 13, font: fonts[0] }, { start: 13, end: 16, font: fonts[1] }];
  const set = [];
  const label = fixtureNode('1:2', { type: 'TEXT', fontName: Symbol('mixed'), get characters() { return text; },
    getStyledTextSegments() { return ranges.map(r => ({ start: r.start, end: r.end, fontName: r.font })); },
    setRangeFontName(start, end, font) { set.push([start, end, font.family]); for (const r of ranges) if (r.start >= start && r.end <= end) r.font = font; },
    insertCharacters(start, chars) { text = text.slice(0, start) + chars + text.slice(start); },
    deleteCharacters(start, end) { text = text.slice(0, start) + text.slice(end); } });
  const loadFont = async font => { if (font.style === 'Bold Italic' && font.family === 'Brand') throw new Error('missing'); };
  const plugin = harness([label], { command: 'edit', loadFont });
  const refused = await plugin.request('patch', { operations: [{ nodeId: label.id, changes: { textReplace: [{ from: '1X2', to: 'AstroBet' }] } }] });
  assert.equal(refused.error.code, 'FONT_UNAVAILABLE'); assert.equal(text, 'Use italics: 1X2');
  const result = await plugin.request('patch', { operations: [{ nodeId: label.id, changes: { textReplace: [{ from: '1X2', to: 'AstroBet' }], rangeFontName: [{ start: 13, end: 16, family: 'Open', style: 'Bold Italic' }] } }] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(set[0][2], 'Open'); assert.equal(text, 'Use italics: AstroBet');
});
