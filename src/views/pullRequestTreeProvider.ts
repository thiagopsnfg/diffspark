import * as vscode from "vscode";
import type {BitbucketClient} from "../bitbucket/client";
import {getReviewState} from "../bitbucket/reviewState";
import {markConflictedFiles} from "../bitbucket/conflicts";
import {buildFileTree, type FileTreeNode} from "../bitbucket/tree";
import type {
    BitbucketRepository,
    ChangedFile,
    FileConflict,
    PullRequest,
    PullRequestSort,
    PullRequestState,
    ReviewState,
} from "../bitbucket/types";

type TreeNode = PullRequestNode | PathNode;
export type FileLayout = "tree" | "list";

const TREE_URI_SCHEME = "diffspark-tree";
const CONFLICT_URI_QUERY = "conflict=1";

export interface PullRequestAuthor {
    accountId: string;
    displayName: string;
    avatarUrl?: string;
}

const REVIEW_PRESENTATION: Record<
    ReviewState | "unavailable",
    {label: string; icon: string; color?: string}
> = {
    approved: {
        icon: "check",
        label: "Approved by you",
        color: "testing.iconPassed",
    },
    changes_requested: {
        icon: "request-changes",
        color: "list.warningForeground",
        label: "Changes requested by you",
    },
    none: {
        icon: "git-pull-request",
        label: "No approval or change request from you",
    },
    unavailable: {
        icon: "git-pull-request",
        label: "Your review status is unavailable",
    },
};

export class PullRequestNode extends vscode.TreeItem {
    constructor(
        readonly pullRequest: PullRequest,
        reviewState?: ReviewState,
    ) {
        super(pullRequest.title, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `#${pullRequest.id} · ${pullRequest.draft ? "Draft · " : ""}${pullRequest.state}`;
        const review = REVIEW_PRESENTATION[reviewState ?? "unavailable"];
        this.iconPath = new vscode.ThemeIcon(
            review.icon,
            review.color ? new vscode.ThemeColor(review.color) : undefined,
        );
        this.tooltip = `${pullRequest.source.branch.name} → ${pullRequest.destination.branch.name}\n${review.label}`;
        this.accessibilityInformation = {
            label: `#${pullRequest.id} ${pullRequest.title}, ${pullRequest.draft ? "Draft, " : ""}${pullRequest.state}, ${review.label}`,
        };
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
        const conflicted =
            fileNode.kind === "file" && files.get(fileNode.path)?.conflicted === true;
        this.tooltip = conflicted ? `${fileNode.path}\nMerge conflict` : fileNode.path;
        // resourceUri + ThemeIcon.File/Folder lets VS Code render icons from the active file icon theme.
        this.resourceUri = vscode.Uri.from({
            scheme: TREE_URI_SCHEME,
            path: `/${repository.fullName}/${pullRequestId}/${fileNode.path}`,
            ...(conflicted ? {query: CONFLICT_URI_QUERY} : {}),
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
            if (conflicted) {
                this.accessibilityInformation = {
                    label: `${fileNode.path}, merge conflict`,
                };
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

export class PullRequestTreeProvider
    implements vscode.TreeDataProvider<TreeNode>, vscode.FileDecorationProvider
{
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
                const client = this.getClient();
                const [changedFiles, conflicts] = await Promise.all([
                    client.getChangedFiles(repository, element.pullRequest.id),
                    this.loadConflicts(client, repository, element.pullRequest),
                ]);
                const files = markConflictedFiles(changedFiles, conflicts);
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
            const client = this.getClient();
            const [pullRequests, accountId] = await Promise.all([
                client.listPullRequests(
                    repository,
                    this.states,
                    this.includeDrafts,
                    this.sort,
                ),
                client.getCurrentAccountId().catch((error: unknown) => {
                    this.onError(error);
                    return undefined;
                }),
            ]);
            this.loadedPullRequests = pullRequests;
            const authorId = this.author?.accountId;
            const visible = authorId
                ? pullRequests.filter(
                      (pullRequest) => pullRequest.author?.account_id === authorId,
                  )
                : pullRequests;
            return visible.map(
                (pullRequest) =>
                    new PullRequestNode(
                        pullRequest,
                        accountId ? getReviewState(pullRequest, accountId) : undefined,
                    ),
            );
        } catch (error) {
            this.onError(error);
            return [];
        }
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== TREE_URI_SCHEME || uri.query !== CONFLICT_URI_QUERY) {
            return undefined;
        }
        return new vscode.FileDecoration(
            "⚠",
            "Merge conflict",
            new vscode.ThemeColor("list.warningForeground"),
        );
    }

    private async loadConflicts(
        client: BitbucketClient,
        repository: BitbucketRepository,
        pullRequest: PullRequest,
    ): Promise<FileConflict[]> {
        if (pullRequest.state !== "OPEN") {
            return [];
        }
        try {
            return await client.getFileConflicts(repository, pullRequest.id);
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
