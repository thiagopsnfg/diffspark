# DiffSpark

![DiffSpark — Smarter reviews. Better code.](resources/diffspark-logo.png)

**Smarter reviews. Better code.**

A VS Code extension for reviewing Bitbucket Cloud pull requests from the active Git repository.

## Features

- Lists pull requests from the active Bitbucket Cloud repository.
- Defaults to open pull requests with drafts hidden; filter by status and choose whether drafts are included.
- Filters by author (all authors by default), showing each author's Bitbucket avatar before their name, with an account icon when no avatar is available.
- Sorts oldest-first or by most recently updated.
- Displays changed files in a folder tree (default) or a flat list with the file name followed by its folder path, such as `text.js - src/sub/folder`. Root-level files show only their names. Use **DiffSpark: Select File Layout** in the view toolbar or Command Palette, or set `diffspark.files.layout` to `tree` or `list`. The preference is saved and applies immediately.
- Opens a side-by-side diff when clicking a changed file, using the common ancestor and the PR source commit from Bitbucket, including added, removed, and renamed files. Add inline comments to changed lines and view existing inline discussions directly in the diff.
- The diff editor toolbar can open the file from the current checkout or check out the pull request source branch and open the file. Checking out warns before changing a dirty worktree; source branches from forks require that fork to be configured as a Git remote.
- Shows the pull request description and Markdown comments, supports Markdown comments and threaded replies, and can approve, request changes, or merge.
- Delete published comments using the trash icon in the header of each of your own diff comments (including replies), or **Delete** in the pull request view. In the diff, the icon appears when you hover over or focus the comment; it is not a thread-wide action. Deletion requires confirmation and Bitbucket permission; permission errors are shown without removing the comment locally. Deleted comments remain as placeholders so replies are preserved.
- **Request changes** uses Bitbucket's native change-request status and can optionally post a Markdown comment explaining what to adjust.
- The merge dialog lets you choose a strategy, edit the commit message, and optionally close the source branch.
- When Jira is connected, the merge dialog finds Jira issue keys in the PR title, description, and source branch. Select which issues to transition and their target statuses; Jira transitions run after the Bitbucket merge succeeds.
- **Improve comment** (AI): works like Jira's *Improve description*. Write a comment, click **Improve comment**, and review an editable AI suggestion. The default makes it clearer, more polite, and more objective, and adds an example when it helps. The suggestion keeps your comment's language. The AI actions dropdown offers **Improve formatting**, **Fix spelling and grammar**, **Remix**, **Change tone** (professional, empathetic, casual, neutral, educational), **Make shorter**, **Make longer**, **Add code example**, and **Translate options**. See [Improve comment with AI](#improve-comment-with-ai).

## Improve comment with AI

- **Pull request view**: the comment box has a toolbar with **Improve comment** and an AI dropdown (✦ ▾). The suggestion appears below the box, where you can edit it and then choose **Replace**, **Insert below**, **Try again**, or **Discard**. Use **Stop** to cancel a running request.
- **Diff inline comments**: next to **Comment**/**Reply** there are **Improve comment** and **AI actions ▾** buttons. The suggestion appears in the thread as an editable *AI suggestion* with **Replace & post**, **Insert below**, **Try again**, and **Discard**.
  - VS Code clears its native comment box after any button runs, so your original text is never lost. **Discard** and **Insert below** turn it into an editable *Draft* that you can **Post**, **Improve** again, or **Delete**.
- Context sent to the AI:
  - always: your draft comment;
  - for inline comments: the file path, about 17 lines of code around the commented line, and the earlier messages in the thread;
  - in the pull request view: the PR title and description, plus the parent discussion for replies.

Providers (run **DiffSpark: Select AI Provider**):

| Provider | Setup |
| --- | --- |
| GitHub Copilot (default) | Uses the VS Code Language Model API and your Copilot subscription. No API key. VS Code asks once to allow DiffSpark to use Copilot. |
| OpenAI | Run **DiffSpark: Set AI API Key**. Default model `gpt-4o-mini`. `diffspark.ai.openaiBaseUrl` lets you use any OpenAI-compatible endpoint (HTTPS, or HTTP on localhost). |
| Google Gemini | Run **DiffSpark: Set AI API Key** with a [Google AI Studio](https://aistudio.google.com/apikey) key. Default model `gemini-2.5-flash`. |

- API keys are stored in VS Code `SecretStorage`.
- `diffspark.ai.model` overrides the model: a Copilot model family, or an OpenAI/Gemini model name.
- Privacy: your draft comment and the context listed above are sent to the selected provider.

## Setup

1. Open a workspace containing the Git repository whose pull requests you want to review. Its remote must point to `bitbucket.org`.
2. Run **DiffSpark: Connect** from the Command Palette.
3. Enter the email address associated with your Bitbucket account and a Bitbucket API token. Create it at <https://id.atlassian.com/manage-profile/security/api-tokens> with **Create API token with scopes** → **Bitbucket**, and grant these scopes:
   - `read:pullrequest:bitbucket` — list pull requests and read or write comments.
   - `write:pullrequest:bitbucket` — approve, request changes, and merge pull requests.
   - `read:repository:bitbucket` — list changed files. Bitbucket redirects the pull request diffstat to the repository diffstat endpoint, which requires this scope.
   - `write:repository:bitbucket` — close the source branch after merging.
   - `read:user:bitbucket` — identify your account so the diff shows the trash icon only on your own comments, and the pull request view shows whether you already approved or requested changes. Without it, existing diff comments have no trash icon and the extension warns you to reconnect with this scope; newly posted comments can still be deleted. The review state shows "none" until you approve or request changes.
4. The credentials are stored in VS Code `SecretStorage`, not workspace settings or files.
5. Open the **DiffSpark** activity bar view. Use its toolbar to refresh, select a repository, change filters, filter by author, or sort.
6. Jira transitions are optional. Run **DiffSpark: Connect Jira** and enter your Jira Cloud site URL, Jira account email, and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens). The token is used with HTTPS Basic authentication and stored in VS Code `SecretStorage`.
   - The Jira account needs **Browse Projects** and **Transition Issues** for each linked issue. Issue-level security must also allow the account to view the issue.
   - Atlassian API tokens used by this extension do not have configurable permission scopes; they inherit the Jira account's permissions. For OAuth 2.0 integrations, Jira's classic scopes are `read:jira-work` (read issues and transitions) and `write:jira-work` (perform transitions), but this extension does not use OAuth.
   - Only Jira Cloud site URLs ending in `.atlassian.net` are supported.

If several Git repositories are open, the extension uses the repository containing the active editor when possible. Use **DiffSpark: Select Repository** to choose another one.

## Development

```sh
npm install
npm test
npm run test:coverage
npm run compile
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host.

## Install locally in another project

```sh
npx @vscode/vsce package --githubBranch main
code --install-extension diffspark-0.1.0.vsix --force
```

Reload VS Code, open the target repository, and run **DiffSpark: Connect**.

## Limitations

- Bitbucket Cloud is supported; Bitbucket Data Center/Server is not supported.
- Draft filtering depends on the draft metadata returned by Bitbucket Cloud.
- Merge succeeds only when Bitbucket permissions, branch policies, and repository state allow it.
- Jira transition failures are reported after a successful merge; they do not undo or mark the Bitbucket merge as failed.
- Redirects are followed only within `https://api.bitbucket.org/2.0/` (up to 5), so your credentials are never sent to another host. Write requests are repeated only on method-preserving redirects (307/308).

## Troubleshooting

Errors are logged in **Output → DiffSpark**.

- **HTTP 401** — the email or API token is wrong or expired. Run **DiffSpark: Connect** again.
- **HTTP 403 when expanding a pull request's files** — the token is missing `read:repository:bitbucket`.
- **Review buttons don't reflect an existing approval or change request** — the token is missing `read:user:bitbucket`.
- **Improve comment says GitHub Copilot is not available** — sign in to GitHub Copilot in VS Code, or switch providers with **DiffSpark: Select AI Provider**.
- **Improve comment fails with HTTP 401/403** — the OpenAI/Gemini API key is wrong. Run **DiffSpark: Set AI API Key**.
