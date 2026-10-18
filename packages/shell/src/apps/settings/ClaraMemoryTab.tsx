/**
 * "What Clara knows about me" — the trust anchor of the guide concept:
 * everything Clara has learned about the user can be viewed, edited and
 * deleted here. Lists are edited as one line per entry.
 */
import { useEffect, useState } from "react";
import styles from "./ClaraMemoryTab.module.css";

const API = "/api/claraos/guide/profile";

const FIELD_LABELS: Record<string, string> = {
  rolle: "Meine Rolle",
  ziele: "Meine Ziele",
  technik_komfort: "Technik-Komfort",
  vorlieben: "Vorlieben",
  notizen: "Notizen",
};

type Profile = Record<string, string | string[]>;

export function ClaraMemoryTab() {
  const [profil, setProfil] = useState<Profile>({});
  const [exists, setExists] = useState(false);
  const [meta, setMeta] = useState<{ by?: string; at?: string }>({});
  const [status, setStatus] = useState<"laden" | "bereit" | "speichert" | "fehler">("laden");
  const [dirty, setDirty] = useState(false);
  const [nudgesOn, setNudgesOn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(API, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        setProfil(d.profil ?? {});
        setExists(Boolean(d.exists));
        setMeta({ by: d.updated_by, at: d.updated_at });
        setStatus("bereit");
      })
      .catch(() => setStatus("fehler"));
    fetch("/api/claraos/guide/nudges", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setNudgesOn(!d.optout))
      .catch(() => setNudgesOn(null));
  }, []);

  const toggleNudges = async (on: boolean) => {
    setNudgesOn(on);
    await fetch("/api/claraos/guide/nudges-optout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optout: !on }),
    }).catch(() => setNudgesOn(!on));
  };

  const save = async (next: Profile) => {
    setStatus("speichert");
    try {
      const r = await fetch(API, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profil: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setProfil(next);
      setExists(Object.keys(next).length > 0);
      setMeta({ by: "user", at: new Date().toISOString() });
      setDirty(false);
      setStatus("bereit");
    } catch {
      setStatus("fehler");
    }
  };

  const setField = (key: string, raw: string) => {
    const wasList = Array.isArray(profil[key]) || raw.includes("\n");
    setProfil((p) => ({
      ...p,
      [key]: wasList ? raw.split("\n").map((s) => s.trim()).filter(Boolean) : raw,
    }));
    setDirty(true);
  };

  const removeField = (key: string) => {
    setProfil((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    setDirty(true);
  };

  if (status === "laden") return <p className={styles.hint}>Lade…</p>;

  const keys = Object.keys(profil);
  return (
    <div className={styles.wrap} data-testid="clara-memory">
      <h2 className={styles.title}>Was Clara über mich weiß</h2>
      <p className={styles.hint}>
        Clara merkt sich hier — nur mit deiner Zustimmung im Gespräch — wer du
        bist und was dir wichtig ist, um dir besser zu helfen. Du kannst alles
        ändern oder löschen; Clara nutzt danach sofort den neuen Stand.
      </p>

      {keys.length === 0 && (
        <p className={styles.empty}>
          Clara kennt dich noch nicht. Sag ihr im Chat einfach Hallo — sie
          stellt sich vor und fragt, was du dir merken lassen möchtest.
        </p>
      )}

      {keys.map((key) => {
        const val = profil[key];
        const text = Array.isArray(val) ? val.join("\n") : String(val ?? "");
        return (
          <div className={styles.field} key={key}>
            <div className={styles.fieldHead}>
              <label className={styles.label}>{FIELD_LABELS[key] ?? key}</label>
              <button className={styles.ghost} onClick={() => removeField(key)}
                      title="Feld entfernen">✕</button>
            </div>
            <textarea
              className={styles.input}
              rows={Math.min(5, Math.max(1, text.split("\n").length))}
              value={text}
              onChange={(e) => setField(key, e.target.value)}
            />
          </div>
        );
      })}

      <div className={styles.actions}>
        <button className={styles.primary} disabled={!dirty || status === "speichert"}
                onClick={() => void save(profil)}>
          {status === "speichert" ? "Speichert…" : "Speichern"}
        </button>
        {exists && (
          <button className={styles.danger}
                  onClick={() => { if (window.confirm("Wirklich alles löschen, was Clara über dich weiß?")) void save({}); }}>
            Alles löschen
          </button>
        )}
      </div>

      {nudgesOn !== null && (
        <label className={styles.toggleRow} data-testid="nudge-optout">
          <input type="checkbox" checked={nudgesOn}
                 onChange={(e) => void toggleNudges(e.target.checked)} />
          <span>
            Clara darf mir Vorschläge machen (Touren, Tipps zum Einstieg).
            Ausgeschaltet meldet sie sich nur, wenn du sie ansprichst.
          </span>
        </label>
      )}

      {meta.at && (
        <p className={styles.meta}>
          Zuletzt geändert {meta.by === "clara" ? "von Clara (mit deiner Zustimmung)" : "von dir"}
          {" am "}{new Date(meta.at).toLocaleString("de-DE")}
        </p>
      )}
      {status === "fehler" && <p className={styles.error}>Speichern/Laden fehlgeschlagen — bitte nochmal versuchen.</p>}
    </div>
  );
}
