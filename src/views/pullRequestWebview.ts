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
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 0 1rem 2rem; }
    header, .actions, .composer-actions { display: flex; align-items: center; gap: .75rem; }
    .meta, .comment header span { color: var(--vscode-descriptionForeground); font-size: .9em; }
    .section { border-top: 1px solid var(--vscode-panel-border); margin-top: 1.5rem; padding-top: .5rem; }
    .comment { border-left: 2px solid var(--vscode-panel-border); margin: 1rem 0; padding: .5rem 1rem; }
    .comment[data-reply="true"] { margin-left: 2rem; }
    .comment header { justify-content: space-between; }
    .markdown { overflow-wrap: anywhere; }
    .markdown pre { overflow: auto; padding: .75rem; background: var(--vscode-textCodeBlock-background); }
    .markdown code { font-family: var(--vscode-editor-font-family); }
    .markdown a { color: var(--vscode-textLink-foreground); }
    textarea { box-sizing: border-box; width: 100%; min-height: 7rem; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: .5rem; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: .45rem .8rem; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); padding: .4rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(this.pullRequest.title)}</h1>
  <p class="meta">#${this.pullRequest.id} · ${escapeHtml(this.pullRequest.state)}${this.pullRequest.draft ? " · Draft" : ""} · ${escapeHtml(this.pullRequest.author?.display_name ?? "Unknown author")}</p>
  <p class="meta">${escapeHtml(this.pullRequest.source.branch.name)} → ${escapeHtml(this.pullRequest.destination.branch.name)}</p>
  <section class="section"><h2>Description</h2><div class="markdown">${description}</div></section>
  <section class="section">
    <h2>Review</h2>
    <div class="actions">
      <button id="approve">Approve</button>
      <select id="merge-strategy" aria-label="Merge strategy">
        <option value="merge_commit">Merge commit</option>
        <option value="squash">Squash</option>
        <option value="fast_forward">Fast forward</option>
      </select>
      <label><input id="close-source-branch" type="checkbox"> Close source branch</label>
      <button id="merge">Merge…</button>
    </div>
  </section>
  <section class="section"><h2>Comments</h2>${renderedComments || "<p>No comments yet.</p>"}</section>
  <section class="section">
    <h2 id="composer-title">Add a comment</h2>
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
  | { command: "merge"; strategy: MergeStrategy; closeSourceBranch: boolean };

function isWebviewMessage(message: unknown): message is WebviewMessage {
  if (!message || typeof message !== "object" || !("command" in message)) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.command === "approve") {
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
