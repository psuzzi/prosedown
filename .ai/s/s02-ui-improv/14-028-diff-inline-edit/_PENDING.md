# ⏸️ PENDING — #28 inline-editable diff

**This feature is designed but NOT built.** Paused on 2026-07-17 after the
analysis/design phase, by operator decision. No production code was written.

## Status

- GitHub issue: https://github.com/psuzzi/prosedown/issues/28 (open)
- Parked branch: `fix/028-diff-inline-edit` (pushed, **not merged**, left open) —
  carries a branch-only `HANDOFF.md` with the detailed resume plan.
- Current shipping behavior is unchanged: the diff is view-only, with an
  **Edit** button that opens the file in the full editor. That covers the
  review flow in the meantime.

## Read these first (in order)

1. `04-simplified-analysis-result.md` — the plain-language summary.
2. `03-analysis-result.md` — the agreed direction of record (edit inside the
   colored WYSIWYG diff; three-version model for AI suggestions; VS Code owns
   source-level diffing).
3. `01-analysis.md` + `02-proposed-impl.md` — the deeper (split-pane) analysis
   and phased plan. Note: `03` refines/partly supersedes these.

## To resume

Check out `fix/028-diff-inline-edit`, read its `HANDOFF.md`, and decide the
open v1-vs-v2 question first (cheap split-pane edit mode vs. the richer
in-place colored/track-changes editor). Everything else follows from that.
