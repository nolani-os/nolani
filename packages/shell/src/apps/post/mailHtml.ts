import DOMPurify from "dompurify";

/**
 * Mail HTML for editors on the shell origin (composer, signature editor).
 *
 * The API already allowlist-sanitises quotes, but these editors are
 * contenteditable elements in the main document: anything that survives runs with
 * the user's session. So the client sanitises again right before `innerHTML`.
 * `<style>` is dropped because its rules would restyle the whole shell, `id` and
 * `name` because they can shadow globals (DOM clobbering).
 */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["id", "name"],
  });
}
