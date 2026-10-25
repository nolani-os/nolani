import { useCallback, useEffect, useState } from "react";
import styles from "./TaskManagerApp.module.css";
import { SYSTEM_LABELS } from "../../widgets/systemLabels";
import { i18n, useTranslation } from "@claraos/core";

interface Target {
  id: string;
  name: string;
  kind: string; // node | vm | device
  node?: string;
}

interface TargetStats {
  id: string;
  name: string;
  kind: string;
  status?: string;
  cpu: number | null;
  mem: number | null;
  maxmem: number | null;
  disk: number | null;
  maxdisk: number | null;
  uptime: number | null;
}

/** Read on every render: a lookup table built at import time would freeze the language. */
function kindLabel(kind: string): string {
  if (kind === "node") return SYSTEM_LABELS.nodeKind;
  if (kind === "vm") return i18n.t("taskManager:system.kindVm");
  if (kind === "device") return i18n.t("taskManager:system.kindDevice");
  return kind;
}

function fmtBytes(b: number | null | undefined): string {
  if (!b) return "—";
  if (b > 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${b} B`;
}

function fmtUptime(s: number | null | undefined): string {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function Bar({ used, max }: { used: number | null; max: number | null }) {
  if (!used || !max) return <span className={styles.subCell}>—</span>;
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className={styles.barRow} title={`${fmtBytes(used)} / ${fmtBytes(max)}`}>
      <div className={styles.barTrack}>
        <div
          className={styles.barFill}
          style={{ width: `${pct}%`, background: pct > 90 ? "#dc2626" : pct > 75 ? "#d97706" : "var(--accent)" }}
        />
      </div>
      <span className={styles.barLabel}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export function SystemTab() {
  const { t } = useTranslation("taskManager");
  const [targets, setTargets] = useState<Target[]>([]);
  const [pveConfigured, setPveConfigured] = useState(true);
  const [stats, setStats] = useState<Record<string, TargetStats>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await fetch(`/api/claraos/system/target-stats?ids=${encodeURIComponent(ids.join(","))}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const map: Record<string, TargetStats> = {};
      for (const t of d.targets ?? d.results ?? []) map[t.id] = t;
      setStats(map);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let ids: string[] = [];
    let iv: ReturnType<typeof setInterval> | undefined;
    fetch("/api/claraos/system/targets", { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: { pve_configured: boolean; targets: Target[] }) => {
        setPveConfigured(d.pve_configured);
        setTargets(d.targets);
        ids = d.targets.map((t) => t.id).slice(0, 16);
        loadStats(ids).finally(() => setLoading(false));
        iv = setInterval(() => loadStats(ids), 15000);
      })
      .catch((e) => { setError((e as Error).message); setLoading(false); });
    return () => { if (iv) clearInterval(iv); };
  }, [loadStats]);

  return (
    <div className={styles.containersPane}>
      {!pveConfigured && (
        <p className={styles.hostHint}>
          {SYSTEM_LABELS.tokenMissingTab}
        </p>
      )}
      {error && <p className={styles.errorLine}>⚠ {error}</p>}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("col.target")}</th>
              <th>{t("col.type")}</th>
              <th>{t("col.status")}</th>
              <th>{t("col.cpu")}</th>
              <th>{t("col.ram")}</th>
              <th>{t("col.disk")}</th>
              <th>{t("col.uptime")}</th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr><td colSpan={7} className={styles.empty}>{loading ? t("loading") : t("system.noTargets")}</td></tr>
            )}
            {targets.map((z) => {
              const s = stats[z.id];
              const up = s?.status === "running" || s?.status === "online";
              return (
                <tr key={z.id}>
                  <td className={styles.titleCell}>
                    <span className={up ? styles.dotUp : styles.dotDown}>●</span> {z.name}
                    {z.node ? <span className={styles.subCell}> @ {z.node}</span> : null}
                  </td>
                  <td className={styles.subCell}>{kindLabel(z.kind)}</td>
                  <td className={styles.subCell}>{s?.status ?? "—"}</td>
                  <td className={styles.subCell}>{s?.cpu != null ? `${s.cpu.toFixed(1)} %` : "—"}</td>
                  <td><Bar used={s?.mem ?? null} max={s?.maxmem ?? null} /></td>
                  <td><Bar used={s?.disk ?? null} max={s?.maxdisk ?? null} /></td>
                  <td className={styles.subCell}>{fmtUptime(s?.uptime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.footerLine}>{t("system.refreshNote")}</p>
    </div>
  );
}
