import { useState } from "react";
import { heimSlots } from "../../../extensions";
import styles from "./InviteDialog.module.css";
import { useTranslation, i18n } from "@claraos/core";

interface InviteResult {
  guest_username: string;
  matrix_user_id: string;
  invite_url: string;
  instructions: string;
}

// Extra fields this installation's invite flow may return (optional extension).
const InviteResultExtra = heimSlots.InviteResultExtra;

export function InviteDialog({
  roomId,
  roomName,
  onClose,
}: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("teams");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInvite = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/claraos/teams/invite-guest", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name.trim(), room_id: roomId }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || i18n.t("teams:invite.failed"));
      }
      setResult(await resp.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>{t("invite.title", { room: roomName })}</h3>
          <button aria-label={t("common.close")} title={t("common.close")} className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {!result ? (
          <div className={styles.body}>
            <label className={styles.label}>{t("invite.guestName")}</label>
            <input
              autoFocus
              className={styles.input}
              placeholder={t("invite.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleInvite()}
            />
            {error && <div className={styles.error}>{error}</div>}
            <button
              className={styles.inviteBtn}
              onClick={handleInvite}
              disabled={loading || !name.trim()}
            >
              {loading ? t("invite.creating") : t("invite.send")}
            </button>
          </div>
        ) : (
          <div className={styles.body}>
            <div className={styles.success}>{t("invite.created")}</div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t("invite.username")}</span>
              <code>{result.guest_username}</code>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t("invite.matrixId")}</span>
              <code>{result.matrix_user_id}</code>
            </div>
            {InviteResultExtra && <InviteResultExtra result={result as unknown as Record<string, unknown>} />}
            <div className={styles.instructions}>
              <strong>{t("invite.instructions")}</strong>
              <pre>{result.instructions}</pre>
            </div>
            <button
              className={styles.copyBtn}
              onClick={() => navigator.clipboard.writeText(result.instructions)}
            >
              {t("invite.copy")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
