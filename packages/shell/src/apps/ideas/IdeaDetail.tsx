/** Object detail: the main stage (Notion-like: page = content).
 * Title + BlockNote editor (lazy) + meta sidebar + activity log.
 * Binds the window to the object (setCurrentObjectUri), so "Develop with
 * Clara" opens the inline Clara panel with the object as context. */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { buildObjectUri, useWindowsStore } from "@claraos/core";
import styles from "./IdeasApp.module.css";
import leiste from "../wissen/Wissen.module.css";
import { Icon } from "../../components/Icon";
import { PopupMenu } from "../../components/PopupMenu";
import type { ContextMenuItem } from "../../components/WindowContextMenu";
import { ideasApi } from "./api";
import type { KbObject, KbObjectSlim, KbType, Stage, Visibility } from "./types";
import { MetaSidebar } from "./MetaSidebar";
import { SammlungsFelder } from "../wissen/SammlungsFelder";
import { ClaraSection } from "./ClaraSection";
import { CommentsPanel } from "./CommentsPanel";
import { HistoryPanel } from "./HistoryPanel";

const IdeaEditor = lazy(() => import("./IdeaEditor"));

const KIND_LABEL: Record<string, string> = {
  comment: "💬", analysis: "🔎 Analyse", question: "❓ Rückfrage", answer: "💡 Antwort",
  stage_change: "🪜", edit: "✏️", handoff: "🚀 An Planner übergeben",
};

interface Props {
  objectId: string;
  windowId: string;
  // Also rendered by the knowledge suite; appId controls ONLY the object URI
  // binding (chat_v2 accepts both schemes), nothing else.
  appId?: string;
  currentUser: string;
  linkCandidates: KbObjectSlim[];
  types?: KbType[];
  onBack: () => void;
  onOpenObject: (id: string) => void;
  onChanged: () => void;
  /** Where did the entry come from? First breadcrumb in the path, click = back. */
  herkunft?: { label: string; icon?: string | null };
  /** Running in the side peek next to the table: then no path (the side
   *  peek's header carries it) and the sidebar collapses. */
  kompakt?: boolean;
}

export function IdeaDetail({
  objectId, windowId, appId = "ideas", currentUser, linkCandidates, types = [], onBack, onOpenObject, onChanged,
  herkunft, kompakt,
}: Props) {
  const [obj, setObj] = useState<KbObject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Breadcrumb + subpages + favorite + icon
  const [ancestors, setAncestors] = useState<{ id: string; title: string; icon: string | null }[]>([]);
  const [children, setChildren] = useState<KbObjectSlim[]>([]);
  const [isFav, setIsFav] = useState(false);
  const [iconEdit, setIconEdit] = useState(false);
  // Selected text in the editor → comment anchor (quote + context)
  const [selection, setSelection] = useState<{ text: string; prefix: string; suffix: string } | null>(null);
  /** Title last loaded from the server: reference for "has anything changed?" */
  const savedTitle = useRef<string>("");
  /** Root element: basis for the width measurement (see below).
   *  Callback ref, not `useRef`: the first render shows "Lade…" (loading) and
   *  the actual root element only appears afterwards. A `useRef` with an
   *  empty dependency array would have seen `null` forever. */
  const [wurzel, setWurzel] = useState<HTMLDivElement | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Position of the ⋯ menu (portal, as everywhere in this app)
  const [mehr, setMehr] = useState<{ x: number; y: number } | null>(null);
  const [showMeta, setShowMeta] = useState(false);   // mobile: properties as a sheet
  const [isNarrow, setIsNarrow] = useState(false);
  // Unlinked mentions (objects that name the title in their text)
  const [mentions, setMentions] = useState<KbObjectSlim[]>([]);
  // The editor remounts ONLY on external body changes (e.g. Clara wrote via a
  // tool); our own saves leave the editor (and cursor) untouched.
  const [editorRev, setEditorRev] = useState(0);
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);
  const toggleClaraInline = useWindowsStore((s) => s.toggleClaraInline);

  const load = useCallback(async () => {
    try {
      const fresh = await ideasApi.getObject(objectId);
      savedTitle.current = fresh.title;
      setObj((prev) => {
        if (prev && prev.id === fresh.id && prev.body !== fresh.body) {
          setEditorRev((r) => r + 1);
        }
        return fresh;
      });
      setError(null);
      // Tree/favorite are nice-to-have; errors here never block
      void ideasApi.getAncestors(objectId).then(setAncestors).catch(() => {});
      void ideasApi.getChildren(objectId).then(setChildren).catch(() => {});
      void ideasApi.listFavorites()
        .then((f) => setIsFav(f.some((x) => x.id === objectId)))
        .catch(() => {});
      void ideasApi.backmentions(objectId).then(setMentions).catch(() => setMentions([]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [objectId]);

  useEffect(() => { void load(); }, [load]);

  // Important: measure our OWN space, not the window. Using
  // `window.innerWidth < 700` breaks in the side peek: the window is 1600 px
  // wide but the space is 400, so the detail assumed desktop width and
  // squeezed title and editor down to one letter per line.
  // A component that measures its width from the window is wrong in every
  // sub-area; it has to ask its container.
  useEffect(() => {
    const el = wurzel;
    if (!el || typeof ResizeObserver === "undefined") {
      const check = () => setIsNarrow(window.innerWidth < 700);
      check();
      window.addEventListener("resize", check);
      return () => window.removeEventListener("resize", check);
    }
    const beob = new ResizeObserver(([e]) => setIsNarrow(e.contentRect.width < 700));
    beob.observe(el);
    return () => beob.disconnect();
  }, [wurzel]);

  // Bind window ↔ object (the inline Clara chat then runs per object)
  useEffect(() => {
    setCurrentObjectUri(windowId, buildObjectUri(appId, `object/${objectId}`));
    return () => setCurrentObjectUri(windowId, undefined);
  }, [windowId, objectId, appId, setCurrentObjectUri]);

  // Refetch on window focus (Clara may have written via tools)
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  /** References IN the text are clickable and open the object.
   *
   * Mentions get a color (`.kb-mention`) and a `data-object-id`; this handler
   * is what makes them actually navigate (the subpage creation below relies
   * on it: "to fill the page, click the reference").
   *
   * Two forms are matched: the mention chip and the raw `#kb-<uuid>` link
   * (that is how the mention is stored in Markdown, and how it arrives from
   * Clara or a script before the editor has turned it into a chip).
   * Modifier clicks are left alone so selecting and deleting in the editor
   * still work. */
  const onVerweisKlick = useCallback((e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const ziel = (e.target as HTMLElement | null)?.closest?.(
      "[data-object-id], a[href^='#kb-']",
    ) as HTMLElement | null;
    if (!ziel) return;
    const id = ziel.getAttribute("data-object-id")
      ?? (ziel.getAttribute("href") ?? "").slice("#kb-".length);
    if (!/^[0-9a-f-]{36}$/i.test(id) || id === objectId) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenObject(id);
  }, [objectId, onOpenObject]);

  // Offer the editor's text selection as a comment anchor. The context before
  // and after makes a quote that occurs several times uniquely locatable.
  useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!text || text.length < 3) return;
      const inEditor = sel?.anchorNode?.parentElement?.closest("[data-claraos-editor]");
      if (!inEditor) return;
      const body = obj?.body ?? "";
      const pos = body.indexOf(text);
      setSelection({
        text: text.slice(0, 2000),
        prefix: pos > 0 ? body.slice(Math.max(0, pos - 40), pos) : "",
        suffix: pos >= 0 ? body.slice(pos + text.length, pos + text.length + 40) : "",
      });
    };
    document.addEventListener("mouseup", onSelect);
    return () => document.removeEventListener("mouseup", onSelect);
  }, [obj?.body]);

  const isOwner = obj?.owner === currentUser;
  /** Users who received the collection with write access may also edit the
   *  content; the server says so (`can_edit`). Trash, shares, visibility and
   *  versions remain with the owner. */
  const darfSchreiben = !!(obj?.can_edit ?? isOwner);
  // The side peek has as little space as a phone.
  const schmal = isNarrow || !!kompakt;

  const patch = useCallback(async (p: Parameters<typeof ideasApi.patchObject>[1]) => {
    if (!obj) return;
    setSaving(true);
    try {
      // PATCH response has no links/activity → merge, never replace
      const updated = await ideasApi.patchObject(obj.id, p);
      setObj((prev) => (prev ? { ...prev, ...updated, links: prev.links, activity: prev.activity } : prev));
      if (p.stage !== undefined) void load(); // reload to pick up the stage_change activity
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void load();
    } finally {
      setSaving(false);
    }
  }, [obj, load, onChanged]);

  /** Entries of the ⋯ menu. Order: harmless first, and at the very bottom
   *  what must not be hit by accident. */
  const mehrEintraege: ContextMenuItem[] = obj ? [
    { id: "versionen", label: "Versionen ansehen", icon: <Icon name="restore" size={14} />,
      onSelect: () => setShowHistory(true) },
    { id: "duplizieren", label: "Duplizieren", icon: "⧉", onSelect: async () => {
        const copy = await ideasApi.duplicateObject(obj.id);
        onChanged();
        onOpenObject(copy.id);
      } },
    ...(isOwner ? [{ id: "tr1", label: "---" }, {
      id: "shopping", label: "Shopping-Recherche starten", icon: "🛒",
      onSelect: async () => {
        // Create a basket with idea_ref → the shopping app shows a link back
        // to the idea; if one already exists, it is reused.
        try {
          const listed = await fetch("/api/claraos/shopping/carts", { credentials: "include" });
          const carts = listed.ok ? (await listed.json()).carts : [];
          let cart = carts.find((c: { idea_ref: string | null }) => c.idea_ref === obj.id);
          if (!cart) {
            const r = await fetch("/api/claraos/shopping/carts", {
              method: "POST", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: obj.title.slice(0, 60), idea_ref: obj.id }),
            });
            if (!r.ok) throw new Error(String(r.status));
            cart = await r.json();
          }
          sessionStorage.setItem("claraos.shopping.openCart", cart.id);
        } catch {
          // Basket creation failed → open the app anyway, where the error
          // is visible instead of silently swallowed here
          sessionStorage.removeItem("claraos.shopping.openCart");
        }
        const { useWindowsStore } = await import("@claraos/core");
        useWindowsStore.getState().openWindow("shopping", { title: "Shopping" });
      },
    } as ContextMenuItem] : []),
    ...(isOwner ? [{ id: "tr2", label: "---" }, {
      id: "papierkorb", label: "In den Papierkorb", icon: <Icon name="trash" size={14} />,
      variant: "destructive" as const,
      confirm: `„${obj.title}" in den Papierkorb legen?\n\n`
        + "Der Eintrag bleibt im Papierkorb und lässt sich dort zurückholen.",
      onSelect: async () => {
        await ideasApi.deleteObject(obj.id);
        onChanged();
        onBack();
      },
    } as ContextMenuItem] : []),
  ] : [];

  if (error) {
    return (
      <div className={styles.detail}>
        <button className={styles.btnSecondary} onClick={onBack}>← Zurück</button>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }
  if (!obj) return <div className={styles.detail}><div className={styles.empty}>Lade…</div></div>;

  return (
    <div className={`${styles.detail} ${isNarrow ? styles.detailSchmal : ""}`} ref={setWurzel}>
      <div className={styles.detailBar}>
        {/* The path replaces "← Back". The button only said THAT there was a
            previous place; the path also says WHERE you are, in the same
            space. In the side peek it is omitted; its header carries it. */}
        {!kompakt && (
          <nav className={`${leiste.pfad} ${isNarrow ? leiste.pfadEigeneZeile : ""}`}
               aria-label="Pfad">
            <button className={leiste.pfadTeil} onClick={onBack}
                    title={herkunft ? `Zurück zu „${herkunft.label}"` : "Zurück zur Übersicht"}>
              {herkunft?.icon ? `${herkunft.icon} ` : ""}{herkunft?.label ?? "Übersicht"}
            </button>
            {/* On phones only the origin: on a typical phone (~400 px) the full
                path collapsed to "📁 / …", and the title is right below as a heading anyway.
                A path you cannot read is worse than no path. */}
            {!isNarrow && (
              <>
                {ancestors.map((a) => (
                  <span key={a.id} style={{ display: "contents" }}>
                    <span className={leiste.pfadTrenner}>/</span>
                    <button className={leiste.pfadTeil} onClick={() => onOpenObject(a.id)}>
                      {a.icon ? `${a.icon} ` : ""}{a.title}
                    </button>
                  </span>
                ))}
                <span className={leiste.pfadTrenner}>/</span>
                <span className={leiste.pfadJetzt}>{obj.icon ? `${obj.icon} ` : ""}{obj.title}</span>
              </>
            )}
          </nav>
        )}
        <span className={styles.saveState}>{saving ? "Speichert…" : ""}</span>
        <button
          className={styles.iconBtn}
          title={isFav ? "Favorit entfernen" : "Als Favorit merken"}
          onClick={async () => {
            if (isFav) await ideasApi.removeFavorite(obj.id);
            else await ideasApi.addFavorite(obj.id);
            setIsFav(!isFav);
            onChanged();
          }}
        >
          {isFav ? "★" : "☆"}
        </button>
        <button
          className={styles.btnPrimary}
          title="Inline-Chat zu genau diesem Objekt öffnen"
          onClick={() => toggleClaraInline(windowId)}
        ><Icon name="comment" size={14} className={styles.inlineIcon} />Mit Clara entwickeln
        </button>
        {/* Versions, duplicate, shopping and especially trash live behind ⋯
            rather than as equal-ranked buttons, so delete is not one misclick
            away from the main action. */}
        <button className={styles.iconBtn} title="Mehr"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMehr(mehr ? null : { x: Math.max(8, r.right - 240), y: r.bottom + 4 });
                }}><Icon name="more" size={16} /></button>
        {mehr && (
          <PopupMenu
            x={mehr.x} y={mehr.y}
            onClose={() => setMehr(null)}
            items={mehrEintraege}
          />
        )}
      </div>

      <div className={styles.detailBody}>
        <main className={styles.detailMain}>
          <div className={styles.titleRow}>
            <button
              className={styles.iconPickBtn}
              title={obj.icon ? "Symbol ändern" : "Symbol hinzufügen"}
              onClick={() => darfSchreiben && setIconEdit((v) => !v)}
            >
              {obj.icon || <span className={styles.iconPickHint}>Symbol</span>}
            </button>
            {iconEdit && (
              <input
                className={styles.input}
                style={{ maxWidth: 90 }}
                autoFocus
                placeholder="Emoji"
                defaultValue={obj.icon ?? ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = (e.target as HTMLInputElement).value.trim();
                    void patch({ icon: v || null } as never);
                    setObj({ ...obj, icon: v || null } as never);
                    setIconEdit(false);
                  }
                  if (e.key === "Escape") setIconEdit(false);
                }}
              />
            )}
            <input
              className={styles.detailTitle}
              value={obj.title}
              readOnly={!darfSchreiben}
              onChange={(e) => setObj({ ...obj, title: e.target.value })}
              onBlur={(e) => {
                // Do NOT compare against obj.title: onChange has already
                // updated the state by blur time, so the comparison was always
                // equal and the title was never saved. The reference is the
                // last LOADED server state (savedTitle).
                const t = e.target.value.trim();
                if (darfSchreiben && t && t !== savedTitle.current) {
                  savedTitle.current = t;
                  void patch({ title: t });
                }
              }}
            />
          </div>

          {/* The collection's columns are shown HERE, directly below the title,
              as in Notion. Showing only the object type's prop_schema would
              hide exactly the fields a user just read when opening a table
              row. */}
          <SammlungsFelder
            sammlungen={obj.collections ?? []}
            werte={obj.properties ?? {}}
            readOnly={!darfSchreiben}
            onSpeichern={(key, wert) => {
              const props = { ...(obj.properties ?? {}) };
              if (wert === null) delete props[key];
              else props[key] = wert;
              setObj({ ...obj, properties: props });
              void patch({ properties: props });
            }}
          />

          <Suspense fallback={<div className={styles.empty}>Editor lädt…</div>}>
            {/* onClickCapture: runs before ProseMirror, otherwise the editor only
                sets the cursor and the click is lost. */}
            <div onClickCapture={onVerweisKlick}>
            <IdeaEditor
              key={`${obj.id}:${editorRev}`}
              initialMarkdown={obj.body}
              readOnly={!darfSchreiben}
              objectId={obj.id}
              mobile={isNarrow && !kompakt}
              onNeueUnterseite={isOwner ? async () => {
                const sub = await ideasApi.createObject({
                  type: "note", title: "Neue Unterseite",
                  visibility: obj.visibility === "shared" ? "private" : obj.visibility,
                  parent_id: obj.id,
                } as never);
                // Do not navigate there: the reference is created mid-sentence.
                // To fill the page, click the reference.
                void ideasApi.getChildren(obj.id).then(setChildren).catch(() => {});
                onChanged();
                return { id: sub.id, title: sub.title };
              } : undefined}
              onChangeMarkdown={(md) => { if (md !== obj.body) void patch({ body: md }); }}
            />
            </div>
          </Suspense>

          {/* Unlinked mentions: objects that name this title in their text
              without linking to it (SiYuan pattern) */}
          {mentions.length > 0 && (
            <section className={styles.subpages}>
              <h4>Unverlinkte Erwähnungen</h4>
              <ul className={styles.subpageList}>
                {mentions.slice(0, 8).map((m) => (
                  <li key={m.id}>
                    <button className={styles.subpageItem} onClick={() => onOpenObject(m.id)}>
                      {m.icon || "📄"} {m.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Subpages (page tree) */}
          <section className={styles.subpages}>
            {children.length > 0 && <h4>Unterseiten</h4>}
            <ul className={styles.subpageList}>
              {children.map((c) => (
                <li key={c.id}>
                  <button className={styles.subpageItem} onClick={() => onOpenObject(c.id)}>
                    {c.icon || "📄"} {c.title}
                  </button>
                </li>
              ))}
            </ul>
            {isOwner && (
              <button
                className={styles.btnSecondary}
                title="Neue Unterseite anlegen"
                onClick={async () => {
                  const sub = await ideasApi.createObject({
                    type: "note", title: "Neue Unterseite",
                    visibility: obj.visibility === "shared" ? "private" : obj.visibility,
                    parent_id: obj.id,
                  } as never);
                  onChanged();
                  onOpenObject(sub.id);
                }}
              >
                ＋ Unterseite
              </button>
            )}
          </section>

          <CommentsPanel
            objectId={obj.id}
            currentUser={currentUser}
            isOwner={!!isOwner}
            selection={selection}
            onClearSelection={() => setSelection(null)}
          />

          <ClaraSection
            activity={obj.activity}
            onAnswer={async (q, answer) => {
              await ideasApi.addActivity(obj.id, `> ${q.content}\n\n${answer}`, "answer");
              void load();
            }}
          />

          <section className={styles.activity}>
            <h4>Verlauf</h4>
            {obj.activity.length === 0 && <p className={styles.metaHint}>Noch nichts passiert.</p>}
            <ul className={styles.activityList}>
              {obj.activity.map((a) => (
                <li key={a.id} className={a.actor === "clara" ? styles.activityClara : ""}>
                  <span className={styles.activityHead}>
                    {a.actor === "clara" ? "🤖 Clara" : a.actor} · {KIND_LABEL[a.kind] ?? a.kind} ·{" "}
                    {new Date(a.created_at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                  {a.kind === "stage_change" ? (
                    <span className={styles.metaHint}>
                      {String(a.meta?.from_stage ?? "—")} → {String(a.meta?.to_stage ?? "—")}
                    </span>
                  ) : (
                    a.content && <div className={styles.activityContent}>{a.content}</div>
                  )}
                </li>
              ))}
            </ul>
            {/* No second input field: comments are written in the comment panel
                above; two competing fields stacked directly on top of each
                other were simply confusing on phones. */}
          </section>
        </main>

        {schmal && !showMeta ? (
          <button className={styles.metaOpenBtn} onClick={() => setShowMeta(true)}>
            ⚙ Eigenschaften, Zugriff &amp; Verknüpfungen
          </button>
        ) : null}
        <div className={schmal ? (showMeta ? styles.metaSheet : styles.metaHidden) : undefined}>
        {schmal && showMeta && (
          <div className={styles.metaSheetHead}>
            <b>Eigenschaften</b>
            <button className={styles.iconBtn} onClick={() => setShowMeta(false)} title="Schließen"><Icon name="close" size={14} title="Schließen" /></button>
          </div>
        )}
        <MetaSidebar
          breit={schmal}
          object={obj}
          isOwner={!!isOwner}
          canEdit={darfSchreiben}
          propSchema={types.find((t) => t.id === obj.type)?.prop_schema ?? []}
          onSaveProp={(key, value) => {
            const props = { ...(obj.properties ?? {}) };
            if (value === null) delete props[key];
            else props[key] = value;
            void patch({ properties: props });
          }}
          linkCandidates={linkCandidates}
          onSetStage={(s: Stage) => void patch({ stage: s })}
          onSetVisibility={(v: Visibility) => void patch({ visibility: v })}
          onAddShare={async (u) => {
            try {
              await ideasApi.addShare(obj.id, u);
              void load();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          onRemoveShare={async (u) => { await ideasApi.removeShare(obj.id, u); void load(); }}
          onLink={async (toId, rel) => { await ideasApi.createLink(obj.id, toId, rel); void load(); }}
          onUnlink={async (linkId) => { await ideasApi.deleteLink(linkId); void load(); }}
          onOpenObject={onOpenObject}
        />
        </div>
      </div>

      {showHistory && (
        <HistoryPanel
          objectId={obj.id}
          isOwner={!!isOwner}
          onRestored={() => { void load(); onChanged(); }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
