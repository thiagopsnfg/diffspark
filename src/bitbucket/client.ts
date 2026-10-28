import * as https from "node:https";
import {
  BitbucketRepository,
  ChangedFile,
  MergeStrategy,
  PullRequest,
  PullRequestComment,
  PullRequestPage,
  PullRequestSort,
  PullRequestState,
  RequestOptions,
  RequestTransport,
  TransportResponse,
} from "./types";

const API_ORIGIN = "https://api.bitbucket.org";
const API_VERSION_PREFIX = "/2.0/";
const PAGE_LENGTH = 50;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isBitbucketApiUrl(url: URL): boolean {
  return url.origin === API_ORIGIN && url.pathname.startsWith(API_VERSION_PREFIX);
}

function httpsTransport(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          location: response.headers.location,
        });
      });
    });

    request.setTimeout(30_000, () => {
      request.destroy(new Error("Bitbucket request timed out after 30 seconds."));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

export class BitbucketClient {
  private readonly authorization: string;

  constructor(
    email: string,
    apiToken: string,
    private readonly transport: RequestTransport = httpsTransport,
  ) {
    this.authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async listPullRequests(
    repository: BitbucketRepository,
    states: PullRequestState[],
    includeDrafts: boolean,
    sort: PullRequestSort,
  ): Promise<PullRequest[]> {
    const path = this.repositoryPath(repository, "/pullrequests");
    const url = new URL(path, API_ORIGIN);
    url.searchParams.set("pagelen", String(PAGE_LENGTH));
    url.searchParams.set("sort", sort);
    if (states.length > 0) {
      const stateQuery =
        states.length === 1
          ? `state="${states[0]}"`
          : `state IN (${states.map((state) => `"${state}"`).join(",")})`;
      url.searchParams.set("q", stateQuery);
    }

    const pullRequests = await this.getPaginated<PullRequest>(url.toString());
    return includeDrafts
      ? pullRequests
      : pullRequests.filter((pullRequest) => pullRequest.draft !== true);
  }

  async getChangedFiles(repository: BitbucketRepository, pullRequestId: number): Promise<ChangedFile[]> {
    const path = this.pullRequestPath(repository, pullRequestId, "/diffstat");
    const entries = await this.getPaginated<{
      new?: { path?: string };
      old?: { path?: string };
      status?: string;
    }>(new URL(path, API_ORIGIN).toString());

    return entries.flatMap((entry) => {
      const filePath = entry.new?.path ?? entry.old?.path;
      return filePath ? [{ path: filePath, status: entry.status }] : [];
    });
  }

  getComments(repository: BitbucketRepository, pullRequestId: number): Promise<PullRequestComment[]> {
    const path = this.pullRequestPath(repository, pullRequestId, "/comments");
    return this.getPaginated<PullRequestComment>(new URL(path, API_ORIGIN).toString());
  }

  createComment(
    repository: BitbucketRepository,
    pullRequestId: number,
    markdown: string,
    parentId?: number,
  ): Promise<PullRequestComment> {
    const path = this.pullRequestPath(repository, pullRequestId, "/comments");
    return this.request(new URL(path, API_ORIGIN).toString(), {
      method: "POST",
      body: {
        content: { raw: markdown },
        ...(parentId === undefined ? {} : { parent: { id: parentId } }),
      },
    });
  }

  approve(repository: BitbucketRepository, pullRequestId: number): Promise<void> {
    const path = this.pullRequestPath(repository, pullRequestId, "/approve");
    return this.request(new URL(path, API_ORIGIN).toString(), { method: "POST" });
  }

  merge(
    repository: BitbucketRepository,
    pullRequestId: number,
    strategy: MergeStrategy,
    closeSourceBranch = false,
  ): Promise<void> {
    const path = this.pullRequestPath(repository, pullRequestId, "/merge");
    return this.request(new URL(path, API_ORIGIN).toString(), {
      method: "POST",
      body: { merge_strategy: strategy, close_source_branch: closeSourceBranch },
    });
  }

  private repositoryPath(repository: BitbucketRepository, suffix: string): string {
    return `${API_VERSION_PREFIX}repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.slug)}${suffix}`;
  }

  private pullRequestPath(
    repository: BitbucketRepository,
    pullRequestId: number,
    suffix: string,
  ): string {
    return `${this.repositoryPath(repository, `/pullrequests/${pullRequestId}`)}${suffix}`;
  }

  private async getPaginated<T>(initialUrl: string): Promise<T[]> {
    const values: T[] = [];
    let nextUrl: string | undefined = initialUrl;

    while (nextUrl) {
      const page: PullRequestPage<T> = await this.request<PullRequestPage<T>>(nextUrl, { method: "GET" });
      values.push(...page.values);
      nextUrl = page.next;
      if (nextUrl && !isBitbucketApiUrl(new URL(nextUrl))) {
        throw new Error("Bitbucket returned a pagination link outside its REST API.");
      }
    }

    return values;
  }

  private async request<T>(url: string, options: RequestOptions): Promise<T> {
    let method = options.method ?? "GET";
    let headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authorization,
    };
    let body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let currentUrl = url;
    let response = await this.transport(currentUrl, method, headers, body);
    for (let redirects = 0; REDIRECT_STATUSES.has(response.statusCode); redirects++) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Bitbucket exceeded the limit of ${MAX_REDIRECTS} redirects.`);
      }
      currentUrl = this.resolveRedirect(currentUrl, response);

      if (response.statusCode === 303) {
        method = "GET";
        body = undefined;
        headers = { Accept: headers.Accept, Authorization: headers.Authorization };
      } else if (method !== "GET" && response.statusCode !== 307 && response.statusCode !== 308) {
        // A 301/302 would turn the write into a GET, so report it instead of claiming success.
        throw new Error(
          `Bitbucket redirected ${method} ${new URL(url).pathname} with HTTP ${response.statusCode}; the request was not repeated.`,
        );
      }

      response = await this.transport(currentUrl, method, headers, body);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(this.formatApiError(response));
    }
    if (!response.body.trim()) {
      return undefined as T;
    }

    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new Error(`Bitbucket returned invalid JSON for ${method} ${new URL(url).pathname}.`);
    }
  }

  private resolveRedirect(currentUrl: string, response: TransportResponse): string {
    if (!response.location) {
      throw new Error(`Bitbucket returned HTTP ${response.statusCode} without a Location header.`);
    }

    let target: URL;
    try {
      target = new URL(response.location, currentUrl);
    } catch {
      throw new Error("Bitbucket returned an invalid redirect location.");
    }
    // The Authorization header is resent, so only follow redirects that stay on the REST API.
    if (!isBitbucketApiUrl(target)) {
      throw new Error("Bitbucket redirected outside its REST API; the request was not followed.");
    }
    return target.toString();
  }

  private formatApiError(response: TransportResponse): string {
    let detail = response.body;
    try {
      const body = JSON.parse(response.body) as {
        error?: { message?: string };
        message?: string;
      };
      detail = body.error?.message ?? body.message ?? response.body;
    } catch {
      // Keep plain-text API errors visible to the user.
    }

    const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : "";
    return `Bitbucket API request failed with HTTP ${response.statusCode}${suffix}`;
  }
}
