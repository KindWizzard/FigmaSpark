import { Params, CommandError, integer, plain, equal, nodeSummary, serializeNode, auditNodes, base64, cooperativeYield } from './document';
import { ReadCache, pageIndex, buildOverview, componentCatalog, screenFor, textExcerpt, compactSummary, layerText } from './catalog';

figma.showUI(__html__, { width: 120, height: 80, themeColors: true, title: '' });
figma.skipInvisibleInstanceChildren = false;

const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let revision = 0;
let writeEnabled = figma.command === 'edit';
let cancelled = new Set<string>();
const activeRequests = new Set<string>();
let queue = Promise.resolve();
const subscribedPages = new Set<string>();
let documentTimer: ReturnType<typeof setTimeout> | undefined;
const reads = new ReadCache();
let latestReport: Params | null = null;

function context() {
  return {
    clientId, fileName: figma.root.name, fileKey: figma.fileKey ?? null, editorType: figma.editorType,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.slice(0, 20).map(nodeSummary), selectionCount: figma.currentPage.selection.length,
    selectionTruncated: figma.currentPage.selection.length > 20,
    revision, writeEnabled, protocol: 1
  };
}

function event(name: string, data: Params) { figma.ui.postMessage({ type: 'event', event: name, data }); }
function onNodeChange() {
  revision += 1;
  reads.clear();
  if (documentTimer) clearTimeout(documentTimer);
  documentTimer = setTimeout(() => event('document', { revision, page: context().page }), 150);
}
function subscribePage(page: PageNode) {
  if (subscribedPages.has(page.id)) return;
  page.on('nodechange', onNodeChange);
  subscribedPages.add(page.id);
}

async function readPage(page: PageNode) {
  if (subscribedPages.has(page.id)) return;
  // Already loaded pages are readable without a new Figma network round trip.
  try { void page.children.length; }
  catch {
    try { await page.loadAsync(); }
    catch (error) { throw new CommandError('PAGE_UNAVAILABLE', `Figma could not load page "${page.name}". ${(error as Error)?.message ?? String(error)}`); }
  }
  subscribePage(page);
}
subscribePage(figma.currentPage);
figma.on('selectionchange', () => event('selection', { selection: context().selection, revision }));
figma.on('currentpagechange', () => { subscribePage(figma.currentPage); revision += 1; reads.clear(); event('context', context()); });
figma.on('stylechange', () => { revision += 1; reads.clear(); });

async function overview(params: Params, isCancelled: () => boolean) {
  const roots = await getRoots({ scope: 'page', ...params });
  const startRevision = revision;
  const key = JSON.stringify(['overview', roots.map(node => node.id), params.depth, params.maxNodes, params.sampleNodes, params.limit, params.offset, !!params.includeHidden]);
  let data = params.refresh !== true ? reads.getSummary(key) : undefined;
  const cached = !!data;
  if (!data) {
    data = await buildOverview(roots, params, isCancelled);
    if (startRevision === revision) reads.setSummary(key, data);
  }
  return { context: context(), pages: pageIndex(figma.root.children, figma.currentPage.id), ...data, revision: startRevision, coverage: { ...data.coverage, changedDuringRead: startRevision !== revision }, cache: { hit: cached } };
}

async function libraries(params: Params, isCancelled: () => boolean) {
  const roots = await getRoots({ scope: 'page', ...params });
  const startRevision = revision;
  const key = JSON.stringify(['libraries', roots.map(node => node.id), params.depth, params.maxNodes, params.limit, !!params.includeHidden]);
  let data = params.refresh !== true ? reads.getSummary(key) : undefined;
  const cached = !!data;
  if (!data) {
    const walked = await reads.walk(roots, params, isCancelled);
    const catalog = await componentCatalog(walked.items.map(item => item.node), params, isCancelled);
    const localStyles = (await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync()])).flat();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (isCancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    data = { ...catalog, styles: localStyles.slice(0, 200).map(style => ({ id: style.id, key: style.key, name: style.name, type: style.type })), variableCollections: collections.slice(0, 100).map(collection => ({ id: collection.id, key: collection.key, name: collection.name, modes: plain(collection.modes), variableCount: collection.variableIds.length })), coverage: { scanned: walked.visited, truncated: walked.truncated || catalog.truncated, referencedComponentsOnly: true, stylesTotal: localStyles.length, stylesTruncated: localStyles.length > 200, collectionsTotal: collections.length, collectionsTruncated: collections.length > 100 } };
    if (startRevision === revision) reads.setSummary(key, data);
  }
  return { ...data, revision: startRevision, coverage: { ...data.coverage, changedDuringRead: startRevision !== revision }, cache: { hit: cached } };
}

async function getRoots(params: Params): Promise<BaseNode[]> {
  if (params.nodeIds !== undefined) {
    if (!Array.isArray(params.nodeIds) || !params.nodeIds.length || params.nodeIds.length > 50 || params.nodeIds.some((id: any) => typeof id !== 'string' || id.length > 100)) {
      throw new CommandError('INVALID_PARAMS', 'nodeIds must contain 1–50 node IDs.');
    }
    const nodes = await Promise.all(params.nodeIds.map((id: string) => figma.root.children.find(page => page.id === id) ?? figma.getNodeByIdAsync(id)));
    const missing = params.nodeIds.filter((_: string, index: number) => !nodes[index]);
    if (missing.length) throw new CommandError('NODE_NOT_FOUND', `Nodes not found: ${missing.join(', ')}`);
    for (const node of nodes) if (node?.type === 'DOCUMENT') throw new CommandError('INVALID_SCOPE', 'Use pages or a page ID instead of the entire document.');
    for (const node of nodes) {
      if (node?.type === 'PAGE') await readPage(node);
      let page: BaseNode | null = node;
      while (page && page.type !== 'PAGE') page = page.parent;
      if (page?.type === 'PAGE') await readPage(page);
    }
    return nodes as BaseNode[];
  }
  if (params.pageId) {
    const page = figma.root.children.find(page => page.id === params.pageId);
    if (!page) throw new CommandError('PAGE_NOT_FOUND', 'Page not found.');
    await readPage(page);
    return [page];
  }
  if (params.scope === 'page') return [figma.currentPage];
  if (params.scope !== undefined && params.scope !== 'selection') throw new CommandError('INVALID_SCOPE', 'scope must be selection or page.');
  const nodes = [...figma.currentPage.selection];
  if (!nodes.length) throw new CommandError('EMPTY_SELECTION', 'Select a frame or explicitly request scope: page.');
  return nodes;
}

function assertScene(node: BaseNode): asserts node is SceneNode {
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new CommandError('INVALID_NODE', 'This command requires a layer or frame.');
}

async function snapshot(params: Params, isCancelled: () => boolean) {
  const roots = await getRoots(params);
  const startRevision = revision;
  if (params.revision !== undefined && params.revision !== revision) throw new CommandError('STALE_SNAPSHOT', 'The document changed. Start a fresh snapshot.');
  const walked = await reads.walk(roots, params, isCancelled);
  const offset = integer(params.offset, 0, 0, 20000);
  const limit = integer(params.limit, 100, 1, 2000);
  if (params.revision !== undefined && params.revision !== revision) throw new CommandError('STALE_SNAPSHOT', 'The document changed. Start a fresh snapshot.');
  const nodes: Params[] = [];
  const yieldIfBusy = cooperativeYield();
  let nodeHits = 0;
  for (const item of walked.items.slice(offset, offset + limit)) {
    if (isCancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    const data = await reads.node(item.node, { detail: 'review', ...params });
    if (data.cached) nodeHits++;
    nodes.push({ ...data.value, depth: item.depth });
    if (nodes.length % 75 === 0) await yieldIfBusy();
  }
  return {
    context: context(), rootIds: roots.map(node => node.id), nodes,
    coverage: { scanned: walked.visited, included: walked.items.length, returned: nodes.length, truncated: walked.truncated, includeHidden: !!params.includeHidden, depth: params.depth ?? 12, changedDuringRead: revision !== startRevision },
    revision: startRevision,
    detail: params.detail ?? 'review', cache: { traversalHit: walked.cached, nodeHits },
    nextOffset: offset + limit < walked.items.length ? offset + limit : null
  };
}

async function exportNodes(params: Params, isCancelled: () => boolean) {
  const roots = await getRoots(params);
  if (roots.length > 4) throw new CommandError('EXPORT_LIMIT', 'Export up to four frames per request.');
  const format = params.format ?? 'PNG';
  if (!['PNG', 'JPG', 'SVG'].includes(format)) throw new CommandError('INVALID_FORMAT', 'Supported formats: PNG, JPG, SVG.');
  const maxDimension = integer(params.maxDimension, 1600, 256, 4096);
  const requestedScale = params.scale ?? 1;
  if (typeof requestedScale !== 'number' || !Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 4) throw new CommandError('INVALID_SCALE', 'scale must be greater than 0 and at most 4.');
  const images: Params[] = [];
  for (const node of roots) {
    if (isCancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    assertScene(node);
    const bounds = ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null) ?? node.absoluteBoundingBox;
    const scale = Math.min(requestedScale, maxDimension / Math.max(bounds?.width ?? node.width, bounds?.height ?? node.height, 1));
    const bytes = await node.exportAsync(format === 'SVG' ? { format: 'SVG', svgOutlineText: true } : { format, constraint: { type: 'SCALE', value: scale }, contentsOnly: true });
    if (bytes.length > 8 * 1024 * 1024) throw new CommandError('EXPORT_TOO_LARGE', 'Export exceeds 8 MiB. Reduce maxDimension or export a smaller node.');
    images.push({ nodeId: node.id, name: node.name, format, scale, byteLength: bytes.length, bounds: plain(bounds), base64: base64(bytes) });
  }
  return { context: context(), images };
}

async function styles() {
  const groups = await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync()]);
  return groups.flat().map(style => {
    const source = style as any;
    const result: Params = { id: style.id, key: style.key, name: style.name, description: style.description, type: style.type, remote: style.remote };
    for (const field of ['paints', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'effects', 'layoutGrids', 'boundVariables']) if (field in source) result[field] = plain(source[field]);
    return result;
  });
}

async function variables(params: Params) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const local = await figma.variables.getLocalVariablesAsync();
  const filtered = params.collectionId ? local.filter(variable => variable.variableCollectionId === params.collectionId) : local;
  const offset = integer(params.offset, 0, 0, 100000);
  const limit = integer(params.limit, 500, 1, 2000);
  return {
    collections: collections.map(collection => ({ id: collection.id, key: collection.key, name: collection.name, modes: plain(collection.modes), defaultModeId: collection.defaultModeId, variableIds: collection.variableIds })),
    variables: filtered.slice(offset, offset + limit).map(variable => ({ id: variable.id, key: variable.key, name: variable.name, description: variable.description, collectionId: variable.variableCollectionId, resolvedType: variable.resolvedType, valuesByMode: plain(variable.valuesByMode), scopes: plain(variable.scopes), codeSyntax: plain(variable.codeSyntax) })),
    total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null
  };
}

async function focus(params: Params) {
  if (params.pageId && params.nodeIds === undefined) {
    const page = figma.root.children.find(page => page.id === params.pageId);
    if (!page) throw new CommandError('PAGE_NOT_FOUND', 'Page not found.');
    if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
    subscribePage(page);
    return { page: { id: page.id, name: page.name }, focused: [] };
  }
  const roots = await getRoots(params);
  for (const node of roots) assertScene(node);
  const nodes = roots as SceneNode[];
  let page: BaseNode | null = nodes[0];
  while (page && page.type !== 'PAGE') page = page.parent;
  if (!page || page.type !== 'PAGE') throw new CommandError('PAGE_NOT_FOUND', 'Cannot find the parent page.');
  if (nodes.some(node => { let p: BaseNode | null = node; while (p && p.type !== 'PAGE') p = p.parent; return p?.id !== page?.id; })) throw new CommandError('MIXED_PAGES', 'Focus nodes from the same page.');
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  return { focused: nodes.map(nodeSummary) };
}

async function patch(params: Params, isCancelled: () => boolean) {
  if (!writeEnabled) throw new CommandError('WRITE_DISABLED', 'Restart FigmaSpark using its native menu command: connect and allow edits.');
  reads.clear();
  if (!Array.isArray(params.operations) || !params.operations.length || params.operations.length > 50) throw new CommandError('INVALID_PATCH', 'Provide 1–50 operations.');
  const allowed = new Set(['name', 'characters', 'visible', 'opacity', 'fills', 'x', 'y', 'width', 'height', 'fontSize', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']);
  const staged: { node: SceneNode; changes: Params; before: Params; expected: Params }[] = [];
  function verifyExpected(node: SceneNode, expected: Params) {
    for (const [key, value] of Object.entries(expected)) {
      if (!allowed.has(key) || !(key in node)) throw new CommandError('INVALID_PATCH', `Unsupported expected property: ${key}.`);
      if (!equal(plain((node as any)[key]), value)) throw new CommandError('STALE_PATCH', `${key} on ${node.name} changed since it was inspected.`);
    }
  }
  const seen = new Set<string>();
  for (const op of params.operations) {
    if (!op || typeof op.nodeId !== 'string' || !op.changes || typeof op.changes !== 'object' || Array.isArray(op.changes) || !Object.keys(op.changes).length || (op.expected !== undefined && (!op.expected || typeof op.expected !== 'object' || Array.isArray(op.expected)))) throw new CommandError('INVALID_PATCH', 'Each operation needs nodeId, non-empty changes, and optional expected values.');
    if (seen.has(op.nodeId)) throw new CommandError('INVALID_PATCH', 'Use one operation per node.');
    seen.add(op.nodeId);
    const node = await figma.getNodeByIdAsync(op.nodeId);
    if (!node) throw new CommandError('NODE_NOT_FOUND', `Node not found: ${op.nodeId}`);
    assertScene(node);
    const source = node as any;
    verifyExpected(node, op.expected ?? {});
    if (('width' in op.changes || 'height' in op.changes) && typeof source.resize !== 'function') throw new CommandError('INVALID_PATCH', 'This node cannot be resized.');
    const before: Params = {};
    for (const [key, value] of Object.entries(op.changes)) {
      if (!allowed.has(key) || !(key in source)) throw new CommandError('INVALID_PATCH', `Unsupported property ${key} on ${node.name}.`);
      if (key === 'name' || key === 'characters') {
        if (typeof value !== 'string' || value.length > 100000) throw new CommandError('INVALID_PATCH', `${key} must be a bounded string.`);
      } else if (key === 'visible') {
        if (typeof value !== 'boolean') throw new CommandError('INVALID_PATCH', 'visible must be boolean.');
      } else if (key === 'fills') {
        if (!Array.isArray(value) || value.length > 10 || value.some(paint => paint.type !== 'SOLID' || !paint.color || ['r', 'g', 'b'].some(channel => typeof paint.color[channel] !== 'number' || paint.color[channel] < 0 || paint.color[channel] > 1) || (paint.opacity !== undefined && (typeof paint.opacity !== 'number' || paint.opacity < 0 || paint.opacity > 1)))) throw new CommandError('INVALID_PATCH', 'fills supports up to ten valid SOLID paints.');
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < (['x', 'y'].includes(key) ? -100000 : 0) || value > 100000 || (['width', 'height', 'fontSize'].includes(key) && value <= 0) || (key === 'opacity' && value > 1)) throw new CommandError('INVALID_PATCH', `Invalid number for ${key}.`);
      }
      before[key] = source[key];
    }
    if (node.type === 'TEXT' && ('characters' in op.changes || 'fontSize' in op.changes || 'fills' in op.changes)) {
      const fonts = node.getRangeAllFontNames(0, node.characters.length);
      if (!fonts.length && node.fontName !== figma.mixed) fonts.push(node.fontName);
      await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
    }
    if ('width' in op.changes || 'height' in op.changes) { before.width = node.width; before.height = node.height; }
    staged.push({ node, changes: op.changes, before, expected: op.expected ?? {} });
  }
  // Fonts may have loaded asynchronously while the user edited a layer.
  for (const item of staged) verifyExpected(item.node, item.expected);
  const applied: typeof staged = [];
  try {
    for (const item of staged) {
      if (!writeEnabled || isCancelled()) throw new CommandError('CANCELLED', 'Editing was disabled or the request was cancelled.');
      applied.push(item);
      const source = item.node as any;
      for (const [key, value] of Object.entries(item.changes)) if (key !== 'width' && key !== 'height') source[key] = value;
      if ('width' in item.changes || 'height' in item.changes) source.resize(item.changes.width ?? item.node.width, item.changes.height ?? item.node.height);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const item of [...applied].reverse()) try {
        const source = item.node as any;
        for (const [key, value] of Object.entries(item.before)) if (key !== 'width' && key !== 'height') source[key] = value;
        if ('width' in item.before || 'height' in item.before) source.resize(item.before.width ?? item.node.width, item.before.height ?? item.node.height);
      } catch { rollbackFailed = true; }
    if (rollbackFailed) throw new CommandError('ROLLBACK_FAILED', 'Some changes could not be restored. Use Figma Undo, then inspect the affected nodes.');
    throw error;
  }
  figma.commitUndo();
  onNodeChange();
  return { applied: staged.map(item => ({ nodeId: item.node.id, before: plain(item.before), after: plain(item.changes) })), undo: 'Use Figma Undo to revert this patch.' };
}

async function handle(command: string, params: Params, isCancelled: () => boolean): Promise<any> {
  figma.skipInvisibleInstanceChildren = params.includeHidden !== true;
  switch (command) {
    case 'ping': return { pong: true, revision };
    case 'context': return context();
    case 'pages': return { pages: pageIndex(figma.root.children, figma.currentPage.id) };
    case 'overview': return overview(params, isCancelled);
    case 'libraries': return libraries(params, isCancelled);
    case 'selection': return { context: context(), nodes: await Promise.all(figma.currentPage.selection.slice(0, 50).map(node => serializeNode(node, { detail: 'review', ...params }))), truncated: figma.currentPage.selection.length > 50 };
    case 'snapshot': return snapshot(params, isCancelled);
    case 'export': return exportNodes(params, isCancelled);
    case 'styles': return { styles: await styles() };
    case 'variables': return variables(params);
    case 'focus': return focus(params);
    case 'patch': return patch(params, isCancelled);
    case 'search': {
      if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 500) throw new CommandError('INVALID_QUERY', 'Provide a non-empty query, up to 500 characters.');
      if (params.match !== undefined && !['contains', 'exact'].includes(params.match)) throw new CommandError('INVALID_PARAMS', 'match must be contains or exact.');
      if (params.types !== undefined && (!Array.isArray(params.types) || params.types.some((type: any) => typeof type !== 'string'))) throw new CommandError('INVALID_PARAMS', 'types must be an array of node types.');
      const query = params.query.toLocaleLowerCase();
      if (params.scope === 'file') {
        const matches = pageIndex(figma.root.children, figma.currentPage.id).filter(page => params.match === 'exact' ? page.name.toLocaleLowerCase() === query : page.name.toLocaleLowerCase().includes(query));
        return { matches, total: matches.length, nextOffset: null, coverage: { level: 'pageNames', pageTreesLoaded: 0, truncated: false } };
      }
      const roots = await getRoots({ scope: 'page', ...params });
      const startRevision = revision;
      const walked = await reads.walk(roots, params, isCancelled);
      const matches = walked.items.filter(({ node }) => {
        if (params.types && !params.types.includes(node.type)) return false;
        const text = layerText(node);
        const fields = [node.name, ...(text ? [text] : [])];
        return fields.some(text => params.match === 'exact' ? text.toLocaleLowerCase() === query : text.toLocaleLowerCase().includes(query));
      });
      const offset = integer(params.offset, 0, 0, 20000), limit = integer(params.limit, 50, 1, 500);
      return { matches: matches.slice(offset, offset + limit).map(({ node }) => ({ ...compactSummary(node), frame: screenFor(node), ...(layerText(node) ? { text: textExcerpt(layerText(node)!, params.query) } : {}) })), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null, coverage: { scanned: walked.visited, truncated: walked.truncated, changedDuringRead: revision !== startRevision }, revision: startRevision, cache: { traversalHit: walked.cached } };
    }
    case 'inspect': {
      const roots = await getRoots(params);
      if (roots.length > 10) throw new CommandError('INSPECT_LIMIT', 'Inspect up to ten nodes per request.');
      const result: Params[] = [];
      for (const node of roots) {
        assertScene(node);
        const data = await serializeNode(node, { ...params, prototype: true });
        if (params.css) data.css = await node.getCSSAsync();
        result.push(data);
      }
      return { nodes: result, context: context() };
    }
    case 'audit': {
      if (!Array.isArray(params.requirements) || !params.requirements.length || params.requirements.length > 100) throw new CommandError('INVALID_REQUIREMENTS', 'Provide 1–100 requirements.');
      const roots = await getRoots(params);
      const startRevision = revision;
      const walked = await reads.walk(roots, params, isCancelled);
      const findings = await auditNodes(walked.items.map(item => item.node), params.requirements, walked.truncated);
      const changedDuringRead = startRevision !== revision;
      if (changedDuringRead) for (const finding of findings) if (finding.status === 'pass') { finding.status = 'unknown'; finding.evidence = 'The design changed during this review; repeat the check.'; }
      const report = { title: params.title ?? 'Проверка по документации', source: params.source ?? null, findings, context: context(), coverage: { rootIds: roots.map(node => node.id), scanned: walked.visited, truncated: walked.truncated, changedDuringRead }, generatedAt: new Date().toISOString() };
      latestReport = report;
      return report;
    }
    case 'report': {
      if (!Array.isArray(params.findings) || params.findings.length > 200 || params.findings.some((finding: any) => !finding || typeof finding.title !== 'string' || !['pass', 'fail', 'unknown'].includes(finding.status) || (finding.nodeIds !== undefined && (!Array.isArray(finding.nodeIds) || finding.nodeIds.length > 200 || finding.nodeIds.some((id: any) => typeof id !== 'string'))))) throw new CommandError('INVALID_REPORT', 'Provide up to 200 findings with title, status, and optional nodeIds.');
      const report = { title: params.title ?? 'Проверка по документации', source: params.source ?? null, findings: plain(params.findings), context: context(), generatedAt: new Date().toISOString() };
      latestReport = report;
      return { stored: params.findings.length, presentation: 'chat-or-file' };
    }
    case 'last-report': return latestReport;
    default: throw new CommandError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }
}

figma.ui.onmessage = (message: Params) => {
  if (message.type === 'ready') {
    figma.clientStorage.getAsync('spark-settings')
      .catch(() => ({}))
      .then(settings => figma.ui.postMessage({ type: 'init', context: context(), settings: settings ?? {} }));
    return;
  }
  if (message.type === 'settings') {
    const settings = message.settings;
    if (settings && typeof settings.code === 'string' && settings.code.length <= 100) figma.clientStorage.setAsync('spark-settings', { code: settings.code }).catch(() => {});
    return;
  }
  if (message.type === 'cancel' && typeof message.id === 'string') { if (activeRequests.has(message.id)) cancelled.add(message.id); return; }
  if (message.type !== 'request' || typeof message.id !== 'string' || typeof message.command !== 'string') return;
  if (activeRequests.has(message.id)) return;
  activeRequests.add(message.id);
  const receivedAt = Date.now();
  queue = queue.then(async () => {
    const isCancelled = () => cancelled.has(message.id);
    try {
      if (isCancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
      const result = await handle(message.command, message.params ?? {}, isCancelled);
      if (!isCancelled()) figma.ui.postMessage({ type: 'response', id: message.id, ok: true, result, executionMs: Date.now() - receivedAt });
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (!isCancelled()) figma.ui.postMessage({ type: 'response', id: message.id, ok: false, error: { code: failure?.code ?? 'PLUGIN_ERROR', message: failure?.message ?? String(error) } });
    } finally { cancelled.delete(message.id); activeRequests.delete(message.id); }
  });
};
