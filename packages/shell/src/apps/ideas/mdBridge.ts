/** MD bridge: translates between custom blocks and their lossless
 * Markdown form.
 *
 *   Callout  ↔  quote block whose text starts with "[!kind] "
 *               (MD: "> [!note] …", a GitHub admonition, readable by Clara)
 *   Mention  ↔  link "[@Title](claraos://knowledge/object/<uuid>)"
 *               (post-save extracts kb_refs/backlinks from it automatically)
 *
 * Works on the block JSON (plain objects), deliberately WITHOUT BlockNote
 * internals, so a BlockNote upgrade does not break the bridge. */

/** Important: the mention MD form is the fragment `#kb-<uuid>`, NOT `claraos://…`.
 * The Markdown parser (remark/rehype) drops unknown URL schemes when
 * sanitizing, so the link (and with it the backlink) was lost on round trip.
 * Fragments are always allowed and stay domain-independent.
 * Both forms are READ (legacy content and claraos:// links written by Clara). */
const OBJ_URI_RE =
  /^(?:claraos:\/\/(?:knowledge|ideas)\/object\/|#kb-)([0-9a-f-]{36})$/i;
const CALLOUT_MARKER_RE = /^\[!(\w+)\]\s?/;

type AnyBlock = Record<string, any>;
type AnyInline = Record<string, any>;

/** Include table cells. A table block's content is an OBJECT
 * (`{type:"tableContent", rows:[{cells}]}`), not an array, so the
 * `Array.isArray(b.content)` check below skipped it. As a result, a mention
 * INSIDE a table stayed a raw `#kb-…` link on load instead of a mention chip.
 * Depending on its age, a cell is either an inline list directly or a
 * `tableCell` object; both forms occur. */
function tableContentMap(tc: AnyBlock, fn: (ic: AnyInline) => AnyInline): AnyBlock {
  return {
    ...tc,
    rows: (tc.rows ?? []).map((row: AnyBlock) => ({
      ...row,
      cells: (row.cells ?? []).map((cell: any) => (
        Array.isArray(cell)
          ? cell.map(fn)
          : { ...cell, content: Array.isArray(cell?.content) ? cell.content.map(fn) : cell?.content }
      )),
    })),
  };
}

const istTabelle = (c: any): boolean => !!c && !Array.isArray(c) && c.type === "tableContent";

// ── Serialize (blocks → MD-compatible blocks) ──────────────────────────────

function inlineToMd(ic: AnyInline): AnyInline {
  if (ic?.type === "mention") {
    const { objectId, title } = ic.props ?? {};
    return {
      type: "link",
      href: `#kb-${objectId}`,
      content: [{ type: "text", text: `@${title || "Objekt"}`, styles: {} }],
    };
  }
  if (ic?.type === "link" && Array.isArray(ic.content)) {
    return { ...ic, content: ic.content.map(inlineToMd) };
  }
  return ic;
}

/** Call before blocksToMarkdownLossy: custom blocks → standard forms. */
export function blocksForSerialize(blocks: AnyBlock[]): AnyBlock[] {
  return blocks.map((b) => {
    const out: AnyBlock = { ...b };
    if (Array.isArray(b.content)) {
      out.content = b.content.map(inlineToMd);
    } else if (istTabelle(b.content)) {
      out.content = tableContentMap(b.content, inlineToMd);
    }
    if (Array.isArray(b.children) && b.children.length) {
      out.children = blocksForSerialize(b.children);
    }
    if (b.type === "callout") {
      const kind = b.props?.kind || "note";
      const marker = { type: "text", text: `[!${kind}] `, styles: {} };
      out.type = "quote";
      out.props = {};
      out.content = [marker, ...(out.content ?? [])];
    }
    return out;
  });
}

// ── Parse (blocks from MD → custom blocks) ─────────────────────────────────

function inlineFromMd(ic: AnyInline): AnyInline {
  if (ic?.type === "link") {
    const m = OBJ_URI_RE.exec(ic.href ?? "");
    if (m) {
      const text = (ic.content ?? [])
        .map((c: AnyInline) => (c?.type === "text" ? c.text : ""))
        .join("");
      return {
        type: "mention",
        props: { objectId: m[1].toLowerCase(), title: text.replace(/^@/, "") },
      };
    }
    return { ...ic, content: (ic.content ?? []).map(inlineFromMd) };
  }
  return ic;
}

/** Call after tryParseMarkdownToBlocks: standard forms → custom blocks. */
export function blocksFromParse(blocks: AnyBlock[]): AnyBlock[] {
  return blocks.map((b) => {
    const out: AnyBlock = { ...b };
    if (Array.isArray(b.content)) {
      out.content = b.content.map(inlineFromMd);
    } else if (istTabelle(b.content)) {
      out.content = tableContentMap(b.content, inlineFromMd);
    }
    if (Array.isArray(b.children) && b.children.length) {
      out.children = blocksFromParse(b.children);
    }
    if (b.type === "quote" && Array.isArray(out.content) && out.content.length) {
      const first = out.content[0];
      if (first?.type === "text") {
        const m = CALLOUT_MARKER_RE.exec(first.text ?? "");
        if (m) {
          const kind = m[1].toLowerCase();
          const rest = first.text.slice(m[0].length);
          out.type = "callout";
          out.props = { kind: ["note", "tip", "important", "warning", "caution"].includes(kind) ? kind : "note" };
          out.content = rest
            ? [{ ...first, text: rest }, ...out.content.slice(1)]
            : out.content.slice(1);
          if (!out.content.length) {
            out.content = [{ type: "text", text: "", styles: {} }];
          }
        }
      }
    }
    return out;
  });
}
