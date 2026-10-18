import { useState, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useWindowsStore, useFileStore, buildObjectUri } from "@claraos/core";

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

  // Save file via the v2 endpoint, falling back to legacy
  const saveFile = useCallback(async () => {
    if (!filePath || !fileSource) {
      setStatus("Speichern fehlgeschlagen — kein Pfad. „Speichern unter\u201c gibt es noch nicht.");
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

  // Keyboard shortcut Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveFile]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1e1e1e" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
        background: "#252526", borderBottom: "1px solid #3c3c3c", fontSize: 13,
      }}>
        <button onClick={() => { setContent(""); setFilename("untitled.txt"); setDirty(false); }}
          style={btnStyle}>Neu</button>
        <button onClick={saveFile} disabled={!dirty} style={btnStyle}>
          Speichern {dirty ? "●" : ""}
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
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#3c3c3c", color: "#ccc", border: "1px solid #555",
  borderRadius: 3, padding: "2px 10px", cursor: "pointer", fontSize: 12,
};
