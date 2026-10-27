export interface FileTreeNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: FileTreeNode[];
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];

  for (const rawPath of paths) {
    const segments = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let siblings = roots;
    let currentPath = "";

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      let node = siblings.find((candidate) => candidate.name === segment);

      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          kind: isFile ? "file" : "directory",
          children: [],
        };
        siblings.push(node);
      } else if (isFile) {
        node.kind = "file";
      }

      siblings = node.children;
    });
  }

  const sortNodes = (nodes: FileTreeNode[]): void => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => sortNodes(node.children));
  };

  sortNodes(roots);
  return roots;
}
