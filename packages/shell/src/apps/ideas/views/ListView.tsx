/** Ideen-/Objekt-Liste — filterbar nach Stage + Volltext (Muster planner/TasksView). */
import { useMemo, useState } from "react";
import styles from "../IdeasApp.module.css";
import { Icon } from "../../../components/Icon";
import type { KbObjectSlim, Stage } from "../types";
import { STAGES, STAGE_BY_KEY } from "../stages";

interface Props {
  ideas: KbObjectSlim[];
  currentUser: string;
  onOpen: (id: string) => void;
}

export function ListView({ ideas, currentUser, onOpen }: Props) {
  const [stageFilter, setStageFilter] = useState<Stage | "all">("all");
  const [q, setQ] = useState("");
  const [mineOnly, setMineOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ideas.filter((i) => {
      if (stageFilter !== "all" && (i.stage ?? "spark") !== stageFilter) return false;
      if (mineOnly && i.owner !== currentUser) return false;
      if (needle && !`${i.title} ${i.body_preview}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [ideas, stageFilter, q, mineOnly, currentUser]);

  return (
    <div className={styles.listView}>
      <div className={styles.listFilters}>
        <input
          className={styles.input}
          placeholder="Filtern…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className={styles.input}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as Stage | "all")}
        >
          <option value="all">Alle Stufen</option>
          {STAGES.map((s) => (
            <option key={s.key} value={s.key}><Icon name={s.iconName} size={14} /> {s.label}</option>
          ))}
        </select>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Nur meine
        </label>
      </div>
      <div className={styles.listRows}>
        {filtered.map((i) => {
          const st = STAGE_BY_KEY[i.stage ?? "spark"];
          return (
            <button key={i.id} className={styles.listRow} onClick={() => onOpen(i.id)}>
              <span className={styles.stageBadge} style={{ background: st?.color }}>
                <Icon name={st?.iconName ?? "idea"} size={14} /> {st?.label}
              </span>
              <span className={styles.listTitle}>{i.title}</span>
              <span className={styles.listMeta}>
                {i.visibility === "family" && "👪 "}
                {i.owner !== currentUser ? `${i.owner} · ` : ""}
                {new Date(i.updated_at).toLocaleDateString("de-DE")}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className={styles.empty}>Keine Ideen gefunden — leg mit „＋ Idee" los.</div>
        )}
      </div>
    </div>
  );
}
