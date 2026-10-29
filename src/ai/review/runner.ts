import * as vscode from "vscode";
import type {BitbucketClient, ComparisonContext} from "../../bitbucket/client";
import type {BitbucketRepository, ChangedFile, PullRequest} from "../../bitbucket/types";
import type {CommentImprover} from "../service";
import type {ImprovePrompt} from "../prompt";
import {createBatches, type DiffChunk} from "./batch";
import {
    buildFileDiff,
    DEFAULT_REVIEW_EXCLUDES,
    type FileDiff,
    isExcludedPath,
    looksBinary,
} from "./diff";
import {
    type BatchReviewOutput,
    extractJsonObject,
    meetsThreshold,
    normalizeBatchResult,
    normalizeSynthesis,
    reconcileVerdict,
    sortFindings,
    type SynthesisOutput,
} from "./parse";
import {
    buildJsonRepairPrompt,
    buildReviewBatchPrompt,
    buildReviewSynthesisPrompt,
    resolveReviewLanguage,
} from "./prompt";
import {
    buildRuleFileTemplate,
    GLOBAL_RULES_TEMPLATE,
    limitRules,
    MAX_TOTAL_RULE_CHARS,
    parseRuleFile,
    sanitizeRuleFileName,
    selectRules,
} from "./rules";
import {
    type AiReviewFinding,
    type AiReviewResult,
    type AppliedRule,
    type FindingStatus,
    type PullRequestContext,
    REVIEW_FOCUS_AREAS,
    REVIEW_SEVERITIES,
    type ReviewFocus,
    type ReviewRule,
    type ReviewSeverity,
} from "./types";

const CONFIG_SECTION = "diffspark.ai.review";
const STATE_KEY_PREFIX = "diffspark.aiReview:";
const RULES_FOLDER = "review-rules";
const FETCH_CONCURRENCY = 4;
const AI_CONCURRENCY = 2;
const MAX_BATCH_DIFF_CHARS = 60_000;
const MIN_BATCH_DIFF_CHARS = 8_000;
const PROMPT_OVERHEAD_CHARS = 6_000;
const MAX_INSTRUCTION_DEPTH = 4;
const REVIEW_TEMPERATURE = 0.1;
const JUSTIFICATION =
    "DiffSpark uses Copilot to review the pull request changes for you.";

export interface AiReviewState {
    running: boolean;
    progress?: string;
    error?: string;
    result?: AiReviewResult;
}

export interface AiReviewTarget {
    repository: BitbucketRepository;
    pullRequest: PullRequest;
    /** Local repository root used to read repository instructions. */
    rootUri?: vscode.Uri;
}

export function aiReviewKey(
    repository: Pick<BitbucketRepository, "fullName">,
    pullRequestId: number,
): string {
    return `${repository.fullName}#${pullRequestId}`;
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const run = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, run));
    return results;
}

export class AiReviewer implements vscode.Disposable {
    private readonly states = new Map<string, AiReviewState>();
    private readonly running = new Map<string, vscode.CancellationTokenSource>();
    private readonly changeEmitter = new vscode.EventEmitter<string>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly improver: CommentImprover,
        private readonly getClient: () => BitbucketClient,
        private readonly log: (message: string) => void,
    ) {}

    dispose(): void {
        for (const source of this.running.values()) {
            source.cancel();
        }
        this.changeEmitter.dispose();
    }

    getState(key: string): AiReviewState {
        const state = this.states.get(key);
        if (state) {
            return state;
        }
        const cached = this.context.workspaceState?.get<AiReviewResult>(
            STATE_KEY_PREFIX + key,
        );
        return cached ? {running: false, result: cached} : {running: false};
    }

    getResult(key: string): AiReviewResult | undefined {
        return this.getState(key).result;
    }

    isRunning(key: string): boolean {
        return this.running.has(key);
    }

    cancel(key: string): void {
        this.running.get(key)?.cancel();
    }

    async clear(key: string): Promise<void> {
        this.states.delete(key);
        await this.context.workspaceState?.update(STATE_KEY_PREFIX + key, undefined);
        this.changeEmitter.fire(key);
    }

    async updateFindingStatus(
        key: string,
        ids: readonly string[],
        status: FindingStatus,
    ): Promise<void> {
        const result = this.getResult(key);
        if (!result || ids.length === 0) {
            return;
        }
        const targets = new Set(ids);
        const updated: AiReviewResult = {
            ...result,
            findings: result.findings.map((finding) =>
                targets.has(finding.id) ? {...finding, status} : finding,
            ),
        };
        await this.saveResult(key, updated);
    }

    private setState(key: string, state: AiReviewState): void {
        this.states.set(key, state);
        this.changeEmitter.fire(key);
    }

    private async saveResult(key: string, result: AiReviewResult): Promise<void> {
        this.setState(key, {running: false, result});
        await this.context.workspaceState?.update(STATE_KEY_PREFIX + key, result);
    }

    async review(target: AiReviewTarget): Promise<AiReviewResult | undefined> {
        const key = aiReviewKey(target.repository, target.pullRequest.id);
        if (this.running.has(key)) {
            void vscode.window.showInformationMessage(
                `DiffSpark: The AI is already reviewing PR #${target.pullRequest.id}.`,
            );
            return undefined;
        }
        const source = new vscode.CancellationTokenSource();
        this.running.set(key, source);
        const previous = this.getResult(key);
        const report = (progress: string): void =>
            this.setState(key, {running: true, progress, result: previous});
        report("Preparing the review…");
        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `DiffSpark: AI review of PR #${target.pullRequest.id}`,
                    cancellable: true,
                },
                async (progress, notificationToken) => {
                    const subscription = notificationToken.onCancellationRequested(() =>
                        source.cancel(),
                    );
                    try {
                        return await this.runReview(target, source.token, (message) => {
                            progress.report({message});
                            report(message);
                        });
                    } finally {
                        subscription.dispose();
                    }
                },
            );
            if (!result) {
                this.setState(key, {running: false, result: previous});
                return undefined;
            }
            await this.saveResult(key, result);
            return result;
        } catch (error) {
            if (
                error instanceof vscode.CancellationError ||
                source.token.isCancellationRequested
            ) {
                this.setState(key, {running: false, result: previous});
                return undefined;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.setState(key, {running: false, error: message, result: previous});
            throw error;
        } finally {
            this.running.delete(key);
            source.dispose();
        }
    }

    private async runReview(
        target: AiReviewTarget,
        token: vscode.CancellationToken,
        report: (message: string) => void,
    ): Promise<AiReviewResult | undefined> {
        const {repository, pullRequest} = target;
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const throwIfCancelled = (): void => {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
        };

        report("Loading changed files…");
        const client = this.getClient();
        const [changedFiles, comparison] = await Promise.all([
            client.getChangedFiles(repository, pullRequest.id),
            client.getComparisonContext(repository, pullRequest.id),
        ]);
        throwIfCancelled();

        const excludes = [
            ...DEFAULT_REVIEW_EXCLUDES,
            ...stringList(configuration.get("exclude")),
        ];
        const filesSkipped: string[] = [];
        let eligible = changedFiles.filter((file) => {
            const path = file.newPath ?? file.path;
            if (isExcludedPath(path, excludes)) {
                filesSkipped.push(path);
                return false;
            }
            return true;
        });
        if (eligible.length === 0) {
            throw new Error(
                "There are no reviewable files in this pull request (all changed files are excluded).",
            );
        }
        const maxFiles = positiveInteger(configuration.get("maxFiles"), 60);
        if (eligible.length > maxFiles) {
            const reviewSome = `Review first ${maxFiles}`;
            const reviewAll = `Review all ${eligible.length}`;
            const choice = await vscode.window.showWarningMessage(
                `PR #${pullRequest.id} changes ${eligible.length} reviewable files. Reviewing all of them may take a while and use many AI requests.`,
                {modal: true},
                reviewSome,
                reviewAll,
            );
            if (!choice) {
                return undefined;
            }
            if (choice === reviewSome) {
                filesSkipped.push(
                    ...eligible.slice(maxFiles).map((file) => file.newPath ?? file.path),
                );
                eligible = eligible.slice(0, maxFiles);
            }
        }

        let fetched = 0;
        report(`Fetching ${eligible.length} files…`);
        const diffs = (
            await mapWithConcurrency(eligible, FETCH_CONCURRENCY, async (file) => {
                throwIfCancelled();
                const diff = await this.fetchFileDiff(
                    repository,
                    pullRequest.id,
                    file,
                    comparison,
                );
                fetched++;
                report(`Fetching files (${fetched}/${eligible.length})…`);
                if (!diff) {
                    filesSkipped.push(file.newPath ?? file.path);
                }
                return diff;
            })
        ).filter((diff): diff is FileDiff => Boolean(diff && diff.hunks.length > 0));
        throwIfCancelled();
        if (diffs.length === 0) {
            throw new Error("There are no text changes to review in this pull request.");
        }

        const rules = await this.loadRules(target.rootUri);
        const allRules = limitRules(rules);
        for (const dropped of allRules.dropped) {
            this.log(
                `AI review: rules "${dropped.source}" were skipped because the rules exceed ${MAX_TOTAL_RULE_CHARS} characters.`,
            );
        }
        const ruleChars = allRules.rules.reduce(
            (total, rule) => total + rule.content.length,
            0,
        );
        const budget = await this.improver.getInputCharBudget();
        const maxDiffChars = Math.max(
            MIN_BATCH_DIFF_CHARS,
            Math.min(MAX_BATCH_DIFF_CHARS, budget - ruleChars - PROMPT_OVERHEAD_CHARS),
        );
        const batches = createBatches(diffs, maxDiffChars);
        const language = resolveReviewLanguage(
            configuration.get<string>("language"),
            vscode.env.language,
        );
        const focus = stringList(configuration.get("focus")).filter(
            (item): item is ReviewFocus =>
                (REVIEW_FOCUS_AREAS as readonly string[]).includes(item),
        );
        const pullRequestContext: PullRequestContext = {
            title: pullRequest.title,
            description: pullRequest.description,
            sourceBranch: pullRequest.source.branch.name,
            destinationBranch: pullRequest.destination.branch.name,
        };
        const filesByPath = new Map(diffs.map((diff) => [diff.path, diff]));
        const allPaths = diffs.map((diff) => diff.path);
        const usedRules = new Map<string, AppliedRule>();
        let completed = 0;
        const describeProgress = (): string =>
            batches.length > 1
                ? `Analyzing changes (${completed}/${batches.length} parts, ${diffs.length} files)…`
                : `Analyzing ${diffs.length} files…`;
        report(describeProgress());

        const outcomes = await mapWithConcurrency(
            batches,
            AI_CONCURRENCY,
            async (chunks, index) => {
                throwIfCancelled();
                const batchPaths = [...new Set(chunks.map((chunk) => chunk.file.path))];
                const batchRules = limitRules(
                    selectRules(allRules.rules, batchPaths),
                ).rules;
                for (const rule of batchRules) {
                    usedRules.set(rule.source, {
                        source: rule.source,
                        description: rule.description,
                        truncated: rule.truncated,
                    });
                }
                try {
                    const output = await this.reviewBatch(
                        chunks,
                        {
                            pullRequest: pullRequestContext,
                            rules: batchRules,
                            language,
                            focus,
                            batch: {index: index + 1, count: batches.length},
                            otherFiles: allPaths.filter(
                                (path) => !batchPaths.includes(path),
                            ),
                            files: filesByPath,
                            idPrefix: `b${index + 1}`,
                        },
                        token,
                    );
                    return {output, paths: batchPaths};
                } catch (error) {
                    if (
                        error instanceof vscode.CancellationError ||
                        token.isCancellationRequested
                    ) {
                        throw new vscode.CancellationError();
                    }
                    this.log(
                        `AI review: part ${index + 1}/${batches.length} failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return {error, paths: batchPaths};
                } finally {
                    completed++;
                    report(describeProgress());
                }
            },
        );
        throwIfCancelled();

        const succeeded = outcomes.filter(
            (outcome): outcome is {output: BatchReviewOutput; paths: string[]} =>
                "output" in outcome && Boolean(outcome.output),
        );
        if (succeeded.length === 0) {
            const failure = outcomes.find((outcome) => "error" in outcome) as
                | {error: unknown}
                | undefined;
            throw failure?.error instanceof Error
                ? failure.error
                : new Error("The AI review failed.");
        }
        const failedPaths = outcomes
            .filter((outcome) => !("output" in outcome && outcome.output))
            .flatMap((outcome) => outcome.paths);
        filesSkipped.push(...failedPaths);
        const reviewedPaths = [...new Set(succeeded.flatMap((outcome) => outcome.paths))];

        let findings = succeeded.flatMap((outcome) => outcome.output.findings);
        const rejected = succeeded.reduce(
            (total, outcome) => total + outcome.output.rejected,
            0,
        );
        if (rejected > 0) {
            this.log(
                `AI review: ${rejected} findings were ignored because they did not reference a changed file.`,
            );
        }

        let synthesis: SynthesisOutput | undefined;
        if (succeeded.length > 1) {
            report("Consolidating the review…");
            try {
                synthesis = await this.synthesize(
                    pullRequestContext,
                    succeeded.map((outcome) => outcome.output),
                    findings,
                    language,
                    reviewedPaths.length,
                    token,
                );
            } catch (error) {
                if (
                    error instanceof vscode.CancellationError ||
                    token.isCancellationRequested
                ) {
                    throw new vscode.CancellationError();
                }
                this.log(
                    `AI review: consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        if (synthesis?.duplicates.length) {
            const duplicates = new Set(synthesis.duplicates);
            findings = findings.filter((finding) => !duplicates.has(finding.id));
        }

        const minSeverity = severitySetting(configuration.get("minSeverity"));
        const minConfidence = confidenceSetting(configuration.get("minConfidence"));
        const visible = sortFindings(
            findings.filter((finding) =>
                meetsThreshold(finding, {minSeverity, minConfidence}),
            ),
        );
        if (visible.length < findings.length) {
            this.log(
                `AI review: ${findings.length - visible.length} findings were hidden by the minSeverity/minConfidence settings.`,
            );
        }
        const modelVerdict =
            synthesis?.verdict ??
            (succeeded.length === 1 ? succeeded[0].output.verdict : undefined);
        const summary =
            synthesis?.summary ||
            succeeded
                .map((outcome) => outcome.output.summary)
                .filter(Boolean)
                .join("\n\n") ||
            (visible.length === 0
                ? "No relevant problems were found in the changes."
                : "");

        return {
            verdict: reconcileVerdict(modelVerdict, visible),
            summary,
            findings: visible,
            sourceCommit: comparison.sourceHash,
            createdAt: new Date().toISOString(),
            provider: this.improver.getModelLabel(),
            filesReviewed: reviewedPaths,
            filesSkipped: [...new Set(filesSkipped)],
            rules: [...usedRules.values()],
            language,
        };
    }

    private async fetchFileDiff(
        repository: BitbucketRepository,
        pullRequestId: number,
        file: ChangedFile,
        comparison: ComparisonContext,
    ): Promise<FileDiff | undefined> {
        const path = file.newPath ?? file.path;
        try {
            const {before, after} = await this.getClient().getFileComparison(
                repository,
                pullRequestId,
                file,
                comparison,
            );
            if (looksBinary(before) || looksBinary(after)) {
                return undefined;
            }
            return buildFileDiff({
                path,
                oldPath: file.oldPath,
                status: file.status,
                before,
                after,
            });
        } catch (error) {
            this.log(
                `AI review: could not load ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
        }
    }

    private async completeJson(
        prompt: ImprovePrompt,
        token: vscode.CancellationToken,
    ): Promise<Record<string, unknown>> {
        const raw = await this.improver.complete(
            prompt,
            {json: true, temperature: REVIEW_TEMPERATURE, justification: JUSTIFICATION},
            token,
        );
        try {
            return extractJsonObject(raw);
        } catch {
            this.log(
                "AI review: the AI answer was not valid JSON, asking it to fix the answer.",
            );
            const repaired = await this.improver.complete(
                buildJsonRepairPrompt(prompt, raw),
                {json: true, temperature: 0, justification: JUSTIFICATION},
                token,
            );
            return extractJsonObject(repaired);
        }
    }

    private async reviewBatch(
        chunks: readonly DiffChunk[],
        options: Omit<Parameters<typeof buildReviewBatchPrompt>[0], "chunks"> & {
            files: ReadonlyMap<string, FileDiff>;
            idPrefix: string;
        },
        token: vscode.CancellationToken,
    ): Promise<BatchReviewOutput> {
        const prompt = buildReviewBatchPrompt({...options, chunks});
        const raw = await this.completeJson(prompt, token);
        return normalizeBatchResult(raw, {
            files: options.files,
            idPrefix: options.idPrefix,
        });
    }

    private async synthesize(
        pullRequest: PullRequestContext,
        outputs: readonly BatchReviewOutput[],
        findings: readonly AiReviewFinding[],
        language: string,
        filesReviewed: number,
        token: vscode.CancellationToken,
    ): Promise<SynthesisOutput> {
        const prompt = buildReviewSynthesisPrompt({
            pullRequest,
            batchSummaries: outputs.map((output) => output.summary).filter(Boolean),
            findings,
            language,
            filesReviewed,
        });
        return normalizeSynthesis(await this.completeJson(prompt, token));
    }

    get globalRulesUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, RULES_FOLDER);
    }

    async loadRules(rootUri?: vscode.Uri): Promise<ReviewRule[]> {
        const rules: ReviewRule[] = [];
        for (const [uri, name] of await listMarkdownFiles(this.globalRulesUri, 1)) {
            const rule = await readRule(uri, `global/${name}`);
            if (rule) {
                rules.push(rule);
            }
        }
        if (
            rootUri &&
            vscode.workspace
                .getConfiguration(CONFIG_SECTION)
                .get<boolean>("useRepositoryInstructions", true) !== false
        ) {
            for (const path of ["AGENTS.md", ".github/copilot-instructions.md"]) {
                const rule = await readRule(
                    vscode.Uri.joinPath(rootUri, ...path.split("/")),
                    `repo/${path}`,
                    true,
                );
                if (rule) {
                    rules.push(rule);
                }
            }
            const instructions = vscode.Uri.joinPath(rootUri, ".github", "instructions");
            for (const [uri, name] of await listMarkdownFiles(
                instructions,
                MAX_INSTRUCTION_DEPTH,
                ".instructions.md",
            )) {
                const rule = await readRule(uri, `repo/.github/instructions/${name}`);
                if (rule) {
                    rules.push(rule);
                }
            }
        }
        return rules;
    }

    /** Quick pick to manage the global review rules. */
    async editRules(rootUri?: vscode.Uri): Promise<void> {
        const folder = this.globalRulesUri;
        await vscode.workspace.fs.createDirectory(folder);
        const existing = await listMarkdownFiles(folder, 1);
        type Item = vscode.QuickPickItem & {run: () => Promise<void>};
        const openFile = async (uri: vscode.Uri): Promise<void> => {
            await vscode.window.showTextDocument(uri, {preview: false});
        };
        const items: Item[] = [];
        if (!existing.some(([, name]) => name === "general.md")) {
            items.push({
                label: "$(add) Create general rules",
                detail: "Rules applied to every pull request you review with AI (general.md).",
                run: async () => {
                    const uri = vscode.Uri.joinPath(folder, "general.md");
                    await vscode.workspace.fs.writeFile(
                        uri,
                        Buffer.from(GLOBAL_RULES_TEMPLATE, "utf8"),
                    );
                    await openFile(uri);
                },
            });
        }
        for (const [uri, name] of existing) {
            const rule = await readRule(uri, name);
            items.push({
                label: `$(file) ${name}`,
                description: rule?.applyTo.length
                    ? `applies to ${rule.applyTo.join(", ")}`
                    : "applies to all files",
                detail: rule?.description,
                run: () => openFile(uri),
            });
        }
        items.push(
            {
                label: "$(new-file) New scoped rules file…",
                detail: "Rules that only apply to files matching a glob, e.g. **/*.{ts,tsx} or src/api/**",
                run: async () => {
                    const name = await vscode.window.showInputBox({
                        title: "DiffSpark: New review rules file",
                        prompt: "File name",
                        placeHolder: "typescript",
                        ignoreFocusOut: true,
                        validateInput: (value) =>
                            sanitizeRuleFileName(value)
                                ? undefined
                                : "Enter a valid file name.",
                    });
                    const fileName =
                        name === undefined ? undefined : sanitizeRuleFileName(name);
                    if (!fileName) {
                        return;
                    }
                    const applyTo = await vscode.window.showInputBox({
                        title: "DiffSpark: New review rules file",
                        prompt: "Glob(s) of the files these rules apply to (comma separated). Leave empty for all files.",
                        placeHolder: "**/*.{ts,tsx}",
                        ignoreFocusOut: true,
                    });
                    if (applyTo === undefined) {
                        return;
                    }
                    const uri = vscode.Uri.joinPath(folder, fileName);
                    if (!(await exists(uri))) {
                        await vscode.workspace.fs.writeFile(
                            uri,
                            Buffer.from(
                                buildRuleFileTemplate({
                                    applyTo,
                                    description: `${fileName.replace(/\.md$/, "")} review rules`,
                                }),
                                "utf8",
                            ),
                        );
                    }
                    await openFile(uri);
                },
            },
            {
                label: "$(folder-opened) Open rules folder",
                detail: folder.fsPath,
                run: async () => {
                    await vscode.commands.executeCommand("revealFileInOS", folder);
                },
            },
        );
        if (rootUri) {
            const repoRules = (await this.loadRules(rootUri)).filter((rule) =>
                rule.source.startsWith("repo/"),
            );
            for (const rule of repoRules) {
                const relative = rule.source.slice("repo/".length);
                items.push({
                    label: `$(repo) ${relative}`,
                    description: "repository instructions",
                    detail: rule.applyTo.length
                        ? `applies to ${rule.applyTo.join(", ")}`
                        : "applies to all files",
                    run: () =>
                        openFile(vscode.Uri.joinPath(rootUri, ...relative.split("/"))),
                });
            }
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: "DiffSpark: AI review rules",
            placeHolder:
                "Rules tell the AI reviewer what to focus on. Markdown files with optional applyTo frontmatter.",
            matchOnDetail: true,
        });
        await picked?.run();
    }
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter(
              (item): item is string => typeof item === "string" && item.trim() !== "",
          )
        : [];
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}

function severitySetting(value: unknown): ReviewSeverity {
    return typeof value === "string" &&
        (REVIEW_SEVERITIES as readonly string[]).includes(value)
        ? (value as ReviewSeverity)
        : "minor";
}

function confidenceSetting(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0.5;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readRule(
    uri: vscode.Uri,
    source: string,
    alwaysApply = false,
): Promise<ReviewRule | undefined> {
    try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
            "utf8",
        );
        const rule = parseRuleFile(text, source);
        if (!rule.content.trim()) {
            return undefined;
        }
        return alwaysApply ? {...rule, applyTo: []} : rule;
    } catch {
        return undefined;
    }
}

/** Lists Markdown files below `folder`, returning [uri, relative path] sorted by path. */
async function listMarkdownFiles(
    folder: vscode.Uri,
    depth: number,
    suffix = ".md",
): Promise<[vscode.Uri, string][]> {
    const files: [vscode.Uri, string][] = [];
    const walk = async (
        uri: vscode.Uri,
        prefix: string,
        level: number,
    ): Promise<void> => {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(uri);
        } catch {
            return;
        }
        for (const [name, type] of entries) {
            if (name.startsWith(".")) {
                continue;
            }
            const child = vscode.Uri.joinPath(uri, name);
            if (type & vscode.FileType.Directory) {
                if (level < depth) {
                    await walk(child, `${prefix}${name}/`, level + 1);
                }
            } else if (name.toLowerCase().endsWith(suffix)) {
                files.push([child, `${prefix}${name}`]);
            }
        }
    };
    await walk(folder, "", 1);
    return files.sort((a, b) => a[1].localeCompare(b[1]));
}
