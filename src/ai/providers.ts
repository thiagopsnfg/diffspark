import { ImprovePrompt } from "./prompt";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TEMPERATURE = 0.3;

export interface CompletionOptions {
  /** Ask the provider for a JSON object response. */
  json?: boolean;
  temperature?: number;
}

const defaultFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function apiErrorMessage(provider: string, status: number, text: string): string {
  const body = parseJson(text) as { error?: { message?: unknown } | unknown } | undefined;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const detail = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : typeof error === "string"
      ? error
      : text.slice(0, 300);
  const hint = status === 401 || status === 403
    ? " Check the API key with \"DiffSpark: Set AI API Key\"."
    : status === 429
      ? " The provider is rate limiting requests or the quota was exceeded."
      : "";
  return `${provider} request failed (${status})${detail ? `: ${detail}` : ""}.${hint}`;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("The OpenAI base URL must use HTTPS (HTTP is only allowed for localhost).");
  }
  return value;
}

export async function requestOpenAi(
  prompt: ImprovePrompt,
  options: { apiKey: string; model?: string; baseUrl?: string; signal?: AbortSignal; fetch?: FetchLike } & CompletionOptions,
): Promise<string> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const url = `${normalizeBaseUrl(options.baseUrl)}/chat/completions`;
  const send = (json: boolean) => fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model?.trim() || DEFAULT_OPENAI_MODEL,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: options.signal,
  });
  let response = await send(Boolean(options.json));
  let text = await response.text();
  // Some OpenAI-compatible endpoints reject response_format; the prompt already asks for JSON, so retry without it.
  if (options.json && response.status === 400 && /response_format|json/i.test(text)) {
    response = await send(false);
    text = await response.text();
  }
  if (!response.ok) {
    throw new Error(apiErrorMessage("OpenAI", response.status, text));
  }
  const body = parseJson(text) as { choices?: { message?: { content?: unknown } }[] } | undefined;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI returned an empty suggestion.");
  }
  return content;
}

export async function requestGemini(
  prompt: ImprovePrompt,
  options: { apiKey: string; model?: string; signal?: AbortSignal; fetch?: FetchLike } & CompletionOptions,
): Promise<string> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const response = await fetchImpl(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: {
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        ...(options.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(apiErrorMessage("Gemini", response.status, text));
  }
  const body = parseJson(text) as {
    candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  } | undefined;
  if (body?.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request (${body.promptFeedback.blockReason}).`);
  }
  const content = (body?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  if (!content.trim()) {
    throw new Error("Gemini returned an empty suggestion.");
  }
  return content;
}
