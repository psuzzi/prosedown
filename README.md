[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=psuzzi.prosedown)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Install-C160EF?logo=eclipseide&logoColor=white)](https://open-vsx.org/extension/psuzzi/prosedown)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/psuzzi/prosedown/blob/main/LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.80.0-24a0ed)](https://code.visualstudio.com/)

I read as much `.md` as all other programming languages combined.

Personal notes, research notes, Claude Code generated reports, random READMEs.

I find it easier to read rich, block-based markdown than raw markdown — WYSIWYG (What You See Is What You Get), so the document on screen already looks the way it will read.

![Prosedown feature showcase](assets/prosedown-feature-showcase-100pc-v2.gif)

That's why Prosedown exists.

## The Cool Stuff

### Rich Diffs — for git _and_ AI edits

You have seen rich editing. But have you seen rich **diffing**?

Prosedown renders a navigable, side-by-side diff of your markdown — with images inline and headings intact. It works for `git` changes **and** for AI-proposed edits: when Claude Code (or another agent) previews a change to a `.md` file, Prosedown opens the rich diff automatically. Step through every change with the ↑ / ↓ controls.

![Rich diff with change navigation](assets/rich-diff-with-navigation.png)

### Seamless Sync.

Open in the Default Editor.

Open in the Rich Editor.

Open in the Browser.

It just works.

![seamless-sync](assets/seamless-sync.gif)

### Navigate without hassle.

Sticky headings so you can navigate long documents with ease.

Table of contents so you know where you are.

Clicky here, go there.

![navigate](assets/navigate.gif)

## Loaded With Features

### Modes

#### Default Editor

Default editor supports opening in Rich Editor and Browser modes.

Enjoy it because this will be the last time you open the vanilla view.

![default-editor-overview](assets/default-editor-overview.png)

#### Rich Editor

The rich editor lets you jump straight back to the default editor, or open in the browser. Everything syncs automatically and instantly.

![rich-editor-overview](assets/rich-editor-overview.png)

#### Browser

Browser mode lets you open the rich editor as a Chrome/Firefox tab, so you can take it with you everywhere your browser goes.

Drag and drop images, gifs, etc.

It's like Notion, but you own the data.

![browser-mode-overview](assets/browser-mode-overview.png)

### Rich editing

#### Slash Commands

The beloved `/` works out of the box. It's like you never left your favourite editor.

![slash-command-working](assets/slash-command-working.png)

#### Checkboxes, Tables, Math, Quotes, Code Blocks, and your standard stuff.

Tables have options to:

- add row above, add row below
- add column to the left, add columns to the right
- remove rows, remove columns
- drop the entire table

You can write math using $\KaTeX$ in both inline and block modes.

![checkboxes-table-inline-math](assets/checkboxes-table-inline-math.png)

![math-block](assets/math-block.png)

#### Mermaid Diagrams

` ```mermaid ` fences render as live diagrams inline — edit the source, the preview updates.

![mermaid](assets/mermaid.gif)

#### YouTube & GitHub Embeds

Paste a YouTube or GitHub URL and get a rich card; the source stays a bare URL so the file remains portable.

![embedding](assets/embedding.gif)

## Known Limitations

- Opening a file never rewrites it. Saving is surgical: only the top-level blocks you actually edit are re-serialized. Untouched regions stay byte-identical (whitespace, `*` vs `_`, list tightness, setext headings, fence labels, …). The block you *did* edit is still normalized according to the serialization settings below.
- A whole list, table, blockquote, or code fence is one top-level block — editing one list item rewrites that list (not the rest of the file).
- Conversion of an edited block from rich text back to markdown is not a one-to-one exact map. You can control normalization of edited blocks via the settings icon in the rich editor mode.
- Bold/italic adjacent to a word, when the run also contains a code span, can't be expressed in plain CommonMark (e.g. `**`bold`**Apples` parses as literal asterisks, not bold). The editor saves these as `**`bold`**<!---->Apples` — an empty HTML comment is the cleanest CommonMark-valid way to break the flanking run so the bold survives re-open. Adding a space (or any non-word char) avoids the separator entirely and is handled naturally.

---

## Meta Thingies

### Installation

Search for **Prosedown** in your editor's Extensions panel and hit Install. No login, setup or permissions required. It works out of the box.

Prosedown is published to both extension registries, so it installs the same way in VS Code and in the VS Code-compatible editors:

| Registry                                                                                    | Editors                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=psuzzi.prosedown) | VS Code                                           |
| [Open VSX](https://open-vsx.org/extension/psuzzi/prosedown)                                 | Cursor, Windsurf, VSCodium, Gitpod, Eclipse Theia |

Or from the command line:

```bash
code --install-extension psuzzi.prosedown      # VS Code
cursor --install-extension psuzzi.prosedown    # Cursor, Windsurf, VSCodium, …
```

### Commands

Every action is in the command palette under the `Prosedown:` prefix.

| Command palette title          | Shortcut                                      | What it does                                                                                                                                                      |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle Prosedown/Source Editor | Cmd/Ctrl+Shift+M (on `.md` files)             | Swap the active `.md` between the Prosedown rich editor and VS Code's default text editor.                                                                        |
| Find in Document               | Cmd/Ctrl+F (inside the rich editor)           | Open the in-editor search bar for the current rich-editor pane.                                                                                                   |
| Open Rich Diff                 | Right-click an SCM entry, or the diff toolbar | Open a side-by-side or rendered markdown diff of the selected file vs HEAD (or any two URIs). AI-proposed edits open this automatically.                          |
| Open in Browser                | —                                             | Spin up a local server and open the file in your default browser as the same rich editor — drag-and-drop images, leave it open as a tab, edits sync back to disk. |
| Factory Reset Settings         | —                                             | Wipe all Prosedown settings back to defaults and re-show the welcome modal on the next file open. Confirms before applying.                                       |

### Keyboard shortcuts

| Shortcut         | Action                                  |
| ---------------- | --------------------------------------- |
| Cmd/Ctrl+Shift+M | Toggle rich / source editor             |
| Cmd/Ctrl+F       | Find in document                        |
| /                | Open slash command menu (start of line) |

### Privacy

I do not collect telemetry, analytics, or usage data.

I am too lazy to implement that.

Everything runs locally in your VS Code instance.

### Bugs/Feature Requests

If you encounter any bugs or have any feature requests, please [open an issue](https://github.com/psuzzi/prosedown/issues).

I am actively using it myself, so expect frequent updates.

### Available Platforms

- **VS Code Marketplace** — [marketplace.visualstudio.com/items?itemName=psuzzi.prosedown](https://marketplace.visualstudio.com/items?itemName=psuzzi.prosedown)
- **Open VSX** — [open-vsx.org/extension/psuzzi/prosedown](https://open-vsx.org/extension/psuzzi/prosedown)

Both registries receive every release from the same build, so the two listings are always the same version.

### Acknowledgments

Prosedown is a fork of the excellent [Markdown Studio](https://github.com/chaudhary1337/markdown-studio) by Tanishq Chaudhary, used under the MIT License. After contributing a few fixes upstream and seeing no further activity there, I decided to fork and continue development at full speed on a derived solution. My thanks to the original author for the foundation this builds on.
