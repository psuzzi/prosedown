/**
 * Markdown formatting preferences.
 * These control how Tiptap's output is serialized back to markdown.
 *
 * See remark-stringify options:
 * https://github.com/remarkjs/remark/tree/main/packages/remark-stringify#options
 */
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { DEFAULT_SETTINGS, type ProsedownSettings } from "./settings";

/**
 * Build a remark-stringify options object from user settings.
 * `strong` and `emphasis` are single-char in remark's API (the stringifier
 * doubles strong automatically), so we map our user-friendly `**`/`__` down.
 */
export function buildMarkdownConfig(settings: ProsedownSettings = DEFAULT_SETTINGS) {
  return {
    bullet: settings.bullet,
    bulletOther: (settings.bullet === "-" ? "*" : "-") as "-" | "*" | "+",
    bulletOrdered: "." as const,
    listItemIndent: settings.listItemIndent,
    emphasis: settings.emphasis,
    strong: (settings.strong === "**" ? "*" : "_") as "*" | "_",
    fence: "`" as const,
    fences: true,
    rule: settings.rule,
    // Ordered-list numbering is the serializer's job: true re-sequences from the
    // list's start (1,2,3…); false keeps each item's own number. This replaces
    // the old text pass `renumberOrderedLists` (slice 2 of #78), so it can never
    // touch a numbered list shown inside a fenced code block.
    incrementListMarker: settings.renumberOrderedLists,
  };
}

/** Back-compat export for the default config. */
export const MARKDOWN_CONFIG = buildMarkdownConfig(DEFAULT_SETTINGS);

/**
 * The shared HTML → markdown pipeline:
 * rehype-parse → rehype-remark → remark-gfm → remark-stringify.
 *
 * Defined once and used by both the save path and the clipboard path in
 * `useVSCodeSync.ts` and by the test mirror in `test/pipeline.ts`, so the three
 * cannot drift. This is also the seam that future mdast transforms plug into
 * (added with `.use(...)` before `remark-stringify`, where the tree is still
 * live). Callers pick `.process()` (async) or `.processSync()`.
 */
export function buildMdPipeline(settings: ProsedownSettings = DEFAULT_SETTINGS) {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(codeInfoTransform, settings)
    .use(orderedListGuard)
    .use(listCompactTransform, settings)
    .use(imageDedupTransform, settings)
    .use(remarkStringify, buildMarkdownConfig(settings));
}

/**
 * Guard against an illegal ordered-list marker. CommonMark caps ordered markers
 * at 9 digits; remark-stringify increments from `list.start`, so a list starting
 * near the cap would emit a 10-digit marker (e.g. 999999999 → 1000000000). That
 * is no longer a list item and would break on the next parse, so reset such a
 * list to start at 1. Replaces the clamp the old text `renumberOrderedLists`
 * carried (#54); operates on the tree, so it never sees fenced code.
 */
function orderedListGuard() {
  return (tree: Root) => {
    visit(tree, "list", (node) => {
      if (!node.ordered) return;
      const start = node.start ?? 1;
      if (start + Math.max(0, node.children.length - 1) > 999_999_999) {
        node.start = 1;
      }
    });
  };
}

/**
 * Normalize fenced-code **info strings** on the mdast (a `code` node's `lang`),
 * before serialization. This is the tree-based replacement for the old text
 * passes `shellscriptToBash` and `applyDefaultCodeBlockLang` — and because it
 * walks `code` nodes, it can only ever touch a real fence, never a fence shown
 * *inside* another fence (whose body is the opaque `code.value`).
 *
 * - `shellscript` → `bash` (when the setting is on).
 * - a bare fence gets the user's `defaultCodeBlockLang`, if any.
 * - with no default set, a `text`/`plaintext` label is stripped (never a real
 *   language) — mirrors the old behaviour exactly.
 */
function codeInfoTransform(settings: ProsedownSettings) {
  return (tree: Root) => {
    const dflt = settings.defaultCodeBlockLang;
    visit(tree, "code", (node) => {
      if (settings.shellscriptToBash && node.lang === "shellscript") {
        node.lang = "bash";
      }
      if (!node.lang && dflt) {
        node.lang = dflt;
      } else if (
        node.lang &&
        !dflt &&
        (node.lang === "text" || node.lang === "plaintext")
      ) {
        node.lang = null;
      }
    });
  };
}

/**
 * Tight lists. remark-stringify keeps a list "loose" (blank lines between items)
 * when the mdast marks it spread; the old text pass `compactLists` stripped those
 * blanks. On the tree that is clearing the LIST's `spread` flag — and it can
 * never reach a list shown inside a fenced code block. An item's own spread is
 * left alone, so a blank line between an item and its indented child block is
 * preserved (matching the old pass).
 */
function listCompactTransform(settings: ProsedownSettings) {
  return (tree: Root) => {
    if (!settings.compactLists) return;
    visit(tree, "list", (node) => {
      node.spread = false;
      for (const item of node.children) {
        // Tighten only the canonical nested-list item: a leading paragraph
        // immediately followed by a sublist (parent → sublist has no blank line).
        // Any other shape — a trailing paragraph after the sublist, or two
        // paragraphs — is left loose, so its blank lines are preserved and the
        // result stays a fixed point across saves (matches the old text pass).
        if (item.children.length === 2 && item.children[1].type === "list") {
          item.spread = false;
        }
      }
    });
  };
}

/**
 * Remove a paragraph that only repeats the preceding image's alt text. The editor
 * can emit an image and then a caption paragraph with the same text; an editor
 * should never persist duplicate content. Tree form of the old `dedupImageAltText`
 * pass — it works on sibling nodes, so it can never touch a fenced code block.
 */
function imageDedupTransform(settings: ProsedownSettings) {
  return (tree: Root) => {
    if (!settings.dedupImageAltText) return;
    visit(tree, "paragraph", (node, index, parent) => {
      if (!parent || index == null) return;
      const only = node.children.length === 1 ? node.children[0] : undefined;
      if (!only || only.type !== "image" || !only.alt) return;
      // Drop EVERY consecutive paragraph that only repeats this image's alt, so a
      // run of duplicates collapses in a single pass (stays a fixed point).
      for (;;) {
        const next = parent.children[index + 1];
        if (
          next &&
          next.type === "paragraph" &&
          next.children.length === 1 &&
          next.children[0].type === "text" &&
          next.children[0].value === only.alt
        ) {
          parent.children.splice(index + 1, 1);
        } else {
          break;
        }
      }
    });
  };
}

/**
 * Post-process markdown to fix formatting issues
 * that remark-stringify doesn't handle correctly.
 *
 * Every step corresponds to a toggleable setting; passing no settings
 * uses the defaults (which enable everything).
 */
export function normalizeMarkdown(
  md: string,
  settings: ProsedownSettings = DEFAULT_SETTINGS
): string {
  // Bullet marker, ordered-list spacing, and ordered-list renumbering are all
  // handled natively by remark-stringify now (the `bullet` and
  // `incrementListMarker` options + `orderedListGuard`), inside buildMdPipeline
  // and before serialization — so they can never rewrite a list shown inside a
  // fenced code block (slice 2 of #78).
  md = fixTaskLists(md);
  if (settings.unescapeSpecialChars) {
    md = unescapeSpecialChars(md);
  }
  if (settings.fixTableHeaders) {
    md = fixTableHeaders(md);
  }
  md = padTables(md);
  // Duplicate image-caption removal now handled on the tree (imageDedupTransform
  // in buildMdPipeline, slice 3b of #78) — never touches content inside a fence.
  md = stripAutolinks(md);
  md = unescapeBareUrls(md);
  md = replaceSafetyEntities(md);
  // List tightness now handled on the tree (listCompactTransform in
  // buildMdPipeline, slice 3 of #78) — never touches a list shown in a fence.
  return md;
}

/**
 * Run `fn` on each line that is OUTSIDE a fenced code block; fence lines and the
 * lines inside a fence pass through untouched. Handles both ``` and ~~~ fences,
 * 0–3 spaces of indent, and a closer that matches the opener's char and is at
 * least as long (CommonMark §4.5). Shared by every post-stringify text pass so
 * none of them can rewrite content shown inside a fence (slice 4 of #78).
 */
function eachLineOutsideFences(md: string, fn: (line: string) => string): string {
  const lines = md.split("\n");
  let fence: { char: string; len: number } | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const ticks = m[1];
      if (!fence) {
        fence = { char: ticks[0], len: ticks.length };
      } else if (
        ticks[0] === fence.char &&
        ticks.length >= fence.len &&
        m[2].trim() === ""
      ) {
        fence = null; // matching closer
      }
      out.push(line); // fence lines are never transformed
      continue;
    }
    out.push(fence ? line : fn(line));
  }
  return out.join("\n");
}

/**
 * Run `fn` on the parts of a line that are OUTSIDE inline code spans; the code
 * spans (backtick-delimited) pass through untouched.
 */
function outsideInlineCode(line: string, fn: (segment: string) => string): string {
  let out = "";
  let remaining = line;
  while (remaining.length > 0) {
    const tick = remaining.indexOf("`");
    if (tick === -1) {
      out += fn(remaining);
      break;
    }
    out += fn(remaining.slice(0, tick));
    const end = remaining.indexOf("`", tick + 1);
    if (end === -1) {
      out += remaining.slice(tick);
      break;
    }
    out += remaining.slice(tick, end + 1);
    remaining = remaining.slice(end + 1);
  }
  return out;
}

/**
 * Remove unnecessary backslash escapes that remark-stringify adds
 * (`\~ \* \_ \[ \=`) outside code blocks/spans, so the saved source is clean.
 * Preserves real strikethrough (~~text~~) and emphasis markers.
 */
function unescapeSpecialChars(md: string): string {
  return eachLineOutsideFences(md, (line) =>
    outsideInlineCode(line, unescapeText)
  );
}

function unescapeText(text: string): string {
  // Remove backslash before ~ (remark-gfm escapes tildes)
  text = text.replace(/\\~/g, "~");
  // Unescape escaped bold/strong markers (\*\* → **).
  // remark-stringify escapes opening ** when followed by $ (remark-math
  // declares $ as unsafe). Match \*\* acting as an opener (followed by
  // non-whitespace) or closer (preceded by non-whitespace).
  text = text.replace(/\\\*\\\*(?=\S)/g, "**");
  text = text.replace(/(?<=\S)\\\*\\\*/g, "**");
  // Remove backslash before * that isn't part of bold/emphasis markup
  // Only unescape standalone \* (e.g. "2 \* 3") not emphasis markers
  text = text.replace(/(?<=\s|^)\\\*(?=\s|$)/g, "*");
  // Remove backslash before _ inside words (e.g. future\_relevance → future_relevance)
  // but keep \_ at word boundaries where it prevents emphasis.
  // Use Unicode property escapes so non-ASCII letters (β, 日, 文…) count as
  // word chars — plain \w is ASCII-only.
  text = text.replace(/([\p{L}\p{N}_])\\_([\p{L}\p{N}_])/gu, "$1_$2");
  // Remove backslash before [ when not part of a link (remark escapes all [)
  text = text.replace(/\\\[/g, "[");
  // Remove backslash before = when followed by a non-= non-whitespace char
  // (remark escapes = to prevent setext headings, but "=> text" is never one)
  text = text.replace(/\\=(?=[^=\s])/g, "=");
  return text;
}

/**
 * Fix task list formatting. BlockNote produces patterns like:
 *   - \[ ] text   or   - [ ]\n\n    text
 * Merges them into: - [ ] text
 */
function fixTaskLists(md: string): string {
  md = md.replace(/^(\s*-\s)\\\[(\s)\\\]/gm, "$1[$2]");
  md = md.replace(/^(\s*-\s)\\\[([xX])\\\]/gm, "$1[$2]");
  md = md.replace(/^(\s*-\s)\\(\[[\sxX]\])/gm, "$1$2");

  const lines = md.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const checkboxMatch = line.match(/^(\s*-\s\[[\sxX]\])\s*$/);
    if (checkboxMatch) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].trim() !== "") {
        result.push(`${checkboxMatch[1]} ${lines[j].trim()}`);
        i = j + 1;
        continue;
      }
    }

    const indentedTask = line.match(/^\s{2,}(-\s\[[\sxX]\]\s*.*)$/);
    if (
      indentedTask &&
      result.length > 0 &&
      /^-\s*$/.test(result[result.length - 1].trim())
    ) {
      result.pop();
      result.push(indentedTask[1]);
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  // Remove blank lines between consecutive task list items
  const final: string[] = [];
  for (let k = 0; k < result.length; k++) {
    if (
      result[k].trim() === "" &&
      k > 0 &&
      /^-\s\[[\sxX]\]\s/.test(result[k - 1]) &&
      k + 1 < result.length &&
      /^-\s\[[\sxX]\]\s/.test(result[k + 1])
    ) {
      continue;
    }
    final.push(result[k]);
  }
  return final.join("\n");
}

/**
 * Fix tables where rehype-remark adds an empty header row.
 */
function fixTableHeaders(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (/^\|.+\|/.test(lines[i])) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      if (
        tableLines.length >= 3 &&
        isEmptyRow(tableLines[0]) &&
        isSeparatorRow(tableLines[1])
      ) {
        const dataRows = tableLines.slice(2);
        result.push(dataRows[0]);
        result.push(buildSeparator(dataRows));
        result.push(...dataRows.slice(1));
      } else if (tableLines.length >= 2 && isSeparatorRow(tableLines[1])) {
        const dataRows = [tableLines[0], ...tableLines.slice(2)];
        result.push(tableLines[0]);
        result.push(buildSeparator(dataRows));
        result.push(...tableLines.slice(2));
      } else {
        result.push(...tableLines);
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join("\n");
}

/**
 * Pad all table cells to uniform column widths with aligned separators.
 * This normalizes tables to expanded format so remark-stringify's own
 * padding doesn't cause cosmetic diffs on the first round-trip.
 */
function padTables(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (/^\|.+\|/.test(lines[i])) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      // Compute column widths across all data rows
      const colWidths: number[] = [];
      for (const tl of tableLines) {
        if (isSeparatorRow(tl)) continue;
        const cells = splitTableRow(tl);
        cells.forEach((c, idx) => {
          colWidths[idx] = Math.max(colWidths[idx] || 3, c.trim().length);
        });
      }

      for (const tl of tableLines) {
        if (isSeparatorRow(tl)) {
          result.push(
            "|" +
              colWidths
                .map((w) => " " + "-".repeat(Math.max(w, 3)) + " ")
                .join("|") +
              "|"
          );
        } else {
          const cells = splitTableRow(tl);
          result.push(
            "| " +
              cells
                .map((c, idx) => c.trim().padEnd(colWidths[idx] || 3))
                .join(" | ") +
              " |"
          );
        }
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join("\n");
}

function buildSeparator(rows: string[]): string {
  const colWidths: number[] = [];
  for (const row of rows) {
    const cells = splitTableRow(row);
    cells.forEach((cell, idx) => {
      colWidths[idx] = Math.max(colWidths[idx] || 3, cell.trim().length);
    });
  }
  return (
    "|" +
    colWidths.map((w) => " " + "-".repeat(Math.max(w, 3)) + " ").join("|") +
    "|"
  );
}

/** Split a markdown table row into cells, respecting | inside backtick spans. */
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  // Skip leading |
  let i = row.indexOf("|") + 1;
  for (; i < row.length; i++) {
    const ch = row[i];
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  // Drop trailing empty cell (from trailing |)
  if (cells.length > 0 && current.trim() === "") return cells;
  if (current) cells.push(current);
  return cells;
}

function isEmptyRow(line: string): boolean {
  return /^\|(\s*\|)+\s*$/.test(line);
}

function isSeparatorRow(line: string): boolean {
  return /^\|\s*[-:]+[-|\s:]*$/.test(line);
}

/**
 * Strip angle-bracket autolinks (<https://…>) back to bare URLs.
 * GFM auto-links bare URLs identically, and users expect round-trip
 * to preserve the bare form they wrote.
 */
function stripAutolinks(md: string): string {
  return eachLineOutsideFences(md, (line) =>
    outsideInlineCode(line, (seg) =>
      seg.replace(/<(https?:\/\/[^\s>]+)>/g, "$1")
    )
  );
}

/**
 * Remove remark-stringify's "safety" backslash escapes on bare URLs
 * (e.g. `https\://www\.example\.com`). We WANT these URLs to be parsed as
 * GFM autolinks on re-load — that's how YouTube / GitHub embed detection
 * recognizes them.
 */
function unescapeBareUrls(md: string): string {
  const URL_RE = /\bhttps?\\:\/\/(?:[^\s\\]|\\[^\s])+/g;
  const unescape = (m: string) => m.replace(/\\([^\s])/g, "$1");
  return eachLineOutsideFences(md, (line) =>
    outsideInlineCode(line, (seg) => seg.replace(URL_RE, unescape))
  );
}

/**
 * Swap remark-stringify "safety" numeric character entities for the literal
 * char + an empty HTML comment separator.
 *
 * When emphasis / strong / code-span markers abut a word character that the
 * markers _wouldn't_ reach under CommonMark flanking rules (`_x_after`,
 * `**``x``**Apples`), remark-stringify encodes the adjacent letter as a
 * numeric character reference (`&#x41;`, `&#x78;`, …) so the output re-parses
 * as the same tree. The reference is correct but ugly in the source.
 *
 * Replacement form: marker + `<!---->` + decoded char (or the inverse for
 * an opening-side entity). The empty HTML comment is a CommonMark inline-HTML
 * node — it breaks the flanking run the same way the entity does, but the
 * source reads cleanly. The transform is idempotent: a re-emitted tree drops
 * the comment, the entity comes back, and this step rewrites it again.
 */
function replaceSafetyEntities(md: string): string {
  return eachLineOutsideFences(md, (line) =>
    outsideInlineCode(line, swapSafetyEntities)
  );
}

function swapSafetyEntities(text: string): string {
  const decode = (cp: number, raw: string) =>
    cp >= 0x20 && cp <= 0x7e ? String.fromCharCode(cp) : raw;
  // marker (close) + entity → marker + <!----> + char
  text = text.replace(
    /(\*{1,2}|_{1,2})&#x([0-9a-fA-F]+);/g,
    (m, marker, hex) => `${marker}<!---->${decode(parseInt(hex, 16), m)}`
  );
  text = text.replace(
    /(\*{1,2}|_{1,2})&#(\d+);/g,
    (m, marker, dec) => `${marker}<!---->${decode(parseInt(dec, 10), m)}`
  );
  // entity + marker (open) → char + <!----> + marker
  text = text.replace(
    /&#x([0-9a-fA-F]+);(\*{1,2}|_{1,2})/g,
    (m, hex, marker) => `${decode(parseInt(hex, 16), m)}<!---->${marker}`
  );
  text = text.replace(
    /&#(\d+);(\*{1,2}|_{1,2})/g,
    (m, dec, marker) => `${decode(parseInt(dec, 10), m)}<!---->${marker}`
  );
  return text;
}

