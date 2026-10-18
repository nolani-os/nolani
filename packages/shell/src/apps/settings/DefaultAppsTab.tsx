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
} from "@claraos/core";
import styles from "./SettingsApp.module.css";

/** What a default application can be set for. */
const FILE_KINDS: { ext: string; label: string; apps: string[] }[] = [
  { ext: "pdf", label: "PDF-Dokumente", apps: ["pdf-viewer", "office-viewer", "files"] },
  { ext: "png", label: "Bilder", apps: ["image-viewer", "files"] },
  { ext: "mp4", label: "Videos", apps: ["video-player", "files"] },
  { ext: "mp3", label: "Musik", apps: ["video-player", "files"] },
  { ext: "docx", label: "Textdokumente", apps: ["office-viewer", "text-editor", "files"] },
  { ext: "xlsx", label: "Tabellen", apps: ["office-viewer", "files"] },
  { ext: "md", label: "Markdown und Text", apps: ["text-editor", "files"] },
  { ext: "stl", label: "3D-Modelle", apps: ["model-viewer", "files"] },
];

const APP_LABELS: Record<string, string> = {
  "pdf-viewer": "PDF-Betrachter",
  "image-viewer": "Bildbetrachter",
  "video-player": "Videoplayer",
  "office-viewer": "Office (Collabora)",
  "text-editor": "Texteditor",
  "model-viewer": "3D-Betrachter",
  files: "Dateien",
};

export function DefaultAppsTab() {
  const overrides = useFileStore((s) => s.openWithOverrides);
  const setOpenWith = useFileStore((s) => s.setOpenWithOverride);
  const getAllApps = useAppRegistryStore((s) => s.getAllApps);
  const store = useSettingsStore();
  const values = store.values["session"] ?? {};
  const [busy, setBusy] = useState(false);

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
      <div className={styles.navGroupTitle}>Womit Dateien geöffnet werden</div>
      {FILE_KINDS.map((kind) => {
        const current = overrides[kind.ext] ?? kind.apps[0];
        const isCustom = Boolean(overrides[kind.ext]);
        return (
          <div key={kind.ext} className={styles.row}>
            <div className={styles.rowLabel}>
              <label htmlFor={`default-${kind.ext}`}>{kind.label}</label>
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
                    {APP_LABELS[a] ?? a}
                  </option>
                ))}
              </select>
              {isCustom && (
                <button
                  type="button"
                  className={styles.resetBtn}
                  title="Auf Standard zurücksetzen"
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
        Beim Anmelden öffnen
      </div>
      <p className={styles.rowDesc} style={{ margin: "0 0 8px" }}>
        Diese Apps starten nach der Anmeldung von selbst. Das ist etwas anderes
        als das Wiederherstellen der letzten Sitzung — es gilt auch, wenn zuvor
        nichts offen war.
      </p>
      {autostart.length === 0 && (
        <p className={styles.rowDesc}>Noch nichts ausgewählt.</p>
      )}
      {autostart.map((id) => {
        const app = apps.find((a) => a.id === id);
        return (
          <div key={id} className={styles.row}>
            <div className={styles.rowLabel}>
              <label>{app?.name ?? id}</label>
              {!app && <p className={styles.rowDesc}>App nicht mehr verfügbar</p>}
            </div>
            <div className={styles.rowControl}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveAutostart(autostart.filter((x) => x !== id))}
              >
                Entfernen
              </button>
            </div>
          </div>
        );
      })}
      <div className={styles.row}>
        <div className={styles.rowLabel}>
          <label htmlFor="autostart-add">App hinzufügen</label>
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
            <option value="">Auswählen …</option>
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
