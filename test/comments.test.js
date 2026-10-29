const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../dist");
const repository = { workspace: "team", slug: "repo", fullName: "team/repo" };
const comments = [
  { id: 10, content: { raw: "My comment" }, inline: { path: "app.js", to: 1 }, user: { display_name: "Ana", account_id: "me" } },
  { id: 11, parent: { id: 10 }, content: { raw: "A reply" }, user: { display_name: "Ana", account_id: "me" } },
  { id: 12, deleted: true, content: { raw: "Must not appear" }, inline: { path: "app.js", to: 2 }, user: { account_id: "me" } },
  { id: 13, parent: { id: 10 }, content: { raw: "Another person's reply" }, user: { display_name: "Ana", account_id: "other" } },
  { id: 14, deleted: true, content: { raw: "Deleted root" }, inline: { path: "app.js", to: 3 }, user: { account_id: "me" } },
  { id: 15, parent: { id: 14 }, content: { raw: "Reply to deleted root" }, user: { account_id: "other" } },
  { id: 16, parent: { id: 11 }, content: { raw: "Nested reply" }, user: { account_id: "other" } },
  { id: 17, deleted: true, parent: { id: 10 }, content: { raw: "Deleted reply" }, user: { account_id: "me" } },
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
  const warnings = [];
  const state = { choice: "Delete", failure: undefined, confirmations: 0, accountId: "me" };
  const authorFilter = { authors: [], current: undefined, items: [], selected: undefined };
  const fileLayout = { value: "tree", applied: undefined, updates: [], failure: undefined };
  let configurationListener;
  const disposable = { dispose() {} };
  const uri = (value) => ({ fsPath: value, toString: () => value });
  const panel = {
    onDidDispose() {},
    webview: { html: "", onDidReceiveMessage() {}, postMessage: async (message) => messages.push(message) },
  };
  const api = {
    getComments: async () => comments.map((comment) => ({ ...comment })),
    getMyReviewState: async () => "none",
    getCurrentAccountId: async () => state.accountId,
    getFileComparison: async () => ({ before: "old", after: "new" }),
    createComment: async () => ({ id: 20, content: { raw: "New comment" } }),
    deleteComment: async (...args) => {
      deletions.push(args);
      if (state.failure) throw state.failure;
    },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    CommentMode: { Preview: 0 },
    EventEmitter: class {
      constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return disposable; }; }
      fire(value) { this.listeners.forEach((listener) => listener(value)); }
      dispose() {}
    },
    ViewColumn: { Active: 1 },
    MarkdownString: class { constructor(value) { this.value = value; } },
    Range: class { constructor(line) { this.start = { line }; } },
    Uri: { from: ({ scheme, path }) => uri(scheme + ":" + path), joinPath: () => uri("/extension/icon"), parse: uri },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async () => {},
    },
    comments: {
      createCommentController: () => ({
        ...disposable,
        createCommentThread: (uri, range, comments) => {
          const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
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
      showQuickPick: async (items) => {
        authorFilter.items = items;
        return authorFilter.selected === undefined ? undefined : items[authorFilter.selected];
      },
      showWarningMessage: async (message, options) => {
        if (!options?.modal) {
          warnings.push(message);
          return undefined;
        }
        state.confirmations++;
        return state.choice;
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: () => fileLayout.value,
        update: async (key, value, target) => {
          if (fileLayout.failure) throw fileLayout.failure;
          fileLayout.updates.push({ key, value, target });
          fileLayout.value = value;
          configurationListener({ affectsConfiguration: (key) => key === "diffspark.files.layout" });
        },
      }),
      onDidChangeConfiguration: (listener) => { configurationListener = listener; return disposable; },
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
    "./views/pullRequestTreeProvider": { PullRequestTreeProvider: class {
      refresh() {}
      getAuthors() { return authorFilter.authors; }
      getAuthor() { return authorFilter.current; }
      setAuthor(author) { authorFilter.current = author; }
      setFileLayout(layout) { fileLayout.applied = layout; }
    } },
    "./ai/service": { CommentImprover: class {} },
  };
  return {
    api, commands, threads, errors, deletions, messages, warnings, state, panel, overrides, authorFilter, fileLayout,
    async openDiff() {
      const { activate } = load(path.join(root, "extension.js"), overrides);
      await activate({
        subscriptions: [], extensionUri: uri("/extension"),
        secrets: { get: async (key) => key.endsWith(".email") ? "dev@example.com" : key.endsWith(".api-token") ? "token" : undefined },
      });
      await commands.get("bitbucketPrReviewer.refresh")();
      await commands.get("bitbucketPrReviewer.openChangedFile")(repository, 42, { path: "app.js" }, "feature");
      assert.deepEqual(errors, []);
      assert.equal(threads.length, 3);
    },
    async openWebview(aiReview) {
      const { PullRequestWebview } = load(path.join(root, "views/pullRequestWebview.js"), overrides);
      return PullRequestWebview.open({
        id: 42, title: "Test", state: "OPEN",
        source: { branch: { name: "feature" }, commit: { hash: "abc123" } }, destination: { branch: { name: "main" } },
      }, repository, api, (error) => errors.push(error), () => {}, () => undefined,
      async () => false, { getProviderLabel: () => "Test" }, aiReview);
    },
  };
}

test("file layout picker saves the choice, applies configuration changes, and handles cancellation and errors", async () => {
  const h = harness();
  h.fileLayout.value = "list";
  await h.openDiff();
  assert.equal(h.fileLayout.applied, "list");
  const selectLayout = h.commands.get("bitbucketPrReviewer.selectFileLayout");
  await selectLayout();
  assert.equal(h.authorFilter.items[1].description, "(current)");
  assert.deepEqual(h.fileLayout.updates, []);
  h.authorFilter.selected = 0;
  await selectLayout();
  assert.deepEqual(h.fileLayout.updates, [{ key: "files.layout", value: "tree", target: 1 }]);
  assert.equal(h.fileLayout.applied, "tree");
  h.authorFilter.selected = 1;
  await selectLayout();
  assert.equal(h.fileLayout.applied, "list");
  h.fileLayout.failure = new Error("Cannot save settings");
  h.authorFilter.selected = 0;
  await selectLayout();
  assert.equal(h.fileLayout.applied, "list");
  assert.match(h.errors[0], /Cannot save settings/);
});

test("changed files switch between the default folder tree and a flat list without changing file actions", async () => {
  let refreshes = 0;
  const errors = [];
  const { PullRequestTreeProvider, PullRequestNode } = load(path.join(root, "views/pullRequestTreeProvider.js"), {
    vscode: {
      TreeItem: class {
        constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
      },
      TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
      EventEmitter: class { fire() { refreshes++; } dispose() {} },
      Uri: { from: (uri) => uri },
      ThemeIcon: { File: "file", Folder: "folder" },
    },
  });
  const files = [
    { path: "src/sub/folder/text.js", status: "modified" },
    { path: "src/sub/folder1/somefile.jsx", status: "added" },
    { path: "other/text.js", status: "removed" },
    { path: "README.md", status: "modified" },
    { path: "new/renamed.js", oldPath: "old/original.js", status: "renamed" },
  ];
  const pr = new PullRequestNode({
    id: 42, title: "PR", state: "OPEN",
    source: { branch: { name: "feature" }, repository: { full_name: "fork/repo" } },
    destination: { branch: { name: "main" } },
  });
  const provider = new PullRequestTreeProvider(
    () => ({ getChangedFiles: async () => files }),
    () => repository,
    (error) => errors.push(error),
  );
  const tree = await provider.getChildren(pr);
  assert.deepEqual(tree.map((node) => node.label), ["new", "other", "src", "README.md"]);
  const src = tree.find((node) => node.label === "src");
  const sub = (await provider.getChildren(src))[0];
  const folder = (await provider.getChildren(sub))[0];
  const nestedFile = (await provider.getChildren(folder))[0];
  assert.equal(nestedFile.label, "text.js");
  assert.equal(nestedFile.description, undefined);
  provider.setFileLayout("list");
  assert.equal(refreshes, 1);
  const list = await provider.getChildren(pr);
  assert.deepEqual(list.map((node) => [node.label, node.description]), [
    ["README.md", undefined],
    ["renamed.js", "- new"],
    ["somefile.jsx", "- src/sub/folder1"],
    ["text.js", "- other"],
    ["text.js", "- src/sub/folder"],
  ]);
  for (const node of list) {
    assert.equal(node.collapsibleState, 0);
    assert.equal(node.iconPath, "file");
    assert.equal(node.contextValue, "bitbucketChangedFile");
    assert.deepEqual(await provider.getChildren(node), []);
    assert.equal(node.command.command, "bitbucketPrReviewer.openChangedFile");
    assert.deepEqual(node.command.arguments, [
      repository, 42, files.find((file) => file.path === node.tooltip), "feature", "fork/repo",
    ]);
  }
  assert.deepEqual(list[4].command, nestedFile.command);
  assert.deepEqual(list[4].resourceUri, nestedFile.resourceUri);
  provider.setFileLayout("tree");
  assert.deepEqual((await provider.getChildren(pr)).map((node) => node.label), tree.map((node) => node.label));
  files.length = 0;
  provider.setFileLayout("list");
  assert.deepEqual(await provider.getChildren(pr), []);
  assert.deepEqual(errors, []);
  provider.dispose();
});

test("author filter shows avatars before names, falls back to icons, and preserves selection", async () => {
  const h = harness();
  await h.openDiff();
  const ana = { accountId: "ana", displayName: "Ana", avatarUrl: "https://example.com/ana.png" };
  const bob = { accountId: "bob", displayName: "Bob" };
  h.authorFilter.authors = [ana, bob];
  h.authorFilter.selected = 1;
  const filter = h.commands.get("bitbucketPrReviewer.filterByAuthor");
  await filter();
  const [all, avatar, fallback] = h.authorFilter.items;
  assert.equal(all.label, "All authors");
  assert.equal(all.iconPath.id, "organization");
  assert.equal(avatar.label, "Ana");
  assert.equal(avatar.iconPath.toString(), ana.avatarUrl);
  assert.equal(fallback.label, "Bob");
  assert.equal(fallback.iconPath.id, "account");
  assert.equal(h.authorFilter.current, ana);
  h.authorFilter.selected = undefined;
  await filter();
  assert.equal(h.authorFilter.items[1].description, "(current)");
  assert.equal(h.authorFilter.current, ana);
  h.authorFilter.selected = 0;
  await filter();
  assert.equal(h.authorFilter.current, undefined);
  assert.deepEqual(h.errors, []);
});

test("tree provider carries Bitbucket avatar URLs into the sorted author list and retains the active author", async () => {
  const errors = [];
  const { PullRequestTreeProvider } = load(path.join(root, "views/pullRequestTreeProvider.js"), {
    vscode: {
      TreeItem: class {},
      TreeItemCollapsibleState: { Collapsed: 1 },
      EventEmitter: class { fire() {} dispose() {} },
    },
  });
  const author = { account_id: "ana", display_name: "Ana", links: { avatar: { href: "https://example.com/ana.png" } } };
  let pullRequests = [author, author, { account_id: "bob", display_name: "Bob" }, undefined].map((author, id) => ({
    id, author, title: "PR", state: "OPEN",
    source: { branch: { name: "feature" } }, destination: { branch: { name: "main" } },
  }));
  const provider = new PullRequestTreeProvider(
    () => ({ listPullRequests: async () => pullRequests }),
    () => repository,
    (error) => errors.push(error),
  );
  await provider.getChildren();
  assert.deepEqual(provider.getAuthors(), [
    { accountId: "ana", displayName: "Ana", avatarUrl: "https://example.com/ana.png" },
    { accountId: "bob", displayName: "Bob", avatarUrl: undefined },
  ]);
  provider.setAuthor(provider.getAuthors()[0]);
  assert.equal((await provider.getChildren()).length, 2);
  pullRequests = [];
  await provider.getChildren();
  assert.equal(provider.getAuthors()[0].avatarUrl, author.links.avatar.href);
  assert.deepEqual(errors, []);
  provider.dispose();
});

test("native diff hides deleted comments and removes them from the thread after deletion", async () => {
  const h = harness();
  await h.openDiff();
  const [thread, deletedOnlyThread, orphanThread] = h.threads;
  assert.deepEqual(thread.comments.map((comment) => comment.bitbucketId), [10, 11, 13, 16]);
  assert.equal(deletedOnlyThread.disposed, true);
  assert.equal(orphanThread.disposed, false);
  assert.deepEqual(orphanThread.comments.map((comment) => comment.bitbucketId), [15]);
  assert.equal(orphanThread.range.start.line, 2);
  assert.ok(h.threads.every((item) => item.comments.every((comment) => !/Deleted|Must not appear/.test(comment.body.value))));

  const rootComment = thread.comments[0];
  const reply = thread.comments[1];
  const draft = { body: "Unsent draft", ai: { kind: "draft" } };
  thread.comments = [...thread.comments, draft];
  assert.equal(rootComment.contextValue, "diffsparkOwnComment");
  assert.equal(reply.contextValue, "diffsparkOwnComment");
  assert.equal(thread.comments[2].contextValue, undefined);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(rootComment);
  assert.deepEqual(h.deletions, [[repository, 42, 10]]);
  assert.equal(thread.comments.includes(rootComment), false);
  assert.equal(thread.comments[0], reply);
  assert.equal(thread.comments.at(-1), draft);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(reply);
  assert.deepEqual(h.deletions[1], [repository, 42, 11]);
  assert.equal(thread.comments.includes(reply), false);
  assert.equal(thread.comments.at(-1), draft);
  assert.equal(thread.disposed, false);
  assert.deepEqual(h.errors, []);
});

test("native diff disposes a thread when its last comment is deleted", async () => {
  const h = harness();
  await h.openDiff();
  await h.commands.get("bitbucketPrReviewer.replyDiffComment")({ thread: h.threads[2], text: "New comment" });
  const thread = h.threads[2];
  thread.comments = thread.comments.filter((comment) => comment.bitbucketId === 20);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(thread.comments[0]);
  assert.deepEqual(h.deletions, [[repository, 42, 20]]);
  assert.equal(thread.disposed, true);
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
  assert.equal(comment.contextValue, "diffsparkOwnComment");
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(comment);
  assert.deepEqual(h.deletions, [[repository, 42, 20]]);
});

test("webview exposes deletion, validates messages, and updates without reloading the composer", async () => {
  const h = harness();
  const view = await h.openWebview();
  const html = h.panel.webview.html;
  assert.match(html, /data-comment-id="10"/);
  assert.match(html, /data-comment-id="11"/);
  assert.doesNotMatch(html, /data-comment-id="1[247]"|Must not appear|Deleted root|Deleted reply|Comment deleted/);
  assert.match(html, /Reply to deleted root/);
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
  assert.equal(view.comments.some((comment) => comment.id === 10), false);
  assert.equal(view.comments.find((comment) => comment.id === 11).content.raw, "A reply");
  await view.handleMessage({ command: "deleteComment", commentId: 10 });
  assert.equal(h.deletions.length, 1);
});

test("webview renders the AI review section and validates AI review messages", async () => {
  const h = harness();
  const calls = [];
  const finding = (id, severity, title, extra = {}) => ({
    id, file: "src/app.js", line: 3, severity, category: "bug", title, body: "Fix <b>this</b>", confidence: 0.9, status: "open", ...extra,
  });
  const state = {
    running: false,
    result: {
      verdict: "request_changes",
      summary: "Adds a feature with one bug.",
      findings: [
        finding("b1-1", "major", "Null dereference <script>"),
        finding("b1-2", "nit", "Dismissed one", { status: "dismissed" }),
        finding("b1-3", "minor", "Already posted", { status: "posted" }),
      ],
      filesReviewed: ["src/app.js"],
      filesSkipped: ["package-lock.json"],
      rules: [{ source: "global/general.md", description: "General", applyTo: [] }],
      sourceCommit: "old",
      provider: "Fake model",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
  };
  const host = {
    getState: () => state,
    onDidChange: () => ({ dispose() {} }),
    run: async () => { calls.push(["run"]); },
    cancel: () => calls.push(["cancel"]),
    clear: async () => calls.push(["clear"]),
    editRules: async () => calls.push(["editRules"]),
    openFinding: async (id) => calls.push(["open", id]),
    setFindingStatus: async (ids, status) => calls.push(["status", ids, status]),
    postFindings: async (ids) => { calls.push(["post", ids]); return ids.length; },
    postSummary: async () => calls.push(["summary"]),
  };
  const view = await h.openWebview(host);
  const html = h.panel.webview.html;
  assert.match(html, /id="ai-review"/);
  assert.match(html, /Changes needed/);
  assert.match(html, /Null dereference &lt;script&gt;/);
  assert.doesNotMatch(html, /Null dereference <script>/);
  assert.match(html, /global\/general\.md/);
  assert.match(html, /package-lock\.json/);
  assert.match(html, /new commits/i);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));

  await view.handleMessage({ command: "aiReview", action: "run" });
  await view.handleMessage({ command: "aiReview", action: "editRules" });
  await view.handleMessage({ command: "aiReview", action: "unknown" });
  await view.handleMessage({ command: "aiReviewFindings", action: "dismiss", ids: ["b1-1"] });
  await view.handleMessage({ command: "aiReviewFindings", action: "post", ids: ["b1-1", "b1-3"] });
  await view.handleMessage({ command: "aiReviewFindings", action: "open", ids: ["b1-1"] });
  await view.handleMessage({ command: "aiReviewFindings", action: "post", ids: ["../bad id"] });
  await view.handleMessage({ command: "aiReviewFindings", action: "post", ids: "b1-1" });
  assert.deepEqual(calls.slice(0, 2), [["run"], ["editRules"]]);
  assert.ok(calls.some((call) => call[0] === "status" && call[1][0] === "b1-1" && call[2] === "dismissed"));
  assert.ok(calls.some((call) => call[0] === "post" && call[1].includes("b1-1")));
  assert.ok(calls.some((call) => call[0] === "open" && call[1] === "b1-1"));
  assert.equal(calls.filter((call) => call[0] === "post").length, 1);
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
  assert.equal(view.comments.find((comment) => comment.id === 11).content.raw, "A reply");
});

test("native diff does not allow deleting other people's comments with the same display name", async () => {
  const h = harness();
  await h.openDiff();
  const otherComment = h.threads[0].comments[2];
  assert.equal(otherComment.contextValue, undefined);
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(otherComment);
  assert.equal(h.state.confirmations, 0);
  assert.equal(h.deletions.length, 0);
  assert.match(h.errors[0], /no longer available/);
});

test("native diff warns when identity is unavailable but newly posted comments remain deletable", async () => {
  const h = harness();
  h.state.accountId = undefined;
  await h.openDiff();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /read:user:bitbucket/);
  assert.ok(h.threads.every((thread) => thread.comments.every((comment) => comment.contextValue === undefined)));
  await h.commands.get("bitbucketPrReviewer.replyDiffComment")({ thread: h.threads[0], text: "New comment" });
  const comment = h.threads[0].comments.at(-1);
  assert.equal(comment.contextValue, "diffsparkOwnComment");
  await h.commands.get("bitbucketPrReviewer.deleteDiffComment")(comment);
  assert.deepEqual(h.deletions, [[repository, 42, 20]]);
});

test("manifest puts the trash icon in the preview comment title, not the editing actions", () => {
  const { contributes } = require("../package.json");
  const id = "bitbucketPrReviewer.deleteDiffComment";
  assert.equal(contributes.commands.find((command) => command.command === id).icon, "$(trash)");
  assert.deepEqual(contributes.menus["commandPalette"].find((command) => command.command === id), { command: id, when: "false" });
  const titleAction = contributes.menus["comments/comment/title"].find((command) => command.command === id);
  assert.equal(titleAction.group, "inline@1");
  assert.equal(titleAction.when, "commentController == diffspark && comment == diffsparkOwnComment");
  assert.equal(contributes.menus["comments/comment/context"].some((command) => command.command === id), false);
});
