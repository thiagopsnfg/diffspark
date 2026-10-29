<p align="center">
  <img src="resources/diffspark-logo.png" alt="DiffSpark" width="420" />
</p>

<h3 align="center">Smarter reviews. Better code.</h3>

<p align="center">
  Review Bitbucket Cloud pull requests without leaving VS Code — browse, diff, comment, approve, and merge, with AI that helps you write better feedback.
</p>

<p align="center">
  <a href="https://github.com/thiagopsnfg/diffspark/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
  <img alt="VS Code ^1.90.0" src="https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC.svg?style=flat-square&logo=visualstudiocode&logoColor=white" />
  <img alt="Bitbucket Cloud" src="https://img.shields.io/badge/Bitbucket-Cloud-0052CC.svg?style=flat-square&logo=bitbucket&logoColor=white" />
  <img alt="Jira Cloud" src="https://img.shields.io/badge/Jira-Cloud-0052CC.svg?style=flat-square&logo=jira&logoColor=white" />
  <a href="https://github.com/thiagopsnfg/diffspark"><img alt="GitHub stars" src="https://img.shields.io/github/stars/thiagopsnfg/diffspark.svg?style=flat-square&logo=github" /></a>
</p>

---

<p align="center">
  <img src="images/ai-improve.gif" alt="Improve a review comment with AI in DiffSpark" width="820" />
</p>

---

## Table of contents

- [Why DiffSpark?](#why-diffspark)
- [✨ AI comment assistant](#ai-comment-assistant)
- [🤖 Review with AI](#review-with-ai)
- [🔎 Find the right pull request, fast](#smart-filters)
- [🗂️ A file layout that fits your flow](#file-layout)
- [💬 Review, discuss, and merge](#review-and-merge)
- [Quick start](#quick-start)
- [Jira integration](#jira-integration)
- [Commands](#commands)
- [Settings](#settings)
- [Security & privacy](#security--privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributors](#contributors)
- [License](#license)

## Why DiffSpark?

| | |
| --- | --- |
| ✨ **AI comment assistant** | Turn a rushed note into clear, kind, actionable feedback in one click — with GitHub Copilot, OpenAI, or Gemini. |
| 🤖 **Review with AI** | Let the AI review every change in the PR against **your team's rules** and propose fixes — or tell you it looks good. |
| 🔎 **Smart filters & sorting** | Filter by status, drafts, and author (with avatars), and sort by **Recently updated** or **Oldest**. |
| 🗂️ **Your layout, your flow** | Browse changed files as a folder tree or a flat list. |
| 🧩 **Native diffs** | Side-by-side diffs in VS Code, including added, removed, renamed, and fork files. |
| 💬 **Inline discussions** | Read, write, reply to, and delete Markdown comments right on the changed lines. |
| ✅ **Review & merge** | Approve, request changes, and merge — and move linked Jira issues automatically. |

<a id="ai-comment-assistant"></a>

## ✨ AI comment assistant

> **Write what you think. DiffSpark helps you say it well.**

Code review is as much about communication as it is about code. The AI comment assistant works like Jira's *Improve description*: write your comment, click **Improve comment**, and get an editable suggestion that is **clearer, more polite, and more objective** — with an example when it helps. Your comment keeps its original language, and nothing is posted until you decide.

### Pick exactly the help you need

Open the **✦ ▾** menu for focused actions:

<table>
  <tr>
    <td width="50%">
      <ul>
        <li>📝 <b>Improve formatting</b></li>
        <li>🔤 <b>Fix spelling and grammar</b></li>
        <li>🔀 <b>Remix</b> — a fresh take on the same idea</li>
        <li>🎭 <b>Change tone</b> — professional, empathetic, casual, neutral, educational</li>
        <li>✂️ <b>Make shorter</b> / ➕ <b>Make longer</b></li>
        <li>🧑‍💻 <b>Add code example</b></li>
        <li>🌍 <b>Translate</b> — English, Portuguese (Brazil), Spanish, French, German, Italian, or any other language</li>
      </ul>
    </td>
    <td width="50%"><img src="images/ai-menu.png" alt="AI actions menu with tone and translation options" /></td>
  </tr>
</table>

<p align="center">
  <img src="images/ai-actions.gif" alt="Changing a comment's tone to empathetic with the AI actions menu" width="820" />
  <br /><sub>Turning a blunt comment into an empathetic one with <b>Change tone → Empathetic</b>.</sub>
</p>

### You stay in control

- **Pull request view** — the suggestion appears below the comment box. Edit it, then **Replace**, **Insert below**, **Try again**, or **Discard**. Click **Stop** to cancel a running request.
- **Inline diff comments** — **Improve comment** and **AI actions ▾** sit next to **Comment**/**Reply**. The suggestion shows up in the thread with **Replace & post**, **Insert below**, **Try again**, and **Discard**. Your original text is never lost: **Discard** and **Insert below** keep it as an editable *Draft* that you can **Post**, **Improve** again, or **Delete**.
- **Context-aware** — inline suggestions consider the file, the surrounding code, and the earlier messages in the thread; the PR view uses the PR title and description (see [Security & privacy](#security--privacy)).

### Bring your own AI

Choose a provider with **DiffSpark: Select AI Provider**:

| Provider | Setup |
| --- | --- |
| **GitHub Copilot** (default) | Uses the VS Code Language Model API and your Copilot subscription. No API key — VS Code asks once for permission. |
| **OpenAI** | Run **DiffSpark: Set AI API Key**. Default model `gpt-4o-mini`. Works with any OpenAI-compatible endpoint via `diffspark.ai.openaiBaseUrl` (HTTPS, or HTTP on localhost). |
| **Google Gemini** | Run **DiffSpark: Set AI API Key** with a [Google AI Studio](https://aistudio.google.com/apikey) key. Default model `gemini-2.5-flash`. |

<a id="review-with-ai"></a>

## 🤖 Review with AI

> **A first pass on the whole PR, so you can focus on what matters.**

Click the ✦ icon next to a pull request (or run **DiffSpark: Review Pull Request with AI**). DiffSpark sends the changes to your AI provider and shows the result in the **AI Review** section of the pull request view:

- **Verdict**: ✅ *Looks good*, 💬 *Comments*, or ⛔ *Changes needed*, plus a short summary of what the PR does.
- **Findings** grouped by severity (🔴 blocker, 🟠 major, 🟡 minor, ⚪ nit). Each one has a file and line, an explanation, an optional suggested fix, and a confidence score. Violations of your rules are tagged *Team rule*.
- **Drafts in the diff**: open a changed file and the findings appear on their lines as *AI review · not posted* drafts.

**Nothing is posted automatically.** For each finding you can click **Post comment** to publish it as a Bitbucket inline comment (it falls back to a general comment when the line is no longer in the diff). You can also click its location to open the diff and edit the draft before posting, or **Dismiss** it. You can also post several at once with **Post selected**, or use **Post summary as comment**. Then **Approve** or **Request changes** in one click.

How it works:

- Changes are reviewed against the merge base, the same diff you see. Lock files, build output, minified files, and binaries are skipped. Add more with `diffspark.ai.review.exclude`.
- Large PRs are split into parts that fit the model's context window, then consolidated into a single verdict with duplicates removed. Above `diffspark.ai.review.maxFiles` changed files, DiffSpark asks whether to review only the first files.
- Findings below `diffspark.ai.review.minSeverity` or `diffspark.ai.review.minConfidence` are hidden to reduce noise.
- The result is cached per PR. When new commits are pushed, a notice offers to run **Review again**. You can **Stop** a running review at any time.
- The review is written in your VS Code display language, or in the language set in `diffspark.ai.review.language`.

### Teach the reviewer your rules

Review rules are Markdown files that tell the AI what to focus on or consider. Write them the way you would brief a new reviewer on your team. Run **DiffSpark: Edit AI Review Rules** (or click **Edit rules…** in the AI Review section) to create or open them.

```markdown
---
applyTo: "**/*.{ts,tsx}"          # optional: only for these files (comma-separated globs)
description: TypeScript guidelines
---
# TypeScript guidelines

- **Important:** never use `any`; prefer `unknown` and narrow it.
- Prefer early returns over nested `if/else` blocks.
- Functions with more than two parameters must use an options object.

❌ Avoid
    function create(name: string, age: number, admin: boolean) {}

✅ Prefer
    function create({ name, age, admin }: CreateUserOptions) {}
```

- Without `applyTo` (or with `applyTo: "**"`), a file applies to every change. With it, the file is only sent when the part being reviewed touches matching files.
- Mark important rules (for example **Important** or *must be blocked*) and the AI treats violations as more severe.

Rules are loaded from:

| Source | Location | Notes |
| --- | --- | --- |
| **Your rules** | `review-rules/*.md` in DiffSpark's global storage | Personal and shared by every repository. Managed with **DiffSpark: Edit AI Review Rules**. |
| **Repository instructions** | `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/**/*.instructions.md` in your local checkout | The same files GitHub Copilot uses, so team conventions committed to the repo are applied automatically. Turn this off with `diffspark.ai.review.useRepositoryInstructions`. |

The rules applied in each review are listed in the **AI Review** section. Each file is capped at 20,000 characters, with 40,000 in total.

<a id="smart-filters"></a>

## 🔎 Find the right pull request, fast

Focus on what matters right now, straight from the **Pull Requests** view toolbar:

- **Status & drafts** — pick any combination of `OPEN`, `MERGED`, `DECLINED`, and `SUPERSEDED`, and choose whether drafts are included. Defaults to open pull requests without drafts.
- **Author** — every author appears with their Bitbucket avatar. The active author is shown next to the view title so you always know what you are looking at.
- **Sort** — switch anytime between **Recently updated** (newest activity first) to keep up with ongoing discussions, and **Oldest** (oldest pull requests first) to clear the review backlog.

<p align="center">
  <img src="images/pr-filters.gif" alt="Filtering pull requests by status, drafts, and author, then sorting by Oldest and back to Recently updated" width="820" />
  <br /><sub>Filter by status and drafts, pick an author, then sort by <b>Oldest</b> and back to <b>Recently updated</b>.</sub>
</p>

<p align="center">
  <img src="images/author-filter.png" alt="Author filter with Bitbucket avatars" width="820" />
</p>

<a id="file-layout"></a>

## 🗂️ A file layout that fits your flow

Some reviewers navigate by folder; others just want the list of files. Choose what works for you with **DiffSpark: Select File Layout** (or the `diffspark.files.layout` setting) — the change applies instantly and is remembered.

| Layout | Best for | Example |
| --- | --- | --- |
| **Tree** (default) | Understanding the shape of a change across modules | `src › components › castle › CastleCard.tsx` |
| **List** | Scanning many files quickly | `CastleCard.tsx - src/components/castle` |

<p align="center">
  <img src="images/file-layout.gif" alt="Switching changed files from tree to list layout" width="820" />
</p>

<a id="review-and-merge"></a>

## 💬 Review, discuss, and merge

<p align="center">
  <img src="images/pull-request-view.png" alt="DiffSpark pull request view" width="820" />
</p>

- **Native side-by-side diffs** between the common ancestor and the PR source commit — including added, removed, renamed, and fork files.
- **Inline comments** on changed lines, with existing discussions shown right in the diff.
- **Open the real file** from your checkout, or check out the PR source branch from the diff toolbar. DiffSpark warns before touching a dirty worktree; fork branches require the fork as a Git remote.
- **Markdown everywhere** — description, comments, and threaded replies.
- **Delete your own comments** (including replies) with the trash icon on hover. Deletion asks for confirmation, and placeholders keep replies intact.
- **Approve**, **Request changes** (Bitbucket's native status, with an optional explanation), and **Merge** with your choice of strategy, commit message, and source-branch cleanup.

## Quick start

1. Open a workspace with a Git repository whose remote points to `bitbucket.org`.
2. Run **DiffSpark: Connect** from the Command Palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>).
3. Enter your Bitbucket account email and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) created with **Create API token with scopes** → **Bitbucket** and these scopes:

   | Scope | Why it is needed |
   | --- | --- |
   | `read:pullrequest:bitbucket` | List pull requests and read or write comments. |
   | `write:pullrequest:bitbucket` | Approve, request changes, and merge pull requests. |
   | `read:repository:bitbucket` | List changed files (Bitbucket redirects the PR diffstat to the repository diffstat endpoint). |
   | `write:repository:bitbucket` | Close the source branch after merging. |
   | `read:user:bitbucket` | Identify your account to show the delete icon only on your own comments and your current review state. |

4. Open the **DiffSpark** view in the Activity Bar and start reviewing. 🚀

> **Tip:** with several repositories open, DiffSpark uses the one containing the active editor. Use **DiffSpark: Select Repository** to pick another.

## Jira integration

Optional. Run **DiffSpark: Connect Jira** and enter your Jira Cloud site URL (`*.atlassian.net`), account email, and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).

- The merge dialog detects Jira issue keys in the PR title, description, and source branch. Pick which issues to transition and their target statuses.
- Transitions run only after the Bitbucket merge succeeds.
- The Jira account needs **Browse Projects** and **Transition Issues** on each linked issue, and issue-level security must allow it to view the issue. API tokens inherit the account's permissions; they have no configurable scopes.

## Commands

| Command | Description |
| --- | --- |
| `DiffSpark: Connect` | Connect to Bitbucket Cloud. |
| `DiffSpark: Connect Jira` | Connect to Jira Cloud (optional). |
| `DiffSpark: Refresh` | Reload pull requests. |
| `DiffSpark: Select Repository` | Choose which open repository to review. |
| `DiffSpark: Filter Pull Requests` | Filter by status and drafts. |
| `DiffSpark: Filter Pull Requests by Author` | Show only one author's pull requests. |
| `DiffSpark: Sort Pull Requests` | Change the sort order. |
| `DiffSpark: Select File Layout` | Switch between tree and list layouts. |
| `DiffSpark: Open Pull Request` | Open the pull request view. |
| `DiffSpark: Review Pull Request with AI` | Review every change in a pull request with AI. |
| `DiffSpark: Edit AI Review Rules` | Create or open the Markdown rules that guide the AI reviewer. |
| `DiffSpark: Select AI Provider` | Choose GitHub Copilot, OpenAI, or Gemini. |
| `DiffSpark: Set AI API Key` | Store the OpenAI or Gemini API key. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `diffspark.files.layout` | `tree` | Changed files layout: `tree` or `list`. |
| `diffspark.ai.provider` | `copilot` | AI provider: `copilot`, `openai`, or `gemini`. |
| `diffspark.ai.model` | `""` | Optional model override (Copilot model family or OpenAI/Gemini model name). |
| `diffspark.ai.openaiBaseUrl` | `https://api.openai.com/v1` | Base URL for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter, local servers…). |
| `diffspark.ai.review.language` | `""` | Language of the AI review (for example `Portuguese (Brazil)` or `pt-br`). Empty uses the VS Code display language. |
| `diffspark.ai.review.minSeverity` | `minor` | Lowest severity shown: `nit`, `minor`, `major`, or `blocker`. |
| `diffspark.ai.review.minConfidence` | `0.5` | Hide findings the AI is less confident about (0–1). |
| `diffspark.ai.review.exclude` | `[]` | Extra glob patterns of files to skip (lock files, build output, and binaries are always skipped). |
| `diffspark.ai.review.focus` | `[]` | Areas to emphasize: `security`, `performance`, `tests`, `readability`, `design`. |
| `diffspark.ai.review.useRepositoryInstructions` | `true` | Also apply `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/*.instructions.md` from the checkout. |
| `diffspark.ai.review.maxFiles` | `60` | Ask before reviewing pull requests with more changed files than this. |

## Security & privacy

- Bitbucket, Jira, and AI credentials are stored in VS Code **SecretStorage** — never in settings or workspace files.
- Bitbucket redirects are followed only within `https://api.bitbucket.org/2.0/` (up to 5), so Bitbucket credentials never reach another host. Write requests are repeated only on method-preserving redirects (307/308).
- **AI context:** your draft comment is always sent to the selected provider. Inline comments also include the file path, about 17 lines around the commented line, and earlier messages in the thread; the PR view includes the PR title, description, and the parent discussion for replies.
- **Review with AI** sends the PR title, branches, and description, the diffs of the reviewed files (excluded and binary files are never sent), and the applicable review rules. The PR description and code are treated as untrusted data in the prompt, so instructions hidden in them are not followed. Findings stay local, in the workspace state, until you post them.

## Limitations

- Supports **Bitbucket Cloud** and **Jira Cloud** only (not Data Center/Server).
- Draft filtering depends on the draft metadata returned by Bitbucket.
- Merges succeed only when Bitbucket permissions, branch policies, and repository state allow them.
- Jira transition failures are reported after the merge; they do not undo it.

## Troubleshooting

Errors are logged in **Output → DiffSpark**.

| Symptom | Fix |
| --- | --- |
| HTTP 401 | Email or API token is wrong or expired — run **DiffSpark: Connect** again. |
| HTTP 403 when expanding a pull request's files | Token is missing `read:repository:bitbucket`. |
| No trash icon on your existing comments, or review buttons ignore your approval | Token is missing `read:user:bitbucket`. |
| *GitHub Copilot is not available* | Sign in to GitHub Copilot, or switch provider with **DiffSpark: Select AI Provider**. |
| Improve comment fails with HTTP 401/403 | Wrong OpenAI/Gemini key — run **DiffSpark: Set AI API Key**. |
| AI review lists *Files not reviewed* | A part of the PR failed or was too large; the details are in **Output → DiffSpark**. Re-run the review, or exclude generated files with `diffspark.ai.review.exclude`. |
| My review rules are ignored | Check the `applyTo` globs: rules are sent only when the reviewed files match them. The rules actually applied are listed in the AI Review section. |

## Development

```sh
npm install
npm test               # compile and run tests
npm run test:coverage  # tests with coverage
```

Open the folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host.

To install a local build in another project:

```sh
npx @vscode/vsce package --githubBranch main
code --install-extension diffspark-0.1.0.vsix --force
```

Issues and pull requests are welcome at [github.com/thiagopsnfg/diffspark](https://github.com/thiagopsnfg/diffspark/issues).

## Contributors

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/thiagopsnfg">
        <img src="https://github.com/thiagopsnfg.png?size=100" width="80" alt="Thiago P. Santos" /><br />
        <sub><b>Thiago P. Santos</b></sub>
      </a>
    </td>
  </tr>
</table>

Want to see your name here? [Open a pull request](https://github.com/thiagopsnfg/diffspark/pulls)! 💙

## License

Released under the [MIT License](LICENSE). © 2026 Thiago P. Santos.

<p align="center"><b>Happy reviewing!</b> ✨</p>
