/**
 * Extensive conversion tests: markdown ↔ HTML round-trips + unit tests.
 *
 * Test categories:
 *   A. Headings (h1-h6)
 *   B. Inline formatting (bold, italic, code, strike)
 *   C. Lists (unordered, ordered, nested, mixed)
 *   D. Task lists (GFM ↔ Tiptap conversion)
 *   E. Tables (incl. `|` in code spans, `\|` escape protection)
 *   F. Code blocks (language labels, shellscript → bash)
 *   G. Images (alt text, separation)
 *   H. Blockquotes
 *   I. Horizontal rules
 *   J. Special characters / escaping
 *   K. (removed — metadata no longer needed)
 *   L. normalizeMarkdown unit tests
 *   L2. Frontmatter preservation
 *   M. Known-failing cases (documented, expected to fail)
 *   O. Math (inline and block)
 *   P. Embeds (YouTube, GitHub)
 *   Q. Mermaid diagrams
 *   N. Settings-driven behavior
 *
 * Usage: npx tsx test/test-conversions.ts
 */

import { roundTrip, mdToHtml, htmlToMd } from "./pipeline";
import { normalizeMarkdown, buildMarkdownConfig, buildMdPipeline } from "../webview/markdown.config";
import { DEFAULT_SETTINGS, mergeSettings } from "../webview/settings";
import { extractFrontmatter, prependFrontmatter } from "../webview/frontmatter";
import { surgicalMerge, parseTopLevelBlocks } from "../webview/surgical-save";
import {
  isYouTubeUrl,
  getYouTubeVideoId,
} from "../webview/extensions/YouTubeEmbed";
import {
  isGitHubUrl,
  parseGitHubUrl,
} from "../webview/extensions/GitHubEmbed";

// ============================================================================
// Mini test harness
// ============================================================================

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  known?: boolean;
}

const results: TestResult[] = [];
let currentCategory = "";

function category(name: string) {
  currentCategory = name;
}

function normalize(s: string): string {
  // Trim trailing newlines so "foo" and "foo\n" compare equal.
  // remark-stringify always appends a newline; test inputs usually don't.
  return s.replace(/\n+$/, "");
}

async function roundtripCase(
  name: string,
  input: string,
  expected?: string,
  opts: { known?: boolean } = {}
) {
  const actual = await roundTrip(input);
  const exp = expected ?? input;
  // Idempotence: a second pass over the output must not change it further.
  // Catches "opening + saving twice mutates content" bugs the single pass
  // misses (#70; e.g. #54's >9-digit overflow was a 2nd-pass failure).
  const secondPass = await roundTrip(actual);
  const idempotent = normalize(secondPass) === normalize(actual);
  const passed = normalize(actual) === normalize(exp) && idempotent;
  results.push({
    name,
    category: currentCategory,
    passed,
    expected: exp,
    actual: idempotent
      ? actual
      : `${actual}\n  [NON-IDEMPOTENT — 2nd pass →]\n${secondPass}`,
    known: opts.known,
  });
}

function eq(name: string, actual: string, expected: string, opts: { known?: boolean } = {}) {
  const passed = normalize(actual) === normalize(expected);
  results.push({
    name,
    category: currentCategory,
    passed,
    expected,
    actual,
    known: opts.known,
  });
}

function assert(name: string, condition: boolean, detail?: string, opts: { known?: boolean } = {}) {
  results.push({
    name,
    category: currentCategory,
    passed: condition,
    actual: condition ? "OK" : detail ?? "(no detail)",
    expected: "OK",
    known: opts.known,
  });
}

/**
 * Fenced-code info-string normalization (shellscript→bash, defaultCodeBlockLang)
 * moved out of `normalizeMarkdown` into a `code`-node transform inside
 * `buildMdPipeline` (slice 1 of #78). Exercise it through the real pipeline from
 * an HTML code-block fixture, the same way rehype-remark feeds the save path.
 */
function codeFencePipeline(
  lang: string,
  body: string,
  settings = DEFAULT_SETTINGS
): string {
  const cls = lang ? ` class="language-${lang}"` : "";
  return String(buildMdPipeline(settings).processSync(`<pre><code${cls}>${body}</code></pre>`));
}

/**
 * Ordered/unordered-list numbering and bullet markers moved out of
 * `normalizeMarkdown` into remark-stringify options + `orderedListGuard` inside
 * `buildMdPipeline` (slice 2 of #78). Exercise them through the real html→md
 * path from a list HTML fixture (as rehype-remark feeds the save path).
 */
function olThroughPipeline(items: string[], settings = DEFAULT_SETTINGS, start?: number): string {
  const s = start != null ? ` start="${start}"` : "";
  const html = `<ol${s}>` + items.map((t) => `<li>${t}</li>`).join("") + `</ol>`;
  return String(buildMdPipeline(settings).processSync(html));
}
function ulThroughPipeline(items: string[], settings = DEFAULT_SETTINGS): string {
  const html = `<ul>` + items.map((t) => `<li>${t}</li>`).join("") + `</ul>`;
  return String(buildMdPipeline(settings).processSync(html));
}
/**
 * Run markdown through the full round-trip pipeline (md → html → md via
 * buildMdPipeline). Used to test list tightness (slice 3 of #78), which now lives
 * in a tree transform, so tests exercise observable output — not the old text
 * helper — and honour the settings.
 */
async function listMd(md: string, settings = DEFAULT_SETTINGS): Promise<string> {
  return String(await buildMdPipeline(settings).process(await mdToHtml(md)));
}
/** Run an HTML fixture through the html→md pipeline (as rehype-remark feeds the
 * save path). Used to test transforms whose input is editor HTML. */
function htmlMd(html: string, settings = DEFAULT_SETTINGS): string {
  return String(buildMdPipeline(settings).processSync(html));
}

// ============================================================================
// Tests
// ============================================================================

async function run() {
  // --------------------------------------------------------------------------
  category("A. Headings");
  // --------------------------------------------------------------------------

  await roundtripCase("h1 round-trip", "# Hello");
  await roundtripCase("h2 round-trip", "## Hello");
  await roundtripCase("h3 round-trip", "### Hello");

  // h4-h6 round-trip natively (Tiptap supports all 6 levels)
  await roundtripCase("h4 round-trip", "#### Heading 4");
  await roundtripCase("h5 round-trip", "##### Heading 5");
  await roundtripCase("h6 round-trip", "###### Heading 6");
  await roundtripCase(
    "mixed h1-h6 preserved",
    "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6"
  );

  // --------------------------------------------------------------------------
  category("B. Inline formatting");
  // --------------------------------------------------------------------------

  await roundtripCase("bold", "This has **bold text** in it.");
  await roundtripCase("italic", "This has _italic text_ in it.");
  await roundtripCase("inline code", "This has `code` in it.");
  await roundtripCase("strikethrough", "This has ~~strike~~ text.");
  await roundtripCase(
    "bold italic code strike together",
    "This has **bold text** and _italic text_ and `inline code` and ~~strikethrough~~."
  );
  await roundtripCase(
    "nested bold+italic",
    "Mixed: **bold and _italic_ together** and more text."
  );
  await roundtripCase(
    "bold mid-sentence",
    "A sentence with **bold** in the middle and _emphasis_ too."
  );
  // Regression: `**`bold code`**` lost its bold wrapper because Tiptap's
  // default Code mark has `excludes: '_'` (drops all other marks). Issue #3.
  await roundtripCase("bold around inline code", "**`bold code`**");
  eq(
    "html→md: <strong><code>x</code></strong> keeps bold",
    (await htmlToMd("<p><strong><code>bold code</code></strong></p>")).trim(),
    "**`bold code`**"
  );
  // Regression: when bold-around-code abuts a word with no space between,
  // remark-stringify emits `&#x41;` to disambiguate. We post-process that
  // into `<!---->` + literal char, which is valid CommonMark and re-parses
  // identically. Issue #3 follow-up.
  eq(
    "html→md: <strong><code>x</code></strong>Apples uses HTML-comment separator",
    (await htmlToMd("<p><strong><code>bold code</code></strong>Apples</p>")).trim(),
    "**`bold code`**<!---->Apples"
  );
  eq(
    "html→md: <em>x</em>after uses HTML-comment separator",
    (await htmlToMd("<p><em>x</em>after</p>")).trim(),
    "_<!---->x_<!---->after"
  );
  await roundtripCase(
    "bold-code adjacent to word round-trips with comment separator",
    "**`bold code`**<!---->Apples"
  );

  // --------------------------------------------------------------------------
  category("C. Lists");
  // --------------------------------------------------------------------------

  await roundtripCase(
    "unordered simple",
    "- Item one\n- Item two\n- Item three"
  );
  await roundtripCase(
    "unordered with bold",
    "- Item one\n- Item two\n- Item three with **bold**\n- Item with `code`"
  );
  await roundtripCase(
    "unordered nested 2 levels",
    "- Parent item\n  - Child item\n  - Another child\n- Back to parent"
  );
  await roundtripCase(
    "unordered nested 3 levels",
    "- Parent item\n  - Child item\n  - Another child\n    - Grandchild\n- Back to parent"
  );
  await roundtripCase("ordered simple", "1. First\n2. Second\n3. Third");
  await roundtripCase("ordered list starting at 5 (#54)", "5. First\n6. Second\n7. Third");
  // >9-digit start would emit an illegal 10-digit marker, so orderedListGuard
  // resets the list to start at 1; result stays a fixed point across saves
  // (#54/#70). (Was "999999999. a\n1. b\n" under the old text clamp.)
  await roundtripCase(
    "ordered list >9-digit start clamped, idempotent (#54/#70)",
    "999999999. a\n999999999. b\n",
    "1. a\n2. b\n"
  );
  // KNOWN BUG (filed): a loose nested ordered list with a non-1 start survives
  // one save, then collapses on the second — remark-stringify tightens the
  // list and a non-1 ordered list can't interrupt a paragraph (CommonMark
  // §5.3), so pass 2 re-reads it as text. This case exists to (a) document the
  // bug and (b) exercise roundtripCase's idempotence branch (it fails ONLY on
  // the 2nd pass, so it proves #70's check is live).
  await roundtripCase(
    "loose nested ol, non-1 start — 2nd-pass collapse (known bug)",
    "1. a\n\n   6. n1\n\n   6. n2\n\n2. b\n",
    "1. a\n   6. n1\n   7. n2\n2. b\n",
    { known: true }
  );
  await roundtripCase(
    "ordered nested",
    "1. First\n   1. Sub-first\n   2. Sub-second\n2. Second"
  );
  await roundtripCase(
    "mixed ul+ol",
    "- Unordered\n  1. Ordered child\n  2. Another ordered\n- Back to unordered"
  );
  // A list item with a paragraph AFTER its sublist must stay loose — tightening
  // it collapses the trailing blank and drifts on the next save. Regression for
  // the compactLists tree transform (#78 slice 3a).
  await roundtripCase(
    "list item with a paragraph after its sublist stays loose + idempotent",
    "- item text\n\n  - nested one\n  - nested two\n\n  trailing para\n"
  );
  await roundtripCase(
    "list with inline link",
    "- List with [link](https://example.com)\n  - Nested [link](https://example.com/nested)"
  );

  // --------------------------------------------------------------------------
  category("D. Task lists");
  // --------------------------------------------------------------------------

  await roundtripCase(
    "task list all states",
    "- [ ] Unchecked task\n- [x] Checked task\n- [ ] Another unchecked\n- [x] Another checked"
  );
  await roundtripCase(
    "task list with formatting",
    "- [ ] Task with **bold**\n- [x] Done with `code`"
  );

  // --------------------------------------------------------------------------
  category("E. Tables");
  // --------------------------------------------------------------------------

  await roundtripCase(
    "simple 3-col table",
    "| Header 1 | Header 2 | Header 3 |\n| -------- | -------- | -------- |\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |"
  );

  // `|` inside code span in table cell — the critical protectTableCodePipes test.
  // Output canonicalizes to GFM-escaped `\|` (which is the correct markdown).
  await roundtripCase(
    "table with | in code span → escapes to \\|",
    "| Syntax | Example |\n| ------ | ------- |\n| pipe   | `a|b`   |",
    "| Syntax | Example |\n| ------ | ------- |\n| pipe   | `a\\|b`  |\n"
  );

  // `\|` already escaped — must stay `\|`, NOT become `\\|`
  await roundtripCase(
    "table with escaped \\| in code span (no double-escape)",
    "| Syntax | Example |\n| ------ | ------- |\n| escape | `a\\|b`  |",
    "| Syntax | Example |\n| ------ | ------- |\n| escape | `a\\|b`  |\n"
  );

  // Multiple pipes in single code span
  await roundtripCase(
    "table cell with multiple | in code span",
    "| col     |\n| ------- |\n| `a|b|c` |",
    "| col       |\n| --------- |\n| `a\\|b\\|c` |\n"
  );

  // --------------------------------------------------------------------------
  category("F. Code blocks");
  // --------------------------------------------------------------------------

  await roundtripCase(
    "code block javascript",
    '```javascript\nfunction hello() {\n  console.log("world");\n}\n```'
  );
  await roundtripCase(
    "code block python",
    '```python\ndef hello():\n    print("world")\n```'
  );
  await roundtripCase(
    "code block bash",
    '```bash\necho "hello world"\n```'
  );
  await roundtripCase(
    "code block no language stays bare",
    "```\nplain code\nno language\n```"
  );

  // shellscript → bash normalization (code-node transform, slice 1 of #78)
  eq(
    "pipeline: shellscript → bash",
    codeFencePipeline("shellscript", "echo hi"),
    "```bash\necho hi\n```\n"
  );

  // --------------------------------------------------------------------------
  category("G. Images");
  // --------------------------------------------------------------------------

  await roundtripCase("image with alt", "![Alt text](image.png)");
  await roundtripCase("image without alt", "![](no-alt.png)");
  await roundtripCase(
    "two images separate blocks",
    "![First](one.png)\n\n![Second](two.png)"
  );

  // --------------------------------------------------------------------------
  category("H. Blockquotes");
  // --------------------------------------------------------------------------

  await roundtripCase("blockquote simple", "> This is a blockquote.");
  await roundtripCase(
    "blockquote multi-paragraph",
    "> This is a blockquote.\n>\n> With multiple paragraphs."
  );
  await roundtripCase(
    "blockquote nested",
    "> Nested:\n>\n> > Inner quote"
  );

  // --------------------------------------------------------------------------
  category("I. Horizontal rules");
  // --------------------------------------------------------------------------

  await roundtripCase(
    "horizontal rule between sections",
    "## Section 1\n\n---\n\n## Section 2"
  );

  // --------------------------------------------------------------------------
  category("J. Special characters / escaping");
  // --------------------------------------------------------------------------

  // Unescape \~ → ~
  await roundtripCase(
    "bare tilde preserved",
    "Tildes: ~ single tilde and ~~ double tildes ~~."
  );

  // Unescape standalone \*
  await roundtripCase(
    "bare asterisk preserved",
    "Asterisks in text: 2 * 3 = 6."
  );

  // Currency $ must not be paired as math by remarkMath
  await roundtripCase(
    "bold with currency $ preserved",
    "**$14B**, $1.4B raised"
  );
  await roundtripCase(
    "multiple currency amounts in paragraph",
    "costs $100 or $200"
  );
  await roundtripCase(
    "bold currency in table cell",
    "| Company | Valuation |\n| --- | --- |\n| **Skild AI** | **$14B**, $1.4B raised |",
    "| Company      | Valuation              |\n| ------------ | ---------------------- |\n| **Skild AI** | **$14B**, $1.4B raised |\n"
  );

  // Unescape escaped bold markers (\*\* → **) — safety-net normalizeMarkdown rule
  eq(
    "normalizeMarkdown: unescape \\*\\* bold opener before $",
    normalizeMarkdown("\\*\\*$14B**, $1.4B raised\n"),
    "**$14B**, $1.4B raised\n"
  );
  eq(
    "normalizeMarkdown: unescape \\*\\* bold with $ inside",
    normalizeMarkdown("\\*\\*LeCun's $1B bet.**\n"),
    "**LeCun's $1B bet.**\n"
  );

  // Unescape \_ in words (ASCII)
  eq(
    "normalizeMarkdown: unescape \\_ in words",
    normalizeMarkdown("future\\_relevance check\n"),
    "future_relevance check\n"
  );

  // Unescape \_ in words (Unicode — Greek, CJK)
  eq(
    "normalizeMarkdown: unescape \\_ around Unicode (β\\_kl)",
    normalizeMarkdown("β\\_kl\n"),
    "β_kl\n"
  );
  eq(
    "normalizeMarkdown: unescape \\_ around CJK (日\\_本)",
    normalizeMarkdown("日\\_本\n"),
    "日_本\n"
  );

  // Unescape \[ brackets
  eq(
    "normalizeMarkdown: unescape \\[",
    normalizeMarkdown("see \\[note] here\n"),
    "see [note] here\n"
  );

  // Unescape \~
  eq(
    "normalizeMarkdown: unescape \\~",
    normalizeMarkdown("use \\~ for home\n"),
    "use ~ for home\n"
  );

  // Unescape \= before non-= content (e.g. => arrows)
  eq(
    "normalizeMarkdown: unescape \\=> arrow",
    normalizeMarkdown("\\=> leads to something\n"),
    "=> leads to something\n"
  );

  // slice 4 of #78: the unescape passes are now fence-aware for ~~~ and indented
  // fences too (not just ```), so escaped example content shown inside them is
  // left verbatim (the old passes only tracked un-indented ``` and would have
  // unescaped these).
  eq(
    "unescape: escaped content inside a ~~~ fence is left alone",
    normalizeMarkdown("~~~\n2 \\* 3\n~~~\n"),
    "~~~\n2 \\* 3\n~~~\n"
  );
  eq(
    "unescape: escaped content inside an indented ``` fence is left alone",
    normalizeMarkdown("   ```\n2 \\* 3\n   ```\n"),
    "   ```\n2 \\* 3\n   ```\n"
  );
  eq(
    "unescape: an autolink inside a ~~~ fence is left alone",
    normalizeMarkdown("~~~\n<https://example.com>\n~~~\n"),
    "~~~\n<https://example.com>\n~~~\n"
  );

  // Strip <autolinks> back to bare URLs
  eq(
    "normalizeMarkdown: strip <https://...> autolink",
    normalizeMarkdown("see <https://arxiv.org/pdf/1602.04938>\n"),
    "see https://arxiv.org/pdf/1602.04938\n"
  );

  // Autolinks inside code spans must NOT be stripped
  eq(
    "normalizeMarkdown: keep <url> inside code span",
    normalizeMarkdown("use `<https://example.com>` in code\n"),
    "use `<https://example.com>` in code\n"
  );

  // --------------------------------------------------------------------------
  // K. (removed — metadata system no longer needed, Tiptap supports h4-h6)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  category("L. normalizeMarkdown unit tests");
  // --------------------------------------------------------------------------

  eq(
    "bullet * → - (serializer bullet option)",
    ulThroughPipeline(["one", "two", "three"]),
    "- one\n- two\n- three\n"
  );

  eq(
    "renumber ordered list (serializer incrementListMarker)",
    olThroughPipeline(["first", "second", "third"]),
    "1. first\n2. second\n3. third\n"
  );

  // The old fixOrphanedListMarkers pass (removed in slice 4 of #78 — dead + buggy)
  // merged a bare "- " marker into the following line. The pipeline now preserves
  // an empty list item as-is; the property that matters is that it stays a fixed
  // point across saves.
  await roundtripCase(
    "empty list marker input is stable (no merge, idempotent)",
    "- \n\n  text here\n",
    "-\n\ntext here\n"
  );

  // Task list checkbox fix patterns from BlockNote era
  eq(
    "task list: fix \\[ ] → [ ]",
    normalizeMarkdown("- \\[ ] todo item\n"),
    "- [ ] todo item\n"
  );

  eq(
    "task list: fix \\[x] → [x]",
    normalizeMarkdown("- \\[x] done item\n"),
    "- [x] done item\n"
  );

  // Image + duplicate alt caption removal — now a tree transform (slice 3b of
  // #78), tested through the real html→md path (image + a separate caption
  // paragraph, the shape the editor actually emits).
  eq(
    "image followed by a duplicate-alt paragraph is deduped",
    htmlMd('<p><img src="a.png" alt="pic"></p><p>pic</p>'),
    "![pic](a.png)\n"
  );
  // a real (non-duplicate) caption is kept
  eq(
    "image with a non-duplicate caption keeps the caption",
    htmlMd('<p><img src="a.png" alt="pic"></p><p>a real caption</p>'),
    "![pic](a.png)\n\na real caption\n"
  );
  // a run of duplicate captions collapses in ONE pass (stays a fixed point)
  eq(
    "image dedup collapses a run of duplicate captions in one pass",
    htmlMd('<p><img src="a.png" alt="a"></p><p>a</p><p>a</p>'),
    "![a](a.png)\n"
  );
  // fence-safety: a duplicate caption SHOWN inside a code fence is left untouched
  eq(
    "image dedup does NOT touch a duplicate shown inside a fence",
    codeFencePipeline("markdown", "![pic](a.png)\n\npic"),
    "```markdown\n![pic](a.png)\n\npic\n```\n"
  );

  // compactLists (now a tree transform, slice 3 of #78) — tested through the
  // real pipeline (observable output), not the removed text helper.
  eq(
    "compactLists: removes blank lines between items",
    await listMd("- one\n\n- two\n\n- three\n"),
    "- one\n- two\n- three\n"
  );
  // preserves the blank between two different list types at top level
  eq(
    "compactLists: keeps blank between ul and ol at top level",
    await listMd("- bullet\n\n1. number\n"),
    "- bullet\n\n1. number\n"
  );
  // an item's own blank before an indented paragraph is preserved (the item is
  // legitimately loose); only blanks *between items* are removed
  eq(
    "compactLists: preserves blank between list item and indented para (2sp)",
    await listMd("- item\n\n  indented para\n"),
    "- item\n\n  indented para\n"
  );
  eq(
    "compactLists: preserves blank before an item's indented child block",
    await listMd("- item\n\n    code-indented\n"),
    "- item\n\n  code-indented\n"
  );
  eq(
    "compactLists: preserves blank between list and following unindented para",
    await listMd("- one\n- two\n\nparagraph after\n"),
    "- one\n- two\n\nparagraph after\n"
  );
  // a parent item and its nested sublist stay tight (no blank inserted)
  eq(
    "compactLists: parent → nested sublist stays tight",
    await listMd("- Parent\n  - Child\n  - Another\n- Back\n"),
    "- Parent\n  - Child\n  - Another\n- Back\n"
  );
  // fence-safety: a loose list SHOWN inside a code fence is left untouched
  eq(
    "compactLists: loose list inside a fence is NOT tightened",
    codeFencePipeline("markdown", "- one\n\n- two"),
    "```markdown\n- one\n\n- two\n```\n"
  );

  // Table header reconstruction: empty header row + separator → first row becomes header
  const tableFixed = normalizeMarkdown(
    "|   |   |\n| - | - |\n| A | B |\n| C | D |\n"
  );
  assert(
    "fixTableHeaders: empty header row reconstructed from first data row",
    /\| A\s+\| B\s+\|/.test(tableFixed) &&
      !tableFixed.match(/^\|\s+\|\s+\|\s*$/m),
    tableFixed
  );

  // Table separator widths match unescaped content (not pre-unescape widths)
  eq(
    "fixTableHeaders: separator width matches after unescape",
    normalizeMarkdown(
      "|   |   |\n| - | - |\n| Company | \\*\\*$14B** |\n"
    ),
    "| Company | **$14B** |\n| ------- | -------- |\n"
  );

  // slice 4b of #78: the block-oriented passes (tables, task lists) are now
  // fence-aware — a table or task list SHOWN inside a fence is left verbatim,
  // while a real one outside is still formatted.
  eq(
    "table shown inside a fence is NOT reformatted",
    normalizeMarkdown("```\n| a | b |\n| - | - |\n| ccc | d |\n```\n"),
    "```\n| a | b |\n| - | - |\n| ccc | d |\n```\n"
  );
  eq(
    "escaped task shown inside a fence is NOT unescaped",
    normalizeMarkdown("```\n- \\[ \\] example task\n```\n"),
    "```\n- \\[ \\] example task\n```\n"
  );

  // HTML entity cleanup
  eq(
    "HTML entity cleanup: &#x20; → space",
    "foo&#x20;bar".replace(/&#x20;/g, " "),
    "foo bar"
  );
  eq(
    "HTML entity cleanup: &amp; → &",
    "a &amp; b".replace(/&amp;/g, "&"),
    "a & b"
  );

  // Bold in lists (regression test for list item serialization)
  await roundtripCase(
    "bold in lists",
    "- **Bold list item**\n- **Another bold** with trailing text\n- Normal then **bold part**\n- _Italic item_"
  );

  // Nested bold/italic preservation
  await roundtripCase(
    "bold containing italic",
    "**outer _inner_ text**"
  );

  // --------------------------------------------------------------------------
  category("L2. Frontmatter preservation");
  // --------------------------------------------------------------------------

  // extractFrontmatter unit tests
  {
    const { content, frontmatter } = extractFrontmatter(
      "---\nname: test\ndescription: hello\n---\n\n# Heading\n\nBody text.\n"
    );
    eq("extractFrontmatter: strips frontmatter", content, "\n# Heading\n\nBody text.\n");
    eq("extractFrontmatter: captures raw block", frontmatter, "---\nname: test\ndescription: hello\n---\n");
  }

  {
    const { content, frontmatter } = extractFrontmatter("# No frontmatter\n\nJust content.\n");
    eq("extractFrontmatter: no frontmatter returns content unchanged", content, "# No frontmatter\n\nJust content.\n");
    eq("extractFrontmatter: no frontmatter returns empty string", frontmatter, "");
  }

  eq(
    "prependFrontmatter: restores block with blank line",
    prependFrontmatter("# Heading\n", "---\nfoo: bar\n---\n"),
    "---\nfoo: bar\n---\n\n# Heading\n"
  );

  eq(
    "prependFrontmatter: noop when empty",
    prependFrontmatter("# Heading\n", ""),
    "# Heading\n"
  );

  // Full round-trip with frontmatter
  await roundtripCase(
    "YAML frontmatter preserved through round-trip",
    "---\nname: games-vm\ndescription: SSH into the games VM\nallowed-tools: Bash\n---\n\n## Games VM\n\nSome content here.\n"
  );

  await roundtripCase(
    "frontmatter with special chars preserved",
    "---\ntitle: My <Project>\ntags: [a, b, c]\n---\n\n# Title\n\nParagraph.\n"
  );

  // Exact reproduction of the reported bug: angle-bracket value + multi-line YAML
  await roundtripCase(
    "frontmatter with angle-bracket value (reported issue)",
    "---\nname: games-vm\ndescription: SSH into the games VM (A100 GPU) on GCP to run commands, check training runs, or manage experiments\nargument-hint: <command-to-run>\nallowed-tools: Bash\n---\n\n## Games VM\n\nSome content here.\n"
  );

  // --------------------------------------------------------------------------
  category("M. Known failing / limitations (documented)");
  // --------------------------------------------------------------------------

  // Escaped markdown characters in plain text lose backslash on round-trip
  // because Tiptap stores the rendered text, not the source.
  // The remark/rehype pipeline alone ALSO loses them.
  await roundtripCase(
    "\\* literal asterisk in text (LOSSY)",
    "Escape: \\* should stay",
    "Escape: * should stay",
    { known: true }
  );

  // (was: "β\\_kl not unescaped (Unicode)" — now fixed, see category J below)
  // (was: "compactLists: indented para after list loses blank" — now fixed,
  //  see L.compactLists positive assertions below)

  // Empty fenced code block round-trips to itself (no language label
  // added or removed — we only touch labels when the user opts in via
  // defaultCodeBlockLang).
  await roundtripCase("empty fenced code block stays bare", "```\n```");

  // --------------------------------------------------------------------------
  category("O. Math (inline and block)");
  // --------------------------------------------------------------------------

  await roundtripCase("inline math simple", "Einstein wrote $E=mc^2$ in 1905.");
  await roundtripCase("inline math with subscript", "The variable $x_1$ is defined.");
  await roundtripCase("inline math with braces", "We have $\\frac{a}{b}$ here.");
  await roundtripCase("block math simple", "$$\na^2 + b^2 = c^2\n$$");
  await roundtripCase(
    "block math multiline",
    "$$\n\\sum_{i=1}^{n} x_i = x_1 + x_2 + \\cdots + x_n\n$$"
  );
  await roundtripCase(
    "inline math in paragraph",
    "The formula $a + b = c$ is basic arithmetic."
  );
  await roundtripCase(
    "multiple inline math in one line",
    "Both $\\alpha$ and $\\beta$ are Greek."
  );
  await roundtripCase(
    "block math surrounded by text",
    "Before math:\n\n$$\nf(x) = x^2\n$$\n\nAfter math."
  );

  // Inline math whose content starts AND ends with a digit must not be
  // mis-protected by protectCurrencyDollars (regression: the leading `$`
  // matched the `$<digit>` currency pattern, breaking the math pair).
  await roundtripCase(
    "inline math digit boundaries with LaTeX command",
    "So 5 cats would have $24 \\times 5 = 120$ whiskers between them."
  );
  await roundtripCase(
    "inline math digit boundaries with operator",
    "Result: $2x + 3 = 5$ is the answer."
  );

  // Currency must still be protected even when math also appears nearby
  await roundtripCase(
    "currency and inline math on same line",
    "It costs $100 but $E=mc^2$ stays."
  );

  // Verify md→html produces correct data attributes
  {
    const html = await mdToHtml("$E=mc^2$");
    assert(
      "md→html: inline math produces data-type='mathInline'",
      html.includes('data-type="mathInline"') && html.includes('data-latex="E=mc^2"'),
      html
    );
  }
  {
    const html = await mdToHtml("$$\na^2 + b^2 = c^2\n$$");
    assert(
      "md→html: block math produces data-type='mathBlock'",
      html.includes('data-type="mathBlock"'),
      html
    );
  }

  // --------------------------------------------------------------------------
  category("P. Embeds (YouTube, GitHub)");
  // --------------------------------------------------------------------------

  // URL detection
  assert("isYouTubeUrl: watch URL", isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  assert("isYouTubeUrl: short URL", isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"));
  assert("isYouTubeUrl: shorts URL", isYouTubeUrl("https://www.youtube.com/shorts/abcdef"));
  assert("isYouTubeUrl: plain youtube.com rejected", !isYouTubeUrl("https://www.youtube.com/"));
  assert("isYouTubeUrl: non-YT rejected", !isYouTubeUrl("https://example.com/watch?v=xyz"));

  assert("isGitHubUrl: repo", isGitHubUrl("https://github.com/foo/bar"));
  assert("isGitHubUrl: PR", isGitHubUrl("https://github.com/foo/bar/pull/42"));
  assert("isGitHubUrl: issue", isGitHubUrl("https://github.com/foo/bar/issues/7"));
  assert("isGitHubUrl: file blob", isGitHubUrl("https://github.com/foo/bar/blob/main/src/a.ts"));
  assert("isGitHubUrl: user profile rejected", !isGitHubUrl("https://github.com/foo"));
  assert("isGitHubUrl: non-GH rejected", !isGitHubUrl("https://gitlab.com/foo/bar"));

  // Video ID extraction
  eq(
    "getYouTubeVideoId: watch?v=",
    getYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ") || "",
    "dQw4w9WgXcQ"
  );
  eq(
    "getYouTubeVideoId: youtu.be short",
    getYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ") || "",
    "dQw4w9WgXcQ"
  );

  // GitHub URL parsing — kind classification
  const prInfo = parseGitHubUrl("https://github.com/foo/bar/pull/42");
  assert(
    "parseGitHubUrl: PR → kind='pr', owner, repo, number",
    prInfo?.kind === "pr" &&
      (prInfo as any).owner === "foo" &&
      (prInfo as any).repo === "bar" &&
      (prInfo as any).number === "42",
    JSON.stringify(prInfo)
  );
  const fileInfo = parseGitHubUrl("https://github.com/foo/bar/blob/main/src/a.ts");
  assert(
    "parseGitHubUrl: file → kind='file' with path",
    fileInfo?.kind === "file" && (fileInfo as any).path === "src/a.ts",
    JSON.stringify(fileInfo)
  );

  // md→html: standalone autolink becomes embed paragraph
  {
    const html = await mdToHtml("https://www.youtube.com/watch?v=dQw4w9WgXcQ\n");
    assert(
      "md→html: YouTube URL becomes data-type='youtubeEmbed' paragraph",
      html.includes('data-type="youtubeEmbed"') &&
        html.includes('data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'),
      html
    );
  }
  {
    const html = await mdToHtml("https://github.com/foo/bar/pull/42\n");
    assert(
      "md→html: GitHub URL becomes data-type='githubEmbed' paragraph",
      html.includes('data-type="githubEmbed"') &&
        html.includes('data-url="https://github.com/foo/bar/pull/42"'),
      html
    );
  }
  {
    // URL inside sentence should NOT be rewritten as an embed
    const html = await mdToHtml("Check https://www.youtube.com/watch?v=abc here.\n");
    assert(
      "md→html: URL inside sentence is NOT embedded",
      !html.includes('data-type="youtubeEmbed"'),
      html
    );
  }

  // Round-trip: bare URL survives as bare URL
  await roundtripCase(
    "YouTube URL on its own line round-trips",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  );
  await roundtripCase(
    "GitHub PR URL on its own line round-trips",
    "https://github.com/foo/bar/pull/42"
  );
  await roundtripCase(
    "GitHub file URL on its own line round-trips",
    "https://github.com/foo/bar/blob/main/src/a.ts"
  );

  // --------------------------------------------------------------------------
  category("Q. Mermaid diagrams");
  // --------------------------------------------------------------------------

  // Mermaid blocks are plain fenced code blocks on disk — the rich editor
  // renders them via a dedicated Tiptap node, but round-trip goes through
  // the standard code-block path (no placeholder machinery).
  await roundtripCase(
    "mermaid simple graph",
    "```mermaid\ngraph TD\nA-->B\n```"
  );
  await roundtripCase(
    "mermaid sequence diagram",
    "```mermaid\nsequenceDiagram\nAlice->>Bob: Hi\n```"
  );
  await roundtripCase(
    "mermaid block surrounded by text",
    "Before:\n\n```mermaid\ngraph LR\nA-->B\n```\n\nAfter."
  );
  await roundtripCase(
    "mermaid alongside a regular code block",
    "```mermaid\ngraph TD\nA-->B\n```\n\n```javascript\nconsole.log(1);\n```"
  );

  // md→html: mermaid fence produces a standard <pre><code class="language-mermaid">
  // (the custom Tiptap parseHTML hook picks this up client-side).
  {
    const html = await mdToHtml("```mermaid\ngraph TD\nA-->B\n```");
    assert(
      "md→html: mermaid fence produces <pre><code class='language-mermaid'>",
      html.includes('<code class="language-mermaid">') &&
        html.includes("graph TD"),
      html
    );
  }

  // --------------------------------------------------------------------------
  category("N. Settings-driven behavior");
  // --------------------------------------------------------------------------

  // mergeSettings with nothing returns defaults
  eq(
    "mergeSettings: null/undefined → defaults",
    JSON.stringify(mergeSettings(null)),
    JSON.stringify(DEFAULT_SETTINGS)
  );

  // Partial settings merge onto defaults
  const partial = mergeSettings({ bullet: "*" });
  assert(
    "mergeSettings: partial settings keep defaults for missing keys",
    partial.bullet === "*" && partial.emphasis === "_" && partial.compactLists === true,
    JSON.stringify(partial)
  );

  // buildMarkdownConfig maps user-friendly "**"/"__" down to remark's single char
  const cfgStarStar = buildMarkdownConfig(mergeSettings({ strong: "**" }));
  const cfgUnderUnder = buildMarkdownConfig(mergeSettings({ strong: "__" }));
  assert(
    "buildMarkdownConfig: strong ** → remark strong='*'",
    cfgStarStar.strong === "*",
    `got '${cfgStarStar.strong}'`
  );
  assert(
    "buildMarkdownConfig: strong __ → remark strong='_'",
    cfgUnderUnder.strong === "_",
    `got '${cfgUnderUnder.strong}'`
  );

  // bulletOther is the complement of bullet
  assert(
    "buildMarkdownConfig: bullet='-' → bulletOther='*'",
    buildMarkdownConfig(mergeSettings({ bullet: "-" })).bulletOther === "*"
  );
  assert(
    "buildMarkdownConfig: bullet='*' → bulletOther='-'",
    buildMarkdownConfig(mergeSettings({ bullet: "*" })).bulletOther === "-"
  );

  // compactLists toggle: when disabled, blank lines between list items remain
  eq(
    "settings: compactLists=false preserves blanks between items",
    await listMd("- a\n\n- b\n\n- c\n", mergeSettings({ compactLists: false })),
    "- a\n\n- b\n\n- c\n"
  );
  eq(
    "settings: compactLists=true compacts blanks between items (default)",
    await listMd("- a\n\n- b\n\n- c\n", DEFAULT_SETTINGS),
    "- a\n- b\n- c\n"
  );

  // unescapeSpecialChars toggle
  eq(
    "settings: unescapeSpecialChars=false keeps \\_ in words",
    normalizeMarkdown("foo\\_bar\n", mergeSettings({ unescapeSpecialChars: false })),
    "foo\\_bar\n"
  );
  eq(
    "settings: unescapeSpecialChars=true unescapes \\_ in words (default)",
    normalizeMarkdown("foo\\_bar\n", DEFAULT_SETTINGS),
    "foo_bar\n"
  );

  // shellscriptToBash toggle
  eq(
    "settings: shellscriptToBash=true rewrites label (default)",
    codeFencePipeline("shellscript", "echo hi", DEFAULT_SETTINGS),
    "```bash\necho hi\n```\n"
  );
  eq(
    "settings: shellscriptToBash=false keeps shellscript",
    codeFencePipeline("shellscript", "echo hi", mergeSettings({ shellscriptToBash: false })),
    "```shellscript\necho hi\n```\n"
  );

  // renumberOrderedLists toggle → the serializer's incrementListMarker option
  eq(
    "settings: renumberOrderedLists=true renumbers (default)",
    olThroughPipeline(["a", "b", "c"], DEFAULT_SETTINGS),
    "1. a\n2. b\n3. c\n"
  );
  eq(
    "settings: renumberOrderedLists=false keeps original numbers",
    olThroughPipeline(["a", "b", "c"], mergeSettings({ renumberOrderedLists: false })),
    "1. a\n1. b\n1. c\n"
  );
  eq(
    "settings: renumberOrderedLists keeps a non-1 start (#54)",
    olThroughPipeline(["a", "b", "c"], DEFAULT_SETTINGS, 6),
    "6. a\n7. b\n8. c\n"
  );
  eq(
    "settings: renumberOrderedLists leaves a correct non-1 sequence (#54)",
    olThroughPipeline(["a", "b", "c"], DEFAULT_SETTINGS, 5),
    "5. a\n6. b\n7. c\n"
  );
  eq(
    "settings: orderedListGuard clamps a >9-digit overflow to a legal marker (#54)",
    olThroughPipeline(["a", "b"], DEFAULT_SETTINGS, 999999999),
    "1. a\n2. b\n"
  );

  // bullet setting → the serializer's `bullet` option
  eq(
    "settings: bullet='*' converts - to *",
    ulThroughPipeline(["one", "two"], mergeSettings({ bullet: "*" })),
    "* one\n* two\n"
  );
  eq(
    "settings: bullet='+' converts - to +",
    ulThroughPipeline(["one", "two"], mergeSettings({ bullet: "+" })),
    "+ one\n+ two\n"
  );
  // slice 2 of #78: a numbered list shown INSIDE a fence is opaque content and
  // is never renumbered (the old text pass corrupted it — this is issue #68).
  eq(
    "pipeline: numbered list inside a markdown fence is NOT renumbered (#68)",
    codeFencePipeline("markdown", "6. a\n6. b"),
    "```markdown\n6. a\n6. b\n```\n"
  );

  // defaultCodeBlockLang
  eq(
    "settings: defaultCodeBlockLang='' leaves bare fences alone (default)",
    codeFencePipeline("", "hello", DEFAULT_SETTINGS),
    "```\nhello\n```\n"
  );
  eq(
    "settings: defaultCodeBlockLang='text' labels bare fences when user opts in",
    codeFencePipeline("", "hello", mergeSettings({ defaultCodeBlockLang: "text" })),
    "```text\nhello\n```\n"
  );
  eq(
    "settings: defaultCodeBlockLang='' strips text label",
    codeFencePipeline("text", "hello", mergeSettings({ defaultCodeBlockLang: "" })),
    "```\nhello\n```\n"
  );
  eq(
    "settings: defaultCodeBlockLang leaves real languages alone",
    codeFencePipeline("python", "print('x')", mergeSettings({ defaultCodeBlockLang: "" })),
    "```python\nprint('x')\n```\n"
  );

  // slice 1 of #78: the code-node transform is fence-aware — a fence shown
  // INSIDE another fence is opaque content, never rewritten. The old text
  // passes were fence-blind here and would have corrupted these.
  eq(
    "pipeline: shellscript shown inside a markdown fence is NOT rewritten",
    codeFencePipeline("markdown", "```shellscript\necho hi\n```"),
    "````markdown\n```shellscript\necho hi\n```\n````\n"
  );
  eq(
    "pipeline: bare fence inside a fence keeps no default lang label",
    codeFencePipeline("markdown", "```\nplain\n```", mergeSettings({ defaultCodeBlockLang: "text" })),
    "````markdown\n```\nplain\n```\n````\n"
  );

  // --------------------------------------------------------------------------
  category("R. Surgical save");
  // --------------------------------------------------------------------------

  const messy = [
    "Title",
    "=====",
    "",
    "A paragraph with *star emphasis* and __underscore bold__.",
    "",
    "- loose",
    "",
    "- list",
    "",
    "Middle paragraph to edit.",
    "",
    "```shellscript",
    "echo hi",
    "```",
    "",
    "Trailing *stars* stay.",
    "",
  ].join("\n");

  const messyCanon = await roundTrip(messy);
  const noEdit = surgicalMerge(messy, messyCanon, messyCanon);
  assert(
    "open/roundtrip without user edits leaves messy markdown byte-identical",
    noEdit === messy,
    noEdit === messy ? undefined : `diffed:\n${noEdit}`,
  );

  const origBlocks = parseTopLevelBlocks(messy);
  const canonBlocks = parseTopLevelBlocks(messyCanon);
  assert(
    "messy fixture has several top-level blocks",
    origBlocks.length >= 5,
    `only ${origBlocks.length} blocks`,
  );

  const middleIdx = canonBlocks.findIndex((b) =>
    b.text.includes("Middle paragraph to edit."),
  );
  assert(
    "canonical dump still contains the middle paragraph",
    middleIdx >= 0,
    "middle paragraph missing from canonical serialize",
  );

  let editedCanon = messyCanon;
  if (middleIdx >= 0) {
    const b = canonBlocks[middleIdx];
    editedCanon =
      messyCanon.slice(0, b.start) +
      "Edited middle paragraph." +
      messyCanon.slice(b.end);
  }
  const oneBlock = surgicalMerge(messy, editedCanon, messyCanon);

  assert(
    "editing one block leaves setext heading byte-identical",
    oneBlock.includes("Title\n====="),
    "setext heading was rewritten",
  );
  assert(
    "editing one block leaves *emphasis* / __bold__ byte-identical",
    oneBlock.includes("*star emphasis*") && oneBlock.includes("__underscore bold__"),
    "inline markers were normalized",
  );
  assert(
    "editing one block leaves loose-list blank line byte-identical",
    oneBlock.includes("- loose\n\n- list"),
    "list tightness was normalized",
  );
  assert(
    "editing one block leaves ```shellscript fence byte-identical",
    oneBlock.includes("```shellscript"),
    "fence label was rewritten",
  );
  assert(
    "editing one block leaves the trailing paragraph byte-identical",
    oneBlock.includes("Trailing *stars* stay."),
    "trailing paragraph was rewritten",
  );
  assert(
    "edited block is present in the output",
    oneBlock.includes("Edited middle paragraph."),
    "new text missing",
  );
  assert(
    "unedited regions are exact slices of the original file",
    oneBlock.includes(messy.slice(0, messy.indexOf("Middle paragraph to edit."))),
    "prefix of file was not a byte-identical slice",
  );

  // Insert a block between two kept originals
  const insertedCanon =
    messyCanon.replace(
      "Middle paragraph to edit.",
      "Middle paragraph to edit.\n\nBrand new paragraph.",
    );
  const inserted = surgicalMerge(messy, insertedCanon, messyCanon);
  assert(
    "inserting a block keeps surrounding original bytes",
    inserted.includes("*star emphasis*") &&
      inserted.includes("```shellscript") &&
      inserted.includes("Brand new paragraph."),
    "insert lost original bytes or new text",
  );

  // --------------------------------------------------------------------------
  // Print report
  // --------------------------------------------------------------------------

  const groups = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category)!.push(r);
  }

  let passed = 0;
  let failed = 0;
  let knownFailed = 0;
  let unexpectedFailed = 0;

  for (const [cat, items] of groups) {
    console.log(`\n\x1b[1m${cat}\x1b[0m`);
    for (const r of items) {
      if (r.passed) {
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${r.name}`);
      } else {
        failed++;
        if (r.known) {
          knownFailed++;
          console.log(`  \x1b[33m○\x1b[0m ${r.name} \x1b[90m(known)\x1b[0m`);
        } else {
          unexpectedFailed++;
          console.log(`  \x1b[31m✗\x1b[0m ${r.name}`);
          console.log(`    \x1b[90mexpected:\x1b[0m ${JSON.stringify(r.expected)}`);
          console.log(`    \x1b[90m  actual:\x1b[0m ${JSON.stringify(r.actual)}`);
        }
      }
    }
  }

  console.log(
    `\n\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ` +
      (unexpectedFailed
        ? `\x1b[31m${unexpectedFailed} failed\x1b[0m, `
        : "") +
      `\x1b[33m${knownFailed} known-failing\x1b[0m`
  );

  if (unexpectedFailed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
