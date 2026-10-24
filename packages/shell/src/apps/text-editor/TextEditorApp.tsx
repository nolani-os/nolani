import { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { useWindowsStore, useFileStore, buildObjectUri } from "@claraos/core";
import SpeichernUnter from "./SpeichernUnter";

const LANG_MAP: Record<string, string> = {
  ".js": "javascript", ".ts": "typescript", ".tsx": "typescript",
  ".py": "python", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".md": "markdown", ".html": "html", ".css": "css", ".sh": "shell",
  ".sql": "sql", ".xml": "xml", ".toml": "ini", ".env": "shell",
  ".txt": "plaintext", ".log": "plaintext", ".csv": "plaintext",
};

function getLanguage(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return LANG_MAP[ext] || "plaintext";
}

export default function TextEditorApp({ windowId }: { windowId: string }) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("untitled.txt");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileSource, setFileSource] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Bereit");
  const [speichernUnter, setSpeichernUnter] = useState(false);
  // Path we just wrote ourselves: the window store echoes it back as winPath,
  // and re-reading it from the server would only reset status and cursor.
  const selbstGeschrieben = useRef<string | null>(null);

  // Auto-load when the window was opened with a path/source
  const winPath = useWindowsStore((s) => s.windows[windowId]?.path);
  const winSource = useWindowsStore((s) => s.windows[windowId]?.source);
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);

  // Surface the open file as the inline-chat object-URI
  useEffect(() => {
    if (winPath && winSource) {
      setCurrentObjectUri(windowId, buildObjectUri("text-editor", `${winSource}://${winPath}`));
    } else {
      setCurrentObjectUri(windowId, undefined);
    }
  }, [windowId, winPath, winSource, setCurrentObjectUri]);
  useEffect(() => {
    if (!winPath || !winSource) return;
    if (selbstGeschrieben.current === `${winSource}:${winPath}`) return;
    let cancelled = false;
    (async () => {
      setStatus("Loading...");
      const data = await useFileStore.getState().readFile(winSource, winPath);
      if (cancelled) return;
      if (!data) {
        setStatus("Failed to load file");
        return;
      }
      // Binary files (encoding=base64) — show a notice instead of raw bytes
      if (data.encoding === "base64") {
        setContent("[Binary file — open in another viewer]");
      } else {
        setContent(data.content || "");
      }
      setFilename(winPath.split("/").pop() || winPath);
      setFilePath(winPath);
      setFileSource(winSource);
      setDirty(false);
      setStatus(`Loaded: ${winPath}`);
    })();
    return () => { cancelled = true; };
  }, [winPath, winSource]);

  // Save file via the v2 endpoint; a file without a path goes through "save as".
  const saveFile = useCallback(async () => {
    if (!filePath || !fileSource) {
      setSpeichernUnter(true);
      return;
    }
    setStatus("Saving...");
    const ok = await useFileStore.getState().writeFile(fileSource, filePath, content);
    if (ok) {
      setDirty(false);
      setStatus(`Gespeichert: ${filename}`);
    } else {
      setStatus(`Fehler beim Speichern`);
    }
  }, [filePath, fileSource, content, filename]);

  const speichernAls = useCallback(async (source: string, pfad: string) => {
    const ok = await useFileStore.getState().writeFile(source, pfad, content);
    if (!ok) return false;
    const name = pfad.split("/").pop() || pfad;
    selbstGeschrieben.current = `${source}:${pfad}`;
    setFilePath(pfad);
    setFileSource(source);
    setFilename(name);
    setDirty(false);
    setSpeichernUnter(false);
    setStatus(`Gespeichert: ${pfad}`);
    // The window now belongs to this file: title, inline chat and session restore.
    useWindowsStore.getState().setWindowFile(windowId, source, pfad, name);
    return true;
  }, [content, windowId]);

  // "New" must also forget the previous file — otherwise the next save
  // overwrote the file that was open before with the new text.
  const neu = () => {
    setContent("");
    setFilename("untitled.txt");
    setFilePath(null);
    setFileSource(null);
    setDirty(false);
    setStatus("Bereit");
    selbstGeschrieben.current = null;
    useWindowsStore.getState().setWindowFile(windowId, "", "", "Texteditor");
  };

  // Ctrl+S / Ctrl+Shift+S — only for the focused window; the listener is global,
  // and every open editor window would otherwise save (or open its dialog) at once.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      if (useWindowsStore.getState().focusedWindowId !== windowId) return;
      e.preventDefault();
      if (e.shiftKey) setSpeichernUnter(true);
      else saveFile();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveFile, windowId]);

  // Start folder of the dialog: the open file's folder, otherwise where the Files app is.
  const dateien = useFileStore.getState();
  const dialogQuelle = fileSource || dateien.activeSource || "nextcloud";
  const dialogOrdner = filePath
    ? filePath.slice(0, filePath.lastIndexOf("/")) || "/"
    : (dialogQuelle === dateien.activeSource ? dateien.currentPath : "/");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1e1e1e", position: "relative" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
        background: "#252526", borderBottom: "1px solid #3c3c3c", fontSize: 13,
      }}>
        <button onClick={neu} style={btnStyle}>Neu</button>
        <button onClick={saveFile} disabled={!dirty} style={btnStyle} title="Speichern (Strg+S)">
          Speichern {dirty ? "●" : ""}
        </button>
        <button onClick={() => setSpeichernUnter(true)} style={btnStyle} title="Speichern unter (Strg+Umschalt+S)">
          Speichern unter…
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#888", fontSize: 12 }}>
          {filename} {dirty ? "(modified)" : ""} — {getLanguage(filename)}
        </span>
      </div>

      {/* Editor */}
      <div style={{ flex: 1 }}>
        <Editor
          height="100%"
          language={getLanguage(filename)}
          value={content}
          onChange={(value) => { setContent(value || ""); setDirty(true); }}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "var(--font-mono, 'Cascadia Code', monospace)",
            wordWrap: "on",
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
          }}
        />
      </div>

      {/* Status bar */}
      <div style={{
        padding: "2px 8px", background: "#007acc", color: "#fff",
        fontSize: 12, display: "flex", justifyContent: "space-between",
      }}>
        <span>{status}</span>
        <span>{content.split("\n").length} lines</span>
      </div>

      {speichernUnter && (
        <SpeichernUnter
          source={dialogQuelle}
          startPfad={dialogOrdner}
          dateiname={filename}
          onSpeichern={speichernAls}
          onAbbrechen={() => setSpeichernUnter(false)}
        />
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#3c3c3c", color: "#ccc", border: "1px solid #555",
  borderRadius: 3, padding: "2px 10px", cursor: "pointer", fontSize: 12,
};
