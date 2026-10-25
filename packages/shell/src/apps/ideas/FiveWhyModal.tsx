/** 5 Whys as a guided dialog.
 *
 * Deliberately step by step: Clara asks the question and offers candidates,
 * but **the answer comes from the person**. A model that invents five levels
 * by itself produces plausible prose instead of a root cause, and that is
 * exactly where most "AI kaizen" tools fail. */
import { i18n, useTranslation } from "@claraos/core";
import { useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { GoalNode, WhyLink } from "./types";

interface Props {
  goal: GoalNode;
  onClose: () => void;
  onDone: () => void;
}

export function FiveWhyModal({ goal, onClose, onDone }: Props) {
  const { t } = useTranslation("wissen");
  const [problem, setProblem] = useState("");
  const [started, setStarted] = useState(false);
  const [chain, setChain] = useState<WhyLink[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [done, setDone] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextStep = async (nextChain: WhyLink[]) => {
    setBusy(true);
    setError(null);
    try {
      const r = await ideasApi.fiveWhyStep(goal.id, problem, nextChain);
      setQuestion(r.question);
      setCandidates(r.candidates);
      setDone(r.done);
      setNote(r.note);
      setAnswer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:fiveWhy.noAnswer"));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!problem.trim()) return;
    setStarted(true);
    await nextStep([]);
  };

  const submitAnswer = async () => {
    if (!answer.trim() || !question) return;
    const next = [...chain, { question, answer: answer.trim() }];
    setChain(next);
    await nextStep(next);
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await ideasApi.fiveWhyFinish(goal.id, problem, chain);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:fiveWhy.evalFailed"));
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="search" size={16} className={styles.inlineIcon} />{t("fiveWhy.title", { goal: goal.title })}</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>

        {!started ? (
          <>
            <p className={styles.metaHint}>
              {t("fiveWhy.intro")}
            </p>
            <input className={styles.input} autoFocus value={problem}
                   placeholder={t("fiveWhy.placeholder")}
                   onChange={(e) => setProblem(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") void start(); }} />
            <div className={styles.modalFoot}>
              <button className={styles.btnPrimary} disabled={!problem.trim()}
                      onClick={() => void start()}>{t("fiveWhy.go")}</button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.whyProblem}><strong>{t("fiveWhy.problem")}</strong> {problem}</p>

            {chain.length > 0 && (
              <ol className={styles.whyChain}>
                {chain.map((c, i) => (
                  <li key={i}>
                    <span className={styles.metaHint}>{c.question}</span>
                    <div>→ {c.answer}</div>
                  </li>
                ))}
              </ol>
            )}

            {busy && <p className={styles.metaHint}>{t("fiveWhy.thinking")}</p>}
            {error && <div className={styles.error}>{error}</div>}
            {note && <p className={styles.metaHint}>{note}</p>}

            {!done && question && (
              <div className={styles.whyStep}>
                <strong>{t("fiveWhy.why", { n: chain.length + 1, question })}</strong>
                {candidates.length > 0 && (
                  <div className={styles.whyCandidates}>
                    {candidates.map((c) => (
                      <button key={c} className={styles.btnGhost} onClick={() => setAnswer(c)}>
                        {c}
                      </button>
                    ))}
                  </div>
                )}
                <textarea className={styles.input} rows={2} value={answer} autoFocus
                          placeholder={t("fiveWhy.answer")}
                          onChange={(e) => setAnswer(e.target.value)} />
                <button className={styles.btnPrimary} disabled={busy || !answer.trim()}
                        onClick={() => void submitAnswer()}>{t("fiveWhy.next")}</button>
              </div>
            )}

            <div className={styles.modalFoot}>
              {chain.length > 0 && (
                <button className={styles.btnPrimary} disabled={busy} onClick={() => void finish()}>
                  {done ? t("fiveWhy.finish") : t("fiveWhy.abort")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
