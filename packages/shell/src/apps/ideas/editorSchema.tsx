/** BlockNote schema with a callout block and mention inline content.
 * Markdown-as-source-of-truth rule: EVERY custom block has a lossless MD form:
 * callout ↔ "> [!note] …" admonition, mention ↔ "[@Title](claraos://…)" link.
 * The translation is done by mdBridge.ts (pre-serialize/post-parse), NOT this file. */
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";

/** Admonition variants (GitHub syntax): key = MD marker, value = display. */
export const CALLOUT_KINDS: Record<string, { icon: string; label: string }> = {
  note: { icon: "💡", label: "Hinweis" },
  tip: { icon: "🌱", label: "Tipp" },
  important: { icon: "📌", label: "Wichtig" },
  warning: { icon: "⚠️", label: "Warnung" },
  caution: { icon: "🛑", label: "Achtung" },
};

/** Note (BlockNote 0.51): createReactBlockSpec returns a FACTORY (must be called),
 * whereas createReactInlineContentSpec returns the spec directly. Mixing them up
 * crashes schema init with "Cannot read properties of undefined (reading 'node')". */
export const Callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      kind: { default: "note", values: Object.keys(CALLOUT_KINDS) },
    },
    content: "inline",
  },
  {
    render: (props: any) => {
      const kind = CALLOUT_KINDS[props.block.props.kind] ?? CALLOUT_KINDS.note;
      return (
        <div className="kb-callout" data-kind={props.block.props.kind}>
          <button
            className="kb-callout-icon"
            title={`${kind.label} — klicken zum Wechseln`}
            contentEditable={false}
            onClick={() => {
              const keys = Object.keys(CALLOUT_KINDS);
              const next = keys[(keys.indexOf(props.block.props.kind) + 1) % keys.length];
              props.editor.updateBlock(props.block, { props: { kind: next } });
            }}
          >
            {kind.icon}
          </button>
          <div className="kb-callout-content" ref={props.contentRef} />
        </div>
      );
    },
  },
);

export const Mention = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: {
      objectId: { default: "" },
      title: { default: "" },
    },
    content: "none",
  },
  {
    render: (props: any) => (
      <span
        className="kb-mention"
        data-object-id={props.inlineContent.props.objectId}
        title="Verknüpftes Objekt"
      >
        @{props.inlineContent.props.title || "Objekt"}
      </span>
    ),
  },
);

export const kbSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, callout: Callout() },  // factory call!
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention },
});
