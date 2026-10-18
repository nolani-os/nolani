import { useEffect, useState } from "react";
import {
  useUIStore,
  useVoiceStore,
  useAuthStore,
  useIstZelle,
  useSettingsStore,
  useDeviceStore,
  isDndActive,
  dndRemainingLabel,
  dndUntilFor,
  DND_PRESETS,
} from "@claraos/core";
import { availableSkins } from "@claraos/skins";
import { heimSlots } from "../extensions";
import styles from "./QuickSettingsPanel.module.css";

interface QuickSettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface SystemStats {
  cpu: number | null;
  ram: number | null;
  disk: number | null;
}

/**
 * Win11-style "Quick Settings" panel — opens via tray button or Win+A.
 * Houses controls that should be one tap away: Volume (browser audio),
 * skin/theme switch, voice mute, logout, plus a brief network/system
 * status read-out.
 */
export function QuickSettingsPanel({ open, onClose }: QuickSettingsPanelProps) {
  const skinId = useUIStore((s) => s.skinId);
  const setSkin = useUIStore((s) => s.setSkin);
  const setTheme = useUIStore((s) => s.setTheme);
  const muted = useVoiceStore((s) => s.muted);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const logout = useAuthStore((s) => s.logout);
  const istZelle = useIstZelle();
  const HeimStatus = heimSlots.QuickSettingsStatus;

  // "Do not disturb" — the state is a timestamp, not a switch, so it expires
  // by itself instead of staying active for weeks after a movie night.
  const notifValues = useSettingsStore((s) => s.values["notifications"]);
  const putSetting = useSettingsStore((s) => s.apply);
  const setDraft = useSettingsStore((s) => s.setDraft);
  const dndUntil = typeof notifValues?.dndUntil === "number" ? notifValues.dndUntil : 0;
  const dndPolicy = { dndUntil, criticalInDnd: true, lowPriorityPopups: true,
                      lowPriorityHistory: false, apps: {} };
  const dndOn = isDndActive(dndPolicy);
  const [dndMenuOpen, setDndMenuOpen] = useState(false);

  const setDnd = async (minutes: number | null) => {
    const until = minutes === null ? 0 : dndUntilFor(minutes);
    setDraft("notifications", "dndUntil", until);
    await putSetting("notifications");
    setDndMenuOpen(false);
  };

  const [stats, setStats] = useState<SystemStats>({ cpu: null, ram: null, disk: null });
  // Volume is its own tray flyout (VolumeTray); the page volume is applied
  // shell-wide by usePageVolume. Disks of the LOCAL device come from the
  // device store (Companion bridge).
  const storage = useDeviceStore((s) => s.storage);

  // Poll system stats while open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/claraos/system/stats");
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        setStats({
          cpu: typeof d.cpu === "number" ? d.cpu : null,
          ram: typeof d.ram === "number" ? d.ram : null,
          disk: typeof d.disk === "number" ? d.disk : null,
        });
      } catch { /* keep placeholder */ }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [open]);

  const handleSkin = (id: string) => {
    setSkin(id);
    setTheme(id.includes("light") ? "light" : "dark");
    // Clear any user wallpaper so the new skin's default takes over
    useUIStore.getState().setWallpaper("");
    document.documentElement.style.removeProperty("--wallpaper");
  };

  if (!open) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={`aeroWidget ${styles.panel}`} role="dialog" aria-label="Quick Settings">
        <div className={styles.header}>
          <span className={styles.title}>Quick Settings</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Do not disturb */}
        <section className={styles.section}>
          <div className={styles.row}>
            <span className={styles.icon}>{dndOn ? "🌙" : "🔔"}</span>
            <button
              className={styles.toggleBtn}
              aria-pressed={dndOn}
              onClick={() => (dndOn ? void setDnd(null) : setDndMenuOpen((v) => !v))}
            >
              {dndOn ? `Nicht stören — ${dndRemainingLabel(dndPolicy)}` : "Nicht stören"}
            </button>
          </div>
          {dndMenuOpen && !dndOn && (
            <div className={styles.dndMenu}>
              {DND_PRESETS.map((p) => (
                <button key={p.label} onClick={() => void setDnd(p.minutes)}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Guided tour */}
        <section className={styles.section}>
          <div className={styles.row}>
            <span className={styles.icon}>🧭</span>
            <button
              className={styles.toggleBtn}
              onClick={() => {
                onClose();
                window.dispatchEvent(new CustomEvent("claraos-start-tour", {
                  detail: { tourId: "claraos-basics" },
                }));
              }}
            >
              Tour: ClaraOS kennenlernen
            </button>
          </div>
        </section>

        {/* System / Network */}
        <section className={styles.section}>
          <div className={styles.statRow}>
            <Stat label="CPU" value={stats.cpu} />
            <Stat label="RAM" value={stats.ram} />
            <Stat label="Disk" value={stats.disk} />
          </div>
          {!istZelle && HeimStatus && <HeimStatus />}
        </section>

        {/* Disks of THIS device (only with the Companion bridge) */}
        {storage && storage.length > 0 && (
          <section className={styles.section} data-qs-section="storage">
            <div className={styles.sectionLabel}>Datenträger (dieses Gerät)</div>
            {storage.map((m) => {
              const usedPct = m.totalGb > 0
                ? Math.min(100, Math.round(((m.totalGb - m.freeGb) / m.totalGb) * 100))
                : 0;
              return (
                <div key={m.mount} title={m.mount}>
                  <div className={styles.row}>
                    <span className={styles.icon}>{m.removable ? "🔌" : "💽"}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.label}
                    </span>
                    <span className={styles.value} style={{ width: "auto" }}>
                      {m.freeGb.toFixed(0)} von {m.totalGb.toFixed(0)} GB frei
                    </span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${usedPct}%`, borderRadius: 3,
                      background: usedPct > 90 ? "#ff6b6b" : "var(--accent, #6c8cff)",
                    }} />
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* Theme / Skin */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>Theme</div>
          <div className={styles.skinGrid}>
            {availableSkins.map((skin) => (
              <button
                key={skin.id}
                className={`${styles.skinTile} ${skinId === skin.id ? styles.skinActive : ""}`}
                onClick={() => handleSkin(skin.id)}
                title={skin.name}
              >
                <span
                  className={styles.skinSwatch}
                  style={{ background: skin.tokens.colors["accent"] }}
                />
                <span className={styles.skinName}>{skin.name}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Voice + Logout */}
        <section className={styles.section}>
          <div className={styles.actions}>
            <button className={styles.actionBtn} onClick={toggleMute}>
              <span>{muted ? "🔇" : "🎤"}</span>
              <span>Clara {muted ? "stumm" : "aktiv"}</span>
            </button>
            <button className={`${styles.actionBtn} ${styles.logoutBtn}`} onClick={logout}>
              <span>↪</span>
              <span>Abmelden</span>
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value !== null ? `${Math.round(value)}%` : "—"}</div>
    </div>
  );
}
