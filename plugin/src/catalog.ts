import { Params, PlainNode, CommandError, integer, plain, nodeSummary, walkNodes, serializeNode, cooperativeYield } from './document';

export class ReadCache {
  private epoch = 0;
  private walks = new Map<string, Awaited<ReturnType<typeof walkNodes>>>();
  private nodes = new Map<string, Promise<PlainNode>>();
  private summaries = new Map<string, Params>();
  clear() { this.epoch++; this.walks.clear(); this.nodes.clear(); this.summaries.clear(); }
  getSummary(key: string) { return this.summaries.get(key); }
  setSummary(key: string, value: Params) {
    if (this.summaries.size >= 8) this.summaries.delete(this.summaries.keys().next().value!);
    this.summaries.set(key, value);
  }
  async walk(roots: BaseNode[], params: Params, cancelled: () => boolean) {
    const key = JSON.stringify([roots.map(n => n.id), params.depth ?? 12, params.maxNodes ?? 5000, !!params.includeHidden]);
    if (params.refresh !== true && this.walks.has(key)) return { ...this.walks.get(key)!, cached: true };
    const epoch = this.epoch;
    const value = await walkNodes(roots, params, cancelled);
    if (this.walks.size >= 6) this.walks.delete(this.walks.keys().next().value!);
    if (!cancelled() && epoch === this.epoch) this.walks.set(key, value);
    return { ...value, cached: false };
  }
  async node(node: BaseNode, params: Params) {
    const key = JSON.stringify([node.id, params.detail ?? 'full', params.textSegments, params.components, !!params.prototype, !!params.includeHidden]);
    const hit = params.refresh !== true && this.nodes.has(key);
    let value = hit ? this.nodes.get(key)! : serializeNode(node, params);
    if (!hit) {
      if (this.nodes.size >= 2000) this.nodes.delete(this.nodes.keys().next().value!);
      this.nodes.set(key, value);
    }
    try { return { value: await value, cached: hit }; }
    catch (error) { if (this.nodes.get(key) === value) this.nodes.delete(key); throw error; }
  }
}

export function pageIndex(pages: readonly PageNode[], currentId: string) {
  // Reading page names does not require loading their layer trees.
  return pages.map(page => ({ id: page.id, name: page.name, current: page.id === currentId }));
}

export function screenFor(node: BaseNode): Params | null {
  let parent: BaseNode | null = node, frame: BaseNode | null = null;
  while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') {
    if (parent.type === 'FRAME') frame = parent;
    parent = parent.parent;
  }
  return frame ? { id: frame.id, name: frame.name } : null;
}

export function textExcerpt(text: string, query = '', limit = 140) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const at = query ? clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
  const start = Math.max(0, at - Math.floor(limit / 3));
  return (start ? '…' : '') + clean.slice(start, start + limit) + '…';
}

export function layerText(node: BaseNode): string | undefined {
  if ('characters' in node) return node.characters;
  if ('text' in node && typeof node.text?.characters === 'string') return node.text.characters;
}

export function compactSummary(node: BaseNode) {
  const summary = nodeSummary(node);
  if (node.name.length > 120) { summary.name = textExcerpt(node.name, '', 120); summary.nameTruncated = true; }
  return summary;
}

async function sampleBlock(root: BaseNode, cancelled: () => boolean, budget: number) {
  const labels = new Set<string>(), instances = new Set<string>();
  const queue: BaseNode[] = [root];
  const yieldIfBusy = cooperativeYield();
  let scanned = 0, head = 0, truncated = false, instanceCount = 0;
  while (head < queue.length && scanned < budget) {
    if (cancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    const node = queue[head++]; scanned++;
    if ('visible' in node && !node.visible) continue;
    const text = layerText(node);
    if (labels.size < 6 && text?.trim()) labels.add(textExcerpt(text, '', 80));
    if (node.type === 'INSTANCE') {
      instanceCount++;
      if (instances.size < 4) instances.add(textExcerpt(node.name, '', 80));
    }
    if ('children' in node) {
      const available = Math.max(0, budget - scanned - (queue.length - head));
      const children = node.children;
      if (children.length > available) truncated = true;
      for (let i = 0; i < Math.min(children.length, available); i++) queue.push(children[i]);
    }
    if (scanned % 100 === 0) await yieldIfBusy();
  }
  return { textHints: [...labels], componentHints: [...instances], sample: { scanned, instances: instanceCount, truncated: truncated || head < queue.length } };
}

export async function buildOverview(roots: BaseNode[], params: Params, cancelled: () => boolean) {
  const depth = integer(params.depth, 3, 0, 8), maxNodes = integer(params.maxNodes, 400, 1, 2000);
  const sampleBudget = integer(params.sampleNodes, 160, 0, 500);
  const limit = integer(params.limit, 60, 1, 200), offset = integer(params.offset, 0, 0, 2000);
  const queue = roots.map(node => ({ node, depth: 0 })), blocks: Params[] = [], notes: Params[] = [];
  const blockTypes = new Set(['SECTION', 'GROUP', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'TRANSFORM_GROUP']);
  const seen = new Set<string>();
  let head = 0, scanned = 0, truncated = false, noteCount = 0;
  while (head < queue.length && scanned < maxNodes) {
    if (cancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    const item = queue[head++], node = item.node;
    if (seen.has(node.id)) continue;
    seen.add(node.id); scanned++;
    if (!params.includeHidden && 'visible' in node && !node.visible) continue;
    if (blockTypes.has(node.type)) blocks.push({ node, depth: item.depth });
    else {
      const text = layerText(node);
      if (text?.trim()) {
        noteCount++;
        if (notes.length < 12) notes.push({ id: node.id, parentId: node.parent?.id ?? null, type: node.type, text: textExcerpt(text) });
      }
    }
    // Sections/groups may wrap screens; an instance is a reusable unit, not a screen tree.
    const stop = node.type === 'INSTANCE' || (item.depth > 0 && ['FRAME', 'COMPONENT', 'COMPONENT_SET'].includes(node.type));
    if ('children' in node && !stop) {
      if (item.depth >= depth && node.children.length) truncated = true;
      else {
        const available = Math.max(0, maxNodes - scanned - (queue.length - head));
        if (node.children.length > available) truncated = true;
        for (let i = 0; i < Math.min(node.children.length, available); i++) queue.push({ node: node.children[i], depth: item.depth + 1 });
      }
    }
  }
  const result: Params[] = [];
  for (const item of blocks.slice(offset, offset + limit)) {
    const node = item.node as BaseNode;
    result.push({ ...compactSummary(node), depth: item.depth, ...await sampleBlock(node, cancelled, sampleBudget) });
  }
  return {
    rootIds: roots.map(node => node.id), blocks: result, totalBlocks: blocks.length, notes,
    nextOffset: offset + limit < blocks.length ? offset + limit : null,
    coverage: { scanned, truncated: truncated || head < queue.length, detail: 'outline', sampledText: true, sampleNodesPerBlock: sampleBudget, notesFound: noteCount, notesTruncated: noteCount > notes.length, decorativeLayersOmitted: true },
    guidance: 'Page names cover the file. Blocks and text hints cover only the requested page/scope; hints are samples, not a full inventory. Drill into node IDs before verifying requirements.'
  };
}

export async function componentCatalog(nodes: BaseNode[], params: Params, cancelled: () => boolean) {
  const limit = integer(params.limit, 30, 1, 100);
  const components: Params[] = [], definitions = new Map<string, Params>();
  const instances = nodes.filter(node => node.type === 'INSTANCE') as InstanceNode[];
  const yieldIfBusy = cooperativeYield();
  let resolved = 0;
  for (const node of instances.slice(0, limit)) {
    if (cancelled()) throw new CommandError('CANCELLED', 'The request was cancelled.');
    try {
      const main = await node.getMainComponentAsync();
      if (!main) { components.push({ instanceId: node.id, name: node.name, unavailable: true, reason: 'Main component is unavailable.' }); continue; }
      resolved++;
      const owner = main.parent?.type === 'COMPONENT_SET' ? main.parent : main;
      let definition = definitions.get(owner.key || owner.id);
      if (!definition) {
        let properties: Params;
        try { properties = plain(owner.componentPropertyDefinitions); }
        catch (error) { properties = { unavailable: true, reason: textExcerpt((error as Error).message) }; }
        definition = { id: owner.id, key: owner.key, name: owner.name, type: owner.type, remote: owner.remote, description: owner.description || undefined, properties, instances: [] };
        definitions.set(owner.key || owner.id, definition); components.push(definition);
      }
      definition.instances.push({ id: node.id, name: node.name, mainComponent: { id: main.id, key: main.key, name: main.name }, properties: plain(node.componentProperties), variants: plain(node.variantProperties) });
    } catch (error) { components.push({ instanceId: node.id, name: node.name, unavailable: true, reason: textExcerpt((error as Error).message) }); }
    if (resolved % 10 === 0) await yieldIfBusy();
  }
  return { components, instancesFound: instances.length, resolved, truncated: instances.length > limit };
}
