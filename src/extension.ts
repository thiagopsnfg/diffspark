import * as vscode from "vscode";
import { BitbucketClient } from "./bitbucket/client";
import { JiraClient } from "./jira/client";
import { parseBitbucketRemoteUrl } from "./bitbucket/repository";
import { PullRequestWebview } from "./views/pullRequestWebview";
import { PullRequestAuthor, PullRequestTreeProvider } from "./views/pullRequestTreeProvider";
import {
  PullRequest,
  PullRequestState,
  BitbucketRepository,
  ChangedFile,
  PullRequestComment,
} from "./bitbucket/types";
import { CommentImprover } from "./ai/service";
import { pickImproveOptions } from "./ai/actionPicker";
import { buildCodeSnippet, describeImproveOptions, ImproveOptions } from "./ai/prompt";

const EMAIL_SECRET = "bitbucket-pr-reviewer.email";
const TOKEN_SECRET = "bitbucket-pr-reviewer.api-token";
const JIRA_SITE_SECRET = "bitbucket-pr-reviewer.jira-site";
const JIRA_EMAIL_SECRET = "bitbucket-pr-reviewer.jira-email";
const JIRA_TOKEN_SECRET = "bitbucket-pr-reviewer.jira-api-token";
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
    HEAD?: { name?: string };
    workingTreeChanges: unknown[];
    indexChanges: unknown[];
    onDidChange?: vscode.Event<void>;
  };
  fetch(remote?: string, ref?: string): Promise<void>;
  checkout(treeish: string): Promise<void>;
}

interface GitApi {
  repositories: GitRepositoryHandle[];
  onDidOpenRepository?: vscode.Event<GitRepositoryHandle>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

interface RepositoryCandidate {
  remoteName: string;
  handle: GitRepositoryHandle;
  bitbucket: BitbucketRepository;
}

interface DiffMetadata {
  file: ChangedFile;
  repository: GitRepositoryHandle;
  bitbucketRepository: BitbucketRepository;
  pullRequestId: number;
  sourceBranch: string;
  sourceRepositoryFullName?: string;
  side: "before" | "after";
  path: string;
}

interface DiffComment extends vscode.Comment {
  bitbucketId: number;
  thread: vscode.CommentThread;
}

type AiCommentKind = "loading" | "suggestion" | "draft";

interface AiComment extends vscode.Comment {
  ai: {
    kind: AiCommentKind;
    thread: vscode.CommentThread;
    original: string;
    options: ImproveOptions;
  };
}

const AI_CONTEXT_VALUES: Record<AiCommentKind, string> = {
  loading: "diffsparkAiLoading",
  suggestion: "diffsparkAiSuggestion",
  draft: "diffsparkAiDraft",
};

const isAiComment = (comment: vscode.Comment | undefined): comment is AiComment =>
  Boolean(comment && (comment as AiComment).ai);

const commentText = (comment: vscode.Comment): string =>
  typeof comment.body === "string" ? comment.body : comment.body.value;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("DiffSpark");
  context.subscriptions.push(output);
  const improver = new CommentImprover(context.secrets);

  let client: BitbucketClient | undefined;
  let jiraClient: JiraClient | undefined;
  let selectedRepository: RepositoryCandidate | undefined;
  let treeView: vscode.TreeView<unknown> | undefined;

  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
    void vscode.window.showErrorMessage(`DiffSpark: ${message}`);
  };

  const [jiraSiteUrl, jiraEmail, jiraApiToken] = await Promise.all([
    context.secrets.get(JIRA_SITE_SECRET),
    context.secrets.get(JIRA_EMAIL_SECRET),
    context.secrets.get(JIRA_TOKEN_SECRET),
  ]);
  if (jiraSiteUrl && jiraEmail && jiraApiToken) {
    try {
      jiraClient = new JiraClient(jiraSiteUrl, jiraEmail, jiraApiToken);
    } catch (error) {
      reportError(error);
    }
  }

  const getClient = (): BitbucketClient => {
    if (!client) {
      throw new Error("Connect to Bitbucket before loading pull requests.");
    }
    return client;
  };

  const getJiraClient = (): JiraClient | undefined => jiraClient;

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

  const setAuthorFilter = (author: PullRequestAuthor | undefined): void => {
    tree.description = author ? `Author: ${author.displayName}` : undefined;
    provider.setAuthor(author);
  };

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

  const connectJira = async (): Promise<boolean> => {
    const siteUrl = await vscode.window.showInputBox({
      prompt: "Jira Cloud site URL",
      placeHolder: "https://example.atlassian.net",
      ignoreFocusOut: true,
      value: await context.secrets.get(JIRA_SITE_SECRET),
      validateInput: (value) => {
        try {
          const site = new URL(value.trim());
          return site.protocol === "https:" &&
            site.hostname.endsWith(".atlassian.net") &&
            !site.port &&
            !site.username &&
            !site.password &&
            !site.search &&
            !site.hash &&
            (site.pathname === "/" || site.pathname === "")
            ? undefined
            : "Enter a Jira Cloud site URL such as https://example.atlassian.net.";
        } catch {
          return "Enter a valid Jira Cloud site URL.";
        }
      },
    });
    if (siteUrl === undefined) {
      return false;
    }

    const email = await vscode.window.showInputBox({
      prompt: "Jira account email",
      placeHolder: "name@example.com",
      ignoreFocusOut: true,
      value: await context.secrets.get(JIRA_EMAIL_SECRET),
      validateInput: (value) => value.includes("@") ? undefined : "Enter a valid account email.",
    });
    if (email === undefined) {
      return false;
    }

    const apiToken = await vscode.window.showInputBox({
      prompt: "Jira API token",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Enter an API token.",
    });
    if (apiToken === undefined) {
      return false;
    }

    const normalizedSiteUrl = siteUrl.trim().replace(/\/+$/, "");
    const normalizedEmail = email.trim();
    const connectedClient = new JiraClient(normalizedSiteUrl, normalizedEmail, apiToken);
    await context.secrets.store(JIRA_SITE_SECRET, normalizedSiteUrl);
    await context.secrets.store(JIRA_EMAIL_SECRET, normalizedEmail);
    await context.secrets.store(JIRA_TOKEN_SECRET, apiToken);
    jiraClient = connectedClient;
    void vscode.window.showInformationMessage("DiffSpark: Jira connected.");
    return true;
  };

  const ensureJiraClient = async (): Promise<boolean> => {
    if (jiraClient) {
      return true;
    }
    const [siteUrl, email, apiToken] = await Promise.all([
      context.secrets.get(JIRA_SITE_SECRET),
      context.secrets.get(JIRA_EMAIL_SECRET),
      context.secrets.get(JIRA_TOKEN_SECRET),
    ]);
    if (siteUrl && email && apiToken) {
      jiraClient = new JiraClient(siteUrl, email, apiToken);
      return true;
    }
    return connectJira();
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

  // Loads pull requests on startup using stored credentials, without prompting the user.
  let autoLoading = false;
  const autoLoad = async (): Promise<void> => {
    if (selectedRepository || autoLoading) {
      return;
    }
    autoLoading = true;
    try {
      if (!client) {
        const [email, apiToken] = await Promise.all([
          context.secrets.get(EMAIL_SECRET),
          context.secrets.get(TOKEN_SECRET),
        ]);
        if (!email || !apiToken) {
          return;
        }
        client = new BitbucketClient(email, apiToken);
        treeView!.message = "Looking for a Bitbucket repository…";
      }
      const candidates = await getCandidates();
      if (candidates.length === 0 || selectedRepository) {
        return;
      }
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      selectedRepository = (activeUri
        ? candidates.find((candidate) => containsUri(candidate.handle.rootUri, activeUri))
        : undefined) ?? candidates[0];
      treeView!.message = `${selectedRepository.bitbucket.fullName} · ${selectedRepository.remoteName}`;
      provider.refresh();
    } catch (error) {
      output.appendLine(`[${new Date().toISOString()}] Auto-load failed: ${
        error instanceof Error ? error.message : String(error)
      }`);
    } finally {
      autoLoading = false;
    }
  };

  const watchGitRepositories = async (): Promise<void> => {
    try {
      const api = await getGitApi();
      const watchRepository = (repository: GitRepositoryHandle): void => {
        const subscription = repository.state.onDidChange?.(() => void autoLoad());
        if (subscription) {
          context.subscriptions.push(subscription);
        }
      };
      api.repositories.forEach(watchRepository);
      const openSubscription = api.onDidOpenRepository?.((repository) => {
        watchRepository(repository);
        void autoLoad();
      });
      if (openSubscription) {
        context.subscriptions.push(openSubscription);
      }
    } catch (error) {
      output.appendLine(`[${new Date().toISOString()}] ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    await autoLoad();
  };

  const diffContents = new Map<string, string>();
  const diffMetadata = new Map<string, DiffMetadata>();
  let diffSequence = 0;
  const commentController = vscode.comments.createCommentController("diffspark", "DiffSpark");
  commentController.options = {
    prompt: "Add a comment to this pull request",
    placeHolder: "Comment on this line (Markdown)",
  };
  commentController.commentingRangeProvider = {
    provideCommentingRanges: (document) => {
      const metadata = diffMetadata.get(document.uri.toString());
      if (!metadata) {
        return [];
      }
      if (
        (metadata.file.status === "added" && metadata.side === "before") ||
        (metadata.file.status === "removed" && metadata.side === "after")
      ) {
        return [];
      }
      return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
    },
  };
  context.subscriptions.push(
    commentController,
    vscode.workspace.registerTextDocumentContentProvider("diffspark", {
      provideTextDocumentContent: (uri) => diffContents.get(uri.toString()) ?? "",
    }),
    {
      dispose: () => {
        diffContents.clear();
        diffMetadata.clear();
      },
    },
  );

  const resolveDiffMetadata = (uri?: vscode.Uri): DiffMetadata => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const metadata = target && diffMetadata.get(target.toString());
    if (!metadata) {
      throw new Error("No DiffSpark diff is active.");
    }
    return metadata;
  };

  const openWorkspaceFile = async (metadata: DiffMetadata): Promise<void> => {
    const relativePath = metadata.file.newPath ?? metadata.file.path;
    if (
      relativePath.startsWith("/") ||
      relativePath.split(/[\\/]/).some((part) => part === "..")
    ) {
      throw new Error(`Invalid repository file path: ${relativePath}`);
    }
    const fileUri = vscode.Uri.joinPath(metadata.repository.rootUri, relativePath);
    if (!containsUri(metadata.repository.rootUri, fileUri)) {
      throw new Error(`File is outside the Git repository: ${relativePath}`);
    }
    await vscode.window.showTextDocument(fileUri, { preview: false });
  };

  const toDiffComment = (comment: PullRequestComment, thread: vscode.CommentThread): DiffComment => ({
    body: new vscode.MarkdownString(comment.deleted ? "_Comment deleted._" : comment.content?.raw ?? comment.content?.html ?? ""),
    mode: vscode.CommentMode.Preview,
    author: { name: comment.user?.display_name ?? "Unknown" },
    ...(comment.created_on ? { timestamp: new Date(comment.created_on) } : {}),
    bitbucketId: comment.id,
    thread,
    contextValue: comment.deleted ? undefined : "diffsparkPostedComment",
  });

  const loadInlineComments = async (
    left: vscode.Uri,
    right: vscode.Uri,
    file: ChangedFile,
    repository: BitbucketRepository,
    pullRequestId: number,
  ): Promise<void> => {
    const comments = await getClient().getComments(repository, pullRequestId);
    const threadByCommentId = new Map<number, vscode.CommentThread>();
    const rootComments = comments.filter((comment) => !comment.parent);

    for (const comment of rootComments) {
      const inline = comment.inline;
      if (!inline || !Number.isInteger(inline.to ?? inline.from)) {
        continue;
      }
      const afterPath = file.newPath ?? file.path;
      const beforePath = file.oldPath ?? file.path;
      const side = inline.to !== undefined ? "after" : "before";
      const expectedPath = side === "after" ? afterPath : beforePath;
      if (inline.path !== expectedPath) {
        continue;
      }
      const line = (inline.to ?? inline.from)!;
      if (line < 1) {
        continue;
      }
      const uri = side === "after" ? right : left;
      const thread = commentController.createCommentThread(
        uri,
        new vscode.Range(line - 1, 0, line - 1, 0),
        [],
      );
      thread.comments = [toDiffComment(comment, thread)];
      threadByCommentId.set(comment.id, thread);
    }

    for (const comment of comments) {
      if (!comment.parent) {
        continue;
      }
      const thread = threadByCommentId.get(comment.parent.id);
      if (thread) {
        thread.comments = [...thread.comments, toDiffComment(comment, thread)];
      }
    }
  };

  const postDiffComment = async (thread: vscode.CommentThread, text: string): Promise<boolean> => {
    if (!text.trim()) {
      return false;
    }
    const metadata = diffMetadata.get(thread.uri.toString());
    if (!metadata) {
      throw new Error("The pull request diff for this comment is no longer available.");
    }
    const firstComment = thread.comments.find((comment) => !isAiComment(comment)) as DiffComment | undefined;
    const parentId = firstComment?.bitbucketId;
    const line = thread.range?.start.line;
    if (parentId === undefined && line === undefined) {
      throw new Error("Could not determine the line for this pull request comment.");
    }
    const created = await getClient().createComment(
      metadata.bitbucketRepository,
      metadata.pullRequestId,
      text,
      parentId,
      parentId === undefined
        ? {
            path: metadata.path,
            ...(metadata.side === "after" ? { to: line! + 1 } : { from: line! + 1 }),
          }
        : undefined,
    );
    const posted = thread.comments.filter((comment) => !isAiComment(comment));
    const drafts = thread.comments.filter(isAiComment);
    thread.comments = [...posted, toDiffComment(created, thread), ...drafts];
    return true;
  };

  const aiAuthorIcon = vscode.Uri.joinPath(context.extensionUri, "resources", "diffspark-icon.png");

  const setAiComment = (
    thread: vscode.CommentThread,
    kind: AiCommentKind,
    text: string,
    original: string,
    options: ImproveOptions,
  ): void => {
    const loadingBody = new vscode.MarkdownString(
      `$(loading~spin) **${describeImproveOptions(options)}** with ${improver.getProviderLabel()}…`,
      true,
    );
    const comment: AiComment = {
      body: kind === "loading" ? loadingBody : text,
      mode: kind === "loading" ? vscode.CommentMode.Preview : vscode.CommentMode.Editing,
      author: {
        name: kind === "draft" ? "Draft · not posted" : "Improve comment",
        iconPath: aiAuthorIcon,
      },
      label: kind === "suggestion" ? `AI suggestion · ${describeImproveOptions(options)}` : undefined,
      contextValue: AI_CONTEXT_VALUES[kind],
      ai: { kind, thread, original, options },
    };
    thread.comments = [...thread.comments.filter((item) => !isAiComment(item)), comment];
  };

  const removeAiComments = (thread: vscode.CommentThread): void => {
    thread.comments = thread.comments.filter((item) => !isAiComment(item));
  };

  const improveInThread = async (
    thread: vscode.CommentThread,
    original: string,
    options: ImproveOptions,
    fallback: { kind: AiCommentKind; text: string; original: string; options: ImproveOptions },
  ): Promise<void> => {
    if (!original.trim()) {
      void vscode.window.showInformationMessage("DiffSpark: Write your comment first, then use \"Improve comment\".");
      return;
    }
    const metadata = diffMetadata.get(thread.uri.toString());
    const line = thread.range?.start.line ?? 0;
    const lines = (diffContents.get(thread.uri.toString()) ?? "").split(/\r?\n/);
    const discussion = thread.comments
      .filter((item) => !isAiComment(item))
      .map((item) => `${item.author.name}: ${commentText(item)}`);

    setAiComment(thread, "loading", "", original, options);
    try {
      const suggestion = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `DiffSpark: ${describeImproveOptions(options)} with ${improver.getProviderLabel()}…`,
          cancellable: true,
        },
        (_progress, token) =>
          improver.improve(
            {
              ...options,
              comment: original,
              filePath: metadata?.path,
              codeSnippet: lines.length > 1 || lines[0] ? buildCodeSnippet(lines, line) : undefined,
              discussion,
            },
            token,
          ),
      );
      setAiComment(thread, "suggestion", suggestion, original, options);
    } catch (error) {
      setAiComment(thread, fallback.kind, fallback.text, fallback.original, fallback.options);
      if (!(error instanceof vscode.CancellationError)) {
        throw error;
      }
    }
  };

  const improveFromReply = async (reply: vscode.CommentReply, pick: boolean): Promise<void> => {
    const text = reply.text;
    if (!text.trim()) {
      void vscode.window.showInformationMessage("DiffSpark: Write your comment first, then use \"Improve comment\".");
      return;
    }
    const options: ImproveOptions | undefined = pick ? await pickImproveOptions() : { action: "improve" };
    if (!options) {
      // The reply box is cleared after this command returns, so keep the text as an editable draft.
      setAiComment(reply.thread, "draft", text, text, { action: "improve" });
      return;
    }
    await improveInThread(reply.thread, text, options, { kind: "draft", text, original: text, options });
  };

  const improveFromDraft = async (comment: AiComment, pick: boolean): Promise<void> => {
    const text = commentText(comment);
    const options: ImproveOptions | undefined = pick ? await pickImproveOptions() : { action: "improve" };
    if (!options) {
      setAiComment(comment.ai.thread, "draft", text, text, comment.ai.options);
      return;
    }
    await improveInThread(comment.ai.thread, text, options, { kind: "draft", text, original: text, options });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.deleteDiffComment",
      (comment: DiffComment) => runAction(async () => {
        if (!comment || comment.contextValue !== "diffsparkPostedComment" ||
            !comment.thread?.comments.includes(comment)) {
          throw new Error("This pull request comment is no longer available.");
        }
        const metadata = resolveDiffMetadata(comment.thread.uri);
        const choice = await vscode.window.showWarningMessage(
          "Delete this comment from Bitbucket? This cannot be undone. Replies will be kept.",
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") {
          return;
        }
        await getClient().deleteComment(metadata.bitbucketRepository, metadata.pullRequestId, comment.bitbucketId);
        comment.thread.comments = comment.thread.comments.map((item) =>
          item === comment
            ? { ...comment, body: new vscode.MarkdownString("_Comment deleted._"), contextValue: undefined }
            : item,
        );
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.createDiffComment",
      (reply: vscode.CommentReply) => runAction(async () => {
        await postDiffComment(reply.thread, reply.text);
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.replyDiffComment",
      (reply: vscode.CommentReply) => runAction(async () => {
        await postDiffComment(reply.thread, reply.text);
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.improveDiffComment",
      (reply: vscode.CommentReply) => runAction(() => improveFromReply(reply, false)),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.improveDiffCommentWith",
      (reply: vscode.CommentReply) => runAction(() => improveFromReply(reply, true)),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiSuggestionReplace",
      (comment: AiComment) => runAction(async () => {
        const text = commentText(comment);
        try {
          if (await postDiffComment(comment.ai.thread, text)) {
            removeAiComments(comment.ai.thread);
          } else {
            setAiComment(comment.ai.thread, "suggestion", text, comment.ai.original, comment.ai.options);
          }
        } catch (error) {
          setAiComment(comment.ai.thread, "suggestion", text, comment.ai.original, comment.ai.options);
          throw error;
        }
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiSuggestionInsert",
      (comment: AiComment) => runAction(async () => {
        const text = `${comment.ai.original.trimEnd()}\n\n${commentText(comment).trim()}`;
        setAiComment(comment.ai.thread, "draft", text, text, comment.ai.options);
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiSuggestionRetry",
      (comment: AiComment) => runAction(() =>
        improveInThread(comment.ai.thread, comment.ai.original, comment.ai.options, {
          kind: "suggestion",
          text: commentText(comment),
          original: comment.ai.original,
          options: comment.ai.options,
        }),
      ),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiSuggestionDiscard",
      (comment: AiComment) => runAction(async () => {
        setAiComment(comment.ai.thread, "draft", comment.ai.original, comment.ai.original, comment.ai.options);
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiDraftPost",
      (comment: AiComment) => runAction(async () => {
        const text = commentText(comment);
        try {
          if (await postDiffComment(comment.ai.thread, text)) {
            removeAiComments(comment.ai.thread);
          } else {
            setAiComment(comment.ai.thread, "draft", text, text, comment.ai.options);
          }
        } catch (error) {
          setAiComment(comment.ai.thread, "draft", text, text, comment.ai.options);
          throw error;
        }
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiDraftImprove",
      (comment: AiComment) => runAction(() => improveFromDraft(comment, false)),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiDraftImproveWith",
      (comment: AiComment) => runAction(() => improveFromDraft(comment, true)),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.aiDraftDelete",
      (comment: AiComment) => runAction(async () => {
        removeAiComments(comment.ai.thread);
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.selectAiProvider", () =>
      runAction(async () => {
        await improver.selectProvider();
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.setAiApiKey", () =>
      runAction(async () => {
        if (await improver.setApiKey()) {
          void vscode.window.showInformationMessage("DiffSpark: API key saved.");
        }
      }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.openChangedFile",
      (
        repository: BitbucketRepository,
        pullRequestId: number,
        file: ChangedFile,
        sourceBranch: string,
        sourceRepositoryFullName?: string,
      ) =>
        runAction(async () => {
          if (!repository || !file || !sourceBranch || !(await ensureClient())) {
            return;
          }
          const gitRepository = selectedRepository?.handle;
          if (!gitRepository || selectedRepository?.bitbucket.fullName !== repository.fullName) {
            throw new Error("The pull request's Git repository is no longer selected.");
          }
          const { before, after } = await getClient().getFileComparison(repository, pullRequestId, file);
          const comparisonId = ++diffSequence;
          const metadata: Omit<DiffMetadata, "side" | "path"> = {
            file,
            repository: gitRepository,
            bitbucketRepository: repository,
            pullRequestId,
            sourceBranch,
            sourceRepositoryFullName,
          };
          const makeUri = (
            side: "before" | "after",
            path: string,
            content: string,
          ): vscode.Uri => {
            const uri = vscode.Uri.from({
              scheme: "diffspark",
              path: `/${repository.fullName}/PR-${pullRequestId}/${comparisonId}/${side}/${path}`,
            });
            diffContents.set(uri.toString(), content);
            diffMetadata.set(uri.toString(), { ...metadata, side, path });
            return uri;
          };
          const left = makeUri("before", file.oldPath ?? file.path, before);
          const right = makeUri("after", file.newPath ?? file.path, after);
          await vscode.commands.executeCommand(
            "vscode.diff", left, right, `${file.path} (PR #${pullRequestId})`, { preview: true },
          );
          try {
            await loadInlineComments(left, right, file, repository, pullRequestId);
          } catch (error) {
            reportError(error);
          }
        }),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.openWorkspaceFile",
      (uri?: vscode.Uri) =>
        runAction(() => openWorkspaceFile(resolveDiffMetadata(uri))),
    ),
    vscode.commands.registerCommand(
      "bitbucketPrReviewer.openFileOnPrBranch",
      (uri?: vscode.Uri) =>
        runAction(async () => {
          const metadata = resolveDiffMetadata(uri);
          const sourceRepository = metadata.sourceRepositoryFullName;
          const sourceRemote = metadata.repository.state.remotes.find((remote) =>
            [remote.fetchUrl, remote.pushUrl].some(
              (url) =>
                url !== undefined &&
                parseBitbucketRemoteUrl(url)?.fullName === sourceRepository,
            ),
          );
          if (!sourceRemote) {
            throw new Error(
              sourceRepository
                ? `Add a Git remote for the pull request source repository (${sourceRepository}) before checking out its branch.`
                : "The pull request source repository could not be identified.",
            );
          }

          const gitRepository = metadata.repository;
          if (gitRepository.state.HEAD?.name !== metadata.sourceBranch) {
            if (
              gitRepository.state.workingTreeChanges.length > 0 ||
              gitRepository.state.indexChanges.length > 0
            ) {
              const answer = await vscode.window.showWarningMessage(
                `You have uncommitted changes. Check out "${metadata.sourceBranch}" anyway?`,
                { modal: true },
                "Checkout",
              );
              if (answer !== "Checkout") {
                return;
              }
            }

            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Checking out ${metadata.sourceBranch}…`,
              },
              async () => {
                await gitRepository.fetch(sourceRemote.name, metadata.sourceBranch);
                await gitRepository.checkout(metadata.sourceBranch);
              },
            );
          }
          await openWorkspaceFile(metadata);
        }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.connect", () =>
      runAction(async () => {
        if (await connect()) {
          await refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.connectJira", () =>
      runAction(async () => {
        await connectJira();
      }),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.refresh", () =>
      runAction(refresh),
    ),
    vscode.commands.registerCommand("bitbucketPrReviewer.selectRepository", () =>
      runAction(async () => {
        if (await chooseRepository(true)) {
          setAuthorFilter(undefined);
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
    vscode.commands.registerCommand("bitbucketPrReviewer.filterByAuthor", () =>
      runAction(async () => {
        const current = provider.getAuthor();
        const authors = provider.getAuthors();
        const selected = await vscode.window.showQuickPick(
          [
            {
              label: "All authors",
              description: current ? undefined : "(current)",
              author: undefined as PullRequestAuthor | undefined,
            },
            ...authors.map((author) => ({
              label: author.displayName,
              description: author.accountId === current?.accountId ? "(current)" : undefined,
              author,
            })),
          ],
          {
            placeHolder: authors.length > 0
              ? "Filter pull requests by author"
              : "No authors found in the loaded pull requests",
            matchOnDescription: true,
          },
        );
        if (selected) {
          setAuthorFilter(selected.author);
        }
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
            getJiraClient,
            ensureJiraClient,
            improver,
          );
        }),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      selectedRepository = undefined;
      treeView!.message = "Select a Bitbucket repository to load pull requests.";
      setAuthorFilter(undefined);
      void autoLoad();
    }),
  );

  void watchGitRepositories();
}

export function deactivate(): void {}
