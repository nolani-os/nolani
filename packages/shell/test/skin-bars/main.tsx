/**
 * Harness for the shell bars: renders the menu bar + dock (two-bar skins) or
 * the taskbar (one-bar skins) with a seeded app registry, pins and open
 * windows — without the API or a login. `?skin=<id>` picks the skin,
 * `?focus=<windowTitle>` focuses a window so the menu bar shows its name.
 */
import { createRoot } from "react-dom/client";
import { useAppRegistryStore, useAppCenterStore, useWindowsStore, useUIStore, type AppManifest } from "@claraos/core";
import { applySkin, resolveSkin } from "@claraos/skins";
import { startI18n } from "../../src/i18n";
import { useSkinLayout } from "../../src/useSkinLayout";
import { MenuBar } from "../../src/MenuBar/MenuBar";
import { Dock } from "../../src/Dock/Dock";
import { Taskbar } from "../../src/Taskbar/Taskbar";
import { AppIcon } from "../../src/components/AppIcon";

const q = new URLSearchParams(location.search);
const skinId = q.get("skin") ?? "orchard-dark";
const skin = resolveSkin(skinId);
if (!skin) throw new Error(`unknown skin ${skinId}`);

const app = (id: string, name: string, icon: string): AppManifest => ({
  id, name, icon, description: name, type: "internal", category: "system", source: "builtin",
  activated: true, showInStartMenu: true, pinned: false,
  window: { defaultWidth: 800, defaultHeight: 600, minWidth: 320, minHeight: 240, resizable: true },
} as unknown as AppManifest);

await startI18n("de");
applySkin(skin);
useUIStore.setState({ skinId: skin.id });
useAppRegistryStore.setState({
  apps: Object.fromEntries([
    app("files", "Dateien", "📁"), app("mail", "Post", "✉️"), app("planner", "Planner", "📅"),
    app("settings", "Einstellungen", "⚙️"), app("browser", "Browser", "🌐"), app("terminal", "Terminal", "⌨️"),
  ].map((a) => [a.id, a])),
  loaded: true,
});
useAppCenterStore.setState({ pinnedAppIds: ["files", "mail", "planner", "settings", "browser"] });
const w = useWindowsStore.getState();
const filesWin = w.openWindow("files", { title: "Dateien", width: 720, height: 440 });
const termWin = w.openWindow("terminal", { title: "Terminal", width: 600, height: 400 });
w.minimizeWindow(termWin);
useWindowsStore.getState().focusWindow(q.get("focus") === "terminal" ? termWin : filesWin);

function Stage() {
  const layout = useSkinLayout();
  return (
    <>
      <div id="wall" data-shell-part="wallpaper" />
      {layout.menuBar && <MenuBar />}
      <div className="desk">
        <div className="win">
          <div className="head">
            <span className="lights"><i style={{ background: "#ff5f57" }} /><i style={{ background: "#febc2e" }} /><i style={{ background: "#28c840" }} /></span>
            <span style={{ flex: 1, textAlign: "center" }}>Dateien</span>
          </div>
          <div className="body">
            <b>Ein Fenster, wie das Skin es zeichnet:</b> Ecken aus <code>--radius-window</code>, Schatten, Kopfzeile und
            Schrift aus den Token.<br /><span className="accent">Akzent</span>
            <div id="icons" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
              {[16, 20, 24, 32].map((px) => (
                <span key={px} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <AppIcon appId="settings" fallback="⚙️" size="taskbar" pixelSize={px} />
                  <AppIcon appId="files" fallback="📁" size="taskbar" pixelSize={px} />
                  <small>{px}</small>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      {layout.menuBar ? <Dock /> : <Taskbar layout={layout} />}
    </>
  );
}

createRoot(document.getElementById("stage")!).render(<Stage />);
