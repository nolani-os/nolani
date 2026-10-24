// Session guard: MUST remain the FIRST import — it wraps window.fetch before
// any other module (stores!) can issue requests. Silently heals expired SSO
// sessions instead of showing "Failed to fetch".
import "./sessionGuard";
import { StrictMode, useEffect, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import {
  useWindowsStore, useUIStore, useWrappStore, useWorkspaceStore,
  useAppRegistryStore, useMatrixStore, useAuthStore,
  useFileStore, useIframeAppStore, useClaraChatSettings, useMarkerStore,
  useSettingsStore,
  useClipboardStore,
  useDeviceStore,
  loadFormatPrefs,
} from "@claraos/core";
import { installMarkerBridge } from "./Marker/markerBridge";
import { Shell } from "./Shell";
import { MobileShell } from "./Mobile/MobileShell";
import { FeedbackDialogHost } from "./components/FeedbackDialog";
import { useIsMobile } from "./Mobile/useIsMobile";
import { SkinManager } from "./SkinManager";
import { AppearanceManager } from "./AppearanceManager";
import { OnboardingInstallPrompt, captureInstallPrompt } from "./OnboardingInstallPrompt";
import { installFullscreenHotkey, installFullscreenRestore } from "./fullscreen";
import { installVersionWatch } from "./versionWatch";
import { heimBoot } from "./extensions";
import { startI18n } from "./i18n";
import "./tokens.css";
import "./global.css";

// Setup assistant: capture beforeinstallprompt BEFORE the React mount — the
// browser fires it exactly once, often before components mount.
captureInstallPrompt();

// Fullscreen: F11/Ctrl+Shift+F everywhere, and after a reload re-enter
// fullscreen on the first click (the browser requires a user gesture).
installFullscreenHotkey();
installFullscreenRestore();

// Version watch: the companion WebView only loads the page on a cold start —
// every deployment stayed invisible on the phone until the app was
// force-stopped (a device could go days without requesting `index.html`).
// From here on the shell notices by itself. It NEVER reloads unprompted if
// something could be lost — in that case it asks.
installVersionWatch();

// Public page of this installation (optional
// public/PublicPage.heim.tsx): anything under /share/* renders it instead of the Shell,
// with no sign-in (the reverse proxy lets those paths through).
const publicPages = import.meta.glob<{ default: ComponentType }>(
  "./public/PublicPage.heim.tsx", { eager: true },
);
const PublicPage = Object.values(publicPages)[0]?.default;
const IS_PUBLIC_SHARE = !!PublicPage && window.location.pathname.startsWith("/share/");

// Expose stores for E2E testing
declare global {
  interface Window {
    __claraos?: {
      windows: typeof useWindowsStore;
      ui: typeof useUIStore;
    };
  }
}
window.__claraos = {
  windows: useWindowsStore,
  ui: useUIStore,
  workspaces: useWorkspaceStore,
  appRegistry: useAppRegistryStore,
  matrix: useMatrixStore,
  ...heimBoot?.heimDebugStores,
  // Exposed for the Playwright E2E suite
  wrapp: useWrappStore,
  files: useFileStore,
  iframeApps: useIframeAppStore,
  claraChatSettings: useClaraChatSettings,
  marker: useMarkerStore,
  // The E2E suite uses this to verify that settings toggles really take effect
  settings: useSettingsStore,
  clipboard: useClipboardStore,
  // The quick settings E2E test (tray_quick_settings_e2e) checks capability
  // gating, debounce and echo suppression via this store
  device: useDeviceStore,
} as never;

// Skip all auth-dependent side effects when serving the
// public Customer-View. Otherwise loadApps()/Authentik calls 401-redirect
// and the React tree never mounts.
if (!IS_PUBLIC_SHARE) {
  // Start-up hooks of this installation's own features (none in the product).
  heimBoot?.startHeim?.();

  // Marker bridge: wires 📍 ChatPanel ↔ drivers in iframe apps.
  installMarkerBridge();

  // Load app registry from API (before React renders)
  useAppRegistryStore.getState().loadApps();

  // Web Share Target: sharing a product from a retailer app into ClaraOS →
  // the manifest delivers st_url/st_text as query params. Android often puts
  // the URL into `text` instead of `url` → check both. Handed to the shopping
  // app via sessionStorage (does not survive the auth redirect — it does not
  // need to: Authentik returns the query params on redirect).
  {
    const params = new URLSearchParams(window.location.search);
    const rawShare = params.get("st_url") || params.get("st_text") || "";
    const urlMatch = rawShare.match(/https?:\/\/\S+/);
    if (urlMatch) {
      sessionStorage.setItem("claraos.shopping.shareUrl", urlMatch[0]);
      ["st_url", "st_text", "st_title"].forEach((p) => params.delete(p));
      const rest = params.toString();
      window.history.replaceState(null, "", rest ? `/?${rest}` : "/");
      useWindowsStore.getState().openWindow("shopping", { title: "Shopping" });
    }
  }
}

function App() {
  const isMobile = useIsMobile();
  // The auth store must be loaded here at the root, not only from the start
  // menu — mobile has no start menu. Otherwise `user` stays empty on phones,
  // every app treats the user as a stranger (`isOwner === false`) and the whole
  // UI falls into read-only mode: no editing, no filters, no creating.
  useEffect(() => {
    if (!useAuthStore.getState().user) {
      useAuthStore.getState().loadUser().catch(() => undefined);
    }
  }, []);
  return (
    <>
      {isMobile ? <MobileShell /> : <Shell />}
      {/* global (desktop+mobile): opens on "claraos-open-feedback" */}
      <FeedbackDialogHost />
    </>
  );
}

// Render only once the region/language settings and the start catalogs are
// in: dates are formatted at render time (regionLocale() is not reactive) and
// the first frame should already be in the user's language. Neither may block
// the shell — a slow or failing settings API falls back after 1.5 s, a public
// share page has no settings at all.
const settingsReady = IS_PUBLIC_SHARE
  ? Promise.resolve()
  : Promise.race([
      loadFormatPrefs().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
void settingsReady
  .then(() => startI18n(useSettingsStore.getState().values["region-formats"]?.uiLanguage))
  .catch(() => undefined)
  .finally(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {IS_PUBLIC_SHARE && PublicPage ? (
      <PublicPage />
    ) : (
      <>
        <SkinManager />
        {/* after SkinManager: layers the user overrides over the skin tokens */}
        <AppearanceManager />
        <App />
        <OnboardingInstallPrompt />
      </>
    )}
  </StrictMode>,
));
