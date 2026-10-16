import { Node, mergeAttributes } from "@tiptap/core";
import { RAW_HTML_TYPE } from "../conversion-utils";

/**
 * A block of raw HTML from the markdown file (`<details>`, `<summary>`, an
 * HTML comment, `<div align="center">`…). The editor can't show it as rich
 * text, so it is kept as an atom holding its exact source and shown as a
 * small read-only chip. Saving writes the source back byte for byte; deleting
 * the chip deletes the HTML.
 */
export const RawHtmlBlock = Node.create({
  name: "rawHtmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-raw") ?? "",
        renderHTML: (attrs) => ({ "data-raw": attrs.raw }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${RAW_HTML_TYPE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": RAW_HTML_TYPE })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "raw-html-block";
      dom.contentEditable = "false";
      dom.title = "Raw HTML: kept exactly as written. Edit it in the text editor.";
      const label = document.createElement("span");
      label.className = "raw-html-label";
      label.textContent = "HTML";
      const code = document.createElement("code");
      code.className = "raw-html-source";
      code.textContent = node.attrs.raw;
      dom.append(label, code);
      return { dom };
    };
  },
});
