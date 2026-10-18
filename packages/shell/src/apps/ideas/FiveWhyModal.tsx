/** 5 Whys as a guided dialog.
 *
 * Deliberately step by step: Clara asks the question and offers candidates,
 * but **the answer comes from the person**. A model that invents five levels
 * by itself produces plausible prose instead of a root cause, and that is
 * exactly where most "AI kaizen" tools fail. */
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
      setError(e instanceof Error ? e.message : "Clara antwortet gerade nicht");
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
      setError(e instanceof Error ? e.message : "Auswertung fehlgeschlagen");
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="search" size={16} className={styles.inlineIcon} />Ursache suchen — „{goal.title}"</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title="Schließen" /></button>
        </div>

        {!started ? (
          <>
            <p className={styles.metaHint}>
              Beschreibe in einem Satz, was konkret nicht läuft. Clara fragt dann fünfmal
              „warum?" — antworten musst du, denn du kennst die Lage. Sie schlägt jeweils
              ein paar Möglichkeiten vor, die du übernehmen oder überschreiben kannst.
            </p>
            <input className={styles.input} autoFocus value={problem}
                   placeholder="Was läuft nicht? (z. B. Wir verpassen regelmäßig Abgabetermine)"
                   onChange={(e) => setProblem(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") void start(); }} />
            <div className={styles.modalFoot}>
              <button className={styles.btnPrimary} disabled={!problem.trim()}
                      onClick={() => void start()}>Los</button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.whyProblem}><strong>Problem:</strong> {problem}</p>

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

            {busy && <p className={styles.metaHint}>Clara denkt nach…</p>}
            {error && <div className={styles.error}>{error}</div>}
            {note && <p className={styles.metaHint}>{note}</p>}

            {!done && question && (
              <div className={styles.whyStep}>
                <strong>{chain.length + 1}. Warum? {question}</strong>
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
                          placeholder="Deine Antwort (Vorschlag anklicken und anpassen geht auch)"
                          onChange={(e) => setAnswer(e.target.value)} />
                <button className={styles.btnPrimary} disabled={busy || !answer.trim()}
                        onClick={() => void submitAnswer()}>Weiter</button>
              </div>
            )}

            <div className={styles.modalFoot}>
              {chain.length > 0 && (
                <button className={styles.btnPrimary} disabled={busy} onClick={() => void finish()}>
                  {done ? "Auswerten und speichern" : "Hier abbrechen und auswerten"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
