/**
 * OfficeViewerApp — Word/Excel/PowerPoint/ODF in a DIRECTLY embedded Collabora.
 *
 * claraos-api is itself the WOPI host (routers/wopi.py) — the shell loads
 * cool.html directly from the Collabora host and is therefore the host frame
 * of the session. Only this makes the postMessage API work
 * (officeViewerBridge: Clara inserts live at the cursor position).
 * Previously the embed ran nested via Nextcloud's /f/<fileId> deep link —
 * postMessage was unreachable for the shell (only the direct parent may use it).
 *
 * Flow: POST /api/claraos/wopi/token (cookie/Authentik) → hidden form POST of
 * the access_token into the iframe (Collabora standard) → on
 * App_LoadingStatus/Document_loaded → Host_PostmessageReady (bridge).
 */
import { useEffect, useRef, useState } from "react";
import { useWindowsStore, buildObjectUri } from "@claraos/core";
import {
  COLLABORA_ORIGIN,
  installOfficeViewerActionHandler,
  markOfficeFrameFocused,
  markOfficeFrameReady,
  registerOfficeFrame,
  sendHostReady,
} from "./officeViewerBridge";
import styles from "./OfficeViewerApp.module.css";

installOfficeViewerActionHandler();

interface WopiToken {
  wopi_src: string;
  access_token: string;
  access_token_ttl: number;
  /** cool.html URL including the version hash from /hosting/discovery. */
  editor_url?: string;
}

export default function OfficeViewerApp({ windowId }: { windowId: string }) {
  const winPath = useWindowsStore((s) => s.windows[windowId]?.path);
  const winSource = useWindowsStore((s) => s.windows[windowId]?.source);
  const isFocused = useWindowsStore((s) => s.windows[windowId]?.focused);
  const setCurrentObjectUri = useWindowsStore((s) => s.setCurrentObjectUri);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [token, setToken] = useState<WopiToken | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (winPath && winSource) {
      setCurrentObjectUri(windowId, buildObjectUri("office-viewer", `${winSource}://${winPath}`));
    }
    return () => setCurrentObjectUri(windowId, undefined);
  }, [windowId, winPath, winSource, setCurrentObjectUri]);

  useEffect(() => {
    if (isFocused) markOfficeFrameFocused(windowId);
  }, [isFocused, windowId]);

  // 1) Mint the WOPI session token
  useEffect(() => {
    if (!winPath) {
      setError("Keine Datei übergeben — Office-Dokumente über die Dateien-App öffnen.");
      return;
    }
    if (winSource && winSource !== "nextcloud") {
      setError("Office-Dokumente können nur aus Nextcloud geöffnet werden.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/claraos/wopi/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ source: "nextcloud", path: winPath }),
        });
        if (!r.ok) {
          const detail = (await r.json().catch(() => ({})))?.detail;
          throw new Error(detail ?? `HTTP ${r.status}`);
        }
        const data = (await r.json()) as WopiToken;
        if (!cancelled) {
          setToken(data);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(`Dokument konnte nicht geöffnet werden: ${err}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [winPath, winSource]);

  // 2) Load access_token via form POST into the iframe (Collabora standard) +
  //    register the frame with the bridge + Document_loaded handshake
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!token || !iframe) return;

    const unregister = registerOfficeFrame(windowId, iframe);

    // frameName is set as the name attribute in JSX — setting
    // iframe.name=… afterwards does not reliably work for form.target in Chromium
    // (the form POST then landed in a POPUP instead of the iframe).
    const frameName = `office-frame-${windowId}`;
    const editorBase = token.editor_url || `${COLLABORA_ORIGIN}/browser/dist/cool.html?`;
    const sep = editorBase.includes("?") ? "" : "?";
    const form = document.createElement("form");
    form.method = "POST";
    form.target = frameName;
    // The canonical param is WOPISrc (case-sensitive!) — with "WopiSrc" the
    // FileServer returns a cool.html without a document URI → WS "/cool//ws" → Invalid URI.
    form.action = `${editorBase}${sep}WOPISrc=${encodeURIComponent(token.wopi_src)}`;
    form.style.display = "none";
    const tokenField = document.createElement("input");
    tokenField.type = "hidden";
    tokenField.name = "access_token";
    tokenField.value = token.access_token;
    form.appendChild(tokenField);
    const ttlField = document.createElement("input");
    ttlField.type = "hidden";
    ttlField.name = "access_token_ttl";
    ttlField.value = String(token.access_token_ttl);
    form.appendChild(ttlField);
    document.body.appendChild(form);
    form.submit();
    form.remove();

    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== COLLABORA_ORIGIN || ev.source !== iframe.contentWindow) return;
      let msg: { MessageId?: string; Values?: { Status?: string } };
      try {
        msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      if (msg?.MessageId === "App_LoadingStatus") {
        // Initialized → send Host_PostmessageReady; only AFTER that does
        // Collabora send Document_Loaded (and accept host actions).
        sendHostReady(windowId);
        // Beware of case drift between Collabora versions: "Document_Loaded"
        // (current) vs "Document_loaded" (older docs) → match tolerantly.
        if (/^document_loaded$/i.test(String(msg?.Values?.Status ?? ""))) {
          markOfficeFrameReady(windowId);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      unregister();
    };
  }, [token, windowId]);

  if (error) {
    return (
      <div className={styles.state}>
        <span className={styles.stateIcon} aria-hidden="true">📄</span>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      {!token && (
        <div className={styles.state}>
          <span className={styles.spinner} aria-hidden="true" />
          <p>Collabora wird geladen …</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        name={`office-frame-${windowId}`}
        className={styles.frame}
        style={token ? undefined : { display: "none" }}
        title="Office-Dokument (Collabora)"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </>
  );
}
