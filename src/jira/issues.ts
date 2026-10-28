import { PullRequest } from "../bitbucket/types";

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9_]*-\d+\b/g;

export function extractJiraIssueKeys(pullRequest: PullRequest): string[] {
  const text = [
    pullRequest.title,
    pullRequest.description ?? "",
    pullRequest.source.branch.name,
  ].join("\n");
  return [...new Set(text.match(ISSUE_KEY_PATTERN) ?? [])];
}
