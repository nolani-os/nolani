/**
 * Print dialog.
 *
 * Deliberately small: pick a printer, copies, go. The conversion (images and
 * office files → PDF) is done by the server; here the file is only read and
 * sent.
 *
 * Important: before sending, the printer is probed (`/probe`). A printer whose
 * services hang accepts the connection and then never answers; without this
 * pre-check the user would stare at a spinner for a minute (some consumer
 * printers behave exactly like this).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@claraos/core";
import styles from "./ShareDialog.module.css";

interface Printer {
  id: string;
  name: string;
  state: string | null;
}

interface PrinterOptions {
  duplex: string[];
  duplex_note: string;
  color: string[];
  copies_max: number;
}

/** Option values with a translation (`print.sidesOption.*` / `print.colorOption.*`);
 *  anything else the printer reports is shown as is. */
const KNOWN_SIDES = new Set(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
const KNOWN_COLORS = new Set(["auto", "color", "monochrome"]);

interface Props {
  path: string;
  name: string;
  source: string;
  onClose: () => void;
}

export function PrintDialog({ path, name, source, onClose }: Props) {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selected, setSelected] = useState("");
  const [options, setOptions] = useState<PrinterOptions | null>(null);
  const [sides, setSides] = useState("one-sided");
  const [color, setColor] = useState("auto");
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const { t } = useTranslation("files");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/claraos/printing/printers", { credentials: "include" });
        const d = await r.json();
        if (!alive) return;
        setPrinters(d.printers ?? []);
        if (d.printers?.length) setSelected(d.printers[0].id);
      } catch {
        if (alive) setError(t("print.loadFailed"));
      }
    })();
    return () => { alive = false; };
  }, [t]);

  // Capabilities of the SELECTED printer: the UI only shows what it can
  // really do (a duplex switch that does nothing would be a lie).
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/claraos/printing/printers/${selected}/options`,
                              { credentials: "include" });
        if (!r.ok) return;
        const d: PrinterOptions = await r.json();
        if (!alive) return;
        setOptions(d);
        setSides(d.duplex.includes(sides) ? sides : "one-sided");
        setColor(d.color.includes(color) ? color : "auto");
      } catch { /* options stay hidden; defaults still print */ }
    })();
    return () => { alive = false; };
    // sides/color deliberately NOT a dependency: otherwise every selection reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setError("");
    setDone("");
    try {
      setBusy(t("print.probing"));
      const probe = await fetch(`/api/claraos/printing/printers/${selected}/probe`, {
        method: "POST", credentials: "include",
      });
      const pj = await probe.json();
      if (!pj.ok) {
        setBusy("");
        setError(pj.detail || t("print.noResponse"));
        return;
      }

      setBusy(t("print.reading"));
      const read = await fetch(
        `/api/claraos/files/v2/read?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`,
        { credentials: "include" },
      );
      if (!read.ok) throw new Error(t("print.readFailed"));
      const fd = await read.json();
      const b64 = fd.encoding === "base64" ? fd.content : btoa(unescape(encodeURIComponent(fd.content ?? "")));

      setBusy(t("print.sending"));
      const res = await fetch("/api/claraos/printing/print", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: selected, content_b64: b64, filename: name,
                               copies, sides, color }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || t("print.error", { status: res.status }));
      setBusy("");
      setDone(body.detail || t("print.sent"));
    } catch (e) {
      setBusy("");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selected, source, path, name, copies, sides, color, t]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} data-print-dialog>
        <h3 style={{ margin: "0 0 12px" }}>{t("print.title", { name })}</h3>

        {printers.length === 0 ? (
          <p style={{ opacity: 0.75 }}>
            {t("print.noPrinter")}
          </p>
        ) : (
          <>
            <label style={{ display: "block", marginBottom: 10 }}>
              {t("print.printer")}
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                style={{ width: "100%", marginTop: 4, padding: 6 }}
                data-print-printer
              >
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            {options && options.color.length > 1 && (
              <label style={{ display: "block", marginBottom: 10 }}>
                {t("print.color")}
                <select
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  style={{ width: "100%", marginTop: 4, padding: 6 }}
                  data-print-color
                >
                  {options.color.map((c) => (
                    <option key={c} value={c}>{KNOWN_COLORS.has(c) ? t(`print.colorOption.${c}`) : c}</option>
                  ))}
                </select>
              </label>
            )}

            {options && options.duplex.length > 1 ? (
              <label style={{ display: "block", marginBottom: 10 }}>
                {t("print.sides")}
                <select
                  value={sides}
                  onChange={(e) => setSides(e.target.value)}
                  style={{ width: "100%", marginTop: 4, padding: 6 }}
                  data-print-sides
                >
                  {options.duplex.map((s) => (
                    <option key={s} value={s}>{KNOWN_SIDES.has(s) ? t(`print.sidesOption.${s}`) : s}</option>
                  ))}
                </select>
              </label>
            ) : options?.duplex_note ? (
              <p style={{ opacity: 0.6, fontSize: 12, margin: "0 0 10px" }} data-print-duplex-note>
                {options.duplex_note}
              </p>
            ) : null}

            <label style={{ display: "block", marginBottom: 14 }}>
              {t("print.copies")}
              <input
                type="number" min={1} max={options?.copies_max ?? 20} value={copies}
                onChange={(e) => setCopies(Math.min(options?.copies_max ?? 20,
                                                    Math.max(1, Number(e.target.value) || 1)))}
                style={{ width: 80, marginLeft: 8, padding: 6 }}
                data-print-copies
              />
            </label>
          </>
        )}

        {busy && <p style={{ opacity: 0.8 }} data-print-busy>{busy}</p>}
        {error && <p style={{ color: "#fca5a5" }} data-print-error>{error}</p>}
        {done && <p style={{ color: "#86efac" }} data-print-done>{done}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose}>{t("actions.close")}</button>
          <button
            onClick={() => void submit()}
            disabled={!selected || !!busy}
            data-print-submit
          >
            {t("print.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
