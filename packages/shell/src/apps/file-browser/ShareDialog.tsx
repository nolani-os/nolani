/**
 * Share dialog.
 *
 * The recipient side already existed; links just could not be created
 * anywhere. Dolphin cannot do this at all; here a web file manager plays its
 * home advantage.
 *
 * Deliberately simple: one link, optionally with a password and expiry date,
 * plus the list of existing links to revoke. Everything else the Nextcloud
 * UI does better.
 */
import { useCallback, useEffect, useState } from "react";
import { useIstZelle, useTranslation } from "@claraos/core";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./ShareDialog.module.css";

interface Share {
  id: string;
  url: string;
  hasPassword: boolean;
  expiration: string;
  permissions?: number;
}

interface Props {
  path: string;
  name: string;
  onClose: () => void;
}

export function ShareDialog({ path, name, onClose }: Props) {
  const istZelle = useIstZelle();
  const { t } = useTranslation("files");
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState("");
  const [writable, setWritable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/claraos/files/v2/shares?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      setShares(r.ok ? (d.shares ?? []) : []);
      if (!r.ok) setError(d.detail ?? t("share.loadFailed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [path, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/claraos/files/v2/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "nextcloud",
          path,
          password,
          expires,
          // 1 = read only, 15 = also upload/modify
          permissions: writable ? 15 : 1,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail || t("share.createFailed"));
        return;
      }
      setPassword("");
      setExpires("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/claraos/files/v2/share/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError(t("share.copyFailed"));
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("share.title", { name })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span>{t("share.title", { name })}</span>
          <button onClick={onClose} aria-label={t("actions.close")}>×</button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.form}>
          <label>
            {t("share.password")}
            <input
              type="text"
              value={password}
              placeholder={t("share.noPassword")}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            {t("share.expires")}
            <input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={writable}
              onChange={(e) => setWritable(e.target.checked)}
            />
            {t("share.allowUpload")}
          </label>
          <button className={styles.primary} disabled={busy} onClick={() => void create()}>
            {t("share.create")}
          </button>
        </div>

        <div className={styles.notice}>
          {t("share.noticeAccount")}{" "}
          {istZelle
            ? t("share.noticeInternet")
            : INSTALL_TEXTS.shareLinkReach}
        </div>

        <div className={styles.list}>
          {loading && <p className={styles.hint}>{t("share.loading")}</p>}
          {!loading && shares.length === 0 && (
            <p className={styles.hint}>{t("share.none")}</p>
          )}
          {shares.map((s) => (
            <div key={s.id} className={styles.share}>
              <input readOnly value={s.url} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => void copy(s.url)}>
                {copied === s.url ? t("share.copied") : t("actions.copy")}
              </button>
              <button
                className={styles.danger}
                disabled={busy}
                onClick={() => void remove(s.id)}
                title={t("share.revoke")}
              >
                {t("share.remove")}
              </button>
              <div className={styles.meta}>
                {s.hasPassword ? t("share.withPassword") : t("share.noPassword")}
                {s.expiration ? ` · ${t("share.until", { date: s.expiration })}` : ""}
                {s.permissions && s.permissions > 1 ? ` · ${t("share.uploadAllowed")}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
