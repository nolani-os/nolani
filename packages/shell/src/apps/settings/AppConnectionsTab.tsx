import { useEffect, useState } from "react";
import styles from "./CredentialsTab.module.css";
import { useTranslation, Trans } from "@claraos/core";

/**
 * Settings → "App-Verbindungen".
 *
 * Lets each user store their OWN per-app lookup token (→ claraos_app_credentials).
 * The clara-tools gateway then resolves the caller's token for per_user tools, so
 * Clara's lookups in shared app instances only see the user's own data. Without a
 * connection here the gateway falls back to the shared service token.
 *
 * Apps are discovered live from GET /api/claraos/tools/connectable-apps (the
 * per_user lookup tools). Credentials use /api/claraos/credentials/{app_id}.
 */

interface AppField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
}
interface ConnectableApp {
  app_id: string;
  label: string;
  module: string | null;
  hint?: string;
  fields: AppField[];
}
interface AccountInfo {
  account_name: string;
  is_active: boolean;
  vw_synced: boolean;
}

const HEADERS = { "Content-Type": "application/json" };
const ACCOUNT = "Default"; // one per-user account per app for lookup tokens

export function AppConnectionsTab() {
  const { t } = useTranslation("settingsTabs");
  const [apps, setApps] = useState<ConnectableApp[]>([]);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const loadAll = async () => {
    setLoading(true);
    try {
      const list: ConnectableApp[] = await fetch("/api/claraos/tools/connectable-apps").then((r) => r.json());
      const conn: Record<string, boolean> = {};
      await Promise.all(
        list.map(async (a) => {
          try {
            const accts: AccountInfo[] = await fetch(`/api/claraos/credentials/${a.app_id}`).then((r) => r.json());
            conn[a.app_id] = Array.isArray(accts) && accts.length > 0;
          } catch {
            conn[a.app_id] = false;
          }
        }),
      );
      setApps(list);
      setConnected(conn);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const setField = (appId: string, key: string, value: string) =>
    setDrafts((d) => ({ ...d, [appId]: { ...(d[appId] || {}), [key]: value } }));

  const save = async (app: ConnectableApp) => {
    const draft = drafts[app.app_id] || {};
    // required = non-optional fields; optional fields may stay empty
    const missing = app.fields.find((f) => !f.optional && !(draft[f.key] || "").trim());
    if (missing) {
      setError(t("appConnections.fillField", { app: app.label, field: missing.label }));
      return;
    }
    // only send filled fields — with merge:true the server keeps the rest,
    // so updating e.g. the widget password never wipes a stored api_token
    const creds = Object.fromEntries(
      app.fields
        .map((f) => [f.key, (draft[f.key] || "").trim()])
        .filter(([, v]) => v !== ""),
    );
    if (Object.keys(creds).length === 0) {
      setError(t("appConnections.fillOne", { app: app.label }));
      return;
    }
    setBusy(app.app_id);
    setError("");
    setNotice("");
    try {
      const isUpdate = connected[app.app_id];
      const url = isUpdate
        ? `/api/claraos/credentials/${app.app_id}/${ACCOUNT}`
        : `/api/claraos/credentials/${app.app_id}`;
      const body = isUpdate
        ? { credentials: creds, merge: true }
        : { account_name: ACCOUNT, credentials: creds };
      const r = await fetch(url, {
        method: isUpdate ? "PUT" : "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      setDrafts((d) => ({ ...d, [app.app_id]: {} }));
      setConnected((c) => ({ ...c, [app.app_id]: true }));
      setNotice(t("appConnections.connectedNotice", { app: app.label }));
    } catch (e) {
      setError(`${app.label}: ${e}`);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async (app: ConnectableApp) => {
    if (!confirm(t("appConnections.confirmDisconnect", { app: app.label }))) return;
    setBusy(app.app_id);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/api/claraos/credentials/${app.app_id}/${ACCOUNT}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(await r.text());
      setConnected((c) => ({ ...c, [app.app_id]: false }));
      setNotice(t("appConnections.disconnectedNotice", { app: app.label }));
    } catch (e) {
      setError(`${app.label}: ${e}`);
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return (
      <div className={styles.tab}>
        <h2 className={styles.heading}>{t("appConnections.title")}</h2>
        <p>{t("appConnections.loading")}</p>
      </div>
    );
  }

  return (
    <div className={styles.tab}>
      <h2 className={styles.heading}>{t("appConnections.title")}</h2>
      <p className={styles.subtle}>
        <Trans t={t} i18nKey="appConnections.intro" components={{ b: <strong /> }} />
      </p>

      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.subtle}>{notice}</p>}

      {apps.length === 0 ? (
        <p className={styles.empty}>{t("appConnections.empty")}</p>
      ) : (
        <ul className={styles.itemList}>
          {apps.map((app) => {
            const isConn = connected[app.app_id];
            const draft = drafts[app.app_id] || {};
            return (
              <li key={app.app_id} className={styles.itemCard}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>
                    {app.label} {isConn ? t("appConnections.connected") : t("appConnections.notConnected")}
                  </div>
                  {app.hint && <p className={styles.subtle}>{app.hint}</p>}
                  {app.fields.map((f) => (
                    <div key={f.key} style={{ marginTop: 6 }}>
                      <label className={styles.label}>{f.label}{f.optional ? t("appConnections.optional") : ""}</label>
                      <input
                        className={styles.input}
                        type={f.secret ? "password" : "text"}
                        value={draft[f.key] || ""}
                        placeholder={isConn ? t("appConnections.overwritePlaceholder") : ""}
                        autoComplete="off"
                        onChange={(e) => setField(app.app_id, f.key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className={styles.itemActions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy === app.app_id}
                    onClick={() => save(app)}
                  >
                    {busy === app.app_id ? "…" : isConn ? t("appConnections.update") : t("appConnections.connect")}
                  </button>
                  {isConn && (
                    <button
                      className={styles.btnSecondary}
                      disabled={busy === app.app_id}
                      onClick={() => disconnect(app)}
                    >
                      {t("appConnections.disconnect")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
