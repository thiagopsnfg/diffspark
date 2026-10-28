const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildImprovePrompt,
  buildCodeSnippet,
  cleanSuggestion,
  describeImproveOptions,
  isImproveAction,
  isImproveTone,
  IMPROVE_ACTIONS,
} = require("../dist/ai/prompt");
const { requestOpenAi, requestGemini } = require("../dist/ai/providers");

function fakeFetch(status, body) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    },
  };
}

test("builds the default improve prompt keeping the original language", () => {
  const prompt = buildImprovePrompt({
    action: "improve",
    comment: "  isso ta errado, arruma  ",
    filePath: "src/app.js",
    codeSnippet: ">  3 | const score = 0;",
    discussion: ["Ana: why?", "  "],
  });
  assert.match(prompt.system, /same language as the original draft comment/);
  assert.match(prompt.system, /Return ONLY the rewritten comment/);
  assert.match(prompt.user, /polite and constructive/);
  assert.match(prompt.user, /File being reviewed: src\/app\.js/);
  assert.match(prompt.user, /<code>\n>  3 \| const score = 0;\n<\/code>/);
  assert.match(prompt.user, /<discussion>\nAna: why\?\n<\/discussion>/);
  assert.match(prompt.user, /<comment>\nisso ta errado, arruma\n<\/comment>/);
});

test("builds action specific instructions", () => {
  const base = { comment: "fix this" };
  assert.match(buildImprovePrompt({ ...base, action: "grammar" }).user, /Fix only spelling/);
  assert.match(buildImprovePrompt({ ...base, action: "formatting" }).user, /formatting and structure/);
  assert.match(buildImprovePrompt({ ...base, action: "remix" }).user, /noticeably different way/);
  assert.match(buildImprovePrompt({ ...base, action: "shorter" }).user, /shorter and more objective/);
  assert.match(buildImprovePrompt({ ...base, action: "longer" }).user, /Expand the comment/);
  assert.match(buildImprovePrompt({ ...base, action: "example" }).user, /code example/);
  assert.match(buildImprovePrompt({ ...base, action: "tone", tone: "empathetic" }).user, /empathetic tone/);
  assert.match(buildImprovePrompt({ ...base, action: "tone" }).user, /professional tone/);

  const translated = buildImprovePrompt({ ...base, action: "translate", targetLanguage: "Spanish" });
  assert.match(translated.user, /Translate the comment to Spanish/);
  assert.match(translated.system, /Write the result in Spanish\./);
  assert.doesNotMatch(translated.system, /same language as the original/);
});

test("rejects empty comments and truncates large context", () => {
  assert.throws(() => buildImprovePrompt({ action: "improve", comment: "   " }), /Write a comment/);
  const prompt = buildImprovePrompt({ action: "improve", comment: "ok", codeSnippet: "x".repeat(10_000) });
  assert.match(prompt.user, /…\[truncated\]/);
  assert.ok(prompt.user.length < 6_000);
});

test("describes and validates improve options", () => {
  assert.equal(describeImproveOptions({ action: "improve" }), "Improve comment");
  assert.equal(describeImproveOptions({ action: "shorter" }), "Make shorter");
  assert.equal(describeImproveOptions({ action: "tone", tone: "casual" }), "Change tone: Casual");
  assert.equal(describeImproveOptions({ action: "translate", targetLanguage: "German" }), "Translate to German");
  assert.equal(describeImproveOptions({ action: "translate" }), "Translate to English");
  assert.equal(isImproveAction("improve"), true);
  for (const action of IMPROVE_ACTIONS) {
    assert.equal(isImproveAction(action.id), true);
  }
  assert.equal(isImproveAction("delete"), false);
  assert.equal(isImproveTone("neutral"), true);
  assert.equal(isImproveTone("angry"), false);
});

test("cleans wrapped AI suggestions", () => {
  assert.equal(cleanSuggestion("```markdown\nUse `const` here.\n```"), "Use `const` here.");
  assert.equal(cleanSuggestion("<comment>\nBetter text\n</comment>"), "Better text");
  assert.equal(cleanSuggestion("\"Please rename this.\""), "Please rename this.");
  assert.equal(cleanSuggestion("Keep this:\n```js\nconst a = 1;\n```"), "Keep this:\n```js\nconst a = 1;\n```");
  assert.equal(cleanSuggestion("Use \"strict\" mode and \"lint\"."), "Use \"strict\" mode and \"lint\".");
});

test("builds code snippets around the commented line", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const snippet = buildCodeSnippet(lines, 9, 2).split("\n");
  assert.deepEqual(snippet, ["   8 | line 8", "   9 | line 9", "> 10 | line 10", "  11 | line 11", "  12 | line 12"]);
  assert.equal(buildCodeSnippet(lines, 0, 1), "> 1 | line 1\n  2 | line 2");
  assert.equal(buildCodeSnippet([], 3), "");
  assert.match(buildCodeSnippet(lines, 100, 1), /> 30 \| line 30$/);
});

test("requests OpenAI chat completions", async () => {
  const { calls, fetch } = fakeFetch(200, { choices: [{ message: { content: "Improved" } }] });
  const result = await requestOpenAi({ system: "S", user: "U" }, { apiKey: "sk-test", fetch });
  assert.equal(result, "Improved");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [{ role: "system", content: "S" }, { role: "user", content: "U" }]);
});

test("supports OpenAI-compatible base URLs and custom models", async () => {
  const { calls, fetch } = fakeFetch(200, { choices: [{ message: { content: "ok" } }] });
  await requestOpenAi({ system: "S", user: "U" }, { apiKey: "k", model: "gpt-4.1", baseUrl: "https://example.com/api/v1/", fetch });
  assert.equal(calls[0].url, "https://example.com/api/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).model, "gpt-4.1");
  await requestOpenAi({ system: "S", user: "U" }, { apiKey: "k", baseUrl: "http://localhost:11434/v1", fetch });
  assert.equal(calls[1].url, "http://localhost:11434/v1/chat/completions");
  await assert.rejects(
    requestOpenAi({ system: "S", user: "U" }, { apiKey: "k", baseUrl: "http://example.com/v1", fetch }),
    /must use HTTPS/,
  );
});

test("reports OpenAI errors with hints", async () => {
  const unauthorized = fakeFetch(401, { error: { message: "Incorrect API key provided" } });
  await assert.rejects(
    requestOpenAi({ system: "S", user: "U" }, { apiKey: "bad", fetch: unauthorized.fetch }),
    /OpenAI request failed \(401\): Incorrect API key provided\. Check the API key/,
  );
  const empty = fakeFetch(200, { choices: [] });
  await assert.rejects(
    requestOpenAi({ system: "S", user: "U" }, { apiKey: "k", fetch: empty.fetch }),
    /empty suggestion/,
  );
});

test("requests Gemini generateContent", async () => {
  const { calls, fetch } = fakeFetch(200, {
    candidates: [{ content: { parts: [{ text: "Melhor " }, { text: "comentário" }] } }],
  });
  const result = await requestGemini({ system: "S", user: "U" }, { apiKey: "g-key", fetch });
  assert.equal(result, "Melhor comentário");
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "S" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "U" }] }]);
});

test("reports Gemini errors and blocked prompts", async () => {
  const quota = fakeFetch(429, { error: { message: "Resource exhausted" } });
  await assert.rejects(
    requestGemini({ system: "S", user: "U" }, { apiKey: "k", fetch: quota.fetch }),
    /Gemini request failed \(429\): Resource exhausted\. The provider is rate limiting/,
  );
  const blocked = fakeFetch(200, { promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(
    requestGemini({ system: "S", user: "U" }, { apiKey: "k", fetch: blocked.fetch }),
    /blocked the request \(SAFETY\)/,
  );
});

test("passes abort signals to fetch", async () => {
  const controller = new AbortController();
  const { calls, fetch } = fakeFetch(200, { choices: [{ message: { content: "ok" } }] });
  await requestOpenAi({ system: "S", user: "U" }, { apiKey: "k", signal: controller.signal, fetch });
  assert.equal(calls[0].init.signal, controller.signal);
});
