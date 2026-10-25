import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { INSTALL_TEXTS } from "../../installTexts";
import styles from "./UserAdminApp.module.css";
import { regionLocale, Trans, useTranslation } from "@claraos/core";

const UA = "/api/claraos/user-admin";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface CreateResult {
  username: string;
  password: string;
  email: string;
  steps: Record<string, unknown>;
}

function genPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

export function CreateUserWizard({ onClose, onCreated }: Props) {
  const { t } = useTranslation("userAdmin");
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [familyPreset, setFamilyPreset] = useState<string[]>(["clara-users", "team-family"]);
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [ncQuota, setNcQuota] = useState("50 GB");
  const [createNc, setCreateNc] = useState(true);
  const [createMail, setCreateMail] = useState(true);
  const [mailAvailable, setMailAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [invite, setInvite] = useState<{ invite_url: string; expires_at: string } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);

  const createInvite = async () => {
    if (!result) return;
    setInviteBusy(true); setInviteError("");
    try {
      const r = await fetch(`${UA}/users/${result.username}/invite`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      setInvite(body);
    } catch (e) {
      setInviteError((e as Error).message);
    }
    setInviteBusy(false);
  };

  useEffect(() => {
    fetch(`${UA}/groups`)
      .then((r) => r.json())
      .then((d) => {
        setAllGroups(d.groups || []);
        setFamilyPreset(d.family_preset || ["clara-users", "team-family"]);
        setGroups(d.family_preset || ["clara-users", "team-family"]);
      })
      .catch(() => {});
    // Mail availability is heuristic: /users/_probe/apps does not exist — we read
    // availability from the result. Optimistically on beforehand; the backend
    // skips cleanly if the secret is missing.
    setMailAvailable(true);
  }, []);

  // Derive the username from the name (until edited manually)
  useEffect(() => {
    if (usernameEdited) return;
    const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
    setUsername(slug);
  }, [name, usernameEdited]);

  const toggleGroup = (g: string) =>
    setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const password = genPassword();
      const res = await fetch(`${UA}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username, name, email: createMail ? "" : "",
          password, groups,
          create_nextcloud: createNc, nc_quota: ncQuota,
          create_mail: createMail,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      setResult(body);
      // Check the result of the mail step
      const mailStep = String(body.steps?.mail ?? "");
      if (createMail && mailStep.includes("übersprungen")) setMailAvailable(false);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  // Result view: password shown ONCE
  if (result) {
    return (
      <div className={styles.modalOverlay}>
        <div className={styles.modal}>
          <h2>{t("wizard.created", { user: result.username })}</h2>
          <p className={styles.modalHint}>
            <Trans t={t} i18nKey="wizard.passwordOnce" components={{ b: <strong /> }} />
          </p>
          <div className={styles.pwBox}>
            <code className={styles.pwValue}>{result.password}</code>
            <button className={styles.btn} onClick={() => {
              navigator.clipboard.writeText(result.password);
              setCopied(true); setTimeout(() => setCopied(false), 1500);
            }}>{copied ? t("common.copied") : t("common.copy")}</button>
          </div>
          <div className={styles.stepList}>
            {Object.entries(result.steps).map(([k, v]) => (
              <div key={k} className={styles.stepRow}>
                <span className={styles.stepKey}>{k}</span>
                <span className={styles.stepVal}>{Array.isArray(v) ? v.join(", ") || "—" : String(v)}</span>
              </div>
            ))}
          </div>
          {result.email && <p className={styles.modalHint}>{t("wizard.mail")} <code>{result.email}</code></p>}

          {/* Invite link for the setup assistant (public portal).
              Like the password: the link is only visible NOW (the DB only keeps the hash). */}
          {!invite ? (
            <div style={{ margin: "12px 0" }}>
              <button className={styles.btn} onClick={createInvite} disabled={inviteBusy}>
                {inviteBusy ? t("wizard.inviteBusy") : t("wizard.invite")}
              </button>
              {inviteError && <p className={styles.error}>{inviteError}</p>}
            </div>
          ) : (
            <div style={{ margin: "12px 0" }}>
              <p className={styles.modalHint}>
                <Trans t={t} i18nKey="wizard.inviteHint" components={{ b: <strong /> }}
                       values={{ date: new Date(invite.expires_at).toLocaleDateString(regionLocale()) }} />
              </p>
              <div className={styles.pwBox}>
                <code className={styles.pwValue} style={{ fontSize: 11, wordBreak: "break-all" }}>{invite.invite_url}</code>
                <button className={styles.btn} onClick={() => {
                  navigator.clipboard.writeText(invite.invite_url);
                  setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1500);
                }}>{inviteCopied ? t("common.copied") : t("common.copy")}</button>
              </div>
              <div style={{ background: "#fff", borderRadius: 10, padding: 12, width: "fit-content", margin: "10px auto" }}>
                <QRCodeSVG value={invite.invite_url} size={140} marginSize={1} />
              </div>
            </div>
          )}

          <div className={styles.modalActions}>
            <button className={styles.btnPrimary} onClick={onClose}>{t("wizard.done")}</button>
          </div>
        </div>
      </div>
    );
  }

  const canNext = username.length >= 2 && name.trim().length > 0;

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modal}>
        <h2>{step === 2 ? t("wizard.titleServices") : t("wizard.title")}</h2>

        {step === 1 && (
          <>
            <label className={styles.field}>
              <span>{t("wizard.name")}</span>
              <input className={styles.input} value={name} autoFocus
                onChange={(e) => setName(e.target.value)} placeholder={t("wizard.namePlaceholder")} />
            </label>
            <label className={styles.field}>
              <span>{t("wizard.username")}</span>
              <input className={styles.input} value={username}
                onChange={(e) => { setUsername(e.target.value); setUsernameEdited(true); }}
                placeholder={t("wizard.usernamePlaceholder")} />
            </label>
            <div className={styles.field}>
              <span>{t("wizard.groups")}</span>
              <div className={styles.groupChips}>
                {allGroups.map((g) => (
                  <button key={g} type="button"
                    className={`${styles.chip} ${groups.includes(g) ? styles.chipOn : ""} ${familyPreset.includes(g) ? styles.chipPreset : ""}`}
                    onClick={() => toggleGroup(g)}>{g}</button>
                ))}
              </div>
              <span className={styles.hint}>{t("wizard.presetHint")}</span>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btn} onClick={onClose}>{t("wizard.cancel")}</button>
              <button className={styles.btnPrimary} disabled={!canNext} onClick={() => setStep(2)}>{t("wizard.next")}</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <label className={styles.checkRow}>
              <input type="checkbox" checked={createNc} onChange={(e) => setCreateNc(e.target.checked)} />
              <span>{t("wizard.createNc")}</span>
            </label>
            {createNc && (
              <label className={styles.field}>
                <span>{t("wizard.quota")}</span>
                <select className={styles.input} value={ncQuota} onChange={(e) => setNcQuota(e.target.value)}>
                  <option>10 GB</option><option>50 GB</option><option>100 GB</option><option>none</option>
                </select>
              </label>
            )}
            <label className={styles.checkRow}>
              <input type="checkbox" checked={createMail} onChange={(e) => setCreateMail(e.target.checked)} />
              <span>{t("wizard.createMail")}</span>
            </label>
            {mailAvailable === false && (
              <span className={styles.hint}>{INSTALL_TEXTS.mailSecretMissing}</span>
            )}
            <div className={styles.summary}>
              <strong>{name}</strong> ({username}) · {t("wizard.groupCount", { count: groups.length })}
              {createNc && ` · NC ${ncQuota}`}{createMail && " · Mail"}
            </div>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.modalActions}>
              <button className={styles.btn} onClick={() => setStep(1)} disabled={busy}>{t("common.back")}</button>
              <button className={styles.btnPrimary} onClick={submit} disabled={busy}>
                {busy ? t("wizard.creating") : t("wizard.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
