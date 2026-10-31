import type {PullRequest, ReviewState} from "./types";

export function getReviewState(
    pullRequest: PullRequest,
    accountId: string | undefined,
): ReviewState {
    if (!accountId) {
        return "none";
    }
    const participant = pullRequest.participants?.find(
        (entry) => entry.user?.account_id === accountId,
    );
    if (participant?.state === "changes_requested") {
        return "changes_requested";
    }
    return participant?.state === "approved" || participant?.approved
        ? "approved"
        : "none";
}
