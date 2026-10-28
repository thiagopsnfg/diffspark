import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BitbucketClient } from "../bitbucket/client";
import { BitbucketRepository, MergeStrategy, PullRequest, PullRequestComment } from "../bitbucket/types";
import { JiraClient, JiraTransition } from "../jira/client";
import { extractJiraIssueKeys } from "../jira/issues";
import { renderMarkdown, sanitizeCommentHtml } from "./markdown";

interface MergeIssueOption {
  key: string;
  summary: string;
  issueType: string;
  transitions: JiraTransition[];
  error?: string;
}

export class PullRequestWebview {
  private disposed = false;
  private hasRequestedChanges = false;
  private readonly availableTransitions = new Map<string, Set<string>>();
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly pullRequest: PullRequest,
    private readonly repository: BitbucketRepository,
    private readonly client: BitbucketClient,
    private readonly onError: (error: unknown) => void,
    private readonly onMerged: () => void,
    private readonly getJiraClient: () => JiraClient | undefined,
    private readonly ensureJiraClient: () => Promise<boolean>,
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
    getJiraClient: () => JiraClient | undefined,
    ensureJiraClient: () => Promise<boolean>,
  ): Promise<PullRequestWebview> {
    const view = new PullRequestWebview(
      pullRequest,
      repository,
      client,
      onError,
      onMerged,
      getJiraClient,
      ensureJiraClient,
    );
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
      if (message && typeof message === "object" && "command" in message && message.command === "merge") {
        await this.panel.webview.postMessage({ command: "mergeFailed" });
      }
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
      if (message.command === "loadMergeOptions") {
        await this.loadMergeOptions();
        return;
      }
      if (message.command === "connectJira") {
        await this.ensureJiraClient();
        await this.loadMergeOptions();
        return;
      }
      if (message.command === "merge") {
        await this.merge(
          message.strategy,
          message.closeSourceBranch,
          message.commitMessage,
          message.transitions,
        );
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
      if (message.command === "merge") {
        await this.panel.webview.postMessage({ command: "mergeFailed" });
      } else if (message.command === "connectJira") {
        await this.loadMergeOptions();
      }
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
    this.hasRequestedChanges = true;
    await this.refresh();
    const comment = reason.trim();
    if (comment) {
      await this.client.createComment(this.repository, this.pullRequest.id, comment);
    }
    void vscode.window.showInformationMessage(`Changes requested on pull request #${this.pullRequest.id}.`);
    await this.refresh();
  }

  private async loadMergeOptions(): Promise<void> {
    const jira = this.getJiraClient();
    this.availableTransitions.clear();
    if (!jira) {
      await this.panel.webview.postMessage({
        command: "mergeOptions",
        jiraConfigured: false,
        issues: [],
      });
      return;
    }

    const keys = extractJiraIssueKeys(this.pullRequest);
    const issues = await Promise.all(keys.map(async (key): Promise<MergeIssueOption> => {
      const [issueResult, transitionsResult] = await Promise.allSettled([
        jira.getIssue(key),
        jira.getTransitions(key),
      ]);
      if (issueResult.status === "rejected") {
        return {
          key,
          summary: key,
          issueType: "",
          transitions: [],
          error: errorMessage(issueResult.reason),
        };
      }
      if (transitionsResult.status === "rejected") {
        return {
          ...issueResult.value,
          transitions: [],
          error: errorMessage(transitionsResult.reason),
        };
      }
      this.availableTransitions.set(
        key,
        new Set(transitionsResult.value.map((transition) => transition.id)),
      );
      return { ...issueResult.value, transitions: transitionsResult.value };
    }));

    if (!this.disposed) {
      await this.panel.webview.postMessage({
        command: "mergeOptions",
        jiraConfigured: true,
        issues,
      });
    }
  }

  private async merge(
    strategy: MergeStrategy,
    closeSourceBranch: boolean,
    commitMessage: string,
    transitions: { issueKey: string; transitionId: string }[],
  ): Promise<void> {
    if (!commitMessage.trim() || commitMessage.length > 10_000) {
      throw new Error("The commit message must contain 1–10,000 characters.");
    }
    if (new Set(transitions.map(({ issueKey }) => issueKey)).size !== transitions.length) {
      throw new Error("Select at most one transition per Jira issue.");
    }
    for (const transition of transitions) {
      if (!this.availableTransitions.get(transition.issueKey)?.has(transition.transitionId)) {
        throw new Error(`The selected Jira transition for ${transition.issueKey} is not available.`);
      }
    }

    const jira = this.getJiraClient();
    if (transitions.length > 0 && !jira) {
      throw new Error("Connect to Jira before applying issue transitions.");
    }

    await this.client.merge(
      this.repository,
      this.pullRequest.id,
      strategy,
      closeSourceBranch,
      commitMessage.trim(),
    );
    this.onMerged();
    const results = await Promise.allSettled(
      transitions.map(({ issueKey, transitionId }) => jira!.transition(issueKey, transitionId)),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${transitions[index].issueKey}: ${errorMessage(result.reason)}`]
        : [],
    );
    void vscode.window.showInformationMessage(`Pull request #${this.pullRequest.id} merged.`);
    if (failures.length > 0) {
      void vscode.window.showWarningMessage(
        `The pull request was merged, but these Jira transitions failed: ${failures.join(" · ")}`,
      );
    }
    await this.panel.webview.postMessage({ command: "mergeComplete" });
  }

  private render(comments: PullRequestComment[]): string {
    const nonce = randomBytes(16).toString("base64");
    const description = renderMarkdown(this.pullRequest.description ?? "");
    const state = this.pullRequest.draft
      ? "Draft"
      : this.pullRequest.state.charAt(0) + this.pullRequest.state.slice(1).toLowerCase();
    const statusClass = this.pullRequest.draft
      ? "status--draft"
      : `status--${this.pullRequest.state.toLowerCase()}`;
    const defaultCommitMessage =
      `Merged in ${this.pullRequest.source.branch.name} (pull request #${this.pullRequest.id})\n\n${this.pullRequest.title}`;
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
    .status--open, .status--merged { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); }
    .status--declined { color: var(--vscode-testing-iconFailed); border-color: var(--vscode-testing-iconFailed); background: color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, transparent); }
    .status--draft { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); }
    .status--superseded { color: var(--vscode-descriptionForeground); }
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
    select:focus, input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: .5rem .85rem; font: inherit; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.requested { color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-editorWarning-foreground); }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: .45rem .6rem; font: inherit; }
    label { color: var(--vscode-descriptionForeground); font-size: .9em; }
    dialog { box-sizing: border-box; width: min(540px, calc(100vw - 2rem)); max-height: min(90vh, 760px); padding: 1.25rem 1.4rem; overflow: auto; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; box-shadow: 0 12px 32px #0008; }
    dialog::backdrop { background: #0009; }
    .merge-title { margin: 0 0 1rem; font-size: 1.2rem; }
    .merge-field { margin: .65rem 0; }
    .merge-field > label, .merge-field > .field-label { display: block; margin-bottom: .35rem; color: var(--vscode-descriptionForeground); font-size: .9em; }
    .merge-branch { display: inline-block; max-width: 100%; padding: .2rem .5rem; border-radius: 4px; background: var(--vscode-editor-background); font-size: .9em; overflow-wrap: anywhere; }
    .merge-dialog textarea { min-height: 6.4rem; }
    .jira-issues { display: grid; gap: .55rem; }
    .jira-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(120px, auto); align-items: center; gap: .55rem; }
    .jira-issue { min-width: 0; display: flex; align-items: center; gap: .4rem; }
    .jira-type { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: .8em; }
    .jira-type--bug { color: var(--vscode-testing-iconFailed); }
    .jira-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .jira-key { flex: 0 0 auto; font-family: var(--vscode-editor-font-family); }
    .jira-arrow { color: var(--vscode-descriptionForeground); }
    .jira-error, .merge-hint { color: var(--vscode-descriptionForeground); font-size: .88em; }
    .jira-error { grid-column: 2 / -1; overflow-wrap: anywhere; }
    .transition--new { color: var(--vscode-descriptionForeground); border-color: var(--vscode-panel-border); }
    .transition--indeterminate { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }
    .transition--done { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
    .merge-footer { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1rem; }
    .merge-footer button:disabled { opacity: .6; cursor: wait; }
    .composer-actions { margin-top: .75rem; }
    @media (max-width: 560px) {
      body { padding: 1rem .85rem 2rem; }
      .section { padding: .9rem; }
      .comment[data-reply="true"] { margin-left: .5rem; }
      .jira-row { grid-template-columns: auto minmax(0, 1fr) auto; }
      .jira-row select { grid-column: 2 / -1; justify-self: start; max-width: 100%; }
    }
  </style>
</head>
<body>
  <header class="pr-header">
    <div class="pr-kicker"><span class="status ${statusClass}">${escapeHtml(state)}</span><span>Pull request #${this.pullRequest.id}</span></div>
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
      <button id="request-changes" class="secondary${this.hasRequestedChanges ? " requested" : ""}">Request changes</button>
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
  <dialog id="merge-dialog" class="merge-dialog">
    <h2 class="merge-title">Merge pull request</h2>
    <div class="merge-field"><span class="field-label">Source</span><span class="merge-branch">${escapeHtml(this.pullRequest.source.branch.name)}</span></div>
    <div class="merge-field"><span class="field-label">Destination</span><span class="merge-branch">${escapeHtml(this.pullRequest.destination.branch.name)}</span></div>
    <div class="merge-field">
      <label for="merge-strategy">Merge strategy</label>
      <select id="merge-strategy" aria-label="Merge strategy">
        <option value="merge_commit">Merge commit</option>
        <option value="squash">Squash</option>
        <option value="fast_forward">Fast forward</option>
      </select>
    </div>
    <div class="merge-field">
      <label for="merge-message">Commit message</label>
      <textarea id="merge-message">${escapeHtml(defaultCommitMessage)}</textarea>
    </div>
    <div class="merge-field">
      <span class="field-label">Transition work item</span>
      <div id="jira-status" class="merge-hint" aria-live="polite">Loading Jira issues…</div>
      <div id="jira-issues" class="jira-issues"></div>
      <button id="connect-jira" class="secondary" hidden>Connect Jira</button>
    </div>
    <div class="merge-field">
      <label><input id="close-source-branch" type="checkbox"> Close source branch</label>
    </div>
    <div class="merge-footer">
      <button id="cancel-merge" class="secondary" type="button">Cancel</button>
      <button id="confirm-merge" type="button">Merge</button>
    </div>
  </dialog>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById("comment-input");
    const title = document.getElementById("composer-title");
    const send = document.getElementById("send-comment");
    const cancelReply = document.getElementById("cancel-reply");
    const mergeDialog = document.getElementById("merge-dialog");
    const mergeButton = document.getElementById("confirm-merge");
    const jiraStatus = document.getElementById("jira-status");
    const jiraIssues = document.getElementById("jira-issues");
    const connectJira = document.getElementById("connect-jira");
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
      mergeDialog.showModal();
      mergeButton.disabled = true;
      jiraStatus.textContent = "Loading Jira issues…";
      jiraIssues.replaceChildren();
      connectJira.hidden = true;
      vscode.postMessage({ command: "loadMergeOptions" });
    });
    document.getElementById("cancel-merge").addEventListener("click", () => mergeDialog.close());
    mergeDialog.addEventListener("click", (event) => {
      if (event.target === mergeDialog) mergeDialog.close();
    });
    connectJira.addEventListener("click", () => {
      mergeButton.disabled = true;
      jiraStatus.textContent = "Connect to Jira in the prompt…";
      vscode.postMessage({ command: "connectJira" });
    });
    document.getElementById("confirm-merge").addEventListener("click", () => {
      const selectedTransitions = Array.from(jiraIssues.querySelectorAll(".jira-row"))
        .filter((row) => row.querySelector("input[type=checkbox]").checked)
        .map((row) => ({
          issueKey: row.dataset.issueKey,
          transitionId: row.querySelector("select").value,
        }));
      vscode.postMessage({
        command: "merge",
        strategy: document.getElementById("merge-strategy").value,
        closeSourceBranch: document.getElementById("close-source-branch").checked,
        commitMessage: document.getElementById("merge-message").value,
        transitions: selectedTransitions,
      });
      mergeButton.disabled = true;
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command === "mergeOptions") {
        mergeButton.disabled = false;
        connectJira.hidden = message.jiraConfigured;
        if (!message.jiraConfigured) {
          jiraStatus.textContent = "Connect Jira to load work items and available transitions.";
          connectJira.hidden = false;
          return;
        }
        if (message.issues.length === 0) {
          jiraStatus.textContent = "No Jira issue keys found in the PR title, description, or source branch.";
          return;
        }
        jiraStatus.textContent = "";
        message.issues.forEach((issue) => {
          const row = document.createElement("div");
          row.className = "jira-row";
          row.dataset.issueKey = issue.key;

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = issue.transitions.length > 0 && !issue.error;
          checkbox.disabled = issue.transitions.length === 0 || Boolean(issue.error);
          checkbox.setAttribute("aria-label", "Transition " + issue.key + " after merge");

          const details = document.createElement("div");
          details.className = "jira-issue";
          const type = document.createElement("span");
          type.className = "jira-type";
          type.textContent = issue.issueType.toLowerCase().includes("bug") ? "🐞" : "◇";
          if (issue.issueType.toLowerCase().includes("bug")) type.classList.add("jira-type--bug");
          type.title = issue.issueType;
          const key = document.createElement("strong");
          key.className = "jira-key";
          key.textContent = issue.key;
          const summary = document.createElement("span");
          summary.className = "jira-summary";
          summary.textContent = issue.summary;
          summary.title = issue.summary;
          details.append(type, key, summary);

          row.append(checkbox, details);
          if (issue.transitions.length > 0) {
            const select = document.createElement("select");
            select.setAttribute("aria-label", "Status after merge for " + issue.key);
            issue.transitions.forEach((transition) => {
              const option = document.createElement("option");
              option.value = transition.id;
              option.textContent = transition.to.name;
              option.dataset.category = transition.to.statusCategory?.key || "";
              select.append(option);
            });
            const colorSelect = () => {
              select.classList.remove("transition--new", "transition--indeterminate", "transition--done");
              const category = select.selectedOptions[0]?.dataset.category;
              if (category === "new" || category === "indeterminate" || category === "done") {
                select.classList.add("transition--" + category);
              }
            };
            select.addEventListener("change", colorSelect);
            colorSelect();
            const arrow = document.createElement("span");
            arrow.className = "jira-arrow";
            arrow.setAttribute("aria-hidden", "true");
            arrow.textContent = "→";
            row.append(arrow, select);
          }
          if (issue.error) {
            const error = document.createElement("span");
            error.className = "jira-error";
            error.textContent = issue.error;
            row.append(error);
          } else if (issue.transitions.length === 0) {
            const hint = document.createElement("span");
            hint.className = "jira-error";
            hint.textContent = "No available transitions.";
            row.append(hint);
          }
          jiraIssues.append(row);
        });
      }
      if (message.command === "mergeComplete") {
        mergeButton.disabled = false;
        mergeDialog.close();
      }
      if (message.command === "mergeFailed") {
        mergeButton.disabled = false;
      }
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
  | { command: "loadMergeOptions" }
  | { command: "connectJira" }
  | {
      command: "merge";
      strategy: MergeStrategy;
      closeSourceBranch: boolean;
      commitMessage: string;
      transitions: { issueKey: string; transitionId: string }[];
    };

function isWebviewMessage(message: unknown): message is WebviewMessage {
  if (!message || typeof message !== "object" || !("command" in message)) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  if (
    candidate.command === "approve" ||
    candidate.command === "requestChanges" ||
    candidate.command === "loadMergeOptions" ||
    candidate.command === "connectJira"
  ) {
    return true;
  }
  if (candidate.command === "merge") {
    return (
      (candidate.strategy === "merge_commit" || candidate.strategy === "squash" || candidate.strategy === "fast_forward") &&
      typeof candidate.closeSourceBranch === "boolean" &&
      typeof candidate.commitMessage === "string" &&
      Array.isArray(candidate.transitions) &&
      candidate.transitions.every((item) =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.issueKey === "string" &&
        /^[A-Z][A-Z0-9_]*-\d+$/.test(item.issueKey) &&
        typeof item.transitionId === "string" &&
        /^\d+$/.test(item.transitionId),
      )
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
