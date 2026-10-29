import {addedLineNumbers, commentableLines, type FileDiff} from "./diff";
import {
    type AiReviewFinding,
    type AiReviewResult,
    REVIEW_CATEGORIES,
    REVIEW_SEVERITIES,
    type ReviewCategory,
    type ReviewSeverity,
    type ReviewVerdict,
} from "./types";

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 6_000;
const MAX_SUGGESTION_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 6_000;
const LINE_SNAP_DISTANCE = 3;
const DEFAULT_CONFIDENCE = 0.7;

export interface BatchReviewOutput {
    summary: string;
    verdict?: ReviewVerdict;
    findings: AiReviewFinding[];
    rejected: number;
}

export interface SynthesisOutput {
    verdict?: ReviewVerdict;
    summary: string;
    duplicates: string[];
}

/** Extracts the first JSON object from a model answer, tolerating Markdown fences and surrounding text. */
export function extractJsonObject(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    const fenced = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/i.exec(trimmed);
    const candidates = [trimmed, fenced?.[1] ?? ""];
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
        candidates.push(trimmed.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
            if (Array.isArray(parsed)) {
                return {findings: parsed};
            }
        } catch {
            // Try the next candidate.
        }
    }
    throw new Error("The AI did not return valid JSON.");
}

function asString(value: unknown, maxLength: number): string {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeSeverity(value: unknown): ReviewSeverity {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if ((REVIEW_SEVERITIES as readonly string[]).includes(text)) {
        return text as ReviewSeverity;
    }
    if (["critical", "high", "error", "blocking"].includes(text)) {
        return "blocker";
    }
    if (["medium", "warning", "important"].includes(text)) {
        return "major";
    }
    if (["low", "info", "suggestion"].includes(text)) {
        return "minor";
    }
    if (["trivial", "nitpick", "style"].includes(text)) {
        return "nit";
    }
    return "minor";
}

export function normalizeCategory(value: unknown): ReviewCategory {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if ((REVIEW_CATEGORIES as readonly string[]).includes(text)) {
        return text as ReviewCategory;
    }
    if (["maintainability", "style", "clarity", "naming"].includes(text)) {
        return "readability";
    }
    if (["test", "testing"].includes(text)) {
        return "tests";
    }
    if (["correctness", "logic", "error"].includes(text)) {
        return "bug";
    }
    return "design";
}

export function normalizeVerdict(value: unknown): ReviewVerdict | undefined {
    const text =
        typeof value === "string"
            ? value
                  .trim()
                  .toLowerCase()
                  .replace(/[\s-]+/g, "_")
            : "";
    if (text === "approve" || text === "approved" || text === "ok" || text === "lgtm") {
        return "approve";
    }
    if (text === "request_changes" || text === "changes_requested" || text === "reject") {
        return "request_changes";
    }
    if (text === "comment" || text === "comments") {
        return "comment";
    }
    return undefined;
}

function normalizePath(value: string): string {
    return value
        .trim()
        .replace(/^`|`$/g, "")
        .replace(/^(?:a|b)\//, "")
        .replace(/^\.?\//, "");
}

/** Maps a path returned by the model to a reviewed file path (exact match first, then a unique suffix match). */
export function resolveFilePath(
    value: unknown,
    files: ReadonlyMap<string, FileDiff>,
): string | undefined {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    const path = normalizePath(value);
    if (files.has(path)) {
        return path;
    }
    const matches = [...files.keys()].filter(
        (candidate) => candidate.endsWith(`/${path}`) || path.endsWith(`/${candidate}`),
    );
    return matches.length === 1 ? matches[0] : undefined;
}

/** Keeps a line only when it can receive an inline comment; otherwise snaps to a nearby added line or drops it. */
export function resolveLine(value: unknown, file: FileDiff): number | undefined {
    const line =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN;
    if (!Number.isInteger(line) || line < 1) {
        return undefined;
    }
    if (commentableLines(file).has(line)) {
        return line;
    }
    const nearest = addedLineNumbers(file)
        .map((candidate) => ({candidate, distance: Math.abs(candidate - line)}))
        .filter(({distance}) => distance <= LINE_SNAP_DISTANCE)
        .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.candidate;
}

export function normalizeBatchResult(
    raw: Record<string, unknown>,
    options: {files: ReadonlyMap<string, FileDiff>; idPrefix: string},
): BatchReviewOutput {
    const items = Array.isArray(raw.findings) ? raw.findings : [];
    const findings: AiReviewFinding[] = [];
    let rejected = 0;
    items.forEach((item, index) => {
        if (!item || typeof item !== "object") {
            rejected++;
            return;
        }
        const entry = item as Record<string, unknown>;
        const file = resolveFilePath(entry.file ?? entry.path, options.files);
        const title = asString(entry.title, MAX_TITLE_LENGTH);
        const body = asString(
            entry.body ?? entry.description ?? entry.message,
            MAX_BODY_LENGTH,
        );
        if (!file || (!title && !body)) {
            rejected++;
            return;
        }
        const line = resolveLine(entry.line, options.files.get(file)!);
        const rule = asString(entry.rule, MAX_TITLE_LENGTH);
        const suggestion =
            typeof entry.suggestion === "string" && entry.suggestion.trim()
                ? entry.suggestion
                      .replace(/^\n+|\s+$/g, "")
                      .replace(/^```[\w-]*\n([\s\S]*?)\n?```$/, "$1")
                      .slice(0, MAX_SUGGESTION_LENGTH)
                : undefined;
        const confidence =
            typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
                ? Math.min(1, Math.max(0, entry.confidence))
                : DEFAULT_CONFIDENCE;
        findings.push({
            id: `${options.idPrefix}-${index + 1}`,
            file,
            ...(line === undefined ? {} : {line}),
            severity: normalizeSeverity(entry.severity),
            category: rule ? "rule" : normalizeCategory(entry.category),
            ...(rule ? {rule} : {}),
            title: title || body.split("\n")[0].slice(0, MAX_TITLE_LENGTH),
            body,
            ...(suggestion ? {suggestion} : {}),
            confidence,
            status: "open",
        });
    });
    return {
        summary: asString(raw.summary, MAX_SUMMARY_LENGTH),
        verdict: normalizeVerdict(raw.verdict),
        findings,
        rejected,
    };
}

export function normalizeSynthesis(raw: Record<string, unknown>): SynthesisOutput {
    return {
        verdict: normalizeVerdict(raw.verdict),
        summary: asString(raw.summary, MAX_SUMMARY_LENGTH),
        duplicates: Array.isArray(raw.duplicates)
            ? raw.duplicates.filter((id): id is string => typeof id === "string")
            : [],
    };
}

export function severityRank(severity: ReviewSeverity): number {
    return REVIEW_SEVERITIES.length - REVIEW_SEVERITIES.indexOf(severity);
}

export function meetsThreshold(
    finding: Pick<AiReviewFinding, "severity" | "confidence">,
    thresholds: {minSeverity: ReviewSeverity; minConfidence: number},
): boolean {
    return (
        severityRank(finding.severity) >= severityRank(thresholds.minSeverity) &&
        finding.confidence >= thresholds.minConfidence
    );
}

export function deriveVerdict(
    findings: readonly Pick<AiReviewFinding, "severity">[],
): ReviewVerdict {
    if (
        findings.some(
            (finding) => finding.severity === "blocker" || finding.severity === "major",
        )
    ) {
        return "request_changes";
    }
    return findings.length > 0 ? "comment" : "approve";
}

/** The model's verdict can only make the outcome stricter than what the findings imply, never more lenient. */
export function reconcileVerdict(
    modelVerdict: ReviewVerdict | undefined,
    findings: readonly Pick<AiReviewFinding, "severity">[],
): ReviewVerdict {
    const derived = deriveVerdict(findings);
    const order: ReviewVerdict[] = ["approve", "comment", "request_changes"];
    if (!modelVerdict) {
        return derived;
    }
    return order.indexOf(modelVerdict) > order.indexOf(derived) ? modelVerdict : derived;
}

export function sortFindings(findings: readonly AiReviewFinding[]): AiReviewFinding[] {
    return [...findings].sort(
        (a, b) =>
            severityRank(b.severity) - severityRank(a.severity) ||
            a.file.localeCompare(b.file) ||
            (a.line ?? 0) - (b.line ?? 0),
    );
}

export const SEVERITY_LABELS: Record<ReviewSeverity, string> = {
    blocker: "⛔ Blocker",
    major: "🟠 Major",
    minor: "🟡 Minor",
    nit: "⚪ Nit",
};

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
    approve: "✅ Looks good",
    comment: "💬 Suggestions",
    request_changes: "⛔ Changes needed",
};

const CATEGORY_LABELS: Record<ReviewCategory, string> = {
    bug: "Bug",
    security: "Security",
    performance: "Performance",
    readability: "Readability",
    tests: "Tests",
    design: "Design",
    rule: "Team rule",
};

export function categoryLabel(
    finding: Pick<AiReviewFinding, "category" | "rule">,
): string {
    return finding.category === "rule" && finding.rule
        ? `${CATEGORY_LABELS.rule}: ${finding.rule}`
        : CATEGORY_LABELS[finding.category];
}

const FENCE_LANGUAGES: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    java: "java",
    kt: "kotlin",
    go: "go",
    rs: "rust",
    rb: "ruby",
    php: "php",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    swift: "swift",
    scala: "scala",
    sql: "sql",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    vue: "vue",
    md: "markdown",
    dart: "dart",
};

export function fenceLanguage(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    return FENCE_LANGUAGES[extension] ?? "";
}

/** Markdown posted to Bitbucket for a finding. */
export function formatFindingComment(
    finding: AiReviewFinding,
    options: {includeLocation?: boolean} = {},
): string {
    const location = options.includeLocation
        ? ` · \`${finding.file}${finding.line ? `:${finding.line}` : ""}\``
        : "";
    const parts = [
        `**${SEVERITY_LABELS[finding.severity]} · ${categoryLabel(finding)}**${location} — ${finding.title}`,
    ];
    if (finding.body && finding.body !== finding.title) {
        parts.push(finding.body);
    }
    if (finding.suggestion) {
        parts.push(`\`\`\`${fenceLanguage(finding.file)}\n${finding.suggestion}\n\`\`\``);
    }
    return parts.join("\n\n");
}

export function formatSummaryComment(
    result: Pick<AiReviewResult, "verdict" | "summary" | "findings">,
): string {
    const open = result.findings.filter((finding) => finding.status !== "dismissed");
    const parts = [`### ${VERDICT_LABELS[result.verdict]}`, result.summary];
    if (open.length > 0) {
        parts.push(
            open
                .map(
                    (finding) =>
                        `- **${SEVERITY_LABELS[finding.severity]}** \`${finding.file}${finding.line ? `:${finding.line}` : ""}\` — ${finding.title}`,
                )
                .join("\n"),
        );
    }
    return parts.filter(Boolean).join("\n\n");
}
