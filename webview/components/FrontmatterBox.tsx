import React, { useEffect, useRef, useState } from "react";

/**
 * Collapsed-by-default box revealing the document's YAML frontmatter (which
 * is stripped from the WYSIWYG render and restored on save). Editable in
 * place (#33): edits rebuild the fenced block and flow through the standard
 * save pipeline via `onChange`. Read-only panes keep a plain <pre>.
 */

// `frontmatter` arrives as the full block including fences (`---\n…\n---\n`).
// Show the inner YAML verbatim.
function stripFences(block: string): string {
  return block
    .replace(/^---\r?\n/, "")
    .replace(/\r?\n---\r?\n?$/, "")
    .replace(/\s+$/, "");
}

export function FrontmatterBox({
  frontmatter,
  readonly = false,
  onChange,
}: {
  frontmatter: string;
  readonly?: boolean;
  onChange?: (inner: string) => void;
}) {
  const [value, setValue] = useState(() => stripFences(frontmatter));
  // Once frontmatter existed, keep the box mounted for the session so
  // clearing the textarea doesn't unmount it mid-edit.
  const [hadFrontmatter, setHadFrontmatter] = useState(
    () => !!frontmatter.trim(),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync external updates (git checkout, AI edit, host echo) into the
  // textarea — but never clobber it while the user is typing in it.
  useEffect(() => {
    if (frontmatter.trim()) setHadFrontmatter(true);
    if (document.activeElement === textareaRef.current) return;
    setValue(stripFences(frontmatter));
  }, [frontmatter]);

  if (!hadFrontmatter) return null;

  const editable = !readonly && !!onChange;
  const rows = Math.min(Math.max(value.split("\n").length, 2), 20);

  return (
    <details className="frontmatter-box">
      <summary className="frontmatter-summary">Frontmatter</summary>
      {editable ? (
        <textarea
          ref={textareaRef}
          className="frontmatter-content frontmatter-input"
          value={value}
          rows={rows}
          spellCheck={false}
          aria-label="Edit frontmatter YAML"
          onChange={(e) => {
            setValue(e.target.value);
            onChange!(e.target.value);
          }}
        />
      ) : (
        <pre className="frontmatter-content">{value}</pre>
      )}
    </details>
  );
}
