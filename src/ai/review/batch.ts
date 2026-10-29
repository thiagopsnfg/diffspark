import { DiffHunk, FileDiff, formatFileDiff, formatHunk } from "./diff";

export interface DiffChunk {
  file: FileDiff;
  hunks: DiffHunk[];
  part: { index: number; count: number };
  text: string;
}

const HEADER_ALLOWANCE = 300;

function splitHunk(hunk: DiffHunk, maxChars: number): DiffHunk[] {
  if (formatHunk(hunk).length <= maxChars) {
    return [hunk];
  }
  const pieces: DiffHunk[] = [];
  let current: DiffHunk["lines"] = [];
  let size = 0;
  let oldCursor = hunk.oldStart;
  let pieceOldStart = oldCursor;
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const newNumbers = current.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine]));
    const oldCount = current.filter((line) => line.kind !== "+").length;
    pieces.push({
      oldStart: pieceOldStart,
      oldLines: oldCount,
      newStart: newNumbers[0] ?? hunk.newStart,
      newLines: newNumbers.length,
      lines: current,
    });
    current = [];
    size = 0;
    pieceOldStart = oldCursor;
  };
  for (const line of hunk.lines) {
    const lineSize = line.text.length + 12;
    if (size + lineSize > maxChars && current.length > 0) {
      flush();
    }
    current.push(line);
    size += lineSize;
    if (line.kind !== "+") {
      oldCursor++;
    }
  }
  flush();
  return pieces;
}

export function splitFileDiff(file: FileDiff, maxChars: number): DiffChunk[] {
  const whole = formatFileDiff(file);
  if (whole.length <= maxChars) {
    return [{ file, hunks: file.hunks, part: { index: 1, count: 1 }, text: whole }];
  }
  const budget = Math.max(maxChars - HEADER_ALLOWANCE, 1_000);
  const hunks = file.hunks.flatMap((hunk) => splitHunk(hunk, budget));
  const groups: DiffHunk[][] = [];
  let group: DiffHunk[] = [];
  let size = 0;
  for (const hunk of hunks) {
    const hunkSize = formatHunk(hunk).length + 1;
    if (size + hunkSize > budget && group.length > 0) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(hunk);
    size += hunkSize;
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups.map((items, index) => {
    const part = { index: index + 1, count: groups.length };
    return { file, hunks: items, part, text: formatFileDiff(file, items, part) };
  });
}

/** Packs file diffs into batches whose formatted size stays under maxChars (large files are split by hunks). */
export function createBatches(files: readonly FileDiff[], maxChars: number): DiffChunk[][] {
  const chunks = files.flatMap((file) => splitFileDiff(file, maxChars));
  const batches: DiffChunk[][] = [];
  let batch: DiffChunk[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const chunkSize = chunk.text.length + 2;
    if (size + chunkSize > maxChars && batch.length > 0) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(chunk);
    size += chunkSize;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}
