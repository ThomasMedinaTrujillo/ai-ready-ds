
type KeepNode = ComponentNode | ComponentSetNode | InstanceNode;


const GRID_GAP = 120;

const MAX_ROW_WIDTH = 4800;


function isKeepNode(node: SceneNode): node is KeepNode {
  return (
    node.type === 'COMPONENT' ||
    node.type === 'COMPONENT_SET' 
  );
}


function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node;
}


function collectKeepNodes(node: SceneNode, collected: Map<string, KeepNode>): void {
  if (isKeepNode(node)) {
    collected.set(node.id, node);
  }

  if (!hasChildren(node)) {
    return;
  }

  for (const child of node.children) {
    collectKeepNodes(child, collected);
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


async function runExtraction() {
  // Load all pages first
  await figma.loadAllPagesAsync();

  const collected = new Map<string, KeepNode>();

  // Collect components from all pages
  for (const page of figma.root.children) {
    if (page.type === 'PAGE') {
      for (const node of page.children) {
        collectKeepNodes(node, collected);
      }
    }
  }

  const filtered = getCompactNodes(Array.from(collected.values()));

  if (filtered.length === 0) {
    figma.closePlugin('No components, component sets, or instances were found in the file.');
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

  figma.closePlugin(`Created ${targetPage.name} with ${clonedNodes.length} nodes (compact sets).`);
}

runExtraction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  figma.closePlugin(`Extraction failed: ${message}`);
  console.log(`${message}`);
  
});
