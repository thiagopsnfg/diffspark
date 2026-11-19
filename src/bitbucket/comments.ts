import type {ChangedFile, PullRequestComment, PullRequestInlineComment} from "./types";

export function getCommentLocations(
    comments: PullRequestComment[],
): Map<number, PullRequestInlineComment> {
    const commentsById = new Map(
        comments.map((comment) => [comment.id, comment] as const),
    );
    const locations = new Map<number, PullRequestInlineComment>();

    for (const comment of comments) {
        const visited = new Set<number>();
        let current: PullRequestComment | undefined = comment;
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            if (current.inline?.path) {
                locations.set(comment.id, current.inline);
                break;
            }
            current = current.parent ? commentsById.get(current.parent.id) : undefined;
        }
    }

    return locations;
}

export function getCommentedPaths(comments: PullRequestComment[]): Set<string> {
    const locations = getCommentLocations(comments);
    const paths = new Set<string>();
    for (const comment of comments) {
        if (comment.deleted) {
            continue;
        }
        const path = locations.get(comment.id)?.path;
        if (path) {
            paths.add(path);
        }
    }
    return paths;
}

export function findChangedFileForLocation(
    files: ChangedFile[],
    location: PullRequestInlineComment,
): ChangedFile | undefined {
    return files.find((file) =>
        [file.path, file.newPath, file.oldPath].some((path) => path === location.path),
    );
}
