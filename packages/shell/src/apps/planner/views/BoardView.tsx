/** A project's Kanban board — buckets (project sections), cards,
 * HTML5 DnD card→bucket (house style, no dnd-kit). */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../PlannerApp.module.css";
import { Icon } from "../../../components/Icon";
import { plannerApi } from "../api";
import { hasDate, type VikBucket, type VikProject, type VikTask } from "../types";
import { ChecklistBadge, InWorkBadge, LabelChips, PrioBadge, dueLabel, isOverdue } from "../shared";

export function BoardView({
  project, onOpen, onBack,
}: {
  project: VikProject;
  onOpen: (t: VikTask) => void;
  onBack: () => void;
}) {
  const [buckets, setBuckets] = useState<VikBucket[]>([]);
  const [viewId, setViewId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragTaskId, setDragTaskId] = useState<number | null>(null);
  const [dropBucket, setDropBucket] = useState<number | null>(null);
  const [addingIn, setAddingIn] = useState<number | null>(null);
  const [newCard, setNewCard] = useState("");
  const [addingBucket, setAddingBucket] = useState(false);
  const [newBucket, setNewBucket] = useState("");

  const load = useCallback(async () => {
    try {
      setError(null);
      const detail = await plannerApi.getProject(project.id);
      const kanban = (detail.views || []).find((v) => v.view_kind === "kanban");
      if (!kanban) { setError("Projekt hat keine Kanban-Ansicht."); return; }
      setViewId(kanban.id);
      let bs = (await plannerApi.listBuckets(project.id, kanban.id)) || [];
      // Fallback: if the bucket endpoint returns no tasks, group from the project tasks
      if (bs.length && bs.every((b) => !b.tasks || b.tasks.length === 0)) {
        const tasks = await plannerApi.listProjectTasks(project.id);
        if (tasks.some((t) => t.bucket_id)) {
          bs = bs.map((b) => ({ ...b, tasks: tasks.filter((t) => t.bucket_id === b.id) }));
        } else if (tasks.length) {
          bs = bs.map((b, i) => (i === 0 ? { ...b, tasks: tasks.filter((t) => !t.done) } : b));
        }
      }
      setBuckets(bs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const totalTasks = useMemo(
    () => buckets.reduce((n, b) => n + (b.tasks?.length ?? 0), 0),
    [buckets],
  );

  const moveTask = async (taskId: number, targetBucket: number) => {
    if (viewId == null) return;
    const src = buckets.find((b) => b.tasks?.some((t) => t.id === taskId));
    if (src?.id === targetBucket) return;
    // optimistic
    setBuckets((prev) => {
      const task = prev.flatMap((b) => b.tasks ?? []).find((t) => t.id === taskId);
      if (!task) return prev;
      return prev.map((b) => ({
        ...b,
        tasks: b.id === targetBucket
          ? [...(b.tasks ?? []), { ...task, bucket_id: targetBucket }]
          : (b.tasks ?? []).filter((t) => t.id !== taskId),
      }));
    });
    try {
      await plannerApi.moveTaskToBucket(project.id, viewId, targetBucket, taskId);
    } catch {
      load();
    }
  };

  const addCard = async (bucketId: number) => {
    const title = newCard.trim();
    if (!title) return;
    try {
      const t = await plannerApi.createTask(project.id, { title });
      if (viewId != null) await plannerApi.moveTaskToBucket(project.id, viewId, bucketId, t.id).catch(() => undefined);
      setNewCard("");
      setAddingIn(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addBucket = async () => {
    const title = newBucket.trim();
    if (!title || viewId == null) return;
    await plannerApi.createBucket(project.id, viewId, title);
    setNewBucket("");
    setAddingBucket(false);
    load();
  };

  return (
    <div className={styles.boardWrap}>
      <header className={styles.viewHeader}>
        <button aria-label="Zurück" title="Zurück" className={styles.btn} onClick={onBack}>←</button>
        <h2>{project.title}</h2>
        <span className={styles.viewSub}>{totalTasks} Aufgaben</span>
      </header>
      {error && <div className={styles.errorBox}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>Lade Board…</div>
      ) : (
        <div className={styles.board}>
          {buckets.map((b) => (
            <div
              key={b.id}
              className={`${styles.bucket} ${dropBucket === b.id ? styles.bucketDrop : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDropBucket(b.id); }}
              onDragLeave={() => setDropBucket((cur) => (cur === b.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDropBucket(null);
                const id = dragTaskId ?? Number(e.dataTransfer.getData("text/plain"));
                if (id) moveTask(id, b.id);
              }}
            >
              <div className={styles.bucketHeader}>
                <span>{b.title}</span>
                <span className={styles.count}>{b.tasks?.length ?? 0}</span>
              </div>
              <div className={styles.bucketBody}>
                {(b.tasks ?? []).map((t) => (
                  <div
                    key={t.id}
                    className={`${styles.card} ${t.done ? styles.taskDone : ""}`}
                    draggable
                    onDragStart={(e) => {
                      setDragTaskId(t.id);
                      e.dataTransfer.setData("text/plain", String(t.id));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => { setDragTaskId(null); setDropBucket(null); }}
                    onClick={() => onOpen(t)}
                  >
                    <div className={styles.cardTitle}>{t.title} <PrioBadge priority={t.priority} /></div>
                    <div className={styles.cardMeta}>
                      {hasDate(t.due_date) && (
                        <span className={`${styles.metaBadge} ${isOverdue(t) ? styles.overdue : ""}`}>
                          <Icon name="calendar" size={12} /> {dueLabel(t.due_date)}
                        </span>
                      )}
                      <ChecklistBadge task={t} />
                      <InWorkBadge task={t} />
                      {!!t.assignees?.length && (
                        <span className={styles.metaBadge}><Icon name="person" size={12} /> {t.assignees.map((a) => a.username).join(", ")}</span>
                      )}
                      <LabelChips task={t} />
                    </div>
                  </div>
                ))}
                {addingIn === b.id ? (
                  <input
                    className={styles.input}
                    autoFocus
                    placeholder="Kartentitel…"
                    value={newCard}
                    onChange={(e) => setNewCard(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addCard(b.id);
                      if (e.key === "Escape") { setAddingIn(null); setNewCard(""); }
                    }}
                    onBlur={() => { setAddingIn(null); setNewCard(""); }}
                  />
                ) : (
                  <button className={styles.addCardBtn} onClick={() => setAddingIn(b.id)}>+ Karte</button>
                )}
              </div>
            </div>
          ))}
          <div className={styles.bucketAdd}>
            {addingBucket ? (
              <input className={styles.input} autoFocus placeholder="Abschnittsname…"
                     value={newBucket} onChange={(e) => setNewBucket(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") addBucket();
                       if (e.key === "Escape") { setAddingBucket(false); setNewBucket(""); }
                     }}
                     onBlur={() => { setAddingBucket(false); setNewBucket(""); }} />
            ) : (
              <button className={styles.addCardBtn} onClick={() => setAddingBucket(true)}>+ Abschnitt</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
