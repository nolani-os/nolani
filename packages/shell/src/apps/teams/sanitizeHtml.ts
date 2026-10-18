// Sanitizer for Matrix formatted_body before dangerouslySetInnerHTML.
// The Matrix spec (11.2.1.7) requires clients to strip untrusted HTML down to
// a tag allowlist — other homeserver users could otherwise inject <script>,
// event handlers or javascript: URLs into our timeline.
// DOMParser-based: parses into an inert document (scripts never execute),
// then rebuilds only allowlisted tags/attributes.

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "del", "code", "pre", "blockquote",
  "p", "br", "span", "div", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5",
  "h6", "table", "thead", "tbody", "tr", "th", "td", "hr", "sub", "sup",
  "mx-reply", "img", "font", "caption", "details", "summary",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  "a": new Set(["href", "target", "rel"]),
  "img": new Set(["src", "alt", "title", "width", "height"]),
  "font": new Set(["color"]),
  "span": new Set(["data-mx-color", "data-mx-bg-color", "data-mx-spoiler"]),
  "code": new Set(["class"]), // language-* for syntax hints
  "ol": new Set(["start"]),
};

function urlAllowed(value: string, tag: string): boolean {
  const v = value.trim().toLowerCase();
  if (tag === "img") {
    // Images only via Matrix media (mxc converted to https by sender) or https.
    return v.startsWith("https://") || v.startsWith("mxc://");
  }
  return (
    v.startsWith("https://") || v.startsWith("http://") ||
    v.startsWith("mailto:") || v.startsWith("matrix:") || v.startsWith("#")
  );
}

function sanitizeNode(node: Node, out: Node, doc: Document, depth: number): void {
  if (depth > 50) return; // spec: cap nesting
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      // Drop the tag but keep its (sanitized) children — e.g. <script> body is
      // NOT kept as text, everything else unwraps.
      if (tag !== "script" && tag !== "style") {
        sanitizeNode(el, out, doc, depth + 1);
      }
      continue;
    }

    const clean = doc.createElement(tag);
    const allowed = ALLOWED_ATTRS[tag];
    if (allowed) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name)) continue;
        if ((name === "href" || name === "src") && !urlAllowed(attr.value, tag)) continue;
        clean.setAttribute(name, attr.value);
      }
    }
    if (tag === "a") {
      clean.setAttribute("target", "_blank");
      clean.setAttribute("rel", "noreferrer noopener");
    }
    sanitizeNode(el, clean, doc, depth + 1);
    out.appendChild(clean);
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const container = doc.createElement("div");
  sanitizeNode(doc.body, container, doc, 0);
  return container.innerHTML;
}
