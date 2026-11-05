import type {ChangedFile, FileConflict} from "./types";

export function markConflictedFiles(
    files: ChangedFile[],
    conflicts: FileConflict[],
): ChangedFile[] {
    if (conflicts.length === 0) {
        return files;
    }
    const conflictedPaths = new Set(conflicts.map(({path}) => path));
    return files.map((file) =>
        [file.path, file.newPath, file.oldPath].some(
            (path) => path !== undefined && conflictedPaths.has(path),
        )
            ? {...file, conflicted: true}
            : file,
    );
}
