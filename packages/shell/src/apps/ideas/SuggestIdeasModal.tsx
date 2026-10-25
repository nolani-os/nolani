/** "Clara, what could I do?": idea suggestions for a goal.
 *
 * Suggestions are NOT saved automatically. The person accepts them one by
 * one: an idea space that fills up with unrequested objects quickly becomes
 * worthless, and an off-target suggestion must leave no trace. */
import { useTranslation, i18n } from "@claraos/core";
import { useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { IdeaProposal } from "./types";

interface Props {
  goalId: string;
  goalTitle: string;
  onClose: () => void;
  onAccepted: () => void;
}

export function SuggestIdeasModal({ goalId, goalTitle, onClose, onAccepted }: Props) {
  const { t } = useTranslation("wissen");
  const [ideas, setIdeas] = useState<IdeaProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());

  const ask = async (n = 5) => {
    setBusy(true);
    setError(null);
    try {
      setIdeas(await ideasApi.suggestIdeas(goalId, n));
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:fiveWhy.noAnswer"));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (p: IdeaProposal) => {
    setBusy(true);
    try {
      await ideasApi.acceptIdea(goalId, p);
      setTaken((s) => new Set(s).add(p.title));
      onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:suggest.takeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="idea" size={16} className={styles.inlineIcon} />{t("suggest.title", { goal: goalTitle })}</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>

        {ideas === null && !busy && (
          <p className={styles.metaHint}>
            {t("suggest.intro")}
          </p>
        )}
        {busy && <p className={styles.metaHint}>{t("fiveWhy.thinking")}</p>}
        {error && <div className={styles.error}>{error}</div>}

        {ideas && (
          <ul className={styles.proposalList}>
            {ideas.map((p) => (
              <li key={p.title} className={taken.has(p.title) ? styles.proposalTaken : ""}>
                <div>
                  <strong>{p.title}</strong>
                  <p className={styles.metaHint}>{p.why}</p>
                  <span className={styles.metaHint}>
                    {t("suggest.rating", { impact: p.impact, effort: p.effort })}
                  </span>
                </div>
                <button className={styles.btnPrimary} disabled={busy || taken.has(p.title)}
                        onClick={() => void accept(p)}>
                  {taken.has(p.title) ? t("suggest.taken") : t("suggest.take")}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.modalFoot}>
          <button className={styles.btnGhost} disabled={busy} onClick={() => void ask(5)}>
            {ideas ? t("suggest.more") : t("suggest.fetch")}
          </button>
        </div>
      </div>
    </div>
  );
}
