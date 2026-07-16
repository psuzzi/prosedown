import React from "react";

/**
 * Read-only, collapsed-by-default box that reveals the document's YAML
 * frontmatter (which is otherwise stripped from the WYSIWYG render and only
 * restored on save). View-only — editing the frontmatter is done in the
 * source editor.
 */
export function FrontmatterBox({ frontmatter }: { frontmatter: string }) {
  if (!frontmatter.trim()) return null;

  // `frontmatter` is the full block including fences (`---\n…\n---\n`).
  // Strip the fences for display; keep the inner YAML verbatim.
  const inner = frontmatter
    .replace(/^---\r?\n/, "")
    .replace(/\r?\n---\r?\n?$/, "")
    .replace(/\s+$/, "");

  return (
    <details className="frontmatter-box">
      <summary className="frontmatter-summary">Frontmatter</summary>
      <pre className="frontmatter-content">{inner}</pre>
    </details>
  );
}
