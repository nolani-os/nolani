import { Suspense, useCallback, useRef, useState } from "react";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useWorkspaceStore, useWindowsStore, useAppRegistryStore, useTranslation } from "@claraos/core";
import { widgetComponents, getWidgetManifest, WIDGET_OPEN_APP } from "../widgets/registry";
import styles from "./DesktopWidgets.module.css";

// Match DesktopIcons cell size so widgets and icons share the same grid
const CELL_W = 90;
const CELL_H = 90;

export function DesktopWidgets() {
  const { t } = useTranslation("desktop");
  const widgets = useWorkspaceStore((s) => s.getActive().widgets ?? []);
  const moveWidget = useWorkspaceStore((s) => s.moveWidget);
  const removeWidget = useWorkspaceStore((s) => s.removeWidget);
  const resizeWidget = useWorkspaceStore((s) => s.resizeWidget);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const getApp = useAppRegistryStore((s) => s.getApp);

  const [dragging, setDragging] = useState<string | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; col: number; row: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const openAppFor = useCallback(
    (type: string) => {
      const appId = WIDGET_OPEN_APP[type];
      const app = appId ? getApp(appId) : undefined;
      if (!app) return;
      openWindow(app.id, {
        title: app.name,
        icon: app.icon,
        width: app.window.defaultWidth,
        height: app.window.defaultHeight,
      });
    },
    [getApp, openWindow],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, widgetId: string) => {
      // Only start drag from the widget chrome, not from interactive children
      const target = e.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
      e.preventDefault();
      const widget = widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const manifest = getWidgetManifest(widget.type);
      const w = widget.gridW || manifest?.defaultSize.w || 3;
      const h = widget.gridH || manifest?.defaultSize.h || 2;
      setDragging(widgetId);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        col: widget.gridCol,
        row: widget.gridRow,
      };

      const onMove = (ev: MouseEvent) => {
        if (!dragStartRef.current) return;
        const dx = ev.clientX - dragStartRef.current.x;
        const dy = ev.clientY - dragStartRef.current.y;
        // Clamp to the desktop area so a widget can never vanish off-screen
        const rect = containerRef.current?.getBoundingClientRect();
        const maxCol = rect ? Math.max(0, Math.floor(rect.width / CELL_W) - w) : Infinity;
        const maxRow = rect ? Math.max(0, Math.floor(rect.height / CELL_H) - h) : Infinity;
        const col = Math.min(maxCol, Math.max(0, Math.round(dragStartRef.current.col + dx / CELL_W)));
        const row = Math.min(maxRow, Math.max(0, Math.round(dragStartRef.current.row + dy / CELL_H)));
        moveWidget(widgetId, col, row);
      };
      const onUp = () => {
        setDragging(null);
        dragStartRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widgets, moveWidget],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, widgetId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const widget = widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      const manifest = getWidgetManifest(widget.type);
      const min = manifest?.minSize ?? { w: 2, h: 2 };
      const max = manifest?.maxSize ?? { w: 8, h: 6 };
      const start = {
        x: e.clientX,
        y: e.clientY,
        w: widget.gridW || manifest?.defaultSize.w || 3,
        h: widget.gridH || manifest?.defaultSize.h || 2,
      };
      setResizing(widgetId);

      const onMove = (ev: MouseEvent) => {
        const w = Math.min(max.w, Math.max(min.w, Math.round(start.w + (ev.clientX - start.x) / CELL_W)));
        const h = Math.min(max.h, Math.max(min.h, Math.round(start.h + (ev.clientY - start.y) / CELL_H)));
        resizeWidget(widgetId, w, h);
      };
      const onUp = () => {
        setResizing(null);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widgets, resizeWidget],
  );

  // "⋯" hover button re-routes to the Radix context menu at the click point.
  const openMenuAt = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).closest("[data-widget-id]");
    host?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: 2,
      }),
    );
  }, []);

  return (
    <div className={styles.widgetLayer} ref={containerRef}>
      {widgets.map((widget) => {
        const WidgetComp = widgetComponents[widget.type];
        const manifest = getWidgetManifest(widget.type);
        if (!WidgetComp) return null;
        const w = widget.gridW || manifest?.defaultSize.w || 3;
        const h = widget.gridH || manifest?.defaultSize.h || 2;
        const canOpenApp = !!WIDGET_OPEN_APP[widget.type];

        return (
          <ContextMenu.Root key={widget.id}>
            <ContextMenu.Trigger asChild>
              <div
                data-widget-id={widget.id}
                data-widget-type={widget.type}
                className={`aeroWidget ${styles.widget} ${dragging === widget.id ? styles.dragging : ""} ${resizing === widget.id ? styles.resizing : ""}`}
                style={{
                  left: widget.gridCol * CELL_W + 8,
                  top: widget.gridRow * CELL_H + 8,
                  width: w * CELL_W - 16,
                  height: h * CELL_H - 16,
                }}
                onMouseDown={(e) => handleMouseDown(e, widget.id)}
              >
                <AppErrorBoundary appName="Widget">
                <Suspense fallback={<div className={styles.loading}>…</div>}>
                  <WidgetComp
                    widgetId={widget.id}
                    config={widget.config}
                    onOpenApp={canOpenApp ? () => openAppFor(widget.type) : undefined}
                  />
                </Suspense>
                </AppErrorBoundary>
                {/* Universelle Greif-Leiste: bewusst OHNE data-no-drag — garantiert
                    jedem Widget eine Drag-Fläche, auch wenn der Inhalt (z.B. Chat)
                    vollflächig interaktiv ist. mousedown bubbelt zum Frame. */}
                <div className={styles.dragHandle} aria-hidden />
                <button
                  className={styles.menuBtn}
                  data-no-drag
                  onClick={openMenuAt}
                  aria-label={t("desktop.widgetMenu.menu")}
                >
                  ⋯
                </button>
                <div
                  className={styles.resizeGrip}
                  data-no-drag
                  onMouseDown={(e) => handleResizeStart(e, widget.id)}
                  aria-hidden
                />
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.ctxMenu}>
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger className={styles.ctxItem}>
                    {t("desktop.widgetMenu.size")}
                    <span style={{ marginLeft: "auto" }}>›</span>
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent className={styles.ctxMenu}>
                      {manifest && (
                        <>
                          <ContextMenu.Item
                            className={styles.ctxItem}
                            onSelect={() => resizeWidget(widget.id, manifest.minSize.w, manifest.minSize.h)}
                          >
                            {t("desktop.widgetMenu.small")}
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className={styles.ctxItem}
                            onSelect={() => resizeWidget(widget.id, manifest.defaultSize.w, manifest.defaultSize.h)}
                          >
                            {t("desktop.widgetMenu.default")}
                          </ContextMenu.Item>
                          {manifest.maxSize && (
                            <ContextMenu.Item
                              className={styles.ctxItem}
                              onSelect={() => resizeWidget(widget.id, manifest.maxSize!.w, manifest.maxSize!.h)}
                            >
                              {t("desktop.widgetMenu.large")}
                            </ContextMenu.Item>
                          )}
                        </>
                      )}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
                {manifest?.hasSettings && (
                  <ContextMenu.Item
                    className={styles.ctxItem}
                    onSelect={() =>
                      window.dispatchEvent(
                        new CustomEvent("claraos-widget-settings", {
                          detail: { widgetId: widget.id },
                        }),
                      )
                    }
                  >
                    {t("desktop.widgetMenu.settings")}
                  </ContextMenu.Item>
                )}
                {canOpenApp && (
                  <ContextMenu.Item
                    className={styles.ctxItem}
                    onSelect={() => openAppFor(widget.type)}
                  >
                    {t("desktop.widgetMenu.openApp")}
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className={styles.ctxSeparator} />
                <ContextMenu.Item
                  className={styles.ctxItem}
                  onSelect={() => removeWidget(widget.id)}
                >
                  {t("desktop.widgetMenu.remove")}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
    </div>
  );
}
