/** Projects — card overview + create + manage (rename, colour,
 * description, archive/reactivate, delete). */
import { useState } from "react";
import { useTranslation } from "@claraos/core";
import styles from "../PlannerApp.module.css";
import { plannerApi } from "../api";
import type { VikProject } from "../types";

/** Small palette in Vikunja style; free-form hex works as well. */
const COLORS = ["", "e74c3c", "e67e22", "f1c40f", "2ecc71", "1abc9c", "3498db", "9b59b6", "e91e63", "607d8b"];

export function ProjectsView({
  projects, onOpenProject, onReload,
}: {
  projects: VikProject[]; // ALL projects including archived ones
  onOpenProject: (p: VikProject) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation("planner");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<VikProject | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = projects.filter((p) => !p.is_archived);
  const archived = projects.filter((p) => p.is_archived);

  const create = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const p = await plannerApi.createProject(name);
      setTitle("");
      setCreating(false);
      onReload();
      onOpenProject(p);
    } finally {
      setBusy(false);
    }
  };

  const card = (p: VikProject) => (
    <div key={p.id} className={`${styles.projectCard} ${p.is_archived ? styles.projectArchived : ""}`}
         role="button" tabIndex={0}
         onClick={() => !p.is_archived && onOpenProject(p)}>
      <span className={styles.projectCardDot}
            style={p.hex_color ? { background: `#${p.hex_color}` } : undefined} />
      <span className={styles.projectCardTitle}>{p.title}</span>
      {p.description && <span className={styles.projectCardDesc}>{p.description.replace(/<[^>]+>/g, "")}</span>}
      <button className={styles.projectCardMenu} title={t("projects.manage")}
              onClick={(e) => { e.stopPropagation(); setEditing(p); }}>
        ⋯
      </button>
    </div>
  );

  return (
    <div className={styles.view}>
      <header className={styles.viewHeader}>
        <h2>📋 {t("nav.projects")}</h2>
        <div className={styles.viewTools}>
          {archived.length > 0 && (
            <button className={`${styles.btn} ${showArchived ? styles.btnActive : ""}`}
                    onClick={() => setShowArchived((s) => !s)}>
              🗄 {t("projects.archiveCount", { count: archived.length })}
            </button>
          )}
          <button className={styles.btnPrimary} onClick={() => setCreating(true)}>+ {t("projects.newProject")}</button>
        </div>
      </header>
      {error && (
        <div className={styles.errorBox}>
          {error} <button className={styles.btn} onClick={() => setError(null)}>{t("actions.ok")}</button>
        </div>
      )}
      <div className={styles.projectGrid}>
        {active.map(card)}
        {active.length === 0 && <div className={styles.empty}>{t("projects.empty")}</div>}
      </div>
      {showArchived && archived.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("projects.archived")}</h3>
          <div className={styles.projectGrid}>{archived.map(card)}</div>
        </section>
      )}

      {creating && (
        <div className={styles.dialogOverlay} onClick={() => setCreating(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3>{t("projects.newProject")}</h3>
            <input className={styles.input} autoFocus placeholder={t("projects.namePlaceholder")}
                   value={title} onChange={(e) => setTitle(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && create()} />
            <div className={styles.dialogActions}>
              <button className={styles.btn} onClick={() => setCreating(false)}>{t("actions.cancel")}</button>
              <button className={styles.btnPrimary} disabled={!title.trim() || busy} onClick={create}>{t("actions.create")}</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <ProjectEditDialog
          project={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onReload(); }}
          onError={(m) => { setError(m); setEditing(null); }}
        />
      )}
    </div>
  );
}

function ProjectEditDialog({
  project, onClose, onDone, onError,
}: {
  project: VikProject;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation("planner");
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description?.replace(/<[^>]+>/g, "") ?? "");
  const [color, setColor] = useState(project.hex_color ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(() => plannerApi.updateProjectFields(project.id, {
    title: title.trim() || project.title,
    description,
    hex_color: color.replace(/^#/, ""),
  }));

  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3>{t("projects.manage")}</h3>
        <div className={styles.fieldRow}>
          <label>{t("projects.name")}</label>
          <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label>{t("projects.description")}</label>
          <textarea className={styles.textarea} rows={2} value={description}
                    onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label>{t("projects.color")}</label>
          <span className={styles.colorRow}>
            {COLORS.map((c) => (
              <button key={c || "none"}
                      className={`${styles.colorSwatch} ${color.replace(/^#/, "") === c ? styles.colorSwatchActive : ""}`}
                      style={c ? { background: `#${c}` } : undefined}
                      title={c ? `#${c}` : t("projects.noColor")}
                      onClick={() => setColor(c)}>
                {c ? "" : "∅"}
              </button>
            ))}
            <input className={styles.inputSmall} placeholder={t("projects.hexPlaceholder")} value={color}
                   onChange={(e) => setColor(e.target.value)} />
          </span>
        </div>
        <div className={styles.dialogActions}>
          <button className={styles.btn} disabled={busy}
                  onClick={() => run(() => plannerApi.updateProjectFields(project.id, { is_archived: !project.is_archived }))}>
            {project.is_archived ? `♻ ${t("projects.reactivate")}` : `🗄 ${t("projects.archive")}`}
          </button>
          {confirmDelete ? (
            <button className={styles.btnDanger} disabled={busy}
                    onClick={() => run(() => plannerApi.deleteProject(project.id))}>
              {t("projects.confirmDelete")}
            </button>
          ) : (
            <button className={styles.btnDanger} disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t("actions.delete")}
            </button>
          )}
        </div>
        <div className={styles.dialogActions}>
          <button className={styles.btn} onClick={onClose}>{t("actions.cancel")}</button>
          <button className={styles.btnPrimary} disabled={busy || !title.trim()} onClick={save}>{t("actions.save")}</button>
        </div>
      </div>
    </div>
  );
}
