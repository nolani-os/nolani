import { useCallback, useEffect, useState } from "react";
import { useIsMobile } from "../Mobile/useIsMobile";
import styles from "./SelkiesApp.module.css";

// Detect touch devices even when the viewport reports ≥768px (phone in
// "desktop site" mode, foldables). Otherwise a phone lands on the desktop
// twin (mouse layout, unusable). Coarse pointer = finger/stylus.
function isCoarsePointer(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}

interface SelkiesAppProps {
  windowId: string;
  appId?: string;
  targetUrl?: string;
  title?: string;
}

export function SelkiesApp({ appId, targetUrl, title }: SelkiesAppProps) {
  const [selkiesUrl, setSelkiesUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [showCreds, setShowCreds] = useState(true);
  const [navStatus, setNavStatus] = useState<"idle" | "ok" | "failed">("idle");
  // Why there is no browser (e.g. all slots busy) — shown instead of a generic "offline".
  const [hint, setHint] = useState<string | null>(null);
  // Mobile = a dedicated mobile-tuned browser twin (Android UA, 2.6x scaling,
  // separate profile); the desktop stream is unusable on touch. A narrow
  // viewport OR a coarse pointer suffices, so desktop-mode phones don't slip through.
  const isNarrow = useIsMobile();
  const preferMobile = isNarrow || isCoarsePointer();

  const checkStatus = useCallback(async () => {
    setLoading(true);
    try {
      // `form` tells the server which twin is needed, so only that one is woken.
      const res = await fetch(`/api/claraos/apps/selkies/status?form=${preferMobile ? "mobile" : "desktop"}`);
      if (res.ok) {
        const data = await res.json();
        const branch = preferMobile && data.mobile ? data.mobile : data;
        setAvailable(branch.available);
        setSelkiesUrl(branch.url);
        setHint(branch.hint || data.hint || null);
      } else {
        setAvailable(false);
      }
    } catch {
      setAvailable(false);
    }
    setLoading(false);
  }, [preferMobile]);

  // Load credentials for overlay
  useEffect(() => {
    if (!appId) return;
    (async () => {
      try {
        const res = await fetch(`/api/claraos/auth-proxy/${appId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.credentials) setCredentials(data.credentials);
        }
      } catch { /* ignore */ }
    })();
  }, [appId]);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  // Auto-navigation: send the streamed Chromium to the target URL via CDP.
  // Falls back to the copy hint on error.
  const navigate = useCallback(async () => {
    if (!appId || !targetUrl) return;
    try {
      const res = await fetch("/api/claraos/apps/selkies/navigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, form: preferMobile ? "mobile" : "desktop" }),
      });
      const data = res.ok ? await res.json() : null;
      setNavStatus(data?.status === "opened" || data?.status === "focused" ? "ok" : "failed");
    } catch {
      setNavStatus("failed");
    }
  }, [appId, targetUrl, preferMobile]);

  useEffect(() => {
    if (available && navStatus === "idle") navigate();
  }, [available, navStatus, navigate]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  if (loading) return <div className={styles.loading}>Starting browser...</div>;
  if (!available || !selkiesUrl) {
    return (
      <div className={styles.offline}>
        <span className={styles.offlineIcon}>🌐</span>
        <p>{hint || "Der ferne Browser ist offline"}</p>
        <button className={styles.retryBtn} onClick={checkStatus}>Erneut versuchen</button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Navigation hint + credentials */}
      {((targetUrl && navStatus !== "ok") || credentials) && showCreds && (
        <div className={styles.hint}>
          {targetUrl && navStatus !== "ok" && (
            <>
              <span>Adresse aufrufen:</span>
              <code className={styles.hintUrl}>{targetUrl}</code>
              <button className={styles.copyBtn} onClick={() => handleCopy(targetUrl)}>
                {copied ? "Kopiert!" : "Kopieren"}
              </button>
              {navStatus === "failed" && (
                <button className={styles.copyBtn} onClick={navigate}>↻ Automatisch aufrufen</button>
              )}
            </>
          )}
          {credentials && Object.entries(credentials).map(([key, value]) => (
            <span key={key} className={styles.credHint}>
              {key}: <code className={styles.hintUrl}>{key.includes("pass") ? "••••" : value}</code>
              <button className={styles.copyBtn} onClick={() => handleCopy(value)}>📋</button>
            </span>
          ))}
          <button className={styles.copyBtn} onClick={() => setShowCreds(false)}>✕</button>
        </div>
      )}
      <iframe
        className={styles.iframe}
        src={selkiesUrl}
        title={title || "Remote Browser"}
        allow="camera; microphone; clipboard-write; clipboard-read; autoplay; fullscreen"
        loading="lazy"
      />
    </div>
  );
}
