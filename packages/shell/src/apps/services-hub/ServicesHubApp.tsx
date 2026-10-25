/**
 * Services hub 🧩 — portal for external third-party services (MyApps pattern).
 *
 * Grid: the data source is the appregistry store (GET /apps already applies the
 * group gate, overrides and rewrites correctly — no second source of truth).
 * A click opens the service through the normal window dispatch (type "selkies"
 * → SelkiesApp → CDP auto-navigation in the Clara browser).
 *
 * Admin tabs (manage / vault reconciliation) talk to /api/claraos/hub — the
 * backend is the source of truth: if the probe returns 403, the tabs do not exist.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppCenterStore, useAppRegistryStore, useWindowsStore, useTranslation, type AppManifest } from "@claraos/core";
import { AppIcon } from "../../components/AppIcon";
import { WindowContextMenu, type ContextMenuItem } from "../../components/WindowContextMenu";
import * as api from "./api";
import { HubApiError } from "./api";
import type { HubServiceInput, HubServiceRow, VaultItemMeta, VaultStatus } from "./types";
import styles from "./ServicesHubApp.module.css";
import { CredentialAccounts } from "../../components/CredentialAccounts";

type Tab = "grid" | "manage" | "vault";

const GROUP_SUGGESTIONS = ["clara-admins", "team-family"];

function baseHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// ── Service tile ─────────────────────────────────────────────────────────────

function ServiceTile({ app, onOpen, onZugang }: {
  app: AppManifest;
  onOpen: (app: AppManifest) => void;
  /** only set when the service declares its own credential fields. */
  onZugang?: (app: AppManifest) => void;
}) {
  const { t } = useTranslation("servicesHub");
  const pinnedAppIds = useAppCenterStore((s) => s.pinnedAppIds);
  const pinned = pinnedAppIds.includes(app.id);
  const menu: ContextMenuItem[] = [
    { id: "open", label: t("tile.open"), onSelect: () => onOpen(app) },
    {
      id: "pin",
      label: pinned ? t("tile.unpin") : t("tile.pin"),
      onSelect: () => {
        const store = useAppCenterStore.getState();
        if (pinned) store.unpinApp(app.id);
        else store.pinApp(app.id);
      },
    },
  ];
  // Third-party services with their own API access (e.g. Notion) need a
  // place for their token. The app center hides hub services — so it lives here.
  if (onZugang) {
    menu.push({
      id: "zugang",
      label: t("tile.credentials"),
      onSelect: () => onZugang(app),
    });
  }
  return (
    <WindowContextMenu items={menu}>
      <button className={styles.tile} data-testid="hub-service" onClick={() => onOpen(app)}>
        <AppIcon
          appId={app.id}
          fallback={app.icon}
          iconUrl={app.config?.iconUrl}
          size="start"
          forceLogos
          className={styles.tileIcon}
          title={app.name}
        />
        <span className={styles.tileName}>{app.name}</span>
        <span className={styles.tileHost}>{baseHost(app.config?.url || "")}</span>
        {app.config?.vaultItemId && (
          <span className={styles.tileBadge} title={t("tile.vaultBadge")}>🔑</span>
        )}
      </button>
    </WindowContextMenu>
  );
}

// ── Admin: form ──────────────────────────────────────────────────────────────

interface FormState extends HubServiceInput {
  editingId?: string; // set = PUT instead of POST
}

const EMPTY_FORM: FormState = { name: "", url: "", icon: "🌐", requiredGroups: ["clara-admins"] };

function ServiceForm({
  form,
  vaultItems,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: FormState;
  vaultItems: VaultItemMeta[];
  busy: boolean;
  onChange: (f: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("servicesHub");
  return (
    <form
      className={styles.form}
      data-testid="hub-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className={styles.formTitle}>
        {form.editingId ? t("form.editTitle", { id: form.editingId }) : t("form.newTitle")}
      </div>
      <label className={styles.field}>
        <span>{t("form.name")}</span>
        <input
          value={form.name}
          required
          placeholder={t("form.namePlaceholder")}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>{t("form.url")}</span>
        <input
          value={form.url}
          required
          type="url"
          placeholder="https://…"
          onChange={(e) => onChange({ ...form, url: e.target.value })}
        />
      </label>
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span>{t("form.emoji")}</span>
          <input
            value={form.icon || ""}
            maxLength={4}
            onChange={(e) => onChange({ ...form, icon: e.target.value })}
          />
        </label>
        <label className={`${styles.field} ${styles.fieldGrow}`}>
          <span>{t("form.iconUrl")}</span>
          <input
            value={form.iconUrl || ""}
            placeholder="https://…/logo.svg"
            onChange={(e) => onChange({ ...form, iconUrl: e.target.value || undefined })}
          />
        </label>
      </div>
      {/* A choice instead of free text: a typo here silently created a tile
          that NOBODY sees — the mistake only surfaced when someone looked for it.
          Other groups from existing tiles are offered too, so that switching over
          does not silently discard an existing setting. */}
      <fieldset className={styles.field} data-testid="hub-form-groups">
        <legend>{t("form.groups")}</legend>
        {Array.from(new Set([...GROUP_SUGGESTIONS, ...(form.requiredGroups || [])])).map(
          (gruppe) => {
            const aktiv = (form.requiredGroups || []).includes(gruppe);
            return (
              <label key={gruppe} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={aktiv}
                  onChange={() =>
                    onChange({
                      ...form,
                      requiredGroups: aktiv
                        ? (form.requiredGroups || []).filter((g) => g !== gruppe)
                        : [...(form.requiredGroups || []), gruppe],
                    })
                  }
                />
                <span>{gruppe}</span>
              </label>
            );
          },
        )}
      </fieldset>
      <label className={styles.field}>
        <span>{t("form.vaultItem")}</span>
        <select
          value={form.vaultItemId || ""}
          onChange={(e) => onChange({ ...form, vaultItemId: e.target.value || undefined })}
        >
          <option value="">{t("form.noVaultItem")}</option>
          {vaultItems.map((it) => (
            <option key={it.id} value={it.id}>
              {it.name}{it.username ? ` (${it.username})` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.formActions}>
        <button type="submit" className={styles.primaryBtn} disabled={busy}>
          {form.editingId ? t("form.save") : t("form.create")}
        </button>
        {form.editingId && (
          <button type="button" className={styles.ghostBtn} onClick={onCancel}>
            {t("form.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ServicesHubApp({ windowId: _windowId }: { windowId: string }) {
  const { t } = useTranslation("servicesHub");
  const apps = useAppRegistryStore((s) => s.apps);
  const reloadApps = useAppRegistryStore((s) => s.reloadApps);
  const openWindow = useWindowsStore((s) => s.openWindow);

  const [tab, setTab] = useState<Tab>("grid");
  const [query, setQuery] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<HubServiceRow[]>([]);
  const [vaultItems, setVaultItems] = useState<VaultItemMeta[]>([]);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Service whose personal credentials are currently being edited.
  const [zugangFuer, setZugangFuer] = useState<AppManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Compact layout: ResizeObserver instead of a container query.
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const services = useMemo(
    () =>
      Object.values(apps)
        .filter((a) => a.hubService && a.activated !== false)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [apps],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return services;
    return services.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        baseHost(a.config?.url || "").includes(q),
    );
  }, [services, query]);

  const refreshAdmin = useCallback(async () => {
    try {
      setRows(await api.listServices());
      setIsAdmin(true);
    } catch (e) {
      if (e instanceof HubApiError && (e.status === 403 || e.status === 401)) setIsAdmin(false);
      else setError((e as Error).message);
    }
  }, []);

  // Admin probe once on open; vault items only when switching to "Verwalten" (manage).
  useEffect(() => {
    void refreshAdmin();
  }, [refreshAdmin]);

  useEffect(() => {
    if (tab === "manage" && isAdmin && vaultItems.length === 0) {
      api.listVaultItems().then(setVaultItems).catch(() => setVaultItems([]));
    }
    if (tab === "vault" && isAdmin) {
      setVault(null);
      api.vaultStatus().then(setVault).catch((e) => setError((e as Error).message));
    }
  }, [tab, isAdmin, vaultItems.length]);

  const handleOpen = useCallback(
    (app: AppManifest) => {
      openWindow(app.id, {
        title: app.name,
        icon: app.icon,
        width: app.window.defaultWidth,
        height: app.window.defaultHeight,
      });
    },
    [openWindow],
  );

  const flash = (msg: string) => {
    setNotice(msg);
    setError("");
    window.setTimeout(() => setNotice(""), 4000);
  };

  const submitForm = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (form.editingId) {
        await api.updateService(form.editingId, {
          name: form.name,
          url: form.url,
          icon: form.icon,
          iconUrl: form.iconUrl,
          vaultItemId: form.vaultItemId,
          requiredGroups: form.requiredGroups,
        });
        flash(t("msg.saved", { name: form.name }));
      } else {
        const created = await api.createService(form);
        flash(t("msg.created", { name: created.name }));
      }
      setForm(EMPTY_FORM);
      await refreshAdmin();
      await reloadApps();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [form, refreshAdmin, reloadApps, t]);

  const handleToggle = useCallback(
    async (row: HubServiceRow) => {
      setBusy(true);
      try {
        await api.toggleService(row.id);
        await refreshAdmin();
        await reloadApps();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refreshAdmin, reloadApps],
  );

  const handleDelete = useCallback(
    async (row: HubServiceRow) => {
      if (!window.confirm(t("msg.confirmDelete", { name: row.name }))) return;
      setBusy(true);
      try {
        await api.deleteService(row.id);
        flash(t("msg.deleted", { name: row.name }));
        await refreshAdmin();
        await reloadApps();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refreshAdmin, reloadApps, t],
  );

  const editRow = (row: HubServiceRow) =>
    setForm({
      editingId: row.id,
      name: row.name,
      url: row.url,
      icon: row.icon,
      iconUrl: row.iconUrl,
      vaultItemId: row.vaultItemId,
      requiredGroups: row.requiredGroups,
    });

  const [syncing, setSyncing] = useState(false);

  /** Create tiles from the vault collection.
   *  The person already decides by creating the vault entry — here they only trigger it. */
  async function syncFromVault() {
    setSyncing(true);
    try {
      const r = await api.syncVault();
      const uebersprungen = r.skipped.length ? t("msg.skipped", { count: r.skipped.length }) : "";
      setNotice(t("msg.synced", { count: r.created.length, skipped: uebersprungen }));
      // Reload both lists: the tiles AND the reconciliation, otherwise the tab keeps
      // showing the entries just created as "without service".
      setRows(await api.listServices());
      setVault(await api.vaultStatus());
      await reloadApps();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  /** Vault reconciliation → "Dienst anlegen" (create service): prefill the form and switch to it. */
  const prefillFromOrphan = (item: VaultItemMeta) => {
    setForm({
      name: item.name,
      url: item.uri && /^https?:\/\//.test(item.uri) ? item.uri : "https://",
      icon: "🌐",
      vaultItemId: item.id,
      requiredGroups: ["clara-admins"],
    });
    setTab("manage");
  };

  return (
    <div ref={rootRef} className={`${styles.app} ${compact ? styles.compact : ""}`}>
      <header className={styles.header}>
        <input
          className={styles.search}
          data-testid="hub-search"
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isAdmin && (
          <nav className={styles.tabs}>
            <button className={tab === "grid" ? styles.tabActive : styles.tab} onClick={() => setTab("grid")}>
              {t("tabs.grid")}
            </button>
            <button
              className={tab === "manage" ? styles.tabActive : styles.tab}
              data-testid="hub-tab-manage"
              onClick={() => setTab("manage")}
            >
              {t("tabs.manage")}
            </button>
            <button
              className={tab === "vault" ? styles.tabActive : styles.tab}
              data-testid="hub-tab-vault"
              onClick={() => setTab("vault")}
            >
              {t("tabs.vault")}
            </button>
          </nav>
        )}
      </header>

      {(error || notice) && (
        <div className={error ? styles.errorBar : styles.noticeBar}>{error || notice}</div>
      )}

      {zugangFuer && (
        <div className={styles.zugangPanel} data-testid="hub-zugang">
          <div className={styles.zugangKopf}>
            <span className={styles.zugangTitel}>
              {zugangFuer.icon} {t("access.title", { name: zugangFuer.name })}
            </span>
            <button className={styles.ghostBtn} onClick={() => setZugangFuer(null)}>
              {t("access.close")}
            </button>
          </div>
          <p className={styles.zugangHinweis}>
            {t("access.hint")}
          </p>
          <CredentialAccounts
            appId={zugangFuer.id}
            slots={zugangFuer.config?.credentials || []}
          />
        </div>
      )}

      {tab === "grid" && (
        <div className={styles.grid} data-testid="hub-grid">
          {visible.map((app) => (
            <ServiceTile
              key={app.id}
              app={app}
              onOpen={handleOpen}
              onZugang={(app.config?.credentials?.length ?? 0) > 0 ? setZugangFuer : undefined}
            />
          ))}
          {visible.length === 0 && (
            <div className={styles.empty}>
              {services.length === 0
                ? t("grid.noneForYou")
                : t("grid.noMatch")}
            </div>
          )}
        </div>
      )}

      {tab === "manage" && isAdmin && (
        <div className={styles.manage}>
          <ServiceForm
            form={form}
            vaultItems={vaultItems}
            busy={busy}
            onChange={setForm}
            onSubmit={submitForm}
            onCancel={() => setForm(EMPTY_FORM)}
          />
          <div className={styles.rowList}>
            {rows.map((row) => (
              <div key={row.id} className={styles.row} data-testid="hub-row">
                <span className={styles.rowIcon}>{row.icon || "🌐"}</span>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>
                    {row.name}
                    {!row.enabled && <em className={styles.rowOff}>{t("row.disabled")}</em>}
                  </span>
                  <span className={styles.rowMeta}>
                    {baseHost(row.url)} · {row.createdBy === "system" ? t("row.seed") : t("row.byForm")}
                    {row.requiredGroups.length > 0 && ` · ${row.requiredGroups.join(", ")}`}
                    {row.vaultItemId && t("row.vault")}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  {row.createdBy === "hub" && (
                    <button className={styles.ghostBtn} onClick={() => editRow(row)}>{t("row.edit")}</button>
                  )}
                  <button className={styles.ghostBtn} onClick={() => void handleToggle(row)}>
                    {row.enabled ? t("row.deactivate") : t("row.activate")}
                  </button>
                  {row.createdBy === "hub" && (
                    <button className={styles.dangerBtn} onClick={() => void handleDelete(row)}>{t("row.delete")}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "vault" && isAdmin && (
        <div className={styles.vault} data-testid="hub-vault">
          {!vault && !error && <div className={styles.empty}>{t("vault.reading")}</div>}
          {vault && (
            <>
              <h3 className={styles.vaultTitle}>{t("vault.services")}</h3>
              {vault.services.map((s) => (
                <div key={s.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>{s.name}</span>
                    <span className={styles.rowMeta}>
                      {s.matched.length === 0 && t("vault.noCredentials")}
                      {s.matched.map((m) =>
                        `${m.itemName} (${m.via === "explicit" ? t("vault.explicit") : t("vault.domain")})`,
                      ).join(" · ")}
                    </span>
                  </div>
                </div>
              ))}
              <h3 className={styles.vaultTitle}>
                {t("vault.orphans")}
                {vault.orphanItems.length > 0 && (
                  <button
                    className={styles.ghostBtn}
                    data-testid="hub-sync-vault"
                    disabled={syncing}
                    onClick={syncFromVault}
                    title={t("vault.syncTitle")}
                  >
                    {syncing ? t("vault.syncing") : t("vault.syncAll", { count: vault.orphanItems.length })}
                  </button>
                )}
              </h3>
              {vault.orphanItems.length === 0 && (
                <div className={styles.empty}>{t("vault.allAssigned")}</div>
              )}
              {vault.orphanItems.map((it) => (
                <div key={it.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>{it.name}</span>
                    <span className={styles.rowMeta}>{it.uri || "—"}{it.username ? ` · ${it.username}` : ""}</span>
                  </div>
                  <div className={styles.rowActions}>
                    <button className={styles.ghostBtn} onClick={() => prefillFromOrphan(it)}>
                      {t("vault.createService")}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
