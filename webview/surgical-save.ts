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
 * the unmatched blocks on both sides form one region. A block it drops
 * entirely (raw HTML, a comment, a link definition) belongs to no region: it
 * sits in the gap between two, and gaps are never rewritten.
 */
export function createBaseline(body: string, canon: string): Baseline {
  // Link definitions never survive serialization (links come back inline), so
  // they are never part of a region.
  const B = blocksOf(body).filter((b) => b.type !== "definition");
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

/** A baseline for text the serializer produced itself: every block maps to itself. */
function identityBaseline(md: string): Baseline {
  const regions = blocksOf(md).map(({ start, end }) => ({
    body: { start, end },
    canon: { start, end },
  }));
  return { body: md, canon: md, regions };
}

/**
 * Fold a new serialize into the baseline. The returned baseline's `body` is
 * the markdown to save.
 */
export function applySerialized(base: Baseline, next: string): Baseline {
  const { body, canon, regions } = base;
  if (next === canon) return base;
  const R = regions.length;
  if (R === 0) return identityBaseline(next);

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

  // 3. Parse only that window of the new serialize.
  const from = a === 0 ? 0 : regions[a].canon.start;
  const to = b < R ? regions[b].canon.start + delta : next.length;
  const win = next.slice(from, to);
  let nb = blocksOf(win);

  // 4. Give the margins back where they turn out to be untouched.
  const boundary = (offset: number, edge: "start" | "end") =>
    nb.findIndex((blk) => blk[edge] + from === offset);
  if (a < b && regions[a].canon.end <= p) {
    const first = boundary(regions[a].canon.start, "start");
    const lastIdx = boundary(regions[a].canon.end, "end");
    if (first === 0 && lastIdx >= 0) {
      nb = nb.slice(lastIdx + 1);
      a++;
    }
  }
  if (a < b && regions[b - 1].canon.start >= canon.length - s) {
    const first = boundary(regions[b - 1].canon.start + delta, "start");
    const lastIdx = boundary(regions[b - 1].canon.end + delta, "end");
    if (first >= 0 && lastIdx === nb.length - 1) {
      nb = nb.slice(0, first);
      b--;
    }
  }

  // 5. Splice the serializer's text for those blocks into the original bytes.
  //    The gaps on either side of the window stay: they hold the original
  //    spacing and any block the serializer drops.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const toEol = (t: string) => (eol === "\n" ? t : t.replace(/\n/g, eol));
  // Spacing next to new text must hold a blank line, or the blocks would fuse.
  const blank = (ws: string) => (/\n[ \t]*\r?\n/.test(ws) ? ws : eol + eol);
  const gap = (r: number) => body.slice(regions[r - 1].body.end, regions[r].body.start);
  const before = a > 0 && a < R ? gap(a) : "";
  const after = b > a && b < R ? gap(b) : "";

  const head = body.slice(0, a > 0 ? regions[a - 1].body.end : regions[0].body.start);
  const tail = body.slice(b < R ? regions[b].body.start : regions[R - 1].body.end);

  // Between the kept head and tail: a dropped block from the gap in front,
  // the new blocks, a dropped block from the gap behind.
  const left = a > 0 ? blank(/^\s*/.exec(before)![0]) : "";
  const right = b < R ? blank(/\s*$/.exec(after || before)![0]) : "";
  let inner = before.trim();
  const added: Region[] = [];
  nb.forEach((blk, k) => {
    if (inner) inner += k > 0 ? toEol(win.slice(nb[k - 1].end, blk.start)) : eol + eol;
    const start = head.length + left.length + inner.length;
    inner += toEol(win.slice(blk.start, blk.end));
    added.push({
      body: { start, end: head.length + left.length + inner.length },
      canon: { start: from + blk.start, end: from + blk.end },
    });
  });
  if (after.trim()) inner += (inner ? eol + eol : "") + after.trim();
  // Nothing left in the window: one spacing joins head and tail, none at an edge.
  const mid = inner ? left + inner + right : a > 0 ? right : "";
  const newBody = head + mid + tail;

  // 6. The kept neighbours must still parse as the blocks they were — new
  //    text can capture what follows it (a list swallowing an indented block).
  //    If the seam does not hold, save the plain serialize instead.
  const lo = a > 0 ? regions[a - 1].body.start : 0;
  const hiOld = b < R ? regions[b].body.end : body.length;
  const types = (md: string) => blocksOf(md).map((x) => x.type);
  const expected = [
    ...types(body.slice(lo, head.length) + before),
    ...nb.map((x) => x.type),
    ...types(after + body.slice(body.length - tail.length, hiOld)),
  ];
  const actual = types(newBody.slice(lo, hiOld + newBody.length - body.length));
  if (expected.join() !== actual.join()) return identityBaseline(next);

  const shift = (r: Region, dBody: number, dCanon: number): Region => ({
    body: { start: r.body.start + dBody, end: r.body.end + dBody },
    canon: { start: r.canon.start + dCanon, end: r.canon.end + dCanon },
  });
  return {
    body: newBody,
    canon: next,
    regions: [
      ...regions.slice(0, a),
      ...added,
      ...regions.slice(b).map((r) => shift(r, newBody.length - body.length, delta)),
    ],
  };
}
