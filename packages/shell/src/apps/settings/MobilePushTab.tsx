import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useUIStore, appUrl, useTranslation, Trans, i18n } from "@claraos/core";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./MobilePushTab.module.css";

// Fixed app endpoint (reverse-proxy passthrough without auth override, per-user token).
// NOT the legacy ntfy.* host — that route overwrites the Authorization header.
const PUSH_SERVER = appUrl("ntfy");

interface TokenResp {
  ntfy_username: string;
  token: string;
  // Login for the ntfy Android app: the app cannot use access tokens and
  // requires a username — user:token returns 401, hence a real password.
  app_password: string;
}

function copy(text: string, label: string) {
  const done = () =>
    useUIStore.getState().addNotification({ title: i18n.t("settingsTabs:mobilePush.copied"), body: label, icon: "📋" });
  navigator.clipboard?.writeText(text).then(done).catch(() => {
    // Fallback for contexts without the Clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      useUIStore.getState().addNotification({
        title: i18n.t("settingsTabs:mobilePush.copyFailed"),
        body: i18n.t("settingsTabs:mobilePush.copyManually", { label }),
        icon: "⚠️",
      });
    }
    document.body.removeChild(ta);
  });
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { t } = useTranslation("settingsTabs");
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldRow}>
        <code className={`${styles.fieldValue} ${mono ? styles.mono : ""}`}>{value}</code>
        <button className={styles.copyBtn} onClick={() => copy(value, label)} title={t("mobilePush.copy")}>📋</button>
      </div>
    </div>
  );
}

export function MobilePushTab() {
  const { t } = useTranslation("settingsTabs");
  const [data, setData] = useState<TokenResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/claraos/ntfy/token", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as TokenResp;
      })
      .then((d) => setData(d))
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const masked = data ? `${data.app_password.slice(0, 4)}…${data.app_password.slice(-2)}` : "";

  return (
    <div className={styles.wrap} data-tour="settings-push">
      <div className={styles.hero}>
        <span className={styles.heroIcon}>📲</span>
        <h1 className={styles.title}>{t("mobilePush.title")}</h1>
        <p className={styles.tagline}>
          <Trans t={t} i18nKey="mobilePush.tagline" components={{ b: <strong /> }} />
          {INSTALL_TEXTS.pushNetworkHint && <> <em>{INSTALL_TEXTS.pushNetworkHint}</em></>}
        </p>
      </div>

      {loading && <div className={styles.muted}>{t("mobilePush.loading")}</div>}
      {error && (
        <div className={styles.error}>
          {t("mobilePush.loadError", { error })}
          <button className={styles.linkBtn} onClick={load}>{t("mobilePush.retry")}</button>
        </div>
      )}

      {data && (
        <>
          <div className={styles.cols}>
            <div className={styles.qrCard}>
              <QRCodeSVG value={data.app_password} size={168} level="M" includeMargin
                bgColor="#ffffff" fgColor="#0b1020" />
              <span className={styles.qrHint}>{t("mobilePush.qrHint")}</span>
            </div>
            <div className={styles.fields}>
              <Field label="Server" value={PUSH_SERVER} mono />
              <Field label={t("mobilePush.topicLabel")} value={data.ntfy_username} mono />
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t("mobilePush.appPassword")}</span>
                <div className={styles.fieldRow}>
                  <code className={`${styles.fieldValue} ${styles.mono}`}>
                    {reveal ? data.app_password : masked}
                  </code>
                  <button className={styles.copyBtn} onClick={() => setReveal((v) => !v)}
                    title={reveal ? t("mobilePush.hide") : t("mobilePush.show")}>{reveal ? "🙈" : "👁️"}</button>
                  <button className={styles.copyBtn} onClick={() => copy(data.app_password, t("mobilePush.appPassword"))}
                    title={t("mobilePush.copy")}>📋</button>
                </div>
                <span className={styles.tokenNote}>{t("mobilePush.tokenNote")}</span>
              </div>
            </div>
          </div>

          <ol className={styles.steps}>
            <li><Trans t={t} i18nKey="mobilePush.step1" components={{ b: <strong /> }} /></li>
            <li>
              <Trans t={t} i18nKey="mobilePush.step2" values={{ server: PUSH_SERVER, user: data.ntfy_username }}
                components={{ b: <strong />, c: <code /> }} />
            </li>
            <li>
              <Trans t={t} i18nKey="mobilePush.step3" values={{ server: PUSH_SERVER, user: data.ntfy_username }}
                components={{ b: <strong />, c: <code /> }} />
            </li>
            <li>{t("mobilePush.step4")}</li>
          </ol>

          <button className={styles.linkBtn} onClick={load}>{t("mobilePush.reloadToken")}</button>
        </>
      )}
    </div>
  );
}
