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
        account_id?: string;
        links?: {
            avatar?: {href?: string};
        };
    };
    source: {
        commit?: {hash: string};
        repository?: {full_name: string};
        branch: {
            name: string;
        };
    };
    destination: {
        commit?: {hash: string};
        branch: {
            name: string;
        };
    };
    participants?: PullRequestParticipant[];
    links?: {
        html?: {
            href?: string;
        };
    };
}

export interface PullRequestParticipant {
    user?: {account_id?: string};
    approved?: boolean;
    state?: "approved" | "changes_requested" | null;
}

export type ReviewState = "none" | "approved" | "changes_requested";

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface PullRequestComment {
    id: number;
    deleted?: boolean;
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
        account_id?: string;
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
    method?: HttpMethod;
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
    method: HttpMethod,
    headers: Record<string, string>,
    body?: string,
) => Promise<TransportResponse>;
