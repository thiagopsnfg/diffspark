const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../dist");
const repository = { workspace: "team", slug: "repo", fullName: "team/repo" };
const comments = [
  { id: 10, content: { raw: "My comment" }, inline: { path: "app.js", to: 1 }, user: { display_name: "Ana" } },
  { id: 11, parent: { id: 10 }, content: { raw: "A reply" } },
  { id: 12, deleted: true, content: { raw: "Must not appear" }, inline: { path: "app.js", to: 2 } },
];

function load(filename, overrides, cache = new Map()) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = new Module(filename);
  cache.set(filename, module);
  const requireFromFile = Module.createRequire(filename);
  module.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    const resolved = requireFromFile.resolve(id);
    return resolved.startsWith(root + path.sep) ? load(resolved, overrides, cache) : requireFromFile(id);
  };
  module._compile(fs.readFileSync(filename, "utf8"), filename);
  return module.exports;
}

function harness() {
  const commands = new Map();
  const threads = [];
  const errors = [];
  const deletions = [];
  const messages = [];
  const state = { choice: "Delete", failure: undefined, confirmations: 0 };
  const disposable = { dispose() {} };
  const uri = (value) => ({ fsPath: value, toString: () => value });
  const panel = {
    onDidDispose() {},
    webview: { html: "", onDidReceiveMessage() {}, postMessage: async (message) => messages.push(message) },
  };
  const api = {
    getComments: async () => comments.map((comment) => ({ ...comment })),
    getMyReviewState: async () => "none",
    getFileComparison: async () => ({ before: "old", after: "new" }),
    createComment: async () => ({ id: 20, content: { raw: "New comment" } }),
    deleteComment: async (...args) => {
      deletions.push(args);
      if (state.failure) throw state.failure;
    },
  };
  const vscode = {
    CommentMode: { Preview: 0 },
    ViewColumn: { Active: 1 },
    MarkdownString: class { constructor(value) { this.value = value; } },
    Range: class { constructor(line) { this.start = { line }; } },
    Uri: { from: ({ scheme, path }) => uri(scheme + ":" + path), joinPath: () => uri("/extension/icon") },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async () => {},
    },
    comments: {
      createCommentController: () => ({
        ...disposable,
        createCommentThread: (uri, range, comments) => {
          const thread = { uri, range, comments, ...disposable };
          threads.push(thread);
          return thread;
        },
      }),
    },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      createTreeView: () => ({ ...disposable }),
      createWebviewPanel: () => panel,
      showErrorMessage: (error) => errors.push(error),
      showWarningMessage: async () => { state.confirmations++; return state.choice; },
    },
    workspace: {
      registerTextDocumentContentProvider: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
    },
    extensions: {
      getExtension: () => ({
        isActive: true,
        exports: { getAPI: () => ({ repositories: [{
          rootUri: uri("/repo"),
          state: { remotes: [{ name: "origin", fetchUrl: "git@bitbucket.org:team/repo.git" }] },
        }] }) },
      }),
    },
  };
  const overrides = {
    vscode,
    "./bitbucket/client": { BitbucketClient: class { constructor() { return api; } } },
    "./views/pullRequestTreeProvider": { PullRequestTreeProvider: class { refresh() {} } },
    "./ai/service": { CommentImprover: class {} },
  };
  return {
    api, commands, threads, errors, deletions, messages, state, panel, overrides,
    async openDiff() {
      const { activate } = load(path.join(root, "extension.js"), overrides);
      await activate({
        subscriptions: [], extensionUri: uri("/extension"),
        secrets: { get: async (key) => key.endsWith(".email") ? "dev@example.com" : key.endsWith(".api-token") ? "token" : undefined },
      });
      await commands.get("bitbucketPrReviewer.refresh")();
      await commands.get("bitbucketPrReviewer.openChangedFile")(repository, 42, { path: "app.js" }, "feature");
      assert.deepEqual(errors, []);
      assert.equal(threads.length, 2);
    },
    async openWebview() {
      const { PullRequestWebview } = load(path.join(root, "views/pullRequestWebview.js"), overrides);
      return PullRequestWebview.open({
        id: 42, title: "Test", state: "OPEN",
        source: { branch: { name: "feature" } }, destination: { branch: { name: "main" } },
      }, repository, api, (error) => errors.push(error), () => {}, () => undefined,
      async () => false, { getProviderLabel: () => "Test" });
    },
  };
}

test("native diff deletes published comments and replies, preserving the thread and drafts", async () => {
  const h = harness();
  await h.openDiff();
  const thread = h.threads[0];
  const rootComment = thread.comments[0];
  const reply = thread.comments[1];
  const draft = { body: "Unsent draft", ai: { kind: "draft" } };
  thread.comments = [...thread.comments, draft];
  assert.equal(rootComment.contextValue, "diffsparkPostedComment");
  assert.equal(h.threads[1].comments[0].contextValue, undefined);
  assert.match(h.threads[1].comments[0].body.value, /Comment deleted/);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(rootComment);
  assert.deepEqual(h.deletions, [[repository, 42, 10]]);
  assert.match(thread.comments[0].body.value, /Comment deleted/);
  assert.equal(thread.comments[0].contextValue, undefined);
  assert.equal(thread.comments[1], reply);
  assert.equal(thread.comments[2], draft);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(reply);
  assert.deepEqual(h.deletions[1], [repository, 42, 11]);
  assert.equal(thread.comments[2], draft);
  assert.deepEqual(h.errors, []);
});

test("native diff cancellation and API errors do not remove comments", async () => {
  const h = harness();
  await h.openDiff();
  const comment = h.threads[0].comments[0];
  h.state.choice = undefined;
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(comment);
  assert.equal(h.deletions.length, 0);
  h.state.choice = "Delete";
  h.state.failure = new Error("Permission denied");
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(comment);
  assert.equal(h.threads[0].comments[0], comment);
  assert.match(h.errors[0], /Permission denied/);
});

test("new native comments immediately expose the delete action", async () => {
  const h = harness();
  await h.openDiff();
  await h.commands.get("bitbucketPrReviewer.replyDiffComment")({ thread: h.threads[0], text: "New comment" });
  const comment = h.threads[0].comments.at(-1);
  assert.equal(comment.contextValue, "diffsparkPostedComment");
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(comment);
  assert.deepEqual(h.deletions, [[repository, 42, 20]]);
});

test("webview exposes deletion, validates messages, and updates without reloading the composer", async () => {
  const h = harness();
  const view = await h.openWebview();
  const html = h.panel.webview.html;
  assert.match(html, /data-comment-id="10"/);
  assert.match(html, /data-comment-id="11"/);
  assert.doesNotMatch(html, /data-comment-id="12"|Must not appear/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  for (const id of [0, -1, "10", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await view.handleMessage({ command: "deleteComment", commentId: id });
  }
  assert.equal(h.errors.length, 5);
  assert.equal(h.state.confirmations, 0);
  await view.handleMessage({ command: "deleteComment", commentId: 999 });
  assert.equal(h.state.confirmations, 0);
  await view.handleMessage({ command: "deleteComment", commentId: 10 });
  assert.deepEqual(h.deletions, [[repository, 42, 10]]);
  assert.deepEqual(h.messages, [{ command: "commentDeleted", commentId: 10 }]);
  assert.equal(h.panel.webview.html, html);
  assert.equal(view.comments.find((comment) => comment.id === 10).deleted, true);
  assert.equal(view.comments.find((comment) => comment.id === 11).content.raw, "A reply");
  await view.handleMessage({ command: "deleteComment", commentId: 10 });
  assert.equal(h.deletions.length, 1);
});

test("webview cancellation and permission errors retain the published comment", async () => {
  const h = harness();
  const view = await h.openWebview();
  h.state.choice = undefined;
  await view.handleMessage({ command: "deleteComment", commentId: 11 });
  assert.equal(h.deletions.length, 0);
  h.state.choice = "Delete";
  h.state.failure = new Error("Permission denied");
  await view.handleMessage({ command: "deleteComment", commentId: 11 });
  assert.equal(h.errors[0].message, "Permission denied");
  assert.equal(h.messages.length, 0);
  assert.equal(view.comments.find((comment) => comment.id === 11).deleted, undefined);
});

test("manifest wires the native delete action only to published DiffSpark comments", () => {
  const { contributes } = require("../package.json");
  const id = "bitbucketPrReviewer.deleteDiffComment";
  assert.equal(contributes.commands.find((command) => command.command === id).icon, "$(trash)");
  assert.deepEqual(contributes.menus["commandPalette"].find((command) => command.command === id), { command: id, when: "false" });
  assert.match(contributes.menus["comments/comment/context"].find((command) => command.command === id).when,
    /commentController == diffspark && comment == diffsparkPostedComment/);
});
