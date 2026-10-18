import { useEffect, useState, type CSSProperties } from "react";
import { BASE_DOMAIN, useIstZelle } from "@claraos/core";

/* Setup wizard completion: if the user arrives from the onboarding portal with
   ?onboarding=1, we show a PWA install hint after login.
   The beforeinstallprompt event is captured in main.tsx BEFORE the React mount
   (deferredInstallPrompt), otherwise it is long gone by render time.
   iOS has no beforeinstallprompt -> share-sheet instructions. */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const installPromptHolder: { event: BeforeInstallPromptEvent | null } = { event: null };

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPromptHolder.event = e as BeforeInstallPromptEvent;
  });
}

const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
/* If the shell is already running INSIDE the Companion app (the WebView sets a
   UA suffix), any install hint is pointless. */
export const IS_COMPANION = navigator.userAgent.includes("ClaraOSCompanion/");
/** Stable path (nginx /downloads/ from a bind mount, behind forward_auth). */
export const COMPANION_APK_URL = "/downloads/claraos-companion.apk";

/* ── Desktop Companion ───────────────────────────────────────────────────────
   The Companion identifies itself as `ClaraOSCompanion/<ver> (windows|linux)`;
   the Android app sends no parentheses. Detection deliberately uses the UA so
   the shell knows in EVERY context what it is running in. */
export type CompanionPlatform = "android" | "windows" | "linux" | null;
export const COMPANION_PLATFORM: CompanionPlatform = (() => {
  const m = /ClaraOSCompanion\/\S+\s+\((windows|linux)\)/.exec(navigator.userAgent);
  if (m) return m[1] as CompanionPlatform;
  return IS_COMPANION ? "android" : null;
})();

const IS_WINDOWS = /Windows NT/i.test(navigator.userAgent);
const IS_LINUX_DESKTOP = /Linux/i.test(navigator.userAgent) && !IS_ANDROID;
/** Desktop browser without Companion = candidate for the PC app. */
const OFFER_DESKTOP_APP = !IS_COMPANION && !IS_IOS && !IS_ANDROID && (IS_WINDOWS || IS_LINUX_DESKTOP);
/** Stable names; behind forward_auth in the shell context, public via the product domain. */
export const COMPANION_DESKTOP_URL = IS_WINDOWS
  ? "/downloads/desktop/ClaraOS-Companion-setup.exe"
  : "/downloads/desktop/ClaraOS-Companion.AppImage";
const IS_STANDALONE =
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export function OnboardingInstallPrompt() {
  const [visible, setVisible] = useState(false);
  // External cell: the Android app connects there in direct mode
  // (claraos://connect); the PC app cannot do that yet — it only knows the tunnel.
  const istZelle = useIstZelle();
  const offerDesktop = OFFER_DESKTOP_APP && !istZelle;
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("onboarding") !== "1" || IS_STANDALONE || IS_COMPANION) return;
    setVisible(true);
    // Remove the param from the URL so reloads/bookmarks stay clean
    params.delete("onboarding");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }, []);

  if (!visible) return null;

  const install = async () => {
    const ev = installPromptHolder.event;
    if (!ev) return;
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    installPromptHolder.event = null;
  };

  return (
    <div style={{
      position: "fixed", left: "50%", bottom: "max(18px, env(safe-area-inset-bottom))",
      transform: "translateX(-50%)", zIndex: 99999,
      maxWidth: "min(440px, calc(100vw - 24px))",
      background: "linear-gradient(165deg, rgba(19,26,46,.92) 0%, rgba(7,10,19,.95) 100%)",
      border: "1px solid rgba(147,197,253,.35)", borderRadius: 16,
      boxShadow: "0 18px 48px rgba(0,0,0,.5)", color: "#e8eefb",
      padding: "16px 18px", fontFamily: "system-ui, sans-serif",
      backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
    }}>
      {installed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>{"\u{1F389}"}</span>
          <div>
            <strong>Fertig!</strong> ClaraOS ist jetzt eine App auf deinem Gerät.
            <button onClick={() => setVisible(false)} style={dismissStyle}>Schließen</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span style={{ fontSize: 24 }}>{"\u{2728}"}</span>
          <div style={{ flex: 1 }}>
            <strong>Letzter Schritt: ClaraOS als App installieren</strong>
            <p style={{ margin: "6px 0 10px", fontSize: 13.5, color: "#9fb0d0", lineHeight: 1.5 }}>
              {IS_IOS
                ? <>In Safari unten das <strong>Teilen-Symbol</strong> antippen → <strong>„Zum Home-Bildschirm"</strong>.</>
                : IS_ANDROID
                  ? istZelle
                    ? <>Empfohlen: die <strong>ClaraOS-App für Android</strong>. Nach der
                        Installation auf <strong>„Mit der App verbinden"</strong> tippen.</>
                    : <>Empfohlen: die <strong>ClaraOS-App für Android</strong> — mit Foto-Sync,
                        Dokumentenscanner und Push. Alternativ als Web-App installieren.</>
                  : offerDesktop
                    ? <>Empfohlen: die <strong>ClaraOS-App für den PC</strong> — verbindet sich
                        selbst mit deinem Zuhause (ohne VPN-Einrichtung, ohne Admin-Rechte)
                        und bringt Benachrichtigungen mit. Alternativ als Web-App installieren.</>
                    : installPromptHolder.event
                      ? "Ein Tipp genügt — danach startet ClaraOS direkt vom Homescreen."
                      : <>Im Browser-Menü <strong>„App installieren"</strong> wählen (⋮ oben rechts).</>}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {IS_ANDROID && (
                <a href={COMPANION_APK_URL} style={{
                  font: "600 14px system-ui", color: "#04121f", cursor: "pointer",
                  background: "linear-gradient(180deg,#4cc7fa,#1f9fe0)", textDecoration: "none",
                  border: "none", borderRadius: 10, padding: "9px 16px", display: "inline-block",
                }}>Android-App laden</a>
              )}
              {IS_ANDROID && istZelle && (
                <a href={`claraos://connect?server=${encodeURIComponent(BASE_DOMAIN)}`} style={{
                  font: "600 14px system-ui", color: "#9fb0d0", cursor: "pointer",
                  background: "transparent", textDecoration: "none",
                  border: "1px solid rgba(147,197,253,.25)", borderRadius: 10,
                  padding: "9px 16px", display: "inline-block",
                }}>Mit der App verbinden</a>
              )}
              {offerDesktop && (
                <a href={COMPANION_DESKTOP_URL} style={{
                  font: "600 14px system-ui", color: "#04121f", cursor: "pointer",
                  background: "linear-gradient(180deg,#4cc7fa,#1f9fe0)", textDecoration: "none",
                  border: "none", borderRadius: 10, padding: "9px 16px", display: "inline-block",
                }}>{IS_WINDOWS ? "PC-App laden (Windows)" : "PC-App laden (Linux)"}</a>
              )}
              {!IS_IOS && installPromptHolder.event && (() => {
                /* Once a native app is offered as primary, the PWA is the
                   second option — then understated, otherwise the main button. */
                const secondary = IS_ANDROID || offerDesktop;
                return (
                  <button onClick={install} style={{
                    font: "600 14px system-ui", color: secondary ? "#9fb0d0" : "#04121f", cursor: "pointer",
                    background: secondary ? "transparent" : "linear-gradient(180deg,#4cc7fa,#1f9fe0)",
                    border: secondary ? "1px solid rgba(147,197,253,.25)" : "none",
                    borderRadius: 10, padding: "9px 16px",
                  }}>{secondary ? "Web-App installieren" : "App installieren"}</button>
                );
              })()}
              <button onClick={() => setVisible(false)} style={dismissStyle}>Später</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const dismissStyle: CSSProperties = {
  font: "600 13px system-ui", color: "#9fb0d0", cursor: "pointer",
  background: "transparent", border: "1px solid rgba(147,197,253,.25)",
  borderRadius: 10, padding: "9px 14px", marginLeft: 8,
};
