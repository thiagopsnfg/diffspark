import { structuredPatch } from "diff";
import { minimatch } from "minimatch";

export interface DiffLine {
  kind: "+" | "-" | " ";
  /** 1-based line number in the new file (undefined for removed lines). */
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: string;
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
}

export const DEFAULT_REVIEW_EXCLUDES: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/go.sum",
  "**/node_modules/**",
  "**/dist/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.{png,jpg,jpeg,gif,bmp,ico,webp,avif,svgz,pdf,zip,gz,tgz,rar,7z,jar,war,class,exe,dll,so,dylib,woff,woff2,ttf,otf,eot,mp3,mp4,mov,avi,webm,wav,vsix}",
];

export const DEFAULT_CONTEXT_LINES = 3;

export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().replace(/^\.\//, "");
  if (!normalizedPattern) {
    return false;
  }
  return minimatch(path, normalizedPattern, { dot: true, matchBase: !normalizedPattern.includes("/"), nocase: false });
}

export function isExcludedPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

export function looksBinary(content: string): boolean {
  return content.slice(0, 8_000).includes("\u0000");
}

export function buildFileDiff(options: {
  path: string;
  oldPath?: string;
  status?: string;
  before: string;
  after: string;
  contextLines?: number;
}): FileDiff {
  const { path, oldPath, before, after } = options;
  const patch = structuredPatch(oldPath ?? path, path, before, after, "", "", {
    context: options.contextLines ?? DEFAULT_CONTEXT_LINES,
  });
  let addedLines = 0;
  let removedLines = 0;
  const hunks = patch.hunks.map((hunk): DiffHunk => {
    let newLine = hunk.newStart;
    const lines: DiffLine[] = [];
    for (const raw of hunk.lines) {
      const kind = raw.charAt(0);
      const text = raw.slice(1);
      if (kind === "+") {
        lines.push({ kind, newLine, text });
        newLine++;
        addedLines++;
      } else if (kind === "-") {
        lines.push({ kind, text });
        removedLines++;
      } else if (kind === " ") {
        lines.push({ kind, newLine, text });
        newLine++;
      }
      // "\ No newline at end of file" markers are ignored.
    }
    return { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines };
  });
  return {
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    status: options.status ?? "modified",
    hunks,
    addedLines,
    removedLines,
  };
}

/** Lines of the new file that appear in the diff (added or context) and can receive inline comments. */
export function commentableLines(file: FileDiff): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) {
        lines.add(line.newLine);
      }
    }
  }
  return lines;
}

export function addedLineNumbers(file: FileDiff): number[] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => (line.kind === "+" && line.newLine !== undefined ? [line.newLine] : [])),
  );
}

export function formatHunk(hunk: DiffHunk): string {
  const width = String(hunk.newStart + Math.max(hunk.newLines, 1)).length;
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const body = hunk.lines.map((line) => {
    const number = line.newLine === undefined ? "" : String(line.newLine);
    return `${number.padStart(width, " ")} ${line.kind} ${line.text}`;
  });
  return [header, ...body].join("\n");
}

export function describeFileHeader(file: Pick<FileDiff, "path" | "oldPath" | "status">): string {
  const details = [file.status];
  if (file.oldPath) {
    details.push(`renamed from ${file.oldPath}`);
  }
  return `### File: ${file.path} (${details.join(", ")})`;
}

export function formatFileDiff(file: FileDiff, hunks: readonly DiffHunk[] = file.hunks, part?: { index: number; count: number }): string {
  const header = describeFileHeader(file) + (part && part.count > 1 ? ` [part ${part.index}/${part.count}]` : "");
  if (hunks.length === 0) {
    return `${header}\n(no textual changes)`;
  }
  return `${header}\n${hunks.map(formatHunk).join("\n")}`;
}
