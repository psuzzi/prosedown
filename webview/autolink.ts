/**
 * Auto-linking while typing follows the GFM autolink-literal rule, so the
 * editor links exactly what the saved file (and GitHub) link on their own:
 * `www.…`, `http://…`, `https://…`, and emails. Tiptap's default would also
 * link any word that happens to end in a top-level domain — `README.md`
 * (`.md` is Moldova), `foo.com`, `a.io` — which the file never treats as
 * links (#6, #91).
 *
 * Spec: https://github.github.com/gfm/#autolinks-extension-
 */
export function isGfmAutolink(text: string): boolean {
  return (
    /^(https?:\/\/|www\.)\S+$/i.test(text) ||
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(\.[\w-]+)+$/.test(text)
  );
}
