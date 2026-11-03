/**
 * Workspace overview — the zoomed-out view of the running windows plus the
 * desktops, in the shape each desktop family knows (layout.overviewStyle):
 *
 *   taskview  windows spread in the upper field, the desktops as a strip of
 *             thumbnails at the bottom with "new desktop" — Task View
 *   mission   a spaces bar across the top (names + thumbnails, "+" at the
 *             end), windows spread below, labels only on hover, minimized
 *             windows stay hidden — Mission Control
 *   overview  a search field that filters the windows, the desktop bar under
 *             it, windows below with captions and a close button — the
 *             Plasma overview
 *
 * The windows are not thumbnails: Window.tsx zooms the real elements to the
 * slots (overviewStore), so this component only draws the backdrop, the hit
 * layer with labels/close buttons on top of each window, and the desktops.
 * Rendered inside the desktop area, so slots share the windows' coordinates.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useWindowsStore, useWorkspaceStore, useAppRegistryStore, useTranslation, requestCloseWindow } from "@claraos/core";
import type { WindowInstance, Workspace } from "@claraos/core";
import { AppIcon } from "../components/AppIcon";
import { useSkinLayout } from "../useSkinLayout";
import { useOverviewStore, overviewActions, getOverviewState, type OverviewSlot } from "./overviewStore";
import { exposeLayout, type Box } from "./layout";
import styles from "./Overview.module.css";

const DRAG_MIME = "application/x-claraos-window";
const THUMB_W = 176;

function belongsTo(w: WindowInstance, wsId: string): boolean {
  return w.workspaceId === wsId || (!w.workspaceId && wsId === "ws-default");
}

export function Overview() {
  const open = useOverviewStore((s) => s.open);
  const showMinimized = useOverviewStore((s) => s.showMinimized);
  const slots = useOverviewStore((s) => s.slots);
  const filter = useOverviewStore((s) => s.filter);
  const { setSlots, setFilter, closeOverview } = overviewActions;

  const layout = useSkinLayout();
  const style = layout.overviewStyle;
  const { t } = useTranslation("shell");

  const windows = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const moveWindowToWorkspace = useWindowsStore((s) => s.moveWindowToWorkspace);
  // a window opened by deep link or shortcut carries no icon — the registry does
  const getApp = useAppRegistryStore((s) => s.getApp);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);

  const rootRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // The windows of the active desktop that take part, in stacking order
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return windowOrder
      .map((id) => windows[id])
      .filter((w): w is WindowInstance => !!w && !w.closing && belongsTo(w, activeId))
      .filter((w) => showMinimized || !w.minimized)
      .filter((w) => !q || w.title.toLowerCase().includes(q));
  }, [windows, windowOrder, activeId, showMinimized, filter]);
  const shownKey = shown.map((w) => w.id).join("|");

  // Field for the windows: everything except the strip/bar of the style
  const field = useCallback((w: number, h: number): Box => {
    if (style === "taskview") return { x: 24, y: 24, w: w - 48, h: h - 24 - 176 };
    if (style === "mission") return { x: 24, y: 128, w: w - 48, h: h - 128 - 24 };
    return { x: 24, y: 188, w: w - 48, h: h - 188 - 24 };
  }, [style]);

  // Measure the live window rects and lay them out. Runs after a frame so a
  // minimized window that just became visible has a box.
  const relayout = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const ar = root.getBoundingClientRect();
    setArea({ w: ar.width, h: ar.height });
    const boxes: Box[] = [];
    const ids: string[] = [];
    for (const w of shown) {
      const el = document.querySelector<HTMLElement>(`[data-window-id="${w.id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // undo a transform that is already applied (relayout while open)
      const prev = getOverviewState().slots[w.id];
      const s = prev?.scale ?? 1;
      const x = r.left - ar.left - (prev?.dx ?? 0);
      const y = r.top - ar.top - (prev?.dy ?? 0);
      boxes.push({ x, y, w: r.width / s, h: r.height / s });
      ids.push(w.id);
    }
    const placed = exposeLayout(boxes, field(ar.width, ar.height), 24, 1);
    const next: Record<string, OverviewSlot> = {};
    placed.forEach((p, i) => {
      const b = boxes[i];
      next[ids[i]] = { dx: p.x - b.x, dy: p.y - b.y, scale: p.scale, x: p.x, y: p.y, w: p.w, h: p.h };
    });
    setSlots(next);
  }, [shown, field]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(relayout);
    const onResize = () => relayout();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
    // shownKey: a window closed or moved away → spread the rest again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shownKey, style]);

  // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeOverview();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, closeOverview]);

  if (!open) return null;

  const pick = (id: string) => {
    focusWindow(id);
    closeOverview();
  };

  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(id);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };
  const acceptDrag = (e: DragEvent, target: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target) setDropTarget(target);
  };
  const dropOn = (e: DragEvent, wsId: string | "new") => {
    const id = e.dataTransfer.getData(DRAG_MIME);
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragging(null);
    if (!id) return;
    const target = wsId === "new" ? createWorkspaceKeepingActive() : wsId;
    moveWindowToWorkspace(id, target);
  };
  // createWorkspace switches to the new desktop; a drop should not
  const createWorkspaceKeepingActive = () => {
    const before = useWorkspaceStore.getState().activeId;
    const id = createWorkspace(t("taskbar.workspaces.defaultName", { n: workspaces.length + 1 }));
    setActive(before);
    return id;
  };

  const thumbH = area.w > 0 ? Math.round((THUMB_W * area.h) / area.w) : 99;
  const desktops = (
    <div className={styles.desktops} data-shell-part="overview-desktops">
      {workspaces.map((ws) => (
        <DesktopThumb
          key={ws.id}
          ws={ws}
          active={ws.id === activeId}
          dropHover={dropTarget === ws.id}
          thumbW={THUMB_W}
          thumbH={thumbH}
          area={area}
          windows={Object.values(windows).filter((w) => !w.closing && belongsTo(w, ws.id))}
          liveSlots={ws.id === activeId ? slots : undefined}
          canDelete={workspaces.length > 1}
          onPick={() => { setActive(ws.id); }}
          onDelete={() => deleteWorkspace(ws.id)}
          onDragOver={(e) => acceptDrag(e, ws.id)}
          onDragLeave={() => setDropTarget((d) => (d === ws.id ? null : d))}
          onDrop={(e) => dropOn(e, ws.id)}
          deleteTitle={t("taskbar.workspaces.delete")}
        />
      ))}
      <button
        className={`${styles.addDesk} ${dropTarget === "new" ? styles.dropHover : ""}`}
        style={{ width: THUMB_W, minHeight: thumbH }}
        onClick={() => createWorkspace(t("taskbar.workspaces.defaultName", { n: workspaces.length + 1 }))}
        onDragOver={(e) => acceptDrag(e, "new")}
        onDragLeave={() => setDropTarget((d) => (d === "new" ? null : d))}
        onDrop={(e) => dropOn(e, "new")}
        title={t("taskbar.workspaces.new")}
      >
        <span className={styles.addGlyph}>+</span>
        <span className={styles.addLabel}>{t("taskbar.workspaces.new")}</span>
      </button>
    </div>
  );

  return (
    <div ref={rootRef} className={styles.root} data-style={style} data-shell-part="overview">
      <div className={styles.backdrop} />
      <div className={styles.layer} onClick={closeOverview}>
        {style === "overview" && (
          <input
            className={styles.search}
            data-shell-part="overview-search"
            autoFocus
            value={filter}
            placeholder={t("overview.filter")}
            onChange={(e) => setFilter(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {style !== "taskview" && desktops}

        {shown.length === 0 && (
          <div className={styles.empty}>{t("overview.noWindows")}</div>
        )}
        {shown.map((w) => {
          const s = slots[w.id];
          if (!s) return null;
          return (
            <div
              key={w.id}
              className={`${styles.slot} ${w.minimized ? styles.slotMinimized : ""} ${dragging === w.id ? styles.slotDragging : ""}`}
              style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
              draggable
              onDragStart={(e) => onDragStart(e, w.id)}
              onDragEnd={onDragEnd}
              onClick={(e) => { e.stopPropagation(); pick(w.id); }}
              title={w.title}
              data-overview-window={w.id}
            >
              <div className={styles.label}>
                <AppIcon appId={w.appId} fallback={getApp(w.appId)?.icon || w.icon || "🔲"} size="taskbar" pixelSize={20} className={styles.labelIcon} />
                <span className={styles.labelText}>{w.title}</span>
              </div>
              {style !== "mission" && (
                <button
                  className={styles.close}
                  title={t("overview.close")}
                  onClick={(e) => { e.stopPropagation(); void requestCloseWindow(w.id); }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {style === "taskview" && desktops}
      </div>
    </div>
  );
}

interface ThumbProps {
  ws: Workspace;
  active: boolean;
  dropHover: boolean;
  thumbW: number;
  thumbH: number;
  area: { w: number; h: number };
  windows: WindowInstance[];
  liveSlots?: Record<string, OverviewSlot>;
  canDelete: boolean;
  deleteTitle: string;
  onPick: () => void;
  onDelete: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

/** A desktop's thumbnail: the wallpaper in miniature with the windows as
 *  small plates at their real positions (the active desktop at its normal
 *  arrangement, not the spread one). */
function DesktopThumb(p: ThumbProps) {
  const k = p.area.w > 0 ? p.thumbW / p.area.w : 0;
  return (
    <div
      className={`${styles.desk} ${p.active ? styles.deskActive : ""} ${p.dropHover ? styles.dropHover : ""}`}
      onClick={(e) => { e.stopPropagation(); p.onPick(); }}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && p.onPick()}
      data-overview-desktop={p.ws.id}
    >
      <div
        className={styles.mini}
        style={{
          width: p.thumbW,
          height: p.thumbH,
          backgroundImage: p.ws.wallpaper ? `url(${p.ws.wallpaper})` : undefined,
        }}
      >
        {k > 0 && p.windows.map((w) => {
          const live = p.liveSlots?.[w.id];
          const box = w.maximized
            ? { x: 0, y: 0, w: p.area.w, h: p.area.h }
            : live
              ? { x: live.x - live.dx, y: live.y - live.dy, w: live.w / live.scale, h: live.h / live.scale }
              : { x: w.x, y: w.y, w: w.width, h: w.height };
          if (w.minimized) return null;
          return (
            <span
              key={w.id}
              className={styles.miniWin}
              style={{ left: box.x * k, top: box.y * k, width: Math.max(4, box.w * k), height: Math.max(3, box.h * k) }}
            />
          );
        })}
      </div>
      <div className={styles.deskFooter}>
        <span className={styles.deskName}>{p.ws.name}</span>
        {p.canDelete && (
          <button
            className={styles.deskDelete}
            title={p.deleteTitle}
            onClick={(e) => { e.stopPropagation(); p.onDelete(); }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
