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
import { useTranslation } from "@claraos/core";
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
  const { t } = useTranslation("chat");
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
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt.current);
    }, 200);
    return () => clearInterval(timer);
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
          ? t("plan.failedApprove")
          : t("plan.failed"),
      );
    }
  };

  return (
    <div className={styles.card} data-claraos-plan-card>
      <div className={styles.header}>
        <span className={styles.title}>📋 {t("plan.startsIn", { seconds: Math.ceil(remainingMs / 1000) })}</span>
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
              ⏵ {t("plan.startNow")}
            </button>
            <button
              className={styles.btn}
              onClick={() => setEditing(true)}
              disabled={responded || submitting}
            >
              ✏️ {t("plan.edit")}
            </button>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => void respond("reject")}
              disabled={responded || submitting}
            >
              ✕ {t("plan.stop")}
            </button>
          </>
        ) : (
          <>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void respond("edit", editedText)}
              disabled={responded || submitting}
            >
              💾 {t("plan.saveAndStart")}
            </button>
            <button
              className={styles.btn}
              onClick={() => { setEditing(false); setEditedText(plan.plan); }}
              disabled={submitting}
            >
              {t("camera.cancel")}
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
