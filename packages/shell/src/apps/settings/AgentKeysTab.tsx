/**
 * "Agenten-Zugang" — the user's own keys for the MCP endpoint.
 *
 * With a key, an AI agent of the user's choice (Claude Code, Cursor, …) works in
 * ClaraOS as this user: planner, mail, calendar, documents. Read-only unless the
 * key may write; sending, deleting and passwords never. The key is shown once,
 * only its hash is stored. Every call an agent makes is listed below, so access
 * that nobody can see does not exist.
 * Endpoints: GET/POST /api/claraos/agent-keys, DELETE /api/claraos/agent-keys/{id}.
 * All requests send JSON: the API accepts them only from a person in the shell.
 */
import { useCallback, useEffect, useState } from "react";
import { useUIStore } from "@claraos/core";
import styles from "./ClaraMemoryTab.module.css";

interface AgentKey {
  id: string;
  name: string;
  prefix: string;
  can_write: boolean;
  created?: string | null;
  last_used?: string | null;
}

interface AgentCall {
  tool: string;
  ok: boolean;
  at: string;
  key?: string | null;
}

interface Overview {
  enabled: boolean;
  endpoint: string;
  keys: AgentKey[];
  calls: AgentCall[];
  max_keys: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function zeit(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function copy(text: string, label: string) {
  const done = () => useUIStore.getState().addNotification({ title: "Kopiert", body: label, icon: "📋" });
  navigator.clipboard?.writeText(text).then(done).catch(() => {
    useUIStore.getState().addNotification({
      title: "Kopieren nicht möglich", body: `${label} bitte von Hand markieren und kopieren.`, icon: "⚠️",
    });
  });
}

function Kopierfeld({ label, wert }: { label: string; wert: string }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.label}>{label}</span>
        <button type="button" className={styles.ghost} onClick={() => copy(wert, label)}>Kopieren</button>
      </div>
      <code style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.8rem" }}>{wert}</code>
    </div>
  );
}

export function AgentKeysTab() {
  const [daten, setDaten] = useState<Overview | null>(null);
  const [status, setStatus] = useState<"laden" | "bereit" | "fehler">("laden");
  const [name, setName] = useState("");
  const [schreiben, setSchreiben] = useState(false);
  const [neu, setNeu] = useState<{ key: string; endpoint: string; name: string } | null>(null);
  const [fehler, setFehler] = useState("");
  const [arbeitet, setArbeitet] = useState(false);

  const laden = useCallback(async () => {
    try {
      const r = await fetch("/api/claraos/agent-keys", { credentials: "include", headers: JSON_HEADERS });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDaten(await r.json());
      setStatus("bereit");
    } catch {
      setStatus("fehler");
    }
  }, []);
  useEffect(() => { void laden(); }, [laden]);

  const erstellen = async () => {
    setArbeitet(true);
    setFehler("");
    try {
      const r = await fetch("/api/claraos/agent-keys", {
        method: "POST", credentials: "include", headers: JSON_HEADERS,
        body: JSON.stringify({ name: name.trim() || "Agent", can_write: schreiben }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setFehler(d.detail || `Fehler ${r.status}`); return; }
      setNeu({ key: d.key, endpoint: d.endpoint, name: d.name });
      setName("");
      setSchreiben(false);
      await laden();
    } finally {
      setArbeitet(false);
    }
  };

  const widerrufen = async (id: string) => {
    const r = await fetch(`/api/claraos/agent-keys/${id}`, {
      method: "DELETE", credentials: "include", headers: JSON_HEADERS,
    });
    if (r.ok) await laden();
  };

  const claudeCode = neu
    ? `claude mcp add --transport http claraos ${neu.endpoint} --header "Authorization: Bearer ${neu.key}"`
    : "";
  const mcpJson = neu
    ? JSON.stringify({ mcpServers: { claraos: { url: neu.endpoint, headers: { Authorization: `Bearer ${neu.key}` } } } }, null, 2)
    : "";

  return (
    <div className={styles.wrap} data-settings-tab="agent-keys">
      <p className={styles.hint}>
        Mit einem Agenten-Schlüssel arbeitet ein KI-Agent deiner Wahl (Claude Code, Cursor …) in deinem
        Namen in ClaraOS: Planner, Mail, Kalender, Kontakte, Dokumente. Er sieht nur, was du siehst.
        Senden, Löschen und Passwörter bleiben ihm immer verschlossen.
      </p>
      {status === "laden" && <p className={styles.meta}>Lade …</p>}
      {status === "fehler" && <p className={styles.error}>Agenten-Zugang konnte nicht geladen werden.</p>}

      {daten && !daten.enabled && (
        <div className={styles.empty}>
          Der Agenten-Zugang ist in dieser Installation ausgeschaltet. Einschalten kann ihn, wer den
          Server betreibt (<code>setup.sh --mcp</code>).
        </div>
      )}

      {neu && (
        <div className={styles.field} data-agent-key-new>
          <div className={styles.label}>Schlüssel „{neu.name}“ — wird nur jetzt angezeigt</div>
          <Kopierfeld label="Schlüssel" wert={neu.key} />
          <Kopierfeld label="Adresse" wert={neu.endpoint} />
          <Kopierfeld label="Claude Code" wert={claudeCode} />
          <Kopierfeld label="mcp.json (z. B. Cursor)" wert={mcpJson} />
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => setNeu(null)}>Ich habe ihn gesichert</button>
          </div>
        </div>
      )}

      {daten?.enabled && !neu && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="agent-key-name">Neuer Schlüssel</label>
          <input
            id="agent-key-name"
            className={styles.input}
            placeholder="Name, z. B. Claude auf dem Laptop"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <label className={styles.toggleRow}>
            <input type="checkbox" checked={schreiben} onChange={(e) => setSchreiben(e.target.checked)} />
            <span>Darf auch ändern (Aufgaben anlegen, Termine eintragen, Mail-Entwürfe schreiben)</span>
          </label>
          {fehler && <p className={styles.error}>{fehler}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={arbeitet} onClick={() => void erstellen()}>
              {arbeitet ? "…" : "Schlüssel erstellen"}
            </button>
          </div>
        </div>
      )}

      {daten && daten.keys.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {daten.keys.map((k) => (
            <li key={k.id} className={styles.field} data-agent-key-id={k.id}>
              <div className={styles.fieldHead}>
                <div>
                  <div className={styles.label}>{k.name}</div>
                  <p className={styles.meta}>
                    {k.prefix}… · {k.can_write ? "lesen und ändern" : "nur lesen"}
                    {k.created ? ` · seit ${zeit(k.created)}` : ""}
                    {` · ${k.last_used ? `zuletzt ${zeit(k.last_used)}` : "noch nie benutzt"}`}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => void widerrufen(k.id)}
                  aria-label={`Schlüssel ${k.name} widerrufen`}
                >
                  Widerrufen
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {daten?.enabled && daten.keys.length === 0 && !neu && (
        <div className={styles.empty}>Noch kein Schlüssel. Ohne Schlüssel kommt kein Agent herein.</div>
      )}

      {daten && daten.calls.length > 0 && (
        <div className={styles.field}>
          <div className={styles.label}>Letzte Aufrufe deiner Agenten</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
            {daten.calls.map((c, i) => (
              <li key={i} className={styles.meta}>
                {zeit(c.at)} · {c.key ?? "gelöschter Schlüssel"} · {c.tool} · {c.ok ? "ok" : "abgelehnt/Fehler"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
