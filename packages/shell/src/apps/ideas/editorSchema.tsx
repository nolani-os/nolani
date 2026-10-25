/** BlockNote schema with a callout block and mention inline content.
 * Markdown-as-source-of-truth rule: EVERY custom block has a lossless MD form:
 * callout ↔ "> [!note] …" admonition, mention ↔ "[@Title](claraos://…)" link.
 * The translation is done by mdBridge.ts (pre-serialize/post-parse), NOT this file. */
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { i18n } from "@claraos/core";

/** Admonition variants (GitHub syntax): key = MD marker, value = display. */
/** `label` is a getter, read in the UI language when shown. */
const hinweis = (kind: string, icon: string) =>
  ({ icon, get label() { return i18n.t(`wissen:callout.${kind}`); } });

export const CALLOUT_KINDS: Record<string, { icon: string; label: string }> = {
  note: hinweis("note", "💡"),
  tip: hinweis("tip", "🌱"),
  important: hinweis("important", "📌"),
  warning: hinweis("warning", "⚠️"),
  caution: hinweis("caution", "🛑"),
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
            title={i18n.t("wissen:callout.switch", { kind: kind.label })}
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
        title={i18n.t("wissen:editor.linkedObject")}
      >
        @{props.inlineContent.props.title || i18n.t("wissen:editor.object")}
      </span>
    ),
  },
);

export const kbSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, callout: Callout() },  // factory call!
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention },
});
