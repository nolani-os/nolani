/** Ideas board — Kanban by maturity stage (pattern: planner/views/BoardView, HTML5 DnD).
 * Mobile: columns scroll horizontally with scroll snap; stages can also be changed
 * via the stepper in the detail view (touch DnD is unreliable). */
import { useTranslation } from "@claraos/core";
import { useState } from "react";
import styles from "../IdeasApp.module.css";
import { Icon } from "../../../components/Icon";
import type { KbObjectSlim, Stage } from "../types";
import { BOARD_STAGES } from "../stages";

interface Props {
  ideas: KbObjectSlim[];
  currentUser: string;
  onOpen: (id: string) => void;
  onMove: (id: string, stage: Stage) => void;
}

export function BoardView({ ideas, currentUser, onOpen, onMove }: Props) {
  const { t } = useTranslation("wissen");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<Stage | null>(null);

  return (
    <div className={styles.board}>
      {BOARD_STAGES.map((st) => {
        const cards = ideas.filter((i) => (i.stage ?? "spark") === st.key);
        return (
          <div
            key={st.key}
            className={`${styles.boardCol} ${dropStage === st.key ? styles.boardColDrop : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDropStage(st.key); }}
            onDragLeave={() => setDropStage((cur) => (cur === st.key ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              setDropStage(null);
              const id = e.dataTransfer.getData("text/kb-object-id") || dragId;
              if (id) onMove(id, st.key);
            }}
          >
            <div className={styles.boardColHead} style={{ borderTopColor: st.color }}>
              <span><Icon name={st.iconName} size={14} /> {st.label}</span>
              <span className={styles.boardCount}>{cards.length}</span>
            </div>
            <div className={styles.boardCards}>
              {cards.map((idea) => (
                <div
                  key={idea.id}
                  className={styles.card}
                  draggable={idea.owner === currentUser}
                  onDragStart={(e) => {
                    setDragId(idea.id);
                    e.dataTransfer.setData("text/kb-object-id", idea.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => onOpen(idea.id)}
                >
                  <div className={styles.cardTitle}>{idea.title}</div>
                  {idea.body_preview && (
                    <div className={styles.cardPreview}>{idea.body_preview}</div>
                  )}
                  <div className={styles.cardMeta}>
                    {idea.visibility === "family" && <span title={t("views.board.family")}>👪</span>}
                    {idea.owner !== currentUser && (
                      <span className={styles.cardOwner}>{idea.owner}</span>
                    )}
                    {idea.created_by === "clara" && <span title={t("views.board.byAssistant")}>🤖</span>}
                  </div>
                </div>
              ))}
              {cards.length === 0 && <div className={styles.colEmpty}>—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
