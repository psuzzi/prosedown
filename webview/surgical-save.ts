/**
 * Surgical markdown save.
 *
 * The on-disk (or last-known) markdown is the source of truth. The editor
 * still serializes the whole document (md → HTML → md), but we only splice
 * regions whose *canonical* form changed. Untouched top-level blocks stay
 * byte-identical — whitespace, `*` vs `_`, list tightness, setext
 * underlines, fence labels, etc.
 *
 * A dirty list / blockquote / table is merged recursively: kept children are
 * original slices; a dirty list item keeps its original marker and indent
 * and only replaces the edited body. New list items inherit the surrounding
 * marker. A dirty paragraph whose mark tree is unchanged splices new text
 * into the original bytes (so `*` / `_` / `__` stay put). When the mark tree
 * *does* change, phrasing is 3-way aligned (original / canon / new): unchanged
 * runs keep original bytes, new emphasis wraps only the affected text with
 * settings markers, and a link destination is spliced into the original
 * `(url)` / `<url>` wrap. Tables align header cells so an added/removed
 * column splices one cell per row and extends/trims the separator with the
 * neighbor's `:---` style. Fences, thematic breaks, heading style, and
 * checkboxes keep their original markers unless the user changed that meaning.
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

/** Shape of phrasing/block marks, ignoring text values and link/image dest.
 *  Dest is omitted so a URL-only edit can splice into the original wrap.
 *  Image alt is omitted so an alt-only edit can still keep url wrapping / title quotes.
 */
function shapeIgnoringText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return "text";
  let extra = "";
  if (node.type === "heading") extra = `:${node.depth}`;
  else if (node.type === "link" || node.type === "linkReference")
    extra = `:${node.identifier ?? ""}`;
  else if (node.type === "image" || node.type === "imageReference")
    extra = `:${node.identifier ?? ""}`;
  else if (node.type === "inlineCode" || node.type === "inlineMath")
    extra = `:${node.value ?? ""}`;
  else if (node.type === "listItem") extra = `:chk:${node.checked}`;
  else if (node.type === "list") extra = `:ord:${!!node.ordered}`;
  const kids = (node.children ?? []).map(shapeIgnoringText).join(",");
  return `${node.type}${extra}[${kids}]`;
}

function visibleOf(node: any): string {
  if (!node) return "";
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "inlineMath"
  ) {
    return String(node.value ?? "");
  }
  if (node.type === "break") return "\n";
  if (node.type === "image" || node.type === "imageReference") {
    return String(node.alt ?? "");
  }
  return (node.children ?? []).map(visibleOf).join("");
}

function imagesOf(node: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "image") {
      out.push(n);
      return;
    }
    for (const ch of n.children ?? []) walk(ch);
  };
  walk(node);
  return out;
}

function linksOf(node: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "link") {
      out.push(n);
      return;
    }
    for (const ch of n.children ?? []) walk(ch);
  };
  walk(node);
  return out;
}

/** Destination span inside raw `[text](dest)` / `<url>` so we splice only the URL. */
function linkDestSpan(raw: string): {
  start: number;
  end: number;
  angled: boolean;
} | null {
  const trimmed = raw.trim();
  if (/^<[^\n>]+>$/.test(trimmed) && !raw.includes("](")) {
    const open = raw.indexOf("<");
    const close = raw.lastIndexOf(">");
    if (open < 0 || close < 0) return null;
    return { start: open + 1, end: close, angled: true };
  }
  const closeBracket = raw.lastIndexOf("]");
  if (closeBracket < 0 || raw[closeBracket + 1] !== "(" || !raw.endsWith(")")) {
    return null;
  }
  const dest = raw.slice(closeBracket + 2, raw.length - 1);
  let i = 0;
  while (i < dest.length && /\s/.test(dest[i])) i++;
  const destAbs = closeBracket + 2;
  if (dest[i] === "<") {
    const end = dest.indexOf(">", i);
    if (end < 0) return null;
    return { start: destAbs + i, end: destAbs + end + 1, angled: true };
  }
  const start = i;
  while (i < dest.length && !/\s/.test(dest[i])) i++;
  return { start: destAbs + start, end: destAbs + i, angled: false };
}

function applyLinkDest(raw: string, o: any, n: any): string {
  if ((o.url ?? "") === (n.url ?? "")) return raw;
  const span = linkDestSpan(raw);
  if (!span) return raw;
  const urlPart = span.angled ? `<${n.url ?? ""}>` : (n.url ?? "");
  return raw.slice(0, span.start) + urlPart + raw.slice(span.end);
}

/** Parse `![alt](dest)` so we can rebuild with original url wrapping / title quotes. */
function rewriteImage(raw: string, o: any, n: any): string | null {
  const m = raw.match(/^!\[([\s\S]*?)\]\(([\s\S]*)\)$/);
  if (!m) return null;
  const dest = m[2];
  let i = 0;
  while (i < dest.length && /\s/.test(dest[i])) i++;
  let urlRaw = "";
  if (dest[i] === "<") {
    const end = dest.indexOf(">", i);
    if (end < 0) return null;
    urlRaw = dest.slice(i, end + 1);
    i = end + 1;
  } else {
    const start = i;
    while (i < dest.length && !/\s/.test(dest[i])) i++;
    urlRaw = dest.slice(start, i);
  }
  const afterUrl = dest.slice(i);
  const titleM = afterUrl.match(/^(\s*)(['"])([\s\S]*)\2(\s*)$/);
  const urlSame = (o.url ?? "") === (n.url ?? "");
  const titleSame = (o.title ?? null) === (n.title ?? null);
  const urlPart = urlSame
    ? urlRaw
    : urlRaw.startsWith("<")
      ? `<${n.url ?? ""}>`
      : (n.url ?? "");
  let titlePart = "";
  if (n.title) {
    if (titleSame && titleM) {
      titlePart = titleM[1] + titleM[2] + titleM[3] + titleM[2] + titleM[4];
    } else {
      const q = titleM ? titleM[2] : '"';
      titlePart = (titleM ? titleM[1] : " ") + q + n.title + q;
    }
  }
  return `![${n.alt ?? ""}](${urlPart}${titlePart})`;
}

function restyleInsertedListItem(
  newText: string,
  oKids: Kid[],
  origMd: string,
): string {
  const sample = oKids.find((k) => listMarkerPrefix(origMd, k.node));
  if (!sample) return newText;
  const samplePrefix = listMarkerPrefix(origMd, sample.node)!;
  const newM = newText.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/);
  if (!newM) return newText;
  const sm = samplePrefix.match(/^(\s*)([-*+]|(\d+)([.)]))(\s*)/);
  const nm = newM[1].match(/^(\s*)([-*+]|(\d+)([.)]))(\s*)/);
  if (!sm || !nm) return newText;
  let prefix: string;
  if (sm[3] != null) {
    prefix = `${sm[1]}${nm[3] ?? sm[3]}${sm[4]}${sm[5] || " "}`;
  } else {
    prefix = `${sm[1]}${sm[2]}${sm[5] || " "}`;
  }
  let body = newText.slice(newM[1].length);
  const sampleText = sample.text;
  const sampleBox = sampleText.match(/\[([xX ])\]/);
  const newBox = body.match(/^\[([xX ])\]/);
  if (sampleBox && newBox) {
    let fill = newBox[1];
    if (fill !== " ") {
      const checkedLetter = sampleText.match(/\[([xX])\]/);
      fill = checkedLetter ? checkedLetter[1] : fill;
    }
    body = `[${fill}]` + body.slice(newBox[0].length);
  }
  return prefix + body;
}

function quoteLinePrefix(origMd: string, bq: any): string {
  const start = bq.position?.start?.offset ?? 0;
  const nl = origMd.indexOf("\n", start);
  const first = origMd.slice(start, nl < 0 ? undefined : nl);
  const m = first.match(/^(>+[ \t]*)/);
  if (!m) return "> ";
  return /[ \t]$/.test(m[1]) ? m[1] : m[1] + " ";
}

function prefixQuoteLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith(">") ? l : prefix + l))
    .join("\n");
}

function applyCheckboxState(
  itemText: string,
  o: any,
  n: any,
): string {
  if (o.checked === n.checked) return itemText;
  if (n.checked == null && o.checked == null) return itemText;
  const m = itemText.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([xX ])\]/);
  if (!m) return itemText;
  let fill: string;
  if (!n.checked) fill = " ";
  else if (m[2] === "X" || m[2] === "x") fill = m[2];
  else fill = "x";
  return itemText.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[([xX ])\]/,
    `$1[${fill}]`,
  );
}

function isTableSepLine(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

interface SrcChar {
  ch: string;
  srcStart: number;
  srcEnd: number;
  owner: Kid;
  atomic: boolean;
}

function buildCharStream(md: string, kids: Kid[]): SrcChar[] {
  const out: SrcChar[] = [];
  const walk = (n: any, owner: Kid) => {
    if (!n) return;
    const t = n.type;
    if (
      t === "link" ||
      t === "linkReference" ||
      t === "image" ||
      t === "imageReference" ||
      t === "inlineCode" ||
      t === "inlineMath" ||
      t === "html"
    ) {
      const vis = visibleOf(n);
      const start = n.position?.start?.offset;
      const end = n.position?.end?.offset;
      if (start == null || end == null) return;
      if (vis.length === 0) return;
      for (const ch of vis) {
        out.push({ ch, srcStart: start, srcEnd: end, owner, atomic: true });
      }
      return;
    }
    if (t === "text") {
      const start = n.position?.start?.offset;
      const end = n.position?.end?.offset;
      const value = String(n.value ?? "");
      if (start == null || end == null) return;
      const raw = md.slice(start, end);
      if (raw === value) {
        for (let i = 0; i < value.length; i++) {
          out.push({
            ch: value[i],
            srcStart: start + i,
            srcEnd: start + i + 1,
            owner,
            atomic: false,
          });
        }
      } else {
        for (let i = 0; i < value.length; i++) {
          out.push({
            ch: value[i],
            srcStart: start,
            srcEnd: end,
            owner,
            atomic: false,
          });
        }
      }
      return;
    }
    if (t === "break") {
      const start = n.position?.start?.offset;
      const end = n.position?.end?.offset;
      if (start != null && end != null) {
        out.push({ ch: "\n", srcStart: start, srcEnd: end, owner, atomic: true });
      }
      return;
    }
    for (const ch of n.children ?? []) walk(ch, owner);
  };
  for (const k of kids) walk(k.node, k);
  return out;
}

function splitRewrap(
  origMd: string,
  oKids: Kid[],
  stream: SrcChar[],
  nKids: Kid[],
): string | null {
  let pos = 0;
  let out = "";
  let lastSrc = oKids[0].start;

  for (const nk of nKids) {
    const vis = visibleOf(nk.node);
    if (nk.node.type === "break") {
      const cur = stream[pos];
      if (cur && cur.ch === "\n") {
        if (lastSrc < cur.srcStart && /^\s*$/.test(origMd.slice(lastSrc, cur.srcStart))) {
          out += origMd.slice(lastSrc, cur.srcStart);
        }
        out += origMd.slice(cur.srcStart, cur.srcEnd);
        lastSrc = cur.srcEnd;
        pos++;
      } else {
        out += nk.text;
      }
      continue;
    }
    if (vis.length === 0) {
      out += nk.text;
      continue;
    }
    const slice = stream.slice(pos, pos + vis.length);
    if (slice.length !== vis.length) return null;
    if (slice.map((c) => c.ch).join("") !== vis) return null;
    pos += vis.length;

    const owner = slice[0].owner;
    const coversOwner =
      slice.every((c) => c.owner === owner) && visibleOf(owner.node) === vis;
    const srcFrom = slice[0].srcStart;
    const srcTo = slice[slice.length - 1].srcEnd;

    if (coversOwner && owner.node.type === nk.node.type) {
      if (lastSrc < owner.start) {
        const mid = origMd.slice(lastSrc, owner.start);
        if (/^\s*$/.test(mid)) out += mid;
      }
      out +=
        nk.node.type === "link"
          ? applyLinkDest(owner.text, owner.node, nk.node)
          : owner.text;
      lastSrc = owner.end;
      continue;
    }

    if (lastSrc < srcFrom) {
      const mid = origMd.slice(lastSrc, srcFrom);
      if (/^\s*$/.test(mid)) out += mid;
    }

    const inner = origMd.slice(srcFrom, srcTo);
    // Plain text keeps the original bytes; anything else (new marks on
    // unchanged text included) takes the serialize's settings markers.
    out += nk.node.type === "text" ? inner : nk.text;
    lastSrc = srcTo;
  }

  if (pos !== stream.length) return null;
  const oEnd = oKids[oKids.length - 1].end;
  if (lastSrc < oEnd) {
    const tail = origMd.slice(lastSrc, oEnd);
    if (/^\s*$/.test(tail)) out += tail;
  }
  return out;
}

function mergePhraseGap(
  origMd: string,
  oKids: Kid[],
  _newMd: string,
  nKids: Kid[],
): string | null {
  if (oKids.length === 0) return nKids.map((k) => k.text).join("");
  if (nKids.length === 0) return "";
  const stream = buildCharStream(origMd, oKids);
  const oVis = stream.map((c) => c.ch).join("");
  const nVis = nKids.map((k) => visibleOf(k.node)).join("");
  if (oVis === nVis) return splitRewrap(origMd, oKids, stream, nKids);

  const ops = align(
    oKids,
    nKids,
    (a, b) => visibleOf(a.node) === visibleOf(b.node),
  );
  let out = "";
  for (const op of ops) {
    if (op.kind === "equal") {
      const oKid = oKids[op.ai];
      const nKid = nKids[op.bi];
      if (oKid.node.type === "link" && nKid.node.type === "link") {
        out += applyLinkDest(oKid.text, oKid.node, nKid.node);
      } else if (oKid.node.type === nKid.node.type) {
        out += oKid.text;
      } else {
        out += nKid.text;
      }
    } else if (op.kind === "ins") {
      out += nKids[op.bi].text;
    }
  }
  return out;
}

function samePhrase(a: Kid, b: Kid): boolean {
  if (a.node.type !== b.node.type) return false;
  if (a.node.type === "link" || a.node.type === "linkReference") {
    return visibleOf(a.node) === visibleOf(b.node);
  }
  return normalizeMd(a.text) === normalizeMd(b.text);
}

/** 3-way phrasing merge: unchanged runs keep original bytes; new marks wrap locally. */
function mergePhrasing(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  const spliced = spliceTextLikes(origMd, o, newMd, n);
  if (spliced != null) return spliced;

  if (!c || c.type !== o.type) {
    c = o;
    canonMd = origMd;
  }

  const oKids = kidsOf(origMd, o);
  const cKids = kidsOf(canonMd, c);
  const nKids = kidsOf(newMd, n);
  const oStart = o.position?.start?.offset;
  const oEnd = o.position?.end?.offset;
  if (!oKids || !cKids || !nKids || oStart == null || oEnd == null) return null;
  if (nKids.length === 0) {
    return oKids.length === 0 ? origMd.slice(oStart, oEnd) : null;
  }
  if (oKids.length === 0 || cKids.length === 0) return null;

  const canonToOrig =
    oKids.length === cKids.length
      ? cKids.map((_, i) => i)
      : (() => {
          const ops = align(
            oKids,
            cKids,
            (a, b) =>
              a.node.type === b.node.type &&
              visibleOf(a.node) === visibleOf(b.node),
          );
          const map: Array<number | null> = Array(cKids.length).fill(null);
          for (const op of ops) {
            if (op.kind === "equal") map[op.bi] = op.ai;
          }
          return map;
        })();

  const ops = align(cKids, nKids, samePhrase);
  const pieces: Array<{ content: string; origIdx: number | null }> = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === "equal") {
      const origIdx = canonToOrig[op.ai];
      if (origIdx != null) {
        const oKid = oKids[origIdx];
        const nKid = nKids[op.bi];
        pieces.push({
          content:
            oKid.node.type === "link" && nKid.node.type === "link"
              ? applyLinkDest(oKid.text, oKid.node, nKid.node)
              : oKid.text,
          origIdx,
        });
      } else {
        pieces.push({ content: nKids[op.bi].text, origIdx: null });
      }
      i++;
      continue;
    }
    const delOrig: Kid[] = [];
    const insNew: Kid[] = [];
    while (i < ops.length && ops[i].kind !== "equal") {
      if (ops[i].kind === "del") {
        const origIdx = canonToOrig[(ops[i] as { ai: number }).ai];
        if (origIdx != null) delOrig.push(oKids[origIdx]);
      } else {
        insNew.push(nKids[(ops[i] as { bi: number }).bi]);
      }
      i++;
    }
    if (insNew.length === 0) continue;
    if (delOrig.length === 0) {
      for (const k of insNew) pieces.push({ content: k.text, origIdx: null });
      continue;
    }
    const gap = mergePhraseGap(origMd, delOrig, newMd, insNew);
    if (gap == null) return null;
    pieces.push({ content: gap, origIdx: oKids.indexOf(delOrig[0]) });
  }
  return stitchKids(origMd, oKids, oStart, oEnd, pieces, "");
}

function splitPipeRow(row: string): {
  cells: string[];
  leadPipe: boolean;
  trailPipe: boolean;
} {
  // Only an *unescaped* `|` is a cell boundary — GFM writes a literal pipe
  // inside a cell (including inside a code span) as `\|`. Splitting on it
  // would shear the cell in half and desync cells from the row's mdast kids.
  const cuts: number[] = [];
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\") {
      i++;
      continue;
    }
    if (row[i] === "|") cuts.push(i);
  }
  if (cuts.length === 0) return { cells: [row], leadPipe: false, trailPipe: false };
  const leadPipe = /^\s*$/.test(row.slice(0, cuts[0]));
  const trailPipe =
    cuts.length > (leadPipe ? 1 : 0) &&
    /^\s*$/.test(row.slice(cuts[cuts.length - 1] + 1));
  const from = leadPipe ? cuts[0] + 1 : 0;
  const to = trailPipe ? cuts[cuts.length - 1] : row.length;
  const inner = cuts.slice(
    leadPipe ? 1 : 0,
    trailPipe ? cuts.length - 1 : cuts.length,
  );
  const cells: string[] = [];
  let p = from;
  for (const c of inner) {
    cells.push(row.slice(p, c));
    p = c + 1;
  }
  cells.push(row.slice(p, to));
  return { cells, leadPipe, trailPipe };
}

function joinPipeRow(parts: {
  cells: string[];
  leadPipe: boolean;
  trailPipe: boolean;
}): string {
  return `${parts.leadPipe ? "|" : ""}${parts.cells.join("|")}${parts.trailPipe ? "|" : ""}`;
}

function makeSepCell(neighbor: string): string {
  const t = neighbor.trim();
  const dash = t.replace(/:/g, "") || "---";
  const dashes = dash.length >= 3 ? dash : "---";
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return `:${dashes}:`;
  if (left) return `:${dashes}`;
  if (right) return `${dashes}:`;
  return dashes;
}

function cellToPipeInner(merged: string): string {
  let s = merged;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s;
}

function rebuildSepLine(sepLine: string, colOps: AlignOp[]): string {
  const parts = splitPipeRow(sepLine);
  const cells: string[] = [];
  for (const op of colOps) {
    if (op.kind === "equal") {
      cells.push(parts.cells[op.ai] ?? " --- ");
    } else if (op.kind === "del") {
      continue;
    } else {
      const neighbor = cells[cells.length - 1] ?? parts.cells[0] ?? ":---";
      const pad = neighbor.match(/^(\s*)(.*?)(\s*)$/);
      const style = makeSepCell(neighbor);
      cells.push(`${pad?.[1] ?? ""}${style}${pad?.[3] ?? ""}`);
    }
  }
  return joinPipeRow({ ...parts, cells });
}

function rebuildTableRow(
  origMd: string,
  oRow: any,
  newMd: string,
  nRow: any,
  colOps: AlignOp[],
): string | null {
  const oStart = oRow.position?.start?.offset;
  const oEnd = oRow.position?.end?.offset;
  const nStart = nRow.position?.start?.offset;
  const nEnd = nRow.position?.end?.offset;
  if (oStart == null || oEnd == null || nStart == null || nEnd == null) return null;
  const oParts = splitPipeRow(origMd.slice(oStart, oEnd));
  const nParts = splitPipeRow(newMd.slice(nStart, nEnd));
  const oKids = kidsOf(origMd, oRow);
  const nKids = kidsOf(newMd, nRow);
  if (!oKids || !nKids) return null;

  const cells: string[] = [];
  for (const op of colOps) {
    if (op.kind === "equal") {
      const oKid = oKids[op.ai];
      const nKid = nKids[op.bi];
      const origCell = oParts.cells[op.ai];
      const newCell = nParts.cells[op.bi];
      if (origCell == null || newCell == null || !oKid || !nKid) return null;
      if (visibleOf(oKid.node) === visibleOf(nKid.node)) {
        cells.push(origCell);
      } else {
        const merged =
          mergePhrasing(origMd, oKid.node, origMd, oKid.node, newMd, nKid.node) ??
          spliceTextLikes(origMd, oKid.node, newMd, nKid.node);
        cells.push(merged != null ? cellToPipeInner(merged) : newCell);
      }
    } else if (op.kind === "del") {
      continue;
    } else {
      const newCell = nParts.cells[op.bi];
      if (newCell == null) return null;
      cells.push(newCell);
    }
  }
  return joinPipeRow({ ...oParts, cells });
}

function mergeTableRow(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  const oKids = kidsOf(origMd, o);
  const cKids = kidsOf(canonMd, c);
  const nKids = kidsOf(newMd, n);
  const oStart = o.position?.start?.offset;
  const oEnd = o.position?.end?.offset;
  if (!oKids || !cKids || !nKids || oStart == null || oEnd == null) return null;
  if (
    oKids.length !== nKids.length ||
    oKids.length !== cKids.length ||
    oKids.length === 0
  ) {
    return null;
  }
  let result = origMd.slice(oStart, oEnd);
  for (let i = oKids.length - 1; i >= 0; i--) {
    if (normalizeMd(cKids[i].text) === normalizeMd(nKids[i].text)) continue;
    const merged =
      mergeNode(
        origMd,
        oKids[i].node,
        canonMd,
        cKids[i].node,
        newMd,
        nKids[i].node,
      ) ?? spliceTextLikes(origMd, oKids[i].node, newMd, nKids[i].node);
    if (merged == null) return null;
    result =
      result.slice(0, oKids[i].start - oStart) +
      merged +
      result.slice(oKids[i].end - oStart);
  }
  return result;
}

function mergeTable(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  const oKids = kidsOf(origMd, o);
  const cKids = kidsOf(canonMd, c);
  const nKids = kidsOf(newMd, n);
  const oStart = o.position?.start?.offset;
  const oEnd = o.position?.end?.offset;
  if (!oKids || !cKids || !nKids || oStart == null || oEnd == null) return null;
  const origText = origMd.slice(oStart, oEnd);
  const sepLine = origText.split("\n").find(isTableSepLine);
  if (!sepLine) return null;

  const oHeader = kidsOf(origMd, oKids[0].node);
  const nHeader = kidsOf(newMd, nKids[0].node);
  const colOps =
    oHeader && nHeader && oHeader.length !== nHeader.length
      ? align(
          oHeader,
          nHeader,
          (a, b) => visibleOf(a.node) === visibleOf(b.node),
        )
      : null;

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

  const rows: string[] = [];
  for (const op of paired) {
    if (op.kind === "keep") {
      const origIdx = canonToOrig[op.ai];
      if (colOps && origIdx != null) {
        rows.push(
          rebuildTableRow(
            origMd,
            oKids[origIdx].node,
            newMd,
            nKids[op.bi].node,
            colOps,
          ) ?? (origIdx != null ? oKids[origIdx].text : nKids[op.bi].text),
        );
      } else {
        rows.push(origIdx != null ? oKids[origIdx].text : nKids[op.bi].text);
      }
    } else if (op.kind === "merge") {
      const origIdx = canonToOrig[op.ai];
      let content: string | null = null;
      if (origIdx != null) {
        content = colOps
          ? rebuildTableRow(
              origMd,
              oKids[origIdx].node,
              newMd,
              nKids[op.bi].node,
              colOps,
            )
          : mergeTableRow(
              origMd,
              oKids[origIdx].node,
              canonMd,
              cKids[op.ai].node,
              newMd,
              nKids[op.bi].node,
            );
      }
      rows.push(content ?? nKids[op.bi].text);
    } else {
      rows.push(nKids[op.bi].text);
    }
  }
  if (rows.length === 0) return null;
  const outSep = colOps ? rebuildSepLine(sepLine, colOps) : sepLine;
  return [rows[0], outSep, ...rows.slice(1)].join("\n");
}

function mergeCode(
  origMd: string,
  o: any,
  canonMd: string,
  c: any,
  newMd: string,
  n: any,
): string | null {
  const oStart = o.position?.start?.offset;
  const oEnd = o.position?.end?.offset;
  if (oStart == null || oEnd == null) return null;
  const raw = origMd.slice(oStart, oEnd);
  const trailNl = raw.endsWith("\n") ? "\n" : "";
  const lines = raw.slice(0, raw.length - trailNl.length).split("\n");
  if (lines.length < 2) return null;
  const open = lines[0];
  const om = open.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
  if (!om) return null;
  const langChanged = (c?.lang ?? "") !== (n?.lang ?? "");
  const newOpen = langChanged
    ? `${om[1]}${om[2]}${n.lang ?? ""}${n.meta ? ` ${n.meta}` : ""}`
    : open;
  // A fence left unclosed at EOF is legal CommonMark. Taking the last line as
  // the closing fence there would re-emit a line of code below the new body.
  const closeRe = new RegExp(
    `^\\s*${om[2][0] === "\`" ? "\`" : "~"}{${om[2].length},}\\s*$`,
  );
  const close = closeRe.test(lines[lines.length - 1])
    ? lines[lines.length - 1]
    : null;
  const bodyIndent = close?.match(/^(\s*)/)?.[1] ?? om[1];
  const body = String(n.value ?? "")
    .split("\n")
    .map((l: string) => bodyIndent + l)
    .join("\n");
  return close != null
    ? `${newOpen}\n${body}\n${close}${trailNl}`
    : `${newOpen}\n${body}${trailNl}`;
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
  const oImgs = imagesOf(origNode);
  const nImgs = imagesOf(newNode);
  if (oImgs.length !== nImgs.length) return null;
  const oLinks = linksOf(origNode);
  const nLinks = linksOf(newNode);
  if (oLinks.length !== nLinks.length) return null;
  if (oLeaves.length === 0 && oImgs.length === 0 && oLinks.length === 0) {
    return origMd.slice(oStart, oEnd);
  }
  type Rep = { start: number; end: number; text: string };
  const reps: Rep[] = [];
  for (let i = 0; i < oLeaves.length; i++) {
    reps.push({
      start: oLeaves[i].start,
      end: oLeaves[i].end,
      text: nLeaves[i].value,
    });
  }
  for (let i = 0; i < oImgs.length; i++) {
    const s = oImgs[i].position?.start?.offset;
    const e = oImgs[i].position?.end?.offset;
    if (s == null || e == null) return null;
    const rewritten = rewriteImage(origMd.slice(s, e), oImgs[i], nImgs[i]);
    if (rewritten == null) return null;
    reps.push({ start: s, end: e, text: rewritten });
  }
  for (let i = 0; i < oLinks.length; i++) {
    const s = oLinks[i].position?.start?.offset;
    const e = oLinks[i].position?.end?.offset;
    if (s == null || e == null) return null;
    if ((oLinks[i].url ?? "") === (nLinks[i].url ?? "")) continue;
    const span = linkDestSpan(origMd.slice(s, e));
    if (!span) return null;
    const urlPart = span.angled ? `<${nLinks[i].url ?? ""}>` : (nLinks[i].url ?? "");
    reps.push({ start: s + span.start, end: s + span.end, text: urlPart });
  }
  reps.sort((a, b) => b.start - a.start);
  let result = origMd.slice(oStart, oEnd);
  for (const r of reps) {
    result =
      result.slice(0, r.start - oStart) + r.text + result.slice(r.end - oStart);
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
  // Always emit only the container's own prefix (list marker, `>` , …), never
  // the bytes of leading kids. Anchoring on the first *surviving* kid would
  // re-emit every kid the user deleted ahead of it.
  result += origMd.slice(parentStart, oKids[0]?.start ?? parentStart);
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
      } else if (defaultSep === "") {
        // phrasing: pieces sit next to each other with no extra separator
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
  // Mirror of the head: the trailing slice starts at the last kid we actually
  // emitted only when that *is* the last original kid. Otherwise the kids
  // after it were deleted, and only the container's own suffix survives.
  const last = pieces[pieces.length - 1];
  const lastKidEnd = oKids[oKids.length - 1].end;
  const tailFrom =
    last.origIdx != null && oKids[last.origIdx].end >= lastKidEnd
      ? oKids[last.origIdx].end
      : lastKidEnd;
  result += origMd.slice(tailFrom, parentEnd);
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
  adaptInsert?: (text: string, kid: Kid) => string,
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
      const raw = nKids[op.bi].text;
      pieces.push({
        content: adaptInsert ? adaptInsert(raw, nKids[op.bi]) : raw,
        origIdx: null,
      });
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

  let result: string | null = null;
  if (c && c.type === "listItem") {
    const oKids = kidsOf(origMd, o);
    const cKids = kidsOf(canonMd, c);
    const nKids = kidsOf(newMd, n);
    const oStart = o.position?.start?.offset;
    const oEnd = o.position?.end?.offset;
    if (oKids && cKids && nKids && oStart != null && oEnd != null) {
      result = mergeKids(
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
    }
  }
  if (result == null) result = marker + newBody;
  return applyCheckboxState(result, o, n);
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
    return mergeKids(
      origMd,
      oKids,
      canonMd,
      cKids,
      newMd,
      nKids,
      oStart,
      oEnd,
      "\n",
      (text) => restyleInsertedListItem(text, oKids, origMd),
    );
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
    const qprefix = quoteLinePrefix(origMd, o);
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
      (text) => prefixQuoteLines(text, qprefix),
    );
  }

  if (o.type === "table") {
    if (!c || c.type !== "table") return null;
    return mergeTable(origMd, o, canonMd, c, newMd, n);
  }

  if (o.type === "tableRow") {
    if (!c || c.type !== "tableRow") return null;
    return mergeTableRow(origMd, o, canonMd, c, newMd, n);
  }

  if (o.type === "tableCell") {
    return mergePhrasing(origMd, o, canonMd, c, newMd, n);
  }

  if (o.type === "code") {
    if (!c || c.type !== "code") return null;
    return mergeCode(origMd, o, canonMd, c, newMd, n);
  }

  if (o.type === "thematicBreak") {
    const s = o.position?.start?.offset;
    const e = o.position?.end?.offset;
    if (s == null || e == null) return null;
    return origMd.slice(s, e);
  }

  if (o.type === "paragraph" || o.type === "heading") {
    if (o.type === "heading" && o.depth !== n.depth) return null;
    return mergePhrasing(origMd, o, canonMd, c, newMd, n);
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
      (t) => restyleInsertedListItem(t, oItems, origText),
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
  // Everything before the first original block (frontmatter, leading blank
  // lines) is kept verbatim. Anchoring on the first *surviving* block instead
  // would re-emit every block the user deleted ahead of it.
  result += original.slice(0, origBlocks[0].start);

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

  // Same rule at the tail: only the last original block carries the document
  // tail with it. If we stopped earlier, the blocks after it were deleted and
  // only the trailing whitespace survives.
  const last = out[out.length - 1];
  const docEnd = origBlocks[origBlocks.length - 1].end;
  const lastEnd =
    last.origEnd ?? (last.origIdx != null ? origBlocks[last.origIdx].end : null);
  result += original.slice(lastEnd != null && lastEnd >= docEnd ? lastEnd : docEnd);

  return result;
}
