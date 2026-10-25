import { i18n, useTranslation } from "@claraos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./TaskManagerApp.module.css";

interface DockerHost {
  id: string;
  label: string;
  ip: string;
  reachable: boolean;
  container_count: number;
  hint: string | null;
}

interface ContainerRow {
  name: string;
  image: string;
  state: string;
  status: string;
  cpu: string | null;
  mem_used: string | null;
  mem_limit: string | null;
  protected: boolean;
}

export function ContainersTab({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation("taskManager");
  const [hosts, setHosts] = useState<DockerHost[]>([]);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [rows, setRows] = useState<ContainerRow[]>([]);
  const [statsOk, setStatsOk] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeHost;

  useEffect(() => {
    fetch("/api/claraos/containers/hosts", { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: { hosts: DockerHost[] }) => {
        setHosts(d.hosts);
        const first = d.hosts.find((h) => h.reachable);
        if (first) setActiveHost((cur) => cur ?? first.id);
      })
      .catch((e) => setError(i18n.t("taskManager:containers.hostsFailed", { error: (e as Error).message })));
  }, []);

  const loadContainers = useCallback(async (hostId: string) => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/claraos/containers/list?host=${encodeURIComponent(hostId)}`, { credentials: "include" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      // Antwort kann nach Host-Wechsel veraltet sein
      if (activeRef.current === hostId) {
        setRows(body.containers);
        setStatsOk(body.stats_ok !== false);
      }
    } catch (e) {
      if (activeRef.current === hostId) setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  // Laden bei Host-Wechsel + Auto-Refresh alle 20 s solange Tab offen
  useEffect(() => {
    if (!activeHost) return;
    loadContainers(activeHost);
    const iv = setInterval(() => loadContainers(activeHost), 20000);
    return () => clearInterval(iv);
  }, [activeHost, loadContainers]);

  const restart = async (name: string) => {
    if (!activeHost) return;
    if (!confirm(t("containers.confirmRestart", { name }))) return;
    setBusy(name); setActionMsg(null);
    try {
      const r = await fetch(`/api/claraos/containers/${activeHost}/${encodeURIComponent(name)}/restart`, {
        method: "POST", credentials: "include",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      setActionMsg({ ok: true, text: t("containers.restarted", { name }) });
      loadContainers(activeHost);
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  };

  const visible = rows.filter((c) =>
    !filter.trim() || c.name.toLowerCase().includes(filter.toLowerCase()) || c.image.toLowerCase().includes(filter.toLowerCase()));
  const running = rows.filter((c) => c.state === "running").length;

  return (
    <div className={styles.containersPane}>
      <div className={styles.hostBar}>
        {hosts.map((h) => (
          <button
            key={h.id}
            className={`${styles.hostChip} ${activeHost === h.id ? styles.hostChipActive : ""} ${!h.reachable ? styles.hostChipDown : ""}`}
            onClick={() => h.reachable && setActiveHost(h.id)}
            title={h.hint ?? t("containers.hostCount", { count: h.container_count })}
            disabled={!h.reachable}
          >
            <span className={h.reachable ? styles.dotUp : styles.dotDown}>●</span> {h.label}
            {h.reachable && <span className={styles.count}>{h.container_count}</span>}
          </button>
        ))}
        <input
          className={styles.filterInput}
          placeholder={t("containers.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className={styles.actionBtn} onClick={() => activeHost && loadContainers(activeHost)} disabled={loading}>
          {loading ? "…" : t("containers.refresh")}
        </button>
      </div>

      {hosts.some((h) => !h.reachable) && (
        <p className={styles.hostHint}>
          {t("containers.unreachable")}
        </p>
      )}
      {error && <p className={styles.errorLine}>⚠ {error}</p>}
      {actionMsg && (
        <p className={actionMsg.ok ? styles.okLine : styles.errorLine}>{actionMsg.text}</p>
      )}
      {!statsOk && !error && (
        <p className={styles.hostHint}>{t("containers.statsMissing")}</p>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("col.container")}</th>
              <th>{t("col.image")}</th>
              <th>{t("col.status")}</th>
              <th>{t("col.cpu")}</th>
              <th>{t("col.ram")}</th>
              {isAdmin && <th>{t("col.action")}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={isAdmin ? 6 : 5} className={styles.empty}>
                {loading ? t("loading") : rows.length ? t("containers.noMatch") : t("containers.none")}
              </td></tr>
            )}
            {visible.map((c) => (
              <tr key={c.name}>
                <td className={styles.titleCell}>
                  <span className={c.state === "running" ? styles.dotUp : styles.dotDown}>●</span>{" "}
                  {c.name}
                  {c.protected && <span className={styles.protectedBadge} title={t("containers.protectedTitle")}>{t("containers.protected")}</span>}
                </td>
                <td className={styles.subCell} title={c.image}>{c.image.length > 42 ? c.image.slice(0, 40) + "…" : c.image}</td>
                <td className={styles.subCell}>{c.status}</td>
                <td className={styles.subCell}>{c.cpu ?? "—"}</td>
                <td className={styles.subCell}>{c.mem_used ? `${c.mem_used}${c.mem_limit ? " / " + c.mem_limit : ""}` : "—"}</td>
                {isAdmin && (
                  <td className={styles.actionCell}>
                    <button
                      className={styles.actionBtn}
                      onClick={() => restart(c.name)}
                      disabled={busy !== null || c.protected}
                    >
                      {busy === c.name ? "…" : t("containers.restart")}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.footerLine}>
        {t("containers.footer", { running, total: rows.length })}
      </p>
    </div>
  );
}
