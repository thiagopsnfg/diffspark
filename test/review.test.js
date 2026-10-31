const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const {
    buildFileDiff,
    commentableLines,
    addedLineNumbers,
    formatFileDiff,
    isExcludedPath,
    looksBinary,
    DEFAULT_REVIEW_EXCLUDES,
} = require("../dist/ai/review/diff");
const {createBatches, splitFileDiff} = require("../dist/ai/review/batch");
const {
    parseRuleFile,
    selectRules,
    limitRules,
    splitGlobList,
    sanitizeRuleFileName,
    buildRuleFileTemplate,
} = require("../dist/ai/review/rules");
const {
    extractJsonObject,
    normalizeBatchResult,
    normalizeSynthesis,
    meetsThreshold,
    reconcileVerdict,
    formatFindingComment,
    formatSummaryComment,
    sortFindings,
} = require("../dist/ai/review/parse");
const {
    buildReviewBatchPrompt,
    buildReviewSynthesisPrompt,
    buildJsonRepairPrompt,
    resolveReviewLanguage,
} = require("../dist/ai/review/prompt");
const {requestOpenAi, requestGemini} = require("../dist/ai/providers");

const before = [
    "function sum(a, b) {",
    "  return a + b;",
    "}",
    "",
    "module.exports = { sum };",
    "",
].join("\n");
const after = [
    "function sum(a, b) {",
    "  console.log(a, b);",
    "  return a + b;",
    "}",
    "",
    "function div(a, b) {",
    "  return a / b;",
    "}",
    "",
    "module.exports = { sum, div };",
    "",
].join("\n");

const pullRequest = {
    title: "Add div",
    description: "Adds a div helper",
    sourceBranch: "feature/div",
    destinationBranch: "main",
};

test("builds diffs with new-file line numbers and commentable lines", () => {
    const diff = buildFileDiff({path: "src/math.js", before, after});
    assert.equal(diff.addedLines, 6);
    assert.equal(diff.removedLines, 1);
    assert.deepEqual(addedLineNumbers(diff), [2, 6, 7, 8, 9, 10]);
    const commentable = commentableLines(diff);
    assert.ok(commentable.has(1) && commentable.has(10));
    assert.equal(commentable.has(42), false);
    const text = formatFileDiff(diff);
    assert.match(text, /^### File: src\/math\.js \(modified\)/);
    assert.match(text, / 2 \+ {3}console\.log\(a, b\);/);
    assert.match(text, /\s+- module\.exports = \{ sum \};/);

    const renamed = buildFileDiff({
        path: "src/new.js",
        oldPath: "src/old.js",
        status: "renamed",
        before,
        after: before,
    });
    assert.equal(renamed.hunks.length, 0);
    assert.match(
        formatFileDiff(renamed),
        /renamed from src\/old\.js[\s\S]*no textual changes/,
    );
});

test("filters generated, lock and binary files", () => {
    for (const file of [
        "package-lock.json",
        "web/yarn.lock",
        "dist/app.js",
        "assets/logo.png",
        "app.min.js",
        "src/__snapshots__/a.snap",
    ]) {
        assert.equal(isExcludedPath(file, DEFAULT_REVIEW_EXCLUDES), true, file);
    }
    assert.equal(isExcludedPath("src/app.ts", DEFAULT_REVIEW_EXCLUDES), false);
    assert.equal(isExcludedPath("src/generated/api.ts", ["**/generated/**"]), true);
    assert.equal(isExcludedPath("deep/folder/schema.graphql", ["*.graphql"]), true);
    assert.equal(looksBinary("abc\u0000def"), true);
    assert.equal(looksBinary("plain text"), false);
});

test("parses rule files with applyTo frontmatter in several formats", () => {
    const typescript = parseRuleFile(
        [
            "---",
            "# comment line",
            'applyTo: "**/*.{ts,tsx}, src/api/**"',
            "description: TypeScript rules",
            "---",
            "# TypeScript",
            "- Never use `any`.",
        ].join("\n"),
        "global/typescript.md",
    );
    assert.deepEqual(typescript.applyTo, ["**/*.{ts,tsx}", "src/api/**"]);
    assert.equal(typescript.description, "TypeScript rules");
    assert.match(typescript.content, /^# TypeScript\n- Never use `any`\.$/);

    const list = parseRuleFile(
        '---\napplyTo:\n  - "**/*.sql"\n  - migrations/**\n---\nUse transactions.',
        "repo/sql.instructions.md",
    );
    assert.deepEqual(list.applyTo, ["**/*.sql", "migrations/**"]);
    assert.deepEqual(
        parseRuleFile("---\napplyTo: ['**/*.py', '**/*.pyi']\n---\nx", "a").applyTo,
        ["**/*.py", "**/*.pyi"],
    );
    assert.deepEqual(parseRuleFile('---\napplyTo: "**"\n---\nAll', "a").applyTo, []);
    const plain = parseRuleFile(
        "\uFEFF# Guidelines\r\n- Avoid console.log",
        "global/general.md",
    );
    assert.deepEqual(plain.applyTo, []);
    assert.equal(plain.content, "# Guidelines\n- Avoid console.log");
    assert.deepEqual(splitGlobList("a/**, {b,c}/*.ts , 'd'"), [
        "a/**",
        "{b,c}/*.ts",
        "d",
    ]);
});

test("selects rules by the files in a batch and enforces size limits", () => {
    const rules = [
        parseRuleFile("General", "global/general.md"),
        parseRuleFile('---\napplyTo: "**/*.{ts,tsx}"\n---\nTS', "global/ts.md"),
        parseRuleFile('---\napplyTo: "**/*.py"\n---\nPY', "global/py.md"),
        parseRuleFile('---\napplyTo: "**/*.py"\n---\n', "global/empty.md"),
    ];
    assert.deepEqual(
        selectRules(rules, ["src/App.tsx"]).map((rule) => rule.source),
        ["global/general.md", "global/ts.md"],
    );
    assert.deepEqual(
        selectRules(rules, ["tool.py"]).map((rule) => rule.source),
        ["global/general.md", "global/py.md"],
    );

    const big = [
        {source: "a", applyTo: [], content: "x".repeat(500)},
        {source: "b", applyTo: [], content: "y".repeat(500)},
        {source: "c", applyTo: [], content: "z".repeat(500)},
    ];
    const limited = limitRules(big, {maxRuleChars: 400, maxTotalChars: 900});
    assert.deepEqual(
        limited.rules.map((rule) => rule.source),
        ["a", "b"],
    );
    assert.equal(limited.rules[0].truncated, true);
    assert.match(limited.rules[0].content, /…\[truncated\]$/);
    assert.deepEqual(
        limited.dropped.map((rule) => rule.source),
        ["c"],
    );
});

test("creates safe rule file names and templates", () => {
    assert.equal(sanitizeRuleFileName("React rules"), "React-rules.md");
    assert.equal(sanitizeRuleFileName("typescript.md"), "typescript.md");
    assert.equal(sanitizeRuleFileName("../../etc/passwd"), "etc-passwd.md");
    assert.equal(sanitizeRuleFileName("  "), undefined);
    const template = buildRuleFileTemplate({applyTo: "**/*.{ts,tsx}", description: "TS"});
    const parsed = parseRuleFile(template, "global/ts.md");
    assert.deepEqual(parsed.applyTo, ["**/*.{ts,tsx}"]);
    assert.equal(parsed.description, "TS");
});

test("batches diffs under the character budget and splits large files", () => {
    const files = Array.from({length: 6}, (_, index) =>
        buildFileDiff({path: `src/file${index}.js`, before, after}),
    );
    const size = formatFileDiff(files[0]).length;
    const batches = createBatches(files, size * 2 + 10);
    assert.equal(batches.length, 3);
    assert.deepEqual(
        batches.flat().map((chunk) => chunk.file.path),
        files.map((file) => file.path),
    );

    const huge = buildFileDiff({
        path: "src/huge.js",
        before: "",
        after: Array.from(
            {length: 2_000},
            (_, index) => `const value${index} = ${index};`,
        ).join("\n"),
    });
    const parts = splitFileDiff(huge, 5_000);
    assert.ok(parts.length > 5);
    assert.ok(parts.every((chunk) => chunk.text.length <= 5_000));
    assert.match(parts[1].text, /\[part 2\/\d+\]/);
    const lines = parts.flatMap((chunk) =>
        chunk.hunks.flatMap((hunk) => hunk.lines.map((line) => line.newLine)),
    );
    assert.equal(lines.length, 2_000);
    assert.equal(lines.at(-1), 2_000);
});

test("extracts JSON from fenced or chatty answers", () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), {a: 1});
    assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), {a: 2});
    assert.deepEqual(
        extractJsonObject('Sure! Here it is:\n{"a":{"b":3}}\nHope it helps'),
        {a: {b: 3}},
    );
    assert.deepEqual(extractJsonObject('[{"title":"x"}]'), {findings: [{title: "x"}]});
    assert.throws(() => extractJsonObject("no json here"), /valid JSON/);
});

test("normalizes findings: paths, lines, severities and invalid entries", () => {
    const diff = buildFileDiff({path: "src/math.js", before, after});
    const files = new Map([[diff.path, diff]]);
    const result = normalizeBatchResult(
        {
            summary: "Adds div.",
            verdict: "Request Changes",
            findings: [
                {
                    file: "b/src/math.js",
                    line: 7,
                    severity: "critical",
                    category: "correctness",
                    title: "Division by zero",
                    body: "Check b.",
                    suggestion: "```js\nif (b === 0) throw new Error();\n```",
                    confidence: 0.9,
                },
                {
                    file: "math.js",
                    line: "2",
                    severity: "low",
                    category: "style",
                    rule: "No console.log",
                    title: "Remove console.log",
                    body: "Debug output.",
                },
                {
                    file: "src/math.js",
                    line: 300,
                    severity: "nit",
                    category: "design",
                    title: "File remark",
                    body: "",
                    confidence: 4,
                },
                {
                    file: "src/math.js",
                    line: 12,
                    severity: "minor",
                    title: "Near the end",
                    body: "Snaps to the closest added line.",
                },
                {file: "src/other.js", line: 1, title: "Unknown file"},
                {file: "src/math.js", title: "", body: ""},
                "garbage",
            ],
        },
        {files, idPrefix: "b1"},
    );
    assert.equal(result.verdict, "request_changes");
    assert.equal(result.rejected, 3);
    assert.equal(result.findings.length, 4);
    const [division, consoleLog, fileLevel, snapped] = result.findings;
    assert.deepEqual(
        {
            id: division.id,
            file: division.file,
            line: division.line,
            severity: division.severity,
            category: division.category,
            confidence: division.confidence,
        },
        {
            id: "b1-1",
            file: "src/math.js",
            line: 7,
            severity: "blocker",
            category: "bug",
            confidence: 0.9,
        },
    );
    assert.equal(division.suggestion, "if (b === 0) throw new Error();");
    assert.equal(consoleLog.line, 2);
    assert.equal(consoleLog.category, "rule");
    assert.equal(consoleLog.rule, "No console.log");
    assert.equal(consoleLog.severity, "minor");
    assert.equal(consoleLog.confidence, 0.7);
    assert.equal(fileLevel.line, undefined);
    assert.equal(fileLevel.confidence, 1);
    assert.equal(fileLevel.title, "File remark");
    assert.equal(snapped.line, 10);
    assert.ok(result.findings.every((finding) => finding.status === "open"));
});

test("applies thresholds, ordering and verdict reconciliation", () => {
    assert.equal(
        meetsThreshold(
            {severity: "nit", confidence: 1},
            {minSeverity: "minor", minConfidence: 0.5},
        ),
        false,
    );
    assert.equal(
        meetsThreshold(
            {severity: "major", confidence: 0.4},
            {minSeverity: "minor", minConfidence: 0.5},
        ),
        false,
    );
    assert.equal(
        meetsThreshold(
            {severity: "blocker", confidence: 0.5},
            {minSeverity: "major", minConfidence: 0.5},
        ),
        true,
    );
    assert.equal(reconcileVerdict("approve", [{severity: "major"}]), "request_changes");
    assert.equal(
        reconcileVerdict("request_changes", [{severity: "nit"}]),
        "request_changes",
    );
    assert.equal(reconcileVerdict(undefined, [{severity: "minor"}]), "comment");
    assert.equal(reconcileVerdict("approve", []), "approve");
    assert.deepEqual(
        normalizeSynthesis({verdict: "lgtm", summary: " ok ", duplicates: ["b1-2", 3]}),
        {verdict: "approve", summary: "ok", duplicates: ["b1-2"]},
    );
    const sorted = sortFindings([
        {id: "1", file: "b.js", line: 3, severity: "minor"},
        {id: "2", file: "a.js", line: 9, severity: "blocker"},
        {id: "3", file: "a.js", line: 1, severity: "minor"},
    ]);
    assert.deepEqual(
        sorted.map((finding) => finding.id),
        ["2", "3", "1"],
    );
});

test("formats findings and the summary as Bitbucket Markdown", () => {
    const finding = {
        id: "b1-1",
        file: "src/math.ts",
        line: 7,
        severity: "major",
        category: "rule",
        rule: "Early return",
        title: "Use an early return",
        body: "Nested ifs are hard to read.",
        suggestion: "if (!user) return;",
        confidence: 0.8,
        status: "open",
    };
    const markdown = formatFindingComment(finding);
    assert.match(
        markdown,
        /^\*\*Major · Team rule: Early return\*\* — Use an early return/,
    );
    assert.match(markdown, /```ts\nif \(!user\) return;\n```/);
    assert.match(
        formatFindingComment(finding, {includeLocation: true}),
        /`src\/math\.ts:7`/,
    );
    const summary = formatSummaryComment({
        verdict: "request_changes",
        summary: "One problem.",
        findings: [
            finding,
            {...finding, id: "b1-2", title: "Dismissed", status: "dismissed"},
        ],
    });
    assert.match(summary, /^### Changes needed\n\nOne problem\./);
    assert.match(summary, /- \*\*Major\*\* `src\/math\.ts:7` — Use an early return/);
    assert.doesNotMatch(summary, /Dismissed/);
    assert.doesNotMatch(markdown + summary, /\p{Extended_Pictographic}/u);

    const options = {includeHeader: false};
    const plain = formatFindingComment(finding, options);
    assert.equal(plain, "Nested ifs are hard to read.\n\n```ts\nif (!user) return;\n```");
    assert.equal(
        formatFindingComment(finding, {...options, includeLocation: true}),
        "`src/math.ts:7`\n\n" + plain,
    );
    assert.equal(
        formatFindingComment(
            {...finding, body: finding.title, suggestion: undefined},
            options,
        ),
        finding.title,
    );
    assert.equal(
        formatFindingComment({...finding, body: "", suggestion: undefined}, options),
        finding.title,
    );
    assert.equal(
        formatFindingComment(
            {...finding, line: undefined},
            {...options, includeLocation: true},
        ),
        "`src/math.ts`\n\n" + plain,
    );
    assert.equal(
        formatSummaryComment(
            {
                verdict: "request_changes",
                summary: "One problem.",
                findings: [finding, {...finding, status: "dismissed"}],
            },
            options,
        ),
        "One problem.\n\n- `src/math.ts:7` — Use an early return",
    );
    assert.equal(
        formatSummaryComment(
            {verdict: "approve", summary: "All good.", findings: []},
            options,
        ),
        "All good.",
    );
});

test("builds review prompts with team rules, language, focus and untrusted data markers", () => {
    const diff = buildFileDiff({path: "src/math.js", before, after});
    const [batch] = createBatches([diff], 50_000);
    const prompt = buildReviewBatchPrompt({
        pullRequest,
        chunks: batch,
        rules: [
            {
                source: "global/general.md",
                description: "General",
                applyTo: ["**/*.js"],
                content: "- Never leave console.log in production code.",
            },
        ],
        language: "Portuguese (Brazil)",
        focus: ["security", "tests"],
        batch: {index: 2, count: 3},
        otherFiles: ["src/a.js", "src/b.js"],
    });
    assert.match(prompt.system, /Team review rules/);
    assert.match(
        prompt.system,
        /<review_rules source="global\/general\.md"[^>]*applyTo="\*\*\/\*\.js"[^>]*>[\s\S]*Never leave console\.log[\s\S]*<\/review_rules>/,
    );
    assert.match(prompt.system, /Portuguese \(Brazil\)/);
    assert.match(prompt.system, /untrusted data/);
    assert.match(prompt.system, /Do not add emojis/);
    assert.match(prompt.system, /"verdict": "approve" \| "comment" \| "request_changes"/);
    assert.match(prompt.user, /extra attention to: security, tests/);
    assert.match(prompt.user, /part 2 of 3/);
    assert.match(prompt.user, /src\/a\.js\nsrc\/b\.js/);
    assert.match(prompt.user, /<diff>\n### File: src\/math\.js[\s\S]*<\/diff>/);
    assert.match(prompt.user, /Title: Add div/);

    const noRules = buildReviewBatchPrompt({
        pullRequest,
        chunks: batch,
        rules: [],
        language: "English",
        batch: {index: 1, count: 1},
    });
    assert.doesNotMatch(noRules.system, /Team review rules/);
    assert.doesNotMatch(noRules.user, /part 1 of 1/);

    const synthesis = buildReviewSynthesisPrompt({
        pullRequest,
        batchSummaries: ["Part one", "Part two"],
        findings: [
            {
                id: "b1-1",
                file: "src/math.js",
                line: 7,
                severity: "major",
                category: "bug",
                title: "Division by zero",
            },
        ],
        language: "English",
        filesReviewed: 4,
    });
    assert.match(
        synthesis.user,
        /\[b1-1\] major\/bug src\/math\.js:7 — Division by zero/,
    );
    assert.match(synthesis.system, /duplicates/);
    assert.match(synthesis.system, /Do not add emojis/);
    assert.match(buildJsonRepairPrompt(prompt, "oops").user, /not valid JSON[\s\S]*oops/);
});

test("resolves the review language from the setting or the VS Code locale", () => {
    assert.equal(resolveReviewLanguage("", "pt-br"), "Portuguese (Brazil)");
    assert.equal(resolveReviewLanguage(undefined, "fr-ca"), "French");
    assert.equal(resolveReviewLanguage("  Klingon ", "en"), "Klingon");
    assert.equal(resolveReviewLanguage("es", "en"), "Spanish");
    assert.equal(resolveReviewLanguage(undefined, undefined), "English");
});

function fetchSequence(responses) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({url, body: JSON.parse(init.body)});
            const [status, body] =
                responses[Math.min(calls.length - 1, responses.length - 1)];
            return {
                ok: status >= 200 && status < 300,
                status,
                text: async () => JSON.stringify(body),
            };
        },
    };
}

test("requests JSON output from OpenAI and retries without response_format when unsupported", async () => {
    const ok = fetchSequence([
        [200, {choices: [{message: {content: '{"findings":[]}'}}]}],
    ]);
    await requestOpenAi(
        {system: "s", user: "u"},
        {apiKey: "k", fetch: ok.fetch, json: true, temperature: 0.1},
    );
    assert.deepEqual(ok.calls[0].body.response_format, {type: "json_object"});
    assert.equal(ok.calls[0].body.temperature, 0.1);

    const fallback = fetchSequence([
        [400, {error: {message: "response_format is not supported by this model"}}],
        [200, {choices: [{message: {content: "{}"}}]}],
    ]);
    assert.equal(
        await requestOpenAi(
            {system: "s", user: "u"},
            {apiKey: "k", fetch: fallback.fetch, json: true},
        ),
        "{}",
    );
    assert.equal(fallback.calls.length, 2);
    assert.equal(fallback.calls[1].body.response_format, undefined);

    const plain = fetchSequence([[200, {choices: [{message: {content: "text"}}]}]]);
    await requestOpenAi({system: "s", user: "u"}, {apiKey: "k", fetch: plain.fetch});
    assert.equal(plain.calls[0].body.response_format, undefined);
    assert.equal(plain.calls[0].body.temperature, 0.3);
});

test("requests JSON output from Gemini", async () => {
    const gemini = fetchSequence([
        [200, {candidates: [{content: {parts: [{text: "{}"}]}}]}],
    ]);
    await requestGemini(
        {system: "s", user: "u"},
        {apiKey: "k", fetch: gemini.fetch, json: true, temperature: 0.1},
    );
    assert.deepEqual(gemini.calls[0].body.generationConfig, {
        temperature: 0.1,
        responseMimeType: "application/json",
    });
});

const distRoot = path.resolve(__dirname, "../dist");

function load(filename, overrides, cache = new Map()) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = new Module(filename);
    cache.set(filename, module);
    const requireFromFile = Module.createRequire(filename);
    module.require = (id) => {
        if (Object.hasOwn(overrides, id)) return overrides[id];
        const resolved = requireFromFile.resolve(id);
        return resolved.startsWith(distRoot + path.sep)
            ? load(resolved, overrides, cache)
            : requireFromFile(id);
    };
    module._compile(fs.readFileSync(filename, "utf8"), filename);
    return module.exports;
}

function runnerHarness(options = {}) {
    const files = new Map(Object.entries(options.files ?? {}));
    const config = {
        minSeverity: "minor",
        minConfidence: 0.5,
        maxFiles: 60,
        useRepositoryInstructions: true,
        language: "",
        ...options.config,
    };
    const state = new Map();
    const prompts = [];
    const logs = [];
    const uri = (value) => ({path: value, fsPath: value, toString: () => value});
    class CancellationError extends Error {}
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({dispose() {}}),
    };
    const vscode = {
        EventEmitter: class {
            constructor() {
                this.listeners = [];
                this.event = (listener) => {
                    this.listeners.push(listener);
                    return {dispose() {}};
                };
            }
            fire(value) {
                this.listeners.forEach((listener) => listener(value));
            }
            dispose() {}
        },
        CancellationTokenSource: class {
            constructor() {
                this.token = {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({dispose() {}}),
                };
            }
            cancel() {
                this.token.isCancellationRequested = true;
            }
            dispose() {}
        },
        CancellationError,
        ProgressLocation: {Notification: 15},
        FileType: {File: 1, Directory: 2},
        env: {language: "pt-br"},
        Uri: {joinPath: (base, ...parts) => uri([base.path, ...parts].join("/"))},
        window: {
            withProgress: async (_options, task) => task({report() {}}, token),
            showWarningMessage: async () => options.maxFilesChoice,
            showInformationMessage() {},
        },
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => (key in config ? config[key] : fallback),
            }),
            fs: {
                readDirectory: async (folder) => {
                    const prefix = folder.path + "/";
                    const entries = new Map();
                    for (const file of files.keys()) {
                        if (file.startsWith(prefix)) {
                            const [name, ...rest] = file.slice(prefix.length).split("/");
                            entries.set(name, rest.length > 0 ? 2 : 1);
                        }
                    }
                    if (entries.size === 0) throw new Error("ENOENT");
                    return [...entries];
                },
                readFile: async (file) => {
                    if (!files.has(file.path)) throw new Error("ENOENT");
                    return Buffer.from(files.get(file.path));
                },
                stat: async (file) => {
                    if (!files.has(file.path)) throw new Error("ENOENT");
                    return {};
                },
            },
        },
    };
    const client = {
        getChangedFiles: async () =>
            options.changedFiles ?? [
                {path: "src/math.js", status: "modified"},
                {path: "package-lock.json", status: "modified"},
                {path: "README.md", status: "modified"},
            ],
        getComparisonContext: async () => ({
            sourceHash: "abc123",
            destinationHash: "def",
            sourceRepository: {},
            getMergeBase: async () => "base",
        }),
        getFileComparison: async (_repo, _id, file) => {
            if (file.path === "README.md")
                return {before: "# Title\n", after: "# Title\n\nMore docs.\n"};
            if (options.comparison) return options.comparison(file);
            return {before, after};
        },
    };
    const improver = {
        getInputCharBudget: async () => options.budget ?? 120_000,
        getModelLabel: () => "Fake model",
        complete: async (prompt, completionOptions) => {
            prompts.push({prompt, options: completionOptions});
            return options.answer ? options.answer(prompt, prompts.length) : "{}";
        },
    };
    const {AiReviewer, aiReviewKey} = load(path.join(distRoot, "ai/review/runner.js"), {
        vscode,
    });
    const context = {
        globalStorageUri: uri("/global"),
        workspaceState: {
            get: (key) => state.get(key),
            update: async (key, value) => {
                state.set(key, value);
            },
        },
    };
    const reviewer = new AiReviewer(
        context,
        improver,
        () => client,
        (message) => logs.push(message),
    );
    const target = {
        repository: {workspace: "team", slug: "repo", fullName: "team/repo"},
        pullRequest: {
            id: 7,
            title: "Add div",
            description: "Adds div",
            source: {branch: {name: "feature"}, commit: {hash: "abc123"}},
            destination: {branch: {name: "main"}},
        },
        rootUri: uri("/repo"),
    };
    return {
        reviewer,
        target,
        prompts,
        logs,
        state,
        key: aiReviewKey(target.repository, 7),
        CancellationError,
    };
}

test("AI reviewer runs the whole pipeline with global rules and repository instructions", async () => {
    const h = runnerHarness({
        files: {
            "/global/review-rules/general.md":
                "---\ndescription: General\n---\n- Never leave console.log in production code.",
            "/global/review-rules/python.md":
                '---\napplyTo: "**/*.py"\n---\n- Use type hints.',
            "/repo/AGENTS.md": "Always validate inputs.",
            "/repo/.github/instructions/js.instructions.md":
                '---\napplyTo: "**/*.js"\n---\nPrefer const.',
            "/repo/.github/instructions/other.md": "Not an instructions file.",
        },
        answer: () =>
            JSON.stringify({
                summary: "Adds a div helper with a console.log left behind.",
                verdict: "comment",
                findings: [
                    {
                        file: "src/math.js",
                        line: 2,
                        severity: "minor",
                        category: "rule",
                        rule: "No console.log",
                        title: "Remove console.log",
                        body: "Debug output.",
                        confidence: 0.9,
                    },
                    {
                        file: "src/math.js",
                        line: 7,
                        severity: "major",
                        category: "bug",
                        title: "Division by zero",
                        body: "Guard b.",
                        confidence: 0.8,
                    },
                    {
                        file: "src/math.js",
                        line: 1,
                        severity: "nit",
                        category: "readability",
                        title: "Nit",
                        body: "Hidden by minSeverity.",
                        confidence: 0.9,
                    },
                    {
                        file: "README.md",
                        line: 3,
                        severity: "minor",
                        category: "design",
                        title: "Low confidence",
                        body: "Hidden.",
                        confidence: 0.2,
                    },
                ],
            }),
    });
    const changes = [];
    h.reviewer.onDidChange((key) => changes.push(key));
    const result = await h.reviewer.review(h.target);

    assert.equal(h.prompts.length, 1);
    const {prompt, options} = h.prompts[0];
    assert.equal(options.json, true);
    assert.match(prompt.system, /Never leave console\.log/);
    assert.match(prompt.system, /Always validate inputs/);
    assert.match(prompt.system, /Prefer const/);
    assert.doesNotMatch(prompt.system, /Use type hints|Not an instructions file/);
    assert.match(prompt.system, /Portuguese \(Brazil\)/);
    assert.doesNotMatch(prompt.user, /package-lock/);

    assert.equal(result.verdict, "request_changes");
    assert.deepEqual(
        result.findings.map((finding) => finding.title),
        ["Division by zero", "Remove console.log"],
    );
    assert.deepEqual(result.filesReviewed.sort(), ["README.md", "src/math.js"]);
    assert.deepEqual(result.filesSkipped, ["package-lock.json"]);
    assert.deepEqual(
        result.rules.map((rule) => rule.source),
        [
            "global/general.md",
            "repo/AGENTS.md",
            "repo/.github/instructions/js.instructions.md",
        ],
    );
    assert.equal(result.sourceCommit, "abc123");
    assert.equal(result.provider, "Fake model");
    assert.ok(h.logs.some((message) => /hidden by the minSeverity/.test(message)));
    assert.ok(changes.every((key) => key === h.key) && changes.length >= 2);

    assert.equal(h.state.get(`diffspark.aiReview:${h.key}`).findings.length, 2);
    await h.reviewer.updateFindingStatus(h.key, [result.findings[0].id], "posted");
    assert.equal(h.reviewer.getResult(h.key).findings[0].status, "posted");
    await h.reviewer.clear(h.key);
    assert.equal(h.reviewer.getResult(h.key), undefined);
});

test("AI reviewer repairs invalid JSON, skips repository instructions when disabled and handles clean PRs", async () => {
    const h = runnerHarness({
        config: {useRepositoryInstructions: false},
        files: {"/repo/AGENTS.md": "Repository rule."},
        answer: (_prompt, call) =>
            call === 1
                ? "I think it looks fine"
                : '{"summary":"Looks good.","verdict":"approve","findings":[]}',
    });
    const result = await h.reviewer.review(h.target);
    assert.equal(h.prompts.length, 2);
    assert.match(h.prompts[1].prompt.user, /not valid JSON/);
    assert.doesNotMatch(h.prompts[0].prompt.system, /Repository rule/);
    assert.equal(result.verdict, "approve");
    assert.equal(result.summary, "Looks good.");
    assert.deepEqual(result.findings, []);
});

test("AI reviewer splits large pull requests into parts and consolidates them", async () => {
    const changedFiles = Array.from({length: 4}, (_, index) => ({
        path: `src/file${index}.js`,
        status: "modified",
    }));
    const h = runnerHarness({
        changedFiles,
        budget: 1_000,
        comparison: () => ({
            before: "",
            after: Array.from(
                {length: 300},
                (_, index) => `export const value${index} = ${index};`,
            ).join("\n"),
        }),
        answer: (prompt) => {
            if (/consolidating/.test(prompt.system)) {
                return JSON.stringify({
                    verdict: "comment",
                    summary: "Overall fine.",
                    duplicates: ["b2-1"],
                });
            }
            const file = /### File: (\S+)/.exec(prompt.user)[1];
            return JSON.stringify({
                summary: `Reviewed ${file}`,
                findings: [
                    {file, line: 7, severity: "minor", title: `Check ${file}`, body: "x"},
                ],
            });
        },
    });
    const result = await h.reviewer.review(h.target);
    const batchPrompts = h.prompts.filter(
        ({prompt}) => !/consolidating/.test(prompt.system),
    );
    assert.ok(batchPrompts.length >= 2);
    assert.equal(h.prompts.length, batchPrompts.length + 1);
    assert.equal(result.summary, "Overall fine.");
    assert.equal(result.verdict, "comment");
    assert.equal(
        result.findings.some((finding) => finding.id === "b2-1"),
        false,
    );
    assert.equal(result.findings.length, batchPrompts.length - 1);
});

test("AI reviewer asks before reviewing many files and can limit the review", async () => {
    const changedFiles = Array.from({length: 5}, (_, index) => ({
        path: `src/file${index}.js`,
        status: "modified",
    }));
    const cancelled = runnerHarness({
        changedFiles,
        config: {maxFiles: 2},
        maxFilesChoice: undefined,
    });
    assert.equal(await cancelled.reviewer.review(cancelled.target), undefined);
    assert.equal(cancelled.prompts.length, 0);

    const limited = runnerHarness({
        changedFiles,
        config: {maxFiles: 2},
        maxFilesChoice: "Review first 2",
    });
    const result = await limited.reviewer.review(limited.target);
    assert.deepEqual(result.filesReviewed.sort(), ["src/file0.js", "src/file1.js"]);
    assert.equal(result.filesSkipped.length, 3);
});

test("AI reviewer reports errors without losing the previous review", async () => {
    const h = runnerHarness({answer: () => '{"summary":"ok","findings":[]}'});
    await h.reviewer.review(h.target);
    const failing = runnerHarness({
        answer: () => {
            throw new Error("quota exceeded");
        },
    });
    failing.state.set(`diffspark.aiReview:${failing.key}`, h.reviewer.getResult(h.key));
    await assert.rejects(failing.reviewer.review(failing.target), /quota exceeded/);
    const state = failing.reviewer.getState(failing.key);
    assert.equal(state.running, false);
    assert.equal(state.error, "quota exceeded");
    assert.equal(state.result.summary, "ok");
});
