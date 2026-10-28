# DiffSpark

![DiffSpark — Smarter reviews. Better code.](resources/diffspark-logo.svg)

**Smarter reviews. Better code.**

A VS Code extension for reviewing Bitbucket Cloud pull requests from the active Git repository.

## Features

- Lists pull requests from the active Bitbucket Cloud repository.
- Defaults to open pull requests with drafts hidden; filter by status and choose whether drafts are included.
- Sorts oldest-first or by most recently updated.
- Expands changed files as folders and files in their repository paths.
- Shows the pull request description and Markdown comments, supports Markdown comments and threaded replies, and can approve or merge.
- Requires confirmation before sending a merge request.

The first version does not implement the native **Change Requested** action or Jira issue transitions. The `bitbucket.org/!api/.../request-changes` route is an undocumented Bitbucket web UI endpoint, so the extension does not rely on it.

## Setup

1. Open a workspace containing the Git repository whose pull requests you want to review. Its remote must point to `bitbucket.org`.
2. Run **DiffSpark: Connect** from the Command Palette.
3. Enter the email address associated with your Bitbucket account and a Bitbucket API token. Create it at <https://id.atlassian.com/manage-profile/security/api-tokens> with **Create API token with scopes** → **Bitbucket**, and grant these scopes:
   - `read:pullrequest:bitbucket` — list pull requests and read or write comments.
   - `write:pullrequest:bitbucket` — approve and merge pull requests.
   - `read:repository:bitbucket` — list changed files. Bitbucket redirects the pull request diffstat to the repository diffstat endpoint, which requires this scope.
4. The credentials are stored in VS Code `SecretStorage`, not workspace settings or files.
5. Open the **DiffSpark** activity bar view. Use its toolbar to refresh, select a repository, change filters, or sort.

If several Git repositories are open, the extension uses the repository containing the active editor when possible. Use **DiffSpark: Select Repository** to choose another one.

## Development

```sh
npm install
npm test
npm run test:coverage
npm run compile
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host.

## Limitations

- Bitbucket Cloud is supported; Bitbucket Data Center/Server is not supported.
- Draft filtering depends on the draft metadata returned by Bitbucket Cloud.
- Native “Change Requested” and Jira transitions are deferred rather than simulated.
- Merge succeeds only when Bitbucket permissions, branch policies, and repository state allow it.
- The merge panel lets you select a merge strategy and whether to close the source branch.
- Redirects are followed only within `https://api.bitbucket.org/2.0/` (up to 5), so your credentials are never sent to another host. Write requests are repeated only on method-preserving redirects (307/308).

## Troubleshooting

Errors are logged in **Output → DiffSpark**.

- **HTTP 401** — the email or API token is wrong or expired. Run **DiffSpark: Connect** again.
- **HTTP 403 when expanding a pull request's files** — the token is missing `read:repository:bitbucket`.
