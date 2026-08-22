/**
 * Surgical markdown save.
 *
 * The on-disk (or last-known) markdown is the source of truth. The editor
 * still serializes the whole document (md → HTML → md), but we only splice
 * regions whose *canonical* form changed. Untouched top-level blocks stay
 * byte-identical — whitespace, `*` vs `_`, list tightness, setext
 * underlines, fence labels, etc.
 *
 * A dirty list / blockquote is merged recursively: kept children are
 * original slices; a dirty list item keeps its original marker and indent
 * and only replaces the edited body. A dirty paragraph whose mark tree is
 * unchanged splices new text into the original bytes (so `*` / `_` / `__`
 * stay put).
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

/** Visible prose used to match a compacted serialize against several original lists. */
function visibleText(text: string): string {
  return text
    .replace(/```[\w-]*/g, "")
    .replace(/[*_~`#>|[\]\\]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMd(md: string): Root {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(md) as Root;
}

export function parseTopLevelBlocks(md: string): SourceBlock[] {
  const tree = parseMd(md);
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

type PairOp =
  | { kind: "keep"; ai: number; bi: number }
  | { kind: "merge"; ai: number; bi: number }
  | { kind: "ins"; bi: number };

/** Pair del+ins runs so a changed block is a merge, not a drop + insert. */
function pairAlignOps(ops: AlignOp[]): PairOp[] {
  const paired: PairOp[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === "equal") {
      paired.push({ kind: "keep", ai: op.ai, bi: op.bi });
      i++;
      continue;
    }
    const dels: number[] = [];
    const inss: number[] = [];
    while (i < ops.length && ops[i].kind !== "equal") {
      if (ops[i].kind === "del") dels.push((ops[i] as { ai: number }).ai);
      else inss.push((ops[i] as { bi: number }).bi);
      i++;
    }
    const n = Math.min(dels.length, inss.length);
    for (let k = 0; k < n; k++) {
      paired.push({ kind: "merge", ai: dels[k], bi: inss[k] });
    }
    for (let k = n; k < inss.length; k++) {
      paired.push({ kind: "ins", bi: inss[k] });
    }
  }
  return paired;
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

/**
 * When compactLists (or similar) folds several original lists into one
 * canonical list, map that canon block back onto the original run.
 */
function origSpanForCanon(
  original: string,
  origBlocks: SourceBlock[],
  canonBlock: SourceBlock,
  mappedIdx: number | null,
): { start: number; end: number; text: string } | null {
  if (mappedIdx != null) {
    const b = origBlocks[mappedIdx];
    return { start: b.start, end: b.end, text: b.text };
  }
  if (canonBlock.type !== "list") return null;
  const target = visibleText(canonBlock.text);
  if (!target) return null;
  for (let i = 0; i < origBlocks.length; i++) {
    if (origBlocks[i].type !== "list") continue;
    for (
      let j = i;
      j < origBlocks.length && origBlocks[j].type === "list";
      j++
    ) {
      const start = origBlocks[i].start;
      const end = origBlocks[j].end;
      const text = original.slice(start, end);
      if (visibleText(text) === target) {
        return { start, end, text };
      }
    }
  }
  return null;
}

interface OutBlock {
  content: string;
  fromOriginal: boolean;
  origIdx: number | null;
  origStart?: number;
  origEnd?: number;
}

interface Kid {
  node: any;
  start: number;
  end: number;
  text: string;
}

function kidsOf(md: string, parent: any): Kid[] | null {
  const out: Kid[] = [];
  for (const node of parent.children ?? []) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start == null || end == null) return null;
    out.push({ node, start, end, text: md.slice(start, end) });
  }
  return out;
}

function listMarkerPrefix(md: string, item: any): string | null {
  const start = item.position?.start?.offset;
  const end = item.position?.end?.offset;
  if (start == null || end == null) return null;
  const m = md.slice(start, end).match(/^(\s*(?:[-*+]|\d+[.)])\s+)/);
  return m ? m[0] : null;
}

function textLeaves(
  node: any,
): Array<{ start: number; end: number; value: string }> {
  const out: Array<{ start: number; end: number; value: string }> = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "text") {
      const s = n.position?.start?.offset;
      const e = n.position?.end?.offset;
      if (s != null && e != null) out.push({ start: s, end: e, value: n.value });
      return;
    }
    for (const ch of n.children ?? []) walk(ch);
  };
  walk(node);
  return out;
}

/** Shape of phrasing/block marks, ignoring text values but keeping urls, code, depth. */
function shapeIgnoringText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return "text";
  let extra = "";
  if (node.type === "heading") extra = `:${node.depth}`;
  else if (node.type === "link" || node.type === "linkReference")
    extra = `:${node.url ?? ""}:${node.identifier ?? ""}`;
  else if (node.type === "image" || node.type === "imageReference")
    extra = `:${node.url ?? ""}:${node.alt ?? ""}:${node.identifier ?? ""}`;
  else if (node.type === "inlineCode" || node.type === "inlineMath")
    extra = `:${node.value ?? ""}`;
  else if (node.type === "listItem") extra = `:chk:${node.checked}`;
  else if (node.type === "list") extra = `:ord:${!!node.ordered}`;
  const kids = (node.children ?? []).map(shapeIgnoringText).join(",");
  return `${node.type}${extra}[${kids}]`;
}

function spliceTextLikes(
  origMd: string,
  origNode: any,
  _newMd: string,
  newNode: any,
): string | null {
  const oStart = origNode.position?.start?.offset;
  const oEnd = origNode.position?.end?.offset;
  if (oStart == null || oEnd == null) return null;
  if (shapeIgnoringText(origNode) !== shapeIgnoringText(newNode)) return null;
  const oLeaves = textLeaves(origNode);
  const nLeaves = textLeaves(newNode);
  if (oLeaves.length !== nLeaves.length) return null;
  if (oLeaves.length === 0) return origMd.slice(oStart, oEnd);
  let result = origMd.slice(oStart, oEnd);
  for (let i = oLeaves.length - 1; i >= 0; i--) {
    const relS = oLeaves[i].start - oStart;
    const relE = oLeaves[i].end - oStart;
    result = result.slice(0, relS) + nLeaves[i].value + result.slice(relE);
  }
  return result;
}

function stitchKids(
  origMd: string,
  oKids: Kid[],
  parentStart: number,
  parentEnd: number,
  pieces: Array<{ content: string; origIdx: number | null }>,
  defaultSep: string,
): string {
  if (pieces.length === 0) return origMd.slice(parentStart, parentEnd);
  let result = "";
  const first = pieces[0];
  if (first.origIdx != null) {
    result += origMd.slice(parentStart, oKids[first.origIdx].start);
  } else {
    result += origMd.slice(parentStart, oKids[0]?.start ?? parentStart);
  }
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) {
      const prev = pieces[i - 1];
      const curr = pieces[i];
      const consecutive =
        prev.origIdx != null &&
        curr.origIdx != null &&
        prev.origIdx + 1 === curr.origIdx;
      if (consecutive) {
        result += origMd.slice(
          oKids[prev.origIdx!].end,
          oKids[curr.origIdx!].start,
        );
      } else {
        if (!result.endsWith("\n")) result += defaultSep.startsWith("\n") ? "" : "\n";
        if (defaultSep === "\n\n") {
          if (!result.endsWith("\n")) result += "\n";
          if (!result.endsWith("\n\n")) result += "\n";
        } else if (!result.endsWith("\n")) {
          result += "\n";
        }
      }
    }
    result += pieces[i].content;
  }
  const last = pieces[pieces.length - 1];
  if (last.origIdx != null) {
    result += origMd.slice(oKids[last.origIdx].end, parentEnd);
  }
  return result;
}

function mergeKids(
  origMd: string,
  oKids: Kid[],
  canonMd: string,
  cKids: Kid[],
  newMd: string,
  nKids: Kid[],
  parentStart: number,
  parentEnd: number,
  defaultSep: string,
): string | null {
  if (oKids.length === 0 || nKids.length === 0 || cKids.length === 0) return null;

  const canonToOrig =
    oKids.length === cKids.length
      ? cKids.map((_, i) => i)
      : (() => {
          const ops = align(
            oKids,
            cKids,
            (a, b) => fingerprint("n", a.text) === fingerprint("n", b.text),
          );
          const map: Array<number | null> = Array(cKids.length).fill(null);
          for (const op of ops) {
            if (op.kind === "equal") map[op.bi] = op.ai;
          }
          return map;
        })();

  const ops = align(
    cKids,
    nKids,
    (a, b) => normalizeMd(a.text) === normalizeMd(b.text),
  );
  const paired = pairAlignOps(ops);
  if (paired.length === 0) return null;

  const pieces: Array<{ content: string; origIdx: number | null }> = [];
  for (const op of paired) {
    if (op.kind === "keep") {
      const origIdx = canonToOrig[op.ai];
      if (origIdx != null) {
        pieces.push({ content: oKids[origIdx].text, origIdx });
      } else {
        pieces.push({ content: nKids[op.bi].text, origIdx: null });
      }
    } else if (op.kind === "merge") {
      const origIdx = canonToOrig[op.ai];
      let content: string | null = null;
      if (origIdx != null) {
        content = mergeNode(
          origMd,
          oKids[origIdx].node,
          canonMd,
          cKids[op.ai].node,
          newMd,
          nKids[op.bi].node,
        );
      }
      pieces.push({
        content: content ?? nKids[op.bi].text,
        origIdx: origIdx,
      });
    } else {
      pieces.push({ content: nKids[op.bi].text, origIdx: null });
    }
  }
  return stitchKids(origMd, oKids, parentStart, parentEnd, pieces, defaultSep);
}

function collectListItems(md: string, root: Root): Kid[] | null {
  const items: Kid[] = [];
  if (root.children.length === 0) return null;
  for (const ch of root.children) {
    if (ch.type !== "list") return null;
    const kids = kidsOf(md, ch);
    if (!kids) return null;
    items.push(...kids);
  }
  return items.length ? items : null;
}

function mergeListItem(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  const marker = listMarkerPrefix(origMd, o);
  const newMarker = listMarkerPrefix(newMd, n);
  const nStart = n.position?.start?.offset;
  const nEnd = n.position?.end?.offset;
  if (!marker || !newMarker || nStart == null || nEnd == null) return null;
  const newBody = newMd.slice(nStart + newMarker.length, nEnd);

  if (o.checked === n.checked && c && c.type === "listItem") {
    const oKids = kidsOf(origMd, o);
    const cKids = kidsOf(canonMd, c);
    const nKids = kidsOf(newMd, n);
    const oStart = o.position?.start?.offset;
    const oEnd = o.position?.end?.offset;
    if (oKids && cKids && nKids && oStart != null && oEnd != null) {
      const inner = mergeKids(
        origMd,
        oKids,
        canonMd,
        cKids,
        newMd,
        nKids,
        oStart,
        oEnd,
        "\n",
      );
      if (inner != null) return inner;
    }
  }
  return marker + newBody;
}

function mergeNode(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  if (!o || !n || o.type !== n.type) return null;

  if (o.type === "list") {
    if (!!o.ordered !== !!n.ordered) return null;
    if (!c || c.type !== "list") return null;
    const oKids = kidsOf(origMd, o);
    const cKids = kidsOf(canonMd, c);
    const nKids = kidsOf(newMd, n);
    const oStart = o.position?.start?.offset;
    const oEnd = o.position?.end?.offset;
    if (!oKids || !cKids || !nKids || oStart == null || oEnd == null) return null;
    return mergeKids(origMd, oKids, canonMd, cKids, newMd, nKids, oStart, oEnd, "\n");
  }

  if (o.type === "listItem") {
    return mergeListItem(origMd, o, canonMd, c, newMd, n);
  }

  if (o.type === "blockquote") {
    if (!c || c.type !== "blockquote") return null;
    const oKids = kidsOf(origMd, o);
    const cKids = kidsOf(canonMd, c);
    const nKids = kidsOf(newMd, n);
    const oStart = o.position?.start?.offset;
    const oEnd = o.position?.end?.offset;
    if (!oKids || !cKids || !nKids || oStart == null || oEnd == null) return null;
    return mergeKids(
      origMd,
      oKids,
      canonMd,
      cKids,
      newMd,
      nKids,
      oStart,
      oEnd,
      "\n\n",
    );
  }

  if (o.type === "paragraph" || o.type === "heading") {
    if (o.type === "heading" && o.depth !== n.depth) return null;
    return spliceTextLikes(origMd, o, newMd, n);
  }

  return null;
}

/** Merge a dirty top-level block (or a run of original lists) against its serialize. */
export function mergeBlock(
  origText: string,
  canonText: string,
  newText: string,
): string {
  if (normalizeMd(canonText) === normalizeMd(newText)) return origText;

  const oRoot = parseMd(origText);
  const cRoot = parseMd(canonText);
  const nRoot = parseMd(newText);

  const oItems = collectListItems(origText, oRoot);
  const cItems = collectListItems(canonText, cRoot);
  const nItems = collectListItems(newText, nRoot);
  if (oItems && cItems && nItems) {
    const merged = mergeKids(
      origText,
      oItems,
      canonText,
      cItems,
      newText,
      nItems,
      0,
      origText.length,
      "\n",
    );
    if (merged != null) return merged;
  }

  const o = oRoot.children[0];
  const c = cRoot.children[0];
  const n = nRoot.children[0];
  if (!o || !c || !n) return newText;
  return mergeNode(origText, o, canonText, c, newText, n) ?? newText;
}

/**
 * Splice `serialized` (a full-document html→md dump) into `original`,
 * keeping original bytes for every top-level block whose canonical form
 * is unchanged vs `originalCanonical`. Dirty lists / paragraphs are
 * merged in-place so only the edited text is rewritten.
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

  const paired = pairAlignOps(ops);
  const keepCount = paired.reduce((n, op) => n + (op.kind === "keep" ? 1 : 0), 0);
  const mergeCount = paired.reduce(
    (n, op) => n + (op.kind === "merge" ? 1 : 0),
    0,
  );
  // Nothing lined up — structure changed too much. Fall back to the
  // full serialize rather than guessing inter-block whitespace.
  if (keepCount === 0 && mergeCount === 0) return serialized;

  const out: OutBlock[] = [];
  for (const op of paired) {
    if (op.kind === "keep") {
      const origIdx = canonToOrig[op.ai];
      if (origIdx != null) {
        out.push({
          content: origBlocks[origIdx].text,
          fromOriginal: true,
          origIdx,
          origStart: origBlocks[origIdx].start,
          origEnd: origBlocks[origIdx].end,
        });
      } else {
        const span = origSpanForCanon(
          original,
          origBlocks,
          canonBlocks[op.ai],
          null,
        );
        if (span) {
          out.push({
            content: span.text,
            fromOriginal: true,
            origIdx: null,
            origStart: span.start,
            origEnd: span.end,
          });
        } else {
          out.push({
            content: newBlocks[op.bi].text,
            fromOriginal: false,
            origIdx: null,
          });
        }
      }
    } else if (op.kind === "merge") {
      const span = origSpanForCanon(
        original,
        origBlocks,
        canonBlocks[op.ai],
        canonToOrig[op.ai],
      );
      if (span) {
        out.push({
          content: mergeBlock(span.text, canonBlocks[op.ai].text, newBlocks[op.bi].text),
          fromOriginal: true,
          origIdx: canonToOrig[op.ai],
          origStart: span.start,
          origEnd: span.end,
        });
      } else {
        out.push({
          content: newBlocks[op.bi].text,
          fromOriginal: false,
          origIdx: null,
        });
      }
    } else {
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
  if (first.origStart != null) {
    result += original.slice(0, first.origStart);
  } else if (first.fromOriginal && first.origIdx != null) {
    result += original.slice(0, origBlocks[first.origIdx].start);
  } else {
    result += original.slice(0, origBlocks[0].start);
  }

  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      const prev = out[i - 1];
      const curr = out[i];
      const prevEnd = prev.origEnd ?? (prev.origIdx != null ? origBlocks[prev.origIdx].end : null);
      const currStart =
        curr.origStart ?? (curr.origIdx != null ? origBlocks[curr.origIdx].start : null);
      const consecutive =
        prev.fromOriginal &&
        curr.fromOriginal &&
        prev.origIdx != null &&
        curr.origIdx != null &&
        prev.origIdx + 1 === curr.origIdx;
      const adjacentSpans =
        prevEnd != null && currStart != null && prevEnd <= currStart && prev.fromOriginal && curr.fromOriginal;
      if (consecutive) {
        result += original.slice(
          origBlocks[prev.origIdx!].end,
          origBlocks[curr.origIdx!].start,
        );
      } else if (adjacentSpans && prev.origIdx == null && curr.origIdx == null) {
        result += original.slice(prevEnd!, currStart!);
      } else {
        if (!result.endsWith("\n")) result += "\n";
        if (!result.endsWith("\n\n")) result += "\n";
      }
    }
    result += out[i].content;
  }

  const last = out[out.length - 1];
  if (last.origEnd != null) {
    result += original.slice(last.origEnd);
  } else if (last.fromOriginal && last.origIdx != null) {
    result += original.slice(origBlocks[last.origIdx].end);
  } else if (original.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}
