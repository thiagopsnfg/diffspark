export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";
export type ReviewCategory = "bug" | "security" | "performance" | "readability" | "tests" | "design" | "rule";
export type ReviewVerdict = "approve" | "comment" | "request_changes";
export type FindingStatus = "open" | "posted" | "dismissed";

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["blocker", "major", "minor", "nit"];
export const REVIEW_CATEGORIES: readonly ReviewCategory[] = [
  "bug",
  "security",
  "performance",
  "readability",
  "tests",
  "design",
  "rule",
];
export const REVIEW_FOCUS_AREAS = ["security", "performance", "tests", "readability", "design"] as const;
export type ReviewFocus = typeof REVIEW_FOCUS_AREAS[number];

export interface AiReviewFinding {
  id: string;
  file: string;
  /** 1-based line in the new version of the file; undefined for file-level findings. */
  line?: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  rule?: string;
  title: string;
  body: string;
  suggestion?: string;
  confidence: number;
  status: FindingStatus;
}

export interface AppliedRule {
  source: string;
  description?: string;
  truncated?: boolean;
}

export interface AiReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: AiReviewFinding[];
  sourceCommit?: string;
  createdAt: string;
  provider: string;
  filesReviewed: string[];
  filesSkipped: string[];
  rules: AppliedRule[];
  language: string;
}

export interface ReviewRule {
  /** Where the rule came from, e.g. "global/general.md" or "repo/AGENTS.md". */
  source: string;
  description?: string;
  /** Glob patterns; empty means the rule applies to every file. */
  applyTo: string[];
  content: string;
  truncated?: boolean;
}

export interface PullRequestContext {
  title: string;
  description?: string;
  sourceBranch: string;
  destinationBranch: string;
}
