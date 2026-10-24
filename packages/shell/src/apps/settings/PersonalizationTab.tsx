import { useEffect, useState } from "react";
import { useUIStore, useTranslation } from "@claraos/core";
import {
  availableSkins,
  aeroGlassStaticWallpaper,
  aeroGlassAnimatedWallpaper,
  claraGlassWallpaper,
  claraGlassWallpaperAlt,
} from "@claraos/skins";
import styles from "./PersonalizationTab.module.css";

const LIVE_WALLPAPER_KEY = "claraos-live-wallpaper";

export function PersonalizationTab() {
  const skinId = useUIStore((s) => s.skinId);
  const setSkin = useUIStore((s) => s.setSkin);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const wallpaper = useUIStore((s) => s.wallpaper);
  const setWallpaper = useUIStore((s) => s.setWallpaper);

  const { t } = useTranslation("settings");
  // ── Avatar and custom wallpapers ────────────────────────────────────
  // Both are stored in Nextcloud so they persist across devices. The cache
  // buster on the image is needed, otherwise the browser shows the old one
  // after an upload.
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [hasAvatar, setHasAvatar] = useState(false);
  const [fallback, setFallback] = useState<
    { initials: string; color: string; textColor: string } | null
  >(null);
  const [ownWallpapers, setOwnWallpapers] = useState<{ name: string; url: string }[]>([]);
  const [imgError, setImgError] = useState("");

  const avatarUrl = hasAvatar
    ? `/api/claraos/personalization/avatar?v=${avatarVersion}`
    : "";

  const loadPersonalization = async () => {
    try {
      const [fb, wp] = await Promise.all([
        fetch("/api/claraos/personalization/avatar/fallback"),
        fetch("/api/claraos/personalization/wallpapers"),
      ]);
      if (fb.ok) {
        const data = await fb.json();
        setFallback(data);
        // Comes from the same response — a HEAD on the image would be a
        // second request, and the endpoint only supports GET anyway.
        setHasAvatar(Boolean(data.hasCustom));
      }
      if (wp.ok) setOwnWallpapers((await wp.json()).wallpapers ?? []);
    } catch {
      /* Personalization is optional — do not escalate errors */
    }
  };

  useEffect(() => {
    void loadPersonalization();
  }, []);

  const upload = async (path: string, file: File) => {
    setImgError("");
    const form = new FormData();
    form.append("file", file);
    const r = await fetch(path, { method: "POST", body: form });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setImgError(b.detail ?? t("personalization.uploadFailed", { status: r.status }));
      return null;
    }
    return r.json().catch(() => ({}));
  };

  const uploadAvatar = async (file: File) => {
    if (await upload("/api/claraos/personalization/avatar", file)) {
      setHasAvatar(true);
      setAvatarVersion((v) => v + 1);
    }
  };

  const removeAvatar = async () => {
    await fetch("/api/claraos/personalization/avatar", { method: "DELETE" });
    setHasAvatar(false);
    setAvatarVersion((v) => v + 1);
  };

  const uploadWallpaper = async (file: File) => {
    const res = await upload("/api/claraos/personalization/wallpaper", file);
    if (res) await loadPersonalization();
  };

  const removeWallpaper = async (name: string) => {
    await fetch(`/api/claraos/personalization/wallpaper/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    await loadPersonalization();
  };

  // Persist the override; SkinManager re-applies it on every skinId/theme
  // change so it survives reloads even though the DOM `--wallpaper` token
  // is rewritten by applySkin().
  const handleWallpaper = (value: string) => {
    setWallpaper(value);
    document.documentElement.style.setProperty("--wallpaper", value);
  };

  // Selecting a skin clears any custom wallpaper override so the new skin's
  // default takes over immediately. SkinManager picks this up via the
  // userWallpaper subscription.
  const handleSkinChange = (newSkinId: string) => {
    setWallpaper("");
    document.documentElement.style.removeProperty("--wallpaper");
    setSkin(newSkinId);
    setTheme(newSkinId.includes("light") ? "light" : "dark");
  };

  // Live wallpaper toggle (Aero-Glass-only signature feature)
  const [liveWallpaper, setLiveWallpaper] = useState<boolean>(() => {
    return localStorage.getItem(LIVE_WALLPAPER_KEY) === "1";
  });

  useEffect(() => {
    localStorage.setItem(LIVE_WALLPAPER_KEY, liveWallpaper ? "1" : "0");
    if (skinId !== "aero-glass") return;
    if (wallpaper) return; // user wallpaper override takes precedence
    const url = liveWallpaper ? aeroGlassAnimatedWallpaper : aeroGlassStaticWallpaper;
    const value = `url("${url}") center/cover no-repeat, radial-gradient(at 30% 20%, #1B1F40 0%, #0A0A14 60%)`;
    document.documentElement.style.setProperty("--wallpaper", value);
  }, [liveWallpaper, skinId, wallpaper]);

  return (
    <div className={styles.tab}>
      <h2 className={styles.heading}>{t("personalization.heading")}</h2>

      {/* Theme Selection */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t("personalization.theme")}</h3>
        <div className={styles.themeRow}>
          <button
            className={`${styles.themeCard} ${skinId === "clara-glass" ? styles.themeActive : ""}`}
            onClick={() => handleSkinChange("clara-glass")}
            title={t("personalization.claraGlassHint")}
          >
            <div
              className={styles.themePreview}
              style={{
                background:
                  "radial-gradient(at 70% 20%, #38BDF8 0%, transparent 50%)," +
                  "radial-gradient(at 25% 70%, #1F8FE0 0%, transparent 55%)," +
                  "radial-gradient(at 90% 90%, #22D3EE 0%, transparent 40%)," +
                  "linear-gradient(165deg, #131A2E 0%, #070A13 100%)",
              }}
            >
              <div className={styles.previewBar} style={{ background: "rgba(12, 18, 34, 0.75)", backdropFilter: "blur(8px)" }} />
            </div>
            <span className={styles.themeLabel}>Glass</span>
          </button>
          <button
            className={`${styles.themeCard} ${skinId === "windows11-dark" ? styles.themeActive : ""}`}
            onClick={() => handleSkinChange("windows11-dark")}
          >
            <div className={styles.themePreview} style={{ background: "linear-gradient(135deg, #000428, #004e92)" }}>
              <div className={styles.previewBar} style={{ background: "rgba(32,32,32,0.8)" }} />
            </div>
            <span className={styles.themeLabel}>{t("personalization.dark")}</span>
          </button>
          <button
            className={`${styles.themeCard} ${skinId === "windows11-light" ? styles.themeActive : ""}`}
            onClick={() => handleSkinChange("windows11-light")}
          >
            <div className={styles.themePreview} style={{ background: "linear-gradient(135deg, #667eea, #764ba2)" }}>
              <div className={styles.previewBar} style={{ background: "rgba(243,243,243,0.8)" }} />
            </div>
            <span className={styles.themeLabel}>{t("personalization.light")}</span>
          </button>
          <button
            className={`${styles.themeCard} ${skinId === "aero-glass" ? styles.themeActive : ""}`}
            onClick={() => handleSkinChange("aero-glass")}
            title={t("personalization.aeroGlassHint")}
          >
            <div
              className={styles.themePreview}
              style={{
                background:
                  "radial-gradient(at 25% 25%, #7B9FFF 0%, transparent 55%)," +
                  "radial-gradient(at 80% 60%, #A78BFA 0%, transparent 55%)," +
                  "radial-gradient(at 55% 95%, #5EEAD4 0%, transparent 50%)," +
                  "linear-gradient(180deg, #0A0A14 0%, #1B1F40 100%)",
              }}
            >
              <div className={styles.previewBar} style={{ background: "rgba(20, 22, 38, 0.55)", backdropFilter: "blur(8px)" }} />
            </div>
            <span className={styles.themeLabel}>Crystal</span>
          </button>
        </div>
      </section>

      {/* Available Skins */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t("personalization.skin")}</h3>
        <div className={styles.skinList}>
          {availableSkins.map((skin) => (
            <button
              key={skin.id}
              className={`${styles.skinItem} ${skinId === skin.id ? styles.skinActive : ""}`}
              onClick={() => handleSkinChange(skin.id)}
            >
              <div
                className={styles.skinSwatch}
                style={{
                  background: skin.tokens.colors["accent"],
                  borderColor: skinId === skin.id ? skin.tokens.colors["accent"] : "transparent",
                }}
              />
              <div className={styles.skinInfo}>
                <span className={styles.skinName}>{skin.name}</span>
                <span className={styles.skinId}>{skin.id}</span>
              </div>
              {skinId === skin.id && <span className={styles.checkmark}>✓</span>}
            </button>
          ))}
        </div>
      </section>

      {/* Live wallpaper — Aero-Glass-only signature */}
      {skinId === "aero-glass" && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("personalization.liveWallpaper")}</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={liveWallpaper}
              onChange={(e) => setLiveWallpaper(e.target.checked)}
            />
            <span>{t("personalization.liveWallpaperDesc")}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)" }}>
              {liveWallpaper ? t("personalization.on") : t("personalization.off")}
            </span>
          </label>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            {t("personalization.pausesOn")} <code>prefers-reduced-motion</code>.
          </span>
        </section>
      )}

      {/* Avatar: custom image, otherwise initials — the model from KDE's
          kcm_users. The initials case needs no file and is the normal
          case, so it is not shown as "empty". */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t("personalization.avatar")}</h3>
        <div className={styles.avatarRow}>
          {avatarUrl ? (
            <img className={styles.avatarPreview} src={avatarUrl} alt={t("personalization.avatar")} />
          ) : (
            <div
              className={styles.avatarPreview}
              style={{ background: fallback?.color ?? "#686b6f", color: fallback?.textColor ?? "#fff" }}
              aria-label={t("personalization.avatarInitials")}
            >
              {fallback?.initials ?? "?"}
            </div>
          )}
          <div className={styles.avatarActions}>
            <label className={styles.uploadBtn}>
              {t("personalization.chooseImage")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAvatar(f);
                  e.target.value = "";
                }}
              />
            </label>
            {avatarUrl && (
              <button onClick={() => void removeAvatar()}>{t("personalization.resetToInitials")}</button>
            )}
          </div>
        </div>
        {imgError && <p className={styles.imgError}>{imgError}</p>}
      </section>

      {/* Wallpaper */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t("personalization.wallpaper")}</h3>

        {/* Custom images — stored in Nextcloud, so they apply on every
            device, not just in this browser. */}
        <div className={styles.wallpaperGrid}>
          {ownWallpapers.map((w) => (
            <div key={w.name} className={styles.ownWallpaper}>
              <button
                className={`${styles.wallpaperCard} ${
                  wallpaper.includes(w.url) ? styles.wallpaperActive : ""
                }`}
                onClick={() => handleWallpaper(`url("${w.url}") center/cover no-repeat`)}
                title={w.name}
              >
                <div
                  className={styles.wallpaperPreview}
                  style={{ background: `url("${w.url}") center/cover no-repeat` }}
                />
                <span className={styles.wallpaperLabel}>{w.name}</span>
              </button>
              <button
                className={styles.wallpaperDelete}
                title={t("personalization.removeImage")}
                aria-label={t("personalization.removeNamed", { name: w.name })}
                onClick={() => void removeWallpaper(w.name)}
              >
                ×
              </button>
            </div>
          ))}
          <label className={`${styles.wallpaperCard} ${styles.wallpaperUpload}`}>
            <div className={styles.wallpaperPreview}>＋</div>
            <span className={styles.wallpaperLabel}>{t("personalization.ownImage")}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadWallpaper(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        <div className={styles.wallpaperGrid}>
          {[...(skinId === "clara-glass" ? CLARA_WALLPAPERS : []), ...WALLPAPERS].map((wp) => (
            <button
              key={wp.id}
              className={`${styles.wallpaperCard} ${wallpaper === wp.value ? styles.wallpaperActive : ""}`}
              onClick={() => handleWallpaper(wp.value)}
            >
              <div className={styles.wallpaperPreview} style={{ background: wp.value }} />
              <span className={styles.wallpaperLabel}>{wp.name}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// clara-glass wallpapers — shown only while that skin is active.
// "Liquid Navy" is the skin default; "Navy Woge" is the brighter single-wave
// alternative offered as an option.
const CLARA_GLASS_FALLBACK = "radial-gradient(at 30% 20%, #12203E 0%, #070A13 65%)";
const CLARA_WALLPAPERS = [
  {
    id: "clara-liquid-navy",
    name: "Liquid Navy",
    value: `url("${claraGlassWallpaper}") center/cover no-repeat, ${CLARA_GLASS_FALLBACK}`,
  },
  {
    id: "clara-navy-woge",
    name: "Navy Woge",
    value: `url("${claraGlassWallpaperAlt}") center/cover no-repeat, ${CLARA_GLASS_FALLBACK}`,
  },
];

const WALLPAPERS = [
  { id: "ocean", name: "Ocean", value: "linear-gradient(135deg, #000428 0%, #004e92 100%)" },
  { id: "sunset", name: "Sunset", value: "linear-gradient(135deg, #f12711 0%, #f5af19 100%)" },
  { id: "aurora", name: "Aurora", value: "linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)" },
  { id: "forest", name: "Forest", value: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)" },
  { id: "night", name: "Night", value: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)" },
  { id: "minimal", name: "Minimal", value: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)" },
  { id: "warm", name: "Warm", value: "linear-gradient(135deg, #373b44 0%, #4286f4 100%)" },
  { id: "rose", name: "Rosé", value: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
];
