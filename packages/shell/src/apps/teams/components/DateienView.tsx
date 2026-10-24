/**
 * Files in the Teams app — a native ClaraOS list instead of the Nextcloud UI.
 *
 * Why the existing Files app is NOT embedded here, even though it seems
 * obvious: its state (`useFileStore` in @claraos/core) is a **global
 * singleton** with tabs and split view — `activeSource`/`currentPath` belong
 * to the whole system, not to one window. Two embedded instances would push
 * each other through folders: navigating in Teams would move the open Files
 * app too. That violates "one property, one writer". Making the store
 * per-window would mean operating on a heavily used app — a channel tab is no
 * reason for that.
 *
 * So this is a lean, standalone list on the same API (`files/v2/tree`, the
 * same per-user Nextcloud access). For a team folder it is a better fit than a
 * full file manager with tabs and clipboard anyway. Opening goes through the
 * same routing as on the desktop (`fileTypeRouter`), so a PDF lands in the PDF
 * window here as everywhere else.
 */
import { useCallback, useEffect, useState } from "react";
import { useWindowsStore, type FileNode } from "@claraos/core";
import { getFileAppId, getViewerSizeForFile } from "../../../lib/fileTypeRouter";
import { FolderIcon, PostsIcon } from "./icons";
import styles from "./DateienView.module.css";
import { regionLocale } from "@claraos/core";

const QUELLE = "nextcloud";

function groesse(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function datum(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(regionLocale(), { day: "2-digit", month: "short", year: "numeric" });
}

export function DateienView({ startPfad = "/" }: { startPfad?: string }) {
  const [pfad, setPfad] = useState(startPfad);
  const [eintraege, setEintraege] = useState<FileNode[]>([]);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);

  // Switching the team folder (another channel) resets navigation.
  useEffect(() => { setPfad(startPfad); }, [startPfad]);

  const laden = useCallback(async (p: string) => {
    setLaedt(true);
    setFehler(null);
    try {
      const r = await fetch(
        `/api/claraos/files/v2/tree?source=${QUELLE}&path=${encodeURIComponent(p)}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(`Der Ordner ließ sich nicht lesen (HTTP ${r.status}).`);
      const knoten = await r.json();
      const kinder: FileNode[] = knoten?.children ?? [];
      // Folders first, then alphabetical — as everywhere else in ClaraOS.
      setEintraege([...kinder].sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.localeCompare(b.name, "de")
          : a.isDir ? -1 : 1));
    } catch (e) {
      setEintraege([]);
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaedt(false);
    }
  }, []);

  useEffect(() => { void laden(pfad); }, [pfad, laden]);

  const oeffnen = useCallback((n: FileNode) => {
    if (n.isDir) { setPfad(n.path); return; }
    const app = getFileAppId(n.name);
    useWindowsStore.getState().openWindow(app, {
      title: n.name,
      ...getViewerSizeForFile(app, n.name),
      path: n.path,
      source: n.source || QUELLE,
    });
  }, []);

  // Breadcrumbs only up to the start path — in a team folder the user has no
  // business above it.
  const wurzel = startPfad.replace(/\/+$/, "");
  const rest = pfad.startsWith(wurzel) ? pfad.slice(wurzel.length) : "";
  const teile = rest.split("/").filter(Boolean);

  return (
    <div className={styles.ansicht}>
      <div className={styles.kopf}>
        <button
          className={styles.krumen}
          onClick={() => setPfad(startPfad || "/")}
          title="Zum Anfang"
        >
          <FolderIcon size={15} />
          <span>{wurzel ? wurzel.split("/").filter(Boolean).slice(-1)[0] : "Dateien"}</span>
        </button>
        {teile.map((t, i) => (
          <button
            key={`${t}-${i}`}
            className={styles.krumen}
            onClick={() => setPfad(`${wurzel}/${teile.slice(0, i + 1).join("/")}`)}
          >
            <span className={styles.trenner}>›</span>
            <span>{t}</span>
          </button>
        ))}
        <span className={styles.fueller} />
        <button className={styles.aktualisieren} onClick={() => void laden(pfad)} title="Neu laden">↻</button>
      </div>

      {fehler && <div className={styles.meldung} style={{ color: "#f38ba8" }}>{fehler}</div>}
      {laedt && !fehler && <div className={styles.meldung}>Wird geladen …</div>}
      {!laedt && !fehler && eintraege.length === 0 && (
        <div className={styles.meldung}>Dieser Ordner ist leer.</div>
      )}

      <div className={styles.liste}>
        {eintraege.map((n) => (
          <button key={n.path} className={styles.zeile} onDoubleClick={() => oeffnen(n)} onClick={() => oeffnen(n)}>
            <span className={styles.symbol}>
              {n.isDir ? <FolderIcon size={16} /> : <PostsIcon size={16} />}
            </span>
            <span className={styles.name}>{n.name}</span>
            <span className={styles.spalte}>{n.isDir ? "" : groesse(n.size)}</span>
            <span className={styles.spalte}>{datum(n.modified)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
