const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

const filename = require.resolve("../dist/views/pullRequestTreeProvider");
const treeModule = new Module(filename);
const requireFromFile = Module.createRequire(filename);
treeModule.require = (id) =>
    id === "vscode"
        ? {
              TreeItem: class {
                  constructor(label) {
                      this.label = label;
                  }
              },
              TreeItemCollapsibleState: {None: 0, Collapsed: 1},
              ThemeIcon: class {
                  static File = "file";
                  static Folder = "folder";
                  constructor(id, color) {
                      this.id = id;
                      this.color = color;
                  }
              },
              ThemeColor: class {
                  constructor(id) {
                      this.id = id;
                  }
              },
              FileDecoration: class {
                  constructor(badge, tooltip, color) {
                      Object.assign(this, {badge, tooltip, color});
                  }
              },
              Uri: {from: (components) => components},
              EventEmitter: class {
                  event = () => {};
                  fire() {}
                  dispose() {}
              },
          }
        : requireFromFile(id);
treeModule._compile(fs.readFileSync(filename, "utf8"), filename);
const {PullRequestTreeProvider} = treeModule.exports;
const {BitbucketClient} = require("../dist/bitbucket/client");

const repository = {workspace: "team", slug: "repo", fullName: "team/repo"};
const participant = (accountId, state, approved = false) => ({
    user: {account_id: accountId},
    state,
    approved,
});
const pullRequest = (id, participants = []) => ({
    id,
    title: `PR ${id}`,
    state: "OPEN",
    source: {branch: {name: "feature"}},
    destination: {branch: {name: "main"}},
    participants,
});

test("shows only the connected user's review and updates it on refresh", async () => {
    const calls = [];
    let pullRequests = [
        pullRequest(1, [participant("me", "approved")]),
        pullRequest(2, [participant("me", "changes_requested", true)]),
        pullRequest(3, [participant("other", "approved", true)]),
        {...pullRequest(4, [participant("me", null, true)]), draft: true},
    ];
    const client = new BitbucketClient("email", "token", async (url) => {
        calls.push(new URL(url));
        return {
            statusCode: 200,
            body: JSON.stringify(
                url.endsWith("/user") ? {account_id: "me"} : {values: pullRequests},
            ),
        };
    });
    const provider = new PullRequestTreeProvider(
        () => client,
        () => repository,
        (error) => {
            throw error;
        },
    );
    provider.setFilters(["OPEN"], true);
    const nodes = await provider.getChildren();
    assert.deepEqual(
        nodes.map((node) => node.iconPath.id),
        ["check", "request-changes", "git-pull-request", "check"],
    );
    assert.equal(nodes[0].iconPath.color.id, "testing.iconPassed");
    assert.equal(nodes[1].iconPath.color.id, "list.warningForeground");
    assert.match(nodes[0].tooltip, /Approved by you/);
    assert.match(nodes[1].accessibilityInformation.label, /Changes requested by you/);
    assert.match(nodes[2].tooltip, /No approval or change request from you/);
    assert.equal(nodes[3].description, "#4 · Draft · OPEN");
    assert.equal(nodes[0].command.arguments[0], provider.getLoadedPullRequests()[0]);
    assert.equal(calls.length, 2);
    assert.equal(
        calls
            .find((url) => url.pathname.endsWith("/pullrequests"))
            .searchParams.get("fields"),
        "+values.participants",
    );

    pullRequests = [pullRequest(1)];
    provider.refresh();
    const refreshed = await provider.getChildren();
    assert.equal(refreshed[0].iconPath.id, "git-pull-request");
    assert.equal(calls.length, 3, "refresh reuses the cached account identity");
});

test("keeps PRs visible when the account identity is unavailable or fails", async () => {
    for (const fails of [false, true]) {
        const errors = [];
        const provider = new PullRequestTreeProvider(
            () => ({
                listPullRequests: async () => [pullRequest(1)],
                getCurrentAccountId: async () => {
                    if (fails) throw new Error("User lookup failed");
                    return undefined;
                },
            }),
            () => repository,
            (error) => errors.push(error),
        );
        const nodes = await provider.getChildren();
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].iconPath.id, "git-pull-request");
        assert.match(nodes[0].tooltip, /Your review status is unavailable/);
        assert.equal(errors.length, fails ? 1 : 0);
    }
});

test("marks conflicting files with a warning decoration in tree and list layouts", async () => {
    const errors = [];
    const conflictCalls = [];
    const files = [
        {path: "src/app.ts", status: "modified", newPath: "src/app.ts"},
        {path: "README.md", status: "modified"},
    ];
    const {PullRequestTreeProvider, PullRequestNode} = treeModule.exports;
    const provider = new PullRequestTreeProvider(
        () => ({
            getChangedFiles: async () => files,
            getFileConflicts: async (...args) => {
                conflictCalls.push(args);
                return [{path: "src/app.ts", scenario: "content"}];
            },
        }),
        () => repository,
        (error) => errors.push(error),
    );
    const pr = new PullRequestNode({
        id: 7,
        title: "PR 7",
        state: "OPEN",
        source: {branch: {name: "feature"}},
        destination: {branch: {name: "main"}},
    });

    const tree = await provider.getChildren(pr);
    const src = tree.find((node) => node.label === "src");
    const [treeFile] = await provider.getChildren(src);
    assert.equal(treeFile.resourceUri.query, "conflict=1");

    provider.setFileLayout("list");
    const list = await provider.getChildren(pr);
    const app = list.find((node) => node.label === "app.ts");
    const readme = list.find((node) => node.label === "README.md");
    assert.equal(app.resourceUri.query, "conflict=1");
    assert.match(app.tooltip, /Merge conflict/);
    assert.match(app.accessibilityInformation.label, /merge conflict/);
    assert.equal(app.command.arguments[2].conflicted, true);
    assert.equal(readme.resourceUri.query, undefined);
    assert.equal(readme.tooltip, "README.md");
    assert.equal(readme.command.arguments[2], files[1]);

    const decoration = provider.provideFileDecoration(app.resourceUri);
    assert.equal(decoration.badge, "⚠");
    assert.equal(decoration.tooltip, "Merge conflict");
    assert.equal(decoration.color.id, "list.warningForeground");
    assert.equal(provider.provideFileDecoration(readme.resourceUri), undefined);
    assert.equal(
        provider.provideFileDecoration({scheme: "file", query: "conflict=1"}),
        undefined,
    );
    assert.deepEqual(conflictCalls, [
        [repository, 7],
        [repository, 7],
    ]);
    assert.equal(files[0].conflicted, undefined);
    assert.deepEqual(errors, []);
    provider.dispose();
});

test("keeps changed files visible when conflict detection fails and skips closed PRs", async () => {
    const errors = [];
    const conflictCalls = [];
    const {PullRequestTreeProvider, PullRequestNode} = treeModule.exports;
    const pullRequest = {
        id: 1,
        title: "PR 1",
        state: "OPEN",
        source: {branch: {name: "feature"}},
        destination: {branch: {name: "main"}},
    };
    const provider = new PullRequestTreeProvider(
        () => ({
            getChangedFiles: async () => [{path: "README.md", status: "modified"}],
            getFileConflicts: async (_repository, id) => {
                conflictCalls.push(id);
                throw new Error("Conflicts unavailable");
            },
        }),
        () => repository,
        (error) => errors.push(error),
    );

    const open = await provider.getChildren(new PullRequestNode(pullRequest));
    assert.deepEqual(
        open.map((node) => node.label),
        ["README.md"],
    );
    assert.equal(open[0].resourceUri.query, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Conflicts unavailable/);

    const merged = await provider.getChildren(
        new PullRequestNode({...pullRequest, id: 2, state: "MERGED"}),
    );
    assert.equal(merged.length, 1);
    assert.deepEqual(conflictCalls, [1]);
    assert.equal(errors.length, 1);
    provider.dispose();
});
