/** TaskDetail — side panel: title, checklist (Markdown toggle), description,
 * due date/reminder/repeat, priority, labels, assignment,
 * dependencies, comments, estimates (_meta). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowsStore } from "@claraos/core";
import { ausfuehrenLokal } from "../../Chat/shellActionHandler";
import styles from "./PlannerApp.module.css";
import { Icon } from "../../components/Icon";
import { plannerApi } from "./api";
import {
  hasDate, type TaskMeta, type VikAttachment, type VikComment, type VikLabel, type VikTask, type VikUser,
} from "./types";
import { appendChecklistItem, parseChecklist, toggleChecklistLine } from "./checklist";
import { dueLabel, fmtEur, fmtMins, fmtTokens } from "./shared";
import { datumInWorten } from "../../lib/datumsWorte";
import type { TaskCost } from "./types";
import { FilePickerModal, type PickedRef } from "../../Chat/FilePickerModal";

type MetaLink = NonNullable<TaskMeta["links"]>[number];

const REPEAT_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Nie", seconds: 0 },
  { label: "Täglich", seconds: 86400 },
  { label: "Wöchentlich", seconds: 604800 },
  { label: "Alle 2 Wochen", seconds: 1209600 },
  { label: "Monatlich (30 T.)", seconds: 2592000 },
];

function isoToLocalInput(iso?: string): string {
  if (!hasDate(iso)) return "";
  const d = new Date(iso!);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date/time at rest shown as German text; only a click opens the native
 *  field.
 *
 * Warning: previously this was an `<input type="datetime-local">` — which
 * ALWAYS shows the browser's locale. On a phone it read as
 * `08/18/2026, 09:00 AM`, the empty state as `mm/dd/yyyy, --:-- --`.
 * For a German-speaking household that is simply wrong, and right next to it,
 * in the same app, the list said "vor 2 Tagen". Two languages for the same
 * thing — exactly the drift `lib/datumsWorte.ts` was built against.
 *
 * Important: the same pattern as in the knowledge table: a value is TEXT
 * first. The native field is good for picking and bad for reading — so we only
 * show it when someone wants to pick.
 */
function DatumFeld({ wert, onSetzen, mitZeit = true }: {
  wert?: string; onSetzen: (iso: string | null) => void; mitZeit?: boolean;
}) {
  const [offen, setOffen] = useState(false);
  const gesetzt = hasDate(wert);
  if (!offen) {
    return (
      <button className={styles.datumText} onClick={() => setOffen(true)}
              title={gesetzt ? "Ändern" : "Datum wählen"}>
        {gesetzt
          ? `${datumInWorten(wert)}${mitZeit ? `, ${new Date(wert!).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr` : ""}`
          : <span className={styles.datumLeer}>kein Datum</span>}
      </button>
    );
  }
  return (
    <input type={mitZeit ? "datetime-local" : "date"} className={styles.input} autoFocus
           value={isoToLocalInput(wert)}
           onBlur={() => setOffen(false)}
           onChange={(e) => {
             onSetzen(e.target.value ? new Date(e.target.value).toISOString() : null);
             setOffen(false);
           }} />
  );
}

export function TaskDetail({
  taskId, projectTitles, allTasks, onOpenTask, onClose, onChanged,
}: {
  taskId: number;
  projectTitles: Map<number, string>;
  /** For the dependency picker (client-side search). Optional — without
   * this prop dependencies stay read-only (compatible with older callers). */
  allTasks?: VikTask[];
  onOpenTask?: (id: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [task, setTask] = useState<VikTask | null>(null);
  const [comments, setComments] = useState<VikComment[]>([]);
  const [labels, setLabels] = useState<VikLabel[]>([]);
  const [members, setMembers] = useState<VikUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newItem, setNewItem] = useState("");
  const [newSubtask, setNewSubtask] = useState("");
  const [newComment, setNewComment] = useState("");
  const [attachments, setAttachments] = useState<VikAttachment[]>([]);
  const [taskCost, setTaskCost] = useState<TaskCost | null>(null);
  const [uploading, setUploading] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [linkDialog, setLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Serialises description mutations (checklist): two quick saves would
  // otherwise race — the second computes on stale state → lost update
  // (observed in E2E: append in flight + toggle = toggle lost).
  const descQueue = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      setError(null);
      const t = await plannerApi.getTask(taskId);
      setTask(t);
      const [cs, ls, ms, atts] = await Promise.all([
        plannerApi.listComments(taskId).catch(() => []),
        plannerApi.listLabels().then((x) => x || []).catch(() => []),
        plannerApi.projectUsers(t.project_id).catch(() => []),
        plannerApi.listAttachments(taskId).then((x) => x || []).catch(() => []),
      ]);
      setComments(cs || []);
      setLabels(ls);
      setMembers(ms || []);
      setAttachments(atts);
      // Actual costs (per-task row from the project costs endpoint) — soft:
      // clara-agent unreachable/no data → the section simply stays empty.
      plannerApi.projectCosts(t.project_id)
        .then((c) => setTaskCost(c.tasks.find((x) => x.task_id === taskId) ?? null))
        .catch(() => setTaskCost(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [taskId]);

  useEffect(() => { setTask(null); load(); }, [load]);

  const save = useCallback(async (patch: Partial<VikTask>) => {
    if (!task) return;
    try {
      const updated = await plannerApi.updateTask({ ...task, ...patch });
      setTask({ ...task, ...patch, ...updated, _meta: task._meta });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [task, onChanged, load]);

  const mutateDescription = useCallback((fn: (desc: string) => string) => {
    descQueue.current = descQueue.current
      .then(async () => {
        // read fresh from the server, apply the mutation there → no stale state
        const fresh = await plannerApi.getTask(taskId);
        const updated = await plannerApi.updateTask({ ...fresh, description: fn(fresh.description ?? "") });
        setTask((cur) => (cur ? { ...cur, description: updated.description } : cur));
        onChanged();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        load();
      });
  }, [taskId, onChanged, load]);

  const checklist = useMemo(() => parseChecklist(task?.description), [task?.description]);

  /** Write the whole links array — PUT /meta replaces `links` completely. */
  const saveLinks = useCallback(async (links: MetaLink[]) => {
    if (!task) return;
    try {
      await plannerApi.upsertMeta({ project_id: task.project_id, task_id: task.id, links });
      setTask((cur) => (cur ? {
        ...cur,
        _meta: { ...(cur._meta ?? { project_id: task.project_id, task_id: task.id }), links },
      } : cur));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [task, onChanged]);

  if (!task) {
    return (
      <aside className={styles.detail}>
        <div className={styles.detailHeader}>
          <button className={styles.btn} onClick={onClose}><Icon name="close" size={14} title="Schließen" /></button>
        </div>
        {error ? <div className={styles.errorBox}>{error}</div> : <div className={styles.loading}>Lade…</div>}
      </aside>
    );
  }

  const relBlockedBy = task.related_tasks?.blocked ?? [];
  const relBlocking = task.related_tasks?.blocking ?? [];
  const relSubtasks = task.related_tasks?.subtask ?? [];

  return (
    <aside className={styles.detail}>
      <div className={styles.detailHeader}>
        <button
          className={`${styles.checkBtn} ${task.done ? styles.checkBtnDone : ""}`}
          onClick={() => save({ done: !task.done })}
        >
          {task.done ? "✓" : ""}
        </button>
        <span className={styles.detailProject}>{projectTitles.get(task.project_id) ?? ""}</span>
        <button className={styles.btn} onClick={onClose}><Icon name="close" size={14} title="Schließen" /></button>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <input
        className={styles.detailTitle}
        value={titleDraft ?? task.title}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={() => {
          if (titleDraft != null && titleDraft.trim() && titleDraft !== task.title) save({ title: titleDraft.trim() });
          setTitleDraft(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />

      {task._meta?.in_work_by && (
        <div className={styles.detailInWork}>
          ● {task._meta.in_work_by} arbeitet hieran
          {task._meta.in_work_since && <> seit {new Date(task._meta.in_work_since).toLocaleString("de-DE")}</>}
          {/* Stale guard: the discipline is prompt-driven — stuck entries
              (session dead, finish_work forgotten) can be resolved manually. */}
          <button
            className={styles.btn}
            title="„Arbeitet hieran“ zurücksetzen (räumt auch den Worklog-Eintrag ab)"
            onClick={async () => {
              try {
                await plannerApi.finishWork(task.project_id, task.id, "manuell zurückgesetzt (UI)");
                setTask({ ...task, _meta: { ...task._meta, in_work_by: null, in_work_since: null } });
                onChanged();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Zurücksetzen
          </button>
        </div>
      )}

      {/* Checklist */}
      <section className={styles.detailSection}>
        <h4>Checkliste {checklist.items.length > 0 && `(${checklist.items.filter((i) => i.checked).length}/${checklist.items.length})`}</h4>
        {checklist.isHtml && <div className={styles.hint}>Beschreibung ist formatiert — Checkliste bitte im Planner-Backend bearbeiten.</div>}
        {checklist.items.map((it) => (
          <label key={it.line} className={styles.checkItem}>
            <input type="checkbox" checked={it.checked}
                   onChange={() => mutateDescription((d) => toggleChecklistLine(d, it.line))} />
            <span className={it.checked ? styles.checkItemDone : ""}>{it.text}</span>
          </label>
        ))}
        {!checklist.isHtml && (
          <div className={styles.quickAdd}>
            <input className={styles.input} placeholder="Punkt hinzufügen…" value={newItem}
                   onChange={(e) => setNewItem(e.target.value)}
                   onKeyDown={(e) => {
                     if (e.key === "Enter" && newItem.trim()) {
                       const text = newItem.trim();
                       mutateDescription((d) => appendChecklistItem(d, text));
                       setNewItem("");
                     }
                   }} />
          </div>
        )}
      </section>

      {/* Dates */}
      <section className={styles.detailSection}>
        <h4>Planung</h4>
        <div className={styles.fieldRow}>
          <label>Fällig</label>
          <DatumFeld wert={task.due_date}
                     onSetzen={(iso) => save({ due_date: iso ?? "0001-01-01T00:00:00Z" })} />
        </div>
        <div className={styles.fieldRow}>
          <label>Wiederholen</label>
          <select className={styles.select} value={task.repeat_after ?? 0}
                  onChange={(e) => save({ repeat_after: Number(e.target.value) })}>
            {REPEAT_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
            {task.repeat_after && !REPEAT_OPTIONS.some((o) => o.seconds === task.repeat_after)
              ? <option value={task.repeat_after}>Alle {Math.round(task.repeat_after / 86400)} Tage</option> : null}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label>Erinnerung</label>
          <DatumFeld wert={task.reminders?.[0]?.reminder}
                     onSetzen={(iso) => save({ reminders: iso ? [{ reminder: iso }] : [] })} />
        </div>
        <div className={styles.fieldRow}>
          <label>Einplanen</label>
          {task._meta?.event_uid ? (
            <span className={styles.scheduledRow}>
              <span className={styles.metaBadge}>📅 im Kalender ({task._meta.event_calendar ?? "?"})</span>
              <button className={styles.btn}
                      onClick={async () => {
                        try {
                          await plannerApi.unscheduleTask(task.id, task.project_id);
                          load(); onChanged();
                        } catch (e) { setError(String(e)); }
                      }}><Icon name="close" size={14} title="Schließen" /></button>
            </span>
          ) : (
            /* Important: show German text here too: a single field in
               browser format stands out more than four — it looks like a
               forgotten leftover, and that's what it would be. */
            <DatumFeld wert={undefined}
                       onSetzen={async (iso) => {
                         if (!iso) return;
                         try {
                           await plannerApi.scheduleTask(task.id, {
                             project_id: task.project_id, start: iso,
                           });
                           load(); onChanged();
                         } catch (err) { setError(String(err)); }
                       }} />
          )}
        </div>
        <div className={styles.fieldRow}>
          <label>Priorität</label>
          <select className={styles.select} value={task.priority ?? 0}
                  onChange={(e) => save({ priority: Number(e.target.value) })}>
            <option value={0}>Keine</option><option value={1}>Niedrig</option><option value={2}>Mittel</option>
            <option value={3}>Hoch</option><option value={4}>Dringend</option><option value={5}>SOFORT</option>
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label>Start</label>
          <DatumFeld wert={task.start_date}
                     onSetzen={(iso) => save({ start_date: iso ?? "0001-01-01T00:00:00Z" })} />
        </div>
        <div className={styles.fieldRow}>
          <label>Ende</label>
          <DatumFeld wert={task.end_date}
                     onSetzen={(iso) => save({ end_date: iso ?? "0001-01-01T00:00:00Z" })} />
        </div>
        <div className={styles.fieldRow}>
          <label>Fortschritt</label>
          {/* Vikunja stores percent_done as 0–1 (fraction), the UI shows percent. */}
          <select className={styles.select} value={Math.round((task.percent_done ?? 0) * 100)}
                  onChange={(e) => save({ percent_done: Number(e.target.value) / 100 })}>
            {Array.from({ length: 11 }, (_, i) => i * 10).map((p) => (
              <option key={p} value={p}>{p} %</option>
            ))}
          </select>
        </div>
      </section>

      {/* Labels */}
      <section className={styles.detailSection}>
        <h4>Tags</h4>
        <div className={styles.labelPicker}>
          {labels.map((l) => {
            const active = task.labels?.some((x) => x.id === l.id);
            return (
              <button key={l.id}
                      className={`${styles.labelChip} ${active ? styles.labelChipActive : ""}`}
                      style={l.hex_color ? { borderColor: `#${l.hex_color}` } : undefined}
                      onClick={async () => {
                        try {
                          if (active) await plannerApi.removeTaskLabel(task.id, l.id);
                          else await plannerApi.addTaskLabel(task.id, l.id);
                          load(); onChanged();
                        } catch (e) { setError(String(e)); }
                      }}>
                {l.title}
              </button>
            );
          })}
          <NewLabelInput onCreate={async (title) => {
            const l = await plannerApi.createLabel(title);
            await plannerApi.addTaskLabel(task.id, l.id);
            load(); onChanged();
          }} />
        </div>
      </section>

      {/* Assignment */}
      <section className={styles.detailSection}>
        <h4>Zugewiesen</h4>
        <div className={styles.labelPicker}>
          {(task.assignees ?? []).map((a) => (
            <button key={a.id} className={`${styles.labelChip} ${styles.labelChipActive}`}
                    title="Entfernen"
                    onClick={() => plannerApi.removeAssignee(task.id, a.id).then(() => { load(); onChanged(); })}>
              👤 {a.username} ✕
            </button>
          ))}
          {members.filter((m) => !task.assignees?.some((a) => a.id === m.id)).map((m) => (
            <button key={m.id} className={styles.labelChip}
                    onClick={() => plannerApi.addAssignee(task.id, m.id).then(() => { load(); onChanged(); })}>
              + {m.username}
            </button>
          ))}
        </div>
      </section>

      {/* Dependencies + subtasks (set/resolve) */}
      <section className={styles.detailSection}>
        <h4>Abhängigkeiten</h4>
        <RelationGroup
          label="⛔ Wird blockiert von:" items={relBlockedBy} kind="blocked"
          task={task} allTasks={allTasks} onOpenTask={onOpenTask}
          onMutated={() => { load(); onChanged(); }} onError={setError}
        />
        <RelationGroup
          label="⏳ Blockiert:" items={relBlocking} kind="blocking"
          task={task} allTasks={allTasks} onOpenTask={onOpenTask}
          onMutated={() => { load(); onChanged(); }} onError={setError}
        />
        <div className={styles.relGroup}>
          <span className={styles.relLabel}>Teilaufgaben:</span>
          {relSubtasks.map((r) => (
            <div key={r.id} className={`${styles.relItem} ${r.done ? styles.taskDone : ""}`}
                 onClick={() => onOpenTask?.(r.id)}
                 style={onOpenTask ? { cursor: "pointer" } : undefined}>
              {r.done ? "✓ " : "○ "}{r.title}
              <button className={styles.savedChipDel} title="Verknüpfung lösen"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await plannerApi.removeRelation(task.id, "subtask", r.id);
                          load(); onChanged();
                        } catch (err) { setError(String(err)); }
                      }}><Icon name="close" size={14} title="Schließen" /></button>
            </div>
          ))}
          <div className={styles.quickAdd}>
            <input className={styles.input} placeholder="Neue Teilaufgabe…" value={newSubtask}
                   onChange={(e) => setNewSubtask(e.target.value)}
                   onKeyDown={async (e) => {
                     if (e.key !== "Enter" || !newSubtask.trim()) return;
                     const title = newSubtask.trim();
                     setNewSubtask("");
                     try {
                       const created = await plannerApi.createTask(task.project_id, { title });
                       await plannerApi.addRelation(task.id, created.id, "subtask");
                       load(); onChanged();
                     } catch (err) { setError(String(err)); }
                   }} />
          </div>
        </div>
      </section>

      {/* Attachments (Vikunja) + cross-app links (sidecar links JSONB) */}
      <section className={styles.detailSection}>
        <h4>Anhänge & Links</h4>
        {attachments.map((a) => (
          <div key={a.id} className={styles.attachRow}>
            <a className={styles.attachName}
               href={plannerApi.attachmentUrl(task.id, a.id)} download={a.file?.name}>
              📎 {a.file?.name ?? `Anhang #${a.id}`}
            </a>
            {a.file?.size != null && <span className={styles.metaBadge}>{formatBytes(a.file.size)}</span>}
            <button className={styles.savedChipDel} title="Anhang löschen"
                    onClick={async () => {
                      if (!window.confirm(`Anhang „${a.file?.name ?? a.id}“ löschen?`)) return;
                      try {
                        await plannerApi.deleteAttachment(task.id, a.id);
                        load();
                      } catch (e) { setError(String(e)); }
                    }}><Icon name="close" size={14} title="Schließen" /></button>
          </div>
        ))}
        {(task._meta?.links ?? []).map((l, i) => (
          <div key={`${l.uri}-${i}`} className={styles.attachRow}>
            <button className={styles.attachName} onClick={() => openMetaLink(l)}>
              {linkIcon(l)} {l.label || l.uri}
            </button>
            {(l.kind === "url" || l.kind === "file") && (
              <button className={styles.savedChipDel} title="Link entfernen"
                      onClick={() => saveLinks((task._meta?.links ?? []).filter((_, j) => j !== i))}><Icon name="close" size={14} title="Schließen" /></button>
            )}
          </div>
        ))}
        <div className={styles.labelPicker}>
          <button className={styles.labelChip} disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}>
            {uploading ? "Lädt hoch…" : "⬆ Datei hochladen"}
          </button>
          <button className={styles.labelChip} onClick={() => setFilePicker(true)}>🗂 Aus Dateien…</button>
          <button className={styles.labelChip} onClick={() => { setLinkUrl(""); setLinkLabel(""); setLinkDialog(true); }}>
            🔗 Link…
          </button>
          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
                 onChange={async (e) => {
                   const files = Array.from(e.target.files ?? []);
                   e.target.value = "";
                   if (!files.length) return;
                   setUploading(true);
                   try {
                     await plannerApi.uploadAttachments(task.id, files);
                     load();
                   } catch (err) {
                     setError(err instanceof Error ? err.message : String(err));
                   } finally {
                     setUploading(false);
                   }
                 }} />
        </div>
      </section>

      {/* Effort: actual costs (clara-agent by-ref) + estimates (sidecar) */}
      {(taskCost != null || task._meta?.estimate_eur != null || task._meta?.estimate_minutes != null || task._meta?.estimate_tokens != null) && (
        <section className={styles.detailSection}>
          <h4>Aufwand</h4>
          {taskCost != null && (taskCost.cost_eur != null || taskCost.worked_minutes != null) && (
            <div className={styles.estimates}>
              <span className={styles.metaBadge}>
                Ist: {fmtEur(taskCost.cost_eur)}
                {taskCost.estimate_eur != null && taskCost.cost_eur != null && taskCost.cost_eur > taskCost.estimate_eur ? " ⚠" : ""}
              </span>
              {taskCost.input_tokens != null && (
                <span className={styles.metaBadge}>🪙 {fmtTokens((taskCost.input_tokens || 0) + (taskCost.output_tokens || 0))} Tokens</span>
              )}
              {taskCost.worked_minutes != null && <span className={styles.metaBadge}>⏱ gearbeitet: {fmtMins(taskCost.worked_minutes)}</span>}
              {taskCost.open_sessions > 0 && <span className={styles.inWorkBadge}>● arbeitet</span>}
            </div>
          )}
          {(task._meta?.estimate_eur != null || task._meta?.estimate_minutes != null || task._meta?.estimate_tokens != null) && (
            <div className={styles.estimates}>
              <span className={styles.metaBadge}>Schätzung:</span>
              {task._meta?.estimate_minutes != null && <span className={styles.metaBadge}>⏱ {task._meta.estimate_minutes} min</span>}
              {task._meta?.estimate_eur != null && <span className={styles.metaBadge}>💶 {task._meta.estimate_eur.toFixed(2)} €</span>}
              {task._meta?.estimate_tokens != null && <span className={styles.metaBadge}>🪙 {task._meta.estimate_tokens.toLocaleString("de-DE")} Tokens</span>}
            </div>
          )}
        </section>
      )}

      {/* Description (plain text, pre-wrap — house style) */}
      <section className={styles.detailSection}>
        <h4>Notizen</h4>
        <textarea
          className={styles.textarea}
          rows={4}
          placeholder="Beschreibung / Notizen…"
          value={descDraft ?? task.description ?? ""}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => {
            if (descDraft != null && descDraft !== (task.description ?? "")) save({ description: descDraft });
            setDescDraft(null);
          }}
        />
      </section>

      {/* Comments */}
      <section className={styles.detailSection}>
        <h4>Kommentare</h4>
        {comments.map((c) => (
          <div key={c.id} className={styles.comment}>
            <span className={styles.commentAuthor}>{c.author?.username ?? "?"}</span>
            {c.created && <span className={styles.commentTime}>{new Date(c.created).toLocaleString("de-DE")}</span>}
            <div className={styles.commentBody}>{c.comment.replace(/<[^>]+>/g, "")}</div>
          </div>
        ))}
        <div className={styles.quickAdd}>
          <input className={styles.input} placeholder="Kommentar…" value={newComment}
                 onChange={(e) => setNewComment(e.target.value)}
                 onKeyDown={async (e) => {
                   if (e.key === "Enter" && newComment.trim()) {
                     await plannerApi.addComment(task.id, newComment.trim());
                     setNewComment("");
                     load();
                   }
                 }} />
        </div>
      </section>

      {linkDialog && (
        <div className={styles.dialogOverlay} onClick={() => setLinkDialog(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3>Link anhängen</h3>
            <input className={styles.input} autoFocus placeholder="https://…" value={linkUrl}
                   onChange={(e) => setLinkUrl(e.target.value)} />
            <input className={styles.input} placeholder="Bezeichnung (optional)" value={linkLabel}
                   onChange={(e) => setLinkLabel(e.target.value)} />
            <div className={styles.dialogActions}>
              <button className={styles.btn} onClick={() => setLinkDialog(false)}>Abbrechen</button>
              <button className={styles.btnPrimary} disabled={!linkUrl.trim()}
                      onClick={() => {
                        const uri = linkUrl.trim();
                        setLinkDialog(false);
                        saveLinks([...(task._meta?.links ?? []),
                                   { kind: "url", uri, label: linkLabel.trim() || uri }]);
                      }}>
                Anhängen
              </button>
            </div>
          </div>
        </div>
      )}

      <FilePickerModal
        open={filePicker}
        onClose={() => setFilePicker(false)}
        onPickRefs={(refs: PickedRef[]) => {
          const add: MetaLink[] = refs.map((r) => ({
            kind: "file", uri: `claraos-file://${r.source}${r.path}`, label: r.name,
          }));
          saveLinks([...(task._meta?.links ?? []), ...add]);
        }}
      />

      <div className={styles.detailFooter}>
        {hasDate(task.due_date) && <span>Fällig: {dueLabel(task.due_date)}</span>}
        <button className={styles.btnDanger}
                onClick={async () => {
                  if (window.confirm(`Aufgabe „${task.title}“ löschen?`)) {
                    await plannerApi.deleteTask(task.id);
                    onChanged();
                    onClose();
                  }
                }}>
          Löschen
        </button>
      </div>
    </aside>
  );
}

function linkIcon(l: MetaLink): string {
  switch (l.kind) {
    // The task contributes to a goal in the Ideas app.
    case "goal": return "🎯";
    case "file": return "🗂";
    case "url": return "🔗";
    case "mail": return "✉️";
    case "chat": return "💬";
    case "event": return "📅";
    default: return "🔗";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Open a cross-app link: claraos-file:// → file browser window at the
 * parent folder; everything else → new tab. */
function openMetaLink(l: MetaLink): void {
  // A goal link leads back into the Ideas app instead of handing the
  // claraos:// address to the browser (which doesn't know the scheme).
  if (l.kind === "goal" && l.uri.startsWith("claraos://ideas/object/")) {
    const objectId = l.uri.slice("claraos://ideas/object/".length);
    sessionStorage.setItem("claraos.ideas.openObject", objectId);
    useWindowsStore.getState().openWindow("ideas", { title: "Ideen" });
    return;
  }
  if (l.kind === "file" && l.uri.startsWith("claraos-file://")) {
    const rest = l.uri.slice("claraos-file://".length);
    const slash = rest.indexOf("/");
    const source = slash === -1 ? rest : rest.slice(0, slash);
    const filePath = slash === -1 ? "/" : rest.slice(slash);
    const parent = filePath.split("/").slice(0, -1).join("/") || "/";
    useWindowsStore.getState().openWindow("file-browser", { source, path: parent });
    return;
  }
  // Mail bridge: a linked email opens in the shell's mail window
  // (deep link into the Mail app), not in a new tab.
  if (l.kind === "mail" && /^https:\/\/mail\.[^/]+\//.test(l.uri)) {
    void ausfuehrenLokal("navigate_to", { app_id: "bulwark-mail", url: l.uri });
    return;
  }
  window.open(l.uri, "_blank", "noopener");
}

/** A relation group (blocked/blocking): entries with ✕ + "+" picker. */
function RelationGroup({
  label, items, kind, task, allTasks, onOpenTask, onMutated, onError,
}: {
  label: string;
  items: VikTask[];
  kind: "blocked" | "blocking";
  task: VikTask;
  allTasks?: VikTask[];
  onOpenTask?: (id: number) => void;
  onMutated: () => void;
  onError: (msg: string) => void;
}) {
  if (items.length === 0 && !allTasks?.length) return null;
  return (
    <div className={styles.relGroup}>
      <span className={styles.relLabel}>{label}</span>
      {items.map((r) => (
        <div key={r.id} className={`${styles.relItem} ${r.done ? styles.taskDone : ""}`}
             onClick={() => onOpenTask?.(r.id)}
             style={onOpenTask ? { cursor: "pointer" } : undefined}>
          {r.done ? "✓ " : "○ "}{r.title}
          <button className={styles.savedChipDel} title="Verknüpfung lösen"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await plannerApi.removeRelation(task.id, kind, r.id);
                      onMutated();
                    } catch (err) { onError(String(err)); }
                  }}><Icon name="close" size={14} title="Schließen" /></button>
        </div>
      ))}
      {allTasks && allTasks.length > 0 && (
        <TaskPicker
          allTasks={allTasks}
          exclude={[task.id, ...items.map((r) => r.id)]}
          onPick={async (other) => {
            try {
              await plannerApi.addRelation(task.id, other.id, kind);
              onMutated();
            } catch (err) { onError(String(err)); }
          }}
        />
      )}
    </div>
  );
}

/** Client-side task search (max. 8 hits) for relations. */
function TaskPicker({
  allTasks, exclude, onPick,
}: {
  allTasks: VikTask[];
  exclude: number[];
  onPick: (t: VikTask) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  if (!editing) {
    return <button className={styles.labelChip} onClick={() => setEditing(true)}>+ Aufgabe verknüpfen</button>;
  }
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? allTasks
        .filter((t) => !t.done && !exclude.includes(t.id) && t.title.toLowerCase().includes(needle))
        .slice(0, 8)
    : [];
  return (
    <div className={styles.pickerWrap}>
      <input className={styles.input} autoFocus placeholder="Aufgabe suchen…" value={q}
             onChange={(e) => setQ(e.target.value)}
             onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setQ(""))} />
      {hits.length > 0 && (
        <div className={styles.pickerPop}>
          {hits.map((t) => (
            <button key={t.id} className={styles.pickerItem}
                    onClick={async () => {
                      setEditing(false); setQ("");
                      await onPick(t);
                    }}>
              {t.title}
            </button>
          ))}
        </div>
      )}
      <button className={styles.btn} onClick={() => { setEditing(false); setQ(""); }}><Icon name="close" size={14} title="Schließen" /></button>
    </div>
  );
}

function NewLabelInput({ onCreate }: { onCreate: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  if (!editing) {
    return <button className={styles.labelChip} onClick={() => setEditing(true)}>+ Tag</button>;
  }
  return (
    <input className={styles.inputSmall} autoFocus placeholder="Neuer Tag…" value={val}
           onChange={(e) => setVal(e.target.value)}
           onBlur={() => { setEditing(false); setVal(""); }}
           onKeyDown={async (e) => {
             if (e.key === "Enter" && val.trim()) {
               await onCreate(val.trim());
               setEditing(false); setVal("");
             }
             if (e.key === "Escape") { setEditing(false); setVal(""); }
           }} />
  );
}
