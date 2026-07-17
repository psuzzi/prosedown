# #28 — Analysis

## 1. What "inline editing" can and cannot mean here

The diff HTML is a **derived artifact** — htmldiff's merged output interleaves `<ins>/<del>` across arbitrary element boundaries. It has no document model; making _it_ contentEditable would produce garbage on serialize. So inline editing must be an **edit mode**: a real Tiptap surface initialized with the new side's markdown, shown inside the diff panel, with the diff recomputed from the editor's live content.

## 2. The two hosting contexts

| Context                                                      | Component host | New side                 | Verdict                                                                                                                                                             |
| ------------------------------------------------------------ | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone panel (git compare, SCM right-click, Claude flow) | `DiffApp`      | `rightUri`               | **Primary target**                                                                                                                                                  |
| In-editor overlay "Diff vs HEAD"                             | `App`          | the live editor document | **Skip** — the real editor is directly behind the overlay; an editor-inside-the-overlay duplicates it. Close overlay → edit → reopen is already a 1-keystroke flow. |

Within the standalone panel, editability depends on the compare pair:

| Pair (from `comparePair`)       | rightUri scheme                     | Inline-editable?                                                                        |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| git compare                     | `file:` (working file)              | ✅                                                                                       |
| Claude proposed edit            | `_claude_vscode_fs_right` (virtual) | ❌ — the proposal isn't ours to mutate pre-accept; keep read-only + existing Edit button |
| Manual "Open Rich Diff" two-URI | varies                              | editable iff right is `file:`                                                           |

Rule: **`editable = rightUri.scheme === "file"`**, computed host-side, sent in `diffInit`. Fail-closed.

## 3. Content fidelity is the #1 risk

A Tiptap instance missing extensions silently **drops unknown nodes** on parse — an edit pane with fewer extensions than the main editor would destroy math/mermaid/embeds/tasklists on the first write-back. Therefore the edit pane must use the **same extension set** as `App.tsx`. That list currently lives inline in `App.tsx` (~25 lines) → extract a shared factory (`webview/editorExtensions.ts`) used by both. This is a pure refactor with no behavior change, and it removes the risk class entirely.

(SlashCommand and the bubble menu are UX, not fidelity — safe to include or exclude; include for a consistent editing feel, exclude if it drags in chrome. Proposal: include SlashCommand, skip bubble menu in v1.)

## 4. Live re-diff — no host round-trip needed

The webview already holds `oldContent` and computes both diff modes locally. In edit mode:

- editor `update` (debounced ~400 ms) → `htmlToMarkdown` (sync variant already used by the overlay) → local state `editedMarkdown`
- left pane re-runs the existing rendered-diff pipeline on `(oldContent, editedMarkdown)` — purely client-side, fast
- in parallel, the same markdown posts to the host for write-back

So "live" costs nothing architecturally; it reuses the exact pipeline the overlay diff uses today.

## 5. Write-back and the echo problem

New message `editNewSide { content }` → `diffPanel` applies a full-document `WorkspaceEdit` to the right (file) URI.

Two sub-decisions:

**(a) Save or stay dirty?** `openTextDocument().getText()` reflects unsaved changes, so the diff stays correct either way. But a dirty document with no visible editor is invisible state the user can't easily save. → **Recommend: auto-save after each applied edit** (mirrors browser mode's direct file writes; also triggers the existing save-watcher consistently for other listeners).

**(b) Echo guard.** The panel's `onDidSaveTextDocument` watcher calls `refresh()` → posts `diffUpdate` → would clobber the in-flight editor state. Guard exactly like `useEditorState` does for the main editor: the host remembers `lastWebviewContent` and skips the refresh when the saved content equals it; belt-and-braces, the webview ignores `diffUpdate.newContent` while edit mode is active (its editor IS the source of truth for the new side; `oldContent` updates still apply).

## 6. UX

- Toolbar: the current **Edit** button becomes a toggle — `Edit` ⇄ `Done` (or a segmented `View | Edit`). When `editable=false` the old behavior (open file in editor) is kept — same button, degraded gracefully, tooltip explains.
- Edit-mode layout: **left = live rendered diff, right = Tiptap editor**, both scrollable independently. Source mode and unified layout are view-mode concerns; edit mode is its own layout and ignores them (returning to view mode restores the previous mode/layout).
- Hunk nav (↑/↓) keeps working against the left pane.

## 7. DiffView size (pre-existing debt)

DiffView is 419 lines and was flagged in the #16 review. Adding edit mode inline would push it ~600. → extract `DiffToolbar` and the new `DiffEditPane` as separate components in this PR; pure moves, no behavior change beyond the feature.

## 8. Risks & mitigations

| Risk                                 | Mitigation                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Round-trip content loss in edit pane | shared extension factory (§3); the conversion pipeline is the battle-tested one                                       |
| Echo clobbers typing                 | host + webview guards (§5b), same pattern as the main editor                                                          |
| Frontmatter destroyed on write-back  | reuse `extractFrontmatter`/`prependFrontmatter` around the edit pane exactly like `useEditorState` (learned from #33) |
| Perf: re-diff on every keystroke     | debounce 400 ms; htmldiff on typical docs is < 50 ms                                                                  |
| Claude virtual side edited           | `editable` flag is fail-closed host-side                                                                              |

## 9. Effort

M–L. Phased: (1) extension-factory refactor, (2) edit pane + local live re-diff, (3) host write-back + editable flag + guards, (4) toolbar/UX polish. Each phase independently testable; (1) is zero-risk and could even ship alone.
