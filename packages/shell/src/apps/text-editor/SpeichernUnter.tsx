import { useCallback, useEffect, useRef, useState } from "react";
import { useFileStore, i18n, useTranslation } from "@claraos/core";

interface Eintrag {
  name: string;
  path: string;
  isDir: boolean;
}

interface Props {
  /** Folder to start in (source + path), e.g. the folder of the open file. */
  source: string;
  startPfad: string;
  dateiname: string;
  /** Called with the chosen full path; returns false if writing failed. */
  onSpeichern: (source: string, pfad: string) => Promise<boolean>;
  onAbbrechen: () => void;
}

const API = "/api/claraos/files/v2";

function verbinde(ordner: string, name: string): string {
  return `${ordner.replace(/\/+$/, "")}/${name}`;
}

function eltern(pfad: string): string {
  const teile = pfad.replace(/\/+$/, "").split("/").filter(Boolean);
  teile.pop();
  return "/" + teile.join("/");
}

/**
 * "Save as" for the text editor: browse folders, pick a name, confirm overwrite.
 * Deliberately local state only — the Files app's store is a global singleton
 * (current folder, tabs); browsing here must not move the Files window along.
 */
export default function SpeichernUnter({ source, startPfad, dateiname, onSpeichern, onAbbrechen }: Props) {
  const { t } = useTranslation("textEditor");
  const [ordner, setOrdner] = useState(startPfad || "/");
  const [eintraege, setEintraege] = useState<Eintrag[]>([]);
  const [name, setName] = useState(dateiname);
  const [fehler, setFehler] = useState("");
  const [laedt, setLaedt] = useState(false);
  const [ueberschreiben, setUeberschreiben] = useState(false);
  const [neuerOrdner, setNeuerOrdner] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const lade = useCallback(async (pfad: string) => {
    setLaedt(true);
    setFehler("");
    try {
      const res = await fetch(`${API}/tree?source=${encodeURIComponent(source)}&path=${encodeURIComponent(pfad)}`);
      if (!res.ok) throw new Error(String(res.status));
      const baum = await res.json();
      const kinder: Eintrag[] = (baum.children ?? []).map((k: Eintrag) => ({ name: k.name, path: k.path, isDir: k.isDir }));
      kinder.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      setEintraege(kinder);
      setOrdner(pfad);
    } catch {
      // A start folder that no longer exists falls back to the root once.
      if (pfad !== "/") return lade("/");
      setFehler(i18n.t("textEditor:dialog.folderUnreadable"));
    } finally {
      setLaedt(false);
    }
  }, [source]);

  useEffect(() => { lade(startPfad || "/"); }, [lade, startPfad]);

  useEffect(() => {
    // Preselect the name without the extension, like desktop save dialogs do.
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    const punkt = dateiname.lastIndexOf(".");
    el.setSelectionRange(0, punkt > 0 ? punkt : dateiname.length);
  }, [dateiname]);

  const speichern = async () => {
    const n = name.trim();
    if (!n || /[\\/]/.test(n)) {
      setFehler(i18n.t("textEditor:dialog.noSlash"));
      return;
    }
    const vorhanden = eintraege.find((e) => e.name === n);
    if (vorhanden?.isDir) {
      setFehler(i18n.t("textEditor:dialog.isFolder"));
      return;
    }
    if (vorhanden && !ueberschreiben) {
      setUeberschreiben(true);
      return;
    }
    setLaedt(true);
    const ok = await onSpeichern(source, verbinde(ordner, n));
    setLaedt(false);
    if (!ok) setFehler(i18n.t("textEditor:dialog.saveFailed"));
  };

  const ordnerAnlegen = async () => {
    const n = (neuerOrdner ?? "").trim();
    if (!n || /[\\/]/.test(n)) return;
    const ok = await useFileStore.getState().createFolder(source, verbinde(ordner, n));
    setNeuerOrdner(null);
    if (ok) await lade(verbinde(ordner, n));
    else setFehler(i18n.t("textEditor:dialog.mkdirFailed"));
  };

  return (
    <div style={hintergrund} onKeyDown={(e) => { if (e.key === "Escape") onAbbrechen(); }}>
      <div role="dialog" aria-label={t("dialog.title")} style={kasten}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{t("dialog.title")}</div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <button style={knopf} disabled={ordner === "/" || laedt} onClick={() => lade(eltern(ordner))}
            title={t("dialog.parent")} aria-label={t("dialog.parent")}>↑</button>
          <span style={{ flex: 1, color: "#aaa", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={ordner}>{ordner}</span>
          <button style={knopf} onClick={() => setNeuerOrdner("")} disabled={laedt}>{t("dialog.newFolder")}</button>
        </div>

        {neuerOrdner !== null && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input autoFocus style={{ ...feld, flex: 1 }} placeholder={t("dialog.folderName")} value={neuerOrdner}
              onChange={(e) => setNeuerOrdner(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") ordnerAnlegen(); }} />
            <button style={knopf} onClick={ordnerAnlegen}>{t("dialog.create")}</button>
          </div>
        )}

        <ul role="listbox" aria-label={t("dialog.contents")} style={liste}>
          {eintraege.length === 0 && !laedt && <li style={{ color: "#777", padding: 8 }}>{t("dialog.empty")}</li>}
          {eintraege.map((e) => (
            <li key={e.path} role="option" aria-selected={!e.isDir && e.name === name}
              style={{ ...zeile, color: e.isDir ? "#ddd" : "#999" }}
              title={e.isDir ? t("dialog.dirHint") : t("dialog.fileHint")}
              onClick={() => { if (!e.isDir) { setName(e.name); setUeberschreiben(false); } }}
              onDoubleClick={() => { if (e.isDir) lade(e.path); }}>
              {e.isDir ? "📁" : "📄"} {e.name}
            </li>
          ))}
        </ul>

        <label style={{ display: "block", fontSize: 12, color: "#aaa", marginTop: 8 }}>
          {t("dialog.fileName")}
          <input ref={nameRef} style={{ ...feld, width: "100%", marginTop: 4 }} value={name}
            onChange={(e) => { setName(e.target.value); setUeberschreiben(false); setFehler(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") speichern(); }} />
        </label>

        {ueberschreiben && (
          <div style={{ color: "#f0c674", fontSize: 12, marginTop: 6 }}>
            {t("dialog.exists", { name: name.trim() })}
          </div>
        )}
        {fehler && <div role="alert" style={{ color: "#f38ba8", fontSize: 12, marginTop: 6 }}>{fehler}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button style={knopf} onClick={onAbbrechen}>{t("dialog.cancel")}</button>
          <button style={{ ...knopf, background: "#0e639c", borderColor: "#1177bb", color: "#fff" }}
            onClick={speichern} disabled={laedt}>
            {ueberschreiben ? t("dialog.replace") : t("dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

const hintergrund: React.CSSProperties = {
  position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 20,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const kasten: React.CSSProperties = {
  width: "min(520px, calc(100% - 24px))", background: "#252526", color: "#ddd",
  border: "1px solid #3c3c3c", borderRadius: 6, padding: 14, boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
};
const liste: React.CSSProperties = {
  listStyle: "none", margin: 0, padding: 0, height: 220, overflowY: "auto",
  border: "1px solid #3c3c3c", borderRadius: 3, background: "#1e1e1e", fontSize: 13,
};
const zeile: React.CSSProperties = { padding: "4px 8px", cursor: "default", userSelect: "none" };
const feld: React.CSSProperties = {
  background: "#3c3c3c", color: "#ddd", border: "1px solid #555", borderRadius: 3,
  padding: "4px 6px", fontSize: 13, boxSizing: "border-box",
};
const knopf: React.CSSProperties = {
  background: "#3c3c3c", color: "#ccc", border: "1px solid #555",
  borderRadius: 3, padding: "3px 10px", cursor: "pointer", fontSize: 12,
};
