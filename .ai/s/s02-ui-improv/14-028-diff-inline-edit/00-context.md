# #28 — Inline-editable rich diff (edit the new side in the diff view)

GitHub: https://github.com/psuzzi/prosedown/issues/28
Branch (when we start): `fix/028-diff-inline-edit`
Follow-up to #16 (rich diff panel) and the interim "Edit" button.

## Problem

The rich diff view is read-only: it renders a computed old→new merge (`node-htmldiff`) or a source diff (`diff2html`) — neither is an editable document. Editing the new side today means the Edit button → full editor → save → diff refresh round-trip.

## Goal

Edit the **new side directly inside the diff panel**, with write-back to the file and a live (debounced) re-diff while typing.

## Decisions so far (user)

- Design discussion first: `01-analysis.md` + `02-proposed-impl.md` reviewed before implementation.
- In edit mode the left pane shows a **live rendered diff** (old vs. current edited content), not a static old render.
- Release: batched with #33 (already merged) as v1.0.11, after this lands.

## Where things live

- `webview/components/DiffView.tsx` (419 lines) — source/rendered diff, hunk nav, toolbar. Flagged in the #16 review as needing a split.
- `webview/DiffApp.tsx` — standalone-panel shell (same `webview.js` bundle as the full editor → Tiptap + conversion pipeline already available).
- `src/diffPanel.ts` — host: `diffInit`/`diffUpdate` messages, save-watcher refresh, `editFile` handler.
- `src/provider.ts` `comparePair()` — scheme routing; tells us which side is a real file.
- `webview/App.tsx` — in-editor overlay usage of DiffView (Diff vs HEAD).
