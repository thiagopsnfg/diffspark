import * as vscode from "vscode";
import { BitbucketClient } from "../bitbucket/client";
import { extractJiraIssueKeys } from "../jira/issues";
import { JiraClient, JiraTransition } from "../jira/client";
import { renderMarkdown, sanitizeCommentHtml } from "./markdown";
import { BitbucketRepository, MergeStrategy, PullRequest, PullRequestComment, ReviewState } from "../bitbucket/types";
import { CommentImprover } from "../ai/service";
import {
  describeImproveOptions,
  IMPROVE_ACTIONS,
  IMPROVE_TONES,
  ImproveOptions,
  isImproveAction,
  isImproveTone,
  TRANSLATE_LANGUAGES,
} from "../ai/prompt";

interface MergeIssueOption {
  key: string;
  summary: string;
  issueType: string;
  transitions: JiraTransition[];
  error?: string;
}

export class PullRequestWebview {
  private disposed = false;
  private reviewState: ReviewState = "none";
  private readonly availableTransitions = new Map<string, Set<string>>();
  private readonly panel: vscode.WebviewPanel;
  private comments: PullRequestComment[] = [];
  private improveCancellation: vscode.CancellationTokenSource | undefined;

  private constructor(
    private readonly pullRequest: PullRequest,
    private readonly repository: BitbucketRepository,
    private readonly client: BitbucketClient,
    private readonly onError: (error: unknown) => void,
    private readonly onMerged: () => void,
    private readonly getJiraClient: () => JiraClient | undefined,
    private readonly ensureJiraClient: () => Promise<boolean>,
    private readonly improver: CommentImprover,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "bitbucketPullRequest",
      `PR #${pullRequest.id}: ${pullRequest.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.improveCancellation?.cancel();
      this.improveCancellation?.dispose();
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
    improver: CommentImprover,
  ): Promise<PullRequestWebview> {
    const view = new PullRequestWebview(
      pullRequest,
      repository,
      client,
      onError,
      onMerged,
      getJiraClient,
      ensureJiraClient,
      improver,
    );
    await view.refresh();
    return view;
  }

  private async refresh(): Promise<void> {
    const [comments, reviewState] = await Promise.all([
      this.client.getComments(this.repository, this.pullRequest.id),
      this.client.getMyReviewState(this.repository, this.pullRequest.id),
    ]);
    this.reviewState = reviewState;
    this.comments = comments.filter((comment) => !comment.deleted);
    if (!this.disposed) {
      this.panel.webview.html = this.render(this.comments);
    }
  }

  private async improveComment(
    requestId: number,
    markdown: string,
    options: ImproveOptions,
    parentId: number | undefined,
  ): Promise<void> {
    this.improveCancellation?.cancel();
    this.improveCancellation?.dispose();
    const cancellation = new vscode.CancellationTokenSource();
    this.improveCancellation = cancellation;
    const parent = parentId === undefined ? undefined : this.comments.find((comment) => comment.id === parentId);
    const discussion = parent
      ? [parent, ...this.comments.filter((comment) => comment.parent?.id === parent.id)].map(
          (comment) => `${comment.user?.display_name ?? "Unknown"}: ${comment.content?.raw ?? ""}`,
        )
      : [];
    try {
      const suggestion = await this.improver.improve(
        {
          ...options,
          comment: markdown,
          pullRequestTitle: this.pullRequest.title,
          pullRequestDescription: this.pullRequest.description,
          discussion,
          filePath: parent?.inline?.path,
        },
        cancellation.token,
      );
      if (!this.disposed && this.improveCancellation === cancellation) {
        await this.panel.webview.postMessage({
          command: "improveResult",
          requestId,
          suggestion,
          label: describeImproveOptions(options),
          provider: this.improver.getProviderLabel(),
        });
      }
    } catch (error) {
      if (!this.disposed && this.improveCancellation === cancellation) {
        const cancelled = error instanceof vscode.CancellationError;
        await this.panel.webview.postMessage({
          command: "improveFailed",
          requestId,
          message: cancelled ? "" : errorMessage(error),
        });
      }
    } finally {
      if (this.improveCancellation === cancellation) {
        this.improveCancellation = undefined;
      }
      cancellation.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      this.onError(new Error("Received an invalid pull request view message."));
      if (message && typeof message === "object" && "command" in message && message.command === "merge") {
        await this.panel.webview.postMessage({ command: "mergeFailed" });
      }
      if (message && typeof message === "object" && "command" in message && message.command === "improveComment") {
        const requestId = (message as { requestId?: unknown }).requestId;
        await this.panel.webview.postMessage({
          command: "improveFailed",
          requestId,
          message: "The comment must contain 1–10,000 characters.",
        });
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
      if (message.command === "improveComment") {
        await this.improveComment(
          message.requestId,
          message.markdown,
          { action: message.action, tone: message.tone, targetLanguage: message.targetLanguage },
          message.parentId,
        );
        return;
      }
      if (message.command === "cancelImprove") {
        this.improveCancellation?.cancel();
        return;
      }
      if (message.command === "configureAi") {
        await this.improver.selectProvider();
        await this.panel.webview.postMessage({ command: "aiProvider", label: this.improver.getProviderLabel() });
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

      if (message.command === "deleteComment") {
        const comment = this.comments.find((entry) => entry.id === message.commentId && !entry.deleted);
        if (!comment) {
          throw new Error("This pull request comment is no longer available.");
        }
        const choice = await vscode.window.showWarningMessage(
          "Delete this comment from Bitbucket? This cannot be undone. Replies will be kept.",
          { modal: true },
          "Delete",
        );
        if (choice === "Delete") {
          await this.client.deleteComment(this.repository, this.pullRequest.id, comment.id);
          this.comments = this.comments.filter((entry) => entry.id !== comment.id);
          await this.panel.webview.postMessage({ command: "commentDeleted", commentId: comment.id });
        }
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
    const approved = this.reviewState === "approved";
    const action = approved ? "Unapprove" : "Approve";
    const choice = await vscode.window.showWarningMessage(
      `${action} pull request #${this.pullRequest.id}?`,
      { modal: true },
      action,
    );
    if (choice !== action) {
      return;
    }
    if (approved) {
      await this.client.unapprove(this.repository, this.pullRequest.id);
    } else {
      await this.client.approve(this.repository, this.pullRequest.id);
    }
    void vscode.window.showInformationMessage(
      `Pull request #${this.pullRequest.id} ${approved ? "unapproved" : "approved"}.`,
    );
    await this.refresh();
  }

  private async requestChanges(): Promise<void> {
    if (this.reviewState === "changes_requested") {
      await this.client.removeChangeRequest(this.repository, this.pullRequest.id);
      void vscode.window.showInformationMessage(`Change request removed from pull request #${this.pullRequest.id}.`);
      await this.refresh();
      return;
    }
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
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join("");
    const approved = this.reviewState === "approved";
    const changesRequested = this.reviewState === "changes_requested";
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
      const deleteControl =
        `<button class="secondary delete-comment" data-comment-id="${comment.id}" aria-label="Delete comment">Delete</button>`;
      return `<article class="comment" id="comment-${comment.id}"${parentId === undefined ? "" : ' data-reply="true"'}><header><strong>${escapeHtml(comment.user?.display_name ?? "Unknown user")}</strong><span>${escapeHtml(formatDate(comment.created_on))}</span></header><div class="markdown">${content}</div><div class="actions">${replyControl}${deleteControl}</div></article>`;
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
    button.approved { color: var(--vscode-testing-iconPassed, #73c991); border: 1px solid var(--vscode-testing-iconPassed, #73c991); }
    .review-icon { margin-right: .35rem; }
    .changes-icon { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 700; }
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
    .editor { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-input-background); }
    .editor:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .editor textarea { display: block; border: 0; border-radius: 0 0 6px 6px; background: transparent; }
    .editor textarea:focus { outline: none; }
    .editor-toolbar { position: relative; display: flex; align-items: center; gap: .15rem; padding: .3rem .4rem; border-bottom: 1px solid var(--vscode-panel-border); }
    .tool-button { display: inline-flex; align-items: center; gap: .35rem; padding: .3rem .45rem; color: var(--vscode-foreground); background: transparent; border-radius: 4px; font-size: .92em; }
    .tool-button:hover:not(:disabled), .tool-button[aria-expanded="true"] { background: var(--vscode-toolbar-hoverBackground, #8882); }
    .tool-button:disabled { opacity: .5; cursor: default; }
    .tool-button svg { flex: 0 0 auto; width: 16px; height: 16px; }
    .ai-toggle { gap: .15rem; padding-right: .3rem; }
    .ai-toggle svg:last-child { width: 12px; height: 12px; opacity: .8; }
    .ai-improve.is-loading svg { animation: wiggle 1s ease-in-out infinite; }
    @keyframes wiggle { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(-14deg); } }
    .ai-menu-anchor { position: relative; }
    .ai-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 250px; padding: .3rem; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border))); border-radius: 6px; box-shadow: 0 6px 20px var(--vscode-widget-shadow, #0006); }
    .ai-menu[hidden] { display: none; }
    .ai-submenu { top: -.35rem; left: calc(100% + 2px); min-width: 230px; }
    .ai-menu-item-wrap { position: relative; }
    .ai-menu-item { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .42rem .6rem; color: inherit; background: transparent; border-radius: 4px; text-align: left; font-size: .93em; }
    .ai-menu-item:hover, .ai-menu-item:focus-visible, .ai-menu-item[aria-expanded="true"] { color: var(--vscode-menu-selectionForeground, inherit); background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); outline: none; }
    .ai-menu-item svg { flex: 0 0 auto; width: 16px; height: 16px; opacity: .85; }
    .ai-menu-item > span { flex: 1 1 auto; }
    .ai-menu-item small { display: block; color: var(--vscode-descriptionForeground); font-size: .85em; }
    .ai-menu-item:hover small, .ai-menu-item:focus-visible small { color: inherit; opacity: .8; }
    .ai-menu-separator { height: 1px; margin: .3rem .2rem; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
    .ai-menu-footer { color: var(--vscode-descriptionForeground); font-size: .86em; }
    .ai-other { display: flex; gap: .3rem; padding: .3rem .3rem .2rem; }
    .ai-other input { flex: 1 1 auto; min-width: 0; padding: .3rem .45rem; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: .9em; }
    .ai-other button { padding: .3rem .55rem; }
    .ai-panel { margin-top: .75rem; padding: .8rem .9rem; border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, var(--vscode-editor-background)); }
    .ai-panel-header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .6rem; }
    .ai-panel-title { display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; }
    .ai-panel-title svg { width: 16px; height: 16px; color: var(--vscode-textLink-foreground); }
    .ai-panel-provider { color: var(--vscode-descriptionForeground); font-size: .85em; }
    .ai-suggestion { min-height: 8rem; }
    .ai-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: .65rem; }
    .ai-disclaimer { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: .8em; }
    .ai-error { color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
    .ai-loading[hidden], .ai-actions[hidden], .ai-error[hidden], .ai-suggestion[hidden] { display: none; }
    .shimmer { height: .7rem; margin: .45rem 0; border-radius: 4px; background: linear-gradient(90deg, var(--vscode-panel-border) 0%, color-mix(in srgb, var(--vscode-textLink-foreground) 35%, transparent) 50%, var(--vscode-panel-border) 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
    .shimmer--short { width: 60%; }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .ai-loading-footer { display: flex; align-items: center; justify-content: space-between; margin-top: .6rem; color: var(--vscode-descriptionForeground); font-size: .88em; }
    .link-button { padding: 0; color: var(--vscode-textLink-foreground); background: transparent; }
    .link-button:hover { background: transparent; text-decoration: underline; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { .shimmer, .ai-improve.is-loading svg { animation: none; } }
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
    <p class="meta"><h2>Author: ${escapeHtml(this.pullRequest.author?.display_name ?? "Unknown author")}</h2></p>
    <p class="meta">Created at: ${escapeHtml(formatDate(this.pullRequest.created_on))}</p>
    <div class="branches" aria-label="Source and destination branches">
      <span class="branch">${escapeHtml(this.pullRequest.source.branch.name)}</span>
      <span class="branch-arrow" aria-hidden="true">→</span>
      <span class="branch">${escapeHtml(this.pullRequest.destination.branch.name)}</span>
    </div>
  </header>
  <section class="section">
    <div class="section-title"><h2>Review</h2><p>Choose an action for this pull request</p></div>
    <div class="actions">
      <button id="approve" class="${approved ? "secondary approved" : ""}"><span class="review-icon" aria-hidden="true">✅</span>${approved ? "Unapprove" : "Approve"}</button>
      <button id="request-changes" class="secondary${changesRequested ? " requested" : ""}"><span class="review-icon changes-icon" aria-hidden="true">⊖</span>${changesRequested ? "Changes requested" : "Request changes"}</button>
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
    <div class="editor">
      <div class="editor-toolbar" role="toolbar" aria-label="Comment tools">
        <div class="ai-menu-anchor">
          <button id="ai-menu-toggle" type="button" class="tool-button ai-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="ai-menu" title="More AI actions">${AI_LOGO_SVG}${icon("chevronDown")}</button>
          ${renderAiMenu(this.improver.getProviderLabel())}
        </div>
        <button id="ai-improve" type="button" class="tool-button ai-improve" title="Improve comment with AI">${icon("wand")}<span id="ai-improve-label">Improve comment</span></button>
      </div>
      <textarea id="comment-input" maxlength="10000" placeholder="Write a Markdown comment…"></textarea>
    </div>
    <div id="ai-panel" class="ai-panel" hidden>
      <div class="ai-panel-header">
        <span class="ai-panel-title">${icon("wand")}<span id="ai-panel-label">Improve comment</span></span>
        <span id="ai-panel-provider" class="ai-panel-provider"></span>
      </div>
      <div id="ai-loading" class="ai-loading" role="status" aria-live="polite">
        <span class="visually-hidden">Improving your comment…</span>
        <div class="shimmer"></div><div class="shimmer"></div><div class="shimmer shimmer--short"></div>
        <div class="ai-loading-footer"><span>Improving your comment…</span><button id="ai-stop" type="button" class="link-button">Stop</button></div>
      </div>
      <div id="ai-error" class="ai-error" role="alert" hidden></div>
      <textarea id="ai-suggestion" class="ai-suggestion" aria-label="AI suggestion (editable)" hidden></textarea>
      <div id="ai-actions" class="ai-actions" hidden>
        <button id="ai-replace" type="button">Replace</button>
        <button id="ai-insert" type="button" class="secondary">Insert below</button>
        <button id="ai-retry" type="button" class="secondary">Try again</button>
        <button id="ai-discard" type="button" class="secondary">Discard</button>
        <span class="ai-disclaimer">AI-generated content may be inaccurate. Review before posting.</span>
      </div>
    </div>
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
    document.querySelectorAll(".delete-comment").forEach((button) => button.addEventListener("click", () => {
      vscode.postMessage({ command: "deleteComment", commentId: Number(button.dataset.commentId) });
    }));
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

    const improveButton = document.getElementById("ai-improve");
    const improveLabel = document.getElementById("ai-improve-label");
    const menuToggle = document.getElementById("ai-menu-toggle");
    const aiMenu = document.getElementById("ai-menu");
    const aiPanel = document.getElementById("ai-panel");
    const aiPanelLabel = document.getElementById("ai-panel-label");
    const aiPanelProvider = document.getElementById("ai-panel-provider");
    const aiLoading = document.getElementById("ai-loading");
    const aiError = document.getElementById("ai-error");
    const aiSuggestion = document.getElementById("ai-suggestion");
    const aiActions = document.getElementById("ai-actions");
    const aiReplace = document.getElementById("ai-replace");
    const aiInsert = document.getElementById("ai-insert");
    const otherLanguage = document.getElementById("ai-other-language");
    let improveRequestId = 0;
    let improving = false;
    let lastImprove;

    const updateImproveState = () => {
      improveButton.disabled = improving || !input.value.trim();
      menuToggle.disabled = improving;
      improveButton.classList.toggle("is-loading", improving);
      improveLabel.textContent = improving ? "Improving…" : "Improve comment";
    };
    const showPanel = (state, text) => {
      aiPanel.hidden = false;
      aiLoading.hidden = state !== "loading";
      aiError.hidden = state !== "error";
      aiSuggestion.hidden = state !== "result";
      aiActions.hidden = state === "loading";
      aiReplace.hidden = state !== "result";
      aiInsert.hidden = state !== "result";
      if (state === "error") aiError.textContent = text;
      if (state === "result") aiSuggestion.value = text;
    };
    const hidePanel = () => {
      aiPanel.hidden = true;
      aiSuggestion.value = "";
    };
    const requestImprove = (options, markdown) => {
      const text = markdown ?? input.value;
      closeMenus();
      if (!text.trim()) {
        input.focus();
        return;
      }
      lastImprove = { options, markdown: text };
      improving = true;
      updateImproveState();
      aiPanelLabel.textContent = options.label;
      aiPanelProvider.textContent = "";
      showPanel("loading");
      vscode.postMessage({
        command: "improveComment",
        requestId: ++improveRequestId,
        markdown: text.slice(0, 10000),
        action: options.action,
        tone: options.tone,
        targetLanguage: options.targetLanguage,
        parentId: replyTo,
      });
    };
    const finishImprove = () => {
      improving = false;
      updateImproveState();
    };

    const menus = () => [aiMenu, ...aiMenu.querySelectorAll(".ai-submenu")];
    const visibleItems = (menu) => Array.from(menu.children).flatMap((child) =>
      child.classList.contains("ai-menu-item-wrap") ? [child.querySelector(":scope > .ai-menu-item")] :
      child.classList.contains("ai-menu-item") ? [child] :
      child.classList.contains("ai-other") ? [child.querySelector("input")] : []);
    const closeSubmenus = (except) => {
      aiMenu.querySelectorAll(".ai-submenu").forEach((submenu) => {
        if (submenu === except) return;
        submenu.hidden = true;
        submenu.previousElementSibling.setAttribute("aria-expanded", "false");
      });
    };
    function closeMenus(focusToggle) {
      closeSubmenus();
      aiMenu.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
      if (focusToggle) menuToggle.focus();
    }
    const openMenu = () => {
      aiMenu.hidden = false;
      menuToggle.setAttribute("aria-expanded", "true");
      visibleItems(aiMenu)[0]?.focus();
    };
    const openSubmenu = (toggle, focusFirst) => {
      const submenu = toggle.nextElementSibling;
      closeSubmenus(submenu);
      submenu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      if (focusFirst) visibleItems(submenu)[0]?.focus();
    };
    const optionsFromItem = (item) => ({
      action: item.dataset.action,
      tone: item.dataset.tone || undefined,
      targetLanguage: item.dataset.language || undefined,
      label: item.dataset.label,
    });
    const translateOther = () => {
      const language = otherLanguage.value.trim();
      if (!language) {
        otherLanguage.focus();
        return;
      }
      requestImprove({ action: "translate", targetLanguage: language.slice(0, 60), label: "Translate to " + language.slice(0, 60) });
    };

    improveButton.addEventListener("click", () => requestImprove({ action: "improve", label: "Improve comment" }));
    menuToggle.addEventListener("click", () => (aiMenu.hidden ? openMenu() : closeMenus()));
    menuToggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openMenu();
      }
    });
    aiMenu.addEventListener("click", (event) => {
      if (event.target.closest("#ai-other-submit")) {
        translateOther();
        return;
      }
      const item = event.target.closest(".ai-menu-item");
      if (!item) return;
      if (item.hasAttribute("data-submenu-toggle")) {
        item.getAttribute("aria-expanded") === "true" ? closeSubmenus() : openSubmenu(item, false);
        return;
      }
      if (item.hasAttribute("data-configure")) {
        closeMenus();
        vscode.postMessage({ command: "configureAi" });
        return;
      }
      if (item.dataset.action) requestImprove(optionsFromItem(item));
    });
    aiMenu.querySelectorAll("[data-submenu-toggle]").forEach((toggle) => {
      toggle.parentElement.addEventListener("mouseenter", () => openSubmenu(toggle, false));
      toggle.parentElement.addEventListener("mouseleave", () => {
        if (!toggle.nextElementSibling.contains(document.activeElement)) {
          toggle.nextElementSibling.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    });
    aiMenu.addEventListener("keydown", (event) => {
      const current = document.activeElement;
      const menu = menus().filter((item) => !item.hidden && item.contains(current)).pop();
      if (!menu) return;
      const items = visibleItems(menu);
      const index = items.indexOf(current);
      if (current === otherLanguage && event.key === "Enter") {
        event.preventDefault();
        translateOther();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? index + 1 : index - 1;
        items[(next + items.length) % items.length]?.focus();
      } else if (event.key === "ArrowRight" && current.hasAttribute("data-submenu-toggle")) {
        event.preventDefault();
        openSubmenu(current, true);
      } else if ((event.key === "ArrowLeft" || event.key === "Escape") && menu !== aiMenu) {
        event.preventDefault();
        const toggle = menu.previousElementSibling;
        closeSubmenus();
        toggle.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenus(true);
      } else if (event.key === "Tab") {
        closeMenus();
      }
    });
    document.addEventListener("click", (event) => {
      if (!aiMenu.hidden && !aiMenu.contains(event.target) && !menuToggle.contains(event.target)) closeMenus();
    });
    input.addEventListener("input", updateImproveState);
    document.getElementById("ai-stop").addEventListener("click", () => {
      improveRequestId++;
      vscode.postMessage({ command: "cancelImprove" });
      finishImprove();
      hidePanel();
      input.focus();
    });
    aiReplace.addEventListener("click", () => {
      input.value = aiSuggestion.value.slice(0, 10000);
      hidePanel();
      updateImproveState();
      input.focus();
    });
    aiInsert.addEventListener("click", () => {
      input.value = (input.value.trimEnd() + "\\n\\n" + aiSuggestion.value.trim()).slice(0, 10000);
      hidePanel();
      updateImproveState();
      input.focus();
    });
    document.getElementById("ai-retry").addEventListener("click", () => {
      if (lastImprove) requestImprove(lastImprove.options, lastImprove.markdown);
    });
    document.getElementById("ai-discard").addEventListener("click", () => {
      hidePanel();
      input.focus();
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command === "commentDeleted") {
        document.getElementById("comment-" + message.commentId)?.remove();
        if (replyTo === message.commentId) {
          cancelReply.click();
        }
        return;
      }
      if (message.command === "aiProvider") {
        document.getElementById("ai-provider-name").textContent = message.label;
        return;
      }
      if ((message.command !== "improveResult" && message.command !== "improveFailed") || message.requestId !== improveRequestId) {
        return;
      }
      finishImprove();
      if (message.command === "improveResult") {
        aiPanelLabel.textContent = "AI suggestion · " + message.label;
        aiPanelProvider.textContent = "by " + message.provider;
        showPanel("result", message.suggestion);
        aiSuggestion.focus();
      } else if (message.message) {
        showPanel("error", message.message);
      } else {
        hidePanel();
      }
    });
    updateImproveState();
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
  | { command: "deleteComment"; commentId: number }
  | { command: "comment"; markdown: string }
  | { command: "reply"; markdown: string; parentId: number }
  | { command: "approve" }
  | { command: "requestChanges" }
  | { command: "loadMergeOptions" }
  | { command: "connectJira" }
  | {
      command: "improveComment";
      requestId: number;
      markdown: string;
      action: ImproveOptions["action"];
      tone?: ImproveOptions["tone"];
      targetLanguage?: string;
      parentId?: number;
    }
  | { command: "cancelImprove" }
  | { command: "configureAi" }
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
  if (candidate.command === "deleteComment") {
    return Number.isSafeInteger(candidate.commentId) && Number(candidate.commentId) > 0;
  }
  if (
    candidate.command === "approve" ||
    candidate.command === "requestChanges" ||
    candidate.command === "loadMergeOptions" ||
    candidate.command === "connectJira" ||
    candidate.command === "cancelImprove" ||
    candidate.command === "configureAi"
  ) {
    return true;
  }
  if (candidate.command === "improveComment") {
    return (
      Number.isInteger(candidate.requestId) &&
      typeof candidate.markdown === "string" &&
      candidate.markdown.trim().length > 0 &&
      candidate.markdown.length <= 10_000 &&
      isImproveAction(candidate.action) &&
      (candidate.tone === undefined || isImproveTone(candidate.tone)) &&
      (candidate.targetLanguage === undefined ||
        (typeof candidate.targetLanguage === "string" && candidate.targetLanguage.length <= 60)) &&
      (candidate.parentId === undefined || (Number.isInteger(candidate.parentId) && Number(candidate.parentId) > 0))
    );
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

const ICON_PATHS: Record<string, string> = {
  wand: '<path d="M2.5 13.5 10 6"/><path d="m9 5 2 2"/><path d="M12.5 1.5v3M11 3h3"/><path d="M5 1.5v2M4 2.5h2"/><path d="M13 9v2M12 10h2"/>',
  chevronDown: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  chevronRight: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  "list-flat": '<path d="M6 4h8M6 8h8M6 12h8"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke-width="2"/>',
  "whole-word": '<path d="m1.5 13 3.25-9L8 13M2.6 10h4.3"/><path d="m9.5 10.5 2 2 3.5-4.5"/>',
  sync: '<path d="M1.5 4.5h3l6 7h4M1.5 11.5h3l1.8-2.1M9.7 6.6l1.8-2.1h3"/><path d="m12.5 2.5 2 2-2 2M12.5 9.5l2 2-2 2"/>',
  comment: '<path d="M2 2.5h12v8.5H7l-3.5 3v-3H2z"/>',
  "fold-up": '<path d="M2 5h12M2 8.5h8"/><path d="m11.5 12.5 1.5-1.5 1.5 1.5"/>',
  "fold-down": '<path d="M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h7"/>',
  code: '<path d="M5 4 1.5 8 5 12M11 4l3.5 4-3.5 4"/>',
  globe: '<path d="M1.5 3h7M5 1.5V3M3 3c.5 2.6 2.4 4.6 4.8 5.6M7 3c-.6 2.6-2.5 4.6-5 5.6"/><path d="m8.5 14.5 3-7.5 3 7.5M9.5 12h4"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;
}

const AI_LOGO_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="ai-logo-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs><path fill="url(#ai-logo-gradient)" d="M8 .8c.5 3.6 2.1 5.4 6.2 6.2v2c-4.1.8-5.7 2.6-6.2 6.2h-.1C7.4 11.6 5.8 9.8 1.8 9V7c4-.8 5.6-2.6 6.1-6.2z"/></svg>`;

function renderAiMenu(providerLabel: string): string {
  const item = (attributes: string, label: string, iconName?: string, description?: string): string =>
    `<button type="button" class="ai-menu-item" role="menuitem" ${attributes}${description ? ` title="${escapeHtml(description)}"` : ""}>${iconName ? icon(iconName) : ""}<span>${escapeHtml(label)}</span></button>`;
  const entries = IMPROVE_ACTIONS.map((action) => {
    if (action.submenu === "tone") {
      const tones = IMPROVE_TONES.map((tone) =>
        `<button type="button" class="ai-menu-item" role="menuitem" data-action="tone" data-tone="${tone.id}" data-label="${escapeHtml(describeImproveOptions({ action: "tone", tone: tone.id }))}"><span>${escapeHtml(tone.label)}<small>${escapeHtml(tone.description)}</small></span></button>`,
      ).join("");
      return `<div class="ai-menu-item-wrap"><button type="button" class="ai-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-submenu-toggle>${icon(action.icon)}<span>${escapeHtml(action.label)}</span>${icon("chevronRight")}</button><div class="ai-menu ai-submenu" role="menu" aria-label="${escapeHtml(action.label)}" hidden>${tones}</div></div>`;
    }
    if (action.submenu === "translate") {
      const languages = TRANSLATE_LANGUAGES.map((language) =>
        item(
          `data-action="translate" data-language="${escapeHtml(language)}" data-label="${escapeHtml(describeImproveOptions({ action: "translate", targetLanguage: language }))}"`,
          language,
        ),
      ).join("");
      const other = `<div class="ai-other"><input id="ai-other-language" type="text" maxlength="60" placeholder="Other language…" aria-label="Other language"><button type="button" id="ai-other-submit" class="secondary" aria-label="Translate to the typed language">→</button></div>`;
      return `<div class="ai-menu-item-wrap"><button type="button" class="ai-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-submenu-toggle>${icon(action.icon)}<span>${escapeHtml(action.label)}</span>${icon("chevronRight")}</button><div class="ai-menu ai-submenu" role="menu" aria-label="${escapeHtml(action.label)}" hidden>${languages}${other}</div></div>`;
    }
    return item(
      `data-action="${action.id}" data-label="${escapeHtml(describeImproveOptions({ action: action.id }))}"`,
      action.label,
      action.icon,
      action.description,
    );
  }).join("");
  const footer = `<button type="button" class="ai-menu-item ai-menu-footer" role="menuitem" data-configure>${icon("gear")}<span>AI provider: <span id="ai-provider-name">${escapeHtml(providerLabel)}</span> · Change…</span></button>`;
  return `<div id="ai-menu" class="ai-menu" role="menu" aria-label="AI actions" hidden>${entries}<div class="ai-menu-separator" role="separator"></div>${footer}</div>`;
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
