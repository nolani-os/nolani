/** Planner — native planning environment.
 * LeftRail (My Day / Tasks / Projects) + content + TaskDetail drawer.
 * Data source: BFF /api/claraos/planner, backend Vikunja. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { appHost, getBrand } from "@claraos/core";
import styles from "./PlannerApp.module.css";
import { Icon, type IconName } from "../../components/Icon";
import { plannerApi, NotConnectedError } from "./api";
import type { VikProject, VikTask } from "./types";
import { MyDayView } from "./views/MyDayView";
import { TasksView } from "./views/TasksView";
import { ProjectsView } from "./views/ProjectsView";
import { BoardView } from "./views/BoardView";
import { GanttView } from "./views/GanttView";
import { CostsView } from "./views/CostsView";
import { CostsOverviewView } from "./views/CostsOverviewView";
import { CalendarView } from "./views/CalendarView";
import { TaskDetail } from "./TaskDetail";
import { registerActionHandler } from "../../Chat/actionBus";
import { registerIframeNavigator } from "../iframeNavigator";
import { useIsMobile } from "../../Mobile/useIsMobile";
import { Werkzeugleiste } from "../../components/Werkzeugleiste";
import BusinessView from "./views/BusinessView";

type Rail = "myday" | "tasks" | "calendar" | "gemeinsam" | "projects" | "costs";

const RAIL_ITEMS: { key: Rail; icon: IconName; label: string }[] = [
  { key: "myday", icon: "today", label: "Mein Tag" },
  { key: "tasks", icon: "check", label: "Aufgaben" },
  { key: "calendar", icon: "calendar", label: "Kalender" },
  // Resources, scheduling polls, meeting room — everything you arrange with
  // others instead of entering on your own.
  { key: "gemeinsam", icon: "people", label: "Gemeinsam" },
  { key: "projects", icon: "collections", label: "Projekte" },
  { key: "costs", icon: "money", label: "Kosten" },
];

export default function PlannerApp({ windowId: _windowId }: { windowId: string }) {
  const isMobile = useIsMobile();
  const [rail, setRail] = useState<Rail>("myday");
  const [projects, setProjects] = useState<VikProject[]>([]);
  const [allTasks, setAllTasks] = useState<VikTask[]>([]);
  const [activeProject, setActiveProject] = useState<VikProject | null>(null);
  const [projView, setProjView] = useState<"board" | "gantt" | "costs">("board");
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const projectTitles = useMemo(() => {
    const m = new Map<number, string>();
    projects.forEach((p) => m.set(p.id, p.title));
    return m;
  }, [projects]);

  // Rail/QuickAdd only show active projects; ProjectsView gets ALL of them
  // (archive section + reactivate).
  const activeProjects = useMemo(() => projects.filter((p) => !p.is_archived), [projects]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        // Load all task pages (previously fixed at 3×50 → capped at 150 tasks).
        // Cap of 40 pages = 2000 tasks as a safety net against endless loops.
        const loadAllTasks = async () => {
          const all: VikTask[] = [];
          for (let page = 1; page <= 40; page++) {
            const batch = (await plannerApi.listAllTasks(page)) || [];
            all.push(...batch);
            if (batch.length < 50) break;
          }
          return all;
        };
        const [projs, rawTasks] = await Promise.all([plannerApi.listProjects(), loadAllTasks()]);
        if (cancelled) return;
        setProjects(projs || []);
        const tasks = rawTasks.filter(Boolean).sort((a, b) => {
          const ad = a.due_date && !a.due_date.startsWith("0001-") ? a.due_date : "9999";
          const bd = b.due_date && !b.due_date.startsWith("0001-") ? b.due_date : "9999";
          return ad.localeCompare(bd);
        });
        setAllTasks(tasks);
        setNotConnected(null);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof NotConnectedError) setNotConnected(e.message);
        else setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  // Deep links (Clara/NavCards): planner.open_task / planner.open_project
  useEffect(() => registerActionHandler("planner", (action, args) => {
    if (action === "open_task" && args?.task_id) {
      setDetailTaskId(Number(args.task_id));
    } else if (action === "open_myday") {
      // Target of the daily digest (services/planner_digest.py)
      setRail("myday");
      setActiveProject(null);
    } else if (action === "open_project" && args?.project_id) {
      const pid = Number(args.project_id);
      setRail("projects");
      plannerApi.getProject(pid).then(setActiveProject).catch(() => undefined);
    }
  }), []);

  // Deep links via the navigate_to path: the app registers itself in the
  // iframeNavigator registry — the shell handler opens the window and polls
  // until this navigator is mounted. "url" here is the RELATIVE path from
  // app_url_patterns.py ("planner"), e.g. /task/42 or /project/7/gantt.
  useEffect(() => registerIframeNavigator("planner", (path) => {
    const openProject = (pid: number, view: "board" | "gantt" | "costs") => {
      setRail("projects");
      setProjView(view);
      plannerApi.getProject(pid).then(setActiveProject).catch(() => undefined);
    };
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/task\/(\d+)/))) {
      setDetailTaskId(Number(m[1]));
    } else if ((m = path.match(/^\/project\/(\d+)\/gantt/))) {
      openProject(Number(m[1]), "gantt");
    } else if ((m = path.match(/^\/project\/(\d+)\/costs/))) {
      openProject(Number(m[1]), "costs");
    } else if ((m = path.match(/^\/project\/(\d+)/))) {
      openProject(Number(m[1]), "board");
    } else if (path.startsWith("/myday") || path.startsWith("/tasks") || path.startsWith("/calendar") || path.startsWith("/costs")) {
      setActiveProject(null);
      setRail(path.slice(1).split("/")[0] as Rail);
    }
  }), []);

  const toggleDone = useCallback(async (t: VikTask) => {
    // optimistic — reload on error (TasksWidget pattern)
    setAllTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: !t.done } : x)));
    try {
      await plannerApi.updateTaskFields(t.id, { done: !t.done });
    } catch {
      reload();
    }
  }, [reload]);

  const openTask = useCallback((t: VikTask) => setDetailTaskId(t.id), []);

  if (notConnected) {
    return (
      <div className={styles.app}>
        <div className={styles.onboarding}>
          <div className={styles.onboardingIcon}><Icon name="collections" size={40} /></div>
          <h2>Planner verbinden</h2>
          <p>{notConnected}</p>
          <ol>
            <li>Planner-Backend öffnen: <code>{appHost("vikunja")}</code> → „{getBrand().product} Login“</li>
            <li>Dort: Einstellungen → API-Tokens → Token erstellen</li>
            <li>{getBrand().product}: Einstellungen → App-Verbindungen → „Planner (Vikunja)“ → Token eintragen</li>
          </ol>
          <button className={styles.btnPrimary} onClick={reload}>Erneut prüfen</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.app} ${isMobile ? styles.appMobile : ""}`}>
      {!isMobile && (
      <nav className={styles.rail}>
        {RAIL_ITEMS.map((it) => (
          <button
            key={it.key}
            className={`${styles.railBtn} ${rail === it.key && !(it.key !== "projects" && activeProject) ? styles.railActive : ""}`}
            onClick={() => { setRail(it.key); if (it.key !== "projects") setActiveProject(null); }}
          >
            <span className={styles.railIcon}><Icon name={it.icon} size={18} /></span>
            <span>{it.label}</span>
          </button>
        ))}
        <div className={styles.railProjects}>
          {activeProjects.map((p) => (
            <button
              key={p.id}
              className={`${styles.railProjBtn} ${activeProject?.id === p.id ? styles.railActive : ""}`}
              onClick={() => { setRail("projects"); setActiveProject(p); }}
              title={p.title}
            >
              <span className={styles.projDot} style={p.hex_color ? { background: `#${p.hex_color}` } : undefined} />
              <span className={styles.railProjTitle}>{p.title}</span>
            </button>
          ))}
        </div>
      </nav>
      )}

      <main className={styles.content}>
        {error && <div className={styles.errorBox}>{error} <button aria-label="Neu laden" title="Neu laden" onClick={reload}>↻</button></div>}
        {loading ? (
          <div className={styles.loading}>Lade…</div>
        ) : rail === "myday" ? (
          <MyDayView tasks={allTasks} projectTitles={projectTitles} onToggle={toggleDone} onOpen={openTask} onReload={reload} />
        ) : rail === "tasks" ? (
          <TasksView tasks={allTasks} projects={activeProjects} projectTitles={projectTitles}
                     onToggle={toggleDone} onOpen={openTask} onReload={reload} />
        ) : rail === "calendar" ? (
          <CalendarView allTasks={allTasks} onOpenTask={openTask} onReloadTasks={reload} />
        ) : rail === "gemeinsam" ? (
          <BusinessView />
        ) : rail === "costs" ? (
          <CostsOverviewView
            allTasks={allTasks}
            onOpenTask={openTask}
            onOpenProject={(pid) => {
              setRail("projects");
              setProjView("costs");
              plannerApi.getProject(pid).then(setActiveProject).catch(() => undefined);
            }}
          />
        ) : activeProject ? (
          <div className={styles.projWrap}>
            <div className={styles.projTabs}>
              {isMobile && (
                <button className={styles.btn} title="Zurück zur Projektliste"
                        onClick={() => setActiveProject(null)}>
                  ‹
                </button>
              )}
              <button className={`${styles.projTab} ${projView === "board" ? styles.projTabActive : ""}`}
                      onClick={() => setProjView("board")}>Board</button>
              <button className={`${styles.projTab} ${projView === "gantt" ? styles.projTabActive : ""}`}
                      onClick={() => setProjView("gantt")}>Gantt</button>
              <button className={`${styles.projTab} ${projView === "costs" ? styles.projTabActive : ""}`}
                      onClick={() => setProjView("costs")}>Kosten</button>
            </div>
            {projView === "board" ? (
              <BoardView project={activeProject} onOpen={openTask} onBack={() => setActiveProject(null)} />
            ) : projView === "gantt" ? (
              <GanttView project={activeProject} onOpen={openTask} />
            ) : (
              <CostsView project={activeProject} onOpen={openTask} />
            )}
          </div>
        ) : (
          <ProjectsView projects={projects} onOpenProject={setActiveProject} onReload={reload} />
        )}
      </main>

      {detailTaskId != null && (
        <TaskDetail
          taskId={detailTaskId}
          projectTitles={projectTitles}
          allTasks={allTasks}
          onOpenTask={(id) => setDetailTaskId(id)}
          onClose={() => setDetailTaskId(null)}
          onChanged={reload}
        />
      )}

      {/* Mobile: shared floating toolbar + FAB. */}
      {isMobile && (
        <Werkzeugleiste
          eintraege={RAIL_ITEMS.map((it) => ({
            key: it.key,
            label: it.label,
            icon: it.icon,
            active: rail === it.key && !(it.key !== "projects" && activeProject),
            onClick: () => { setRail(it.key); if (it.key !== "projects") setActiveProject(null); },
          }))}
          fab={{
            label: "Neue Aufgabe",
            onClick: () => {
              setRail("myday"); setActiveProject(null);
              // MyDayView listens for this and puts the cursor into the input field.
              window.setTimeout(() => window.dispatchEvent(new CustomEvent("claraos-planner-neu")), 50);
            },
          }}
        />
      )}
    </div>
  );
}
