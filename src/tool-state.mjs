/**
 * Same-turn filesystem knowledge used by mutating tools.
 *
 * Range edits depend on line numbers, so they are accepted only when the model
 * has seen the affected lines from the exact current file contents. State is
 * deliberately scoped to one runTurn: a resumed or later turn must read again.
 */
import { createHash } from "node:crypto";

function contentHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function covered(ranges, start, end) {
  return ranges.some((range) => range.start <= start && range.end >= end);
}

export class ToolState {
  constructor() {
    this.reads = new Map();
  }

  recordReadHash(path, hash, startLine, endLine, totalLines = null) {
    const current = this.reads.get(path);
    const ranges = current?.hash === hash ? current.ranges : [];
    const nextRanges = startLine === 0 && endLine === 0 ? [{ start: 0, end: 0 }] : [...ranges, { start: startLine, end: endLine }];
    this.reads.set(path, { hash, totalLines, ranges: mergeRanges(nextRanges) });
  }

  validateRangeEdit(path, content, edits) {
    const ranges = edits.filter((edit) => Number.isInteger(edit.startLine));
    if (ranges.length === 0) return null;
    const read = this.reads.get(path);
    if (!read) return `range edit requires a fresh read of ${path}`;
    if (read.hash !== contentHash(content)) return `range edit refused because ${path} changed after it was read; read it again`;

    for (const edit of ranges) {
      const start = edit.startLine;
      const end = edit.endLine ?? start;
      let requiredStart = start;
      let requiredEnd = end;
      if (end === start - 1) {
        if (read.totalLines === 0 && start === 1) {
          requiredStart = 0;
          requiredEnd = 0;
        } else if (read.totalLines != null && start === read.totalLines + 1) {
          requiredStart = start - 1;
          requiredEnd = start - 1;
        } else {
          requiredEnd = start;
        }
      }
      if (!covered(read.ranges, requiredStart, requiredEnd)) {
        return `range edit ${start}-${end} is outside the freshly read lines of ${path}; read that range again`;
      }
    }
    return null;
  }

  recordMutation(path) {
    this.reads.delete(path);
  }

  invalidateAll() {
    this.reads.clear();
  }
}

export function createToolState() {
  return new ToolState();
}
