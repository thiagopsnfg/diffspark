import * as vscode from "vscode";
import { BitbucketClient } from "../bitbucket/client";
import { buildFileTree, FileTreeNode } from "../bitbucket/tree";
import {
  BitbucketRepository,
  ChangedFile,
  PullRequest,
  PullRequestSort,
  PullRequestState,
} from "../bitbucket/types";

type TreeNode = PullRequestNode | PathNode;

export class PullRequestNode extends vscode.TreeItem {
  constructor(readonly pullRequest: PullRequest) {
    super(pullRequest.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `#${pullRequest.id} · ${pullRequest.draft ? "Draft · " : ""}${pullRequest.state}`;
    this.tooltip = `${pullRequest.source.branch.name} → ${pullRequest.destination.branch.name}`;
    this.contextValue = "bitbucketPullRequest";
    this.command = {
      command: "bitbucketPrReviewer.openPullRequest",
      title: "Open Pull Request",
      arguments: [pullRequest],
    };
  }
}

class PathNode extends vscode.TreeItem {
  constructor(
    readonly fileNode: FileTreeNode,
    readonly repository: BitbucketRepository,
    readonly pullRequestId: number,
    readonly files: Map<string, ChangedFile>,
    readonly sourceBranch: string,
    readonly sourceRepositoryFullName?: string,
  ) {
    super(
      fileNode.name,
      fileNode.kind === "directory"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.tooltip = fileNode.path;
    // resourceUri + ThemeIcon.File/Folder lets VS Code render icons from the active file icon theme.
    this.resourceUri = vscode.Uri.from({
      scheme: "diffspark-tree",
      path: `/${repository.fullName}/${pullRequestId}/${fileNode.path}`,
    });
    this.iconPath = fileNode.kind === "directory" ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    this.contextValue = fileNode.kind === "directory" ? "bitbucketChangedFolder" : "bitbucketChangedFile";
    if (fileNode.kind === "file") {
      this.command = {
        command: "bitbucketPrReviewer.openChangedFile",
        title: "Open File Changes",
        arguments: [
          repository,
          pullRequestId,
          files.get(fileNode.path),
          sourceBranch,
          sourceRepositoryFullName ?? repository.fullName,
        ],
      };
    }
  }
}

export class PullRequestTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private states: PullRequestState[] = ["OPEN"];
  private includeDrafts = false;
  private sort: PullRequestSort = "-updated_on";

  constructor(
    private readonly getClient: () => BitbucketClient,
    private readonly getRepository: () => BitbucketRepository | undefined,
    private readonly onError: (error: unknown) => void,
  ) {}

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof PathNode) {
      return element.fileNode.children.map((node) => new PathNode(
        node,
        element.repository,
        element.pullRequestId,
        element.files,
        element.sourceBranch,
        element.sourceRepositoryFullName,
      ));
    }

    try {
      if (element instanceof PullRequestNode) {
        const repository = this.getRepository();
        if (!repository) {
          return [];
        }
        const files = await this.getClient().getChangedFiles(repository, element.pullRequest.id);
        const fileTree = buildFileTree(files.map((file) => file.path));
        const filesByPath = new Map(files.map((file) => [file.path, file]));
        return fileTree.map((node) => new PathNode(
          node,
          repository,
          element.pullRequest.id,
          filesByPath,
          element.pullRequest.source.branch.name,
          element.pullRequest.source.repository?.full_name,
        ));
      }

      const repository = this.getRepository();
      if (!repository) {
        return [];
      }
      const pullRequests = await this.getClient().listPullRequests(
        repository,
        this.states,
        this.includeDrafts,
        this.sort,
      );
      return pullRequests.map((pullRequest) => new PullRequestNode(pullRequest));
    } catch (error) {
      this.onError(error);
      return [];
    }
  }

  setFilters(states: PullRequestState[], includeDrafts: boolean): void {
    this.states = states;
    this.includeDrafts = includeDrafts;
    this.refresh();
  }

  setSort(sort: PullRequestSort): void {
    this.sort = sort;
    this.refresh();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
