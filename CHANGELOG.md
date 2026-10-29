# Changelog

All notable changes to DiffSpark are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-29

Initial release.

### Added

- **Bitbucket Cloud pull requests** in a dedicated activity bar view, loaded automatically on startup and refreshed when the repository changes.
- **Smart filters**: status (`OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED`), drafts, author (with Bitbucket avatars), and sorting by *Recently updated* or *Oldest*.
- **File layout** toggle for changed files: tree or list.
- **Native side-by-side diffs** between the merge base and the PR source commit, including added, removed, renamed, and fork files.
- **Inline comments** on changed lines, threaded replies, and Markdown rendering for descriptions and comments.
- **Delete your own comments** with confirmation; placeholders keep replies intact.
- **Open the real file** or **check out the PR source branch** from the diff toolbar, with a warning before touching a dirty worktree.
- **Approve**, **Request changes**, and **Merge** with strategy, commit message, and source-branch cleanup options.
- **Jira Cloud integration**: detect issue keys in the PR and transition the selected issues after a successful merge.
- **AI comment assistant**: improve a comment, change its tone, or translate it, with Replace, Insert below, Try again, and Discard actions.
- **Review with AI**: verdict, findings grouped by severity, drafts shown in the diff, and custom team review rules.
- Credentials for Bitbucket, Jira, and AI providers stored in VS Code SecretStorage.

[0.1.0]: https://github.com/thiagopsnfg/diffspark/releases/tag/v0.1.0
