
type KeepNode = ComponentNode | ComponentSetNode | InstanceNode;

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


function isKeepNode(
  node: SceneNode,
  includeOriginals: boolean,
  includeInstances: boolean
): node is KeepNode {
  const isOriginal = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
  const isInstance = node.type === 'INSTANCE';

  return (includeOriginals && isOriginal) || (includeInstances && isInstance);
}


function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node;
}


function collectKeepNodes(
  node: SceneNode,
  collected: Map<string, KeepNode>,
  includeOriginals: boolean,
  includeInstances: boolean
): void {
  if (isKeepNode(node, includeOriginals, includeInstances)) {
    collected.set(node.id, node);
  }

  if (!hasChildren(node)) {
    return;
  }

  for (const child of node.children) {
    collectKeepNodes(child, collected, includeOriginals, includeInstances);
  }
}


function filterNestedVariantComponents(nodes: KeepNode[]): KeepNode[] {
  const setIds = new Set(nodes.filter((node) => node.type === 'COMPONENT_SET').map((node) => node.id));

  return nodes.filter((node) => {
    if (node.type !== 'COMPONENT') {
      return true;
    }

    return !(node.parent?.type === 'COMPONENT_SET' && setIds.has(node.parent.id));
  });
}


function getCompactNodes(nodes: KeepNode[]): KeepNode[] {
  const modeNodes = filterNestedVariantComponents(nodes);

  return modeNodes.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type.localeCompare(b.type);
  });
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

function getNodeSize(node: KeepNode): { width: number; height: number } {
  return { width: node.width, height: node.height };
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
    return 'components, component sets, and instances';
  }
  if (options.includeOriginals) {
    return 'components and component sets';
  }
  return 'instances';
}

async function runExtraction(options: ExtractionOptions) {
  await figma.loadAllPagesAsync();

  if (!options.includeOriginals && !options.includeInstances) {
    figma.notify('Select at least one type: originals and/or instances.', { error: true });
    return;
  }

  const collected = new Map<string, KeepNode>();
  const targetPages = getPagesForScope(options);

  if (options.scope === 'selected-pages' && targetPages.length === 0) {
    figma.notify('Select at least one page in the plugin UI.', { error: true });
    return;
  }

  if (options.scope === 'current-selection') {
    const selectedNodes = figma.currentPage.selection;
    for (const node of selectedNodes) {
      collectKeepNodes(node, collected, options.includeOriginals, options.includeInstances);
    }
  } else {
    for (const page of targetPages) {
      for (const node of page.children) {
        collectKeepNodes(node, collected, options.includeOriginals, options.includeInstances);
      }
    }
  }

  const filtered = getCompactNodes(Array.from(collected.values()));

  if (filtered.length === 0) {
    const descriptor = getNodeTypeDescription(options);
    figma.notify(`No ${descriptor} were found for the selected scope.`, { error: true });
    return;
  }

  const targetPage = figma.createPage();
  targetPage.name = createPageName();

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const clonedNodes: SceneNode[] = [];

  for (const sourceNode of filtered) {
    const clone = sourceNode.clone();
    targetPage.appendChild(clone);

    const { width, height } = getNodeSize(clone);

    if (cursorX > 0 && cursorX + width > MAX_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + GRID_GAP;
      rowHeight = 0;
    }

    clone.x = cursorX;
    clone.y = cursorY;

    cursorX += width + GRID_GAP;
    rowHeight = Math.max(rowHeight, height);
    clonedNodes.push(clone);
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