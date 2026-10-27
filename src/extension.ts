import * as vscode from "vscode";
import { BitbucketClient } from "./bitbucket/client";
import { parseBitbucketRemoteUrl } from "./bitbucket/repository";
import { PullRequestWebview } from "./views/pullRequestWebview";
import { PullRequestTreeProvider } from "./views/pullRequestTreeProvider";
import {
  PullRequest,
  PullRequestState,
  BitbucketRepository,
} from "./bitbucket/types";

const EMAIL_SECRET = "bitbucket-pr-reviewer.email";
const TOKEN_SECRET = "bitbucket-pr-reviewer.api-token";
const PULL_REQUEST_STATES: PullRequestState[] = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];

interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

interface GitRepositoryHandle {
  rootUri: vscode.Uri;
  state: {
    remotes: GitRemote[];
  };
}

interface GitApi {
  repositories: GitRepositoryHandle[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

interface RepositoryCandidate {
  remoteName: string;
  handle: GitRepositoryHandle;
  bitbucket: BitbucketRepository;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("DiffSpark");
  context.subscriptions.push(output);

  let client: BitbucketClient | undefined;
  let selectedRepository: RepositoryCandidate | undefined;
  let treeView: vscode.TreeView<unknown> | undefined;

  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
    void vscode.window.showErrorMessage(`DiffSpark: ${message}`);
  };

  const getClient = (): BitbucketClient => {
    if (!client) {
      throw new Error("Connect to Bitbucket before loading pull requests.");
    }
    return client;
  };

  const getSelectedBitbucketRepository = (): BitbucketRepository | undefined =>
    selectedRepository?.bitbucket;

  const provider = new PullRequestTreeProvider(
    getClient,
    getSelectedBitbucketRepository,
    reportError,
  );
  const tree = vscode.window.createTreeView("bitbucketPrReviewer.pullRequests", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  treeView = tree;
  treeView.message = "Connect to Bitbucket to load pull requests.";
  context.subscriptions.push(tree, provider);

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      reportError(error);
    }
  };

  const connect = async (): Promise<boolean> => {
    const email = await vscode.window.showInputBox({
      prompt: "Bitbucket account email",
      placeHolder: "name@example.com",
      ignoreFocusOut: true,
      value: await context.secrets.get(EMAIL_SECRET),
      validateInput: (value) => value.includes("@") ? undefined : "Enter a valid account email.",
    });
    if (email === undefined) {
      return false;
    }

    const apiToken = await vscode.window.showInputBox({
      prompt: "Bitbucket API token",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Enter an API token.",
    });
    if (apiToken === undefined) {
      return false;
    }

    await context.secrets.store(EMAIL_SECRET, email.trim());
    await context.secrets.store(TOKEN_SECRET, apiToken);
    client = new BitbucketClient(email.trim(), apiToken);
    treeView.message = undefined;
    return true;
  };

  const ensureClient = async (): Promise<boolean> => {
    if (client) {
      return true;
    }
    const email = await context.secrets.get(EMAIL_SECRET);
    const apiToken = await context.secrets.get(TOKEN_SECRET);
    if (email && apiToken) {
      client = new BitbucketClient(email, apiToken);
      return true;
    }
    return connect();
  };

  const getGitApi = async (): Promise<GitApi> => {
    const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) {
      throw new Error("The built-in VS Code Git extension is unavailable.");
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  };

  const getCandidates = async (): Promise<RepositoryCandidate[]> => {
    const api = await getGitApi();
    return api.repositories.flatMap((handle) => {
      const candidates = handle.state.remotes.flatMap((remote) => {
        const bitbucket =
          parseBitbucketRemoteUrl(remote.fetchUrl ?? "") ??
          parseBitbucketRemoteUrl(remote.pushUrl ?? "");
        return bitbucket ? [{ remote, bitbucket }] : [];
      });
      const selected = candidates.find(({ remote }) => remote.name === "origin") ?? candidates[0];
      if (!selected) {
        return [];
      }
      return [{
        handle,
        bitbucket: selected.bitbucket,
        remoteName: selected.remote.name,
      }];
    });
  };

  const containsUri = (root: vscode.Uri, uri: vscode.Uri): boolean => {
    const rootPath = root.fsPath.endsWith("/") ? root.fsPath : `${root.fsPath}/`;
    return uri.fsPath === root.fsPath || uri.fsPath.startsWith(rootPath);
  };

  const chooseRepository = async (manual: boolean): Promise<boolean> => {
    const candidates = await getCandidates();
    if (candidates.length === 0) {
      selectedRepository = undefined;
      treeView.message = "No open Git repository has a Bitbucket Cloud remote.";
      throw new Error("Open a Git repository with a Bitbucket Cloud remote, then refresh.");
    }

    if (!manual && candidates.length === 1) {
      selectedRepository = candidates[0];
      treeView.message = `${selectedRepository.bitbucket.fullName} · ${selectedRepository.remoteName}`;
      return true;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeCandidate = activeUri
      ? candidates.find((candidate) => containsUri(candidate.handle.rootUri, activeUri))
      : undefined;
    if (!manual && activeCandidate) {
      selectedRepository = activeCandidate;
      treeView.message = `${selectedRepository.bitbucket.fullName} · ${selectedRepository.remoteName}`;
      return true;
    }

    const picked = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.bitbucket.fullName,
        description: `${candidate.remoteName} · ${vscode.workspace.asRelativePath(candidate.handle.rootUri)}`,
        candidate,
      })),
      { placeHolder: "Select the Bitbucket repository for pull request review" },
    );
    if (!picked) {
      return false;
    }
    selectedRepository = picked.candidate;
    treeView.message = `${selectedRepository.bitbucket.fullName} · ${selectedRepository.remoteName}`;
    return true;
  };

  const ensureRepository = async (): Promise<boolean> => {
    if (selectedRepository && selectedRepository.handle.state.remotes.some(
      (remote) => remote.name === selectedRepository?.remoteName,
    )) {
      return true;
    }
    return chooseRepository(false);
  };

  const refresh = async (): Promise<void> => {
    if (!(await ensureClient()) || !(await ensureRepository())) {
      return;
    }
    provider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("bitbucketPrReviewer.connect", () =>
      runAction(async () => {
        if (await connect()) {
          await refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.refresh", () =>
      runAction(refresh),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.selectRepository", () =>
      runAction(async () => {
        if (await chooseRepository(true)) {
          provider.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.filterPullRequests", () =>
      runAction(async () => {
        const selectedStates = await vscode.window.showQuickPick(
          PULL_REQUEST_STATES.map((state) => ({
            label: state,
            picked: state === "OPEN",
          })),
          {
            canPickMany: true,
            placeHolder: "Select pull request statuses (select none to show all)",
          },
        );
        if (selectedStates === undefined) {
          return;
        }
        const draftChoice = await vscode.window.showQuickPick(
          [
            { label: "Hide drafts", value: false },
            { label: "Include drafts", value: true },
          ],
          { placeHolder: "Show draft pull requests?" },
        );
        if (!draftChoice) {
          return;
        }
        provider.setFilters(
          selectedStates.map((item) => item.label),
          draftChoice.value,
        );
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.sortPullRequests", () =>
      runAction(async () => {
        const selected = await vscode.window.showQuickPick(
          [
            { label: "Recently updated", detail: "Most recently updated first", value: "-updated_on" as const },
            { label: "Oldest", detail: "Oldest pull requests first", value: "created_on" as const },
          ],
          { placeHolder: "Sort pull requests" },
        );
        if (selected) {
          provider.setSort(selected.value);
        }
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.openPullRequest",
      (pullRequest: PullRequest) =>
        runAction(async () => {
          if (!pullRequest || !(await ensureClient()) || !(await ensureRepository())) {
            return;
          }
          await PullRequestWebview.open(
            pullRequest,
            selectedRepository!.bitbucket,
            getClient(),
            reportError,
            () => provider.refresh(),
          );
        }),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      selectedRepository = undefined;
      treeView!.message = "Select a Bitbucket repository to load pull requests.";
      provider.refresh();
    }),
  );
}

export function deactivate(): void {}
