/**
 * ActiveAgentsPanel — list of what Clara is currently working on.
 *
 * Data comes from `claraWork` (one shared poller for all mounts).
 * There are two mounts: the taskbar (tray entry "Clara arbeitet") and the
 * chat itself, which hides its OWN stream.
 *
 * Note: this list used to sit in the middle of the start menu, between
 * "continue" and "all apps" — a leftover from before a start-menu redesign,
 * when it sat at the edge of the tab bar. When it appeared, it pushed half
 * of the menu content down. System state belongs in the system tray, not in
 * a list you are currently reading.
 *
 * Clicking an entry → focuses the source window or opens the task in the
 * planner.
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUIStore, useWindowsStore, useWrappStore, getBrand, useTranslation } from "@claraos/core";
import { navigateIframe } from "../apps/iframeNavigator";
import { SparklesIcon } from "./icons";
import { useClaraWork, type ActiveStream, type PlannerWork } from "./claraWork";
import styles from "./ActiveAgentsPanel.module.css";

interface ActiveAgentsPanelProps {
  /** Embedded in the chat: hide the OWN stream (same surface+app) —
   *  it already shows there as a typing indicator. */
  excludeSurface?: string;
  excludeAppId?: string | null;
  /** In the taskbar the popover brings its own frame — then without a header. */
  hideHeader?: boolean;
  /** On phones the bar sat permanently above the chat and took up to 180 px
   *  plus header — a quarter of the screen, and it does not scroll away (it
   *  sits OUTSIDE the message list). `kompakt` shows only the single header
   *  row; a tap expands the list. The state stays visible, it just does not
   *  crowd the screen. */
  kompakt?: boolean;
}

export function ActiveAgentsPanel({ excludeSurface, excludeAppId, hideHeader, kompakt }: ActiveAgentsPanelProps = {}) {
  const { t } = useTranslation("chat");
  const { streams, plannerWork, taskTitles } = useClaraWork();
  const [offen, setOffen] = useState(!kompakt);
  const [zeigeVeraltet, setZeigeVeraltet] = useState(false);

  /** Click on a planner entry: open/focus the planner + deep-link the task
   *  detail (same poll pattern as shellNavigateTo — the navigator only
   *  registers after mount). */
  function openPlannerTask(w: PlannerWork): void {
    const store = useWindowsStore.getState();
    const existing = Object.values(store.windows).find((win) => win.appId === "planner");
    if (existing) store.focusWindow(existing.id);
    else store.openWindow("planner");
    const path = `/task/${w.task_id}`;
    if (navigateIframe("planner", path)) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      if (navigateIframe("planner", path) || ++tries > 40) window.clearInterval(timer);
    }, 150);
  }

  function focusFromStream(s: ActiveStream): void {
    // Try wrapp instance first
    if (s.wrapp_instance_id) {
      const inst = useWrappStore.getState().instances[s.wrapp_instance_id];
      if (inst?.windowId) {
        useWindowsStore.getState().focusWindow(inst.windowId);
        return;
      }
    }
    // Fall back to opening the start-menu Clara tab
    const ui = useUIStore.getState();
    if (!ui.startMenuOpen) ui.toggleStartMenu();
  }

  const visible = excludeSurface
    ? streams.filter(
        (s) => !(s.surface === excludeSurface && (s.app_id ?? null) === (excludeAppId ?? null)),
      )
    : streams;

  // Important: stale entries do not count as "currently working". An entry
  // that has been there for over six hours is stale — it does not belong in
  // a list that says what is running NOW. But it does not disappear
  // silently: the footer names it and reveals it on tap.
  // (The locks themselves are now cleared server-side by `/in-work`; this is
  // the second line of defence for anything that slips through.)
  const frisch = plannerWork.filter((w) => !w.stale);
  const veraltet = plannerWork.filter((w) => w.stale);
  const sichtbareArbeit = zeigeVeraltet ? plannerWork : frisch;
  const anzahl = visible.length + frisch.length;

  if (visible.length === 0 && plannerWork.length === 0) return null;
  // Only stale entries and nobody wants to see them → the bar has nothing to say.
  if (anzahl === 0 && !zeigeVeraltet && !veraltet.length) return null;

  const liste = (
    <ul className={styles.list}>
        {visible.map((s) => (
          <li
            key={s.id}
            className={styles.item}
            onClick={() => focusFromStream(s)}
            role="button"
            title={t("agents.focusSourceTitle")}
          >
            <span className={styles.spinner} aria-hidden="true" />
            <span className={styles.itemBody}>
              <span className={styles.appId}>
                {s.app_id ? `app: ${s.app_id}` : "general chat"}
              </span>
              {s.object_uri && (
                <span className={styles.itemSub}>{shortenObject(s.object_uri)}</span>
              )}
              {s.wrapp_instance_id && (
                <span className={styles.itemSub}>wrapp: {s.wrapp_instance_id}</span>
              )}
            </span>
            <span className={styles.duration}>{formatDuration(s.duration_s)}</span>
          </li>
        ))}
        {sichtbareArbeit.map((w) => (
          <li
            key={`planner-${w.project_id}-${w.task_id}`}
            className={styles.item}
            onClick={() => openPlannerTask(w)}
            role="button"
            title={w.stale
              ? t("agents.staleTitle")
              : t("agents.openTaskTitle")}
          >
            <span className={styles.spinner} aria-hidden="true" />
            <span className={styles.itemBody}>
              <span className={styles.appId}>
                🗂️ {taskTitles[w.task_id] ?? `#${w.task_id}`}
              </span>
              <span className={styles.itemSub}>
                {w.in_work_by === "clara" || w.in_work_by === "clara-agent" ? getBrand().assistant : w.in_work_by}
                {w.stale ? ` · ⚠ ${t("agents.stuck")}` : ""}
              </span>
            </span>
            <span className={styles.duration}>{w.since ? formatSince(w.since) : ""}</span>
          </li>
        ))}
    </ul>
  );

  // In the taskbar the list already sits in a popover with its own frame
  // and its own heading — then only the content.
  if (hideHeader) return liste;

  const fuss = veraltet.length > 0 && (
    <button
      type="button"
      className={styles.altlast}
      onClick={(e) => { e.stopPropagation(); setZeigeVeraltet((v) => !v); }}
    >
      {zeigeVeraltet
        ? t("agents.hideStale", { count: veraltet.length })
        : t("agents.showStale", { count: veraltet.length })}
    </button>
  );

  return (
    <div className={styles.panel} role="region" aria-label={t("agents.regionLabel")} data-kompakt={kompakt ? "true" : undefined}>
      <header
        className={`${styles.header} ${kompakt ? styles.headerTippbar : ""}`}
        {...(kompakt
          ? { role: "button" as const, tabIndex: 0, "aria-expanded": offen,
              title: offen ? t("agents.collapse") : t("agents.expand"),
              onClick: () => setOffen((o) => !o),
              onKeyDown: (e: ReactKeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOffen((o) => !o); }
              } }
          : {})}
      >
        <span className={styles.brandIcon}><SparklesIcon size={12} /></span>
        <span className={styles.title}>{t("agents.title")}</span>
        {/* The counter names what is running NOW. Stale entries are in the
            footer — otherwise the number claims work nobody is doing. */}
        <span className={styles.count}>{anzahl}</span>
        {kompakt && <span className={styles.pfeil} aria-hidden="true">{offen ? "▾" : "▸"}</span>}
      </header>
      {offen && liste}
      {offen && fuss}
    </div>
  );
}

function formatSince(sinceIso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(sinceIso).getTime()) / 1000);
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function shortenObject(uri: string): string {
  // claraos://app/<id>/object/<encoded>
  const idx = uri.indexOf("/object/");
  if (idx < 0) return uri;
  let raw = uri.slice(idx + "/object/".length);
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  const last = raw.split(/[/\\]/).pop();
  return last || raw;
}
