import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['plugin/src/catalog.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { ReadCache, buildOverview, pageIndex, screenFor, textExcerpt, componentCatalog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function node(id, name, type = 'FRAME', children = []) {
  const result = { id, name, type, children, visible: true, parent: null };
  for (const child of children) child.parent = result;
  return result;
}

test('page overview reads metadata without loading other page layer trees', () => {
  const unloaded = { id: 'p2', name: 'Library', get children() { throw new Error('Page is not loaded'); } };
  assert.deepEqual(pageIndex([{ id: 'p1', name: 'Players' }, unloaded], 'p1'), [
    { id: 'p1', name: 'Players', current: true }, { id: 'p2', name: 'Library', current: false }
  ]);
});

test('overview finds screens inside sections and labels are bounded evidence samples', async () => {
  const title = node('text', 'Title', 'TEXT'); title.characters = 'Players';
  const screen = node('screen', 'Frame 42', 'FRAME', [title, ...Array.from({ length: 50 }, (_, i) => node('x'+i, 'Control', 'INSTANCE'))]);
  const page = node('page', 'Players', 'PAGE', [node('section', 'Active layouts', 'SECTION', [screen])]);
  const result = await buildOverview([page], { sampleNodes: 4 }, () => false);
  assert.deepEqual(result.blocks.map(b => b.id), ['section', 'screen']);
  assert.equal(result.coverage.detail, 'outline');
  assert.deepEqual(result.blocks[1].textHints, ['Players']);
  assert.ok(result.blocks.every(b => b.sample.scanned <= 4));
  assert.equal(result.blocks[1].sample.truncated, true);
  await assert.rejects(buildOverview([page], {}, () => true), error => error.code === 'CANCELLED');
});

test('cached reads invalidate after edits and an invalidated in-flight traversal is not cached', async () => {
  const cache = new ReadCache();
  const root = node('r', 'Screen', 'FRAME', Array.from({ length: 170 }, (_, i) => node(String(i), 'Text', 'TEXT')));
  const pending = cache.walk([root], {}, () => false);
  cache.clear(); await pending;
  assert.equal((await cache.walk([root], {}, () => false)).cached, false);
  assert.equal((await cache.walk([root], {}, () => false)).cached, true);
  cache.clear();
  assert.equal((await cache.walk([root], {}, () => false)).cached, false);
});

test('overview omits decorative layers but preserves standalone notes and bounds auto-generated names', async () => {
  const note = node('note', 'Paragraph'.repeat(500), 'SHAPE_WITH_TEXT');
  note.text = { characters: 'Status changes require a reason. '.repeat(50) };
  const page = node('page', 'Players', 'PAGE', [note, node('arrow', 'Connector', 'CONNECTOR'), node('screen', 'Screen'.repeat(100), 'FRAME')]);
  const overview = await buildOverview([page], {}, () => false);
  assert.deepEqual(overview.blocks.map(block => block.id), ['screen']);
  assert.equal(overview.blocks[0].nameTruncated, true);
  assert.ok(overview.blocks[0].name.length <= 122);
  assert.equal(overview.notes[0].id, 'note');
  assert.ok(overview.notes[0].text.includes('require a reason'));
  assert.ok(overview.notes[0].text.length <= 142);
});

test('compact review preserves actual text and instance overrides without resolving library definitions', async () => {
  const cache = new ReadCache();
  const text = node('text', 'Title', 'TEXT');
  text.characters = 'Real override'; text.fontSize = 28;
  text.getStyledTextSegments = () => { throw new Error('Expensive segmentation should be opt-in'); };
  assert.equal((await cache.node(text, { detail: 'review' })).value.characters, 'Real override');
  const instance = node('button', 'Primary button', 'INSTANCE');
  instance.componentProperties = { Label: { type: 'TEXT', value: 'Apply filters' } };
  instance.getMainComponentAsync = () => { throw new Error('Definition should be opt-in'); };
  const first = await cache.node(instance, { detail: 'review' });
  assert.equal(first.value.componentProperties.Label.value, 'Apply filters');
  assert.equal((await cache.node(instance, { detail: 'review' })).cached, true);
  instance.componentProperties = { Label: { type: 'TEXT', value: 'Updated by designer' } };
  cache.clear();
  assert.equal((await cache.node(instance, { detail: 'review' })).value.componentProperties.Label.value, 'Updated by designer');
});

test('search result points to the containing screen and excerpts keep the matched phrase', () => {
  const text = node('text', 'Label', 'TEXT');
  const outer = node('screen', 'Players screen', 'FRAME', [node('form', 'Form', 'FRAME', [text])]);
  node('page', 'Players', 'PAGE', [outer]);
  assert.deepEqual(screenFor(text), { id: 'screen', name: 'Players screen' });
  const excerpt = textExcerpt('A'.repeat(500) + ' Reset filters ' + 'B'.repeat(500), 'Reset filters');
  assert.ok(excerpt.includes('Reset filters')); assert.ok(excerpt.length <= 142);
});

test('library catalog groups variant instances by their component set and retains actual overrides', async () => {
  const set = node('set', 'Button', 'COMPONENT_SET'); set.key = 'button-set'; set.remote = true;
  set.componentPropertyDefinitions = { State: { type: 'VARIANT', variantOptions: ['Default', 'Pressed'] } };
  const instances = ['Default', 'Pressed'].map((state, index) => {
    const variant = node('variant'+index, 'State='+state, 'COMPONENT'); variant.key = 'variant-key'+index; variant.parent = set;
    Object.defineProperty(variant, 'componentPropertyDefinitions', { get() { throw new Error('Read the component set instead'); } });
    const instance = node('instance'+index, 'Button', 'INSTANCE');
    instance.getMainComponentAsync = async () => variant;
    instance.componentProperties = { Label: { type: 'TEXT', value: 'Action '+index } };
    instance.variantProperties = { State: state };
    return instance;
  });
  const result = await componentCatalog(instances, {}, () => false);
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].key, 'button-set');
  assert.equal(result.components[0].instances.length, 2);
  assert.equal(result.components[0].instances[1].properties.Label.value, 'Action 1');
  assert.equal(result.components[0].instances[1].mainComponent.key, 'variant-key1');
  assert.deepEqual(result.components[0].properties.State.variantOptions, ['Default', 'Pressed']);
});
