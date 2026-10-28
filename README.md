# DiffSpark

![DiffSpark — Smarter reviews. Better code.](resources/diffspark-logo.png)

**Smarter reviews. Better code.**

A VS Code extension for reviewing Bitbucket Cloud pull requests from the active Git repository.

## Features

- Lists pull requests from the active Bitbucket Cloud repository.
- Defaults to open pull requests with drafts hidden; filter by status and choose whether drafts are included.
- Sorts oldest-first or by most recently updated.
- Expands changed files as folders and files in their repository paths.
- Opens a side-by-side diff when clicking a changed file, using the common ancestor and the PR source commit from Bitbucket, including added, removed, and renamed files. Add inline comments to changed lines and view existing inline discussions directly in the diff.
- The diff editor toolbar can open the file from the current checkout or check out the pull request source branch and open the file. Checking out warns before changing a dirty worktree; source branches from forks require that fork to be configured as a Git remote.
- Shows the pull request description and Markdown comments, supports Markdown comments and threaded replies, and can approve, request changes, or merge.
- **Request changes** uses Bitbucket's native change-request status and can optionally post a Markdown comment explaining what to adjust.
- The merge dialog lets you choose a strategy, edit the commit message, and optionally close the source branch.
- When Jira is connected, the merge dialog finds Jira issue keys in the PR title, description, and source branch. Select which issues to transition and their target statuses; Jira transitions run after the Bitbucket merge succeeds.

## Setup

1. Open a workspace containing the Git repository whose pull requests you want to review. Its remote must point to `bitbucket.org`.
2. Run **DiffSpark: Connect** from the Command Palette.
3. Enter the email address associated with your Bitbucket account and a Bitbucket API token. Create it at <https://id.atlassian.com/manage-profile/security/api-tokens> with **Create API token with scopes** → **Bitbucket**, and grant these scopes:
   - `read:pullrequest:bitbucket` — list pull requests and read or write comments.
   - `write:pullrequest:bitbucket` — approve, request changes, and merge pull requests.
   - `read:repository:bitbucket` — list changed files. Bitbucket redirects the pull request diffstat to the repository diffstat endpoint, which requires this scope.
   - `write:repository:bitbucket` — close the source branch after merging.
4. The credentials are stored in VS Code `SecretStorage`, not workspace settings or files.
5. Open the **DiffSpark** activity bar view. Use its toolbar to refresh, select a repository, change filters, or sort.
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
