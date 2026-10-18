/**
 * Quick settings — the landing page.
 *
 * Modeled on KDE's kcm_landingpage: instead of an empty first page, the
 * handful of things people actually look for first — light/dark, accent
 * color, UI scale, animation speed — plus the most recently used sections.
 *
 * The original feeds "Most used" from real usage and falls back to a
 * curated list while there is too little data. Same here.
 */
import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "@claraos/core";
import { ACCENT_PRESETS } from "@claraos/skins";
import styles from "./SettingsApp.module.css";
import { Icon } from "../../components/Icon";
import { modulPlaettchen } from "./modulSymbole";

const RECENT_KEY = "claraos-settings-recent";
const FALLBACK_MODULES = [
  "personalization",
  "appearance",
  "notifications",
  "shortcuts",
  "region-formats",
  "privacy-history",
];

/** Record recently opened sections — called by the shell. */
export function rememberSettingsModule(moduleId: string): void {
  try {
    const prev: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const next = [moduleId, ...prev.filter((m) => m !== moduleId)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* without history the landing page is simply curated */
  }
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

interface Props {
  onOpen: (moduleId: string) => void;
}

export function QuickSettingsPage({ onOpen }: Props) {
  const store = useSettingsStore();
  const values = store.values["appearance"] ?? {};
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void store.loadModule("appearance");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = async (key: string, value: unknown) => {
    store.setDraft("appearance", key, value);
    await store.apply("appearance");
    setTick((t) => t + 1);
  };

  const mode = String(values.themeMode ?? "skin");
  const accentSource = String(values.accentSource ?? "skin");
  const accent = String(values.accentColor ?? "#3daee9");
  const scale = Number(values.uiScale ?? 100);
  const speed = String(values.animationSpeedHint ?? "");

  // Recently used, with a curated fallback — a landing page that is empty
  // on first start helps nobody.
  const recent = useMemo(() => {
    const seen = readRecent();
    const ids = [...seen, ...FALLBACK_MODULES.filter((m) => !seen.includes(m))].slice(0, 6);
    return ids
      .map((id) => store.modules.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
  }, [store.modules, tick]);

  return (
    <div className={styles.quickPage}>
      <section>
        <h3>Hell oder dunkel</h3>
        <div className={styles.modeTiles}>
          {[
            { id: "skin", label: "Wie das Design" },
            { id: "light", label: "Immer hell" },
            { id: "dark", label: "Immer dunkel" },
            { id: "auto", label: "Nach Tageszeit" },
          ].map((m) => (
            <button
              key={m.id}
              className={`${styles.modeTile} ${mode === m.id ? styles.modeTileActive : ""}`}
              aria-pressed={mode === m.id}
              onClick={() => void set("themeMode", m.id)}
            >
              <span className={styles.modeSwatch} data-mode={m.id} aria-hidden />
              {m.label}
            </button>
          ))}
        </div>
        {mode === "auto" && (
          <p className={styles.rowDesc}>
            Wechselt um {String(values.sunriseHour ?? 7)} und{" "}
            {String(values.sunsetHour ?? 20)} Uhr — Zeiten unter „Farben &amp; Darstellung“.
          </p>
        )}
      </section>

      <section>
        <h3>Akzentfarbe</h3>
        <div className={styles.colorPicker} style={{ maxWidth: "none", justifyContent: "flex-start" }}>
          <button
            className={`${styles.swatch} ${accentSource === "skin" ? styles.swatchActive : ""}`}
            style={{ background: "var(--accent)" }}
            title="Farbe des Designs"
            aria-label="Farbe des Designs verwenden"
            onClick={() => void set("accentSource", "skin")}
          />
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              className={`${styles.swatch} ${
                accentSource === "custom" && accent === c ? styles.swatchActive : ""
              }`}
              style={{ background: c }}
              title={c}
              aria-label={`Akzentfarbe ${c}`}
              onClick={async () => {
                store.setDraft("appearance", "accentColor", c);
                store.setDraft("appearance", "accentSource", "custom");
                await store.apply("appearance");
                setTick((t) => t + 1);
              }}
            />
          ))}
        </div>
      </section>

      <section>
        <h3>Oberflächengröße</h3>
        <div className={styles.scaleRow}>
          <input
            type="range"
            min={80}
            max={150}
            step={10}
            value={scale}
            aria-label="Oberflächengröße"
            onChange={(e) => void set("uiScale", Number(e.target.value))}
          />
          <span>{scale} %</span>
        </div>
      </section>

      <section>
        <h3>Zuletzt benutzt</h3>
        <div className={styles.recentGrid}>
          {recent.map((m) => (
            <button key={m.id} className={styles.recentTile} onClick={() => onOpen(m.id)}>
              <span className={styles.plaettchen} style={{ background: modulPlaettchen(m.id, m.category).farbe }} aria-hidden="true"><Icon name={modulPlaettchen(m.id, m.category).icon} size={15} /></span>
              {m.name}
            </button>
          ))}
        </div>
      </section>
      {speed && <span hidden>{speed}</span>}
    </div>
  );
}
