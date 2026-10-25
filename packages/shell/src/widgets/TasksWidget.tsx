// Tasks widget v3 (desktop + mobile): ClaraOS Planner (Vikunja via BFF).
//
// The data source used to be Nextcloud Tasks (`/api/claraos/nc/tasks/*`) —
// i.e. a SECOND task list next to the one Clara and the Planner actually work
// in. What Clara created or checked off was invisible on the desktop and vice
// versa. Now the widget uses the same BFF as the Planner app
// (`routers/planner.py`) and additionally shows the "Clara is working" marker
// (`_meta.in_work_by`) right on the desktop.
//
// Important: the widget type is still called `nc-tasks` for compatibility:
// the id is stored in every user's saved desktop/homescreen layouts
// (workspace store); renaming it would drop existing widgets.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore, useTranslation, i18n, getBrand } from "@claraos/core";
import type { WidgetProps } from "./registry";
import { NotConnectedError, plannerApi } from "../apps/planner/api";
import { hasDate, type VikProject, type VikTask } from "../apps/planner/types";
import {
  CheckList,
  CheckRow,
  GroupLabel,
  SettingsOverlay,
  useWidgetSettingsOpen,
} from "./settingsControls";
import s from "./MobileListWidgets.module.css";
import c from "./CalendarWidget.module.css";
import { regionLocale } from "@claraos/core";

const POLL_MS = 5 * 60 * 1000;

function dueLabel(due?: string): { label: string; overdue: boolean } {
  if (!hasDate(due)) return { label: "", overdue: false };
  const d = new Date(due as string);
  const overdue = d.getTime() < Date.now();
  return { label: d.toLocaleDateString(regionLocale(), { day: "numeric", month: "numeric" }), overdue };
}

/** Vikunja priority: 0 = none, 1-2 low, 3 high, 4 urgent, 5 DO NOW. */
function prioMark(priority?: number): { mark: string; color: string } | null {
  if (!priority || priority < 3) return null;
  if (priority >= 4) return { mark: "‼", color: "#f87171" };
  return { mark: "!", color: "#fbbf24" };
}

/** "clara"/"clara-agent" are machine actors — one name for the user. */
function actorLabel(actor: string): string {
  return actor === "clara" || actor === "clara-agent" ? getBrand().assistant : actor;
}

export default function TasksWidget({ widgetId, config, guardRef, onOpenApp }: WidgetProps) {
  // `t` is the loop variable for tasks below — hence `tr`.
  // "planner" too: error messages come from the planner api in that namespace.
  const { t: tr } = useTranslation(["desktop", "planner"]);
  const updateWidgetConfig = useWorkspaceStore((st) => st.updateWidgetConfig);
  const cfgProjects: number[] = Array.isArray(config?.projects)
    ? (config.projects as unknown[]).map(Number).filter((n) => Number.isFinite(n))
    : [];

  const [tasks, setTasks] = useState<VikTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [checking, setChecking] = useState<Record<number, boolean>>({});
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftDue, setDraftDue] = useState("");
  const [draftPrio, setDraftPrio] = useState("");
  const [draftProject, setDraftProject] = useState("");
  const [projects, setProjects] = useState<VikProject[]>([]);
  const aliveRef = useRef(true);

  const [settingsOpen, setSettingsOpen] = useWidgetSettingsOpen(widgetId);
  const [draftProjects, setDraftProjects] = useState<number[]>(cfgProjects);

  const load = useCallback(async () => {
    try {
      const open = await plannerApi.listOpenTasks();
      if (!aliveRef.current) return;
      setTasks(cfgProjects.length ? open.filter((t) => cfgProjects.includes(t.project_id)) : open);
      setError(null);
      setNotConnected(null);
    } catch (e) {
      if (!aliveRef.current) return;
      if (e instanceof NotConnectedError) setNotConnected(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [cfgProjects.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    aliveRef.current = true;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  useEffect(() => {
    plannerApi
      .listProjects()
      .then((p) => setProjects((p || []).filter((x) => !x.is_archived)))
      .catch(() => {});
  }, []);

  const toggle = useCallback(
    async (t: VikTask) => {
      if (guardRef?.current) return;
      setChecking((ch) => ({ ...ch, [t.id]: true }));
      setTasks((prev) => (prev ?? []).filter((x) => x.id !== t.id));
      try {
        await plannerApi.updateTaskFields(t.id, { done: true });
        setTimeout(load, 400);
      } catch {
        load(); // failure → reloading the list brings the task back
      } finally {
        setChecking((ch) => {
          const n = { ...ch };
          delete n[t.id];
          return n;
        });
      }
    },
    [guardRef, load],
  );

  /** Target project for new tasks: composer selection → the only selected list
   *  → "Inbox" (Vikunja creates one per user) → first project. */
  const targetProject = useCallback((): number | null => {
    if (draftProject) return Number(draftProject);
    if (cfgProjects.length === 1) return cfgProjects[0];
    const inbox = projects.find((p) => p.title.toLowerCase() === "inbox");
    return inbox?.id ?? projects[0]?.id ?? null;
  }, [draftProject, cfgProjects.join("|"), projects]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTask = useCallback(async () => {
    const title = draft.trim();
    if (!title) {
      setComposing(false);
      return;
    }
    const projectId = targetProject();
    if (!projectId) {
      setError(i18n.t("desktop:widgets.tasks.noProject"));
      return;
    }
    setDraft("");
    setDraftDue("");
    setDraftPrio("");
    setComposing(false);
    try {
      // The date field only yields the day — Vikunja wants an ISO timestamp.
      const due = draftDue ? new Date(`${draftDue}T18:00:00`).toISOString() : undefined;
      await plannerApi.createTask(projectId, {
        title,
        ...(due ? { due_date: due } : {}),
        ...(draftPrio ? { priority: parseInt(draftPrio, 10) } : {}),
      });
      setTimeout(load, 400);
    } catch {
      /* the next poll reconciles */
    }
  }, [draft, draftDue, draftPrio, targetProject, load]);

  const saveSettings = useCallback(() => {
    updateWidgetConfig(widgetId, { projects: draftProjects });
    setSettingsOpen(false);
    setTasks(null);
  }, [widgetId, draftProjects, updateWidgetConfig, setSettingsOpen]);

  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

  // In-progress first (that is the message "something is happening here"),
  // then by due date.
  const sorted = useMemo(() => {
    const key = (t: VikTask) => (hasDate(t.due_date) ? (t.due_date as string) : "9999");
    return [...(tasks ?? [])].sort((a, b) => {
      const aw = a._meta?.in_work_by ? 0 : 1;
      const bw = b._meta?.in_work_by ? 0 : 1;
      return aw !== bw ? aw - bw : key(a).localeCompare(key(b));
    });
  }, [tasks]);

  const projectColor = (id: number) => projects.find((p) => p.id === id)?.hex_color;

  return (
    <div className={s.widget}>
      <div className={s.header}>
        <span className={s.headerTitle}>{tr("widgets.tasks.title")}</span>
        {tasks !== null && <span className={s.badge}>{tasks.length}</span>}
        <span className={s.headerActions}>
          <button className={s.iconBtn} onPointerDown={stop} onClick={(e) => { stop(e); setComposing((v) => !v); }} aria-label={tr("widgets.tasks.add")}>＋</button>
          <button className={s.iconBtn} onPointerDown={stop} onClick={(e) => { stop(e); load(); }} aria-label={tr("widgets.tasks.refresh")}>⟳</button>
          <button className={s.iconBtn} onPointerDown={stop} onClick={(e) => { stop(e); onOpenApp?.(); }} aria-label={tr("widgets.tasks.openPlanner")}>⚙</button>
        </span>
      </div>
      {composing && !notConnected && (
        <div className={c.composer2} onPointerDown={stop}>
          <div className={c.composerRow}>
            <input
              className={c.cInput}
              autoFocus
              placeholder={tr("widgets.tasks.newPlaceholder")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask();
                if (e.key === "Escape") setComposing(false);
              }}
            />
          </div>
          <div className={c.composerRow}>
            <input
              type="date"
              className={`${c.cInput} ${c.cDate}`}
              value={draftDue}
              onChange={(e) => setDraftDue(e.target.value)}
              title={tr("widgets.tasks.due")}
            />
            <select
              className={c.cInput}
              value={draftPrio}
              onChange={(e) => setDraftPrio(e.target.value)}
              title={tr("widgets.tasks.priority")}
            >
              <option value="">{tr("widgets.tasks.prioNormal")}</option>
              <option value="4">{tr("widgets.tasks.prioHigh")}</option>
              <option value="3">{tr("widgets.tasks.prioMedium")}</option>
            </select>
            {projects.length > 1 && (
              <select
                className={c.cInput}
                value={draftProject}
                onChange={(e) => setDraftProject(e.target.value)}
                title={tr("widgets.tasks.project")}
              >
                <option value="">{tr("widgets.tasks.defaultProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
            <button className={c.cBtn} disabled={!draft.trim()} onClick={addTask}>
              OK
            </button>
          </div>
        </div>
      )}
      <div className={s.scroll}>
        {notConnected && (
          <div className={s.empty}>
            {tr("widgets.tasks.notConnected")}
          </div>
        )}
        {!notConnected && tasks === null && !error && <div className={s.empty}>{tr("widgets.tasks.loading")}</div>}
        {!notConnected && tasks === null && error && <div className={s.empty}>{tr("widgets.tasks.unreachable")}</div>}
        {!notConnected && tasks !== null && sorted.length === 0 && <div className={s.empty}>{tr("widgets.tasks.allDone")} 🎉</div>}
        {!notConnected && sorted.map((t) => {
          const due = dueLabel(t.due_date);
          const prio = prioMark(t.priority);
          const color = projectColor(t.project_id);
          const worker = t._meta?.in_work_by;
          return (
            <div key={t.id} className={s.row}>
              <button
                className={`${s.check} ${checking[t.id] ? s.checked : ""}`}
                onPointerDown={stop}
                onClick={(e) => { stop(e); toggle(t); }}
                aria-label={tr("widgets.tasks.done")}
              >
                {checking[t.id] ? "✓" : ""}
              </button>
              {color && <span className={c.calDot} style={{ background: color }} title={projects.find((p) => p.id === t.project_id)?.title} />}
              {prio && (
                <span style={{ color: prio.color, fontWeight: 700, flexShrink: 0 }}>{prio.mark}</span>
              )}
              <span className={s.title}>{t.title || tr("widgets.tasks.untitled")}</span>
              {worker && (
                <span
                  style={{ color: "#7b9fff", fontSize: 10, flexShrink: 0 }}
                  title={tr("widgets.tasks.inWorkSince", { since: t._meta?.in_work_since ?? "?" })}
                >
                  ● {actorLabel(worker)}
                </span>
              )}
              {due.label && <span className={`${s.due} ${due.overdue ? s.overdue : ""}`}>{due.label}</span>}
            </div>
          );
        })}
      </div>

      {settingsOpen && (
        <SettingsOverlay
          title={tr("widgets.tasks.settingsTitle")}
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
        >
          <GroupLabel>{tr("widgets.tasks.shownProjects")}</GroupLabel>
          <CheckList>
            {projects.length === 0 && <span style={{ fontSize: 11, opacity: 0.6 }}>{tr("widgets.tasks.loadingProjects")}</span>}
            {projects.map((p) => (
              <CheckRow
                key={p.id}
                label={p.title}
                swatch={p.hex_color || "#7b9fff"}
                checked={draftProjects.length === 0 ? true : draftProjects.includes(p.id)}
                onChange={(v) =>
                  setDraftProjects((cur) => {
                    const base = cur.length === 0 ? projects.map((y) => y.id) : cur;
                    return v ? [...new Set([...base, p.id])] : base.filter((n) => n !== p.id);
                  })
                }
              />
            ))}
          </CheckList>
        </SettingsOverlay>
      )}
    </div>
  );
}
