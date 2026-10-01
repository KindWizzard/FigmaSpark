export type Params = Record<string, any>;
export type PlainNode = Record<string, any>;
export type WalkItem = { node: BaseNode; depth: number };

export class CommandError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function integer(value: any, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CommandError('INVALID_PARAMS', `Expected an integer between ${min} and ${max}.`);
  }
  return value;
}

export function plain(value: any): any {
  if (typeof value === 'symbol') return 'MIXED';
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  const result: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    const clean = plain(value[key]);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

export function equal(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const keys = Object.keys(a), otherKeys = Object.keys(b);
  return keys.length === otherKeys.length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
}

export function nodeSummary(node: BaseNode): PlainNode {
  const result: PlainNode = { id: node.id, name: node.name, type: node.type, parentId: node.parent?.id ?? null };
  if ('visible' in node) result.visible = node.visible;
  if ('absoluteBoundingBox' in node) result.bounds = plain(node.absoluteBoundingBox);
  if ('children' in node) result.childrenCount = node.children.length;
  return result;
}

export function cooperativeYield(budgetMs = 32) {
  let deadline = Date.now() + budgetMs;
  return async () => {
    // Background Figma timers can be throttled. Yield for actual work, not a fixed layer count.
    if (Date.now() < deadline) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    deadline = Date.now() + budgetMs;
  };
}

const DETAIL_PROPERTIES = [
  'x', 'y', 'width', 'height', 'rotation', 'opacity', 'locked', 'blendMode',
  'layoutMode', 'layoutWrap', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutPositioning',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'clipsContent', 'constraints',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'dashPattern', 'effects',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'layoutGrids', 'boundVariables',
  'characters', 'fontName', 'fontSize', 'fontWeight', 'textAlignHorizontal', 'textAlignVertical',
  'textAutoResize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textStyleId',
  'paragraphSpacing', 'hasMissingFont', 'componentProperties', 'variantProperties',
  'componentPropertyDefinitions', 'description', 'descriptionMarkdown', 'documentationLinks',
  'resolvedVariableModes', 'explicitVariableModes', 'devStatus'
];

export async function serializeNode(node: BaseNode, options: Params = {}): Promise<PlainNode> {
  const result = nodeSummary(node);
  const source = node as any;
  const detail = options.detail ?? 'full';
  if (!['summary', 'review', 'full'].includes(detail)) throw new CommandError('INVALID_PARAMS', 'detail must be summary, review, or full.');
  if ('children' in node) {
    result.childrenIds = node.children.slice(0, 500).map(n => n.id);
    if (node.children.length > 500) result.childrenIdsTruncated = true;
  }
  const fields = detail === 'summary' ? ['characters'] : detail === 'review' ? [
    'characters', 'fontName', 'fontSize', 'fontWeight', 'textStyleId', 'fillStyleId', 'strokeStyleId',
    'fills', 'strokes', 'opacity', 'layoutMode', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'boundVariables', 'componentProperties', 'variantProperties'
  ] : DETAIL_PROPERTIES;
  for (const key of fields) {
    if (key in source) {
      try { result[key] = plain(source[key]); }
      catch { result[key] = { unavailable: true }; }
    }
  }
  if (node.type === 'TEXT' && options.textSegments !== false && (detail === 'full' || options.textSegments === true)) {
    result.textSegments = plain(node.getStyledTextSegments(['fontName', 'fontSize', 'fontWeight', 'fills', 'textStyleId', 'fillStyleId', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'hyperlink']).slice(0, 200));
    if (result.textSegments.length >= 200) result.textSegmentsTruncated = true;
  }
  if (node.type === 'INSTANCE' && options.components !== false && (detail === 'full' || options.components === true)) {
    try {
      const component = await node.getMainComponentAsync();
      result.mainComponent = component ? { id: component.id, key: component.key, name: component.name, description: component.description, remote: component.remote } : null;
    } catch { result.mainComponent = { unavailable: true }; }
  }
  if (options.prototype && 'reactions' in source) result.reactions = plain(source.reactions);
  return result;
}

export async function walkNodes(roots: readonly BaseNode[], options: Params, cancelled: () => boolean = () => false): Promise<{ items: WalkItem[]; truncated: boolean; visited: number }> {
  const depthLimit = integer(options.depth, 12, 0, 50);
  const maxNodes = integer(options.maxNodes, 5000, 1, 20000);
  const stack: { node: BaseNode; depth: number }[] = [...roots].reverse().map(node => ({ node, depth: 0 }));
  const items: WalkItem[] = [];
  const seen = new Set<string>();
  const yieldIfBusy = cooperativeYield();
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    if (cancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    if (visited >= maxNodes) { truncated = true; break; }
    const item = stack.pop()!;
    if (seen.has(item.node.id)) continue;
    seen.add(item.node.id);
    visited += 1;
    if (!options.includeHidden && 'visible' in item.node && !item.node.visible) continue;
    items.push(item);
    if ('children' in item.node && item.node.children.length) {
      if (item.depth >= depthLimit) truncated = true;
      else {
        // Limit the frontier so enormous pages cannot allocate an unbounded stack.
        const children = item.node.children;
        const available = Math.max(0, maxNodes - visited - stack.length);
        const count = Math.min(children.length, available);
        if (count < children.length) truncated = true;
        for (let i = count - 1; i >= 0; i--) stack.push({ node: children[i], depth: item.depth + 1 });
      }
    }
    if (visited % 150 === 0) await yieldIfBusy();
  }
  return { items, truncated, visited };
}

export function selectorMatches(node: BaseNode | PlainNode, selector: Params): boolean {
  if (selector.nodeId && node.id !== selector.nodeId) return false;
  if (selector.type && node.type !== selector.type) return false;
  if (selector.name !== undefined && node.name !== selector.name) return false;
  if (selector.nameContains !== undefined && !node.name.toLocaleLowerCase().includes(String(selector.nameContains).toLocaleLowerCase())) return false;
  const text = 'characters' in node ? node.characters : undefined;
  if (selector.text !== undefined && text !== selector.text) return false;
  if (selector.textContains !== undefined && (typeof text !== 'string' || !text.toLocaleLowerCase().includes(String(selector.textContains).toLocaleLowerCase()))) return false;
  return true;
}

export const CHECK_PROPERTIES = new Set([
  'name', 'type', 'visible', 'characters', 'fontSize', 'fontWeight', 'fontName.family', 'fontName.style',
  'width', 'height', 'opacity', 'cornerRadius', 'itemSpacing', 'layoutMode',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textAlignHorizontal',
  'textAutoResize', 'clipsContent', 'fills', 'strokes', 'boundVariables', 'variantProperties', 'componentProperties'
]);

export function checkProperty(node: PlainNode, check: Params): { status: 'pass' | 'fail' | 'unknown'; actual: any; expected: any; reason?: string } {
  const property = check.property;
  if (!CHECK_PROPERTIES.has(property)) return { status: 'unknown', actual: null, expected: check.value, reason: `Unsupported property: ${property}` };
  const actual = property.split('.').reduce((value: any, key: string) => value?.[key], node);
  if (actual === undefined || actual === 'MIXED' || actual?.unavailable) return { status: 'unknown', actual: actual ?? null, expected: check.value, reason: 'Property is missing, mixed, or unavailable.' };
  let passes: boolean;
  switch (check.operator ?? 'equals') {
    case 'equals':
      if (typeof actual === 'number' && typeof check.value === 'number') passes = Math.abs(actual - check.value) <= (check.tolerance ?? 0.01);
      else passes = equal(actual, check.value);
      break;
    case 'contains':
      if (typeof actual !== 'string' || typeof check.value !== 'string') return { status: 'unknown', actual, expected: check.value, reason: 'contains requires strings.' };
      passes = actual.includes(check.value); break;
    case 'min':
    case 'max':
      if (typeof actual !== 'number' || typeof check.value !== 'number') return { status: 'unknown', actual, expected: check.value, reason: 'min/max require numbers.' };
      passes = check.operator === 'min' ? actual >= check.value : actual <= check.value; break;
    case 'oneOf':
      if (!Array.isArray(check.value)) return { status: 'unknown', actual, expected: check.value, reason: 'oneOf requires an array.' };
      passes = check.value.some((value: any) => equal(actual, value)); break;
    default: return { status: 'unknown', actual, expected: check.value, reason: `Unsupported operator: ${check.operator}` };
  }
  return { status: passes ? 'pass' : 'fail', actual: plain(actual), expected: check.value };
}

export async function auditNodes(nodes: BaseNode[], requirements: Params[], truncated: boolean): Promise<Params[]> {
  const results: Params[] = [];
  const serialized = new Map<string, PlainNode>();
  for (const requirement of requirements) {
    if (!requirement.id || !requirement.selector || typeof requirement.selector !== 'object' || Array.isArray(requirement.selector) || !Object.keys(requirement.selector).length) {
      throw new CommandError('INVALID_REQUIREMENTS', 'Each requirement needs an id and a non-empty selector.');
    }
    const allowedSelectors = ['nodeId', 'name', 'nameContains', 'text', 'textContains', 'type'];
    if (Object.keys(requirement.selector).some(key => !allowedSelectors.includes(key) || typeof requirement.selector[key] !== 'string')) {
      throw new CommandError('INVALID_REQUIREMENTS', 'Selectors accept nodeId, name, nameContains, text, textContains, and type strings.');
    }
    const matches = nodes.filter(node => selectorMatches(node, requirement.selector));
    const minCount = integer(requirement.minCount, 1, 0, 20000);
    const maxCount = integer(requirement.maxCount, 20000, minCount, 20000);
    const countFail = matches.length < minCount || matches.length > maxCount;
    const checks: Params[] = [];
    if (!Array.isArray(requirement.checks ?? []) || (requirement.checks?.length ?? 0) > 30) throw new CommandError('INVALID_REQUIREMENTS', 'checks must be an array with at most 30 checks.');
    for (const node of matches.slice(0, 200)) {
      let data = serialized.get(node.id);
      if (!data) { data = await serializeNode(node, { textSegments: false, components: false }); serialized.set(node.id, data); }
      for (const check of requirement.checks ?? []) {
        if (!check || typeof check !== 'object' || typeof check.property !== 'string') throw new CommandError('INVALID_REQUIREMENTS', 'Each check requires a property.');
        if (check.tolerance !== undefined && (typeof check.tolerance !== 'number' || !Number.isFinite(check.tolerance) || check.tolerance < 0)) throw new CommandError('INVALID_REQUIREMENTS', 'tolerance must be a non-negative finite number.');
        checks.push({ nodeId: node.id, nodeName: node.name, property: check.property, operator: check.operator ?? 'equals', ...checkProperty(data, check) });
      }
    }
    // Positive evidence of a mismatch stays actionable; incomplete coverage can never certify a pass.
    const definiteCountFail = matches.length > maxCount || (!truncated && matches.length < minCount);
    let status = definiteCountFail || checks.some(check => check.status === 'fail') ? 'fail' :
      truncated || matches.length > 200 || checks.some(check => check.status === 'unknown') ? 'unknown' : 'pass';
    if (countFail && truncated && !definiteCountFail && status !== 'fail') status = 'unknown';
    results.push({
      requirementId: String(requirement.id), title: requirement.title ?? String(requirement.id),
      status, severity: requirement.severity ?? 'medium',
      nodeIds: matches.slice(0, 200).map(node => node.id),
      count: matches.length, expectedCount: { min: minCount, max: maxCount }, checks,
      scopeIncomplete: truncated || matches.length > 200,
      expected: requirement.expected ?? requirement.title,
      evidence: definiteCountFail ? `Найдено слоёв: ${matches.length}. Требуется: ${minCount}${maxCount < 20000 ? `–${maxCount}` : ' или больше'}.` :
        status === 'unknown' ? 'Данных недостаточно для вывода; нужна дополнительная проверка.' : undefined
    });
  }
  return results;
}

export function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=') +
      (i + 2 < bytes.length ? alphabet[c & 63] : '=');
    if (chunk.length >= 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}
