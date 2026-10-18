import { useCallback, useEffect, useState } from "react";
import styles from "./TaskManagerApp.module.css";
import { SYSTEM_LABELS } from "../../widgets/systemLabels";

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

const KIND_LABEL: Record<string, string> = { node: SYSTEM_LABELS.nodeKind, vm: "VM", device: "Gerät" };

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
              <th>Ziel</th>
              <th>Typ</th>
              <th>Status</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Disk</th>
              <th>Uptime</th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr><td colSpan={7} className={styles.empty}>{loading ? "Lade…" : "Keine Monitoring-Ziele verfügbar"}</td></tr>
            )}
            {targets.map((t) => {
              const s = stats[t.id];
              const up = s?.status === "running" || s?.status === "online";
              return (
                <tr key={t.id}>
                  <td className={styles.titleCell}>
                    <span className={up ? styles.dotUp : styles.dotDown}>●</span> {t.name}
                    {t.node ? <span className={styles.subCell}> @ {t.node}</span> : null}
                  </td>
                  <td className={styles.subCell}>{KIND_LABEL[t.kind] ?? t.kind}</td>
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
      <p className={styles.footerLine}>Werte aktualisieren sich alle 15 s</p>
    </div>
  );
}
