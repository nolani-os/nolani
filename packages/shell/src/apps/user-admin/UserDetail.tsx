import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import styles from "./UserAdminApp.module.css";

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
    if (!confirm(`Offene Einladungslinks für ${user.username} widerrufen?`)) return;
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
    if (isNaN(val) || val < 0) { setError("Ungültiger Budget-Wert"); return; }
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
    if (!confirm(`Passwort für ${user.username} zurücksetzen? Bestehende Sitzungen werden beendet.`)) return;
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
      setError(`Freigabe konnte nicht geändert werden: ${e}`);
      loadApps();   // reset the display to the actual server state
    }
  };

  const deactivate = async () => {
    if (!confirm(`${user.username} deaktivieren? Login gesperrt, Daten bleiben erhalten.`)) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}/deactivate`, { method: "POST" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      onChanged(); onBack();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const deleteUser = async () => {
    if (!confirm(`${user.username} ENDGÜLTIG aus Authentik löschen? Nur für falsch angelegte Konten — für Familienmitglieder lieber deaktivieren.`)) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${UA}/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
      if (!r.ok) { const b = await r.json(); throw new Error(b.detail || `HTTP ${r.status}`); }
      onChanged(); onBack();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const availableGroups = allGroups.filter((g) => !groups.includes(g));
  const visibleApps = apps.filter((a) => !appFilter || a.name.toLowerCase().includes(appFilter.toLowerCase()));

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <button className={styles.btn} onClick={onBack}>← Zurück</button>
        <h2>{user.name} <span className={styles.detailSub}>{user.username}</span></h2>
        {!user.is_active && <span className={styles.inactiveBadge}>inaktiv</span>}
        <span style={{ marginLeft: "auto" }} />
        <button className={styles.btn} onClick={() => onImpersonate(user.username)} disabled={!user.is_active}
          title="Zeigt nur die ClaraOS-Oberfläche des Users">ClaraOS-Ansicht →</button>
        <button className={styles.btn} onClick={() => onFullView(user.username)} disabled={!user.is_active}
          title="Voll-Ansicht inkl. Fremd-Apps (Nextcloud, Immich …) im Browser-Stream">🔎 Voll-Ansicht →</button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Password reset */}
      <section className={styles.section}>
        <h3>Passwort</h3>
        {pwResult ? (
          <div className={styles.pwBox}>
            <span className={styles.hint}>Neues Start-Passwort (einmalig):</span>
            <code className={styles.pwValue}>{pwResult}</code>
            <button className={styles.btn} onClick={() => { navigator.clipboard.writeText(pwResult); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? "✓" : "Kopieren"}
            </button>
          </div>
        ) : (
          <button className={styles.btn} onClick={resetPassword} disabled={busy || protectedUser}
            title={protectedUser ? "Geschützter Account" : ""}>
            {busy ? "…" : "🔑 Passwort zurücksetzen"}
          </button>
        )}
      </section>

      {/* Guide: Clara companion — rollout progress + parent view for children */}
      {guide && (
        <section className={styles.section} data-testid="guide-status">
          <h3>✦ Clara-Begleitung
            {guide.kid && <span className={styles.hint}> (Kind — Leitplanken aktiv)</span>}
          </h3>
          <p className={styles.hint}>
            {guide.profil_felder > 0
              ? `Profil: ${guide.profil_felder} Felder, zuletzt ${guide.updated_at
                  ? new Date(guide.updated_at).toLocaleDateString("de-DE") : "?"} ` +
                (guide.updated_by === "clara" ? "(von Clara gelernt)" : "(vom User gepflegt)")
              : "Profil: noch keins — Clara kennt diesen User noch nicht."}
            {guide.optout && " · 🔕 Vorschläge abgeschaltet"}
          </p>
          <p className={styles.hint}>
            {(["welcome", "device-setup", "files-tour", "fotos-tour"] as const).map((id, i) => {
              const labels: Record<string, string> = {
                welcome: "Willkommen", "device-setup": "Geräte-Setup",
                "files-tour": "Files-Tour", "fotos-tour": "Fotos-Tour",
              };
              const n = guide.nudges[id] ?? {};
              const stateTxt = n.done ? "✓" : n.dismissed
                ? `⏸ ${n.dismissed}× später` : "–";
              return `${i > 0 ? " · " : "Impulse: "}${labels[id]} ${stateTxt}`;
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
        <h3>Einrichtungsassistent</h3>
        {invite ? (
          <div>
            <span className={styles.hint}>
              Link nur JETZT sichtbar (gültig bis {new Date(invite.expires_at).toLocaleDateString("de-DE")}):
            </span>
            <div className={styles.pwBox}>
              <code className={styles.pwValue} style={{ fontSize: 11, wordBreak: "break-all" }}>{invite.invite_url}</code>
              <button className={styles.btn} onClick={() => {
                navigator.clipboard.writeText(invite.invite_url);
                setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1500);
              }}>{inviteCopied ? "✓" : "Kopieren"}</button>
            </div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 12, width: "fit-content", marginTop: 8 }}>
              <QRCodeSVG value={invite.invite_url} size={130} marginSize={1} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className={styles.btn} onClick={createInvite} disabled={inviteBusy || !user.is_active}>
              {inviteBusy ? "…" : "\u{1F517} Neuen Einladungslink erzeugen"}
            </button>
            {inviteStatus === "offen" && (
              <>
                <span className={styles.hint}>Ein offener Link existiert (neu erzeugen ersetzt ihn).</span>
                <button className={styles.btn} onClick={revokeInvite} disabled={inviteBusy}>Widerrufen</button>
              </>
            )}
          </div>
        )}
      </section>

      {/* Budget */}
      <section className={styles.section}>
        <h3>Clara-Budget <span className={styles.hint}>(Token-Kosten pro Monat)</span></h3>
        {budget === null ? (
          <span className={styles.hint}>lädt…</span>
        ) : budget.available === false ? (
          <span className={styles.hint}>Budget-System nicht erreichbar.</span>
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
                {budget.budget_exceeded && <span className={styles.inactiveBadge}>überschritten</span>}
              </span>
            </div>
            <div className={styles.budgetEdit}>
              <label>Monatslimit €</label>
              <input className={styles.input} type="number" min="0" step="1" style={{ width: 90 }}
                value={budgetEdit} onChange={(e) => setBudgetEdit(e.target.value)} />
              <button className={styles.btn} onClick={saveBudget} disabled={budgetSaving}>
                {budgetSaving ? "…" : "Setzen"}
              </button>
              <span className={styles.hint}>0 = unbegrenzt</span>
            </div>
          </>
        )}
      </section>

      {/* Groups */}
      <section className={styles.section}>
        <h3>Gruppen</h3>
        <div className={styles.groupChips}>
          {groups.map((g) => (
            <span key={g} className={`${styles.chip} ${styles.chipOn}`}>
              {g} <button className={styles.chipX} onClick={() => removeGroup(g)}>×</button>
            </span>
          ))}
        </div>
        {availableGroups.length > 0 && (
          <details className={styles.addGroup}>
            <summary>+ Gruppe hinzufügen</summary>
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
        <h3>App-Berechtigungen <span className={styles.hint}>({apps.filter((a) => a.effective).length}/{apps.length} sichtbar)</span></h3>
        <input className={styles.input} style={{ maxWidth: 220, marginBottom: 8 }} placeholder="Apps filtern…"
          value={appFilter} onChange={(e) => setAppFilter(e.target.value)} />
        <div className={styles.appList}>
          {visibleApps.map((a) => (
            <div key={a.id} className={styles.appRow}>
              <span className={styles.appName}>{a.name}</span>
              <span className={styles.appCat}>{a.category}</span>
              <span className={`${styles.appState} ${a.effective ? styles.appOn : styles.appOff}`}>
                {a.effective ? "sichtbar" : "verborgen"}
                {a.override !== null && <span className={styles.overrideDot} title="Per-User-Override">•</span>}
              </span>
              <div className={styles.appActions}>
                <button className={`${styles.miniBtn} ${a.override === true ? styles.miniOn : ""}`}
                  onClick={() => setAppOverride(a.id, "on")} title="Immer sichtbar">an</button>
                <button className={`${styles.miniBtn} ${a.override === false ? styles.miniOn : ""}`}
                  onClick={() => setAppOverride(a.id, "off")} title="Immer verborgen">aus</button>
                {a.override !== null && (
                  <button className={styles.miniBtn} onClick={() => setAppOverride(a.id, "default")} title="Gruppen-Standard">auto</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Danger zone */}
      {!protectedUser && (
        <section className={styles.section}>
          <h3>Konto</h3>
          <div style={{ display: "flex", gap: 10 }}>
            <button className={styles.btn} onClick={deactivate} disabled={busy || !user.is_active}>
              Deaktivieren
            </button>
            <button className={styles.btnDanger} onClick={deleteUser} disabled={busy}>
              Löschen
            </button>
          </div>
          <span className={styles.hint}>Familienmitglieder deaktivieren (Datenerhalt); Löschen nur für Fehlanlagen.</span>
        </section>
      )}
    </div>
  );
}
