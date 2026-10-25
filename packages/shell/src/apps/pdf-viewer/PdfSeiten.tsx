import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { useTranslation } from "@claraos/core";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Renders a PDF itself (pdf.js → canvas), page below page.
 *
 * Only for environments without a built-in PDF viewer (`navigator.pdfViewerEnabled`
 * is false) — mainly the Android WebView of the companion app. There a PDF in
 * an iframe crashed the whole app, and because the shell restores open
 * windows on start, it then crashed again on every start.
 */
export default function PdfSeiten({ url }: { url: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("viewers");
  const [breite, setBreite] = useState(0);
  const [seiten, setSeiten] = useState(0);
  const [fehler, setFehler] = useState("");

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBreite(el.clientWidth));
    ro.observe(el);
    setBreite(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const hinweis = (text: string) => (
    <p style={{ color: "#aaa", textAlign: "center", padding: 24 }}>{text}</p>
  );

  return (
    <div ref={boxRef} style={{ height: "100%", overflow: "auto", background: "#525659" }}>
      {fehler ? hinweis(fehler) : (
        <Document
          file={url}
          onLoadSuccess={({ numPages }) => setSeiten(numPages)}
          onLoadError={(e) => setFehler(t("pdf.cannotOpenDetail", { error: e.message }))}
          loading={hinweis(t("pdf.loading"))}
          error={hinweis(t("pdf.cannotOpen"))}
        >
          {breite > 0 && Array.from({ length: seiten }, (_, i) => (
            <div key={i} style={{ margin: "8px auto", width: "fit-content", boxShadow: "0 1px 4px #0006" }}>
              <Page
                pageNumber={i + 1}
                width={Math.max(breite - 16, 100)}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </div>
          ))}
        </Document>
      )}
    </div>
  );
}
