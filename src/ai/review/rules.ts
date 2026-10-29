import {matchesGlob} from "./diff";
import type {ReviewRule} from "./types";

export const MAX_RULE_CHARS = 20_000;
export const MAX_TOTAL_RULE_CHARS = 40_000;
const MIN_USEFUL_RULE_CHARS = 200;

export const GLOBAL_RULES_TEMPLATE = `---
# Optional: glob(s) of the files these rules apply to. Remove or leave empty to apply to every file.
# Examples: "**/*.{ts,tsx}"   "src/api/**, **/*.sql"
applyTo: "**"
description: General review rules
---
# Review rules

Tell the AI reviewer what to focus on or consider when it reviews a pull request.
Write them as you would explain them to a new reviewer on your team. Examples:

- Never leave \`console.log\` / \`print\` calls in production code.
- Prefer early returns over nested \`if/else\` blocks.
- Functions with more than two parameters must use an options object.
- New business logic must come with unit tests.
- Never hardcode secrets, passwords or hosts.

You can include ❌ / ✅ code examples. Mark important rules (for example "**Important**" or "must be blocked")
so the AI treats violations as more severe.
`;

function stripQuotes(value: string): string {
    const trimmed = value.trim();
    if (
        trimmed.length >= 2 &&
        (trimmed[0] === '"' || trimmed[0] === "'") &&
        trimmed.at(-1) === trimmed[0]
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

/** Splits a comma-separated glob list, keeping commas inside `{a,b}` braces. */
export function splitGlobList(value: string): string[] {
    let text = stripQuotes(value);
    if (text.startsWith("[") && text.endsWith("]")) {
        text = text.slice(1, -1);
    }
    const items: string[] = [];
    let depth = 0;
    let current = "";
    let quote: string | undefined;
    for (const character of text) {
        if (quote) {
            if (character === quote) {
                quote = undefined;
            }
            current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        if (character === "{") {
            depth++;
        } else if (character === "}") {
            depth = Math.max(0, depth - 1);
        } else if (character === "," && depth === 0) {
            items.push(current);
            current = "";
            continue;
        }
        current += character;
    }
    items.push(current);
    return items.map(stripQuotes).filter(Boolean);
}

interface Frontmatter {
    fields: Map<string, string[]>;
    body: string;
}

function parseFrontmatter(text: string): Frontmatter {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
    if (!match) {
        return {fields: new Map(), body: normalized};
    }
    const fields = new Map<string, string[]>();
    let listKey: string | undefined;
    for (const rawLine of match[1].split("\n")) {
        const line = rawLine.replace(/\s+#.*$/, "");
        if (!line.trim() || line.trim().startsWith("#")) {
            continue;
        }
        const listItem = /^\s*-\s+(.*)$/.exec(line);
        if (listItem && listKey) {
            fields.get(listKey)?.push(stripQuotes(listItem[1]));
            continue;
        }
        const keyValue = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!keyValue) {
            continue;
        }
        const key = keyValue[1];
        const value = keyValue[2].trim();
        listKey = value ? undefined : key;
        fields.set(key, value ? [value] : []);
    }
    return {fields, body: normalized.slice(match[0].length)};
}

export function parseRuleFile(text: string, source: string): ReviewRule {
    const {fields, body} = parseFrontmatter(text);
    const applyTo = (fields.get("applyTo") ?? [])
        .flatMap(splitGlobList)
        .filter((pattern) => pattern !== "**" && pattern !== "**/*" && pattern !== "*");
    const description = fields.get("description")?.map(stripQuotes).join(" ").trim();
    return {
        source,
        ...(description ? {description} : {}),
        applyTo,
        content: body.trim(),
    };
}

export function ruleAppliesTo(rule: ReviewRule, paths: readonly string[]): boolean {
    if (rule.applyTo.length === 0) {
        return true;
    }
    return paths.some((path) =>
        rule.applyTo.some((pattern) => matchesGlob(path, pattern)),
    );
}

export function selectRules(
    rules: readonly ReviewRule[],
    paths: readonly string[],
): ReviewRule[] {
    return rules.filter((rule) => rule.content && ruleAppliesTo(rule, paths));
}

/** Truncates rules to keep the prompt within budget. Rules that do not fit at all are returned in `dropped`. */
export function limitRules(
    rules: readonly ReviewRule[],
    limits: {maxRuleChars?: number; maxTotalChars?: number} = {},
): {rules: ReviewRule[]; dropped: ReviewRule[]} {
    const maxRuleChars = limits.maxRuleChars ?? MAX_RULE_CHARS;
    let remaining = limits.maxTotalChars ?? MAX_TOTAL_RULE_CHARS;
    const kept: ReviewRule[] = [];
    const dropped: ReviewRule[] = [];
    for (const rule of rules) {
        const allowed = Math.min(maxRuleChars, remaining);
        if (allowed < MIN_USEFUL_RULE_CHARS) {
            dropped.push(rule);
            continue;
        }
        if (rule.content.length > allowed) {
            kept.push({
                ...rule,
                content: `${rule.content.slice(0, allowed)}\n…[truncated]`,
                truncated: true,
            });
            remaining -= allowed;
        } else {
            kept.push(rule);
            remaining -= rule.content.length;
        }
    }
    return {rules: kept, dropped};
}

export function sanitizeRuleFileName(name: string): string | undefined {
    const base = name
        .trim()
        .replace(/\.md$/i, "")
        .replace(/[^\w.-]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
    return base ? `${base}.md` : undefined;
}

export function buildRuleFileTemplate(options: {
    applyTo?: string;
    description?: string;
}): string {
    const applyTo = options.applyTo?.trim() || "**";
    const description = options.description?.trim() || "Review rules";
    return GLOBAL_RULES_TEMPLATE.replace(
        'applyTo: "**"',
        `applyTo: ${JSON.stringify(applyTo)}`,
    ).replace(
        "description: General review rules",
        `description: ${description.replace(/\n/g, " ")}`,
    );
}
