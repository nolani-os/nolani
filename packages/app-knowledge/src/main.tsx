import "./polyfills";
import { StrictMode, Suspense, lazy, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { i18n, useAuthStore, useWindowsStore } from "@claraos/core";
import { startI18n } from "../../shell/src/i18n";
import "../../shell/src/tokens.css";
import "../../shell/src/global.css";
import { isTauri, openDb, type Db } from "./local/db";
import { migrate } from "./local/schema";
import { createLocalApi, LOCAL_USER } from "./local/api";
import { installFetchShim } from "./local/fetchShim";
import { NUR_LOKAL, WissenFunktionenContext } from "../../shell/src/apps/wissen/erweiterung";
import { applySettings, loadSettings, startBridge } from "./localApi";
import { ApiEinstellungen } from "./ApiEinstellungen";

// The core only: no Strategy section, and none of the functions that need a
// server or other people (assistant, clipping, sharing, comments, shopping).
const WissenKern = lazy(() => import("../../shell/src/apps/wissen/WissenKern"));
const WINDOW_ID = "knowledge-standalone";

/** Web links open in the system browser; the app window never navigates away. */
async function linkOeffnen(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    fensterOeffnen(url, "_blank", "noopener");
  }
}

// Web links: a tap or click opens them in the system browser. Inside the editor
// this runs first (capture phase): in editable text a tap only places the cursor,
// so a link in a note could not be opened at all on a phone. Elsewhere it catches
// links nothing else handled. The native side additionally refuses to navigate
// the app window away (src-tauri/src/lib.rs, stay_in_app).
document.addEventListener("click", (e) => {
  if (e.button !== 0) return;
  const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || !/^(https?:|mailto:)/i.test(a.getAttribute("href") ?? "")) return;
  if (!a.closest("[data-claraos-editor]") && e.defaultPrevented) return;
  e.preventDefault();
  e.stopPropagation();
  void linkOeffnen(a.href);
  // The tap also put the cursor into the link: leave the editor, so neither the
  // keyboard nor the link popup is open when the user comes back from the browser.
  (document.activeElement as HTMLElement | null)?.blur?.();
  window.getSelection()?.removeAllRanges();
}, true);

// window.open (e.g. "open link" in the editor's link toolbar) goes the same way
const fensterOeffnen = window.open.bind(window);
window.open = ((url?: string | URL, ...rest: unknown[]) => {
  const ziel = url ? String(url) : "";
  if (/^(https?:|mailto:)/i.test(ziel)) {
    void linkOeffnen(ziel);
    return null;
  }
  return fensterOeffnen(url, ...(rest as [string?, string?]));
}) as typeof window.open;

/** Attachments live in the local database: the editor gets a blob address for them. */
const blobUrls = new Map<string, string>();
async function dateiAufloesen(url: string): Promise<string> {
  if (!url.startsWith("/api/claraos/knowledge/attachments/")) return url;
  const cached = blobUrls.get(url);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) return url;
  const blob = URL.createObjectURL(await r.blob());
  blobUrls.set(url, blob);
  return blob;
}

/** Downloads (export archive): the native app writes to the Downloads folder,
 *  a browser gets a regular file download. */
async function herunterladen(url: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`);
  const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "download";
  const data = new Uint8Array(await r.arrayBuffer());
  // Android: into the public Download folder via the activity's bridge
  const android = (window as { NolaniDownloads?: { save(n: string, m: string, b64: string): string } }).NolaniDownloads;
  if (android) {
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const pfad = android.save(name, r.headers.get("Content-Type") ?? "", btoa(bin));
    window.alert(i18n.t("wissen:app.savedTo", { path: pfad, defaultValue: `✓ ${pfad}` }));
    return;
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const pfad = await invoke<string>("save_download", { name, data: Array.from(data) });
    window.alert(i18n.t("wissen:app.savedTo", { path: pfad, defaultValue: `✓ ${pfad}` }));
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function App({ db }: { db: Db }) {
  const [einstellungen, setEinstellungen] = useState(false);
  const funktionen = useMemo(
    () => ({
      ...NUR_LOKAL, dateiAufloesen, herunterladen, einstellungen: () => setEinstellungen(true),
      linkOeffnen: (url: string) => void linkOeffnen(url),
    }), []);
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <WissenFunktionenContext.Provider value={funktionen}>
        <WissenKern windowId={WINDOW_ID} start="wissen" />
      </WissenFunktionenContext.Provider>
      {einstellungen && <ApiEinstellungen db={db} onClose={() => setEinstellungen(false)} />}
    </div>
  );
}

async function boot() {
  const db = await openDb();
  await migrate(db);
  const handle = createLocalApi(db, { lang: () => i18n.resolvedLanguage ?? "de" });
  installFetchShim(handle);
  // Local HTTP API (desktop): answer its requests with the same handler, start it if switched on
  try {
    await startBridge(handle);
    await applySettings(await loadSettings(db));
  } catch (e) {
    console.warn("local API not started", e);
  }
  (window as { __knowledgeDriver?: string }).__knowledgeDriver = db.driver;

  useAuthStore.getState().setUser({
    username: LOCAL_USER, email: "", name: "", role: "user", groups: [], profil: "cell",
  });
  // The app ignores keyboard shortcuts unless its window has focus.
  useWindowsStore.setState({ focusedWindowId: WINDOW_ID } as never);

  await startI18n();
  await i18n.loadNamespaces("wissen");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <App db={db} />
      </Suspense>
    </StrictMode>,
  );

  if (import.meta.env.VITE_SELFTEST === "1") {
    const { runSelftest } = await import("./selftest");
    setTimeout(() => void runSelftest(db.driver), 3000);
  }
}

void boot();
