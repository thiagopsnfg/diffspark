import * as https from "node:https";
import type {HttpMethod, RequestTransport, TransportResponse} from "../bitbucket/types";

interface JiraIssueResponse {
    key: string;
    fields: {
        summary: string;
        issuetype: {name: string};
    };
}

export interface JiraIssue {
    key: string;
    summary: string;
    issueType: string;
}

export interface JiraTransition {
    id: string;
    name: string;
    to: {
        name: string;
        statusCategory?: {key?: string};
    };
}

interface JiraTransitionsResponse {
    transitions: JiraTransition[];
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function httpsTransport(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    body?: string,
): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
        const request = https.request(new URL(url), {method, headers}, (response) => {
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
            request.destroy(new Error("Jira request timed out after 30 seconds."));
        });
        request.on("error", reject);
        if (body) {
            request.write(body);
        }
        request.end();
    });
}

export class JiraClient {
    private readonly authorization: string;
    private readonly origin: string;
    private readonly transport: RequestTransport;

    constructor(
        siteUrl: string,
        email: string,
        apiToken: string,
        transport: RequestTransport = httpsTransport,
    ) {
        const site = new URL(siteUrl);
        if (
            site.protocol !== "https:" ||
            !site.hostname.endsWith(".atlassian.net") ||
            site.port !== "" ||
            site.username ||
            site.password ||
            site.search ||
            site.hash ||
            (site.pathname !== "/" && site.pathname !== "")
        ) {
            throw new Error(
                "Enter a Jira Cloud site URL such as https://example.atlassian.net.",
            );
        }
        this.origin = site.origin;
        this.authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
        this.transport = transport;
    }

    async getIssue(issueKey: string): Promise<JiraIssue> {
        const url = new URL(
            `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
            this.origin,
        );
        url.searchParams.set("fields", "summary,issuetype");
        const issue = await this.request<JiraIssueResponse>(url.toString(), "GET");
        if (
            !issue ||
            typeof issue.key !== "string" ||
            typeof issue.fields?.summary !== "string" ||
            typeof issue.fields?.issuetype?.name !== "string"
        ) {
            throw new Error(`Jira returned invalid issue data for ${issueKey}.`);
        }
        return {
            key: issue.key,
            summary: issue.fields.summary,
            issueType: issue.fields.issuetype.name,
        };
    }

    async getTransitions(issueKey: string): Promise<JiraTransition[]> {
        const url = new URL(
            `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
            this.origin,
        );
        const response = await this.request<JiraTransitionsResponse>(
            url.toString(),
            "GET",
        );
        if (!response || !Array.isArray(response.transitions)) {
            throw new Error(`Jira returned invalid transition data for ${issueKey}.`);
        }
        return response.transitions.filter(isJiraTransition);
    }

    async transition(issueKey: string, transitionId: string): Promise<void> {
        const url = new URL(
            `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
            this.origin,
        );
        await this.request(url.toString(), "POST", {transition: {id: transitionId}});
    }

    private async request<T>(
        url: string,
        method: "GET" | "POST",
        body?: unknown,
    ): Promise<T> {
        let currentUrl = url;
        let currentMethod = method;
        let requestBody = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: this.authorization,
        };
        if (requestBody !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        let response = await this.transport(
            currentUrl,
            currentMethod,
            headers,
            requestBody,
        );
        for (let redirects = 0; REDIRECT_STATUSES.has(response.statusCode); redirects++) {
            if (redirects >= MAX_REDIRECTS) {
                throw new Error(`Jira exceeded the limit of ${MAX_REDIRECTS} redirects.`);
            }
            if (!response.location) {
                throw new Error(
                    `Jira returned HTTP ${response.statusCode} without a Location header.`,
                );
            }

            const target = new URL(response.location, currentUrl);
            if (
                target.protocol !== "https:" ||
                target.origin !== this.origin ||
                !target.pathname.startsWith("/rest/api/3/")
            ) {
                throw new Error(
                    "Jira redirected outside its REST API; the request was not followed.",
                );
            }
            if (response.statusCode === 303) {
                currentMethod = "GET";
                requestBody = undefined;
                delete headers["Content-Type"];
            } else if (
                currentMethod !== "GET" &&
                response.statusCode !== 307 &&
                response.statusCode !== 308
            ) {
                throw new Error(
                    `Jira redirected ${currentMethod} ${new URL(url).pathname} with HTTP ${response.statusCode}; the request was not repeated.`,
                );
            }
            currentUrl = target.toString();
            response = await this.transport(
                currentUrl,
                currentMethod,
                headers,
                requestBody,
            );
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            let detail = response.body;
            try {
                const parsed = JSON.parse(response.body) as {
                    errorMessages?: string[];
                    message?: string;
                };
                detail =
                    parsed.errorMessages?.join("; ") ?? parsed.message ?? response.body;
            } catch {
                // Keep plain-text API errors visible to the user.
            }
            const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : "";
            throw new Error(
                `Jira API request failed with HTTP ${response.statusCode}${suffix}`,
            );
        }
        if (!response.body.trim()) {
            return undefined as T;
        }
        try {
            return JSON.parse(response.body) as T;
        } catch {
            throw new Error(
                `Jira returned invalid JSON for ${method} ${new URL(url).pathname}.`,
            );
        }
    }
}

function isJiraTransition(value: unknown): value is JiraTransition {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Partial<JiraTransition>;
    return (
        typeof candidate.id === "string" &&
        /^\d+$/.test(candidate.id) &&
        typeof candidate.name === "string" &&
        typeof candidate.to?.name === "string"
    );
}
