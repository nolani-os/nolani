import { useState } from "react";
import {
  useWindowsStore,
  useWorkspaceStore,
  useAppRegistryStore,
  useAuthStore,
  useTranslation,
} from "@claraos/core";
import { AppIcon } from "../../components/AppIcon";
import { widgetManifests } from "../../widgets/registry";
import { ContainersTab } from "./ContainersTab";
import { SystemTab } from "./SystemTab";
import styles from "./TaskManagerApp.module.css";

type Tab = "windows" | "widgets" | "containers" | "system";

/**
 * Task manager / system monitor. Four tabs:
 *
 *   1. Applications — open windows (useWindowsStore), focus/quit.
 *   2. Widgets — widgets of the active workspace, remove.
 *   3. Containers (admin) — Docker containers of all reachable hosts incl.
 *      CPU/RAM + restart (backend routers/containers.py, SSH pattern).
 *   4. System (admin) — nodes/VMs/devices from /system/targets (hypervisor + SSH),
 *      shared with the system monitor widget.
 */
export default function TaskManagerApp({ windowId: _windowId }: { windowId: string }) {
  const { t } = useTranslation("taskManager");
  const [tab, setTab] = useState<Tab>("windows");
  const windowsMap = useWindowsStore((s) => s.windows);
  const windowOrder = useWindowsStore((s) => s.windowOrder);
  const closeWindow = useWindowsStore((s) => s.closeWindow);
  const focusWindow = useWindowsStore((s) => s.focusWindow);
  const activeWs = useWorkspaceStore((s) => s.getActive());
  const removeWidget = useWorkspaceStore((s) => s.removeWidget);
  const apps = useAppRegistryStore((s) => s.apps);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const visibleWindows = windowOrder
    .map((id) => windowsMap[id])
    .filter(Boolean);

  return (
    <div className={styles.app}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === "windows" ? styles.tabActive : ""}`}
          onClick={() => setTab("windows")}
        >
          {t("tabs.windows")} <span className={styles.count}>{visibleWindows.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === "widgets" ? styles.tabActive : ""}`}
          onClick={() => setTab("widgets")}
        >
          {t("tabs.widgets")} <span className={styles.count}>{(activeWs.widgets ?? []).length}</span>
        </button>
        {isAdmin && (
          <>
            <button
              className={`${styles.tab} ${tab === "containers" ? styles.tabActive : ""}`}
              onClick={() => setTab("containers")}
            >
              {t("tabs.containers")}
            </button>
            <button
              className={`${styles.tab} ${tab === "system" ? styles.tabActive : ""}`}
              onClick={() => setTab("system")}
            >
              {t("tabs.system")}
            </button>
          </>
        )}
      </div>

      {tab === "containers" && isAdmin && <ContainersTab isAdmin={isAdmin} />}
      {tab === "system" && isAdmin && <SystemTab />}

      {tab === "windows" && (
        <div className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.tableFenster}`}>
          <thead>
            <tr>
              <th></th>
              <th>{t("col.name")}</th>
              <th>{t("col.app")}</th>
              <th>{t("col.status")}</th>
              <th>{t("col.action")}</th>
            </tr>
          </thead>
          <tbody>
            {visibleWindows.length === 0 && (
              <tr><td colSpan={5} className={styles.empty}>{t("noWindows")}</td></tr>
            )}
            {visibleWindows.map((win) => {
              const app = apps[win.appId];
              const status = win.minimized
                ? t("state.minimized")
                : win.maximized
                  ? t("state.maximized")
                  : t("state.active");
              return (
                <tr key={win.id}>
                  <td className={styles.iconCell}>
                    <AppIcon
                      appId={win.appId}
                      fallback={app?.icon ?? "🔲"}
                      pixelSize={20}
                    />
                  </td>
                  <td className={styles.titleCell}>{win.title}</td>
                  <td className={styles.subCell}>{app?.name ?? win.appId}</td>
                  <td className={styles.subCell}>{status}</td>
                  <td className={styles.actionCell}>
                    <button className={styles.actionBtn} onClick={() => focusWindow(win.id)}>
                      {t("focus")}
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.danger}`}
                      onClick={() => closeWindow(win.id)}
                    >
                      {t("quit")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {tab === "widgets" && (
        <div className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.tableWidgets}`}>
          <thead>
            <tr>
              <th>{t("col.type")}</th>
              <th>{t("col.workspace")}</th>
              <th>{t("col.position")}</th>
              <th>{t("col.size")}</th>
              <th>{t("col.action")}</th>
            </tr>
          </thead>
          <tbody>
            {(activeWs.widgets ?? []).length === 0 && (
              <tr><td colSpan={5} className={styles.empty}>{t("noWidgets")}</td></tr>
            )}
            {(activeWs.widgets ?? []).map((w) => {
              const m = widgetManifests[w.type];
              return (
                <tr key={w.id}>
                  <td className={styles.titleCell}>{m?.name ?? w.type}</td>
                  <td className={styles.subCell}>{activeWs.name}</td>
                  <td className={styles.subCell}>({w.gridCol}, {w.gridRow})</td>
                  <td className={styles.subCell}>{w.gridW}×{w.gridH}</td>
                  <td className={styles.actionCell}>
                    <button
                      className={`${styles.actionBtn} ${styles.danger}`}
                      onClick={() => removeWidget(w.id)}
                    >
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
