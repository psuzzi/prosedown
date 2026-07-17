# #28 — Editable diff: the short version

Plain-language summary of `03-analysis-result.md`.

## What people want

When Prosedown shows a diff (a file's "before vs after"), you can look but
you can't type. To change anything you click **Edit**, which opens the file
separately. The request: edit the "after" side **right there in the diff**.

## The idea

Edit **inside the colored diff itself** — added text stays **green**,
removed text stays **red**, and you can type in that same view. It's like
"track changes" in a word processor: you see your edits as changes, in
place.

## Why it's harder than it sounds

What you see in the diff today is **not something you can type into**. It's
a picture of the changes — old and new merged together with highlights. To
edit in place, Prosedown needs a smarter document underneath that remembers
both the original and your edited version at once, shows the differences in
green/red, and still lets you put a cursor and type. Building that is the
main work.

## Two situations

- **A change from an AI assistant** (e.g. Claude Code proposing an edit):
  keep **three versions** — the original, the AI's suggestion, and *your*
  edited version on top of it — so you can adjust the suggestion before
  accepting. Nothing is written to disk until you accept.
- **A plain Git change**: just editing your real file, but through this
  visual diff. Edits save straight back to the file.

## What we deliberately won't build

If someone wants to edit the **raw text** (not the visual form) of a diff,
they can use **VS Code's built-in diff tools**. Prosedown focuses on the
visual (WYSIWYG) experience; plain-text diffing stays with the tools that
already do it well. One less thing to maintain.

## One thing that could quietly break (and the fix)

Any editor used here must recognise **every kind of content** the main
editor does — math, diagrams, tables, embeds, checklists — or it would
**silently delete** them on save. Fix: everything shares **one editor
configuration** so they can't drift apart.

## How big / status

Medium-to-large, and **paused** for now — understood and planned, not being
built yet. There's a cheaper fallback design (a plain editor beside the
diff) if the in-place colored version is too much for a first version.
Meanwhile, the view-only diff plus the **Edit** button already cover
reviewing and changing files.
