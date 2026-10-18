/**
 * StartMenu — two-state panel.
 *
 *   mode="launcher"  (default)  compact launcher: ONE universal input
 *       (instant local app search + named Clara escalation via Tab),
 *       inline quick answers, pinned grid, continue-section, footer.
 *   mode="chat"      the panel grows in place to the full Clara chat
 *       (ClaraChatPanel variant="sidebar" incl. folder tree). The running
 *       conversation and any draft text carry over losslessly.
 *
 * Research-backed layout (Win11 25H2 / Raycast / Copilot patterns):
 * search is deterministic and instant, AI is an explicit escalation —
 * never guessed. Esc collapses chat → launcher, second Esc closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  useUIStore,
  useWindowsStore,
  useAppCenterStore,
  useAppRegistryStore,
  useAuthStore,
  useSettingsStore,
  type AppManifest,
} from "@claraos/core";
import { AppIcon } from "../components/AppIcon";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import { ClaraChatPanel } from "../Chat";
import { COMPANION_PLATFORM } from "../OnboardingInstallPrompt";
import { MessageList } from "../Chat/MessageList";
import { useClaraChat } from "../Chat/useClaraChat";
import { OPEN_CLARA_CHAT_EVENT } from "../useBootDeepLink";
import { MicIcon, StopIcon, SendIcon } from "../Chat/icons";
import styles from "./StartMenu.module.css";

type Mode = "launcher" | "chat";

const RECENTS_KEY = "claraos-recent-apps";
const MAX_RESULTS = 8;

/** Preferred category order — daily-use first, technical last. */
const CATEGORY_ORDER = [
  "productivity",
  "media",
  "games",
  "services",
  "engineering",
  "developer",
  "system",
  "wrapps",
  "other",
];

const CATEGORY_LABELS: Record<string, string> = {
  system: "System",
  productivity: "Produktivität",
  engineering: "Engineering",
  developer: "Entwicklung",
  media: "Medien",
  services: "Dienste",
  games: "Spiele",
  wrapps: "Wrapps",
  other: "Sonstige",
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
}

/** Does the shell keep "recently used"? Settings -> History. */
function recentsEnabled(): boolean {
  const v = useSettingsStore.getState().values["privacy-history"]?.recentAppsEnabled;
  return v === undefined ? true : Boolean(v);
}

function readRecents(): string[] {
  if (!recentsEnabled()) return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function pushRecent(appId: string): string[] {
  if (!recentsEnabled()) {
    // Turned off means: record nothing AND remove existing entries —
    // otherwise yesterday's list reappears when it is switched back on.
    try {
      localStorage.removeItem(RECENTS_KEY);
    } catch {
      /* don't care */
    }
    return [];
  }
  const next = [appId, ...readRecents().filter((id) => id !== appId)].slice(0, 8);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* quota — non-fatal */
  }
  return next;
}

export function StartMenu() {
  const startMenuOpen = useUIStore((s) => s.startMenuOpen);
  const closeStartMenu = useUIStore((s) => s.closeStartMenu);
  const openWindow = useWindowsStore((s) => s.openWindow);
  const pinnedAppIds = useAppCenterStore((s) => s.pinnedAppIds);
  const apps = useAppRegistryStore((s) => s.apps);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  // The auth store is lazy — nothing else on the desktop loads /me, so the
  // footer would show "?" forever without this.
  useEffect(() => {
    if (!user) useAuthStore.getState().loadUser().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [mode, setMode] = useState<Mode>("launcher");
  const [query, setQuery] = useState("");
  const [claraMode, setClaraMode] = useState(false);
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [chatSeed, setChatSeed] = useState<{ chatId?: string; text?: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Launcher quick-chat — lives at StartMenu level so answers survive the
  // launcher⇄results zone switches. Quick chats land in ⚡ Quick Chats.
  const chat = useClaraChat({ surface: "quick" });
  const conversationActive = claraMode && (chat.messages.length > 0 || chat.streaming);

  // ── reset to a fresh launcher whenever the menu closes ──
  useEffect(() => {
    if (!startMenuOpen) {
      setMode("launcher");
      setQuery("");
      setClaraMode(false);
      setAllAppsOpen(false);
      setChatSeed(null);
    }
  }, [startMenuOpen]);

  // Refresh recents + chat list on every open (localStorage / other surfaces
  // may have changed while the menu was closed).
  useEffect(() => {
    if (startMenuOpen) {
      setRecents(readRecents());
      chat.refresh().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMenuOpen]);

  // ── Deep link ?chat=1 / ?chat=<id> and job notifications -> open menu in chat mode ──
  // With a chat id the panel loads that chat (chatSeed keys a fresh panel).
  useEffect(() => {
    const handler = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId?: unknown }>).detail?.chatId;
      if (!useUIStore.getState().startMenuOpen) useUIStore.getState().toggleStartMenu();
      if (typeof chatId === "string" && chatId) setChatSeed({ chatId });
      setMode("chat");
    };
    window.addEventListener(OPEN_CLARA_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CLARA_CHAT_EVENT, handler);
  }, []);

  // ── Escape: chat → launcher, launcher → close ──
  useEffect(() => {
    if (!startMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open context menu (PopupMenu/Radix) owns this Escape — it closes
      // itself; without this guard the start menu would close along with it.
      if (document.querySelector("[data-popup-menu], [data-radix-popper-content-wrapper]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "chat") setMode("launcher");
      else closeStartMenu();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [startMenuOpen, mode, closeStartMenu]);

  // ── focus the universal input when the launcher shows ──
  useEffect(() => {
    if (startMenuOpen && mode === "launcher") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [startMenuOpen, mode]);

  // Type-to-search: if focus strayed (e.g. after clicking a section), a
  // printable key refocuses the universal input and appends the char.
  useEffect(() => {
    if (!startMenuOpen || mode !== "launcher") return;
    const handler = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.length !== 1) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }
      if (!/^[\wÀ-ſ]$/i.test(e.key)) return;
      e.preventDefault();
      setQuery((s) => s + e.key);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [startMenuOpen, mode]);

  const handleLaunch = useCallback(
    (app: AppManifest) => {
      setRecents(pushRecent(app.id));
      closeStartMenu();
      openWindow(app.id, {
        title: app.name,
        icon: app.icon,
        width: app.window.defaultWidth,
        height: app.window.defaultHeight,
        maximized: app.window.startMaximized,
        fullscreen: app.window.startFullscreen,
      });
    },
    [openWindow, closeStartMenu],
  );

  // Right-click menu for every app tile / search result.
  const appTileMenu = useCallback(
    (app: AppManifest): ContextMenuItem[] => {
      const pinned = pinnedAppIds.includes(app.id);
      return [
        { id: "open", label: "Öffnen", onSelect: () => handleLaunch(app) },
        {
          id: "pin",
          label: pinned ? "Von „Angepinnt“ lösen" : "Anpinnen (Start + Taskbar)",
          onSelect: () => {
            const store = useAppCenterStore.getState();
            if (pinned) store.unpinApp(app.id);
            else store.pinApp(app.id);
          },
        },
        { id: "sep", label: "---" },
        {
          id: "appcenter",
          label: "Im App-Center anzeigen",
          onSelect: () => {
            closeStartMenu();
            openWindow("app-center", { title: "App-Center", width: 900, height: 640 });
          },
        },
      ];
    },
    [pinnedAppIds, handleLaunch, closeStartMenu, openWindow],
  );

  // ── universal search over the full registry (apps + wrapps) ──
  const activatedApps = useMemo(
    () => Object.values(apps).filter((a) => a.activated !== false),
    [apps],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || claraMode) return [];
    const scored = activatedApps
      .filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q))
      .sort((a, b) => {
        // prefix matches first, then shorter names
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.name.length - b.name.length;
      });
    return scored.slice(0, MAX_RESULTS);
  }, [activatedApps, query, claraMode]);

  const pinnedApps = useMemo(
    () => pinnedAppIds.map((id) => apps[id]).filter(Boolean) as AppManifest[],
    [apps, pinnedAppIds],
  );

  const recentApps = useMemo(
    () =>
      recents
        .map((id) => apps[id])
        .filter((a): a is AppManifest => !!a && a.activated !== false)
        .slice(0, 4),
    [apps, recents],
  );

  // "Continue": prefer this session's quick conversation — WebUI keeps
  // folder chats (⚡ Quick Chats) OUT of the flat chat list, so chatList[0]
  // alone would never surface the launcher's own conversations.
  const continueChat = useMemo(() => {
    if (chat.chatId) {
      const firstUser = chat.messages.find((m) => m.role === "user");
      return {
        id: chat.chatId,
        title: (firstUser?.content ?? "").slice(0, 60) || "Letzter Chat",
      };
    }
    return chat.chatList[0] ?? null;
  }, [chat.chatId, chat.messages, chat.chatList]);

  const categories = useMemo(() => {
    const cats: Record<string, AppManifest[]> = {};
    for (const app of activatedApps) {
      if (app.hubService) continue; // third-party services live in the services hub, not in the grid
      const cat = app.category || "other";
      (cats[cat] ||= []).push(app);
    }
    const order = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c);
      return i === -1 ? CATEGORY_ORDER.length : i;
    };
    return Object.entries(cats).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
  }, [activatedApps]);

  // ── Clara: ask from the launcher input ──
  const askClara = useCallback(() => {
    const text = query.trim();
    if (!text) return;
    setClaraMode(true);
    setQuery("");
    chat.send(text).catch(() => undefined);
  }, [query, chat]);

  const resetClara = useCallback(() => {
    setClaraMode(false);
    chat.startNewChat();
  }, [chat]);

  const expandToChat = useCallback(
    (opts?: { chatId?: string }) => {
      setChatSeed({
        chatId: opts?.chatId ?? chat.chatId ?? undefined,
        text: query.trim() || undefined,
      });
      setQuery("");
      setMode("chat");
    },
    [chat.chatId, query],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab" && !e.shiftKey && query.trim() && !claraMode) {
        // Named escalation: Tab hands the typed query to Clara.
        e.preventDefault();
        setClaraMode(true);
        return;
      }
      if (e.key === "Backspace" && claraMode && !query) {
        setClaraMode(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (claraMode || conversationActive) {
          askClara();
        } else if (results.length > 0) {
          handleLaunch(results[0]);
        } else if (query.trim()) {
          // no local hit → the visible escalation row says ⏎ asks Clara
          setClaraMode(true);
          askClara();
        }
      }
    },
    [query, claraMode, conversationActive, results, askClara, handleLaunch],
  );

  // In clara-mode Enter must send even before state settles — askClara reads
  // the freshest query via closure; keep the textarea single-purpose.
  const recording = chat.voiceState === "recording";

  const showDefaultZones = !conversationActive && results.length === 0 && !(query.trim() && !claraMode);
  const displayName = user?.name?.split(" ")[0] || user?.username || "";

  // Profile picture or initials — from the same storage as in settings, so
  // the start menu and the settings page show the same thing.
  const [avatar, setAvatar] = useState<
    { initials: string; color: string; textColor: string; hasCustom: boolean } | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/claraos/personalization/avatar/fallback");
        if (r.ok && !cancelled) setAvatar(await r.json());
      } catch {
        /* initials from the name are enough as fallback */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      {startMenuOpen && <div className={styles.backdrop} onClick={closeStartMenu} />}

      <AnimatePresence>
        {startMenuOpen && (
          <motion.div
            className={`${styles.panel} ${mode === "chat" ? styles.panelChat : styles.panelLauncher}`}
            data-shell-part="start-menu"
            data-mode={mode}
            initial={{ opacity: 0, y: 30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {mode === "launcher" ? (
              <div className={styles.launcher}>
                {/* ── Universal input ── */}
                <div className={styles.inputCard} data-shell-part="start-input" data-tour="startmenu-input">
                  {claraMode && (
                    <button
                      type="button"
                      className={styles.claraChip}
                      onClick={resetClara}
                      title="Clara-Modus verlassen (Backspace)"
                    >
                      ✦ Clara
                    </button>
                  )}
                  <textarea
                    ref={inputRef}
                    className={styles.input}
                    data-testid="start-input"
                    rows={1}
                    placeholder={
                      conversationActive
                        ? "Antworten …"
                        : claraMode
                          ? "Frag Clara …"
                          : "Frag Clara oder suche Apps …"
                    }
                    value={query}
                    onChange={(e) => setQuery(e.target.value.replace(/\n/g, ""))}
                    onKeyDown={handleInputKeyDown}
                  />
                  <div className={styles.inputActions}>
                    <button
                      type="button"
                      className={`${styles.inputBtn} ${recording ? styles.inputBtnActive : ""}`}
                      title={recording ? "Aufnahme stoppen" : "Clara diktieren"}
                      onClick={() => {
                        setClaraMode(true);
                        if (recording) chat.stopRecording();
                        else chat.startRecording();
                      }}
                    >
                      {recording ? <StopIcon size={15} /> : <MicIcon size={15} />}
                    </button>
                    {chat.streaming ? (
                      <button
                        type="button"
                        className={styles.stopBtn}
                        onClick={chat.abort}
                        title="Stoppen"
                      >
                        <StopIcon size={13} />
                      </button>
                    ) : (claraMode || conversationActive) && query.trim() ? (
                      <button
                        type="button"
                        className={styles.sendBtn}
                        onClick={askClara}
                        title="Senden"
                      >
                        <SendIcon size={15} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.inputBtn}
                      data-testid="start-expand"
                      title="Chat-Vollansicht öffnen"
                      onClick={() => expandToChat()}
                    >
                      ⤢
                    </button>
                  </div>
                </div>

                <div className={styles.launcherScroll}>
                  {/* ── local results + escalation ── */}
                  {query.trim() && !claraMode && (
                    <div className={styles.results}>
                      {results.map((app, i) => (
                        <WindowContextMenu key={app.id} items={appTileMenu(app)}>
                          <button
                            className={styles.resultRow}
                            data-testid="start-result"
                            onClick={() => handleLaunch(app)}
                          >
                            <AppIcon appId={app.id} fallback={app.icon} iconUrl={app.config?.iconUrl} size="taskbar" className={styles.resultIcon} title={app.name} />
                            <span className={styles.resultName}>{app.name}</span>
                            <span className={styles.resultCat}>
                              {app.hubService ? "Dienst" : categoryLabel(app.category || "other")}
                            </span>
                            {i === 0 && <kbd className={styles.kbd}>⏎</kbd>}
                          </button>
                        </WindowContextMenu>
                      ))}
                      <button
                        type="button"
                        className={`${styles.resultRow} ${styles.claraRow}`}
                        data-testid="clara-escalate"
                        onClick={() => { setClaraMode(true); askClara(); }}
                      >
                        <span className={styles.claraRowIcon}>✦</span>
                        <span className={styles.resultName}>
                          „{query.trim().length > 40 ? `${query.trim().slice(0, 37)}…` : query.trim()}“ — Clara fragen
                        </span>
                        <kbd className={styles.kbd}>{results.length > 0 ? "Tab" : "⏎"}</kbd>
                      </button>
                    </div>
                  )}

                  {/* ── inline quick answer ── */}
                  {conversationActive && (
                    <div className={styles.quickAnswer} data-testid="quick-answer">
                      <MessageList messages={chat.messages} streaming={chat.streaming} />
                      <div className={styles.quickAnswerBar}>
                        <button
                          type="button"
                          className={styles.quickAnswerBtn}
                          onClick={() => expandToChat()}
                          disabled={chat.streaming}
                          title={chat.streaming ? "Warte bis Claras Antwort fertig ist …" : undefined}
                        >
                          Im Chat fortsetzen ⤢
                        </button>
                        <button type="button" className={styles.quickAnswerBtnGhost} onClick={resetClara}>
                          Schließen
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── default zones ── */}
                  {showDefaultZones && (
                    <>
                      {pinnedApps.length > 0 && (
                        <section className={styles.section} data-tour="startmenu-pinned">
                          <div className={styles.sectionTitle}>Angepinnt</div>
                          <div className={styles.pinnedGrid}>
                            {pinnedApps.map((app) => (
                              <WindowContextMenu key={app.id} items={appTileMenu(app)}>
                                <button className={styles.appTile} onClick={() => handleLaunch(app)}>
                                  <AppIcon appId={app.id} fallback={app.icon} size="start" className={styles.appTileIcon} title={app.name} />
                                  <span className={styles.appTileName}>{app.name}</span>
                                </button>
                              </WindowContextMenu>
                            ))}
                          </div>
                        </section>
                      )}

                      {(continueChat || recentApps.length > 0) && (
                        <section className={styles.section}>
                          <div className={styles.sectionTitle}>Weiter machen</div>
                          {continueChat && (
                            <button
                              type="button"
                              className={styles.continueChat}
                              data-testid="continue-chat"
                              onClick={() => expandToChat({ chatId: continueChat.id })}
                            >
                              <span className={styles.claraRowIcon}>✦</span>
                              <span className={styles.resultName}>{continueChat.title || "Letzter Chat"}</span>
                              <span className={styles.resultCat}>Clara-Chat</span>
                            </button>
                          )}
                          {recentApps.length > 0 && (
                            <div className={styles.recentRow}>
                              {recentApps.map((app) => (
                                <WindowContextMenu key={app.id} items={appTileMenu(app)}>
                                  <button className={styles.appTileSmall} onClick={() => handleLaunch(app)}>
                                    <AppIcon appId={app.id} fallback={app.icon} iconUrl={app.config?.iconUrl} size="pinned" className={styles.appTileIcon} title={app.name} />
                                    <span className={styles.appTileName}>{app.name}</span>
                                  </button>
                                </WindowContextMenu>
                              ))}
                            </div>
                          )}
                        </section>
                      )}

                      <section className={styles.section}>
                        <button
                          type="button"
                          className={styles.allAppsToggle}
                          data-testid="all-apps-toggle"
                          onClick={() => setAllAppsOpen((v) => !v)}
                        >
                          <span>Alle Apps</span>
                          <span className={styles.allAppsChevron}>{allAppsOpen ? "▾" : "▸"}</span>
                        </button>
                        {allAppsOpen &&
                          categories.map(([cat, catApps]) => (
                            <div key={cat} className={styles.categoryBlock}>
                              <div className={styles.sectionTitle}>{categoryLabel(cat)}</div>
                              <div className={styles.appsGrid}>
                                {catApps.map((app) => (
                                  <WindowContextMenu key={app.id} items={appTileMenu(app)}>
                                    <button className={styles.appTile} onClick={() => handleLaunch(app)}>
                                      <AppIcon appId={app.id} fallback={app.icon} size="start" className={styles.appTileIcon} title={app.name} />
                                      <span className={styles.appTileName}>{app.name}</span>
                                    </button>
                                  </WindowContextMenu>
                                ))}
                              </div>
                            </div>
                          ))}
                      </section>
                    </>
                  )}
                </div>

                {/* ── footer ── */}
                <div className={styles.footer} data-shell-part="start-footer">
                  <div className={styles.footerUser}>
                    {avatar?.hasCustom ? (
                      <img
                        className={styles.avatar}
                        src="/api/claraos/personalization/avatar"
                        alt=""
                      />
                    ) : (
                      <span
                        className={styles.avatar}
                        aria-hidden="true"
                        style={
                          avatar
                            ? { background: avatar.color, color: avatar.textColor }
                            : undefined
                        }
                      >
                        {avatar?.initials ?? (displayName || "?").charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className={styles.footerName}>{displayName}</span>
                  </div>
                  <div className={styles.footerActions}>
                    <button
                      type="button"
                      className={styles.footerBtn}
                      title="Einstellungen"
                      onClick={() => {
                        const app = apps["settings"];
                        if (app) handleLaunch(app);
                      }}
                    >
                      ⚙
                    </button>
                    <button
                      type="button"
                      className={styles.footerBtn}
                      title="Feedback geben"
                      data-testid="start-feedback"
                      onClick={() => {
                        closeStartMenu();
                        window.dispatchEvent(
                          new CustomEvent("claraos-open-feedback", {
                            detail: { source: "startmenu" },
                          }),
                        );
                      }}
                    >
                      💬
                    </button>
                    <button
                      type="button"
                      className={styles.footerBtn}
                      title="Abmelden"
                      data-testid="start-logout"
                      onClick={logout}
                    >
                      ⏻
                    </button>
                    {(COMPANION_PLATFORM === "windows" ||
                      COMPANION_PLATFORM === "linux") && (
                      <button
                        type="button"
                        className={styles.footerBtn}
                        title="Herunterfahren (ClaraOS Companion beenden)"
                        data-testid="start-shutdown"
                        onClick={() => {
                          // The bridge is injected by the desktop Companion
                          // (main.rs BRIDGE_JS); the location fallback applies
                          // if the init script failed to load.
                          const native = (window as unknown as {
                            ClaraOSNative?: { shutdown?: () => void };
                          }).ClaraOSNative;
                          if (native?.shutdown) native.shutdown();
                          else window.location.assign("claraos://companion/shutdown");
                        }}
                      >
                        ⏼
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.chatMode}>
                {/* Fused single header: back + brand (panel's own header is hidden) */}
                <div className={styles.chatHeader}>
                  <button
                    type="button"
                    className={styles.backBtn}
                    data-testid="start-back"
                    onClick={() => setMode("launcher")}
                    title="Zurück zum Startmenü (Esc)"
                  >
                    ‹ Startmenü
                  </button>
                  <span className={styles.chatHeaderBrand}>✦ Clara</span>
                </div>
                <div className={styles.chatBody}>
                  <ClaraChatPanel
                    key={chatSeed?.chatId ?? "fresh"}
                    variant="sidebar"
                    hideHeader
                    initialChatId={chatSeed?.chatId}
                    initialText={chatSeed?.text ? { value: chatSeed.text } : undefined}
                    initialMessages={
                      chatSeed?.chatId && chatSeed.chatId === chat.chatId
                        ? // Freeze copied activity as done — the new panel instance
                          // never receives the remaining stream events.
                          chat.messages.map((m) =>
                            m.activity && m.activity.phase !== "done"
                              ? { ...m, activity: { ...m.activity, phase: "done" as const } }
                              : m,
                          )
                        : undefined
                    }
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
