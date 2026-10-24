/**
 * "What Clara knows about me" — the trust anchor of the guide concept:
 * everything Clara has learned about the user can be viewed, edited and
 * deleted here. Lists are edited as one line per entry.
 */
import { useEffect, useState } from "react";
import styles from "./ClaraMemoryTab.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

const API = "/api/claraos/guide/profile";

// Profile keys with a catalog label (clara.fields.<key>); others show raw.
const FIELD_LABELS = ["rolle", "ziele", "technik_komfort", "vorlieben", "notizen"];

type Profile = Record<string, string | string[]>;

export function ClaraMemoryTab() {
  const { t } = useTranslation("settingsTabs");
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

  if (status === "laden") return <p className={styles.hint}>{t("claraMemory.loading")}</p>;

  const keys = Object.keys(profil);
  return (
    <div className={styles.wrap} data-testid="clara-memory">
      <h2 className={styles.title}>{t("claraMemory.title")}</h2>
      <p className={styles.hint}>{t("claraMemory.intro")}</p>

      {keys.length === 0 && (
        <p className={styles.empty}>{t("claraMemory.empty")}</p>
      )}

      {keys.map((key) => {
        const val = profil[key];
        const text = Array.isArray(val) ? val.join("\n") : String(val ?? "");
        return (
          <div className={styles.field} key={key}>
            <div className={styles.fieldHead}>
              <label className={styles.label}>{FIELD_LABELS.includes(key) ? t(`claraMemory.fields.${key}`) : key}</label>
              <button className={styles.ghost} onClick={() => removeField(key)}
                      title={t("claraMemory.removeField")}>✕</button>
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
          {status === "speichert" ? t("claraMemory.saving") : t("claraMemory.save")}
        </button>
        {exists && (
          <button className={styles.danger}
                  onClick={() => { if (window.confirm(t("claraMemory.confirmDeleteAll"))) void save({}); }}>
            {t("claraMemory.deleteAll")}
          </button>
        )}
      </div>

      {nudgesOn !== null && (
        <label className={styles.toggleRow} data-testid="nudge-optout">
          <input type="checkbox" checked={nudgesOn}
                 onChange={(e) => void toggleNudges(e.target.checked)} />
          <span>{t("claraMemory.nudges")}</span>
        </label>
      )}

      {meta.at && (
        <p className={styles.meta}>
          {t(meta.by === "clara" ? "claraMemory.changedByClara" : "claraMemory.changedByYou", {
            time: new Date(meta.at).toLocaleString(regionLocale()),
          })}
        </p>
      )}
      {status === "fehler" && <p className={styles.error}>{t("claraMemory.error")}</p>}
    </div>
  );
}
