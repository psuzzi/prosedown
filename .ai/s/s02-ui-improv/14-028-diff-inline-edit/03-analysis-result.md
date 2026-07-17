# #28 — Analysis result (agreed direction)

The conclusion after reviewing the deep analysis (`01-analysis.md`) and proposal (`02-proposed-impl.md`) with the operator. This is the **product direction of record**; it **refines and partly replaces** the split-pane idea in those earlier docs. Nothing here is built yet — it's guidance for whoever resumes. A plain-language version is in `04-simplified-analysis-result.md`.

## Core takeaway

Editing should happen **inside the colored WYSIWYG diff** (track-changes style), not in a separate plain editor beside it. That's the better UX but a bigger build, because it needs a real change-tracking document model (base + working, rendered as green/red, still typeable). If that proves too large for a first pass, the split-pane edit mode in `02-proposed-impl.md` remains a valid, cheaper v1 with inline-colored editing as v2.

## The vision: edit inside the colored diff

Rather than "diff on the left, a separate plain editor on the right", edit **directly in the WYSIWYG diff itself**:

- added content shown in **green**, removed content in **red**,
- and you can type right there, in that same colored view.

This is essentially a **track-changes editor**, not a side-by-side pair. It's a nicer experience, but a different (and harder) model than the earlier proposal — see "Why this is the hard part" below.

## Two cases, handled differently

**1. AI temporary suggestion** (e.g. Claude Code proposing an edit)

Keep **three versions** in play:

- **base** — the previous/original value,
- **suggested** — what the AI is proposing (the current "new" side),
- **working** — an intermediate version the user edits on top of the suggestion, before deciding to accept.

So the user can take the AI's proposal, tweak it in the diff, and only then accept. The AI suggestion isn't a saved file, so this all lives in memory until accepted.

**2. Plain Git change**

Behaves like a **normal edit of the working file**, just done through the WYSIWYG diff/edit tool. There's one real file on disk; the "working" version and that file are the same thing (edits write straight back).

## Scope boundary: source-level editing is NOT ours

If someone wants to edit the **raw source** (markdown text) of either an AI or a Git diff, **reuse VS Code's built-in source diff tools** rather than building our own. That's one less thing for us to maintain. Prosedown owns the **WYSIWYG** diff/edit experience; plain-text diffing stays with the editor that already does it well.

## Why this is the hard part

The earlier analysis said the diff view "isn't a document you can type into" — that's true of the _current_ merged-highlight output. The vision here needs a **real change-tracking document model**: one structure that holds base + working, renders the differences as green/red inline, and still lets you place a cursor and type. That's the core thing to design.

Open question for resumption: build this on top of the editor (a track-changes layer / decorations that know base vs working), or keep the simpler split-pane edit mode from `02-proposed-impl.md` as a v1 and treat inline-colored-editing as v2? The split-pane is much cheaper and already specced; the inline-colored version is the better UX but a bigger build.

## Unchanged from earlier analysis (still applies)

- **Editable only when the "new" side is a real file** — AI proposals stay special (in-memory working version, no disk write until accept).
- **Content fidelity**: any editor used here must share the main editor's full configuration, or it silently drops math/diagrams/tables/embeds on save. Extract one shared setup.
- The in-editor "Diff vs HEAD" overlay is out of scope (the real editor is right behind it).
