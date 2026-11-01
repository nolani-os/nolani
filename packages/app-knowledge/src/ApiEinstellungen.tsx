/** Settings of the device-local app: the local HTTP API (on/off, port, key). */
import { useEffect, useState } from "react";
import { useTranslation } from "@claraos/core";
import styles from "../../shell/src/apps/ideas/IdeasApp.module.css";
import { Icon } from "../../shell/src/components/Icon";
import type { Db } from "./local/db";
import {
  DEFAULT_PORT, apiAvailable, applySettings, loadSettings, newToken, saveSettings, type ApiSettings,
} from "./localApi";

export function ApiEinstellungen({ db, onClose }: { db: Db; onClose: () => void }) {
  const { t } = useTranslation("wissen");
  const [s, setS] = useState<ApiSettings | null>(null);
  const [laeuft, setLaeuft] = useState<number | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [zeigen, setZeigen] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const verfuegbar = apiAvailable();

  useEffect(() => {
    void loadSettings(db).then(async (geladen) => {
      setS(geladen);
      if (verfuegbar) {
        const { invoke } = await import("@tauri-apps/api/core");
        setLaeuft(await invoke<number | null>("api_status"));
      }
    });
  }, [db, verfuegbar]);

  async function uebernehmen(neu: ApiSettings) {
    setS(neu);
    setFehler(null);
    await saveSettings(db, neu);
    try {
      setLaeuft(await applySettings(neu));
    } catch (e) {
      setLaeuft(null);
      setFehler(String(e));
    }
  }

  if (!s) return null;
  // On a phone the dialog opens as a sheet from the bottom like every other one
  const schmal = typeof window !== "undefined" && window.innerWidth < 700;
  const basis = `http://127.0.0.1:${laeuft ?? s.port}/api/claraos/knowledge`;
  const beispiel = `curl -H "Authorization: Bearer ${zeigen ? s.token : "…"}" ${basis}/objects`;

  return (
    <div className={schmal ? styles.mobile : undefined}>
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className={styles.modalHead}>
          <h3><Icon name="gear" size={16} className={styles.inlineIcon} />{t("localApi.title")}</h3>
          <button className={styles.iconBtn} onClick={onClose}>
            <Icon name="close" size={14} title={t("app.close")} />
          </button>
        </div>
        <p className={styles.metaHint}>{t("localApi.intro")}</p>
        {!verfuegbar ? (
          <p className={styles.metaHint}>{t("localApi.unavailable")}</p>
        ) : (
          <>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
              <input type="checkbox" checked={s.enabled}
                     onChange={(e) => void uebernehmen({ ...s, enabled: e.target.checked })} />
              <span>{t("localApi.enable")}</span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
              <span>{t("localApi.port")}</span>
              <input className={styles.input} style={{ maxWidth: 110 }} type="number" min={1024} max={65535}
                     defaultValue={s.port}
                     onBlur={(e) => {
                       const p = Number(e.target.value);
                       const port = Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
                       if (port !== s.port) void uebernehmen({ ...s, port });
                     }} />
            </label>
            <p className={styles.metaHint} data-testid="api-status">
              {laeuft ? t("localApi.running", { url: basis }) : t("localApi.stopped")}
            </p>
            {fehler && <div className={styles.error}><span>{t("localApi.failed", { error: fehler })}</span></div>}
            <div style={{ margin: "12px 0" }}>
              <div>{t("localApi.key")}</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                <input className={styles.input} readOnly value={zeigen ? s.token : "•".repeat(24)}
                       style={{ fontFamily: "monospace", flex: 1 }} />
                <button className={styles.btnSecondary} onClick={() => setZeigen((v) => !v)}>
                  {zeigen ? t("localApi.hide") : t("localApi.show")}
                </button>
                <button className={styles.btnSecondary} onClick={() => {
                  void navigator.clipboard.writeText(s.token).then(() => setKopiert(true));
                }}>
                  <Icon name="copy" size={14} className={styles.inlineIcon} />{kopiert ? t("localApi.copied") : t("localApi.copy")}
                </button>
              </div>
              <button className={styles.btnSecondary} style={{ marginTop: 8 }}
                      onClick={() => {
                        if (window.confirm(t("localApi.newKeyConfirm"))) {
                          setKopiert(false);
                          void uebernehmen({ ...s, token: newToken() });
                        }
                      }}>
                {t("localApi.newKey")}
              </button>
            </div>
            <p className={styles.metaHint}>{t("localApi.example")}</p>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 }}>{beispiel}</pre>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
