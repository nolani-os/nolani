import { useEffect, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import { initMatrixClient, destroyMatrixClient } from "./matrixClient";
import { LeftRail } from "./components/LeftRail";
import { SpacesTree } from "./components/SpacesTree";
import { ChannelView } from "./components/ChannelView";
import { ChatView } from "./components/ChatView";
import { TeamView } from "./components/TeamView";
import { ActivityView } from "./components/ActivityView";
import { SearchView } from "./components/SearchView";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { NotificationSettings } from "./components/NotificationSettings";
import { MobileLayout } from "./components/MobileLayout";
import { CallsView } from "./components/CallsView";
import { KalenderView } from "./components/KalenderView";
import { DateienView } from "./components/DateienView";
import styles from "./TeamsApp.module.css";
import "./tokens.css";

function useMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return mobile;
}

export default function TeamsApp({ windowId }: { windowId: string }) {
  const isMobile = useMobile();
  const connected = useMatrixStore((s) => s.connected);
  const syncing = useMatrixStore((s) => s.syncing);
  const activeRoomId = useMatrixStore((s) => s.activeRoomId);
  const activeSpaceId = useMatrixStore((s) => s.activeSpaceId);
  const railView = useMatrixStore((s) => s.railView);
  const spaces = useMatrixStore((s) => s.spaces);
  const [error, setError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [onboarded, setOnboarded] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setShowSearch((s) => !s); }
      if (e.key === "Escape") { setShowSearch(false); setShowNotifSettings(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    initMatrixClient().then((ok) => {
      if (!ok) setError("Anmeldung bei Matrix fehlgeschlagen. Einzelheiten stehen in der Browser-Konsole.");
    }).catch((err) => setError(String(err)));
    return () => destroyMatrixClient();
  }, []);

  // Detect first-time user (no spaces)
  const isFirstTime = connected && syncing && Object.keys(spaces).length === 0 && !onboarded;

  if (!connected) {
    return (
      <div className={styles.loading} data-teams-app>
        {error ? (
          <>
            <span style={{ color: "var(--danger, #f38ba8)" }}>Verbindungsfehler</span>
            <span style={{ fontSize: 11, maxWidth: 400, textAlign: "center" }}>{error}</span>
          </>
        ) : (
          <>
            <div className={styles.spinner} />
            <span>Verbindung zu Matrix wird aufgebaut…</span>
          </>
        )}
      </div>
    );
  }

  if (isMobile) return <MobileLayout windowId={windowId} />;

  // Does the room belong to a team (channel), or is it a standalone conversation?
  const istKanal = (roomId: string) =>
    Object.values(spaces).some((sp) => sp.childRoomIds.includes(roomId));

  const renderMainContent = () => {
    if (showSearch) return <SearchView />;
    if (showNotifSettings) return <NotificationSettings onClose={() => setShowNotifSettings(false)} />;
    // Warning: the setup wizard used to take over the WHOLE app, including chat,
    // calls and calendar. Users without a team (or who don't want one) could not
    // even reach their chats — and bridged chats arrive without any team.
    // The wizard therefore only belongs in the Teams section.
    if (isFirstTime && railView === "teams") {
      return <OnboardingWizard onComplete={() => setOnboarded(true)} />;
    }

    switch (railView) {
      case "activity":
        return <ActivityView />;
      case "calendar":
        // Formerly an iframe of the Nextcloud calendar UI; now the native
        // ClaraOS view on the same CalDAV data.
        return <KalenderView />;
      case "files":
        // Formerly the Nextcloud files UI in an iframe.
        return <DateienView />;
      case "calls":
        return <CallsView />;
      // Important: chat and teams do NOT open the same view. Otherwise a
      // one-to-one chat ends up in `ChannelView` — with "#", member count and
      // the whole team tab bar. The two are deliberately separate.
      case "chat":
        // Important: `activeRoomId` is ONE selection shared by both sections.
        // Without this check the chat section kept showing the team channel last
        // clicked in the Teams section, and vice versa. Each section therefore
        // only shows what belongs to it.
        if (activeRoomId && !istKanal(activeRoomId)) return <ChatView roomId={activeRoomId} />;
        return (
          <div className={styles.emptyState}>
            <h2>Chat</h2>
            <p>Wähle links ein Gespräch — oder starte ein neues.</p>
            <p className={styles.hint}>
              Hier stehen Gespräche mit Personen und Gruppen. Team-Kanäle findest du unter „Teams".
            </p>
          </div>
        );
      case "teams":
      default:
        // Channel selected → conversation. Only the team selected → the team's
        // shared content (files, calendar, plan).
        if (activeRoomId && istKanal(activeRoomId)) return <ChannelView roomId={activeRoomId} />;
        if (activeSpaceId) return <TeamView spaceId={activeSpaceId} windowId={windowId} />;
        return (
          <div className={styles.emptyState}>
            <h2>Willkommen bei Teams</h2>
            <p>Wähle links ein Team oder einen Kanal.</p>
            <p className={styles.hint}>Neues Team über den +-Knopf in der Seitenleiste.</p>
          </div>
        );
    }
  };

  // The sidebar stays visible in the chat section even without a team — it is
  // the only way to reach "New message" there.
  const showSidebar = !showSearch
    && (railView === "chat" || (railView === "teams" && !isFirstTime));

  return (
    <div
      className={styles.container}
      data-teams-app
      style={{
        gridTemplateColumns: showSidebar ? "48px 240px 1fr" : "48px 1fr",
      }}
    >
      <LeftRail onSearchToggle={() => setShowSearch((s) => !s)} searchActive={showSearch} />
      {showSidebar && <SpacesTree />}
      {renderMainContent()}
    </div>
  );
}
