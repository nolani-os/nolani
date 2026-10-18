import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./IframeApp.module.css";
import { useIsMobile } from "../Mobile/useIsMobile";
import { resolveMobileStrategy } from "./mobileStrategies";
import { getAppManifest } from "./registry";
import { attachIframeBridge } from "../Chat/iframeBridge";
import { registerIframeNavigator } from "./iframeNavigator";

interface AuthProxyResponse {
  auth: { type: string; key?: string; value?: string; name?: string; path?: string; username?: string; password?: string } | null;
  credentials?: Record<string, string>;
  error?: string;
  reason?: string;
}

interface IframeAppProps {
  windowId: string;
  appId: string;
  url: string;
  title?: string;
  extraSandbox?: string;
  /** If true, route the iframe through /api/claraos/iframe-bootstrap/{appId}
   *  to clear stale service cookies and force fresh OIDC auth. */
  forceFreshAuth?: boolean;
  /** If true, always embed inline (skip the mobile choice/redirect landing).
   *  Used by the mobile cobrowse split-view so the live app is shown directly. */
  forceInline?: boolean;
}

export function IframeApp({ windowId, appId, url: rawUrl, title, extraSandbox, forceFreshAuth, forceInline: forceInlineProp = false }: IframeAppProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  // Deep-link override. When Clara calls navigate_to, the
  // shell handler sets this via the iframeNavigator registry; it wins over the
  // auth-resolved finalUrl so the iframe jumps to the requested view.
  const [navOverride, setNavOverride] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  // "choice" strategy: user tapped "open in ClaraOS" on the mobile landing,
  // so we render the inline iframe instead of escaping to a tab/native app.
  const [forceInline, setForceInline] = useState(false);
  const isMobile = useIsMobile();
  const manifest = getAppManifest(appId);
  // Selkies/KasmVNC desktop GUIs ship with show_control_bar=false (desktop has a
  // real keyboard). On mobile, force the control bar on so the on-screen
  // keyboard / touch gestures are reachable.
  const url = isMobile
    ? rawUrl.replace("show_control_bar=false", "show_control_bar=true")
    : rawUrl;
  const mobileResolved = resolveMobileStrategy({
    id: appId,
    mobileStrategy: manifest?.mobileStrategy,
    deeplinkScheme: manifest?.deeplinkScheme,
    type: manifest?.type,
  });
  const useMobileBranch = isMobile && mobileResolved.strategy !== "iframe" && !forceInline && !forceInlineProp;

  // Fetch auth + credentials before loading iframe
  const doAuth = useCallback(async () => {
    if (!url || !appId) { setFinalUrl(url); return; }

    // On desktop, forceFreshAuth routes through iframe-bootstrap to clear stale
    // cookies and trigger fresh OIDC. On mobile, skip this — single-user device,
    // and the multi-redirect chain breaks in mobile iframe contexts.
    if (forceFreshAuth && !isMobile) {
      setFinalUrl(`/api/claraos/iframe-bootstrap/${appId}?t=${Date.now()}`);
      return;
    }

    try {
      const res = await fetch(`/api/claraos/auth-proxy/${appId}`);
      if (!res.ok) { setFinalUrl(url); return; }
      const data: AuthProxyResponse = await res.json();

      // Always show credentials overlay if available
      if (data.credentials) {
        setCredentials(data.credentials);
      }

      // Try to apply auth token
      if (data.auth) {
        if (data.auth.type === "redirect_url" && data.auth.url) {
          setFinalUrl(data.auth.url);
          return;
        }
        if (data.auth.type === "query_param" && data.auth.key && data.auth.value) {
          const sep = url.includes("?") ? "&" : "?";
          setFinalUrl(`${url}${sep}${data.auth.key}=${encodeURIComponent(data.auth.value)}`);
          return;
        }
        if (data.auth.type === "form_login") {
          // Use server-side auto-login endpoint that returns an auto-submitting form
          setFinalUrl(`/api/claraos/auth-proxy/auth-login/${appId}`);
          return;
        }
        if (data.auth.type === "cookie" && data.auth.name && data.auth.value) {
          // Try setting cookie for the service domain
          try {
            const serviceHost = new URL(url).hostname;
            const parentDomain = serviceHost.split(".").slice(-2).join(".");
            document.cookie = `${data.auth.name}=${data.auth.value}; domain=.${parentDomain}; path=${data.auth.path || "/"}; SameSite=None; Secure`;
          } catch { /* cross-origin, ignore */ }
          setFinalUrl(url);
          return;
        }
        if (data.auth.type === "basic_auth" && data.auth.username) {
          // NO user:pass@ URL: Chrome now SILENTLY blocks iframe navigations with
          // embedded credentials (the frame stays empty, "app does not load").
          // Load the plain URL; the user's Authentik session carries through
          // forward-auth SSO, and the credentials overlay remains as a fallback
          // for app-specific login forms.
          setFinalUrl(url);
          return;
        }
      }

      setFinalUrl(url);
    } catch {
      setFinalUrl(url);
    }
  }, [url, appId, isMobile]);

  useEffect(() => { if (!useMobileBranch) doAuth(); }, [doAuth, forceFreshAuth, useMobileBranch]);

  // Cleanup the bridge handle when the component unmounts
  useEffect(() => {
    return () => {
      const el = iframeRef.current as unknown as { __claraosBridge?: { dispose: () => void } } | null;
      el?.__claraosBridge?.dispose();
    };
  }, []);

  // Register this iframe as the deep-link target for its appId. Clara's
  // navigate_to → shell `navigate_to` handler → navigateIframe(appId,url) → here.
  useEffect(() => {
    return registerIframeNavigator(appId, (target) => {
      try {
        // Same-origin path change: drive contentWindow.location when reachable
        // (survives SPA soft-nav better), else fall back to the controlled src.
        const win = iframeRef.current?.contentWindow;
        if (win) win.location.assign(target);
      } catch {
        /* cross-origin guard — fall through to src */
      }
      setNavOverride(target);
    });
  }, [appId]);

  // Loading timeout: show iframe after 6s even if onLoad hasn't fired
  // (cross-origin OIDC redirects in iframes sometimes swallow the event)
  useEffect(() => {
    if (!loading || !finalUrl) return;
    const timer = window.setTimeout(() => setLoading(false), 6000);
    return () => clearTimeout(timer);
  }, [loading, finalUrl]);

  if (!url) {
    return <div className={styles.placeholder}><p>Für diese App ist keine Adresse hinterlegt.</p></div>;
  }

  // Mobile branch: escape iframe entirely. Open top-level tab (redirect) or try
  // a native app scheme first (deeplink) with a Web fallback.
  // For nc_editor apps, resolve the real file URL first via auth-proxy.
  const [mobileUrl, setMobileUrl] = useState<string>(url);
  useEffect(() => {
    if (!useMobileBranch) return;
    fetch(`/api/claraos/auth-proxy/${appId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.auth?.type === "redirect_url" && data.auth.url) {
          setMobileUrl(data.auth.url);
        }
      })
      .catch(() => {});
  }, [useMobileBranch, appId]);

  if (useMobileBranch) {
    const openWeb = () => window.open(mobileUrl, "_blank", "noopener");
    const openDeeplink = () => {
      if (!mobileResolved.scheme) { openWeb(); return; }
      const start = Date.now();
      // If scheme handler is installed, the page becomes hidden quickly.
      const timer = window.setTimeout(() => {
        if (Date.now() - start < 2000 && document.visibilityState === "visible") openWeb();
      }, 1200);
      const cleanup = () => {
        if (document.visibilityState === "hidden") window.clearTimeout(timer);
      };
      document.addEventListener("visibilitychange", cleanup, { once: true });
      window.location.href = mobileResolved.scheme;
    };
    const strat = mobileResolved.strategy;
    const isChoice = strat === "choice";
    const isDeeplink = strat === "deeplink";
    const hint = isChoice
      ? "Diese App hat eine native Android-App. Inline in ClaraOS bleiben oder die App öffnen?"
      : isDeeplink
        ? "Öffnet die native App, falls installiert — sonst im Browser."
        : "Diese App läuft auf dem Handy am besten in einem eigenen Tab.";
    return (
      <div className={styles.mobileLanding}>
        <div className={styles.mobileLandingTitle}>{title || appId}</div>
        <div className={styles.mobileLandingHint}>{hint}</div>
        {isChoice ? (
          <>
            <button className={styles.mobileLandingBtn} onClick={() => setForceInline(true)}>
              In ClaraOS öffnen
            </button>
            <button
              className={`${styles.mobileLandingBtn} ${styles.mobileLandingBtnSecondary}`}
              onClick={openDeeplink}
            >
              In App öffnen
            </button>
          </>
        ) : (
          <>
            <button
              className={styles.mobileLandingBtn}
              onClick={isDeeplink ? openDeeplink : openWeb}
            >
              {isDeeplink ? "In App öffnen" : "Im Browser öffnen"}
            </button>
            {isDeeplink && (
              <button className={`${styles.mobileLandingBtn} ${styles.mobileLandingBtnSecondary}`} onClick={openWeb}>
                Stattdessen im Browser
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  if (!finalUrl) {
    return <div className={styles.loading}>Authenticating...</div>;
  }

  const sandbox = isMobile
    ? `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox${extraSandbox ? ` ${extraSandbox}` : ""}`
    : `allow-scripts allow-same-origin allow-forms allow-popups${extraSandbox ? ` ${extraSandbox}` : ""}`;

  return (
    <div className={styles.container}>
      {/* Credential overlay */}
      {credentials && overlayVisible && (
        <div className={styles.credOverlay}>
          <div className={styles.credOverlayContent}>
            <div className={styles.credOverlayTitle}>Zugangsdaten</div>
            {Object.entries(credentials).map(([key, value]) => (
              <div key={key} className={styles.credRow}>
                <span className={styles.credLabel}>{key}:</span>
                <code className={styles.credValue}>{key.toLowerCase().includes("pass") || key.toLowerCase().includes("token") || key.toLowerCase().includes("key") ? "••••••" : value}</code>
                <button className={styles.credCopy} onClick={() => navigator.clipboard.writeText(value)} title="Kopieren">📋</button>
              </div>
            ))}
            <button className={styles.credDismiss} onClick={() => setOverlayVisible(false)}>Ausblenden</button>
          </div>
        </div>
      )}

      {loading && !error && <div className={styles.loading}>{title || url} wird geladen…</div>}
      {error && (
        <div className={styles.error}>
          <p>{title || url} konnte nicht geladen werden</p>
          <button className={styles.retryBtn} onClick={() => { setError(false); setLoading(true); doAuth(); }}>Erneut versuchen</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className={styles.iframe}
        src={navOverride ?? finalUrl}
        title={title || url}
        sandbox={sandbox}
        allow="camera; microphone; clipboard-write; clipboard-read"
        loading="lazy"
        data-window-id={windowId}
        data-app-id={appId}
        onLoad={() => {
          setLoading(false);
          // Handshake with iframe-helper if the embedded app opted in
          if (iframeRef.current) {
            const handle = attachIframeBridge(iframeRef.current, windowId);
            // Persist on the element so unmount can dispose
            (iframeRef.current as unknown as { __claraosBridge?: { dispose: () => void } }).__claraosBridge = handle;
          }
        }}
        onError={() => { setLoading(false); setError(true); }}
        style={{ opacity: loading || error ? 0 : 1 }}
      />
    </div>
  );
}
