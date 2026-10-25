import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import styles from "./UserAdminApp.module.css";
import { regionLocale, i18n, useTranslation } from "@claraos/core";

const UA = "/api/claraos/user-admin";

interface UserRow {
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  groups: string[];
  /** Owner and system accounts: the API refuses to delete or deactivate them. */
  protected?: boolean;
}

interface AppRow {
  id: string;
  name: string;
  category: string;
  gate_allowed: boolean;
  override: boolean | null;
  effective: boolean;
}

interface Props {
  user: UserRow;
  onBack: () => void;
  onImpersonate: (username: string) => void;
  onFullView: (username: string) => void;
  onChanged: () => void;
}

export function UserDetail({ user, onBack, onImpersonate, onFullView, onChanged }: Props) {
  const { t } = useTranslation("userAdmin");
  const [groups, setGroups] = useState<string[]>(user.groups);
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [appFilter, setAppFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwResult, setPwResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [budget, setBudget] = useState<{ available?: boolean; monthly_budget_eur?: number; current_month_eur?: number; budget_exceeded?: boolean } | null>(null);
  const [budgetEdit, setBudgetEdit] = useState<string>("");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ invite_url: string; expires_at: string } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  // Guide: rollout/parent view — profile metadata + impulse status;
  // the API only returns profile CONTENT for children (adults stay private).
  const [guide, setGuide] = useState<{
    kid: boolean; profil_felder: number; updated_by?: string | null;
    updated_at?: string | null; optout: boolean;
    nudges: Record<string, { done?: boolean; dismissed?: number; next_after?: string }>;
    profil?: Record<string, string | string[]>;
  } | null>(null);

  const protectedUser = user.protected ?? (user.username === "clara.bot" || user.username === "akadmin");

  const loadApps = useCallback(() => {
    fetch(`${UA}/users/${encodeURIComponent(user.username)}/apps`)
      .then((r) => r.json())
      .then((d) => setApps(d.apps || []))
      .catch(() => {});
  }, [user.username]);

  const loadBudget = useCallback(() => {
    fetch(`${UA}/users/${encodeURIComponent(user.username)}/budget`)
      .then((r) => r.json())
      .then((d) => { setBudget(d); if (d.monthly_budget_eur != null) setBudgetEdit(String(d.monthly_budget_eur)); })
      .catch(() => setBudget({ available: false }));
  }, [user.username]);

  const loadInviteStatus = useCallback(() => {
    fetch(`${UA}/invites`)
      .then((r) => r.json())
      .then((d) => {
        const mine = (d.invites || []).find(
          (i: { username: string; status: string }) => i.username === user.username && i.status === "offen");
        setInviteStatus(mine ? "offen" : null);
      })
      .catch(() => {});
  }, [user.username]);

  useEffect(() => {
    fetch(`${UA}/groups`).then((r) => r.json()).then((d) => setAllGroups(d.groups || [])).catch(() => {});
    loadApps();
    loadBudget();
    loadInviteStatus();
  }, [loadApps, loadBudget, loadInviteStatus]);

  useEffect(() => {
    fetch(`/api/claraos/guide/admin/status/${encodeURIComponent(user.username)}`,
      { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setGuide)
      .catch(() => setGuide(null));
  }, [user.username, groups]);

  const createInvite = async () => {
    setInviteBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/invite`, { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail || `HTTP ${r.status}`);
      setInvite(b); setInviteStatus("offen");
    } catch (e) { setError((e as Error).message); }
    setInviteBusy(false);
  };

  const revokeInvite = async () => {
    if (!confirm(t("detail.confirmRevoke", { user: user.username }))) return;
    setInviteBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/invite`, { method: "DELETE" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      setInvite(null); setInviteStatus(null);
    } catch (e) { setError((e as Error).message); }
    setInviteBusy(false);
  };

  const saveBudget = async () => {
    const val = parseFloat(budgetEdit);
    if (isNaN(val) || val < 0) { setError(t("detail.invalidBudget")); return; }
    setBudgetSaving(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/budget`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly_budget_eur: val }),
      });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      loadBudget();
    } catch (e) { setError((e as Error).message); }
    setBudgetSaving(false);
  };

  const addGroup = async (g: string) => {
    setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/groups`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: g }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail || `HTTP ${r.status}`);
      setGroups((cur) => [...cur, g]); onChanged(); loadApps();
    } catch (e) { setError((e as Error).message); }
  };

  const removeGroup = async (g: string) => {
    setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/groups/${encodeURIComponent(g)}`, { method: "DELETE" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      setGroups((cur) => cur.filter((x) => x !== g)); onChanged(); loadApps();
    } catch (e) { setError((e as Error).message); }
  };

  const resetPassword = async () => {
    if (!confirm(t("detail.confirmReset", { user: user.username }))) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/reset-password`, { method: "POST" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail || `HTTP ${r.status}`);
      setPwResult(b.password);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const setAppOverride = async (appId: string, next: "on" | "off" | "default") => {
    try {
      const res = next === "default"
        ? await fetch(`${UA}/users/${encodeURIComponent(user.username)}/apps/${appId}`, { method: "DELETE" })
        : await fetch(`${UA}/users/${encodeURIComponent(user.username)}/apps`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ app_id: appId, enabled: next === "on" }),
          });
      // Important: a rejected call does NOT throw — without res.ok a 403 never
      // reached the catch, and the toggle stayed as if it had worked.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loadApps();
    } catch (e) {
      setError(t("detail.overrideFailed", { error: String(e) }));
      loadApps();   // reset the display to the actual server state
    }
  };

  const deactivate = async () => {
    if (!confirm(t("detail.confirmDeactivate", { user: user.username }))) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/deactivate`, { method: "POST" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      onChanged(); onBack();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const deleteUser = async () => {
    if (!confirm(t("detail.confirmDelete", { user: user.username }))) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      onChanged(); onBack();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const availableGroups = allGroups.filter((g) => !groups.includes(g));
  const appName = (a: AppRow) => i18n.t(`apps:${a.id}.name`, { defaultValue: a.name });
  const visibleApps = apps.filter((a) => !appFilter || appName(a).toLowerCase().includes(appFilter.toLowerCase()));

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <button className={styles.btn} onClick={onBack}>{t("common.back")}</button>
        <h2>{user.name} <span className={styles.detailSub}>{user.username}</span></h2>
        {!user.is_active && <span className={styles.inactiveBadge}>{t("common.inactive")}</span>}
        <span style={{ marginLeft: "auto" }} />
        <button className={styles.btn} onClick={() => onImpersonate(user.username)} disabled={!user.is_active}
          title={t("detail.viewTitle")}>{t("detail.view")}</button>
        <button className={styles.btn} onClick={() => onFullView(user.username)} disabled={!user.is_active}
          title={t("detail.fullViewTitle")}>{t("detail.fullView")}</button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Password reset */}
      <section className={styles.section}>
        <h3>{t("detail.password")}</h3>
        {pwResult ? (
          <div className={styles.pwBox}>
            <span className={styles.hint}>{t("detail.newPassword")}</span>
            <code className={styles.pwValue}>{pwResult}</code>
            <button className={styles.btn} onClick={() => { navigator.clipboard.writeText(pwResult); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "✓" : t("common.copy")}
            </button>
          </div>
        ) : (
          <button className={styles.btn} onClick={resetPassword} disabled={busy || protectedUser}
            title={protectedUser ? t("detail.protected") : ""}>
            {busy ? "…" : t("detail.resetPassword")}
          </button>
        )}
      </section>

      {/* Guide: Clara companion — rollout progress + parent view for children */}
      {guide && (
        <section className={styles.section} data-testid="guide-status">
          <h3>{t("detail.guide")}
            {guide.kid && <span className={styles.hint}>{t("detail.kid")}</span>}
          </h3>
          <p className={styles.hint}>
            {guide.profil_felder > 0
              ? t("detail.profile", { count: guide.profil_felder, date: guide.updated_at
                  ? new Date(guide.updated_at).toLocaleDateString(regionLocale()) : "?" }) +
                (guide.updated_by === "clara" ? t("detail.learned") : t("detail.byUser"))
              : t("detail.noProfile")}
            {guide.optout && t("detail.optout")}
          </p>
          <p className={styles.hint}>
            {(["welcome", "device-setup", "files-tour", "fotos-tour"] as const).map((id, i) => {
              const n = guide.nudges[id] ?? {};
              const stateTxt = n.done ? "✓" : n.dismissed
                ? t("detail.later", { count: n.dismissed }) : "–";
              return `${i > 0 ? " · " : t("detail.nudgesPrefix")}${t(`detail.nudge.${id}`)} ${stateTxt}`;
            }).join("")}
          </p>
          {guide.kid && guide.profil && Object.keys(guide.profil).length > 0 && (
            <pre className={styles.pwBox} style={{ whiteSpace: "pre-wrap" }}>
              {Object.entries(guide.profil)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
                .join("\n")}
            </pre>
          )}
        </section>
      )}

      {/* Setup assistant (invite link for the public onboarding portal) */}
      <section className={styles.section}>
        <h3>{t("detail.setup")}</h3>
        {invite ? (
          <div>
            <span className={styles.hint}>
              {t("detail.linkNow", { date: new Date(invite.expires_at).toLocaleDateString(regionLocale()) })}
            </span>
            <div className={styles.pwBox}>
              <code className={styles.pwValue} style={{ fontSize: 11, wordBreak: "break-all" }}>{invite.invite_url}</code>
              <button className={styles.btn} onClick={() => {
                navigator.clipboard.writeText(invite.invite_url);
                setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1500);
              }}>{inviteCopied ? "✓" : t("common.copy")}</button>
            </div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 12, width: "fit-content", marginTop: 8 }}>
              <QRCodeSVG value={invite.invite_url} size={130} marginSize={1} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className={styles.btn} onClick={createInvite} disabled={inviteBusy || !user.is_active}>
              {inviteBusy ? "…" : t("detail.newInvite")}
            </button>
            {inviteStatus === "offen" && (
              <>
                <span className={styles.hint}>{t("detail.openLink")}</span>
                <button className={styles.btn} onClick={revokeInvite} disabled={inviteBusy}>{t("detail.revoke")}</button>
              </>
            )}
          </div>
        )}
      </section>

      {/* Budget */}
      <section className={styles.section}>
        <h3>{t("detail.budget")} <span className={styles.hint}>{t("detail.budgetHint")}</span></h3>
        {budget === null ? (
          <span className={styles.hint}>{t("detail.budgetLoading")}</span>
        ) : budget.available === false ? (
          <span className={styles.hint}>{t("detail.budgetUnavailable")}</span>
        ) : (
          <>
            <div className={styles.budgetRow}>
              <div className={styles.budgetBarTrack}>
                <div className={styles.budgetBarFill} style={{
                  width: `${Math.min(100, ((budget.current_month_eur ?? 0) / Math.max(0.01, budget.monthly_budget_eur ?? 0)) * 100)}%`,
                  background: budget.budget_exceeded ? "#dc2626" : ((budget.current_month_eur ?? 0) / Math.max(0.01, budget.monthly_budget_eur ?? 1) > 0.8 ? "#d97706" : "var(--accent)"),
                }} />
              </div>
              <span className={styles.budgetLabel}>
                {(budget.current_month_eur ?? 0).toFixed(2)} € / {(budget.monthly_budget_eur ?? 0).toFixed(2)} €
                {budget.budget_exceeded && <span className={styles.inactiveBadge}>{t("detail.exceeded")}</span>}
              </span>
            </div>
            <div className={styles.budgetEdit}>
              <label>{t("detail.monthlyLimit")}</label>
              <input className={styles.input} type="number" min="0" step="1" style={{ width: 90 }}
                value={budgetEdit} onChange={(e) => setBudgetEdit(e.target.value)} />
              <button className={styles.btn} onClick={saveBudget} disabled={budgetSaving}>
                {budgetSaving ? "…" : t("detail.set")}
              </button>
              <span className={styles.hint}>{t("detail.unlimited")}</span>
            </div>
          </>
        )}
      </section>

      {/* Groups */}
      <section className={styles.section}>
        <h3>{t("detail.groups")}</h3>
        <div className={styles.groupChips}>
          {groups.map((g) => (
            <span key={g} className={`${styles.chip} ${styles.chipOn}`}>
              {g} <button className={styles.chipX} onClick={() => removeGroup(g)}>×</button>
            </span>
          ))}
        </div>
        {availableGroups.length > 0 && (
          <details className={styles.addGroup}>
            <summary>{t("detail.addGroup")}</summary>
            <div className={styles.groupChips}>
              {availableGroups.map((g) => (
                <button key={g} className={styles.chip} onClick={() => addGroup(g)}>{g}</button>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* App visibility */}
      <section className={styles.section}>
        <h3>{t("detail.appPermissions")} <span className={styles.hint}>{t("detail.visibleCount", { visible: apps.filter((a) => a.effective).length, total: apps.length })}</span></h3>
        <input className={styles.input} style={{ maxWidth: 220, marginBottom: 8 }} placeholder={t("detail.filterApps")}
          value={appFilter} onChange={(e) => setAppFilter(e.target.value)} />
        <div className={styles.appList}>
          {visibleApps.map((a) => (
            <div key={a.id} className={styles.appRow}>
              <span className={styles.appName}>{appName(a)}</span>
              <span className={styles.appCat}>{a.category}</span>
              <span className={`${styles.appState} ${a.effective ? styles.appOn : styles.appOff}`}>
                {a.effective ? t("detail.visible") : t("detail.hidden")}
                {a.override !== null && <span className={styles.overrideDot} title={t("detail.override")}>•</span>}
              </span>
              <div className={styles.appActions}>
                <button className={`${styles.miniBtn} ${a.override === true ? styles.miniOn : ""}`}
                  onClick={() => setAppOverride(a.id, "on")} title={t("detail.alwaysOn")}>{t("detail.on")}</button>
                <button className={`${styles.miniBtn} ${a.override === false ? styles.miniOn : ""}`}
                  onClick={() => setAppOverride(a.id, "off")} title={t("detail.alwaysOff")}>{t("detail.off")}</button>
                {a.override !== null && (
                  <button className={styles.miniBtn} onClick={() => setAppOverride(a.id, "default")} title={t("detail.groupDefault")}>{t("detail.auto")}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Danger zone */}
      {!protectedUser && (
        <section className={styles.section}>
          <h3>{t("detail.account")}</h3>
          <div style={{ display: "flex", gap: 10 }}>
            <button className={styles.btn} onClick={deactivate} disabled={busy || !user.is_active}>
              {t("detail.deactivate")}
            </button>
            <button className={styles.btnDanger} onClick={deleteUser} disabled={busy}>
              {t("detail.delete")}
            </button>
          </div>
          <span className={styles.hint}>{t("detail.accountHint")}</span>
        </section>
      )}
    </div>
  );
}
