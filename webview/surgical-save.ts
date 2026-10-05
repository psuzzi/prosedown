/**
 * Surgical save — write back only the blocks the user edited.
 *
 * The file's own markdown (`body`) is the source of truth. The editor can only
 * hand us a full re-serialize of the document, which restyles everything
 * (bullets, table padding, escapes) and drops what it cannot represent (raw
 * HTML, comments, link definitions). So we never save that serialize. We use
 * it to *locate* the edit:
 *
 *   canon = serialize(document as loaded)      next = serialize(document now)
 *
 * Both come from the same serializer, so restyling cancels out and
 * `canon → next` differs only where the user edited. We find that span by
 * scanning from both ends, map it onto `body`, and replace just those blocks
 * with the serializer's text. Every other byte of the file is left alone.
 *
 * Idea (diffing two serializes) from Buqian Zheng's PR #87.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

interface Block {
  type: string;
  start: number;
  end: number;
}

/** The same stretch of the document, as offsets into `body` and into `canon`. */
interface Region {
  body: { start: number; end: number };
  canon: { start: number; end: number };
}

export interface Baseline {
  /** Markdown as it is on disk (frontmatter stripped). */
  body: string;
  /** What the serializer makes of that same document. */
  canon: string;
  regions: Region[];
}

function blocksOf(md: string): Block[] {
  return parser.parse(md).children.map((n) => ({
    type: n.type,
    start: n.position!.start.offset!,
    end: n.position!.end.offset!,
  }));
}

/** How far ahead to look for the point where `body` and `canon` line up again. */
const RESYNC = 8;

/**
 * Pair each stretch of `body` with the stretch of `canon` it serializes to.
 * Most blocks pair 1:1. Where the serializer drops, splits or merges blocks,
 * the unmatched blocks on both sides form one region. Blocks it always drops
 * (raw HTML, comments, link definitions) belong to no region: they sit in the
 * gap between two, and gaps are never rewritten.
 */
export function createBaseline(body: string, canon: string): Baseline {
  // Raw HTML and link definitions never survive serialization (HTML is
  // dropped, links come back inline), so they are never part of a region.
  const B = blocksOf(body).filter(
    (b) => b.type !== "html" && b.type !== "definition",
  );
  const C = blocksOf(canon);
  // Letters and digits only: blind to markers, escapes, padding and wrapping.
  const key = (md: string, b: Block) =>
    md.slice(b.start, b.end).replace(/[^\p{L}\p{N}]+/gu, "");
  const bk = B.map((b) => key(body, b));
  const ck = C.map((c) => key(canon, c));

  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  while (i < B.length && j < C.length) {
    // Nearest (di, dj) at which the two sides agree again; (1, 1) if none.
    let di = 1;
    let dj = 1;
    search: for (let d = 0; d <= 2 * RESYNC; d++) {
      for (let x = Math.max(0, d - RESYNC); x <= Math.min(d, RESYNC); x++) {
        if (bk[i + x] !== undefined && bk[i + x] === ck[j + d - x]) {
          di = x;
          dj = d - x;
          break search;
        }
      }
    }
    if (di === 0 && dj === 0) di = dj = 1; // same block on both sides
    const last = regions[regions.length - 1];
    if (di > 0 && dj > 0) {
      regions.push({
        body: { start: B[i].start, end: B[i + di - 1].end },
        canon: { start: last ? C[j].start : 0, end: C[j + dj - 1].end },
      });
    } else if (last && dj > 0) {
      last.canon.end = C[j + dj - 1].end; // added by the serializer
    }
    i += di;
    j += dj;
  }
  const last = regions[regions.length - 1];
  if (last && j < C.length) last.canon.end = C[C.length - 1].end;
  return { body, canon, regions };
}

/**
 * A baseline for text the serializer produced itself: every block maps to
 * itself. `lead` is original text to keep in front of it.
 */
function identityBaseline(md: string, lead = ""): Baseline {
  const regions = blocksOf(md).map(({ start, end }) => ({
    body: { start: lead.length + start, end: lead.length + end },
    canon: { start, end },
  }));
  return { body: lead + md, canon: md, regions };
}

/**
 * Fold a new serialize into the baseline. The returned baseline's `body` is
 * the markdown to save.
 */
export function applySerialized(base: Baseline, next: string): Baseline {
  const { body, canon, regions } = base;
  if (next === canon) return base;
  const R = regions.length;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  // Nothing the editor could show (an empty file, or only dropped blocks):
  // whatever was typed goes after it.
  if (R === 0) {
    const kept = body.trimEnd();
    return identityBaseline(next, kept ? kept + eol + eol : "");
  }

  // 1. The span of the serialize that changed, by scanning from both ends.
  const max = Math.min(canon.length, next.length);
  let p = 0;
  while (p < max && canon.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    canon.charCodeAt(canon.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  )
    s++;
  const delta = next.length - canon.length;

  // 2. Regions [a, b) cover that span, plus one region of margin on each side:
  //    the block just before an edit can change shape without changing bytes
  //    (a list gaining an item), and likewise the one just after.
  let a = 0;
  while (a < R && regions[a].canon.end <= p) a++;
  a = Math.max(0, a - 1);
  let b = R;
  while (b > a && regions[b - 1].canon.start >= canon.length - s) b--;
  b = Math.min(R, b + 1);

  // 3. Parse only that window of the new serialize (offsets into `next`).
  const windowBlocks = () => {
    const from = a === 0 ? 0 : regions[a].canon.start;
    const to = b < R ? regions[b].canon.start + delta : next.length;
    return blocksOf(next.slice(from, to)).map((blk) => ({
      ...blk,
      start: blk.start + from,
      end: blk.end + from,
    }));
  };
  let nb = windowBlocks();

  // 4. Give the margins back where they turn out to be untouched.
  if (a < b && regions[a].canon.end <= p) {
    const last = nb.findIndex((blk) => blk.end === regions[a].canon.end);
    if (last >= 0 && nb[0].start === regions[a].canon.start) {
      nb = nb.slice(last + 1);
      a++;
    }
  }
  if (a < b && regions[b - 1].canon.start >= canon.length - s) {
    const first = nb.findIndex((blk) => blk.start === regions[b - 1].canon.start + delta);
    if (first >= 0 && nb[nb.length - 1].end === regions[b - 1].canon.end + delta) {
      nb = nb.slice(0, first);
      b--;
    }
  }

  // 5–6. Splice, and check the seam. New text can change how a kept
  //      neighbour parses (a list swallowing an indented block); when it
  //      does, take one more region on each side and try again.
  for (;;) {
    const spliced = splice(base, next, a, b, nb, eol);
    if (spliced) return spliced;
    if (a === 0 && b === R) return identityBaseline(next);
    a = Math.max(0, a - 1);
    b = Math.min(R, b + 1);
    nb = windowBlocks();
  }
}

/**
 * Replace regions [a, b) of the baseline with the blocks `nb` of `next`.
 * Returns null if the kept neighbours would no longer parse as the blocks
 * they were.
 */
function splice(
  { body, canon, regions }: Baseline,
  next: string,
  a: number,
  b: number,
  nb: Block[],
  eol: string,
): Baseline | null {
  const R = regions.length;
  const toEol = (t: string) => (eol === "\n" ? t : t.replace(/\n/g, eol));
  // Spacing next to new text must hold a blank line, or the blocks would fuse.
  const blank = (ws: string) => (/\n[ \t]*\r?\n/.test(ws) ? ws : eol + eol);
  // Gaps hold the original spacing and any block the serializer drops. The
  // gaps on either side of the window stay as they are; dropped blocks from
  // gaps inside it are kept too, after the new text.
  const gap = (r: number) => body.slice(regions[r - 1].body.end, regions[r].body.start);
  const before = a > 0 && a < R ? gap(a) : "";
  const after = b > a && b < R ? gap(b) : "";
  const dropped: string[] = [];
  for (let r = a + 1; r <= b && r < R; r++) {
    if (gap(r).trim()) dropped.push(gap(r).trim());
  }

  const head = body.slice(0, a > 0 ? regions[a - 1].body.end : regions[0].body.start);
  const tail = body.slice(b < R ? regions[b].body.start : regions[R - 1].body.end);

  // Between the kept head and tail: a dropped block from the gap in front,
  // the new blocks, the dropped blocks from the gaps inside and behind.
  const left = a > 0 ? blank(/^\s*/.exec(before)![0]) : "";
  const right = b < R ? blank(/\s*$/.exec(after || before)![0]) : "";
  let inner = before.trim();
  const added: Region[] = [];
  nb.forEach((blk, k) => {
    if (inner) inner += k > 0 ? toEol(next.slice(nb[k - 1].end, blk.start)) : eol + eol;
    const start = head.length + left.length + inner.length;
    inner += toEol(next.slice(blk.start, blk.end));
    added.push({
      body: { start, end: head.length + left.length + inner.length },
      canon: { start: blk.start, end: blk.end },
    });
  });
  for (const d of dropped) inner += (inner ? eol + eol : "") + d;
  // Nothing left in the window: one spacing joins head and tail, none at an edge.
  const mid = inner ? left + inner + right : a > 0 ? right : "";
  const newBody = head + mid + tail;
  const grown = newBody.length - body.length;

  const lo = a > 0 ? regions[a - 1].body.start : 0;
  const hi = b < R ? regions[b].body.end : body.length;
  const types = (md: string) => blocksOf(md).map((x) => x.type);
  const expected = [
    ...types(body.slice(lo, head.length) + before),
    ...nb.map((x) => x.type),
    ...types(dropped.join("\n\n")),
    ...types(body.slice(body.length - tail.length, hi)),
  ];
  if (expected.join() !== types(newBody.slice(lo, hi + grown)).join()) return null;

  const delta = next.length - canon.length;
  return {
    body: newBody,
    canon: next,
    regions: [
      ...regions.slice(0, a),
      ...added,
      ...regions.slice(b).map((r) => ({
        body: { start: r.body.start + grown, end: r.body.end + grown },
        canon: { start: r.canon.start + delta, end: r.canon.end + delta },
      })),
    ],
  };
}
