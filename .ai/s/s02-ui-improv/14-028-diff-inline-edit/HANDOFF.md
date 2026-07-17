# HANDOFF — #28 inline-editable diff (branch-only)

> This file lives **only on branch `fix/028-diff-inline-edit`**. It is the
> resume guide for the next person (likely future-me). The branch was force-
> committed because `.ai/` is gitignored on `master` — this branch is the
> durable git home of the design work. No production code exists yet.

## High-level analysis

The diff panel today renders a **computed, read-only** view (htmldiff-merged
HTML for "rendered", diff2html for "source"). Neither is an editable
document. The goal (#28) is to edit the "new" side without leaving the diff.

Agreed product direction (`03-analysis-result.md`): edit **inside the colored
WYSIWYG diff** (track-changes feel — green additions, red deletions,
typeable), rather than a separate plain editor beside it.

Two contexts, handled differently:

- **AI suggestion** (scheme `_claude_vscode_fs_right`, virtual): keep three
  versions — **base**, **suggested**, **working** — in memory; nothing hits
  disk until accept.
- **Plain Git change** (right side is a `file:`): the "working" version *is*
  the file; edits write straight back.

Scope boundary: **source-level** (raw markdown) diff editing is delegated to
**VS Code's built-in diff tools** — not ours to build.

## What was done

- Design only. No code.
- `00-context.md`, `01-analysis.md` (deep, split-pane framing),
  `02-proposed-impl.md` (4-phase plan for the split-pane version),
  `03-analysis-result.md` (agreed direction — inline colored),
  `04-simplified-analysis-result.md` (plain-language).
- Issue #28 has a summary comment.

## What's to do

Decide the **v1 shape first** — this gates everything:

- **Option V1a (cheaper, already specced):** split-pane edit mode from
  `02-proposed-impl.md` — real editor on the right, live re-diff on the left.
  Ships the capability; not the in-place colored UX.
- **Option V1b (the vision):** in-place colored/track-changes editor — needs
  a document model holding base + working and rendering inline green/red
  while remaining typeable. Bigger; this is the real design problem.

Then, regardless of choice, the phased work from `02-proposed-impl.md`:

1. **Shared extension factory** (`webview/editorExtensions.ts`) — extract the
   ~25-line extension array from `App.tsx` so any edit surface shares the
   main editor's full config. **Zero-risk; do this first, could even ship
   alone.** Prevents silent loss of math/mermaid/tables/embeds/tasks.
2. Edit surface + local live re-diff (webview only; reuse `oldContent` +
   existing rendered-diff pipeline; debounce ~400 ms).
3. Host write-back in `src/diffPanel.ts`: `editable = rightUri.scheme ===
   "file"` in `diffInit` (fail-closed); `editNewSide` message → WorkspaceEdit
   + save; echo guard on the save-watcher (remember `lastWebviewContent`).
4. Toolbar/UX (Edit⇄Done toggle; hunk nav vs the diff pane; split layout CSS).

## Open points

- **V1a vs V1b** (above) — the one real decision.
- For V1b: what document model? (ProseMirror decorations tracking base vs
  working? a diffing plugin? a dual-doc overlay?) This is unsolved and is the
  crux of the estimate.
- Three-version AI flow: where does "accept" live — in the panel, or does it
  defer to Claude Code's own accept/reject? (Today closeNative is OFF so the
  native accept/reject stays usable — see #16 notes.)
- Auto-save vs. stay-dirty on write-back (analysis §5a leaned auto-save).
- Frontmatter: reuse `extractFrontmatter`/`prependFrontmatter` around any
  edit surface (lesson from #33, and #33 fixed the diff's frontmatter-as-
  deleted bug — keep that behavior).

## Key files

- `webview/components/DiffView.tsx` (419 lines; split it while here)
- `webview/DiffApp.tsx`, `src/diffPanel.ts` (host, messages, save-watcher)
- `src/provider.ts` `comparePair()` (scheme → which side is a real file)
- `webview/App.tsx` (extension array to extract; overlay usage is out of scope)
