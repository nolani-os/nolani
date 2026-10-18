import { useWindowsStore, useUIStore } from "@claraos/core";
import styles from "./AboutTab.module.css";

const SKIN_LABELS: Record<string, string> = {
  "clara-glass": "Clara Glass",
  "aero-glass": "Aero Glass",
  windows11: "Windows 11",
};
// Labels of this installation's own skins (heim.config.ts, optional).
const heimConfig = import.meta.glob<{ SKIN_LABELS?: Record<string, string> }>("../../heim.config.ts", { eager: true });
Object.assign(SKIN_LABELS, Object.values(heimConfig)[0]?.SKIN_LABELS ?? {});

export function AboutTab() {
  const windowCount = useWindowsStore((s) => Object.keys(s.windows).length);
  const skinId = useUIStore((s) => s.skinId);
  // document.lastModified = time index.html was served ≈ last build/deploy
  const buildDate = new Date(document.lastModified).toLocaleDateString("de-DE");

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
        <h1 className={styles.title}>ClaraOS</h1>
        <p className={styles.version}>Version 0.1.0</p>
        <p className={styles.tagline}>Browser-based Desktop Environment</p>
      </div>

      <div className={styles.infoGrid}>
        <InfoCard label="Platform" value="Web (React + TypeScript)" />
        <InfoCard label="Window Manager" value="react-rnd + motion" />
        <InfoCard label="State" value="Zustand + IndexedDB" />
        <InfoCard label="Skin" value={SKIN_LABELS[skinId] ?? skinId} />
        <InfoCard label="Offene Fenster" value={String(windowCount)} />
        <InfoCard label="Deployt" value={buildDate} />
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
