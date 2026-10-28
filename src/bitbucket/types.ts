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
    branch: {
      name: string;
    };
  };
  destination: {
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
  parent?: {
    id: number;
  };
  created_on?: string;
  user?: {
    display_name?: string;
  };
}

export interface ChangedFile {
  path: string;
  status?: string;
}

export interface PullRequestPage<T> {
  values: T[];
  next?: string;
}

export type MergeStrategy = "merge_commit" | "squash" | "fast_forward";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
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
