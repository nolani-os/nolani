import { useEffect, useState } from "react";
import { AboutTab } from "./AboutTab";
import { PersonalizationTab } from "./PersonalizationTab";
import { CredentialsTab } from "./CredentialsTab";
import { AppConnectionsTab } from "./AppConnectionsTab";
import { FederationTab } from "./FederationTab";
import { MobilePushTab } from "./MobilePushTab";
import SettingsShellV2 from "./SettingsShellV2";
import styles from "./SettingsApp.module.css";

// "Apps" (redirect only) and "System" (placeholder) removed on purpose — a
// real System tab may come later; dead tabs pretend functionality.
const TABS = [
  { id: "about", label: "About", icon: "ℹ️" },
  { id: "personalization", label: "Personalization", icon: "🎨" },
  { id: "credentials", label: "Zugangsdaten", icon: "🔑" },
  { id: "connections", label: "App-Verbindungen", icon: "🔌" },
  { id: "mobilepush", label: "Handy-Push", icon: "📲" },
  { id: "federation", label: "Federation", icon: "🔗" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Rollout switch: the default is the schema-driven shell v2. Rollback
 * without a deploy, per device:
 *     localStorage.setItem("claraos-settings-v1", "1")
 * v1 remains fully intact underneath until acceptance is complete.
 */
export default function SettingsApp({ windowId: _windowId }: { windowId: string }) {
  if (localStorage.getItem("claraos-settings-v1") !== "1") {
    return <SettingsShellV2 />;
  }
  return <SettingsAppV1 />;
}

function SettingsAppV1() {
  const [activeTab, setActiveTab] = useState<TabId>("about");

  // External entry points (e.g. Desktop "Personalize" right-click) request a tab
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab: TabId }>).detail?.tab;
      if (tab && TABS.some((t) => t.id === tab)) setActiveTab(tab);
    };
    window.addEventListener("claraos-settings-tab", handler);
    return () => window.removeEventListener("claraos-settings-tab", handler);
  }, []);

  return (
    <div className={styles.settings}>
      <nav className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarIcon}>⚙️</span>
          <span className={styles.sidebarTitle}>Einstellungen</span>
        </div>
        <div className={styles.sidebarNav}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.navItem} ${activeTab === tab.id ? styles.navActive : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={styles.navIcon}>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <main className={styles.content}>
        {activeTab === "about" && <AboutTab />}
        {activeTab === "personalization" && <PersonalizationTab />}
        {activeTab === "credentials" && <CredentialsTab />}
        {activeTab === "connections" && <AppConnectionsTab />}
        {activeTab === "mobilepush" && <MobilePushTab />}
        {activeTab === "federation" && <FederationTab />}
      </main>
    </div>
  );
}
