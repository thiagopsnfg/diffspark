import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BitbucketClient } from "../bitbucket/client";
import { BitbucketRepository, MergeStrategy, PullRequest, PullRequestComment } from "../bitbucket/types";
import { renderMarkdown, sanitizeCommentHtml } from "./markdown";

export class PullRequestWebview {
  private disposed = false;
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly pullRequest: PullRequest,
    private readonly repository: BitbucketRepository,
    private readonly client: BitbucketClient,
    private readonly onError: (error: unknown) => void,
    private readonly onMerged: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "bitbucketPullRequest",
      `PR #${pullRequest.id}: ${pullRequest.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  static async open(
    pullRequest: PullRequest,
    repository: BitbucketRepository,
    client: BitbucketClient,
    onError: (error: unknown) => void,
    onMerged: () => void,
  ): Promise<PullRequestWebview> {
    const view = new PullRequestWebview(pullRequest, repository, client, onError, onMerged);
    await view.refresh();
    return view;
  }

  private async refresh(): Promise<void> {
    const comments = await this.client.getComments(this.repository, this.pullRequest.id);
    if (!this.disposed) {
      this.panel.webview.html = this.render(comments);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      this.onError(new Error("Received an invalid pull request view message."));
      return;
    }

    try {
      if (message.command === "approve") {
        await this.approve();
        return;
      }
      if (message.command === "requestChanges") {
        await this.requestChanges();
        return;
      }
      if (message.command === "merge") {
        await this.merge(message.strategy, message.closeSourceBranch);
        return;
      }

      if (message.command === "comment" || message.command === "reply") {
        const markdownText = message.markdown.trim();
        if (!markdownText || markdownText.length > 10_000) {
          throw new Error("Comments must contain 1–10,000 characters.");
        }
        await this.client.createComment(
          this.repository,
          this.pullRequest.id,
          markdownText,
          message.command === "reply" ? message.parentId : undefined,
        );
        await this.refresh();
        return;
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private async approve(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Approve pull request #${this.pullRequest.id}?`,
      { modal: true },
      "Approve",
    );
    if (choice !== "Approve") {
      return;
    }
    await this.client.approve(this.repository, this.pullRequest.id);
    void vscode.window.showInformationMessage(`Pull request #${this.pullRequest.id} approved.`);
    await this.refresh();
  }

  private async requestChanges(): Promise<void> {
    const reason = await vscode.window.showInputBox({
      title: `Request changes on pull request #${this.pullRequest.id}`,
      prompt: "Optionally describe what needs to change. It will be posted as a Markdown comment.",
      placeHolder: "What should be adjusted? (optional)",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length > 10_000 ? "Comments must contain at most 10,000 characters." : undefined,
    });
    if (reason === undefined) {
      return;
    }
    await this.client.requestChanges(this.repository, this.pullRequest.id);
    const comment = reason.trim();
    if (comment) {
      await this.client.createComment(this.repository, this.pullRequest.id, comment);
    }
    void vscode.window.showInformationMessage(`Changes requested on pull request #${this.pullRequest.id}.`);
    await this.refresh();
  }

  private async merge(strategy: MergeStrategy, closeSourceBranch: boolean): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Merge PR #${this.pullRequest.id}?\n${this.pullRequest.source.branch.name} → ${this.pullRequest.destination.branch.name}\nStrategy: ${strategy}\nClose source branch: ${closeSourceBranch ? "yes" : "no"}`,
      { modal: true },
      "Merge",
    );
    if (choice !== "Merge") {
      return;
    }

    await this.client.merge(this.repository, this.pullRequest.id, strategy, closeSourceBranch);
    void vscode.window.showInformationMessage(`Pull request #${this.pullRequest.id} merged.`);
    this.onMerged();
  }

  private render(comments: PullRequestComment[]): string {
    const nonce = randomBytes(16).toString("base64");
    const description = renderMarkdown(this.pullRequest.description ?? "");
    const state = this.pullRequest.draft
      ? "Draft"
      : this.pullRequest.state.charAt(0) + this.pullRequest.state.slice(1).toLowerCase();
    const renderedComments = comments.map((comment) => {
      const rawMarkdown = comment.content?.raw ?? comment.content?.html ?? "";
      const content = comment.content?.raw
        ? renderMarkdown(rawMarkdown)
        : sanitizeCommentHtml(rawMarkdown);
      const parentId = comment.parent?.id;
      const replyControl = parentId === undefined
        ? `<button class="secondary reply" data-parent="${comment.id}">Reply</button>`
        : "";
      return `<article class="comment" id="comment-${comment.id}"${parentId === undefined ? "" : ' data-reply="true"'}><header><strong>${escapeHtml(comment.user?.display_name ?? "Unknown user")}</strong><span>${escapeHtml(formatDate(comment.created_on))}</span></header><div class="markdown">${content}</div>${replyControl}</article>`;
    }).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(this.pullRequest.title)}</title>
  <style nonce="${nonce}">
    body { box-sizing: border-box; max-width: 1080px; margin: 0 auto; padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 3rem; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); line-height: 1.55; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin: .8rem 0 .65rem; font-size: 1.65rem; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
    h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
    .pr-header { padding: .25rem 0 1.25rem; }
    .pr-kicker, .meta, .comment header span { color: var(--vscode-descriptionForeground); font-size: .9em; }
    .pr-kicker, .meta, .branches, .actions, .composer-actions { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; }
    .pr-kicker { gap: .5rem; }
    .status { display: inline-flex; align-items: center; padding: .12rem .55rem; border: 1px solid var(--vscode-panel-border); border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .85em; font-weight: 600; }
    .meta { margin: 0; }
    .branches { margin-top: 1rem; }
    .branch { display: inline-flex; max-width: 100%; padding: .25rem .6rem; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-sideBar-background); font-family: var(--vscode-editor-font-family); font-size: .9em; overflow-wrap: anywhere; }
    .branch-arrow { color: var(--vscode-descriptionForeground); }
    .section { margin-top: 1.25rem; padding: 1.1rem 1.2rem; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .85rem; }
    .section-title p { margin: 0; color: var(--vscode-descriptionForeground); font-size: .9em; }
    .actions { gap: .6rem; }
    .comment { margin: .85rem 0 0; padding: .9rem 1rem; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); }
    .comment[data-reply="true"] { margin-left: 1.5rem; }
    .comment header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .6rem; }
    .markdown { overflow-wrap: anywhere; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 1.25em 0 .5em; font-size: 1.05em; }
    .markdown p, .markdown ul, .markdown ol, .markdown blockquote { margin: .65em 0; }
    .markdown ul, .markdown ol { padding-left: 1.5rem; }
    .markdown blockquote { margin-left: 0; padding: .1rem .9rem; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-textBlockQuote-foreground); background: var(--vscode-textBlockQuote-background); }
    .markdown pre { overflow: auto; padding: .85rem; border-radius: 5px; background: var(--vscode-textCodeBlock-background); }
    .markdown code { font-family: var(--vscode-editor-font-family); }
    .markdown :not(pre) > code { padding: .1em .3em; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
    .markdown a { color: var(--vscode-textLink-foreground); }
    .markdown table { display: block; width: 100%; overflow: auto; border-collapse: collapse; }
    .markdown th, .markdown td { padding: .4rem .65rem; border: 1px solid var(--vscode-panel-border); text-align: left; }
    .markdown th { background: var(--vscode-editor-background); }
    .empty-state { color: var(--vscode-descriptionForeground); }
    textarea { box-sizing: border-box; width: 100%; min-height: 7rem; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; padding: .7rem; font: inherit; }
    textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: .5rem .85rem; font: inherit; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: .45rem .6rem; font: inherit; }
    label { color: var(--vscode-descriptionForeground); font-size: .9em; }
    .composer-actions { margin-top: .75rem; }
    @media (max-width: 560px) {
      body { padding: 1rem .85rem 2rem; }
      .section { padding: .9rem; }
      .comment[data-reply="true"] { margin-left: .5rem; }
    }
  </style>
</head>
<body>
  <header class="pr-header">
    <div class="pr-kicker"><span class="status">${escapeHtml(state)}</span><span>Pull request #${this.pullRequest.id}</span></div>
    <h1>${escapeHtml(this.pullRequest.title)}</h1>
    <p class="meta">${escapeHtml(this.pullRequest.author?.display_name ?? "Unknown author")} opened this pull request · ${escapeHtml(formatDate(this.pullRequest.created_on))}</p>
    <div class="branches" aria-label="Source and destination branches">
      <span class="branch">${escapeHtml(this.pullRequest.source.branch.name)}</span>
      <span class="branch-arrow" aria-hidden="true">→</span>
      <span class="branch">${escapeHtml(this.pullRequest.destination.branch.name)}</span>
    </div>
  </header>
  <section class="section">
    <div class="section-title"><h2>Review</h2><p>Choose an action for this pull request</p></div>
    <div class="actions">
      <button id="approve">Approve</button>
      <button id="request-changes" class="secondary">Request changes</button>
      <select id="merge-strategy" aria-label="Merge strategy">
        <option value="merge_commit">Merge commit</option>
        <option value="squash">Squash</option>
        <option value="fast_forward">Fast forward</option>
      </select>
      <label><input id="close-source-branch" type="checkbox"> Close source branch</label>
      <button id="merge" class="secondary">Merge…</button>
    </div>
  </section>
  <section class="section">
    <div class="section-title"><h2>Description</h2></div>
    <div class="markdown">${description || '<p class="empty-state">No description provided.</p>'}</div>
  </section>
  <section class="section">
    <div class="section-title"><h2>Comments</h2><p>${comments.length} ${comments.length === 1 ? "comment" : "comments"}</p></div>
    ${renderedComments || '<p class="empty-state">No comments yet. Start the conversation.</p>'}
  </section>
  <section class="section">
    <div class="section-title"><h2 id="composer-title">Add a comment</h2></div>
    <textarea id="comment-input" maxlength="10000" placeholder="Write a Markdown comment…"></textarea>
    <div class="composer-actions"><button id="send-comment">Comment</button><button id="cancel-reply" class="secondary" hidden>Cancel reply</button></div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById("comment-input");
    const title = document.getElementById("composer-title");
    const send = document.getElementById("send-comment");
    const cancelReply = document.getElementById("cancel-reply");
    let replyTo;
    document.querySelectorAll(".reply").forEach((button) => button.addEventListener("click", () => {
      replyTo = Number(button.dataset.parent);
      title.textContent = "Reply to comment #" + replyTo;
      send.textContent = "Reply";
      cancelReply.hidden = false;
      input.focus();
    }));
    cancelReply.addEventListener("click", () => {
      replyTo = undefined;
      title.textContent = "Add a comment";
      send.textContent = "Comment";
      cancelReply.hidden = true;
    });
    send.addEventListener("click", () => {
      vscode.postMessage({ command: replyTo === undefined ? "comment" : "reply", markdown: input.value, parentId: replyTo });
    });
    document.getElementById("approve").addEventListener("click", () => vscode.postMessage({ command: "approve" }));
    document.getElementById("request-changes").addEventListener("click", () => vscode.postMessage({ command: "requestChanges" }));
    document.getElementById("merge").addEventListener("click", () => {
      vscode.postMessage({
        command: "merge",
        strategy: document.getElementById("merge-strategy").value,
        closeSourceBranch: document.getElementById("close-source-branch").checked,
      });
    });
  </script>
</body>
</html>`;
  }
}

type WebviewMessage =
  | { command: "comment"; markdown: string }
  | { command: "reply"; markdown: string; parentId: number }
  | { command: "approve" }
  | { command: "requestChanges" }
  | { command: "merge"; strategy: MergeStrategy; closeSourceBranch: boolean };

function isWebviewMessage(message: unknown): message is WebviewMessage {
  if (!message || typeof message !== "object" || !("command" in message)) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.command === "approve" || candidate.command === "requestChanges") {
    return true;
  }
  if (candidate.command === "merge") {
    return (
      (candidate.strategy === "merge_commit" || candidate.strategy === "squash" || candidate.strategy === "fast_forward") &&
      typeof candidate.closeSourceBranch === "boolean"
    );
  }
  if (candidate.command === "comment") {
    return typeof candidate.markdown === "string";
  }
  if (candidate.command === "reply") {
    return (
      typeof candidate.markdown === "string" &&
      Number.isInteger(candidate.parentId) &&
      Number(candidate.parentId) > 0
    );
  }
  return false;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatDate(value?: string): string {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString();
}
