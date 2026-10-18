/**
 * PlanCard — soft plan-mode UI.
 *
 * Appears for tasks with `complexity ≥ 4`. Shows the plan + an 8 s countdown;
 * the user can:
 *  - do nothing → auto-approve after 8 s (server-side; the countdown here
 *    is display only)
 *  - "Sofort starten" → POST /plan-response action=approve
 *  - "Stop" → POST /plan-response action=reject → stream stops
 *  - "Bearbeiten" → inline editor → action=edit
 *
 * Buttons lock only after a confirmed POST — otherwise a silent failure
 * would mean: the user believes they stopped it, but the plan runs anyway.
 */
import { useEffect, useRef, useState } from "react";
import type { ClaraPendingPlan } from "./api";
import styles from "./PlanCard.module.css";

interface PlanCardProps {
  plan: ClaraPendingPlan;
}

/** true = answer arrived (200) or already answered (409). */
async function postPlanResponse(
  planId: string,
  action: "approve" | "reject" | "edit",
  editedPlan?: string,
): Promise<boolean> {
  try {
    const resp = await fetch("/api/claraos/chat/v2/plan-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        plan_id: planId,
        action,
        edited_plan: action === "edit" ? editedPlan ?? "" : undefined,
      }),
    });
    return resp.ok || resp.status === 409;
  } catch (err) {
    console.warn("[plan-response] failed", err);
    return false;
  }
}

export function PlanCard({ plan }: PlanCardProps) {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(plan.plan);
  const [responded, setResponded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalMs = plan.waitSeconds * 1000;
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef(plan.proposedAt);

  // Countdown ticker
  useEffect(() => {
    if (responded) return;
    const t = setInterval(() => {
      setElapsedMs(Date.now() - startedAt.current);
    }, 200);
    return () => clearInterval(t);
  }, [responded]);

  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const fillPct = Math.min(100, (elapsedMs / totalMs) * 100);

  const respond = async (action: "approve" | "reject" | "edit", edited?: string) => {
    if (responded || submitting) return;
    setSubmitting(true);
    setError(null);
    const ok = await postPlanResponse(plan.planId, action, edited);
    setSubmitting(false);
    if (ok) {
      setResponded(true);
      setEditing(false);
    } else {
      setError(
        action === "approve"
          ? "Aktion kam nicht durch — bitte nochmal versuchen."
          : "Aktion kam nicht durch — der Plan startet ggf. automatisch. Bitte nochmal versuchen.",
      );
    }
  };

  return (
    <div className={styles.card} data-claraos-plan-card>
      <div className={styles.header}>
        <span className={styles.title}>📋 Plan — startet in {Math.ceil(remainingMs / 1000)}s</span>
        <div className={styles.countdown}>
          <div className={styles.countdownBar}>
            <div className={styles.countdownFill} style={{ width: `${fillPct}%` }} />
          </div>
        </div>
      </div>
      {editing ? (
        <textarea
          className={styles.editor}
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          autoFocus
        />
      ) : (
        <div className={styles.planText}>{plan.plan}</div>
      )}
      <div className={styles.actions}>
        {!editing ? (
          <>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void respond("approve")}
              disabled={responded || submitting}
            >
              ⏵ Sofort starten
            </button>
            <button
              className={styles.btn}
              onClick={() => setEditing(true)}
              disabled={responded || submitting}
            >
              ✏️ Bearbeiten
            </button>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => void respond("reject")}
              disabled={responded || submitting}
            >
              ✕ Stop
            </button>
          </>
        ) : (
          <>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void respond("edit", editedText)}
              disabled={responded || submitting}
            >
              💾 Speichern + starten
            </button>
            <button
              className={styles.btn}
              onClick={() => { setEditing(false); setEditedText(plan.plan); }}
              disabled={submitting}
            >
              Abbrechen
            </button>
          </>
        )}
      </div>
      {error && (
        <div style={{ fontSize: 11, color: "var(--danger, #e5534b)", marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}
