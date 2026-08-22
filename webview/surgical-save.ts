/**
 * Surgical markdown save.
 *
 * The on-disk (or last-known) markdown is the source of truth. The editor
 * still serializes the whole document (md → HTML → md), but we only splice
 * top-level blocks whose *canonical* form changed. Untouched regions stay
 * byte-identical — whitespace, `*` vs `_`, list tightness, setext
 * underlines, fence labels, etc.
 *
 * `originalCanonical` is a full-document serialize of the same editor
 * snapshot that `original` came from (or of the file on open). Comparing
 * `originalCanonical` to a new serialize is how we tell "user edited this
 * block" from "serializer would restyle this block".
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root } from "mdast";

export interface SourceBlock {
  type: string;
  start: number;
  end: number;
  text: string;
  /** type + marker-stripped text; maps original blocks onto their canonical twins */
  fingerprint: string;
}

/** Trailing-newline-insensitive compare — remark-stringify always emits a final `\n`. */
export function normalizeMd(s: string): string {
  return s.replace(/\n+$/, "");
}

function fingerprint(type: string, text: string): string {
  const vis = text
    .replace(/```[\w-]*/g, "")
    .replace(/[*_~`#>|[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${type}:${vis}`;
}

export function parseTopLevelBlocks(md: string): SourceBlock[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(md) as Root;

  const blocks: SourceBlock[] = [];
  for (const node of tree.children) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) continue;
    const text = md.slice(start, end);
    blocks.push({
      type: node.type,
      start,
      end,
      text,
      fingerprint: fingerprint(node.type, text),
    });
  }
  return blocks;
}

type AlignOp =
  | { kind: "equal"; ai: number; bi: number }
  | { kind: "del"; ai: number }
  | { kind: "ins"; bi: number };

function align<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): AlignOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = same(a[i], b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      ops.push({ kind: "equal", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", ai: i });
      i++;
    } else {
      ops.push({ kind: "ins", bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", ai: i++ });
  while (j < m) ops.push({ kind: "ins", bi: j++ });
  return ops;
}

function mapCanonToOriginal(
  origBlocks: SourceBlock[],
  canonBlocks: SourceBlock[],
): Array<number | null> {
  // Normalize almost never splits/merges top-level nodes. Prefer 1:1 so a
  // restyle (`*` → `_`) still maps a block back to its original bytes.
  if (origBlocks.length === canonBlocks.length) {
    return canonBlocks.map((_, i) => i);
  }
  const ops = align(
    origBlocks,
    canonBlocks,
    (a, b) => a.fingerprint === b.fingerprint,
  );
  const map: Array<number | null> = Array(canonBlocks.length).fill(null);
  for (const op of ops) {
    if (op.kind === "equal") map[op.bi] = op.ai;
  }
  return map;
}

interface OutBlock {
  content: string;
  fromOriginal: boolean;
  origIdx: number | null;
}

/**
 * Splice `serialized` (a full-document html→md dump) into `original`,
 * keeping original bytes for every top-level block whose canonical form
 * is unchanged vs `originalCanonical`.
 */
export function surgicalMerge(
  original: string,
  serialized: string,
  originalCanonical: string,
): string {
  if (normalizeMd(originalCanonical) === normalizeMd(serialized)) {
    return original;
  }
  if (!original) return serialized;

  const origBlocks = parseTopLevelBlocks(original);
  const canonBlocks = parseTopLevelBlocks(originalCanonical);
  const newBlocks = parseTopLevelBlocks(serialized);

  if (origBlocks.length === 0 || newBlocks.length === 0) return serialized;
  if (canonBlocks.length === 0) return serialized;

  const canonToOrig = mapCanonToOriginal(origBlocks, canonBlocks);

  const ops = align(
    canonBlocks,
    newBlocks,
    (a, b) => normalizeMd(a.text) === normalizeMd(b.text),
  );

  const equalCount = ops.reduce((n, op) => n + (op.kind === "equal" ? 1 : 0), 0);
  // Nothing lined up — structure changed too much. Fall back to the
  // full serialize rather than guessing inter-block whitespace.
  if (equalCount === 0) return serialized;

  const out: OutBlock[] = [];
  for (const op of ops) {
    if (op.kind === "equal") {
      const origIdx = canonToOrig[op.ai];
      if (origIdx != null) {
        out.push({
          content: origBlocks[origIdx].text,
          fromOriginal: true,
          origIdx,
        });
      } else {
        out.push({
          content: newBlocks[op.bi].text,
          fromOriginal: false,
          origIdx: null,
        });
      }
    } else if (op.kind === "ins") {
      out.push({
        content: newBlocks[op.bi].text,
        fromOriginal: false,
        origIdx: null,
      });
    }
  }

  if (out.length === 0) return serialized;

  let result = "";
  const first = out[0];
  if (first.fromOriginal && first.origIdx != null) {
    result += original.slice(0, origBlocks[first.origIdx].start);
  } else {
    result += original.slice(0, origBlocks[0].start);
  }

  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      const prev = out[i - 1];
      const curr = out[i];
      const consecutive =
        prev.fromOriginal &&
        curr.fromOriginal &&
        prev.origIdx != null &&
        curr.origIdx != null &&
        prev.origIdx + 1 === curr.origIdx;
      if (consecutive) {
        result += original.slice(
          origBlocks[prev.origIdx!].end,
          origBlocks[curr.origIdx!].start,
        );
      } else {
        if (!result.endsWith("\n")) result += "\n";
        if (!result.endsWith("\n\n")) result += "\n";
      }
    }
    result += out[i].content;
  }

  const last = out[out.length - 1];
  if (last.fromOriginal && last.origIdx != null) {
    result += original.slice(origBlocks[last.origIdx].end);
  } else if (original.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}
