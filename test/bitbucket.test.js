const test = require("node:test");
const assert = require("node:assert/strict");
const {buildFileTree} = require("../dist/bitbucket/tree");
const {BitbucketClient} = require("../dist/bitbucket/client");
const {JiraClient} = require("../dist/jira/client");
const {extractJiraIssueKeys} = require("../dist/jira/issues");
const {parseBitbucketRemoteUrl} = require("../dist/bitbucket/repository");
const {renderMarkdown, sanitizeCommentHtml} = require("../dist/views/markdown");

const repository = {
    workspace: "iptvplatform",
    slug: "iptv-dashboard",
    fullName: "iptvplatform/iptv-dashboard",
};

function fakeTransport(responses) {
    const calls = [];
    return {
        calls,
        transport: async (url, method, headers, body) => {
            calls.push({url, method, headers, body});
            const response = responses.shift();
            if (!response) {
                throw new Error("No fake response was configured.");
            }
            return response;
        },
    };
}

test("deletes a published comment using its PR endpoint and accepts an empty 204 response", async () => {
    const fake = fakeTransport([{statusCode: 204, body: ""}]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);
    assert.equal(await client.deleteComment(repository, 42, 10), undefined);
    assert.equal(fake.calls[0].method, "DELETE");
    assert.equal(
        fake.calls[0].url,
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/comments/10",
    );
    assert.equal(fake.calls[0].body, undefined);
});

test("rejects invalid comment IDs without making a request", async () => {
    const fake = fakeTransport([]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);
    for (const id of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "10",
        "../10",
    ]) {
        assert.throws(
            () => client.deleteComment(repository, 42, id),
            /Invalid pull request comment ID/,
        );
    }
    assert.equal(fake.calls.length, 0);
});

test("reports comment deletion permission errors rather than claiming success", async () => {
    const fake = fakeTransport([
        {statusCode: 403, body: JSON.stringify({error: {message: "Permission denied."}})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);
    await assert.rejects(
        client.deleteComment(repository, 42, 10),
        /HTTP 403: Permission denied/,
    );
});

test("parses HTTPS and SSH Bitbucket remotes", () => {
    assert.deepEqual(
        parseBitbucketRemoteUrl(
            "https://someone@bitbucket.org/iptvplatform/iptv-dashboard.git",
        ),
        repository,
    );
    assert.deepEqual(
        parseBitbucketRemoteUrl("git@bitbucket.org:iptvplatform/iptv-dashboard.git"),
        repository,
    );
});

test("rejects other hosts and malformed Bitbucket paths", () => {
    assert.equal(
        parseBitbucketRemoteUrl("git@github.com:iptvplatform/iptv-dashboard.git"),
        undefined,
    );
    assert.equal(
        parseBitbucketRemoteUrl("https://bitbucket.org/iptvplatform"),
        undefined,
    );
    assert.equal(parseBitbucketRemoteUrl("not a remote"), undefined);
});

test("builds a path tree with shared directories and directories before files", () => {
    const tree = buildFileTree([
        "src/components/task.js",
        "src/components/list.js",
        "src/main.ts",
        "README.md",
    ]);

    assert.deepEqual(
        tree.map(({name, kind}) => [name, kind]),
        [
            ["src", "directory"],
            ["README.md", "file"],
        ],
    );
    assert.deepEqual(
        tree[0].children.map(({name, kind}) => [name, kind]),
        [
            ["components", "directory"],
            ["main.ts", "file"],
        ],
    );
    assert.deepEqual(
        tree[0].children[0].children.map(({name}) => name),
        ["list.js", "task.js"],
    );
});

test("renders Markdown while sanitizing script tags and unsafe links", () => {
    const rendered = renderMarkdown(
        "**Review** [safe](https://example.com) <script>alert(1)</script>",
    );
    assert.match(rendered, /<strong>Review<\/strong>/);
    assert.match(rendered, /href="https:\/\/example\.com"/);
    assert.doesNotMatch(rendered, /<script>/);

    const sanitized = sanitizeCommentHtml(
        '<img src=x onerror="alert(1)"><script>alert(2)</script>',
    );
    assert.doesNotMatch(sanitized, /<img|<script|onerror=/);
});

test("lists PRs using selected states and sort and filters drafts", async () => {
    const fake = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({
                values: [
                    {id: 1, title: "Draft PR", draft: true},
                    {id: 2, title: "Ready PR", draft: false},
                ],
            }),
        },
    ]);
    const client = new BitbucketClient("dev@example.com", "secret-token", fake.transport);

    const pullRequests = await client.listPullRequests(
        repository,
        ["OPEN", "MERGED"],
        false,
        "created_on",
    );

    assert.deepEqual(
        pullRequests.map(({id}) => id),
        [2],
    );
    const requestUrl = new URL(fake.calls[0].url);
    assert.equal(
        requestUrl.pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests",
    );
    assert.equal(requestUrl.searchParams.get("pagelen"), "50");
    assert.equal(requestUrl.searchParams.get("q"), 'state IN ("OPEN","MERGED")');
    assert.equal(requestUrl.searchParams.get("sort"), "created_on");
    assert.equal(requestUrl.searchParams.get("fields"), "+values.participants");
    assert.equal(
        fake.calls[0].headers.Authorization,
        `Basic ${Buffer.from("dev@example.com:secret-token").toString("base64")}`,
    );
});

test("includes the custom commit message in the Bitbucket merge request", async () => {
    const fake = fakeTransport([{statusCode: 200, body: ""}]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.merge(repository, 42, "squash", true, "Merge PR #42");

    assert.equal(fake.calls[0].method, "POST");
    assert.equal(
        fake.calls[0].url,
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/merge",
    );
    assert.deepEqual(JSON.parse(fake.calls[0].body), {
        merge_strategy: "squash",
        close_source_branch: true,
        message: "Merge PR #42",
    });
});

test("extracts unique Jira keys from PR title, description, and source branch", () => {
    assert.deepEqual(
        extractJiraIssueKeys({
            title: "ICS-4354: Update language selector",
            description: "Also fixes APP_2-88 and ICS-4354.",
            source: {branch: {name: "feature/APP_2-89-translation"}},
        }),
        ["ICS-4354", "APP_2-88", "APP_2-89"],
    );
});

test("loads Jira issue metadata and transitions with authenticated Cloud API requests", async () => {
    const fake = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({
                key: "ICS-4354",
                fields: {summary: "Fix language selection", issuetype: {name: "Bug"}},
            }),
        },
        {
            statusCode: 200,
            body: JSON.stringify({
                transitions: [
                    {
                        id: "31",
                        name: "Start progress",
                        to: {name: "In Progress", statusCategory: {key: "indeterminate"}},
                    },
                    {id: "32", name: "Malformed", to: {}},
                ],
            }),
        },
    ]);
    const client = new JiraClient(
        "https://example.atlassian.net",
        "jira@example.com",
        "jira-token",
        fake.transport,
    );

    assert.deepEqual(await client.getIssue("ICS-4354"), {
        key: "ICS-4354",
        summary: "Fix language selection",
        issueType: "Bug",
    });
    assert.deepEqual(await client.getTransitions("ICS-4354"), [
        {
            id: "31",
            name: "Start progress",
            to: {name: "In Progress", statusCategory: {key: "indeterminate"}},
        },
    ]);
    assert.equal(new URL(fake.calls[0].url).pathname, "/rest/api/3/issue/ICS-4354");
    assert.equal(
        new URL(fake.calls[0].url).searchParams.get("fields"),
        "summary,issuetype",
    );
    assert.equal(
        fake.calls[0].headers.Authorization,
        `Basic ${Buffer.from("jira@example.com:jira-token").toString("base64")}`,
    );
    assert.equal(
        new URL(fake.calls[1].url).pathname,
        "/rest/api/3/issue/ICS-4354/transitions",
    );
});

test("posts Jira transition and refuses untrusted redirect targets", async () => {
    const fake = fakeTransport([{statusCode: 204, body: ""}]);
    const client = new JiraClient(
        "https://example.atlassian.net",
        "jira@example.com",
        "token",
        fake.transport,
    );
    await client.transition("ICS-4354", "31");
    assert.equal(fake.calls[0].method, "POST");
    assert.deepEqual(JSON.parse(fake.calls[0].body), {transition: {id: "31"}});

    const unsafe = fakeTransport([
        {statusCode: 302, body: "", location: "https://evil.example/steal"},
    ]);
    const unsafeClient = new JiraClient(
        "https://example.atlassian.net",
        "jira@example.com",
        "token",
        unsafe.transport,
    );
    await assert.rejects(
        unsafeClient.getIssue("ICS-4354"),
        /redirected outside its REST API/,
    );
    assert.equal(unsafe.calls.length, 1);
});

test("rejects Jira URLs outside Jira Cloud", () => {
    assert.throws(
        () =>
            new JiraClient(
                "https://example.com",
                "jira@example.com",
                "token",
                async () => ({statusCode: 200, body: "{}"}),
            ),
        /Jira Cloud site URL/,
    );
});

test("follows paginated links only within the Bitbucket REST API", async () => {
    const fake = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({
                values: [{id: 1}],
                next: "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests?page=2",
            }),
        },
        {statusCode: 200, body: JSON.stringify({values: [{id: 2}]})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    const pullRequests = await client.listPullRequests(
        repository,
        ["OPEN"],
        true,
        "-updated_on",
    );
    assert.deepEqual(
        pullRequests.map(({id}) => id),
        [1, 2],
    );
    assert.equal(fake.calls.length, 2);

    const unsafe = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({values: [], next: "https://example.com/steal-token"}),
        },
    ]);
    const unsafeClient = new BitbucketClient(
        "dev@example.com",
        "token",
        unsafe.transport,
    );
    await assert.rejects(
        unsafeClient.listPullRequests(repository, ["OPEN"], true, "-updated_on"),
        /pagination link outside its REST API/,
    );
    assert.equal(unsafe.calls.length, 1);
});

test("reads diffstat paths and falls back to the old path for deleted files", async () => {
    const fake = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({
                values: [
                    {status: "added", new: {path: "src/new.ts"}},
                    {status: "removed", old: {path: "src/old.ts"}},
                ],
            }),
        },
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    assert.deepEqual(await client.getChangedFiles(repository, 42), [
        {path: "src/new.ts", status: "added", newPath: "src/new.ts"},
        {path: "src/old.ts", status: "removed", oldPath: "src/old.ts"},
    ]);
});

test("follows the diffstat redirect to the repository diffstat endpoint", async () => {
    const redirectTarget =
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/iptvplatform/iptv-dashboard:abc%0Ddef?from_pullrequest_id=42&topic=true";
    const fake = fakeTransport([
        {statusCode: 302, body: "", location: redirectTarget},
        {
            statusCode: 200,
            body: JSON.stringify({
                values: [{status: "modified", new: {path: "src/components/task.js"}}],
            }),
        },
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    assert.deepEqual(await client.getChangedFiles(repository, 42), [
        {
            path: "src/components/task.js",
            status: "modified",
            newPath: "src/components/task.js",
        },
    ]);
    assert.equal(fake.calls.length, 2);
    assert.equal(
        new URL(fake.calls[0].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/diffstat",
    );
    assert.equal(fake.calls[1].url, redirectTarget);
    assert.equal(fake.calls[1].method, "GET");
    assert.equal(
        fake.calls[1].headers.Authorization,
        fake.calls[0].headers.Authorization,
    );
});

test("resolves relative redirect locations against the Bitbucket API", async () => {
    const fake = fakeTransport([
        {
            statusCode: 301,
            body: "",
            location: "/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/abc",
        },
        {statusCode: 200, body: JSON.stringify({values: []})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.getChangedFiles(repository, 42);
    assert.equal(
        fake.calls[1].url,
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/abc",
    );
});

test("refuses redirects that would send the token outside the Bitbucket REST API", async () => {
    for (const location of [
        "https://evil.example/2.0/repositories/steal",
        "https://api.bitbucket.org@evil.example/2.0/repositories/steal",
        "http://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/abc",
        "https://api.bitbucket.org:8443/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/abc",
        "https://bitbucket.org/!api/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/abc",
        "https://api.bitbucket.org/1.0/repositories/iptvplatform/iptv-dashboard",
    ]) {
        const fake = fakeTransport([{statusCode: 302, body: "", location}]);
        const client = new BitbucketClient("dev@example.com", "token", fake.transport);

        await assert.rejects(
            client.getChangedFiles(repository, 42),
            /redirected outside its REST API/,
            location,
        );
        assert.equal(fake.calls.length, 1, location);
    }
});

test("limits redirects and rejects redirects without a location", async () => {
    const location =
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/diffstat/loop";
    const loop = fakeTransport(
        Array.from({length: 10}, () => ({statusCode: 302, body: "", location})),
    );
    const loopClient = new BitbucketClient("dev@example.com", "token", loop.transport);
    await assert.rejects(
        loopClient.getChangedFiles(repository, 42),
        /exceeded the limit of 5 redirects/,
    );
    assert.equal(loop.calls.length, 6);

    const missing = fakeTransport([{statusCode: 302, body: ""}]);
    const missingClient = new BitbucketClient(
        "dev@example.com",
        "token",
        missing.transport,
    );
    await assert.rejects(
        missingClient.getChangedFiles(repository, 42),
        /HTTP 302 without a Location header/,
    );
});

test("repeats writes only on method-preserving redirects", async () => {
    const location =
        "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/merge";

    const preserved = fakeTransport([
        {statusCode: 307, body: "", location},
        {statusCode: 200, body: JSON.stringify({state: "MERGED"})},
    ]);
    await new BitbucketClient("dev@example.com", "token", preserved.transport).merge(
        repository,
        42,
        "squash",
    );
    assert.equal(preserved.calls[1].method, "POST");
    assert.equal(preserved.calls[1].body, preserved.calls[0].body);

    const seeOther = fakeTransport([
        {statusCode: 303, body: "", location},
        {statusCode: 200, body: JSON.stringify({state: "MERGED"})},
    ]);
    await new BitbucketClient("dev@example.com", "token", seeOther.transport).merge(
        repository,
        42,
        "squash",
    );
    assert.equal(seeOther.calls[1].method, "GET");
    assert.equal(seeOther.calls[1].body, undefined);
    assert.equal(seeOther.calls[0].headers["Content-Type"], "application/json");
    assert.equal(seeOther.calls[1].headers["Content-Type"], undefined);
    assert.equal(
        seeOther.calls[1].headers.Authorization,
        seeOther.calls[0].headers.Authorization,
    );

    const downgraded = fakeTransport([{statusCode: 302, body: "", location}]);
    await assert.rejects(
        new BitbucketClient("dev@example.com", "token", downgraded.transport).merge(
            repository,
            42,
            "squash",
        ),
        /redirected POST .*HTTP 302; the request was not repeated/,
    );
    assert.equal(downgraded.calls.length, 1);
});

test("loads renamed file contents at the merge base and source commit, including forks", async () => {
    const fake = fakeTransport([
        {
            statusCode: 200,
            body: JSON.stringify({
                source: {
                    commit: {hash: "source"},
                    repository: {full_name: "fork/project"},
                },
                destination: {commit: {hash: "destination"}},
            }),
        },
        {statusCode: 200, body: JSON.stringify({hash: "base"})},
        {statusCode: 200, body: "const before = 1;\n"},
        {statusCode: 200, body: "  \n"},
    ]);
    const result = await new BitbucketClient(
        "dev@example.com",
        "token",
        fake.transport,
    ).getFileComparison(repository, 42, {
        path: "new #?.ts",
        oldPath: "old.ts",
        status: "renamed",
    });
    assert.deepEqual(result, {before: "const before = 1;\n", after: "  \n"});
    assert.match(fake.calls[1].url, /merge-base\/destination\.\.source$/);
    assert.match(fake.calls[2].url, /iptv-dashboard\/src\/base\/old.ts$/);
    assert.match(fake.calls[3].url, /fork\/project\/src\/source\/new%20%23%3F.ts$/);
});

test("uses an empty side for added and removed files without fetching a missing file", async () => {
    for (const status of ["added", "removed"]) {
        const responses = [
            {
                statusCode: 200,
                body: JSON.stringify({
                    source: {commit: {hash: "source"}},
                    destination: {commit: {hash: "destination"}},
                }),
            },
            ...(status === "removed"
                ? [{statusCode: 200, body: JSON.stringify({hash: "base"})}]
                : []),
            {statusCode: 200, body: "content\n"},
        ];
        const fake = fakeTransport(responses);
        const result = await new BitbucketClient(
            "dev@example.com",
            "token",
            fake.transport,
        ).getFileComparison(repository, 42, {path: "file.ts", status});
        assert.deepEqual(
            result,
            status === "added"
                ? {before: "", after: "content\n"}
                : {before: "content\n", after: ""},
        );
        assert.equal(fake.calls.length, status === "added" ? 2 : 3);
    }
});

test("nested changed files open a diff for their original repository and PR", async () => {
    const Module = require("node:module");
    const originalLoad = Module._load;
    let PullRequestTreeProvider;
    let PullRequestNode;
    Module._load = function (id, ...args) {
        if (id === "vscode") {
            return {
                TreeItem: class {
                    constructor(label) {
                        this.label = label;
                    }
                },
                TreeItemCollapsibleState: {None: 0, Collapsed: 1},
                ThemeIcon: class {
                    static File = "file";
                    static Folder = "folder";
                },
                Uri: {from: (components) => components},
                EventEmitter: class {
                    fire() {}
                    dispose() {}
                },
            };
        }
        return originalLoad.call(this, id, ...args);
    };
    try {
        ({
            PullRequestTreeProvider,
            PullRequestNode,
        } = require("../dist/views/pullRequestTreeProvider"));
    } finally {
        Module._load = originalLoad;
    }
    const file = {path: "src/nested/new.ts", oldPath: "src/old.ts", status: "renamed"};
    let selectedRepository = repository;
    const provider = new PullRequestTreeProvider(
        () => ({getChangedFiles: async () => [file]}),
        () => selectedRepository,
        (error) => {
            throw error;
        },
    );
    const pullRequest = new PullRequestNode({
        id: 42,
        title: "Test",
        source: {branch: {name: "feature"}},
        destination: {branch: {name: "main"}},
    });
    const [root] = await provider.getChildren(pullRequest);
    assert.equal(root.command, undefined);
    selectedRepository = {workspace: "other", slug: "other", fullName: "other/other"};
    const [directory] = await provider.getChildren(root);
    const [leaf] = await provider.getChildren(directory);
    assert.equal(directory.iconPath, "folder");
    assert.equal(leaf.iconPath, "file");
    assert.equal(
        leaf.resourceUri.path,
        "/iptvplatform/iptv-dashboard/42/src/nested/new.ts",
    );
    assert.equal(leaf.command.command, "bitbucketPrReviewer.openChangedFile");
    assert.deepEqual(leaf.command.arguments, [
        repository,
        42,
        file,
        "feature",
        "iptvplatform/iptv-dashboard",
    ]);
    provider.dispose();
});

test("creates Markdown comments and threaded replies", async () => {
    const fake = fakeTransport([
        {statusCode: 201, body: JSON.stringify({id: 10})},
        {statusCode: 201, body: JSON.stringify({id: 11})},
        {statusCode: 201, body: JSON.stringify({id: 12})},
        {statusCode: 201, body: JSON.stringify({id: 13})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.createComment(repository, 42, "**Please update this section.**");
    await client.createComment(repository, 42, "I pushed the fix.", 10);
    await client.createComment(
        repository,
        42,
        "This should be on the new line.",
        undefined,
        {
            path: "src/file.ts",
            to: 23,
        },
    );
    await client.createComment(
        repository,
        42,
        "This should be on the old line.",
        undefined,
        {
            path: "src/old-file.ts",
            from: 19,
        },
    );

    assert.deepEqual(JSON.parse(fake.calls[0].body), {
        content: {raw: "**Please update this section.**"},
    });
    assert.deepEqual(JSON.parse(fake.calls[1].body), {
        content: {raw: "I pushed the fix."},
        parent: {id: 10},
    });
    assert.deepEqual(JSON.parse(fake.calls[2].body), {
        content: {raw: "This should be on the new line."},
        inline: {path: "src/file.ts", to: 23},
    });
    assert.deepEqual(JSON.parse(fake.calls[3].body), {
        content: {raw: "This should be on the old line."},
        inline: {path: "src/old-file.ts", from: 19},
    });
});

test("approves and merges through the supported PR endpoints", async () => {
    const fake = fakeTransport([
        {statusCode: 200, body: ""},
        {statusCode: 200, body: JSON.stringify({state: "MERGED"})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.approve(repository, 42);
    await client.merge(repository, 42, "squash", true);

    assert.equal(
        new URL(fake.calls[0].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/approve",
    );
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(
        new URL(fake.calls[1].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/merge",
    );
    assert.deepEqual(JSON.parse(fake.calls[1].body), {
        merge_strategy: "squash",
        close_source_branch: true,
    });
});

test("requests changes through the supported PR endpoint", async () => {
    const fake = fakeTransport([{statusCode: 200, body: ""}]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.requestChanges(repository, 42);

    assert.equal(
        new URL(fake.calls[0].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/request-changes",
    );
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].body, undefined);
});

test("removes approvals and change requests with DELETE", async () => {
    const fake = fakeTransport([
        {statusCode: 204, body: ""},
        {statusCode: 204, body: ""},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    await client.unapprove(repository, 42);
    await client.removeChangeRequest(repository, 42);

    assert.equal(
        new URL(fake.calls[0].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/approve",
    );
    assert.equal(fake.calls[0].method, "DELETE");
    assert.equal(
        new URL(fake.calls[1].url).pathname,
        "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/request-changes",
    );
    assert.equal(fake.calls[1].method, "DELETE");
});

test("shares the cached current account identity across diff comments and review state", async () => {
    const fake = fakeTransport([
        {statusCode: 200, body: JSON.stringify({account_id: "me"})},
        {
            statusCode: 200,
            body: JSON.stringify({
                participants: [{user: {account_id: "me"}, approved: true}],
            }),
        },
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);
    assert.deepEqual(
        await Promise.all([client.getCurrentAccountId(), client.getCurrentAccountId()]),
        ["me", "me"],
    );
    assert.equal(await client.getMyReviewState(repository, 42), "approved");
    assert.equal(
        fake.calls.filter((call) => new URL(call.url).pathname === "/2.0/user").length,
        1,
    );
});

test("reports identity lookup errors and retries after a failed request", async () => {
    const fake = fakeTransport([
        {statusCode: 500, body: JSON.stringify({error: {message: "Unavailable"}})},
        {statusCode: 200, body: JSON.stringify({account_id: "me"})},
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);
    await assert.rejects(client.getCurrentAccountId(), /HTTP 500: Unavailable/);
    assert.equal(await client.getCurrentAccountId(), "me");
});

test("reads the current user's review state from the PR participants", async () => {
    const pullRequest = (state, approved = false) => ({
        statusCode: 200,
        body: JSON.stringify({
            participants: [
                {user: {account_id: "other"}, state: "approved", approved: true},
                {user: {account_id: "me"}, state, approved},
            ],
        }),
    });
    const fake = fakeTransport([
        {statusCode: 200, body: JSON.stringify({account_id: "me"})},
        pullRequest("approved", true),
        pullRequest("changes_requested"),
        pullRequest(null),
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    assert.equal(await client.getMyReviewState(repository, 42), "approved");
    assert.equal(await client.getMyReviewState(repository, 42), "changes_requested");
    assert.equal(await client.getMyReviewState(repository, 42), "none");
    assert.equal(new URL(fake.calls[0].url).pathname, "/2.0/user");
    assert.equal(
        fake.calls.filter((call) => new URL(call.url).pathname === "/2.0/user").length,
        1,
    );
});

test("falls back when the token cannot read the current user, then learns it from approve", async () => {
    const pullRequest = {
        statusCode: 200,
        body: JSON.stringify({
            participants: [{user: {account_id: "me"}, state: "approved", approved: true}],
        }),
    };
    const fake = fakeTransport([
        {
            statusCode: 403,
            body: JSON.stringify({
                error: {
                    message:
                        "Your credentials lack one or more required privilege scopes.",
                },
            }),
        },
        pullRequest,
        pullRequest,
        {
            statusCode: 200,
            body: JSON.stringify({user: {account_id: "me"}, approved: true}),
        },
        pullRequest,
    ]);
    const client = new BitbucketClient("dev@example.com", "token", fake.transport);

    assert.equal(await client.getMyReviewState(repository, 42), "none");
    assert.equal(await client.getMyReviewState(repository, 42), "none");
    await client.approve(repository, 42);
    assert.equal(await client.getMyReviewState(repository, 42), "approved");
    assert.equal(
        fake.calls.filter((call) => new URL(call.url).pathname === "/2.0/user").length,
        1,
    );
});

test("surfaces API errors and invalid JSON responses", async () => {
    const failed = fakeTransport([
        {statusCode: 403, body: JSON.stringify({error: {message: "Permission denied."}})},
    ]);
    const failedClient = new BitbucketClient(
        "dev@example.com",
        "token",
        failed.transport,
    );
    await assert.rejects(
        failedClient.listPullRequests(repository, ["OPEN"], true, "-updated_on"),
        /HTTP 403: Permission denied/,
    );

    const invalid = fakeTransport([{statusCode: 200, body: "not-json"}]);
    const invalidClient = new BitbucketClient(
        "dev@example.com",
        "token",
        invalid.transport,
    );
    await assert.rejects(
        invalidClient.listPullRequests(repository, ["OPEN"], true, "-updated_on"),
        /returned invalid JSON/,
    );
});
