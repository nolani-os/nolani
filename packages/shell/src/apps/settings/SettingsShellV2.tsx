/**
 * Settings shell v2.
 *
 * Modeled on KDE System Settings, but data-driven: categories + modules +
 * fields come as a schema from the server (settings_schema.py); this
 * component knows no concrete keys.
 *
 * Adopted patterns:
 *   - search field in the sidebar header; while typing, the WHOLE sidebar
 *     becomes a flat result list (no overlay dropdown)
 *   - clicking a category opens its owner page or first module — never empty
 *   - apply/discard bar only when there are unsaved changes
 *   - navigation guard: switching modules with changes → apply/discard/cancel
 *   - "highlight changed settings" as a global toggle; badge on the
 *     category, aggregated from /settings/diff
 *
 * Custom modules (component != "") keep rendering the existing tabs
 * unchanged — no loss of functionality compared to settings v1.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useIsMobile } from "../../Mobile/useIsMobile";
import { Button, IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { modulPlaettchen } from "./modulSymbole";
import { useAuthStore } from "@claraos/core";
import { useSettingsStore } from "@claraos/core";
import { SettingRow } from "./SettingRow";
import { AboutTab } from "./AboutTab";
import { PersonalizationTab } from "./PersonalizationTab";
import { CredentialsTab } from "./CredentialsTab";
import { AppConnectionsTab } from "./AppConnectionsTab";
import { FederationTab } from "./FederationTab";
import { MobilePushTab } from "./MobilePushTab";
import { ClaraMemoryTab } from "./ClaraMemoryTab";
import { FreigabenTab } from "./FreigabenTab";
import { AgentKeysTab } from "./AgentKeysTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { QuickSettingsPage, rememberSettingsModule } from "./QuickSettingsPage";
import { DefaultAppsTab } from "./DefaultAppsTab";
import styles from "./SettingsApp.module.css";

const CUSTOM: Record<string, ComponentType> = {
  AboutTab,
  PersonalizationTab,
  CredentialsTab,
  AppConnectionsTab,
  FederationTab,
  MobilePushTab,
  ClaraMemoryTab,
  FreigabenTab,
  AgentKeysTab,
  ShortcutsTab,
  DefaultAppsTab,
};

const HIGHLIGHT_KEY = "claraos-settings-highlight-changed";

export default function SettingsShellV2() {
  const store = useSettingsStore();
  const {
    loaded, categories, modules, changed, error,
    loadSchema, loadModule, loadDiff, connectWs, apply, discard, isDirty,
  } = store;

  const [activeId, setActiveId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(
    () => localStorage.getItem(HIGHLIGHT_KEY) === "1",
  );
  const [guard, setGuard] = useState<{ target: string } | null>(null);
  // Phone: list and detail are TWO views (push/pop as in Android
  // settings), not two stacked columns.
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const Plaettchen = ({ id, cat }: { id: string; cat?: string }) => {
    const p = modulPlaettchen(id, cat);
    return <span className={styles.plaettchen} style={{ background: p.farbe }} aria-hidden="true"><Icon name={p.icon} size={15} /></span>;
  };
  const [detailOffen, setDetailOffen] = useState(false);
  const LISTE = "__liste__";

  useEffect(() => {
    void loadSchema();
    void loadDiff();
    return connectWs();
  }, [loadSchema, loadDiff, connectWs]);

  // The landing page is quick settings — not the first module in the list.
  // A settings app that opens on "App-Zugangsdaten" (app credentials) feels random.
  const QUICK = "__quick__";
  useEffect(() => {
    if (!activeId && modules.length > 0) setActiveId(QUICK);
  }, [modules, activeId]);

  useEffect(() => {
    if (activeId === QUICK) return;
    rememberSettingsModule(activeId);
    const mod = modules.find((m) => m.id === activeId);
    if (mod && !mod.component) void loadModule(activeId);
  }, [activeId, modules, loadModule]);

  // External jump targets (desktop context menu "Personalisieren", deep links)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; module?: string }>).detail;
      const wanted = detail?.module ?? legacyTabToModule(detail?.tab);
      if (wanted && modules.some((m) => m.id === wanted)) navigate(wanted);
    };
    window.addEventListener("claraos-settings-tab", handler);
    return () => window.removeEventListener("claraos-settings-tab", handler);
    // navigate is stable enough (only activeId/guard); the module list as trigger suffices
  }, [modules]); // eslint-disable-line react-hooks/exhaustive-deps

  const gehe = useCallback((target: string) => {
    if (target === LISTE) { setDetailOffen(false); return; }
    setActiveId(target);
    setDetailOffen(true);
  }, []);
  const navigate = useCallback(
    (target: string) => {
      if (target === activeId && (!isMobile || detailOffen)) return;
      if (isDirty(activeId)) {
        setGuard({ target });
        return;
      }
      gehe(target);
    },
    [activeId, isDirty, isMobile, detailOffen, gehe],
  );

  const results = useMemo(() => (query ? store.search(query) : []), [query, store]);
  const searching = query.trim().length > 0;

  const activeModule = modules.find((m) => m.id === activeId);
  const dirty = isDirty(activeId);

  const byCategory = useMemo(() => {
    const map = new Map<string, typeof modules>();
    for (const m of modules) {
      const list = map.get(m.category) ?? [];
      list.push(m);
      map.set(m.category, list);
    }
    return map;
  }, [modules]);

  const categoryChangedCount = useCallback(
    (catId: string) =>
      (byCategory.get(catId) ?? []).reduce((n, m) => n + (changed[m.id]?.length ?? 0), 0),
    [byCategory, changed],
  );

  const toggleHighlight = () => {
    const next = !highlight;
    setHighlight(next);
    localStorage.setItem(HIGHLIGHT_KEY, next ? "1" : "0");
  };

  return (
    <div className={`${styles.settings} ${isMobile ? styles.mobil : ""}`}
         data-ansicht={isMobile ? (detailOffen ? "detail" : "liste") : undefined}>
      <nav className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          {isMobile && <h2 className={styles.mobilTitel}>Einstellungen</h2>}
          {!isMobile && user && (
            <div className={styles.konto}>
              <span className={styles.kontoAvatar} aria-hidden="true">{(user.name || user.username).slice(0, 2).toUpperCase()}</span>
              <span className={styles.kontoText}><b>{user.name || user.username}</b><span>{user.role === "admin" ? "Admin" : user.role === "power-user" ? "Power-User" : user.role === "guest" ? "Gast" : "Nutzer"} · {user.email}</span></span>
            </div>
          )}
          <input
            className={styles.searchField}
            type="search"
            placeholder="Einstellungen durchsuchen…"
            aria-label="Einstellungen durchsuchen"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus={!isMobile}
          />
        </div>

        <div className={styles.sidebarNav} data-searching={searching ? "1" : "0"}>
          {!searching && (
            <button
              className={`${styles.navItem} ${activeId === QUICK ? styles.navActive : ""}`}
              onClick={() => navigate(QUICK)}
            >
              {!isMobile && <Plaettchen id={QUICK} />}
              <span>Schnelleinstellungen</span>
              {isMobile && <Icon name="chevronRight" size={18} className={styles.navPfeil} />}
            </button>
          )}
          {searching ? (
            results.length === 0 ? (
              <p className={styles.emptyHint}>Nichts gefunden.</p>
            ) : (
              results.map((m) => (
                <button
                  key={m.id}
                  className={`${styles.navItem} ${activeId === m.id ? styles.navActive : ""}`}
                  onClick={() => navigate(m.id)}
                >
                  <span>{m.name}</span>
                  <span className={styles.navHint}>
                    {categories.find((c) => c.id === m.category)?.name}
                  </span>
                </button>
              ))
            )
          ) : (
            categories.map((cat) => {
              const mods = byCategory.get(cat.id) ?? [];
              if (mods.length === 0) return null;
              const count = categoryChangedCount(cat.id);
              return (
                <div key={cat.id} className={styles.navGroup}>
                  <div className={styles.navGroupTitle}>
                    {cat.name}
                    {highlight && count > 0 && (
                      <span className={styles.badge} title={`${count} geändert`}>
                        {count}
                      </span>
                    )}
                  </div>
                  {mods.map((m) => (
                    <button
                      key={m.id}
                      className={`${styles.navItem} ${activeId === m.id ? styles.navActive : ""}`}
                      onClick={() => navigate(m.id)}
                    >
                      {!isMobile && <Plaettchen id={m.id} cat={m.category} />}
                      <span>{m.name}</span>
                      {highlight && (changed[m.id]?.length ?? 0) > 0 && (
                        <span className={styles.dot} aria-hidden />
                      )}
                      {isMobile && <Icon name="chevronRight" size={18} className={styles.navPfeil} />}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>

        <div className={styles.sidebarFooter}>
          <label className={styles.highlightToggle}>
            <input type="checkbox" checked={highlight} onChange={toggleHighlight} />
            Geänderte hervorheben
          </label>
        </div>
      </nav>

      <main className={styles.content}>
        {error && <div className={styles.inlineError}>{error}</div>}

        {!loaded && <p className={styles.emptyHint}>Einstellungen werden geladen…</p>}

        {loaded && modules.length === 0 && !error && (
          <p className={styles.emptyHint}>
            Für dieses Konto sind keine Einstellungen freigegeben. Bitte an die
            Administration wenden.
          </p>
        )}

        {loaded && activeId === QUICK && (
          <>
            <header className={styles.contentHeader}>
              {isMobile && <IconButton label="Zurück zur Liste" icon="back" onClick={() => navigate(LISTE)} />}
              <h2>Schnelleinstellungen</h2>
            </header>
            <QuickSettingsPage onOpen={(id) => navigate(id)} />
          </>
        )}

        {loaded && activeModule && (
          <>
            <header className={styles.contentHeader}>
              {isMobile && <IconButton label="Zurück zur Liste" icon="back" onClick={() => navigate(LISTE)} />}
              <h2>{activeModule.name}</h2>
            </header>

            {activeModule.component ? (
              renderCustom(activeModule.component)
            ) : (
              <div className={styles.form}>
                {activeModule.settings.map((s) => (
                  <SettingRow
                    key={s.key}
                    moduleId={activeModule.id}
                    settingKey={s.key}
                    highlightChanged={highlight}
                  />
                ))}
              </div>
            )}

            {dirty && (
              <div className={styles.applyBar} role="status">
                <span>Ungespeicherte Änderungen</span>
                <Button stufe="text" groesse="s" className={styles.applyErster} onClick={() => discard(activeId)}>Verwerfen</Button>
                <Button stufe="filled" groesse="s" onClick={() => void apply(activeId)}>
                  Übernehmen
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {guard && (
        <div className={styles.guardOverlay} role="dialog" aria-modal="true">
          <div className={styles.guardBox}>
            <p>Es gibt ungespeicherte Änderungen. Was soll damit passieren?</p>
            <div className={styles.guardActions}>
              <Button stufe="text" groesse="s" onClick={() => setGuard(null)}>Abbrechen</Button>
              <Button
                stufe="outlined" groesse="s"
                onClick={() => {
                  discard(activeId);
                  gehe(guard.target);
                  setGuard(null);
                }}
              >
                Verwerfen
              </Button>
              <Button
                stufe="filled" groesse="s"
                onClick={async () => {
                  const ok = await apply(activeId);
                  if (ok) gehe(guard.target);
                  setGuard(null);
                }}
              >
                Übernehmen
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCustom(component: string) {
  const C = CUSTOM[component];
  return C ? <C /> : <p className={styles.emptyHint}>Unbekanntes Modul: {component}</p>;
}

/** Keep serving old tab ids from existing callers. */
function legacyTabToModule(tab?: string): string | undefined {
  const map: Record<string, string> = {
    about: "about",
    personalization: "personalization",
    credentials: "credentials",
    connections: "app-connections",
    mobilepush: "mobile-push",
    federation: "federation",
  };
  return tab ? map[tab] : undefined;
}
