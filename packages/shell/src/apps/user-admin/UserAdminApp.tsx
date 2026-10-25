import { useCallback, useEffect, useState } from "react";
import { appUrl, Trans, useTranslation } from "@claraos/core";
import { CreateUserWizard } from "./CreateUserWizard";
import { UserDetail } from "./UserDetail";
import styles from "./UserAdminApp.module.css";
import { regionLocale } from "@claraos/core";

interface User {
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  groups: string[];
}

interface AuditEntry {
  id: string;
  impersonator: string;
  target_user: string;
  action: string;
  started_at: string | null;
  ended_at: string | null;
}

const UA = "/api/claraos/user-admin";
const IMP = "/api/claraos/impersonate";
const AV = "/api/claraos/admin-view";
const ADMIN_VIEW_URL = appUrl("admin-view") + "/";

type Tab = "humans" | "service" | "audit";

export default function UserAdminApp({ windowId: _windowId }: { windowId: string }) {
  const { t } = useTranslation("userAdmin");
  const [tab, setTab] = useState<Tab>("humans");
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<User | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [activeSession, setActiveSession] = useState<{ target: string; sessionId: string } | null>(null);
  const [fullView, setFullView] = useState<{ target: string; streamUrl: string } | null>(null);

  const loadUsers = useCallback(async (filter: "humans" | "service") => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${UA}/users?filter=${filter}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUsers(data.users || []);
    } catch (e) { setError((e as Error).message || String(e)); setUsers([]); }
    finally { setLoading(false); }
  }, []);

  const loadAudit = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${IMP}/audit?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAudit(data.entries || []);
    } catch (e) { setError((e as Error).message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(() => {
    if (tab === "audit") loadAudit();
    else loadUsers(tab);
  }, [tab, loadUsers, loadAudit]);

  useEffect(() => { refresh(); }, [refresh]);

  const startImpersonation = useCallback(async (username: string) => {
    setError(null);
    try {
      const res = await fetch(`${IMP}/start/${encodeURIComponent(username)}`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSelected(null);
      setActiveSession({ target: data.target_user, sessionId: data.session_id });
    } catch (e) { setError(t("msg.impersonateFailed", { error: String(e) })); }
  }, [t]);

  const endImpersonation = useCallback(async () => {
    try {
      const res = await fetch(`${IMP}/end`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Security-relevant: only discard the session locally once the server has
      // actually ended it — otherwise the admin would believe they were back to
      // being themselves.
      setError(t("msg.impersonateEndFailed", { error: String(e) }));
    }
    setActiveSession(null);
    if (tab === "audit") loadAudit();
  }, [tab, loadAudit, t]);

  const startFullView = useCallback(async (username: string) => {
    setError(null);
    try {
      const res = await fetch(`${AV}/start`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user: username }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSelected(null);
      setFullView({ target: data.target_user, streamUrl: data.stream_url });
    } catch (e) { setError(t("msg.fullViewFailed", { error: String(e) })); }
  }, [t]);

  const endFullView = useCallback(async () => {
    try {
      const res = await fetch(`${AV}/end`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError(t("msg.fullViewEndFailed", { error: String(e) }));
    }
    setFullView(null);
    if (tab === "audit") loadAudit();
  }, [tab, loadAudit, t]);

  const formatDate = (d: string | null) => {
    if (!d) return "–";
    try {
      return new Date(d).toLocaleString(regionLocale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return d; }
  };

  // Impersonation fullscreen
  if (activeSession) {
    return (
      <div className={styles.userAdmin}>
        <div className={styles.impersonateFrame}>
          <div className={styles.banner}>
            <span className={styles.bannerIcon}>⚠</span>
            <span><Trans t={t} i18nKey="banner.signedInAs" values={{ user: activeSession.target }} components={{ b: <strong /> }} /></span>
            <span className={styles.bannerSpacer} />
            <span className={styles.sessionId}>session: {activeSession.sessionId.slice(0, 8)}</span>
            <button className={styles.endBtn} onClick={endImpersonation}>{t("banner.endSession")}</button>
          </div>
          <iframe className={styles.iframe} src={ADMIN_VIEW_URL} title={t("banner.frameTitle", { user: activeSession.target })}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="fullscreen; clipboard-read; clipboard-write; camera; microphone" />
        </div>
      </div>
    );
  }

  // Full view (browser stream, the admin signs in and impersonates)
  if (fullView) {
    return (
      <div className={styles.userAdmin}>
        <div className={styles.impersonateFrame}>
          <div className={styles.banner}>
            <span className={styles.bannerIcon}>🔎</span>
            <span><Trans t={t} i18nKey="banner.fullView" values={{ user: fullView.target }} components={{ b: <strong /> }} /></span>
            <span className={styles.bannerSpacer} />
            <button className={styles.endBtn} onClick={endFullView}>{t("banner.endSession")}</button>
          </div>
          <iframe className={styles.iframe} src={fullView.streamUrl} title={t("banner.fullViewTitle", { user: fullView.target })}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="fullscreen; clipboard-read; clipboard-write; camera; microphone" />
        </div>
      </div>
    );
  }

  // Detail view
  if (selected) {
    return (
      <div className={styles.userAdmin}>
        <UserDetail user={selected} onBack={() => { setSelected(null); refresh(); }}
          onImpersonate={startImpersonation} onFullView={startFullView} onChanged={refresh} />
      </div>
    );
  }

  return (
    <div className={styles.userAdmin}>
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === "humans" ? styles.tabActive : ""}`} onClick={() => setTab("humans")}>{t("tabs.humans")}</button>
        <button className={`${styles.tab} ${tab === "service" ? styles.tabActive : ""}`} onClick={() => setTab("service")}>{t("tabs.service")}</button>
        <button className={`${styles.tab} ${tab === "audit" ? styles.tabActive : ""}`} onClick={() => setTab("audit")}>{t("tabs.audit")}</button>
        {tab === "humans" && (
          <button className={styles.newUserBtn} onClick={() => setShowWizard(true)}>{t("newUser")}</button>
        )}
      </div>

      <div className={styles.content}>
        {loading && <div className={styles.status}>{t("common.loading")}</div>}
        {error && <div className={styles.error}>{error}</div>}

        {tab === "audit" && !loading && !error && (
          <div className={styles.auditTable}>
            <div className={styles.auditHeader}>
              <span>{t("audit.started")}</span><span>{t("audit.admin")}</span><span>{t("audit.target")}</span><span>{t("audit.action")}</span><span>{t("audit.ended")}</span>
            </div>
            {audit.length === 0 && <div className={styles.empty}>{t("audit.empty")}</div>}
            {audit.map((e) => (
              <div key={e.id} className={styles.auditRow}>
                <span>{formatDate(e.started_at)}</span><span>{e.impersonator}</span>
                <span>{e.target_user}</span><span>{e.action}</span><span>{formatDate(e.ended_at)}</span>
              </div>
            ))}
          </div>
        )}

        {(tab === "humans" || tab === "service") && !loading && !error && (
          <div className={styles.userGrid}>
            {users.length === 0 && <div className={styles.empty}>{tab === "humans" ? t("list.noHumans") : t("list.noService")}</div>}
            {users.map((u) => (
              <div key={u.username} className={styles.userCard} onClick={() => tab === "humans" && setSelected(u)}
                style={{ cursor: tab === "humans" ? "pointer" : "default" }}>
                <div className={styles.userIcon}>{tab === "service" ? "🤖" : "👤"}</div>
                <div className={styles.userInfo}>
                  <div className={styles.userName}>{u.name}{!u.is_active && <span className={styles.inactiveBadge}>{t("common.inactive")}</span>}</div>
                  <div className={styles.userUsername}>{u.username}</div>
                  {u.email && <div className={styles.userEmail}>{u.email}</div>}
                  <div className={styles.userGroups}>
                    {u.groups.slice(0, 4).map((g) => <span key={g} className={styles.groupBadge}>{g}</span>)}
                  </div>
                </div>
                {tab === "humans"
                  ? <button className={styles.openBtn} onClick={(e) => { e.stopPropagation(); setSelected(u); }}>{t("list.manage")}</button>
                  : <button className={styles.openBtn} onClick={() => startImpersonation(u.username)} disabled={!u.is_active}>{t("list.open")}</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showWizard && (
        <CreateUserWizard onClose={() => setShowWizard(false)} onCreated={() => loadUsers("humans")} />
      )}
    </div>
  );
}
