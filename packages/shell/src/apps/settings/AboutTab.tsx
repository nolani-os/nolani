import { useWindowsStore, useUIStore, useAuthStore, useTranslation, getBrand } from "@claraos/core";
import styles from "./AboutTab.module.css";
import { regionLocale } from "@claraos/core";

const SKIN_LABELS: Record<string, string> = {
  "clara-glass": "Glass",
  "aero-glass": "Crystal",
  windows11: "Classic",
};
// Labels of this installation's own skins (heim.config.ts, optional).
const heimConfig = import.meta.glob<{ SKIN_LABELS?: Record<string, string> }>("../../heim.config.ts", { eager: true });
Object.assign(SKIN_LABELS, Object.values(heimConfig)[0]?.SKIN_LABELS ?? {});

export function AboutTab() {
  const windowCount = useWindowsStore((s) => Object.keys(s.windows).length);
  const skinId = useUIStore((s) => s.skinId);
  const { t } = useTranslation("settings");
  const sourceUrl = useAuthStore((s) => s.user?.source_url);
  // document.lastModified = time index.html was served ≈ last build/deploy
  const buildDate = new Date(document.lastModified).toLocaleDateString(regionLocale());

  return (
    <div className={styles.about}>
      <div className={styles.hero}>
        <div className={styles.logo}>
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect x="4" y="4" width="24" height="24" rx="6" fill="var(--accent)" opacity="0.9" />
            <rect x="36" y="4" width="24" height="24" rx="6" fill="var(--accent)" opacity="0.6" />
            <rect x="4" y="36" width="24" height="24" rx="6" fill="var(--accent)" opacity="0.6" />
            <rect x="36" y="36" width="24" height="24" rx="6" fill="var(--accent)" opacity="0.3" />
          </svg>
        </div>
        <h1 className={styles.title}>{getBrand().product}</h1>
        <p className={styles.version}>{t("about.version", { version: "0.1.0" })}</p>
        <p className={styles.tagline}>{t("about.tagline")}</p>
        {sourceUrl && (
          <p className={styles.tagline}>
            {t("about.license", { defaultValue: "Freie Software (AGPL-3.0-or-later)" })} ·{" "}
            <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
              {t("about.source", { defaultValue: "Quellcode" })}
            </a>
          </p>
        )}
      </div>

      <div className={styles.infoGrid}>
        <InfoCard label={t("about.platform")} value="Web (React + TypeScript)" />
        <InfoCard label={t("about.windowManager")} value="react-rnd + motion" />
        <InfoCard label={t("about.state")} value="Zustand + IndexedDB" />
        <InfoCard label={t("about.skin")} value={SKIN_LABELS[skinId] ?? skinId} />
        <InfoCard label={t("about.openWindows")} value={String(windowCount)} />
        <InfoCard label={t("about.deployed")} value={buildDate} />
        <InfoCard label={t("about.weatherData", { defaultValue: "Wetterdaten" })}
                  value="Deutscher Wetterdienst (DWD), CC BY 4.0" />
      </div>

    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoCard}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}
