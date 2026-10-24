import { Suspense, useMemo } from "react";
import { useWindowsStore, useWorkspaceStore, useTranslation, Trans } from "@claraos/core";
import { Window } from "./Window";
import { appComponents, getAppManifest } from "../apps/registry";
import { IframeApp } from "../apps/IframeApp";
import { SelkiesApp } from "../apps/SelkiesApp";

export function WindowsView() {
  const windows = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const focusedWindowId = useWindowsStore((s) => s.focusedWindowId);

  const activeWs = useWorkspaceStore((s) => s.activeId);

  // Keep ALL windows in DOM (including minimized) to preserve iframe state.
  // Minimized windows are hidden via CSS display:none in Window.tsx.
  const sortedWindows = useMemo(
    () =>
      windowOrder
        .map((id) => windows[id])
        .filter((w): w is NonNullable<typeof w> =>
          w != null &&
          (w.workspaceId === activeWs || (!w.workspaceId && activeWs === "ws-default"))),
    [windows, windowOrder, activeWs],
  );

  return (
    <>
      {sortedWindows.map((win, index) => {
        const InternalApp = appComponents[win.appId];
        const manifest = getAppManifest(win.appId);

        return (
          <Window
            key={win.id}
            window={win}
            zIndex={win.minimized ? -1 : index + 10}
            isFocused={win.id === focusedWindowId}
          >
            {InternalApp ? (
              <Suspense fallback={<LoadingFallback />}>
                <InternalApp windowId={win.id} />
              </Suspense>
            ) : manifest?.type === "selkies" ? (
              <SelkiesApp windowId={win.id} appId={win.appId} targetUrl={manifest.config?.url} title={manifest.name} />
            ) : manifest?.type === "iframe" && (manifest.config?.url) ? (
              <IframeApp
                windowId={win.id}
                appId={win.appId}
                url={manifest.config.url}
                title={manifest.name}
                forceFreshAuth={manifest.config?.forceFreshAuth === true}
              />
            ) : (
              <DefaultContent appId={win.appId} title={win.title} />
            )}
          </Window>
        );
      })}
    </>
  );
}

function LoadingFallback() {
  const { t } = useTranslation("shell");
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-disabled)" }}>
      {t("window.loading")}
    </div>
  );
}

function DefaultContent({ appId, title }: { appId: string; title: string }) {
  return (
    <div style={{ padding: "var(--gap-lg)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: "var(--font-size-lg)" }}>{title}</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
        <Trans
          ns="shell"
          i18nKey="window.noComponent"
          values={{ appId }}
          components={{
            code: <code style={{ fontFamily: "var(--font-mono)", background: "var(--bg-subtle)", padding: "2px 6px", borderRadius: "4px" }} />,
          }}
        />
      </p>
    </div>
  );
}
