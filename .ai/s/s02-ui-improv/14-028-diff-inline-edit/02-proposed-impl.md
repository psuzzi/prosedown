# #28 — Proposed implementation

Four phases, one branch (`fix/028-diff-inline-edit`), one PR. Version stays 1.0.11 (batched release with #33 after this lands).

## Phase 1 — Shared editor-extension factory (pure refactor)

**New `webview/editorExtensions.ts`:**

```ts
export function createEditorExtensions(lowlight: ReturnType<typeof createLowlight>, opts?: { slashCommand?: boolean }) {
  return [ StarterKit.configure({...}), Code.extend({ excludes: "" }), Link.configure({...}),
           ImageBlock, Table…, TaskList…, MermaidBlock, createCodeBlock(lowlight),
           MathInline, MathBlock, YouTubeEmbed, GitHubEmbed,
           ...(opts?.slashCommand !== false ? [SlashCommand] : []) ];
}
```

`App.tsx` swaps its inline array for this call. Zero behavior change; run the full finish workflow to prove it.

## Phase 2 — Edit pane + live re-diff (webview only)

**New `webview/components/DiffEditPane.tsx`:**
- minimal `useEditor` with `createEditorExtensions(lowlight)`;
- props: `{ initialMarkdown, baseUri, settingsRef, onMarkdownChange (debounced) }`;
- init: `extractFrontmatter` → `markdownToHtml` → `setContent`; on update (400 ms debounce): `htmlToMarkdownSync` → `prependFrontmatter` → `onMarkdownChange(md)`;
- no toolbar/TOC/search chrome; `.tiptap-editor` class reused for styling.

**`DiffView.tsx`:**
- new props: `inlineEditable?: boolean`, `onContentEdit?: (md: string) => void`;
- new state `editing`; when true render split: left = existing rendered-diff pipeline computed from `(oldContent, editedMarkdown ?? newContent)`, right = `DiffEditPane`;
- `onMarkdownChange` → `setEditedMarkdown(md)` (drives left pane) + `onContentEdit?.(md)` (write-back);
- extract `DiffToolbar` component while in here (Edit/Done toggle, mode/layout segments, hunk nav, close);
- Edit button behavior: `inlineEditable ? toggle edit mode : onEdit()` (current open-in-editor fallback).

**`DiffApp.tsx`:** pass `inlineEditable={data.editable}` and `onContentEdit={(content) => vscodeApi.postMessage({ type: "editNewSide", content })}`.

`App.tsx` overlay passes neither → overlay unchanged.

## Phase 3 — Host write-back (`src/diffPanel.ts`)

- `postInit()` adds `editable: this.rightUri.scheme === "file"` to `diffInit`;
- handler:

```ts
else if (msg.type === "editNewSide") {
  if (this.rightUri.scheme !== "file") return;           // fail-closed
  const doc = await vscode.workspace.openTextDocument(this.rightUri);
  if (doc.getText() === msg.content) return;              // no-op guard
  this.lastWebviewContent = msg.content;                  // echo guard
  const edit = new vscode.WorkspaceEdit();
  edit.replace(this.rightUri, fullRange(doc), msg.content);
  await vscode.workspace.applyEdit(edit);
  await doc.save();                                       // decision §5a: auto-save
}
```

- save-watcher: skip `refresh()` when the saved doc's content equals `lastWebviewContent` (echo), clear the marker otherwise;
- webview side: while `editing`, apply `diffUpdate.oldContent` but ignore `newContent` (editor is source of truth).

## Phase 4 — Polish

- Toolbar states/tooltips (`Edit` ⇄ `Done`; disabled-reason tooltip when not editable);
- hunk nav bound to the left pane in edit mode;
- `editor.css`: split-pane layout (`.diff-edit-split`), edit-pane scroll containment;
- CHANGELOG bullet under `## 1.0.x`; finish workflow; manual verification script below.

## Verification script (manual)

1. Git-modify `test/example.md`, open **Open Rich Diff** → Edit → type in the right pane → left diff updates ~0.5 s later; file on disk updates (auto-save); undo works inside the pane.
2. Math/mermaid/table/task-list content survives an edit-mode round-trip byte-identically except the intended edit (fidelity check).
3. Frontmatter intact after edit-mode write-back (#33 interplay).
4. Claude Code proposed edit → Edit button falls back to open-in-editor; no write attempts to the virtual side (check with a proposal open).
5. External change while editing (edit the file in another editor) → old side refreshes, typed content not clobbered.
6. Overlay "Diff vs HEAD" in the main editor: unchanged behavior.

## Open questions for review

1. **Auto-save on write-back** (recommended) vs. leave dirty — see analysis §5a.
2. Include **SlashCommand** in the edit pane (recommended: yes) — bubble menu stays out in v1.
3. Should **source mode** also get an editable variant (plain textarea on the right)? Proposal: no — WYSIWYG is the product; source editing belongs to the real editor.
