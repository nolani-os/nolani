import { useEffect, useState } from "react";
import { useUIStore, useTranslation, i18n } from "@claraos/core";
import styles from "./CredentialsTab.module.css";

const toast = (title: string, body: string, icon = "\u{1F511}") =>
  useUIStore.getState().addNotification({ title, body, icon });

type CollKind = "personal" | "family" | "admin";

interface VaultItem {
  id: string;
  name: string;
  notes?: string | null;
  collectionIds: string[];
  login?: { username?: string; password?: string | null; uris?: { uri?: string }[] };
}

interface AccessInfo {
  username: string;
  groups: string[];
  personal_collection: string;
  can_see_family: boolean;
  can_see_admin: boolean;
}

const HEADERS = { "Content-Type": "application/json" };

export function CredentialsTab() {
  const { t } = useTranslation("settingsTabs");
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Bootstrap: /access + /items in parallel
  const loadAll = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/claraos/vault/access").then((r) => r.json()),
      fetch("/api/claraos/vault/items").then((r) => r.json()),
    ])
      .then(([acc, list]) => {
        setAccess(acc);
        setItems(list);
        setError("");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAll();
  }, []);

  // Auto-hide revealed passwords after 10 s
  const reveal = async (id: string) => {
    if (revealed[id]) {
      // already revealed → hide immediately
      setRevealed((r) => {
        const n = { ...r };
        delete n[id];
        return n;
      });
      return;
    }
    try {
      const r = await fetch(`/api/claraos/vault/item/${id}`);
      if (!r.ok) throw new Error(await r.text());
      const item: VaultItem = await r.json();
      const pwd = item.login?.password || "";
      setRevealed((s) => ({ ...s, [id]: pwd }));
      // auto-hide after 10s
      setTimeout(() => {
        setRevealed((s) => {
          const n = { ...s };
          delete n[id];
          return n;
        });
      }, 10_000);
    } catch (e) {
      toast(i18n.t("settingsTabs:credentials.revealFailed"), String(e), "\u26A0");
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(i18n.t("settingsTabs:credentials.copied"), i18n.t("settingsTabs:credentials.copiedBody", { label }));
    } catch {
      // fallback: select + copy via execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  const copyPwd = async (id: string) => {
    try {
      const r = await fetch(`/api/claraos/vault/item/${id}`);
      const item: VaultItem = await r.json();
      const pwd = item.login?.password || "";
      await copyToClipboard(pwd, t("credentials.labelPassword"));
    } catch (e) {
      toast(i18n.t("settingsTabs:credentials.copyFailed"), String(e), "\u26A0");
    }
  };

  const deleteItem = async (id: string, name: string) => {
    if (!confirm(t("credentials.confirmTrash", { name }))) return;
    const r = await fetch(`/api/claraos/vault/item/${id}`, { method: "DELETE" });
    if (!r.ok) {
      toast(i18n.t("settingsTabs:credentials.deleteFailed"), await r.text(), "\u26A0");
      return;
    }
    setItems((cur) => cur.filter((i) => i.id !== id));
  };

  if (loading) {
    return (
      <div className={styles.tab}>
        <h2 className={styles.heading}>{t("credentials.title")}</h2>
        <p>{t("credentials.loading")}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.tab}>
        <h2 className={styles.heading}>{t("credentials.title")}</h2>
        <p className={styles.error}>{t("credentials.loadError", { error })}</p>
        <button className={styles.btnPrimary} onClick={loadAll}>{t("credentials.retry")}</button>
      </div>
    );
  }

  const personalName = access?.personal_collection ?? "";
  const personalItems: VaultItem[] = [];
  const familyItems: VaultItem[] = [];
  const adminItems: VaultItem[] = [];

  // partition by name (collectionIds resolve client-side via heuristic on name match)
  // We don't have collection IDs here — use server's filtered list and just bucket by best guess.
  // For MVP: show all items in one combined section "Your accessible items".
  // (Collection-grouping would need server to send collection-info; we add later.)

  return (
    <div className={styles.tab}>
      <div className={styles.headerRow}>
        <h2 className={styles.heading}>{t("credentials.title")}</h2>
        <button className={styles.btnPrimary} onClick={() => setShowCreate(true)}>
          {t("credentials.new")}
        </button>
      </div>

      {access && (
        <p className={styles.subtle}>
          {t("credentials.signedInAs")} <code>{access.username}</code> · {t("credentials.groups")}{" "}
          {access.groups.join(", ") || t("credentials.noGroups")}
          <br />
          {t("credentials.visible")} {access.personal_collection}
          {access.can_see_family && " · Family-Shared"}
          {access.can_see_admin && " · Admin-Only"}
        </p>
      )}

      {items.length === 0 ? (
        <p className={styles.empty}>
          {t("credentials.emptyBefore")} <strong>{t("credentials.new")}</strong>{" "}
          {t("credentials.emptyAfter", { collection: personalName })}
        </p>
      ) : (
        <ul className={styles.itemList}>
          {items.map((item) => {
            const username = item.login?.username || "";
            const uri = item.login?.uris?.[0]?.uri || "";
            const revealedPwd = revealed[item.id];
            return (
              <li key={item.id} className={styles.itemCard}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{item.name}</div>
                  {uri && (
                    <a href={uri} target="_blank" rel="noopener noreferrer" className={styles.itemUri}>
                      {uri}
                    </a>
                  )}
                  <div className={styles.itemUser}>
                    <span>👤 {username || t("credentials.noUsername")}</span>
                    <button
                      className={styles.iconBtn}
                      onClick={() => copyToClipboard(username, t("credentials.labelUsername"))}
                      title={t("credentials.copyUsername")}
                    >
                      📋
                    </button>
                  </div>
                  <div className={styles.itemPwd}>
                    <span className={styles.pwdValue}>
                      {revealedPwd ? revealedPwd : "•••••••••"}
                    </span>
                    <button
                      className={styles.iconBtn}
                      onClick={() => reveal(item.id)}
                      title={revealedPwd ? t("credentials.hide") : t("credentials.reveal")}
                    >
                      {revealedPwd ? "🙈" : "👁"}
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={() => copyPwd(item.id)}
                      title={t("credentials.copyPassword")}
                    >
                      📋
                    </button>
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setEditingId(item.id)}
                    title={t("credentials.edit")}
                  >
                    ✎
                  </button>
                  <button
                    className={styles.iconBtn}
                    onClick={() => deleteItem(item.id, item.name)}
                    title={t("credentials.trash")}
                  >
                    🗑
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {showCreate && (
        <ItemModal
          mode="create"
          access={access}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            loadAll();
          }}
        />
      )}
      {editingId && (
        <ItemModal
          mode="edit"
          itemId={editingId}
          access={access}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            loadAll();
          }}
        />
      )}
    </div>
  );
}

// ── Modal: create or edit ─────────────────────────────────────────

interface ModalProps {
  mode: "create" | "edit";
  itemId?: string;
  access: AccessInfo | null;
  onClose: () => void;
  onSaved: () => void;
}

function ItemModal({ mode, itemId, access, onClose, onSaved }: ModalProps) {
  const { t } = useTranslation("settingsTabs");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [uri, setUri] = useState("");
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<CollKind>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // load existing item for edit
  useEffect(() => {
    if (mode === "edit" && itemId) {
      fetch(`/api/claraos/vault/item/${itemId}`)
        .then((r) => r.json())
        .then((it: VaultItem) => {
          setName(it.name);
          setUsername(it.login?.username || "");
          setPassword(it.login?.password || "");
          setUri(it.login?.uris?.[0]?.uri || "");
          setNotes(it.notes || "");
        })
        .catch((e) => setError(String(e)));
    }
  }, [mode, itemId]);

  const generatePwd = () => {
    // 24-char alpha-num with at least one special
    const specials = "!@#$%^&*()_+-=[]{}<>?";
    const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const digits = "0123456789";
    const pool = alpha + digits + specials;
    const rand = (s: string) => s[Math.floor(Math.random() * s.length)];
    let pwd = [rand(alpha), rand(alpha.toUpperCase()), rand(digits), rand(specials)];
    for (let i = pwd.length; i < 24; i++) pwd.push(rand(pool));
    pwd.sort(() => Math.random() - 0.5);
    setPassword(pwd.join(""));
  };

  const submit = async () => {
    if (!name.trim()) return setError(t("credentials.nameRequired"));
    setBusy(true);
    setError("");
    try {
      if (mode === "create") {
        const body = {
          name, login_username: username, login_password: password,
          uri, notes, kind,
        };
        const r = await fetch("/api/claraos/vault/items", {
          method: "POST", headers: HEADERS, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
      } else if (itemId) {
        const body = {
          name, login_username: username, login_password: password,
          uri, notes,
        };
        const r = await fetch(`/api/claraos/vault/item/${itemId}`, {
          method: "PUT", headers: HEADERS, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalHeading}>
          {mode === "create" ? t("credentials.modalNew") : t("credentials.modalEdit")}
        </h3>

        <label className={styles.label}>{t("credentials.fieldName")}</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("credentials.namePlaceholder")}
        />

        {mode === "create" && (
          <>
            <label className={styles.label}>{t("credentials.fieldCollection")}</label>
            <select
              className={styles.input}
              value={kind}
              onChange={(e) => setKind(e.target.value as CollKind)}
            >
              <option value="personal">{t("credentials.personal", { collection: access?.personal_collection })}</option>
              {access?.can_see_family && <option value="family">Family-Shared</option>}
              {access?.can_see_admin && <option value="admin">Admin-Only</option>}
            </select>
          </>
        )}

        <label className={styles.label}>{t("credentials.fieldUsername")}</label>
        <input
          className={styles.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label className={styles.label}>{t("credentials.fieldPassword")}</label>
        <div className={styles.row}>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className={styles.btnSecondary} onClick={generatePwd} type="button">
            {t("credentials.generate")}
          </button>
        </div>

        <label className={styles.label}>URL</label>
        <input
          className={styles.input}
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="https://example.com"
        />

        <label className={styles.label}>{t("credentials.fieldNotes")}</label>
        <textarea
          className={styles.input}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>
            {t("credentials.cancel")}
          </button>
          <button className={styles.btnPrimary} onClick={submit} disabled={busy}>
            {busy ? t("credentials.saving") : t("credentials.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
