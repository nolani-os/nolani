/** "Wissen" (Knowledge) — the knowledge suite and the idea/strategy suite in ONE app.
 *
 * Why merged: for the user they were never two programs. Both read the same
 * tables through the same backend (`/api/claraos/knowledge`) and shared the
 * stylesheet, detail view, quick capture and half the component list — only
 * the tiles and a type filter were separate. Writing a note about a goal
 * required switching windows.
 *
 * **NO data moves.** Goals, visions, metrics, metric sources and adapters live
 * on the server and stay untouched; this file is pure UI. Clara's tools are
 * not affected either — they talk to the backend, not to this app.
 *
 * **Both IDs stay valid.** `?app=knowledge` starts in the Knowledge section,
 * `?app=ideas` in the Strategy section; both `actionBus` channels and both
 * `iframeNavigator` paths remain registered. Old links from ntfy
 * notifications, Clara answers and bookmarks therefore still work.
 *
 * Layout: one sidebar with TWO labeled groups (Knowledge · Strategy) instead
 * of two windows. Mobile: tab bar with the four most common targets of the
 * active section + "More".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore, useWindowsStore, getBrand } from "@claraos/core";
import styles from "../ideas/IdeasApp.module.css";
import leiste from "./Wissen.module.css";
import { Icon, iconFuerEmoji, type IconName } from "../../components/Icon";
import { Werkzeugleiste } from "../../components/Werkzeugleiste";
import { ideasApi } from "../ideas/api";
import { formatZeitpunkt } from "../ideas/format";
import type {
  KbCollection, KbNotification, KbObjectSlim, KbType, Stage,
} from "../ideas/types";
import { CollectionView } from "../ideas/views/CollectionView";
import { VorlagenModal } from "./VorlagenModal";
import { StartSeite } from "./StartSeite";
import { IdeaDetail } from "../ideas/IdeaDetail";
import { QuickCapture } from "../ideas/QuickCapture";
import { QuickSwitcher } from "../ideas/QuickSwitcher";
import { ClipModal } from "../ideas/ClipModal";
import { useColorMode } from "../ideas/useColorMode";
import { KnowledgeList } from "../knowledge/views/KnowledgeList";
import { SearchView } from "../knowledge/views/SearchView";
import { KnowledgeGraph } from "../knowledge/views/KnowledgeGraph";
import { BoardView } from "../ideas/views/BoardView";
import { ListView } from "../ideas/views/ListView";
import { VisionsView } from "../ideas/views/VisionsView";
import { GoalsView } from "../ideas/views/GoalsView";
import { DashboardView } from "../ideas/views/DashboardView";
import { MatrixView } from "../ideas/views/MatrixView";
import { GraphView } from "../ideas/views/GraphView";
import { registerActionHandler } from "../../Chat/actionBus";
import { registerIframeNavigator } from "../iframeNavigator";

export type Bereich = "wissen" | "strategie";

type Rail =
  // Knowledge section
  | "collections" | "objects" | "notes" | "search" | "graph" | "inbox" | "trash"
  // Strategy section
  | "dash" | "board" | "list" | "goals" | "matrix" | "visions" | "ideagraph";

interface RailItem {
  key: Rail;
  icon: IconName;
  label: string;
  bereich: Bereich;
}

const RAIL_ITEMS: RailItem[] = [
  { key: "collections", icon: "collections", label: "Sammlungen", bereich: "wissen" },
  { key: "objects", icon: "list", label: "Alle", bereich: "wissen" },
  { key: "notes", icon: "note", label: "Notizen", bereich: "wissen" },
  { key: "search", icon: "search", label: "Suche", bereich: "wissen" },
  { key: "graph", icon: "graph", label: "Netz", bereich: "wissen" },
  { key: "inbox", icon: "bell", label: "Neues", bereich: "wissen" },
  { key: "trash", icon: "trash", label: "Papierkorb", bereich: "wissen" },
  { key: "dash", icon: "dashboard", label: "Übersicht", bereich: "strategie" },
  { key: "goals", icon: "target", label: "Ziele", bereich: "strategie" },
  { key: "visions", icon: "horizon", label: "Visionen", bereich: "strategie" },
  { key: "board", icon: "board", label: "Ideen-Board", bereich: "strategie" },
  { key: "list", icon: "list", label: "Ideen-Liste", bereich: "strategie" },
  { key: "matrix", icon: "matrix", label: "Matrix", bereich: "strategie" },
  { key: "ideagraph", icon: "graph", label: "Ideen-Netz", bereich: "strategie" },
];

/** On mobile only the four most used targets per section — the rest in the "More" sheet.
 * (Seven tabs on a phone would give ~59 px per tab with truncated names.) */
const MOBILE_TABS: Record<Bereich, Rail[]> = {
  wissen: ["collections", "objects", "notes", "search"],
  strategie: ["dash", "goals", "board", "visions"],
};

const START_RAIL: Record<Bereich, Rail> = {
  wissen: "collections",
  strategie: "dash",
};

/** Object kinds of the strategy layer — excluded in the Knowledge section.
 * Must match the server list IDEA_SUITE_TYPES in routers/knowledge.py. */
const PIPELINE_TYPES = new Set(["idea", "vision", "goal", "kpi", "concept", "analysis"]);

function ObjektSymbol({ icon, ersatz = "document", size = 16 }: {
  icon?: string | null; ersatz?: IconName; size?: number;
}) {
  const name = iconFuerEmoji(icon) ?? (icon ? null : ersatz);
  if (name) return <Icon name={name} size={size} className={styles.inlineIcon} />;
  return <span className={styles.inlineIcon}>{icon}</span>;
}

export default function WissenApp({ windowId, start = "wissen" }: {
  windowId: string;
  /** What the app opens with — depending on which tile launched it. */
  start?: Bereich;
}) {
  const [rail, setRail] = useState<Rail>(START_RAIL[start]);
  const [objects, setObjects] = useState<KbObjectSlim[]>([]);
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [types, setTypes] = useState<KbType[]>([]);
  const [favorites, setFavorites] = useState<KbObjectSlim[]>([]);
  const [trash, setTrash] = useState<(KbObjectSlim & { deleted_at: string | null })[]>([]);
  const [notifications, setNotifications] = useState<KbNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showClip, setShowClip] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [showCollModal, setShowCollModal] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Did the entry come from a collection table? Then it opens in the side
  // panel NEXT TO the table instead of replacing it.
  const [ausTabelle, setAusTabelle] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const colorMode = useColorMode(rootRef);
  const user = useAuthStore((s) => s.user);
  const currentUser = user?.username ?? "";

  const bereich: Bereich =
    RAIL_ITEMS.find((it) => it.key === rail)?.bereich ?? "wissen";

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  /** Open an entry as a full page (from lists, search, graph, trash …). */
  const oeffneObjekt = useCallback((id: string) => {
    setAusTabelle(false);
    setDetailId(id);
  }, []);

  // Mobile = narrow window (the shell renders fullscreen in MobileShell).
  // Container queries cannot style the container itself, hence JS.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setIsMobile(el.clientWidth > 0 && el.clientWidth < 700));
    ro.observe(el);
    setIsMobile(el.clientWidth > 0 && el.clientWidth < 700);
    return () => ro.disconnect();
  }, []);

  // Return from the shopping app (cart → "To the idea")
  useEffect(() => {
    const wanted = sessionStorage.getItem("claraos.ideas.openObject");
    if (wanted) {
      sessionStorage.removeItem("claraos.ideas.openObject");
      setDetailId(wanted);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [objs, colls, tps, favs] = await Promise.all([
          ideasApi.listObjects({ limit: 200 }),
          ideasApi.listCollections().catch(() => []),
          ideasApi.listTypes().catch(() => []),
          ideasApi.listFavorites().catch(() => []),
        ]);
        if (!cancelled) {
          setObjects(objs);
          setCollections(colls);
          setTypes(tps);
          setFavorites(favs);
          setError(null);
        }
        void ideasApi.listNotifications(true)
          .then((n) => { if (!cancelled) setUnread(n.length); })
          .catch(() => undefined);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  // ── Deep links ────────────────────────────────────────────────────────────
  // Both channels stay registered so no existing link leads nowhere — neither
  // from Clara nor from an ntfy notification.
  useEffect(() => {
    const behandle = (action: string, args: Record<string, unknown>) => {
      if (action === "open_object" && typeof args?.object_id === "string") {
        setDetailId(args.object_id);
      } else if (action === "open_collection" && typeof args?.collection_id === "string") {
        // "X shared the collection with you" → open it directly.
        setDetailId(null);
        setActiveCollection(args.collection_id);
      } else if (action === "open_kpi" && typeof args?.kpi_id === "string") {
        setDetailId(args.kpi_id);
      } else if (action === "open_dashboard") {
        setDetailId(null);
        setRail("dash");
      } else if (action === "capture") {
        setShowCapture(true);
      } else if (action === "clip") {
        setShowClip(true);
      }
    };
    const ab = registerActionHandler("knowledge", behandle);
    const ab2 = registerActionHandler("ideas", behandle);
    return () => { ab(); ab2(); };
  }, []);

  useEffect(() => {
    const gehe = (path: string) => {
      const mObj = path.match(/^\/object\/([0-9a-f-]{36})/i);
      const mColl = path.match(/^\/collection\/([0-9a-f-]{36})/i);
      if (mObj) {
        setDetailId(mObj[1]);
        return;
      }
      if (mColl) {
        setDetailId(null);
        setActiveCollection(mColl[1]);
        return;
      }
      const erstes = path.slice(1).split("/")[0];
      const ziel: Record<string, Rail> = {
        collections: "collections", list: "list", notes: "notes",
        search: "search", board: "board", visions: "visions", graph: "graph",
        goals: "goals", matrix: "matrix", dash: "dash",
      };
      if (ziel[erstes]) {
        setDetailId(null);
        setActiveCollection(null);
        setRail(ziel[erstes]);
      }
    };
    const n1 = registerIframeNavigator("knowledge", gehe);
    const n2 = registerIframeNavigator("ideas", gehe);
    return () => { n1(); n2(); };
  }, []);

  // Ctrl/Cmd+K = quick switcher — only in the focused window
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      if (useWindowsStore.getState().focusedWindowId !== windowId) return;
      e.preventDefault();
      setShowSwitcher(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [windowId]);

  // N = new capture. What gets created depends on the section: a note in
  // Knowledge, an idea in Strategy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useWindowsStore.getState().focusedWindowId !== windowId) return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      if (document.activeElement?.closest("[data-claraos-editor]")) return;
      setShowCapture(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [windowId]);

  const capture = useCallback(async (title: string, note: string) => {
    const alsIdee = bereich === "strategie";
    const obj = await ideasApi.createObject(alsIdee
      ? { type: "idea", title, body: note ? `${note}\n` : "", stage: "spark" }
      : { type: "note", title, body: note ? `${note}\n` : "" });
    setObjects((prev) => [
      { ...obj, body_preview: note.slice(0, 280) } as unknown as KbObjectSlim,
      ...prev,
    ]);
  }, [bereich]);

  const moveStage = useCallback(async (id: string, stage: Stage) => {
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, stage } : o)));
    try {
      await ideasApi.patchObject(id, { stage });
    } catch {
      reload();
    }
  }, [reload]);

  const openTab = useCallback((key: Rail) => {
    setDetailId(null);
    setActiveCollection(null);
    setRail(key);
    if (key === "trash") {
      void ideasApi.listTrash().then(setTrash).catch(() => setTrash([]));
    }
    if (key === "inbox") {
      void ideasApi.listNotifications().then((n) => {
        setNotifications(n);
        void ideasApi.markNotificationsRead().then(() => setUnread(0)).catch(() => undefined);
      }).catch(() => setNotifications([]));
    }
  }, []);

  // Knowledge view: everything except the strategy layer
  const kbObjects = useMemo(
    () => objects.filter((o) => !PIPELINE_TYPES.has(o.type)), [objects]);
  const kTypes = useMemo(
    () => types.filter((t) => !PIPELINE_TYPES.has(t.id)), [types]);
  const ideas = useMemo(() => objects.filter((o) => o.type === "idea"), [objects]);
  const pipelineObjects = useMemo(
    () => objects.filter((o) => o.type === "idea" || o.type === "vision"), [objects]);
  const activeColl = activeCollection
    ? collections.find((c) => c.id === activeCollection) ?? null
    : null;

  // Side panel only if a collection is open, the entry came from its table
  // and the screen is wide enough.
  const seitenfenster = !!detailId && !!activeColl && ausTabelle && !isMobile;
  // First breadcrumb in the path — the collection, otherwise the sidebar section.
  const herkunft = activeColl
    ? { label: activeColl.name, icon: activeColl.icon }
    : { label: RAIL_ITEMS.find((it) => it.key === rail)?.label ?? "Übersicht" };

  // ── Content ───────────────────────────────────────────────────────────────
  const content = loading ? (
    <div className={styles.empty}>Lade…</div>
  ) : detailId && !seitenfenster ? (
    <IdeaDetail
      objectId={detailId}
      windowId={windowId}
      appId={bereich === "strategie" ? "ideas" : "knowledge"}
      currentUser={currentUser}
      linkCandidates={objects}
      types={types}
      herkunft={herkunft}
      onBack={() => { setDetailId(null); reload(); }}
      onOpenObject={setDetailId}
      onChanged={reload}
    />
  ) : activeColl ? (
    <>
      {/* The back link is not a separate row above the title (that cost 40 px
          of 900). It sits IN the title row (CollectionView). */}
      {/* Clicking a row opens a side panel next to the table instead of
          replacing the WHOLE view — otherwise table, grouping and scroll
          position would be lost, and comparing three entries would start
          over every time. On phones there is no room for that — there the
          full switch remains. */}
      {/* Without a side panel the wrappers pass the height through so the
          table has its own scroll area (both scrollbars in view). */}
      <div className={seitenfenster ? leiste.mitSeitenfenster : leiste.sammlungVoll}>
        <div className={seitenfenster ? leiste.mitSeitenfensterLinks : leiste.sammlungVoll}>
          <CollectionView collection={activeColl} types={kTypes} currentUser={currentUser}
                          mobile={isMobile}
                          onOpen={(id) => { setAusTabelle(true); setDetailId(id); }}
                          onBack={() => setActiveCollection(null)}
                          onChanged={reload}
                          onDeleted={() => { setActiveCollection(null); reload(); }} />
        </div>
        {seitenfenster && detailId && (
          <aside className={leiste.seitenfenster}>
            <div className={leiste.seitenfensterKopf}>
              <span>{activeColl.icon ?? "🗂️"} {activeColl.name}</span>
              <button className={styles.iconBtn} title="Als ganze Seite öffnen"
                      onClick={() => setAusTabelle(false)}>⤢</button>
              <button className={styles.iconBtn} title="Seitenfenster schließen"
                      onClick={() => { setDetailId(null); reload(); }}>
                <Icon name="close" size={14} title="Schließen" />
              </button>
            </div>
            <IdeaDetail
              key={detailId}
              objectId={detailId}
              windowId={windowId}
              appId={bereich === "strategie" ? "ideas" : "knowledge"}
              currentUser={currentUser}
              linkCandidates={objects}
              types={types}
              kompakt
              onBack={() => { setDetailId(null); reload(); }}
              onOpenObject={setDetailId}
              onChanged={reload}
            />
          </aside>
        )}
      </div>
    </>
  ) : rail === "objects" ? (
    <KnowledgeList objects={kbObjects} types={kTypes} currentUser={currentUser} onOpen={oeffneObjekt} />
  ) : rail === "notes" ? (
    <KnowledgeList objects={kbObjects.filter((o) => o.type === "note")} types={kTypes}
                   currentUser={currentUser} fixedType onOpen={oeffneObjekt} />
  ) : rail === "search" ? (
    <SearchView onOpen={oeffneObjekt} />
  ) : rail === "graph" ? (
    <KnowledgeGraph onOpen={oeffneObjekt} />
  ) : rail === "dash" ? (
    <DashboardView onOpen={oeffneObjekt} reloadTick={reloadTick} />
  ) : rail === "board" ? (
    <BoardView ideas={ideas} currentUser={currentUser}
               onOpen={oeffneObjekt} onMove={moveStage} />
  ) : rail === "list" ? (
    <ListView ideas={pipelineObjects} currentUser={currentUser} onOpen={oeffneObjekt} />
  ) : rail === "goals" ? (
    <GoalsView currentUser={currentUser} onOpen={oeffneObjekt}
               onChanged={reload} reloadTick={reloadTick} />
  ) : rail === "matrix" ? (
    <MatrixView currentUser={currentUser} onOpen={oeffneObjekt} reloadTick={reloadTick} />
  ) : rail === "visions" ? (
    <VisionsView objects={objects} currentUser={currentUser}
                 onOpen={oeffneObjekt} onChanged={reload} />
  ) : rail === "ideagraph" ? (
    <GraphView onOpen={oeffneObjekt} />
  ) : rail === "inbox" ? (
    <div className={styles.listView}>
      <h3><Icon name="bell" size={17} className={styles.inlineIcon} />Neues</h3>
      {notifications.length === 0 && <div className={styles.empty}>Nichts Neues.</div>}
      <div className={styles.listRows}>
        {notifications.map((n) => (
          <button key={n.id}
                  className={`${styles.notifRow} ${n.read ? "" : styles.notifUnread}`}
                  onClick={() => { if (n.object_id) setDetailId(n.object_id); }}>
            <span className={styles.listTitle}>
              <Icon name="comment" size={14} className={styles.inlineIcon} />{n.actor} · {n.object_title ?? "Objekt"}
            </span>
            <span className={styles.listMeta}>{n.snippet.slice(0, 60)}</span>
            <span className={styles.listMeta}>{formatZeitpunkt(n.created_at)}</span>
          </button>
        ))}
      </div>
    </div>
  ) : rail === "trash" ? (
    <div className={styles.listView}>
      <h3><Icon name="trash" size={17} className={styles.inlineIcon} />Papierkorb</h3>
      {trash.length === 0 && <div className={styles.empty}>Der Papierkorb ist leer.</div>}
      <div className={styles.listRows}>
        {trash.map((t) => (
          <div key={t.id} className={styles.trashRow}>
            <span className={styles.trashTitle}>
              <ObjektSymbol icon={t.icon} size={14} />{t.title}
            </span>
            <span className={styles.listMeta}>
              {t.deleted_at ? formatZeitpunkt(t.deleted_at) : ""}
            </span>
            <button className={styles.btnSecondary}
                    onClick={async () => {
                      await ideasApi.restoreObject(t.id);
                      setTrash((prev) => prev.filter((x) => x.id !== t.id));
                      reload();
                    }}>
              Wiederherstellen
            </button>
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div className={styles.collPage}>
      {/* Content first, then the filing system. The blocks hide themselves
          as long as there is nothing to show. */}
      {collections.length > 0 && (
        <StartSeite
          objekte={kbObjects}
          sammlungen={collections}
          favoriten={favorites}
          onOpen={oeffneObjekt}
          onClara={() => useWindowsStore.getState().toggleClaraInline(windowId)}
        />
      )}
      <h3><Icon name="collections" size={17} className={styles.inlineIcon} />Sammlungen</h3>
      {collections.length === 0 && (
        /* An empty state without a next step is a dead end. */
        <div className={styles.empty}>
          <p>Hier landet, was ihr nachschlagen wollt — Rezepte, Vertraege, Geschenkideen.</p>
          <button className={styles.btnPrimary} onClick={() => setShowCollModal(true)}>
            Mit einer Vorlage anfangen
          </button>
          {/* This is exactly where someone with nothing yet stands — and for
              them "just say it" is the shortest path. */}
          <button className={styles.btnSecondary}
                  onClick={() => useWindowsStore.getState().toggleClaraInline(windowId)}>
            <Icon name="comment" size={14} className={styles.inlineIcon} />{getBrand().assistant} machen lassen
          </button>
        </div>
      )}
      <div className={styles.collCards}>
        {collections.map((c) => (
          <button key={c.id} className={styles.collCard} onClick={() => setActiveCollection(c.id)}>
            <span className={styles.collCardIcon}><ObjektSymbol icon={c.icon} ersatz="collections" size={20} /></span>
            <span className={styles.collCardName}>{c.name}</span>
            <span className={styles.collCardMeta}>
              {c.item_count ?? 0} Einträge{c.visibility === "family"
                ? <> · <Icon name="people" size={12} /></> : null}
              {c.permission && c.permission !== "owner"
                ? <> · <Icon name="people" size={12} /> von {c.owner}</> : null}
            </span>
          </button>
        ))}
        <button className={`${styles.collCard} ${styles.collCardNew}`} onClick={() => setShowCollModal(true)}>
          <span className={styles.collCardIcon}><Icon name="plus" size={22} /></span>
          <span className={styles.collCardName}>Neue Sammlung</span>
        </button>
      </div>
    </div>
  );

  const railGruppe = (g: Bereich, titel: string) => (
    <>
      <div className={leiste.railGroupLabel}>{titel}</div>
      {RAIL_ITEMS.filter((it) => it.bereich === g).map((it) => (
        <button
          key={it.key}
          className={`${leiste.railBtn} ${rail === it.key && !detailId && !activeCollection ? leiste.railBtnActive : ""}`}
          title={it.label}
          onClick={() => openTab(it.key)}
        >
          <span className={leiste.railIcon}>
            <Icon name={it.icon} size={20} />
            {it.key === "inbox" && unread > 0 ? ` (${unread})` : ""}
          </span>
          <span className={leiste.railLabel}>{it.label}</span>
        </button>
      ))}
    </>
  );

  const mobileTabs = MOBILE_TABS[bereich];

  return (
    <div ref={rootRef} data-color-mode={colorMode}
         className={`${styles.app} ${isMobile ? styles.mobile : ""}`}>
      <div className={styles.layout}>
        {!isMobile && (
          <nav className={leiste.rail}>
            <div className={leiste.railScroll}>
              {railGruppe("wissen", "Wissen")}
              {railGruppe("strategie", "Strategie")}

              {favorites.length > 0 && (
                <>
                  <div className={leiste.railGroupLabel}>Favoriten</div>
                  {favorites.slice(0, 4).map((f) => (
                    <button
                      key={f.id}
                      className={leiste.railBtn}
                      title={f.title}
                      onClick={() => { setActiveCollection(null); setDetailId(f.id); }}
                    >
                      <span className={leiste.railIcon}><ObjektSymbol icon={f.icon} ersatz="star" size={17} /></span>
                      <span className={leiste.railLabel}>{f.title}</span>
                    </button>
                  ))}
                </>
              )}

              {collections.length > 0 && (
                <>
                  <div className={leiste.railGroupLabel}>Sammlungen</div>
                  {collections.map((c) => (
                    <button
                      key={c.id}
                      className={`${leiste.railBtn} ${activeCollection === c.id && !detailId ? leiste.railBtnActive : ""}`}
                      title={c.name}
                      onClick={() => { setDetailId(null); setActiveCollection(c.id); }}
                    >
                      <span className={leiste.railIcon}><ObjektSymbol icon={c.icon} ersatz="collections" size={17} /></span>
                      <span className={leiste.railLabel}>{c.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            <div className={leiste.railSpacer} />
            <button className={leiste.railBtn} title="Webseite sichern (Web-Clipper)"
                    onClick={() => setShowClip(true)}>
              <span className={leiste.railIcon}><Icon name="globe" size={17} /></span>
              <span className={leiste.railLabel}>Clip</span>
            </button>
            <label className={leiste.railBtn} title="Notion- oder Markdown-ZIP importieren">
              <span className={leiste.railIcon}><Icon name="import" size={17} /></span>
              <span className={leiste.railLabel}>Import</span>
              <input
                type="file"
                accept=".zip"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setError(null);
                  try {
                    const rep = await ideasApi.importArchive(f);
                    window.alert(
                      `Import fertig:\n${rep.pages} Seite(n), ${rep.collections} Sammlung(en) ` +
                      `mit ${rep.rows} Zeile(n).\n${rep.links_rewritten} Verweis(e) verknüpft.`);
                    reload();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
            </label>
            <a className={leiste.railBtn} href={ideasApi.exportUrl()}
               title="Alles als ZIP exportieren (Markdown + CSV)" download>
              <span className={leiste.railIcon}><Icon name="export" size={17} /></span>
              <span className={leiste.railLabel}>Export</span>
            </a>
            <button
              className={`${leiste.railBtn} ${leiste.railCapture}`}
              title={bereich === "strategie" ? "Neue Idee (N)" : "Neue Notiz (N)"}
              onClick={() => setShowCapture(true)}
            >
              <span className={leiste.railIcon}><Icon name="plus" size={20} /></span>
              <span className={leiste.railLabel}>{bereich === "strategie" ? "Idee" : "Notiz"}</span>
            </button>
          </nav>
        )}

        <div className={styles.content}>
          {error && (
            <div className={styles.error}>
              <span>{error}</span>
              <button className={styles.btnSecondary}
                      onClick={() => { setError(null); reload(); }}>
                Nochmal versuchen
              </button>
            </div>
          )}
          {content}
        </div>
      </div>

      {isMobile && !detailId && (
        /* Shared floating toolbar (like the Planner) instead of a separate
           tab bar; "New" is the FAB, "More" opens the sheet. */
        <Werkzeugleiste
          eintraege={[
            ...RAIL_ITEMS.filter((it) => mobileTabs.includes(it.key)).map((it) => ({
              key: it.key,
              label: it.label,
              icon: it.icon,
              active: rail === it.key && !activeCollection,
              onClick: () => openTab(it.key),
            })),
            {
              key: "mehr",
              label: "Mehr",
              icon: "more" as const,
              active: !mobileTabs.includes(rail),
              badge: unread,
              onClick: () => setShowMore(true),
            },
          ]}
          fab={{
            label: bereich === "wissen" ? "Neue Notiz" : "Neue Idee",
            onClick: () => setShowCapture(true),
          }}
        />
      )}

      {showCapture && (
        <QuickCapture
          heading={bereich === "strategie" ? "💡 Neue Idee" : "Neue Notiz"}
          submitLabel={bereich === "strategie" ? "Als Funke speichern" : "Speichern"}
          onCapture={capture}
          onClose={() => { setShowCapture(false); reload(); }}
        />
      )}
      {showCollModal && (
        <VorlagenModal
          types={kTypes}
          onDone={reload}
          onOpenCollection={(id) => { setDetailId(null); setActiveCollection(id); }}
          onClose={() => setShowCollModal(false)}
        />
      )}
      {showMore && (
        <div className={styles.modalBackdrop} onClick={() => setShowMore(false)}>
          <div className={`${styles.modal} ${styles.moreSheet}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3>Mehr</h3>
              <button className={styles.iconBtn} onClick={() => setShowMore(false)} title="Schließen">
                <Icon name="close" size={18} title="Schließen" />
              </button>
            </div>
            <div className={styles.moreGrid}>
              {RAIL_ITEMS.filter((it) => !mobileTabs.includes(it.key)).map((it) => (
                <button key={it.key} className={styles.moreItem}
                        onClick={() => { setShowMore(false); openTab(it.key); }}>
                  <span className={styles.moreIcon}><Icon name={it.icon} size={18} /></span>
                  <span>{it.label}</span>
                  {it.key === "inbox" && unread > 0 && <span className={styles.moreBadge}>{unread}</span>}
                </button>
              ))}
              <button className={styles.moreItem}
                      onClick={() => { setShowMore(false); setShowClip(true); }}>
                <span className={styles.moreIcon}><Icon name="globe" size={18} /></span><span>Webseite sichern</span>
              </button>
              <button className={styles.moreItem}
                      onClick={() => { setShowMore(false); setShowCollModal(true); }}>
                <span className={styles.moreIcon}><Icon name="collections" size={18} /></span><span>Neue Sammlung</span>
              </button>
              <label className={styles.moreItem}>
                <span className={styles.moreIcon}><Icon name="import" size={18} /></span><span>Import (ZIP)</span>
                <input type="file" accept=".zip" style={{ display: "none" }}
                       onChange={async (e) => {
                         const f = e.target.files?.[0];
                         e.target.value = "";
                         if (!f) return;
                         setShowMore(false);
                         try {
                           const rep = await ideasApi.importArchive(f);
                           window.alert(`Import fertig: ${rep.pages} Seite(n), ${rep.collections} Sammlung(en).`);
                           reload();
                         } catch (err) {
                           setError(err instanceof Error ? err.message : String(err));
                         }
                       }} />
              </label>
              <a className={styles.moreItem} href={ideasApi.exportUrl()} download
                 onClick={() => setShowMore(false)}>
                <span className={styles.moreIcon}><Icon name="export" size={18} /></span><span>Export (ZIP)</span>
              </a>
            </div>
            {collections.length > 0 && (
              <>
                <h4 className={styles.moreSectionTitle}>
                  <Icon name="collections" size={15} className={styles.inlineIcon} />Sammlungen
                </h4>
                <div className={styles.listRows}>
                  {collections.slice(0, 10).map((c) => (
                    <button key={c.id} className={styles.listRow}
                            onClick={() => { setShowMore(false); setDetailId(null); setActiveCollection(c.id); }}>
                      <span className={styles.listTitle}><ObjektSymbol icon={c.icon} ersatz="collections" size={14} />{c.name}</span>
                      <span className={styles.listMeta}>{c.item_count ?? 0}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showClip && (
        <ClipModal
          onClipped={(id) => { setShowClip(false); reload(); setDetailId(id); }}
          onClose={() => setShowClip(false)}
        />
      )}
      {showSwitcher && (
        <QuickSwitcher
          local={objects}
          collections={collections}
          onOpenObject={(id) => { setActiveCollection(null); setDetailId(id); }}
          onOpenCollection={(id) => { setDetailId(null); setActiveCollection(id); }}
          onClose={() => setShowSwitcher(false)}
        />
      )}
    </div>
  );
}
