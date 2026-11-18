import { Params, CommandError } from './document';

// Bounded editing vocabulary shared by `patch` (property changes on existing layers) and `build`
// (structural steps). Every value is validated and rebuilt from known keys before Figma sees it;
// there is still no way to run arbitrary code.

const BLEND = new Set(['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']);
const GRADIENTS = new Set(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']);
const CONSTRAINT = new Set(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE']);
const ENUMS: Record<string, Set<string>> = {
  textAlignHorizontal: new Set(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']),
  textAlignVertical: new Set(['TOP', 'CENTER', 'BOTTOM']),
  textAutoResize: new Set(['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE']),
  textCase: new Set(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED']),
  layoutSizingHorizontal: new Set(['FIXED', 'HUG', 'FILL']),
  layoutSizingVertical: new Set(['FIXED', 'HUG', 'FILL']),
  layoutPositioning: new Set(['AUTO', 'ABSOLUTE']),
  blendMode: BLEND
};
const NUMBERS: Record<string, [number, number]> = {
  x: [-100000, 100000], y: [-100000, 100000], width: [0.01, 100000], height: [0.01, 100000],
  fontSize: [1, 10000], opacity: [0, 1], rotation: [-360, 360], cornerRadius: [0, 100000],
  strokeWeight: [0, 10000], itemSpacing: [-100000, 100000],
  paddingTop: [0, 100000], paddingRight: [0, 100000], paddingBottom: [0, 100000], paddingLeft: [0, 100000]
};
const BOOLEANS = new Set(['visible', 'clipsContent', 'isMask', 'locked']);
const STRINGS = new Set(['name', 'characters', 'description']);
const STYLE_SETTERS: Record<string, string> = {
  fillStyleId: 'setFillStyleIdAsync', strokeStyleId: 'setStrokeStyleIdAsync',
  textStyleId: 'setTextStyleIdAsync', effectStyleId: 'setEffectStyleIdAsync'
};
// Changes that need the text node's fonts loaded first.
export const TEXT_FONT_KEYS = new Set(['characters', 'fontSize', 'fills', 'fontName', 'letterSpacing', 'lineHeight', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textCase', 'textStyleId', 'textReplace', 'rangeFontName']);

export const PATCH_PROPERTIES = new Set([
  ...Object.keys(NUMBERS), ...BOOLEANS, ...STRINGS, ...Object.keys(ENUMS), ...Object.keys(STYLE_SETTERS),
  'fills', 'strokes', 'effects', 'constraints', 'fontName', 'letterSpacing', 'lineHeight', 'textReplace', 'rangeFontName'
]);

const finite = (value: any, min = -Infinity, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const unit = (value: any) => finite(value, 0, 1);

function color(value: any, alpha: boolean, where: string) {
  if (!value || !unit(value.r) || !unit(value.g) || !unit(value.b)) throw new CommandError('INVALID_PATCH', `${where}: color needs r, g, b between 0 and 1.`);
  if (!alpha) return { r: value.r, g: value.g, b: value.b };
  if (value.a !== undefined && !unit(value.a)) throw new CommandError('INVALID_PATCH', `${where}: alpha must be between 0 and 1.`);
  return { r: value.r, g: value.g, b: value.b, a: value.a ?? 1 };
}

export function paint(value: any, where: string): Paint {
  if (!value || typeof value !== 'object') throw new CommandError('INVALID_PATCH', `${where}: a paint must be an object.`);
  const common: Params = {};
  if (value.opacity !== undefined) { if (!unit(value.opacity)) throw new CommandError('INVALID_PATCH', `${where}: opacity must be between 0 and 1.`); common.opacity = value.opacity; }
  if (value.visible !== undefined) { if (typeof value.visible !== 'boolean') throw new CommandError('INVALID_PATCH', `${where}: visible must be boolean.`); common.visible = value.visible; }
  if (value.blendMode !== undefined) { if (!BLEND.has(value.blendMode)) throw new CommandError('INVALID_PATCH', `${where}: unknown blendMode.`); common.blendMode = value.blendMode; }
  if (value.type === 'SOLID') return { type: 'SOLID', color: color(value.color, false, where), ...common } as SolidPaint;
  if (GRADIENTS.has(value.type)) {
    const transform = value.gradientTransform;
    if (!Array.isArray(transform) || transform.length !== 2 || transform.some((row: any) => !Array.isArray(row) || row.length !== 3 || row.some((n: any) => !finite(n, -1e6, 1e6)))) throw new CommandError('INVALID_PATCH', `${where}: gradientTransform must be a 2×3 matrix.`);
    const stops = value.gradientStops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 16) throw new CommandError('INVALID_PATCH', `${where}: a gradient needs 2–16 stops.`);
    return {
      type: value.type, ...common,
      gradientTransform: transform.map((row: number[]) => [row[0], row[1], row[2]]) as Transform,
      gradientStops: stops.map((stop: any, i: number) => {
        if (!stop || !unit(stop.position)) throw new CommandError('INVALID_PATCH', `${where}: stop ${i} needs a position between 0 and 1.`);
        return { position: stop.position, color: color(stop.color, true, `${where} stop ${i}`) as RGBA };
      })
    } as GradientPaint;
  }
  throw new CommandError('INVALID_PATCH', `${where}: supported paints are SOLID and GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND.`);
}

function effect(value: any, where: string): Effect {
  if (!value || typeof value !== 'object') throw new CommandError('INVALID_PATCH', `${where}: an effect must be an object.`);
  const visible = value.visible ?? true;
  if (typeof visible !== 'boolean') throw new CommandError('INVALID_PATCH', `${where}: visible must be boolean.`);
  if (!finite(value.radius, 0, 1000)) throw new CommandError('INVALID_PATCH', `${where}: radius must be between 0 and 1000.`);
  if (value.type === 'DROP_SHADOW' || value.type === 'INNER_SHADOW') {
    if (!value.offset || !finite(value.offset.x, -10000, 10000) || !finite(value.offset.y, -10000, 10000)) throw new CommandError('INVALID_PATCH', `${where}: offset needs x and y.`);
    if (value.spread !== undefined && !finite(value.spread, -1000, 1000)) throw new CommandError('INVALID_PATCH', `${where}: invalid spread.`);
    const blendMode = value.blendMode ?? 'NORMAL';
    if (!BLEND.has(blendMode)) throw new CommandError('INVALID_PATCH', `${where}: unknown blendMode.`);
    const shadow: Params = { type: value.type, color: color(value.color, true, where), offset: { x: value.offset.x, y: value.offset.y }, radius: value.radius, spread: value.spread ?? 0, visible, blendMode };
    if (value.type === 'DROP_SHADOW' && value.showShadowBehindNode !== undefined) shadow.showShadowBehindNode = !!value.showShadowBehindNode;
    return shadow as Effect;
  }
  if (value.type === 'LAYER_BLUR' || value.type === 'BACKGROUND_BLUR') {
    const blur: Params = { type: value.type, radius: value.radius, visible };
    if (value.blurType !== undefined) { if (value.blurType !== 'NORMAL') throw new CommandError('INVALID_PATCH', `${where}: only NORMAL blurType is supported.`); blur.blurType = 'NORMAL'; }
    return blur as Effect;
  }
  throw new CommandError('INVALID_PATCH', `${where}: supported effects are DROP_SHADOW, INNER_SHADOW, LAYER_BLUR and BACKGROUND_BLUR.`);
}

// Validate one change and return the value to assign, rebuilt from known keys.
export function cleanChange(key: string, value: any, node: SceneNode): any {
  const where = `${key} on ${node.name}`;
  if (!PATCH_PROPERTIES.has(key)) throw new CommandError('INVALID_PATCH', `Unsupported property ${key}.`);
  if (key !== 'textReplace' && key !== 'rangeFontName' && !(key in node)) throw new CommandError('INVALID_PATCH', `Unsupported property ${key} on ${node.name}.`);
  if (key in NUMBERS) {
    const [min, max] = NUMBERS[key];
    if (!finite(value, min, max)) throw new CommandError('INVALID_PATCH', `Invalid number for ${key}.`);
    return value;
  }
  if (BOOLEANS.has(key)) { if (typeof value !== 'boolean') throw new CommandError('INVALID_PATCH', `${key} must be boolean.`); return value; }
  if (STRINGS.has(key)) { if (typeof value !== 'string' || value.length > 100000) throw new CommandError('INVALID_PATCH', `${key} must be a bounded string.`); return value; }
  if (key in ENUMS) { if (!ENUMS[key].has(value)) throw new CommandError('INVALID_PATCH', `Invalid value for ${key}.`); return value; }
  if (key in STYLE_SETTERS) { if (typeof value !== 'string' || value.length > 200) throw new CommandError('INVALID_PATCH', `${key} must be a style id or an empty string.`); return value; }
  if (key === 'fills' || key === 'strokes') {
    if (!Array.isArray(value) || value.length > 10) throw new CommandError('INVALID_PATCH', `${key} supports up to ten paints.`);
    return value.map((item, i) => paint(item, `${where}[${i}]`));
  }
  if (key === 'effects') {
    if (!Array.isArray(value) || value.length > 8) throw new CommandError('INVALID_PATCH', 'effects supports up to eight effects.');
    return value.map((item, i) => effect(item, `${where}[${i}]`));
  }
  if (key === 'constraints') {
    if (!value || !CONSTRAINT.has(value.horizontal) || !CONSTRAINT.has(value.vertical)) throw new CommandError('INVALID_PATCH', 'constraints need horizontal and vertical: MIN, MAX, CENTER, STRETCH or SCALE.');
    return { horizontal: value.horizontal, vertical: value.vertical };
  }
  if (key === 'fontName') {
    if (!value || typeof value.family !== 'string' || typeof value.style !== 'string' || value.family.length > 200 || value.style.length > 200) throw new CommandError('INVALID_PATCH', 'fontName needs family and style.');
    return { family: value.family, style: value.style };
  }
  if (key === 'letterSpacing') {
    if (!value || !finite(value.value, -1000, 1000) || !['PIXELS', 'PERCENT'].includes(value.unit)) throw new CommandError('INVALID_PATCH', 'letterSpacing needs value and unit PIXELS or PERCENT.');
    return { value: value.value, unit: value.unit };
  }
  if (key === 'lineHeight') {
    if (value?.unit === 'AUTO') return { unit: 'AUTO' };
    if (!value || !finite(value.value, 0, 10000) || !['PIXELS', 'PERCENT'].includes(value.unit)) throw new CommandError('INVALID_PATCH', 'lineHeight needs unit AUTO, or value with unit PIXELS or PERCENT.');
    return { value: value.value, unit: value.unit };
  }
  if (key === 'textReplace') {
    if (node.type !== 'TEXT') throw new CommandError('INVALID_PATCH', 'textReplace applies to text layers.');
    if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((pair: any) => !pair || typeof pair.from !== 'string' || !pair.from.length || typeof pair.to !== 'string' || pair.from.length > 10000 || pair.to.length > 10000)) throw new CommandError('INVALID_PATCH', 'textReplace takes 1–50 {from, to} pairs.');
    for (const pair of value) if (!node.characters.includes(pair.from)) throw new CommandError('STALE_PATCH', `"${pair.from}" is not in ${node.name}.`);
    return value.map((pair: any) => ({ from: pair.from, to: pair.to }));
  }
  if (key === 'rangeFontName') {
    if (node.type !== 'TEXT') throw new CommandError('INVALID_PATCH', 'rangeFontName applies to text layers.');
    const length = node.characters.length;
    if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((r: any) => !r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > length || r.start >= r.end || typeof r.family !== 'string' || typeof r.style !== 'string' || r.family.length > 200 || r.style.length > 200)) throw new CommandError('INVALID_PATCH', 'rangeFontName takes 1–50 {start, end, family, style} ranges inside the text.');
    return value.map((r: any) => ({ start: r.start, end: r.end, family: r.family, style: r.style }));
  }
  throw new CommandError('INVALID_PATCH', `Unsupported property ${key}.`);
}

// Replace text in place so each run keeps its own style: the new characters take the style
// of the first replaced character.
function replaceText(node: TextNode, pairs: { from: string; to: string }[]) {
  for (const { from, to } of pairs) {
    let start = node.characters.indexOf(from);
    while (start !== -1) {
      if (to.length) {
        node.insertCharacters(start + 1, to, 'BEFORE');
        node.deleteCharacters(start, start + 1);
        if (from.length > 1) node.deleteCharacters(start + to.length, start + to.length + from.length - 1);
      } else node.deleteCharacters(start, start + from.length);
      start = node.characters.indexOf(from, start + to.length);
    }
  }
}

// Every font in the layer must be loaded before its text changes, except a font this change
// replaces everywhere it is used: a missing font can still be swapped for an available one.
export async function fontsFor(node: SceneNode, changes: Params) {
  if (node.type !== 'TEXT' || !Object.keys(changes).some(key => TEXT_FONT_KEYS.has(key))) return;
  const wanted: FontName[] = [];
  if (changes.fontName) wanted.push(changes.fontName);
  for (const range of changes.rangeFontName ?? []) wanted.push({ family: range.family, style: range.style });
  if (changes.textStyleId) {
    const style = await figma.getStyleByIdAsync(changes.textStyleId);
    if (style && style.type === 'TEXT') wanted.push((style as TextStyle).fontName);
  }
  await Promise.all(wanted.map(font => figma.loadFontAsync(font)));
  const length = node.characters.length;
  const segments = !length ? [] : typeof node.getStyledTextSegments === 'function' ? node.getStyledTextSegments(['fontName'])
    : node.getRangeAllFontNames(0, length).map(fontName => ({ fontName, start: 0, end: length }));
  const current = segments.length ? segments.map(segment => ({ font: segment.fontName, start: segment.start, end: segment.end })) : node.fontName !== figma.mixed ? [{ font: node.fontName as FontName, start: 0, end: 0 }] : [];
  const replaced = (segment: { start: number; end: number }) => !!changes.fontName || (changes.rangeFontName ?? []).some((r: any) => r.start <= segment.start && r.end >= segment.end);
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const segment of current) {
    const key = `${segment.font.family}\u0000${segment.font.style}`;
    try { if (!seen.has(key)) await figma.loadFontAsync(segment.font); seen.add(key); }
    catch (error) { if (!replaced(segment)) failures.push(`${segment.font.family} ${segment.font.style}`); }
  }
  if (failures.length) throw new CommandError('FONT_UNAVAILABLE', `Font not available in Figma: ${[...new Set(failures)].join(', ')}.`);
}

export async function checkStyles(changes: Params) {
  for (const key of Object.keys(STYLE_SETTERS)) {
    const id = changes[key];
    if (typeof id === 'string' && id && !(await figma.getStyleByIdAsync(id))) throw new CommandError('INVALID_PATCH', `Style not found: ${id}.`);
  }
}

export function snapshotValue(node: SceneNode, key: string) {
  if (key === 'textReplace') return (node as TextNode).characters;
  if (key === 'rangeFontName') return null;
  return (node as any)[key];
}

export async function assign(node: SceneNode, key: string, value: any) {
  const target = node as any;
  if (key in STYLE_SETTERS) { await target[STYLE_SETTERS[key]](value); return; }
  if (key === 'textReplace') { replaceText(node as TextNode, value); return; }
  if (key === 'rangeFontName') { for (const r of value) (node as TextNode).setRangeFontName(r.start, r.end, { family: r.family, style: r.style }); return; }
  target[key] = value;
}

// Restoring a value read before the change. Mixed text is restored as plain characters.
export async function restore(node: SceneNode, key: string, value: any) {
  const target = node as any;
  if (key in STYLE_SETTERS) { await target[STYLE_SETTERS[key]](typeof value === 'string' ? value : ''); return; }
  if (key === 'textReplace') { target.characters = value; return; }
  if (key === 'rangeFontName' || typeof value === 'symbol') return;
  target[key] = value;
}

// ── build: structural steps ────────────────────────────────────────────────

const PROTECTED = new Set(['DOCUMENT', 'PAGE', 'COMPONENT', 'COMPONENT_SET']);
const MAX_SVG = 400000;

function svgText(value: any) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_SVG) throw new CommandError('INVALID_BUILD', `svg must be a string up to ${MAX_SVG} characters.`);
  const body = value.replace(/^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*/, '');
  if (!/^<svg[\s/>]/i.test(body)) throw new CommandError('INVALID_BUILD', 'svg must start with an <svg> element.');
  if (/<script|<foreignObject|\son[a-z]+\s*=|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|javascript:)/i.test(body)) throw new CommandError('INVALID_BUILD', 'svg may not contain scripts, event handlers, foreignObject or external references.');
  return value;
}

type Container = BaseNode & ChildrenMixin;
function container(node: BaseNode, where: string): Container {
  if (!('appendChild' in node) || node.type === 'INSTANCE' || node.type === 'DOCUMENT') throw new CommandError('INVALID_BUILD', `${where}: ${node.name} cannot hold layers.`);
  return node as Container;
}
function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return current as PageNode | null;
}

export async function runBuild(params: Params, isCancelled: () => boolean, writeEnabled: () => boolean) {
  const steps = params.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 50) throw new CommandError('INVALID_BUILD', 'Provide 1–50 steps.');
  const refs = new Map<string, SceneNode>();
  const created: SceneNode[] = [];
  const undo: (() => void | Promise<void>)[] = [];
  const removals: SceneNode[] = [];
  const results: Params[] = [];

  async function node(value: any, where: string): Promise<SceneNode> {
    if (typeof value !== 'string' || !value.length || value.length > 200) throw new CommandError('INVALID_BUILD', `${where}: expected a node id or $ref.`);
    const found = value.startsWith('$') ? refs.get(value.slice(1)) ?? null : await figma.getNodeByIdAsync(value);
    if (!found) throw new CommandError('NODE_NOT_FOUND', `${where}: node not found: ${value}`);
    if (found.type === 'DOCUMENT' || found.type === 'PAGE') throw new CommandError('INVALID_BUILD', `${where}: expected a layer.`);
    return found as SceneNode;
  }
  async function parent(value: any, where: string): Promise<Container> {
    if (typeof value !== 'string') throw new CommandError('INVALID_BUILD', `${where}: parentId is required.`);
    const found = value.startsWith('$') ? refs.get(value.slice(1)) ?? null : await figma.getNodeByIdAsync(value);
    if (!found) throw new CommandError('NODE_NOT_FOUND', `${where}: parent not found: ${value}`);
    return container(found, where);
  }
  function insert(target: Container, child: SceneNode, index: any, where: string) {
    if (index === undefined) { target.appendChild(child); return; }
    if (!Number.isInteger(index) || index < 0 || index > target.children.length) throw new CommandError('INVALID_BUILD', `${where}: index out of range.`);
    target.insertChild(index, child);
  }
  function place(child: SceneNode, step: Params, where: string) {
    for (const key of ['x', 'y'] as const) if (step[key] !== undefined) { if (!finite(step[key], -100000, 100000)) throw new CommandError('INVALID_BUILD', `${where}: invalid ${key}.`); child[key] = step[key]; }
    if (step.fitWidth !== undefined || step.fitHeight !== undefined) {
      if (!('rescale' in child)) throw new CommandError('INVALID_BUILD', `${where}: ${child.name} cannot be scaled.`);
      const factor = step.fitWidth !== undefined ? step.fitWidth / child.width : step.fitHeight / child.height;
      if (!finite(factor, 0.0001, 10000)) throw new CommandError('INVALID_BUILD', `${where}: invalid fit size.`);
      (child as any).rescale(factor);
    }
    if (step.width !== undefined || step.height !== undefined) {
      const width = step.width ?? child.width, height = step.height ?? child.height;
      if (!finite(width, 0.01, 100000) || !finite(height, 0.01, 100000) || !('resize' in child)) throw new CommandError('INVALID_BUILD', `${where}: invalid size.`);
      (child as any).resize(width, height);
    }
    if (step.name !== undefined) { if (typeof step.name !== 'string' || step.name.length > 1000) throw new CommandError('INVALID_BUILD', `${where}: invalid name.`); child.name = step.name; }
  }
  function remember(step: Params, child: SceneNode, where: string) {
    if (step.as === undefined) return;
    if (typeof step.as !== 'string' || !/^[A-Za-z][\w-]{0,40}$/.test(step.as) || refs.has(step.as)) throw new CommandError('INVALID_BUILD', `${where}: as must be a new short name.`);
    refs.set(step.as, child);
  }

  try {
    for (let i = 0; i < steps.length; i++) {
      if (!writeEnabled() || isCancelled()) throw new CommandError('CANCELLED', 'Editing was disabled or the request was cancelled.');
      const step = steps[i];
      const where = `step ${i} (${step?.action})`;
      if (!step || typeof step !== 'object') throw new CommandError('INVALID_BUILD', `${where}: a step must be an object.`);
      let child: SceneNode;
      switch (step.action) {
        case 'createSvg': {
          const target = await parent(step.parentId, where);
          child = figma.createNodeFromSvg(svgText(step.svg));
          created.push(child);
          insert(target, child, step.index, where);
          if (step.constraints !== undefined) {
            const value = cleanChange('constraints', step.constraints, child);
            for (const item of [child, ...child.findAll(() => true)]) if ('constraints' in item) (item as any).constraints = value;
          }
          place(child, step, where);
          break;
        }
        case 'clone': {
          const source = await node(step.nodeId, where);
          child = source.clone();
          created.push(child);
          if (step.parentId !== undefined) insert(await parent(step.parentId, where), child, step.index, where);
          else if (source.parent && source.parent.type !== 'DOCUMENT') { const p = source.parent as Container; p.insertChild(p.children.indexOf(source) + 1, child); }
          place(child, step, where);
          break;
        }
        case 'createInstance': {
          const component = await node(step.componentId, where);
          if (component.type !== 'COMPONENT') throw new CommandError('INVALID_BUILD', `${where}: componentId must be a component.`);
          child = component.createInstance();
          created.push(child);
          insert(await parent(step.parentId, where), child, step.index, where);
          place(child, step, where);
          break;
        }
        case 'componentize': {
          const source = await node(step.nodeId, where);
          if (!created.includes(source)) throw new CommandError('INVALID_BUILD', `${where}: only a layer created in this build can become a component.`);
          if (source.type === 'INSTANCE' || source.type === 'COMPONENT' || source.type === 'COMPONENT_SET') throw new CommandError('INVALID_BUILD', `${where}: ${source.type} cannot become a component.`);
          child = figma.createComponentFromNode(source);
          created.splice(created.indexOf(source), 1, child);
          for (const [name, value] of refs) if (value === source) refs.set(name, child);
          place(child, step, where);
          if (step.description !== undefined) { if (typeof step.description !== 'string' || step.description.length > 5000) throw new CommandError('INVALID_BUILD', `${where}: invalid description.`); (child as ComponentNode).description = step.description; }
          break;
        }
        case 'swap': {
          const instance = await node(step.nodeId, where);
          const component = await node(step.componentId, where);
          if (instance.type !== 'INSTANCE' || component.type !== 'COMPONENT') throw new CommandError('INVALID_BUILD', `${where}: swap needs an instance and a component.`);
          const previous = await instance.getMainComponentAsync();
          if (step.expectedComponentId !== undefined && previous?.id !== step.expectedComponentId) throw new CommandError('STALE_PATCH', `${where}: ${instance.name} is no longer an instance of ${step.expectedComponentId}.`);
          const box = { x: instance.x, y: instance.y, width: instance.width, height: instance.height };
          instance.swapComponent(component);
          undo.push(() => { if (previous) { instance.swapComponent(previous); instance.x = box.x; instance.y = box.y; instance.resize(box.width, box.height); } });
          child = instance;
          place(child, step, where);
          break;
        }
        case 'move': {
          const source = await node(step.nodeId, where);
          const target = await parent(step.parentId, where);
          const previous = source.parent as Container | null;
          const box = { index: previous ? previous.children.indexOf(source) : 0, x: source.x, y: source.y };
          insert(target, source, step.index, where);
          undo.push(() => { if (previous) { previous.insertChild(Math.min(box.index, previous.children.length), source); source.x = box.x; source.y = box.y; } });
          child = source;
          place(child, step, where);
          break;
        }
        case 'rescale': {
          child = await node(step.nodeId, where);
          if (step.fitWidth === undefined && step.fitHeight === undefined) throw new CommandError('INVALID_BUILD', `${where}: give fitWidth or fitHeight.`);
          const box = { x: child.x, y: child.y, width: child.width };
          const scaled = child;
          place(child, { fitWidth: step.fitWidth, fitHeight: step.fitHeight, x: step.x, y: step.y }, where);
          undo.push(() => { (scaled as any).rescale(box.width / scaled.width); scaled.x = box.x; scaled.y = box.y; });
          break;
        }
        case 'remove': {
          child = await node(step.nodeId, where);
          if (PROTECTED.has(child.type) || child.type === 'SECTION') throw new CommandError('INVALID_BUILD', `${where}: ${child.type} layers are not removed by FigmaSpark.`);
          if (!step.expected || child.name !== step.expected.name || child.type !== step.expected.type) throw new CommandError('STALE_PATCH', `${where}: remove needs expected.name and expected.type matching the layer.`);
          if ('findAll' in child && (child as any).findAll((item: SceneNode) => item.type === 'COMPONENT' || item.type === 'COMPONENT_SET').length) throw new CommandError('INVALID_BUILD', `${where}: the layer contains a main component.`);
          if (pageOf(child)?.id !== figma.currentPage.id) throw new CommandError('INVALID_BUILD', `${where}: remove only layers on the current page.`);
          removals.push(child);
          break;
        }
        default: throw new CommandError('INVALID_BUILD', `${where}: action must be createSvg, clone, createInstance, componentize, swap, move, rescale or remove.`);
      }
      remember(step, child, where);
      results.push({ index: i, action: step.action, nodeId: child.id, name: child.name, type: child.type, ...('width' in child ? { width: child.width, height: child.height } : {}) });
    }
    // Removals run last, once every other step has succeeded.
    for (const item of removals) item.remove();
  } catch (error) {
    let rollbackFailed = false;
    for (const step of [...undo].reverse()) try { await step(); } catch { rollbackFailed = true; }
    for (const item of [...created].reverse()) try { if (!item.removed) item.remove(); } catch { rollbackFailed = true; }
    if (rollbackFailed) throw new CommandError('ROLLBACK_FAILED', `Some steps could not be undone (${(error as Error)?.message}). Use Figma Undo, then inspect the affected layers.`);
    throw error;
  }
  return { steps: results, refs: Object.fromEntries([...refs].map(([name, item]) => [name, item.id])) };
}
