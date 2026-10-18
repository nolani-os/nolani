/** Kaizen on a goal: root-cause analysis when progress stalls.
 *
 * **Triggered, not a menu item.** The panel only appears when the goal is
 * behind or at risk; tools you have to hunt for in a menu get used by nobody.
 * For "blind" it deliberately offers NO root-cause analysis: there the cause
 * is the missing measurement, not the matter itself.
 *
 * Both methods depend on the person's knowledge. Clara asks the questions and
 * does the math; she invents neither causes nor numbers. */
import { useCallback, useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { Analysis, GoalNode } from "./types";
import { FiveWhyModal } from "./FiveWhyModal";
import { ParetoModal } from "./ParetoModal";

interface Props {
  goal: GoalNode;
  canEdit: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

export function KaizenPanel({ goal, canEdit, onOpen, onChanged }: Props) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [mode, setMode] = useState<"why" | "pareto" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const status = goal.progress.status;
  const stockt = status === "behind" || status === "at_risk";

  const load = useCallback(async () => {
    try {
      setAnalyses(await ideasApi.goalAnalyses(goal.id));
    } catch {
      /* Analyses are secondary; an error here must not disturb the goal tree */
    }
  }, [goal.id]);

  useEffect(() => { void load(); }, [load]);

  if (!stockt && analyses.length === 0) return null;

  const toTask = async (title: string, why?: string) => {
    try {
      await ideasApi.addPlanTask(goal.id, title, why);
      setNote(`„${title}" steht jetzt im Aktionsplan.`);
      onChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Übernahme fehlgeschlagen");
    }
  };

  return (
    <div className={styles.kaizenPanel}>
      {stockt && (
        <div className={styles.kaizenHead}>
          <span>
            <><Icon name={status === "behind" ? "behind" : "at_risk"} size={16} className={styles.inlineIcon} />{status === "behind" ? "Dieses Ziel ist hinterher." : "Dieses Ziel wackelt."}</>
            {" "}Die Frage ist, woran es liegt.
          </span>
          {canEdit && (
            <span>
              <button className={styles.btnGhost} onClick={() => setMode("why")}>
                Ursache suchen (5-Why)
              </button>
              <button className={styles.btnGhost} onClick={() => setMode("pareto")}>
                Pareto
              </button>
            </span>
          )}
        </div>
      )}

      {note && <p className={styles.metaHint}>{note}</p>}

      {analyses.length > 0 && (
        <ul className={styles.analysisList}>
          {analyses.map((a) => (
            <li key={a.id}>
              <button className={styles.linkBtn} onClick={() => onOpen(a.id)}>
                <Icon name={a.method === "pareto" ? "dashboard" : "analysis"} size={15} className={styles.inlineIcon} />{a.title}
              </button>
              <span className={styles.metaHint}>
                {new Date(a.created_at).toLocaleDateString("de-DE")}
              </span>
              {a.root_cause && <p className={styles.metaHint}>Grundursache: {a.root_cause}</p>}
              {a.vital_few.length > 0 && (
                <p className={styles.metaHint}>Die wenigen Wichtigen: {a.vital_few.join(", ")}</p>
              )}
              {canEdit && a.countermeasures.length > 0 && (
                <ul className={styles.counterList}>
                  {a.countermeasures.map((m) => (
                    <li key={m.title}>
                      <span>{m.title}</span>
                      <button className={styles.btnGhost}
                              onClick={() => void toTask(m.title, m.why)}>
                        → Aktionsplan
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {mode === "why" && (
        <FiveWhyModal goal={goal} onClose={() => setMode(null)}
                      onDone={() => { setMode(null); void load(); onChanged(); }} />
      )}
      {mode === "pareto" && (
        <ParetoModal goal={goal} onClose={() => setMode(null)}
                     onDone={() => { setMode(null); void load(); onChanged(); }} />
      )}
    </div>
  );
}
