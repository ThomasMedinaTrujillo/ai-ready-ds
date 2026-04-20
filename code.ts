
type OriginalNode = ComponentNode | ComponentSetNode;

type DependencyNode = ComponentNode | ComponentSetNode;

interface ExtractionItem {
  sourceId: string;
  kind: 'original' | 'instance';
  name: string;
  depth: number;
  createNode: () => SceneNode;
}

interface ExtractionBatch {
  depth: number;
  items: ExtractionItem[];
}

type ExtractionScope = 'all-pages' | 'selected-pages' | 'current-selection';

interface ExtractionOptions {
  scope: ExtractionScope;
  includeOriginals: boolean;
  includeInstances: boolean;
  selectedPageIds: string[];
}

interface PageOption {
  id: string;
  name: string;
  isCurrent: boolean;
}

figma.showUI(__html__);
figma.ui.resize(420, 520);


const GRID_GAP = 120;

const MAX_ROW_WIDTH = 4800;


function isOriginalNode(node: SceneNode): node is OriginalNode {
  return node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
}


function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node;
}


function collectInstanceNodes(node: SceneNode, out: InstanceNode[]): void {
  if (node.type === 'INSTANCE') {
    out.push(node);
  }

  if (!hasChildren(node)) {
    return;
  }

  for (const child of node.children) {
    collectInstanceNodes(child, out);
  }
}


function collectExtractionSources(
  node: SceneNode,
  originals: Map<string, OriginalNode>,
  instanceCandidates: InstanceNode[],
  includeOriginals: boolean,
  includeInstances: boolean
): void {
  if ((includeOriginals || includeInstances) && isOriginalNode(node)) {
    originals.set(node.id, node);
  }

  if (includeInstances && node.type === 'INSTANCE') {
    instanceCandidates.push(node);
  }

  if (!hasChildren(node)) {
    return;
  }

  for (const child of node.children) {
    collectExtractionSources(
      child,
      originals,
      instanceCandidates,
      includeOriginals,
      includeInstances
    );
  }
}

function collectComponentsFromSet(node: ComponentSetNode, collected: Map<string, ComponentNode>): void {
  for (const child of node.children) {
    if (child.type === 'COMPONENT') {
      collected.set(child.id, child);
    }

    if (hasChildren(child)) {
      collectComponentsFromSet(child as ComponentSetNode, collected);
    }
  }
}


function filterNestedVariantComponents(nodes: OriginalNode[]): OriginalNode[] {
  const setIds = new Set(nodes.filter((node) => node.type === 'COMPONENT_SET').map((node) => node.id));

  return nodes.filter((node) => {
    if (node.type !== 'COMPONENT') {
      return true;
    }

    return !(node.parent?.type === 'COMPONENT_SET' && setIds.has(node.parent.id));
  });
}


async function getDirectComponentDependencies(node: DependencyNode): Promise<ComponentNode[]> {
  const instanceNodes: InstanceNode[] = [];
  collectInstanceNodes(node, instanceNodes);

  const mainComponents = await Promise.all(
    instanceNodes.map((instance) => instance.getMainComponentAsync())
  );

  const deps = new Map<string, ComponentNode>();
  for (const mainComponent of mainComponents) {
    if (!mainComponent || mainComponent.id === node.id) {
      continue;
    }

    deps.set(mainComponent.id, mainComponent);
  }

  return Array.from(deps.values());
}

async function computeDependencyDepth(
  node: DependencyNode,
  cache: Map<string, number>,
  visiting: Set<string>
): Promise<number> {
  const cached = cache.get(node.id);
  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(node.id)) {
    return 0;
  }

  visiting.add(node.id);
  const directDeps = await getDirectComponentDependencies(node);

  let depth = 0;
  for (const dependency of directDeps) {
    const dependencyDepth = await computeDependencyDepth(dependency, cache, visiting);
    depth = Math.max(depth, dependencyDepth + 1);
  }

  visiting.delete(node.id);
  cache.set(node.id, depth);
  return depth;
}

async function dedupeInstancesByMainComponent(instances: InstanceNode[]): Promise<InstanceNode[]> {
  const dedupedByMain = new Map<string, InstanceNode>();

  const pairs = await Promise.all(
    instances.map(async (instance) => ({
      instance,
      main: await instance.getMainComponentAsync(),
    }))
  );

  for (const pair of pairs) {
    const key = pair.main ? pair.main.id : pair.instance.id;
    if (!dedupedByMain.has(key)) {
      dedupedByMain.set(key, pair.instance);
    }
  }

  return Array.from(dedupedByMain.values());
}

async function addDependencySourcesFromInstances(
  instances: InstanceNode[],
  originals: Map<string, OriginalNode>
): Promise<void> {
  for (const instance of instances) {
    const main = await instance.getMainComponentAsync();
    if (!main) {
      continue;
    }

    originals.set(main.id, main);

    const parent = main.parent;
    if (parent && parent.type === 'COMPONENT_SET') {
      originals.set(parent.id, parent);
    }
  }
}

function getComponentChildrenOfSet(node: ComponentSetNode): ComponentNode[] {
  const components = new Map<string, ComponentNode>();
  collectComponentsFromSet(node, components);
  return Array.from(components.values());
}

function getRenderableOriginals(
  originals: OriginalNode[],
  includeOriginals: boolean,
  renderAsInstances: boolean
): OriginalNode[] {
  if (includeOriginals || !renderAsInstances) {
    return originals;
  }

  const expanded = new Map<string, OriginalNode>();

  for (const original of originals) {
    if (original.type === 'COMPONENT') {
      expanded.set(original.id, original);
      continue;
    }

    for (const component of getComponentChildrenOfSet(original)) {
      expanded.set(component.id, component);
    }
  }

  return Array.from(expanded.values());
}

async function createExtractionItems(
  originals: OriginalNode[],
  dedupedInstances: InstanceNode[],
  includeOriginals: boolean,
  includeInstances: boolean
): Promise<ExtractionItem[]> {
  const depthCache = new Map<string, number>();
  const items: ExtractionItem[] = [];
  const renderAsInstances = includeInstances && !includeOriginals;
  const renderableOriginals = getRenderableOriginals(originals, includeOriginals, renderAsInstances);
  const seenSourceIds = new Set<string>();

  if (renderAsInstances) {
    for (const original of renderableOriginals) {
      if (seenSourceIds.has(original.id)) {
        continue;
      }

      const depth = await computeDependencyDepth(original, depthCache, new Set<string>());
      seenSourceIds.add(original.id);
      items.push({
        sourceId: original.id,
        kind: 'instance',
        name: original.name,
        depth,
        createNode: () => {
          if (original.type === 'COMPONENT') {
            return original.createInstance();
          }

          return original.clone();
        },
      });
    }
  } else if (includeOriginals) {
    for (const original of renderableOriginals) {
      const depth = await computeDependencyDepth(original, depthCache, new Set<string>());
      items.push({
        sourceId: original.id,
        kind: 'original',
        name: original.name,
        depth,
        createNode: () => original.clone(),
      });
    }
  }

  if (includeInstances) {
    for (const instance of dedupedInstances) {
      const main = await instance.getMainComponentAsync();
      const depth = main ? await computeDependencyDepth(main, depthCache, new Set<string>()) : 0;
      const sourceId = main ? main.id : instance.id;

      if (renderAsInstances && seenSourceIds.has(sourceId)) {
        continue;
      }

      seenSourceIds.add(sourceId);

      items.push({
        sourceId,
        kind: 'instance',
        name: main ? `${main.name} Instance` : `${instance.name} Instance`,
        depth,
        createNode: () => {
          if (main) {
            return main.createInstance();
          }

          return instance.clone();
        },
      });
    }
  }

  return items.sort((a, b) => {
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }

    if (a.kind !== b.kind) {
      return a.kind === 'original' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });
}

function groupItemsByDepth(items: ExtractionItem[]): ExtractionBatch[] {
  const batches = new Map<number, ExtractionItem[]>();

  for (const item of items) {
    const batchItems = batches.get(item.depth) ?? [];
    batchItems.push(item);
    batches.set(item.depth, batchItems);
  }

  return Array.from(batches.entries())
    .sort(([depthA], [depthB]) => depthA - depthB)
    .map(([depth, batchItems]) => ({
      depth,
      items: batchItems.sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === 'original' ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      }),
    }));
}

function createPageName(): string {
  const date = new Date();
  const year = date.getFullYear();
  const monthNumber = date.getMonth() + 1;
  const dayNumber = date.getDate();
  const month = monthNumber < 10 ? `0${monthNumber}` : String(monthNumber);
  const day = dayNumber < 10 ? `0${dayNumber}` : String(dayNumber);
  return `AI_READY_${year}-${month}-${day}`;
}

function getNodeSize(node: SceneNode): { width: number; height: number } {
  return { width: node.width, height: node.height };
}

function getBatchFill(depth: number): RGB {
  const palette: RGB[] = [
    { r: 0.96, g: 0.97, b: 0.99 },
    { r: 0.95, g: 0.98, b: 0.96 },
    { r: 0.99, g: 0.96, b: 0.95 },
    { r: 0.98, g: 0.97, b: 0.93 },
  ];

  return palette[depth % palette.length];
}

function createBatchFrame(depth: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = `Dependency depth ${depth}`;
  frame.fills = [
    {
      type: 'SOLID',
      color: getBatchFill(depth),
    },
  ];
  frame.strokes = [
    {
      type: 'SOLID',
      color: { r: 0.82, g: 0.86, b: 0.91 },
    },
  ];
  frame.strokeWeight = 1;
  frame.cornerRadius = 16;
  frame.clipsContent = false;
  return frame;
}


function getPagesForScope(options: ExtractionOptions): PageNode[] {
  if (options.scope === 'all-pages') {
    return figma.root.children.filter((node): node is PageNode => node.type === 'PAGE');
  }

  if (options.scope === 'selected-pages') {
    const selected = new Set(options.selectedPageIds);
    return figma.root.children.filter(
      (node): node is PageNode => node.type === 'PAGE' && selected.has(node.id)
    );
  }

  return [figma.currentPage];
}

function getNodeTypeDescription(options: ExtractionOptions): string {
  if (options.includeOriginals && options.includeInstances) {
    return 'components/component sets and instances';
  }
  if (options.includeOriginals) {
    return 'components and component sets';
  }
  return 'instances used by components';
}

async function runExtraction(options: ExtractionOptions) {
  await figma.loadAllPagesAsync();

  if (!options.includeOriginals && !options.includeInstances) {
    figma.notify('Select at least one type: originals and/or instances.', { error: true });
    return;
  }

  const collectedOriginals = new Map<string, OriginalNode>();
  const instanceCandidates: InstanceNode[] = [];
  const targetPages = getPagesForScope(options);

  if (options.scope === 'selected-pages' && targetPages.length === 0) {
    figma.notify('Select at least one page in the plugin UI.', { error: true });
    return;
  }

  if (options.scope === 'current-selection') {
    const selectedNodes = figma.currentPage.selection;
    for (const node of selectedNodes) {
      collectExtractionSources(
        node,
        collectedOriginals,
        instanceCandidates,
        options.includeOriginals,
        options.includeInstances
      );
    }
  } else {
    for (const page of targetPages) {
      for (const node of page.children) {
        collectExtractionSources(
          node,
          collectedOriginals,
          instanceCandidates,
          options.includeOriginals,
          options.includeInstances
        );
      }
    }
  }

  const originals = filterNestedVariantComponents(Array.from(collectedOriginals.values()));
  const dedupedInstances = await dedupeInstancesByMainComponent(instanceCandidates);
  if (options.includeInstances && !options.includeOriginals) {
    await addDependencySourcesFromInstances(dedupedInstances, collectedOriginals);
  }

  const extractionItems = await createExtractionItems(
    filterNestedVariantComponents(Array.from(collectedOriginals.values())),
    dedupedInstances,
    options.includeOriginals,
    options.includeInstances
  );

  if (extractionItems.length === 0) {
    const descriptor = getNodeTypeDescription(options);
    figma.notify(`No ${descriptor} were found for the selected scope.`, { error: true });
    return;
  }

  const targetPage = figma.createPage();
  targetPage.name = createPageName();

  const clonedNodes: SceneNode[] = [];
  const batches = groupItemsByDepth(extractionItems);
  let batchCursorY = 0;
  const batchGap = 180;
  const innerGap = 120;
  const batchPadding = 32;

  for (const batch of batches) {
    const batchFrame = createBatchFrame(batch.depth);
    targetPage.appendChild(batchFrame);
    batchFrame.x = 0;
    batchFrame.y = batchCursorY;

    let cursorX = batchPadding;
    let cursorY = batchPadding;
    let rowHeight = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    for (const item of batch.items) {
      const clone = item.createNode();
      batchFrame.appendChild(clone);

      const { width, height } = getNodeSize(clone);

      if (cursorX > batchPadding && cursorX + width > MAX_ROW_WIDTH) {
        cursorX = batchPadding;
        cursorY += rowHeight + innerGap;
        rowHeight = 0;
      }

      clone.x = cursorX;
      clone.y = cursorY;

      cursorX += width + innerGap;
      rowHeight = Math.max(rowHeight, height);
      maxWidth = Math.max(maxWidth, cursorX);
      maxHeight = Math.max(maxHeight, cursorY + height);
      clonedNodes.push(clone);
    }

    batchFrame.resizeWithoutConstraints(maxWidth + batchPadding, maxHeight + batchPadding);
    batchCursorY += batchFrame.height + batchGap;
  }

  await figma.setCurrentPageAsync(targetPage);
  figma.currentPage.selection = clonedNodes;
  figma.viewport.scrollAndZoomIntoView(clonedNodes);

  figma.closePlugin(`Created ${targetPage.name} with ${clonedNodes.length} nodes.`);
}

function sendInitDataToUi() {
  const pageOptions: PageOption[] = figma.root.children
    .filter((node): node is PageNode => node.type === 'PAGE')
    .map((page) => ({
      id: page.id,
      name: page.name,
      isCurrent: page.id === figma.currentPage.id,
    }));

  figma.ui.postMessage({
    type: 'init',
    pages: pageOptions,
  });
}

sendInitDataToUi();



figma.ui.onmessage = (msg) => {
  if (msg.type === 'run-extraction') {
    const options: ExtractionOptions = {
      scope: msg.scope,
      includeOriginals: !!msg.includeOriginals,
      includeInstances: !!msg.includeInstances,
      selectedPageIds: Array.isArray(msg.selectedPageIds) ? msg.selectedPageIds : [],
    };

    runExtraction(options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      figma.closePlugin(`Extraction failed: ${message}`);
      console.log(`${message}`);
    });
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};