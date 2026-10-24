/**
 * Default applications and autostart.
 *
 * Both existed functionally but were invisible: the file type router knew
 * overrides (`openWithOverrides`, set via "Always open with …" in the file
 * manager), but nobody could view or undo them. And opening apps at login
 * was not possible at all.
 *
 * Modeled on KDE's kcm_componentchooser (default applications) and
 * kcm_autostart — there "on/off" is a toggle, not a delete, and every entry
 * shows where it comes from.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useFileStore,
  useAppRegistryStore,
  useSettingsStore,
  useTranslation,
} from "@claraos/core";
import styles from "./SettingsApp.module.css";

/** What a default application can be set for. */
// Labels live in the "settings" catalog: defaultApps.kind.<ext>, defaultApps.app.<id>.
const FILE_KINDS: { ext: string; apps: string[] }[] = [
  { ext: "pdf", apps: ["pdf-viewer", "office-viewer", "files"] },
  { ext: "png", apps: ["image-viewer", "files"] },
  { ext: "mp4", apps: ["video-player", "files"] },
  { ext: "mp3", apps: ["video-player", "files"] },
  { ext: "docx", apps: ["office-viewer", "text-editor", "files"] },
  { ext: "xlsx", apps: ["office-viewer", "files"] },
  { ext: "md", apps: ["text-editor", "files"] },
  { ext: "stl", apps: ["model-viewer", "files"] },
];

export function DefaultAppsTab() {
  const overrides = useFileStore((s) => s.openWithOverrides);
  const setOpenWith = useFileStore((s) => s.setOpenWithOverride);
  const getAllApps = useAppRegistryStore((s) => s.getAllApps);
  const store = useSettingsStore();
  const values = store.values["session"] ?? {};
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation("settings");

  useEffect(() => {
    void store.loadModule("session");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autostart: string[] = useMemo(
    () => (Array.isArray(values.autostartApps) ? (values.autostartApps as string[]) : []),
    [values],
  );

  const apps = useMemo(
    () => getAllApps().filter((a) => a.activated !== false),
    [getAllApps],
  );

  const saveAutostart = async (next: string[]) => {
    setBusy(true);
    try {
      store.setDraft("session", "autostartApps", next);
      await store.apply("session");
      await store.loadModule("session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form}>
      <div className={styles.navGroupTitle}>{t("defaultApps.openWithTitle")}</div>
      {FILE_KINDS.map((kind) => {
        const current = overrides[kind.ext] ?? kind.apps[0];
        const isCustom = Boolean(overrides[kind.ext]);
        return (
          <div key={kind.ext} className={styles.row}>
            <div className={styles.rowLabel}>
              <label htmlFor={`default-${kind.ext}`}>{t(`defaultApps.kind.${kind.ext}`)}</label>
              <p className={styles.rowDesc}>.{kind.ext}</p>
            </div>
            <div className={styles.rowControl}>
              <select
                id={`default-${kind.ext}`}
                value={current}
                onChange={(e) => setOpenWith(kind.ext, e.target.value)}
              >
                {kind.apps.map((a) => (
                  <option key={a} value={a}>
                    {t(`defaultApps.app.${a}`, { defaultValue: a })}
                  </option>
                ))}
              </select>
              {isCustom && (
                <button
                  type="button"
                  className={styles.resetBtn}
                  title={t("defaultApps.reset")}
                  onClick={() => setOpenWith(kind.ext, null)}
                >
                  ↺
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className={styles.navGroupTitle} style={{ marginTop: 18 }}>
        {t("defaultApps.autostartTitle")}
      </div>
      <p className={styles.rowDesc} style={{ margin: "0 0 8px" }}>
        {t("defaultApps.autostartDesc")}
      </p>
      {autostart.length === 0 && (
        <p className={styles.rowDesc}>{t("defaultApps.none")}</p>
      )}
      {autostart.map((id) => {
        const app = apps.find((a) => a.id === id);
        return (
          <div key={id} className={styles.row}>
            <div className={styles.rowLabel}>
              <label>{app?.name ?? id}</label>
              {!app && <p className={styles.rowDesc}>{t("defaultApps.unavailable")}</p>}
            </div>
            <div className={styles.rowControl}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveAutostart(autostart.filter((x) => x !== id))}
              >
                {t("defaultApps.remove")}
              </button>
            </div>
          </div>
        );
      })}
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <label htmlFor="autostart-add">{t("defaultApps.add")}</label>
        </div>
        <div className={styles.rowControl}>
          <select
            id="autostart-add"
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void saveAutostart([...autostart, e.target.value]);
            }}
          >
            <option value="">{t("defaultApps.choose")}</option>
            {apps
              .filter((a) => !autostart.includes(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
      </div>
    </div>
  );
}
