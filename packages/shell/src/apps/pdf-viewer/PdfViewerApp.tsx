import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useWindowsStore, buildObjectUri, i18n, useTranslation } from "@claraos/core";
import { fileUrl } from "../../lib/downloadFile";

// Without a built-in PDF viewer (Android WebView of the companion app) we render
// ourselves — a PDF in an iframe crashed the app there.
const EINGEBAUTER_ANZEIGER = navigator.pdfViewerEnabled !== false;
const PdfSeiten = lazy(() => import("./PdfSeiten"));

export default function PdfViewerApp({ windowId }: { windowId: string }) {
  const { t } = useTranslation("viewers");
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-load when opened with path/source
  const winPath = useWindowsStore((s) => s.windows[windowId]?.path);
  const winSource = useWindowsStore((s) => s.windows[windowId]?.source);
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);

  useEffect(() => {
    if (winPath && winSource) {
      setCurrentObjectUri(windowId, buildObjectUri("pdf-viewer", `${winSource}://${winPath}`));
    }
    return () => setCurrentObjectUri(windowId, undefined);
  }, [windowId, winPath, winSource, setCurrentObjectUri]);
  useEffect(() => {
    if (!winPath || !winSource) return;
    let cancelled = false;
    let createdUrl = "";
    (async () => {
      // Load from the streaming endpoint, not via /read: /read returns JSON/Base64
      // with a 10 MB cap (413), so every larger PDF showed "Failed to load PDF".
      // The blob URL stays: the companion's own renderer needs local bytes.
      const resp = await fetch(fileUrl(winSource, winPath, { inline: true })).catch(() => null);
      if (cancelled || !resp?.ok) {
        if (!cancelled) setError(i18n.t("viewers:pdf.loadFailed"));
        return;
      }
      const blob = new Blob([await resp.arrayBuffer()], { type: "application/pdf" });
      if (cancelled) return;
      createdUrl = URL.createObjectURL(blob);
      if (!cancelled) {
        setPdfUrl(createdUrl);
        setError("");
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [winPath, winSource]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === "application/pdf") {
      const url = URL.createObjectURL(file);
      setPdfUrl(url);
      setError("");
    } else {
      setError(t("pdf.pickPdf"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#2b2b2b" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
        background: "#323233", borderBottom: "1px solid #444",
      }}>
        <button onClick={() => fileInputRef.current?.click()} style={btnStyle}>
          {t("pdf.open")}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileSelect}
          style={{ display: "none" }} />
        {pdfUrl && EINGEBAUTER_ANZEIGER && (
          <button onClick={() => window.open(pdfUrl, "_blank")} style={btnStyle}>
            {t("pdf.newTab")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "#888", fontSize: 12 }}>{t("pdf.title")}</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {pdfUrl && !EINGEBAUTER_ANZEIGER ? (
          <Suspense fallback={null}>
            <PdfSeiten url={pdfUrl} />
          </Suspense>
        ) : pdfUrl ? (
          <iframe
            src={pdfUrl}
            style={{ width: "100%", height: "100%", border: "none" }}
            title={t("pdf.title")}
          />
        ) : (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", color: "#888", gap: 16,
          }}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <p style={{ fontSize: 16 }}>{t("pdf.emptyTitle")}</p>
            <button onClick={() => fileInputRef.current?.click()}
              style={{ ...btnStyle, padding: "8px 24px", fontSize: 14 }}>
              {t("pdf.pick")}
            </button>
            {error && <p style={{ color: "#f38ba8" }}>{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#3c3c3c", color: "#ccc", border: "1px solid #555",
  borderRadius: 4, padding: "4px 12px", cursor: "pointer", fontSize: 13,
};
