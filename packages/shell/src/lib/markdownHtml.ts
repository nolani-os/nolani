/** Markdown → HTML for pasting into office documents (officeViewerBridge). */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");
}

/** Minimal Markdown → HTML for a paste: headings, bullet/numbered lists, bold,
 * italic, paragraphs. Pasted as text/plain, "## Next steps" and "- item"
 * arrived literally — and took over the bold heading style at the cursor. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      const art = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== art) { closeList(); out.push(`<${art}>`); list = art; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return `<html><body>${out.join("")}</body></html>`;
}
