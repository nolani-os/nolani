/**
 * Dialog card of the guided tour (tooltipComponent for Joyride).
 * Video game pattern: title, explanation, next/back — plus "Ask a question":
 * the answer streams from Clara directly into the same card.
 */
import { useEffect, useRef, useState } from "react";
import type { TooltipRenderProps } from "react-joyride";
import { useTranslation, getBrand } from "@claraos/core";
import { streamCompletion } from "../Chat/api";
import styles from "./TourCard.module.css";

export function TourCard(props: TooltipRenderProps) {
  const { backProps, closeProps, primaryProps, tooltipProps, index, isLastStep, size, step } = props;
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { t } = useTranslation("tour");

  // Step change => reset the question area, abort a running stream
  useEffect(() => {
    abortRef.current?.abort();
    setAskOpen(false);
    setQuestion("");
    setAnswer("");
    setBusy(false);
  }, [index]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const context =
      `Du begleitest gerade eine geführte Tour durch ${getBrand().product}. Der Nutzer sieht ` +
      `Schritt „${String(step.title ?? "")}“ mit dem Text: „${String(step.content ?? "")}“. ` +
      `Er hat dazu eine Frage. Antworte kurz (2-5 Sätze), warm und OHNE Fachjargon — ` +
      `der Nutzer ist kein Techniker. Frage:\n${q}`;
    try {
      await streamCompletion(
        { messages: [{ role: "user", content: context }] },
        (c) => {
          if (c.delta) setAnswer((prev) => prev + c.delta);
          if (c.error) setAnswer((prev) => prev || t("card.failedWithError", { error: c.error }));
          if (c.finish) setBusy(false);
        },
        ctrl.signal,
      );
    } catch {
      setAnswer((prev) => prev || t("card.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card} {...tooltipProps} data-testid="tour-card">
      <div className={styles.header}>
        <span className={styles.progress}>{index + 1} / {size}</span>
        <button className={styles.closeBtn} {...closeProps}>✕</button>
      </div>
      {step.title && <div className={styles.title}>{step.title}</div>}
      <div className={styles.content}>{step.content}</div>

      {askOpen && (
        <div className={styles.askArea}>
          <div className={styles.askRow}>
            <textarea
              className={styles.askInput}
              value={question}
              rows={2}
              placeholder={t("card.askPlaceholder")}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask();
                }
              }}
            />
            <button className={styles.askSend} disabled={busy || !question.trim()} onClick={() => void ask()}>
              {busy ? "…" : t("card.send")}
            </button>
          </div>
          {(answer || busy) && (
            <div className={styles.answer} data-testid="tour-answer">
              <span className={styles.answerWho}>✦ {getBrand().assistant}</span>
              {answer || t("card.thinking")}
            </div>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <button className={styles.ghostBtn} onClick={() => setAskOpen((p) => !p)}>
          {askOpen ? t("card.closeQuestion") : t("card.askQuestion")}
        </button>
        <div className={styles.navBtns}>
          {index > 0 && <button className={styles.navBtn} {...backProps}>{t("card.back")}</button>}
          <button className={styles.primaryBtn} {...primaryProps}>
            {isLastStep ? t("card.done") : t("card.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
