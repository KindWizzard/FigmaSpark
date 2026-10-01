import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parseArgs } from '../scripts/spark.mjs';

const bundled = await build({ entryPoints: ['plugin/src/document.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { walkNodes, auditNodes, base64, checkProperty } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function node(id, name, type = 'FRAME', children = []) {
  const result = { id, name, type, visible: true, children, width: 300, height: 200, parent: null };
  for (const child of children) child.parent = result;
  return result;
}

test('snapshot traversal obeys hidden layers, depth and maximum node limits', async () => {
  const hidden = node('3', 'Hidden', 'TEXT'); hidden.visible = false;
  const root = node('1', 'Frame', 'FRAME', [node('2', 'Visible', 'TEXT'), hidden, node('4', 'Nested', 'FRAME', [node('5', 'Deep', 'TEXT')])]);
  assert.deepEqual((await walkNodes([root], {})).items.map(i => i.node.id), ['1', '2', '4', '5']);
  assert.equal((await walkNodes([root], { depth: 1 })).truncated, true);
  const limited = await walkNodes([root], { maxNodes: 2 });
  assert.ok(limited.visited <= 2); assert.equal(limited.truncated, true);
  await assert.rejects(walkNodes([root], {}, () => true), error => error.code === 'CANCELLED');
});

test('audit finds definite failures, missing requirements and verified matches', async () => {
  const title = node('1', 'Title', 'TEXT'); title.characters = 'Players'; title.fontSize = 28;
  const results = await auditNodes([title], [
    { id: 'title', selector: { name: 'Title' }, checks: [{ property: 'characters', value: 'Players' }] },
    { id: 'size', selector: { name: 'Title' }, checks: [{ property: 'fontSize', value: 24 }] },
    { id: 'button', selector: { name: 'Apply filters' } }
  ], false);
  assert.deepEqual(results.map(r => r.status), ['pass', 'fail', 'fail']);
  assert.equal(results[1].checks[0].actual, 28);
  assert.deepEqual(results[1].nodeIds, ['1']);
});

test('partial coverage and mixed properties never claim a pass', async () => {
  const title = node('1', 'Title', 'TEXT'); title.fontSize = Symbol('mixed');
  const requirements = [
    { id: 'title', selector: { name: 'Title' } },
    { id: 'missing', selector: { name: 'Absent' } },
    { id: 'mixed', selector: { name: 'Title' }, checks: [{ property: 'fontSize', value: 24 }] }
  ];
  assert.deepEqual((await auditNodes([title], requirements, true)).map(r => r.status), ['unknown', 'unknown', 'unknown']);
  assert.equal((await auditNodes([title], [requirements[2]], false))[0].status, 'unknown');
  assert.equal(checkProperty({ width: 2 }, { property: 'notReal', value: 2 }).status, 'unknown');
  assert.equal(checkProperty({ width: 2 }, { property: 'width', operator: 'typo', value: 2 }).status, 'unknown');
});

test('audit can prove excess nodes even with incomplete coverage', async () => {
  const nodes = [node('1', 'CTA'), node('2', 'CTA')];
  const results = await auditNodes(nodes, [{ id: 'unique', selector: { name: 'CTA' }, maxCount: 1 }], true);
  assert.equal(results[0].status, 'fail');
});

test('unknown selectors and invalid numeric tolerance are rejected', async () => {
  await assert.rejects(auditNodes([], [{ id: 'x', selector: { regex: '.' } }], false), error => error.code === 'INVALID_REQUIREMENTS');
  await assert.rejects(auditNodes([node('1', 'Frame')], [{ id: 'x', selector: { name: 'Frame' }, checks: [{ property: 'width', value: 1, tolerance: -1 }] }], false), error => error.code === 'INVALID_REQUIREMENTS');
});

test('object equality ignores key order while preserving array order', () => {
  assert.equal(checkProperty({ fontName: { family: 'Inter' }, fills: [{ color: { r: 1, g: 0, b: 0 }, type: 'SOLID' }] }, { property: 'fills', value: [{ type: 'SOLID', color: { b: 0, g: 0, r: 1 } }] }).status, 'pass');
  assert.equal(checkProperty({ fills: [1, 2] }, { property: 'fills', value: [2, 1] }).status, 'fail');
});

test('binary exports retain bytes including incomplete base64 groups', () => {
  for (const bytes of [[], [255], [0, 128], [255, 0, 127], Array.from({ length: 20000 }, (_, i) => i % 256)]) {
    const input = Uint8Array.from(bytes);
    assert.equal(base64(input), Buffer.from(input).toString('base64'));
  }
});

test('CLI flags accept explicit session and reject unknown or missing arguments', () => {
  const result = parseArgs(['search', 'Apply filters', '--session', 'file-one', '--include-hidden']);
  assert.equal(result.argument, 'Apply filters'); assert.equal(result.options.session, 'file-one'); assert.equal(result.options['include-hidden'], true);
  assert.throws(() => parseArgs(['snapshot', '--out']));
  assert.throws(() => parseArgs(['snapshot', '--typo', 'page']));
});
