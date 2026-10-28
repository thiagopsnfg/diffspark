export interface BitbucketRepository {
  workspace: string;
  slug: string;
  fullName: string;
}

export type PullRequestState = "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";

export type PullRequestSort = "created_on" | "-updated_on";

export interface PullRequest {
  id: number;
  title: string;
  description?: string;
  state: PullRequestState;
  draft?: boolean;
  created_on: string;
  updated_on: string;
  author?: {
    display_name?: string;
  };
  source: {
    commit?: { hash: string };
    repository?: { full_name: string };
    branch: {
      name: string;
    };
  };
  destination: {
    commit?: { hash: string };
    branch: {
      name: string;
    };
  };
  links?: {
    html?: {
      href?: string;
    };
  };
}

export interface PullRequestComment {
  id: number;
  content?: {
    raw?: string;
    html?: string;
  };
  inline?: PullRequestInlineComment;
  parent?: {
    id: number;
  };
  created_on?: string;
  user?: {
    display_name?: string;
  };
}

export interface PullRequestInlineComment {
  path: string;
  from?: number;
  to?: number;
}

export interface ChangedFile {
  path: string;
  status?: string;
  oldPath?: string;
  newPath?: string;
}

export interface PullRequestPage<T> {
  values: T[];
  next?: string;
}

export type MergeStrategy = "merge_commit" | "squash" | "fast_forward";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  raw?: boolean;
}

export interface TransportResponse {
  statusCode: number;
  body: string;
  location?: string;
}

export type RequestTransport = (
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
) => Promise<TransportResponse>;
