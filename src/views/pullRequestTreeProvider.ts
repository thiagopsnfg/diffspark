import * as vscode from "vscode";
import type {BitbucketClient} from "../bitbucket/client";
import {buildFileTree, type FileTreeNode} from "../bitbucket/tree";
import type {
    BitbucketRepository,
    ChangedFile,
    PullRequest,
    PullRequestSort,
    PullRequestState,
} from "../bitbucket/types";

type TreeNode = PullRequestNode | PathNode;
export type FileLayout = "tree" | "list";

export interface PullRequestAuthor {
    accountId: string;
    displayName: string;
    avatarUrl?: string;
}

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
        showPath = false,
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
        this.iconPath =
            fileNode.kind === "directory"
                ? vscode.ThemeIcon.Folder
                : vscode.ThemeIcon.File;
        this.contextValue =
            fileNode.kind === "directory"
                ? "bitbucketChangedFolder"
                : "bitbucketChangedFile";
        if (fileNode.kind === "file") {
            if (showPath && fileNode.path.includes("/")) {
                this.description = `- ${fileNode.path.slice(0, fileNode.path.lastIndexOf("/"))}`;
            }
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
    private readonly changeEmitter = new vscode.EventEmitter<
        TreeNode | undefined | null
    >();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private states: PullRequestState[] = ["OPEN"];
    private includeDrafts = false;
    private sort: PullRequestSort = "-updated_on";
    private author: PullRequestAuthor | undefined;
    private loadedPullRequests: PullRequest[] = [];
    private fileLayout: FileLayout = "tree";

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
            return element.fileNode.children.map(
                (node) =>
                    new PathNode(
                        node,
                        element.repository,
                        element.pullRequestId,
                        element.files,
                        element.sourceBranch,
                        element.sourceRepositoryFullName,
                    ),
            );
        }

        try {
            if (element instanceof PullRequestNode) {
                const repository = this.getRepository();
                if (!repository) {
                    return [];
                }
                const files = await this.getClient().getChangedFiles(
                    repository,
                    element.pullRequest.id,
                );
                const fileTree = buildFileTree(files.map((file) => file.path));
                const flattenFiles = (nodes: FileTreeNode[]): FileTreeNode[] =>
                    nodes.flatMap((node) =>
                        node.kind === "file" ? [node] : flattenFiles(node.children),
                    );
                const nodes =
                    this.fileLayout === "list"
                        ? flattenFiles(fileTree).sort(
                              (a, b) =>
                                  a.name.localeCompare(b.name) ||
                                  a.path.localeCompare(b.path),
                          )
                        : fileTree;
                const filesByPath = new Map(files.map((file) => [file.path, file]));
                return nodes.map(
                    (node) =>
                        new PathNode(
                            node,
                            repository,
                            element.pullRequest.id,
                            filesByPath,
                            element.pullRequest.source.branch.name,
                            element.pullRequest.source.repository?.full_name,
                            this.fileLayout === "list",
                        ),
                );
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
            this.loadedPullRequests = pullRequests;
            const authorId = this.author?.accountId;
            const visible = authorId
                ? pullRequests.filter(
                      (pullRequest) => pullRequest.author?.account_id === authorId,
                  )
                : pullRequests;
            return visible.map((pullRequest) => new PullRequestNode(pullRequest));
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

    getLoadedPullRequests(): PullRequest[] {
        return [...this.loadedPullRequests];
    }

    getAuthors(): PullRequestAuthor[] {
        const authors = new Map<string, PullRequestAuthor>();
        for (const pullRequest of this.loadedPullRequests) {
            const accountId = pullRequest.author?.account_id;
            if (accountId && !authors.has(accountId)) {
                authors.set(accountId, {
                    accountId,
                    displayName: pullRequest.author?.display_name ?? accountId,
                    avatarUrl: pullRequest.author?.links?.avatar?.href,
                });
            }
        }
        if (this.author && !authors.has(this.author.accountId)) {
            authors.set(this.author.accountId, this.author);
        }
        return [...authors.values()].sort((a, b) =>
            a.displayName.localeCompare(b.displayName),
        );
    }

    getAuthor(): PullRequestAuthor | undefined {
        return this.author;
    }

    setAuthor(author: PullRequestAuthor | undefined): void {
        this.author = author;
        this.refresh();
    }

    setSort(sort: PullRequestSort): void {
        this.sort = sort;
        this.refresh();
    }

    setFileLayout(layout: FileLayout): void {
        this.fileLayout = layout;
        this.refresh();
    }

    refresh(): void {
        this.changeEmitter.fire(undefined);
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
