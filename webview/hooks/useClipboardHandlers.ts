import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { htmlToMarkdownSync } from "./useVSCodeSync";
import type { ProsedownSettings } from "../settings";

/**
 * True when the current selection is entirely code — a single code block's
 * text, a NodeSelection of a code block, or an inline run fully covered by the
 * `code` mark. Such selections should copy as raw code, not markdown, so
 * pasting into a terminal doesn't carry backticks / fences / escapes.
 */
function selectionIsAllCode(state: EditorState): boolean {
  const { from, to, empty } = state.selection;
  if (empty || from === to) return false;
  const codeBlock = state.schema.nodes.codeBlock;
  const codeMark = state.schema.marks.code;

  // Whole code block selected as a node.
  const selNode = (state.selection as { node?: { type: unknown } }).node;
  if (codeBlock && selNode && selNode.type === codeBlock) return true;

  // Selection sits inside a single code block.
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (codeBlock && $from.parent.type === codeBlock && $from.sameParent($to)) return true;

  // Every text node in the range carries the inline `code` mark.
  if (codeMark) {
    let sawText = false;
    let allCode = true;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) {
        sawText = true;
        if (!codeMark.isInSet(node.marks)) allCode = false;
      }
    });
    if (sawText && allCode) return true;
  }
  return false;
}

export function useClipboardHandlers(
  editor: Editor | null,
  baseUri: MutableRefObject<string>,
  docFolderPath: MutableRefObject<string>,
  settingsRef: MutableRefObject<ProsedownSettings>,
  uploadImage: (file: File) => Promise<string>,
): void {
  // Copy/cut: serialize the selection to markdown so text editors (and
  // git commits, slack, etc.) receive .md source instead of rendered text.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;

    const handler = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) return;

      const slice = editor.state.doc.slice(from, to);
      const serializer = DOMSerializer.fromSchema(editor.schema);
      const fragment = serializer.serializeFragment(slice.content);
      const tmp = document.createElement("div");
      tmp.appendChild(fragment);
      const html = tmp.innerHTML;

      // Code-only selections copy as raw text (no backticks / fences / escapes)
      // so pasting into a terminal is clean; prose still copies as markdown.
      let plain: string;
      if (selectionIsAllCode(editor.state)) {
        plain = editor.state.doc.textBetween(from, to, "\n");
      } else {
        try {
          plain = htmlToMarkdownSync(
            html,
            baseUri.current,
            docFolderPath.current,
            settingsRef.current,
          ).replace(/\n+$/, "");
        } catch (err) {
          console.error("[prosedown] copy → markdown failed:", err);
          return; // let Tiptap's default behavior run
        }
      }

      e.preventDefault();
      e.clipboardData.setData("text/plain", plain);
      e.clipboardData.setData("text/html", html);

      // For cut, also delete the selection (we preventDefault'd the copy,
      // and the browser's cut would have removed it automatically — we must
      // do that manually now).
      if (e.type === "cut" && editor.isEditable) {
        editor.commands.deleteSelection();
      }
    };

    dom.addEventListener("copy", handler);
    dom.addEventListener("cut", handler);
    return () => {
      dom.removeEventListener("copy", handler);
      dom.removeEventListener("cut", handler);
    };
  }, [editor, baseUri, docFolderPath, settingsRef]);

  // Paste images from clipboard
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;

    const pasteHandler = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItems = items.filter((i) => i.type.startsWith("image/"));
      if (!imageItems.length) return;

      e.preventDefault();
      imageItems.forEach(async (item) => {
        const file = item.getAsFile();
        if (!file) return;
        try {
          const src = await uploadImage(file);
          editor.chain().focus().setImage({ src }).run();
        } catch (err) {
          console.error("[prosedown] image paste failed:", err);
        }
      });
    };

    dom.addEventListener("paste", pasteHandler);
    return () => dom.removeEventListener("paste", pasteHandler);
  }, [editor, uploadImage]);
}
