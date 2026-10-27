const assert = require("node:assert/strict");
const test = require("node:test");
const { BitbucketClient } = require("../dist/bitbucket/client");
const { parseBitbucketRemoteUrl } = require("../dist/bitbucket/repository");
const { buildFileTree } = require("../dist/bitbucket/tree");
const { renderMarkdown, sanitizeCommentHtml } = require("../dist/views/markdown");

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
      calls.push({ url, method, headers, body });
      const response = responses.shift();
      if (!response) {
        throw new Error("No fake response was configured.");
      }
      return response;
    },
  };
}

test("parses HTTPS and SSH Bitbucket remotes", () => {
  assert.deepEqual(
    parseBitbucketRemoteUrl("https://someone@bitbucket.org/iptvplatform/iptv-dashboard.git"),
    repository,
  );
  assert.deepEqual(
    parseBitbucketRemoteUrl("git@bitbucket.org:iptvplatform/iptv-dashboard.git"),
    repository,
  );
});

test("rejects other hosts and malformed Bitbucket paths", () => {
  assert.equal(parseBitbucketRemoteUrl("git@github.com:iptvplatform/iptv-dashboard.git"), undefined);
  assert.equal(parseBitbucketRemoteUrl("https://bitbucket.org/iptvplatform"), undefined);
  assert.equal(parseBitbucketRemoteUrl("not a remote"), undefined);
});

test("builds a path tree with shared directories and directories before files", () => {
  const tree = buildFileTree([
    "src/components/task.js",
    "src/components/list.js",
    "src/main.ts",
    "README.md",
  ]);

  assert.deepEqual(tree.map(({ name, kind }) => [name, kind]), [
    ["src", "directory"],
    ["README.md", "file"],
  ]);
  assert.deepEqual(tree[0].children.map(({ name, kind }) => [name, kind]), [
    ["components", "directory"],
    ["main.ts", "file"],
  ]);
  assert.deepEqual(tree[0].children[0].children.map(({ name }) => name), ["list.js", "task.js"]);
});

test("renders Markdown while sanitizing script tags and unsafe links", () => {
  const rendered = renderMarkdown("**Review** [safe](https://example.com) <script>alert(1)</script>");
  assert.match(rendered, /<strong>Review<\/strong>/);
  assert.match(rendered, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(rendered, /<script>/);

  const sanitized = sanitizeCommentHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  assert.doesNotMatch(sanitized, /<img|<script|onerror=/);
});

test("lists PRs using selected states and sort and filters drafts", async () => {
  const fake = fakeTransport([
    {
      statusCode: 200,
      body: JSON.stringify({
        values: [
          { id: 1, title: "Draft PR", draft: true },
          { id: 2, title: "Ready PR", draft: false },
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

  assert.deepEqual(pullRequests.map(({ id }) => id), [2]);
  const requestUrl = new URL(fake.calls[0].url);
  assert.equal(requestUrl.pathname, "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests");
  assert.equal(requestUrl.searchParams.get("q"), 'state IN ("OPEN","MERGED")');
  assert.equal(requestUrl.searchParams.get("sort"), "created_on");
  assert.equal(fake.calls[0].headers.Authorization, `Basic ${Buffer.from("dev@example.com:secret-token").toString("base64")}`);
});

test("follows paginated links only within the Bitbucket REST API", async () => {
  const fake = fakeTransport([
    {
      statusCode: 200,
      body: JSON.stringify({
        values: [{ id: 1 }],
        next: "https://api.bitbucket.org/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests?page=2",
      }),
    },
    { statusCode: 200, body: JSON.stringify({ values: [{ id: 2 }] }) },
  ]);
  const client = new BitbucketClient("dev@example.com", "token", fake.transport);

  const pullRequests = await client.listPullRequests(repository, ["OPEN"], true, "-updated_on");
  assert.deepEqual(pullRequests.map(({ id }) => id), [1, 2]);
  assert.equal(fake.calls.length, 2);

  const unsafe = fakeTransport([
    {
      statusCode: 200,
      body: JSON.stringify({ values: [], next: "https://example.com/steal-token" }),
    },
  ]);
  const unsafeClient = new BitbucketClient("dev@example.com", "token", unsafe.transport);
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
          { status: "added", new: { path: "src/new.ts" } },
          { status: "removed", old: { path: "src/old.ts" } },
        ],
      }),
    },
  ]);
  const client = new BitbucketClient("dev@example.com", "token", fake.transport);

  assert.deepEqual(await client.getChangedFiles(repository, 42), [
    { path: "src/new.ts", status: "added" },
    { path: "src/old.ts", status: "removed" },
  ]);
});

test("creates Markdown comments and threaded replies", async () => {
  const fake = fakeTransport([
    { statusCode: 201, body: JSON.stringify({ id: 10 }) },
    { statusCode: 201, body: JSON.stringify({ id: 11 }) },
  ]);
  const client = new BitbucketClient("dev@example.com", "token", fake.transport);

  await client.createComment(repository, 42, "**Please update this section.**");
  await client.createComment(repository, 42, "I pushed the fix.", 10);

  assert.deepEqual(JSON.parse(fake.calls[0].body), {
    content: { raw: "**Please update this section.**" },
  });
  assert.deepEqual(JSON.parse(fake.calls[1].body), {
    content: { raw: "I pushed the fix." },
    parent: { id: 10 },
  });
});

test("approves and merges through the supported PR endpoints", async () => {
  const fake = fakeTransport([
    { statusCode: 200, body: "" },
    { statusCode: 200, body: JSON.stringify({ state: "MERGED" }) },
  ]);
  const client = new BitbucketClient("dev@example.com", "token", fake.transport);

  await client.approve(repository, 42);
  await client.merge(repository, 42, "squash", true);

  assert.equal(new URL(fake.calls[0].url).pathname, "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/approve");
  assert.equal(fake.calls[0].method, "POST");
  assert.equal(new URL(fake.calls[1].url).pathname, "/2.0/repositories/iptvplatform/iptv-dashboard/pullrequests/42/merge");
  assert.deepEqual(JSON.parse(fake.calls[1].body), {
    merge_strategy: "squash",
    close_source_branch: true,
  });
});

test("surfaces API errors and invalid JSON responses", async () => {
  const failed = fakeTransport([
    { statusCode: 403, body: JSON.stringify({ error: { message: "Permission denied." } }) },
  ]);
  const failedClient = new BitbucketClient("dev@example.com", "token", failed.transport);
  await assert.rejects(
    failedClient.listPullRequests(repository, ["OPEN"], true, "-updated_on"),
    /HTTP 403: Permission denied/,
  );

  const invalid = fakeTransport([{ statusCode: 200, body: "not-json" }]);
  const invalidClient = new BitbucketClient("dev@example.com", "token", invalid.transport);
  await assert.rejects(
    invalidClient.listPullRequests(repository, ["OPEN"], true, "-updated_on"),
    /returned invalid JSON/,
  );
});
