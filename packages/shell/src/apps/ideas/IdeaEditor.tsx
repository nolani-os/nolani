/** BlockNote wrapper: the only point of contact with the 0.x API (version pinned).
 * body = Markdown is the single source of truth (backend/Clara/RAG): load via
 * tryParseMarkdownToBlocks + mdBridge.blocksFromParse, save via
 * mdBridge.blocksForSerialize + blocksToMarkdownLossy (debounced).
 * Uploads (image/video/file → kb_attachments), callout block,
 * @-mentions (→ claraos:// links → automatic backlinks via post-save).
 * Custom blocks ONLY with a lossless MD form (see mdBridge.ts).
 * Loaded by IdeaDetail via React.lazy (bundle only when needed). */
import { useEffect, useRef } from "react";
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { filterSuggestionItems } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { de, en } from "@blocknote/core/locales";
import "@blocknote/core/fonts/inter.css";
import { Icon } from "../../components/Icon";
import "@blocknote/mantine/style.css";
import "./editorTheme.css";
import { kbSchema, CALLOUT_KINDS } from "./editorSchema";
import { blocksForSerialize, blocksFromParse } from "./mdBridge";
import { ideasApi } from "./api";
import { useColorMode } from "./useColorMode";
import { useTranslation, i18n } from "@claraos/core";

/** Formatting toolbar for touch devices: BlockNote only ships a selection
 * popup and the slash menu, both of which assume a mouse or keyboard. Without
 * this bar, bold, lists or callouts are practically unreachable on phones
 * (Notion has exactly such a bar above the keyboard). */
function MobileToolbar({ editor }: { editor: any }) {
  const { t } = useTranslation("wissen");
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();   // keep focus in the editor, otherwise the keyboard closes
    fn();
  };
  const setBlock = (type: string, props: Record<string, unknown> = {}) => {
    const cur = editor.getTextCursorPosition().block;
    editor.updateBlock(cur, { type, props } as never);
  };
  return (
    <div className="kb-mobile-toolbar">
      <button onMouseDown={act(() => editor.toggleStyles({ bold: true }))} title={t("editor.bold")}><b>B</b></button>
      <button onMouseDown={act(() => editor.toggleStyles({ italic: true }))} title={t("editor.italic")}><i>I</i></button>
      <button onMouseDown={act(() => setBlock("heading", { level: 1 }))} title={t("editor.heading")}>H1</button>
      <button onMouseDown={act(() => setBlock("heading", { level: 2 }))} title={t("editor.subheading")}>H2</button>
      <button onMouseDown={act(() => setBlock("bulletListItem"))} title={t("editor.list")}>•—</button>
      <button onMouseDown={act(() => setBlock("checkListItem"))} title={t("editor.task")}>☑</button>
      <button onMouseDown={act(() => setBlock("callout", { kind: "note" }))} title={t("editor.calloutBox")}><Icon name="idea" size={14} /></button>
      <button onMouseDown={act(() => setBlock("codeBlock"))} title={t("editor.code")}>{"</>"}</button>
      <button onMouseDown={act(() => editor.insertInlineContent("@"))} title="Objekt erwähnen">@</button>
      <button onMouseDown={act(() => setBlock("paragraph"))} title={t("editor.paragraph")}>¶</button>
    </div>
  );
}

interface Props {
  /** Markdown body at mount (not a controlled input; remote updates remount via key={}) */
  initialMarkdown: string;
  /** Called debounced (1.5 s) with the current Markdown */
  onChangeMarkdown: (md: string) => void;
  readOnly?: boolean;
  /** Target for editor uploads (kb_attachments); without an ID uploads are disabled */
  objectId?: string;
  /** Touch device → show the fixed formatting toolbar */
  mobile?: boolean;
  /** "/Unterseite" (subpage): creates a subpage and returns it; the editor
   *  then inserts a mention at the cursor position. */
  onNeueUnterseite?: () => Promise<{ id: string; title: string } | null>;
}

async function uploadTo(objectId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  const r = await fetch(`/api/claraos/knowledge/objects/${objectId}/attachments`, {
    method: "POST", credentials: "include", body: form,
  });
  if (!r.ok) throw new Error(i18n.t("wissen:editor.uploadFailed", { status: r.status }));
  return (await r.json()).attachment.url;
}

export default function IdeaEditor({
  initialMarkdown, onChangeMarkdown, readOnly, objectId, mobile, onNeueUnterseite,
}: Props) {
  const { t } = useTranslation("wissen");
  const editor = useCreateBlockNote({
    schema: kbSchema,
    dictionary: i18n.resolvedLanguage === "en" ? en : de,
    uploadFile: objectId ? (file: File) => uploadTo(objectId, file) : undefined,
  });
  const debounce = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  // Warning: without this, the slash menu renders SNOW-WHITE over the dark app.
  // It is portaled to `document.body`, but our `--bn-colors-*` only apply
  // inside `[data-claraos-editor]`. Without a `theme`, BlockNote falls back to
  // the system's `prefers-color-scheme`, which says nothing about the ClaraOS skin.
  // So we measure the actually rendered surface (`useColorMode`), not the
  // skin name and not the system setting.
  const huelle = useRef<HTMLDivElement>(null);
  const modus = useColorMode(huelle);

  // Markdown → blocks (once per mount; remount via key on remote update)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(initialMarkdown || "");
      if (!cancelled && blocks.length) {
        editor.replaceBlocks(editor.document, blocksFromParse(blocks as never[]) as never[]);
      }
      loaded.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => () => window.clearTimeout(debounce.current), []);

  return (
    <div ref={huelle}>
    <BlockNoteView
      editor={editor}
      editable={!readOnly}
      theme={modus}
      data-claraos-editor
      onChange={() => {
        if (!loaded.current) return;
        window.clearTimeout(debounce.current);
        debounce.current = window.setTimeout(async () => {
          const md = await editor.blocksToMarkdownLossy(
            blocksForSerialize(editor.document as never[]) as never[],
          );
          onChangeMarkdown(md);
        }, 1500);
      }}
    >
      {mobile && !readOnly && <MobileToolbar editor={editor} />}
      {/* @-mention: object search → mention inline (serialized as a claraos:// link) */}
      <SuggestionMenuController
        triggerCharacter="@"
        getItems={async (query: string) => {
          const objs = query.trim()
            ? await ideasApi.search(query).catch(() => [])
            : await ideasApi.listObjects({ limit: 8 }).catch(() => []);
          return objs.slice(0, 8).map((o) => ({
            title: o.title,
            subtext: o.type,
            onItemClick: () => {
              editor.insertInlineContent([
                { type: "mention", props: { objectId: o.id, title: o.title } } as never,
                " ",
              ]);
            },
          }));
        }}
      />
      {/* ONE slash menu for everything.
          Callouts are not on a separate "!" trigger (a second path to the
          same thing that nobody knows about without reading the source);
          they live under "/" with everything else. The default menu
          (heading, lists, task, quote, code, divider) already brings groups,
          help text AND keyboard shortcuts. */}
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query: string) => filterSuggestionItems([
          ...getDefaultReactSlashMenuItems(editor as never),
          ...Object.entries(CALLOUT_KINDS).map(([kind, v]) => ({
            title: `${v.label}`,
            subtext: t("editor.calloutSub"),
            aliases: ["callout", "kasten", "hinweis", kind],
            group: t("editor.groupBoxes"),
            icon: <span>{v.icon}</span>,
            onItemClick: () => {
              const cur = editor.getTextCursorPosition().block;
              editor.updateBlock(cur, { type: "callout", props: { kind } } as never);
            },
          })),
          ...(onNeueUnterseite ? [{
            title: t("editor.subpage"),
            subtext: t("editor.subpageSub"),
            aliases: ["seite", "unterseite", "page", "sub"],
            group: t("editor.groupRefs"),
            icon: <Icon name="document" size={16} />,
            onItemClick: async () => {
              const sub = await onNeueUnterseite();
              if (!sub) return;
              editor.insertInlineContent([
                { type: "mention", props: { objectId: sub.id, title: sub.title } } as never,
                " ",
              ]);
            },
          }] : []),
          {
            title: t("editor.mention"),
            subtext: t("editor.mentionSub"),
            aliases: ["erwähnung", "mention", "verweis", "link"],
            group: t("editor.groupRefs"),
            icon: <Icon name="link" size={16} />,
            onItemClick: () => editor.insertInlineContent("@"),
          },
        ] as never[], query)}
      />
    </BlockNoteView>
    </div>
  );
}
