export type ImproveAction =
    | "improve"
    | "formatting"
    | "grammar"
    | "remix"
    | "tone"
    | "shorter"
    | "longer"
    | "example"
    | "translate";

export type ImproveTone =
    | "professional"
    | "empathetic"
    | "casual"
    | "neutral"
    | "educational";

export interface ImproveOptions {
    action: ImproveAction;
    tone?: ImproveTone;
    targetLanguage?: string;
}

export interface ImproveRequest extends ImproveOptions {
    comment: string;
    filePath?: string;
    codeSnippet?: string;
    pullRequestTitle?: string;
    pullRequestDescription?: string;
    discussion?: string[];
}

export interface ImprovePrompt {
    system: string;
    user: string;
}

export interface ImproveActionInfo {
    id: ImproveAction;
    label: string;
    icon: string;
    description: string;
    submenu?: "tone" | "translate";
}

export const IMPROVE_ACTIONS: readonly ImproveActionInfo[] = [
    {
        id: "formatting",
        label: "Improve formatting",
        icon: "list-flat",
        description: "Organize with Markdown: lists, code blocks, emphasis",
    },
    {
        id: "grammar",
        label: "Fix spelling and grammar",
        icon: "whole-word",
        description: "Only fix mistakes, keep your wording",
    },
    {
        id: "remix",
        label: "Remix",
        icon: "sync",
        description: "Rewrite it differently with the same meaning",
    },
    {
        id: "tone",
        label: "Change tone",
        icon: "comment",
        description: "Professional, empathetic, casual…",
        submenu: "tone",
    },
    {
        id: "shorter",
        label: "Make shorter",
        icon: "fold-up",
        description: "More concise and objective",
    },
    {
        id: "longer",
        label: "Make longer",
        icon: "fold-down",
        description: "Explain the reasoning and add context",
    },
    {
        id: "example",
        label: "Add code example",
        icon: "code",
        description: "Suggest a concrete snippet for the change",
    },
    {
        id: "translate",
        label: "Translate options",
        icon: "globe",
        description: "Translate the comment",
        submenu: "translate",
    },
];

export const IMPROVE_TONES: readonly {
    id: ImproveTone;
    label: string;
    description: string;
}[] = [
    {
        id: "professional",
        label: "Professional",
        description: "Formal, precise and respectful",
    },
    {
        id: "empathetic",
        label: "Empathetic",
        description: "Kind, supportive and encouraging",
    },
    {id: "casual", label: "Casual", description: "Friendly and relaxed"},
    {id: "neutral", label: "Neutral", description: "Factual, without emotional language"},
    {
        id: "educational",
        label: "Educational",
        description: "Explains the why, like a mentor",
    },
];

export const TRANSLATE_LANGUAGES: readonly string[] = [
    "English",
    "Portuguese (Brazil)",
    "Spanish",
    "French",
    "German",
    "Italian",
];

const MAX_COMMENT_LENGTH = 10_000;
const MAX_SNIPPET_LENGTH = 4_000;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_DISCUSSION_LENGTH = 3_000;
const MAX_LANGUAGE_LENGTH = 60;

export function isImproveAction(value: unknown): value is ImproveAction {
    return value === "improve" || IMPROVE_ACTIONS.some((action) => action.id === value);
}

export function isImproveTone(value: unknown): value is ImproveTone {
    return IMPROVE_TONES.some((tone) => tone.id === value);
}

function targetLanguage(options: ImproveOptions): string {
    return options.targetLanguage?.trim().slice(0, MAX_LANGUAGE_LENGTH) || "English";
}

export function describeImproveOptions(options: ImproveOptions): string {
    if (options.action === "improve") {
        return "Improve comment";
    }
    if (options.action === "tone") {
        const tone =
            IMPROVE_TONES.find((item) => item.id === options.tone) ?? IMPROVE_TONES[0];
        return `Change tone: ${tone.label}`;
    }
    if (options.action === "translate") {
        return `Translate to ${targetLanguage(options)}`;
    }
    return (
        IMPROVE_ACTIONS.find((action) => action.id === options.action)?.label ??
        "Improve comment"
    );
}

function actionInstructions(options: ImproveOptions): string {
    switch (options.action) {
        case "formatting":
            return "Improve only the formatting and structure: use Markdown lists, short paragraphs, `inline code` for identifiers and fenced code blocks for code. Keep the wording as close to the original as possible.";
        case "grammar":
            return "Fix only spelling, grammar and punctuation mistakes. Do not rephrase, restructure, add or remove content.";
        case "remix":
            return "Rewrite the comment in a noticeably different way (different wording and structure) while preserving exactly the same meaning and requests.";
        case "tone": {
            const tone =
                IMPROVE_TONES.find((item) => item.id === options.tone) ??
                IMPROVE_TONES[0];
            return `Rewrite the comment with a ${tone.label.toLowerCase()} tone (${tone.description.toLowerCase()}). Keep the same technical content and requests.`;
        }
        case "shorter":
            return "Make the comment shorter and more objective. Remove redundancy and filler while keeping every technical point and request.";
        case "longer":
            return "Expand the comment: explain the reasoning behind the feedback, the risks or benefits involved and, when helpful, how to address it. Do not invent facts that are not supported by the code or the comment.";
        case "example":
            return "Keep the feedback and add a concrete, minimal code example (in a fenced code block with the right language) that shows how to apply the suggestion to the commented code.";
        case "translate":
            return `Translate the comment to ${targetLanguage(options)}. Keep code, identifiers and Markdown untouched. Do not add content.`;
        default:
            return [
                "Improve the comment as a whole:",
                "- make it clearer and easier to understand, fixing wording, spelling and grammar;",
                "- make it polite and constructive (suggest rather than order, focus on the code, not the person);",
                "- make it objective: state the problem, why it matters and what to do;",
                "- when it helps, include a short concrete example or code snippet;",
                "- keep it concise; do not add unrelated feedback.",
            ].join("\n");
    }
}

function truncate(value: string, maxLength: number): string {
    return value.length > maxLength
        ? `${value.slice(0, maxLength)}\n…[truncated]`
        : value;
}

export function buildImprovePrompt(request: ImproveRequest): ImprovePrompt {
    const comment = request.comment.trim();
    if (!comment) {
        throw new Error("Write a comment before asking the AI to improve it.");
    }
    const languageRule =
        request.action === "translate"
            ? `Write the result in ${targetLanguage(request)}.`
            : "Write the result in the same language as the original draft comment (for example, Portuguese stays Portuguese), even if the code or the context are in another language.";

    const system = [
        "You are an expert software engineer helping a reviewer write pull request review comments.",
        "Your task is to rewrite the reviewer's draft comment according to the instructions.",
        "Rules:",
        "- Preserve the reviewer's intent, technical meaning and any requests; never contradict them.",
        "- Keep existing Markdown, code, identifiers, links and mentions intact.",
        `- ${languageRule}`,
        "- Return ONLY the rewritten comment, ready to be posted. No preamble, no explanations, no quotes around it.",
        "- Do not wrap the whole answer in a code block.",
    ].join("\n");

    const sections = [`Instructions:\n${actionInstructions(request)}`];
    if (request.pullRequestTitle?.trim()) {
        sections.push(`Pull request title:\n${request.pullRequestTitle.trim()}`);
    }
    if (request.pullRequestDescription?.trim()) {
        sections.push(
            `Pull request description:\n${truncate(request.pullRequestDescription.trim(), MAX_DESCRIPTION_LENGTH)}`,
        );
    }
    if (request.filePath?.trim()) {
        sections.push(`File being reviewed: ${request.filePath.trim()}`);
    }
    if (request.codeSnippet?.trim()) {
        sections.push(
            `Code the comment refers to (the commented line is marked with ">"):\n<code>\n${truncate(request.codeSnippet, MAX_SNIPPET_LENGTH)}\n</code>`,
        );
    }
    const discussion = (request.discussion ?? [])
        .map((item) => item.trim())
        .filter(Boolean);
    if (discussion.length > 0) {
        sections.push(
            `Previous messages in this discussion (context only, do not rewrite them):\n<discussion>\n${truncate(discussion.join("\n---\n"), MAX_DISCUSSION_LENGTH)}\n</discussion>`,
        );
    }
    sections.push(
        `Draft comment to rewrite:\n<comment>\n${truncate(comment, MAX_COMMENT_LENGTH)}\n</comment>`,
    );

    return {system, user: sections.join("\n\n")};
}

export function cleanSuggestion(text: string): string {
    let result = text.trim();
    result = result.replace(/^<comment>\s*([\s\S]*?)\s*<\/comment>$/i, "$1").trim();
    const fenced = /^```(?:markdown|md|text)?[ \t]*\n([\s\S]*?)\n```$/i.exec(result);
    if (fenced) {
        result = fenced[1].trim();
    }
    if (/^["“][^"“”]*["”]$/.test(result)) {
        result = result.slice(1, -1).trim();
    }
    return result;
}

export function buildCodeSnippet(
    lines: string[],
    targetLine: number,
    radius = 8,
): string {
    if (lines.length === 0) {
        return "";
    }
    const line = Math.min(Math.max(targetLine, 0), lines.length - 1);
    const start = Math.max(0, line - radius);
    const end = Math.min(lines.length - 1, line + radius);
    const width = String(end + 1).length;
    const result: string[] = [];
    for (let index = start; index <= end; index++) {
        const marker = index === line ? ">" : " ";
        result.push(
            `${marker} ${String(index + 1).padStart(width, " ")} | ${lines[index]}`,
        );
    }
    return result.join("\n");
}
