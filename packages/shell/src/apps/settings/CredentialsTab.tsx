import { useEffect, useState } from "react";
import { useUIStore } from "@claraos/core";
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
      toast("Anzeigen fehlgeschlagen", String(e), "\u26A0");
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Kopiert", `${label} ist in der Zwischenablage.`);
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
      await copyToClipboard(pwd, "password");
    } catch (e) {
      toast("Kopieren fehlgeschlagen", String(e), "\u26A0");
    }
  };

  const deleteItem = async (id: string, name: string) => {
    if (!confirm(`Move "${name}" to trash?`)) return;
    const r = await fetch(`/api/claraos/vault/item/${id}`, { method: "DELETE" });
    if (!r.ok) {
      toast("L\u00f6schen fehlgeschlagen", await r.text(), "\u26A0");
      return;
    }
    setItems((cur) => cur.filter((i) => i.id !== id));
  };

  if (loading) {
    return (
      <div className={styles.tab}>
        <h2 className={styles.heading}>Zugangsdaten</h2>
        <p>Wird geladen…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.tab}>
        <h2 className={styles.heading}>Zugangsdaten</h2>
        <p className={styles.error}>Tresor konnte nicht geladen werden: {error}</p>
        <button className={styles.btnPrimary} onClick={loadAll}>Erneut versuchen</button>
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
        <h2 className={styles.heading}>Zugangsdaten</h2>
        <button className={styles.btnPrimary} onClick={() => setShowCreate(true)}>
          + Neu
        </button>
      </div>

      {access && (
        <p className={styles.subtle}>
          Angemeldet als <code>{access.username}</code> · Gruppen: {access.groups.join(", ") || "(keine)"}
          <br />
          Sichtbar: {access.personal_collection}
          {access.can_see_family && " · Family-Shared"}
          {access.can_see_admin && " · Admin-Only"}
        </p>
      )}

      {items.length === 0 ? (
        <p className={styles.empty}>
          Noch keine Zugangsdaten. Über <strong>+ Neu</strong> welche in {personalName} anlegen.
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
                    <span>👤 {username || "(no username)"}</span>
                    <button
                      className={styles.iconBtn}
                      onClick={() => copyToClipboard(username, "username")}
                      title="Benutzernamen kopieren"
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
                      title={revealedPwd ? "Verbergen" : "Anzeigen (10 s)"}
                    >
                      {revealedPwd ? "🙈" : "👁"}
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={() => copyPwd(item.id)}
                      title="Passwort kopieren"
                    >
                      📋
                    </button>
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setEditingId(item.id)}
                    title="Bearbeiten"
                  >
                    ✎
                  </button>
                  <button
                    className={styles.iconBtn}
                    onClick={() => deleteItem(item.id, item.name)}
                    title="In den Papierkorb"
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
    if (!name.trim()) return setError("Name is required");
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
          {mode === "create" ? "Neue Zugangsdaten" : "Zugangsdaten bearbeiten"}
        </h3>

        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z. B. Github-SSH-Schlüssel"
        />

        {mode === "create" && (
          <>
            <label className={styles.label}>Sammlung</label>
            <select
              className={styles.input}
              value={kind}
              onChange={(e) => setKind(e.target.value as CollKind)}
            >
              <option value="personal">Persönlich ({access?.personal_collection})</option>
              {access?.can_see_family && <option value="family">Family-Shared</option>}
              {access?.can_see_admin && <option value="admin">Admin-Only</option>}
            </select>
          </>
        )}

        <label className={styles.label}>Benutzername / E-Mail</label>
        <input
          className={styles.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label className={styles.label}>Passwort</label>
        <div className={styles.row}>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className={styles.btnSecondary} onClick={generatePwd} type="button">
            Erzeugen
          </button>
        </div>

        <label className={styles.label}>URL</label>
        <input
          className={styles.input}
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="https://example.com"
        />

        <label className={styles.label}>Notizen</label>
        <textarea
          className={styles.input}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
          <button className={styles.btnPrimary} onClick={submit} disabled={busy}>
            {busy ? "Wird gespeichert…" : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}
