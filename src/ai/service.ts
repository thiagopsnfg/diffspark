import * as vscode from "vscode";
import { buildImprovePrompt, cleanSuggestion, ImprovePrompt, ImproveRequest } from "./prompt";
import {
  CompletionOptions,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  requestGemini,
  requestOpenAi,
} from "./providers";

export type AiProvider = "copilot" | "openai" | "gemini";

const CONFIG_SECTION = "diffspark.ai";
const API_KEY_SECRETS: Record<Exclude<AiProvider, "copilot">, string> = {
  openai: "diffspark.ai.openai-api-key",
  gemini: "diffspark.ai.gemini-api-key",
};
const PROVIDERS: { id: AiProvider; label: string; detail: string }[] = [
  { id: "copilot", label: "GitHub Copilot", detail: "Uses your Copilot subscription through VS Code. No API key needed." },
  { id: "openai", label: "OpenAI", detail: "Uses an OpenAI API key (or any OpenAI-compatible endpoint)." },
  { id: "gemini", label: "Google Gemini", detail: "Uses a Google AI Studio (Gemini) API key." },
];
const PREFERRED_COPILOT_FAMILIES = ["gpt-4.1", "gpt-4o", "gpt-5-mini", "claude-sonnet-4", "gpt-4o-mini"];
const DEFAULT_INPUT_CHAR_BUDGET = 120_000;
const MAX_INPUT_CHAR_BUDGET = 400_000;
const MIN_INPUT_CHAR_BUDGET = 12_000;

export class CommentImprover {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getProvider(): AiProvider {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("provider");
    return value === "openai" || value === "gemini" ? value : "copilot";
  }

  getProviderLabel(): string {
    return PROVIDERS.find((provider) => provider.id === this.getProvider())!.label;
  }

  async improve(request: ImproveRequest, token: vscode.CancellationToken): Promise<string> {
    const raw = await this.complete(
      buildImprovePrompt(request),
      { justification: "DiffSpark uses Copilot to improve the pull request comment you are writing." },
      token,
    );
    const suggestion = cleanSuggestion(raw);
    if (!suggestion) {
      throw new Error("The AI returned an empty suggestion. Try again.");
    }
    return suggestion;
  }

  /** Sends a prompt to the configured provider and returns the raw answer. */
  async complete(
    prompt: ImprovePrompt,
    options: CompletionOptions & { justification?: string },
    token: vscode.CancellationToken,
  ): Promise<string> {
    const provider = this.getProvider();
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const model = configuration.get<string>("model")?.trim() || undefined;
    let raw: string;
    if (provider === "copilot") {
      raw = await this.requestCopilot(prompt, model, options.justification, token);
    } else {
      const apiKey = await this.getOrPromptApiKey(provider);
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        raw = provider === "openai"
          ? await requestOpenAi(prompt, {
              apiKey,
              model,
              baseUrl: configuration.get<string>("openaiBaseUrl"),
              signal: controller.signal,
              json: options.json,
              temperature: options.temperature,
            })
          : await requestGemini(prompt, {
              apiKey,
              model,
              signal: controller.signal,
              json: options.json,
              temperature: options.temperature,
            });
      } catch (error) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        throw error;
      } finally {
        subscription.dispose();
      }
    }
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return raw;
  }

  /** Approximate number of prompt characters the selected model can take comfortably. */
  async getInputCharBudget(): Promise<number> {
    if (this.getProvider() !== "copilot") {
      return DEFAULT_INPUT_CHAR_BUDGET;
    }
    try {
      const model = await this.selectCopilotModel(vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("model")?.trim() || undefined);
      const tokens = model?.maxInputTokens;
      if (typeof tokens === "number" && tokens > 0) {
        return Math.max(MIN_INPUT_CHAR_BUDGET, Math.min(MAX_INPUT_CHAR_BUDGET, Math.floor(tokens * 3 * 0.6)));
      }
    } catch {
      // Fall back to the default budget.
    }
    return DEFAULT_INPUT_CHAR_BUDGET;
  }

  /** "Provider (model)" label for display. */
  getModelLabel(): string {
    const model = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("model")?.trim();
    return model ? `${this.getProviderLabel()} (${model})` : this.getProviderLabel();
  }

  async selectProvider(): Promise<boolean> {
    const current = this.getProvider();
    const picked = await vscode.window.showQuickPick(
      PROVIDERS.map((provider) => ({
        label: provider.label,
        description: provider.id === current ? "(current)" : undefined,
        detail: provider.detail,
        id: provider.id,
      })),
      { title: "DiffSpark: AI provider", placeHolder: "Select the AI provider" },
    );
    if (!picked) {
      return false;
    }
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const model = await this.pickModel(picked.id, picked.id === current ? configuration.get<string>("model") : "");
    if (model === undefined) {
      return false;
    }
    await configuration.update("provider", picked.id, vscode.ConfigurationTarget.Global);
    await configuration.update("model", model, vscode.ConfigurationTarget.Global);
    if (picked.id !== "copilot" && !(await this.secrets.get(API_KEY_SECRETS[picked.id]))) {
      if (!(await this.setApiKey(picked.id))) {
        return false;
      }
    }
    void vscode.window.showInformationMessage(
      `DiffSpark: AI features will use ${picked.label}${model ? ` (${model})` : ""}.`,
    );
    return true;
  }

  async setApiKey(provider?: Exclude<AiProvider, "copilot">): Promise<boolean> {
    let target = provider;
    if (!target) {
      const picked = await vscode.window.showQuickPick(
        PROVIDERS.filter((item) => item.id !== "copilot").map((item) => ({ label: item.label, id: item.id as Exclude<AiProvider, "copilot"> })),
        { placeHolder: "Which provider's API key do you want to set?" },
      );
      if (!picked) {
        return false;
      }
      target = picked.id;
    }
    const label = PROVIDERS.find((item) => item.id === target)!.label;
    const apiKey = await vscode.window.showInputBox({
      title: `DiffSpark: ${label} API key`,
      prompt: target === "openai"
        ? "Paste your OpenAI API key (https://platform.openai.com/api-keys). It is stored in VS Code's secret storage. Leave empty to remove it."
        : "Paste your Gemini API key (https://aistudio.google.com/apikey). It is stored in VS Code's secret storage. Leave empty to remove it.",
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey === undefined) {
      return false;
    }
    if (!apiKey.trim()) {
      await this.secrets.delete(API_KEY_SECRETS[target]);
      void vscode.window.showInformationMessage(`DiffSpark: ${label} API key removed.`);
      return false;
    }
    await this.secrets.store(API_KEY_SECRETS[target], apiKey.trim());
    return true;
  }

  private async getOrPromptApiKey(provider: Exclude<AiProvider, "copilot">): Promise<string> {
    const existing = await this.secrets.get(API_KEY_SECRETS[provider]);
    if (existing) {
      return existing;
    }
    if (!(await this.setApiKey(provider))) {
      throw new vscode.CancellationError();
    }
    return (await this.secrets.get(API_KEY_SECRETS[provider]))!;
  }

  private async pickModel(provider: AiProvider, currentModel: string | undefined): Promise<string | undefined> {
    if (provider === "copilot") {
      let models: vscode.LanguageModelChat[] = [];
      try {
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      } catch {
        models = [];
      }
      if (models.length === 0) {
        return "";
      }
      const families = [...new Set(models.map((model) => model.family))].sort();
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Automatic", description: "Let DiffSpark choose a fast Copilot model", value: "" },
          ...families.map((family) => ({
            label: models.find((model) => model.family === family)?.name ?? family,
            description: family === currentModel ? `${family} (current)` : family,
            value: family,
          })),
        ],
        { placeHolder: "Select the Copilot model" },
      );
      return picked?.value;
    }
    const defaultModel = provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_GEMINI_MODEL;
    const model = await vscode.window.showInputBox({
      title: "DiffSpark: AI model",
      prompt: `Model name (leave empty to use the default "${defaultModel}")`,
      value: currentModel ?? "",
      placeHolder: defaultModel,
      ignoreFocusOut: true,
    });
    return model === undefined ? undefined : model.trim();
  }

  private async selectCopilotModel(family: string | undefined): Promise<vscode.LanguageModelChat | undefined> {
    if (!vscode.lm?.selectChatModels) {
      throw new Error("This VS Code version does not support the Language Model API. Choose OpenAI or Gemini with \"DiffSpark: Select AI Provider\".");
    }
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (models.length === 0) {
      return undefined;
    }
    return (family && (models.find((item) => item.family === family) ?? models.find((item) => item.id === family))) ||
      PREFERRED_COPILOT_FAMILIES.map((preferred) => models.find((item) => item.family === preferred)).find(Boolean) ||
      models[0];
  }

  private async requestCopilot(
    prompt: ImprovePrompt,
    family: string | undefined,
    justification: string | undefined,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const model = await this.selectCopilotModel(family);
    if (!model) {
      throw new Error(
        "GitHub Copilot is not available. Sign in to GitHub Copilot, or choose OpenAI or Gemini with \"DiffSpark: Select AI Provider\".",
      );
    }
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`${prompt.system}\n\n${prompt.user}`)],
        { justification: justification ?? "DiffSpark uses Copilot to help you review pull requests." },
        token,
      );
      let text = "";
      for await (const fragment of response.text) {
        text += fragment;
      }
      return text;
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (error instanceof vscode.LanguageModelError && error.code === vscode.LanguageModelError.NoPermissions().code) {
        throw new Error("DiffSpark is not allowed to use GitHub Copilot. Allow access when prompted, or choose another provider.");
      }
      throw error;
    }
  }
}
