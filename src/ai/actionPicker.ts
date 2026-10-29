import * as vscode from "vscode";
import {
    IMPROVE_ACTIONS,
    IMPROVE_TONES,
    type ImproveOptions,
    TRANSLATE_LANGUAGES,
} from "./prompt";

export async function pickImproveOptions(): Promise<ImproveOptions | undefined> {
    const action = await vscode.window.showQuickPick(
        IMPROVE_ACTIONS.map((item) => ({
            label: `$(${item.icon}) ${item.label}`,
            description: item.submenu ? `${item.description}  ›` : item.description,
            item,
        })),
        {
            title: "Improve comment",
            placeHolder: "Choose how the AI should improve your comment",
        },
    );
    if (!action) {
        return undefined;
    }
    if (action.item.submenu === "tone") {
        const tone = await vscode.window.showQuickPick(
            IMPROVE_TONES.map((item) => ({
                label: item.label,
                description: item.description,
                id: item.id,
            })),
            {title: "Improve comment › Change tone", placeHolder: "Choose the tone"},
        );
        return tone ? {action: "tone", tone: tone.id} : undefined;
    }
    if (action.item.submenu === "translate") {
        const other = "$(edit) Other language…";
        const language = await vscode.window.showQuickPick(
            [...TRANSLATE_LANGUAGES, other],
            {
                title: "Improve comment › Translate",
                placeHolder: "Translate the comment to…",
            },
        );
        if (!language) {
            return undefined;
        }
        if (language !== other) {
            return {action: "translate", targetLanguage: language};
        }
        const custom = await vscode.window.showInputBox({
            title: "Improve comment › Translate",
            prompt: "Target language",
            placeHolder: "e.g. Japanese",
            validateInput: (value) =>
                value.trim() && value.trim().length <= 60
                    ? undefined
                    : "Enter a language name.",
        });
        return custom?.trim()
            ? {action: "translate", targetLanguage: custom.trim()}
            : undefined;
    }
    return {action: action.item.id};
}
