// System monitor v2: multi-target (hypervisor nodes + VMs + SSH devices).
// Targets come from /api/claraos/system/targets (read-only hypervisor API or
// ssh_scanner), live values from /system/target-stats. Per target: status dot,
// CPU/RAM bars and a CPU sparkline (client-side ring buffer, inline SVG).
// Without a target selection the widget falls back to the classic container
// view (/system/stats), which the quick settings panel also uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore, useTranslation } from "@claraos/core";
import type { WidgetProps } from "./registry";
import {
  CheckList,
  CheckRow,
  GroupLabel,
  SelectRow,
  SettingsOverlay,
  useWidgetSettingsOpen,
} from "./settingsControls";
import styles from "./Widgets.module.css";
import { SYSTEM_LABELS } from "./systemLabels";

interface Target {
  id: string;
  name: string;
  kind: "node" | "vm" | "device";
  node?: string;
}

interface TargetStats extends Target {
  status: string;
  cpu: number | null;
  mem: number | null;
  maxmem: number | null;
  disk: number | null;
  maxdisk: number | null;
  uptime: number | null;
}

const HISTORY_LEN = 60;

// Default targets come from this installation's optional heim.config.ts
// (without it the widget waits for a configuration).
const heimConfig = import.meta.glob<{ SYSTEM_STATS_DEFAULT_IDS?: string[] }>("../heim.config.ts", { eager: true });
const DEFAULT_IDS: string[] = Object.values(heimConfig)[0]?.SYSTEM_STATS_DEFAULT_IDS ?? [];

function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <svg className={sparkCls} viewBox="0 0 60 18" />;
  const step = 60 / (HISTORY_LEN - 1);
  const offset = HISTORY_LEN - points.length;
  const d = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${((offset + i) * step).toFixed(1)},${(17 - (v / 100) * 16).toFixed(1)}`)
    .join(" ");
  return (
    <svg className={sparkCls} viewBox="0 0 60 18" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="#7b9fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const sparkCls = styles.sysSpark;

export default function SystemStatsWidget({ widgetId, config }: WidgetProps) {
  const updateWidgetConfig = useWorkspaceStore((st) => st.updateWidgetConfig);
  // `t` is the loop variable for targets below — hence `tr`.
  const { t: tr } = useTranslation("desktop");
  const cfgIds: string[] = Array.isArray(config?.targets) ? (config.targets as string[]) : DEFAULT_IDS;
  const pollSec =
    typeof config?.pollSec === "number" && config.pollSec >= 5 ? (config.pollSec as number) : 10;

  const [stats, setStats] = useState<TargetStats[] | null>(null);
  const [pveConfigured, setPveConfigured] = useState(true);
  const [error, setError] = useState(false);
  const historyRef = useRef<Map<string, number[]>>(new Map());
  const [, bumpHistory] = useState(0);

  const [settingsOpen, setSettingsOpen] = useWidgetSettingsOpen(widgetId);
  const [available, setAvailable] = useState<Target[] | null>(null);
  const [draftIds, setDraftIds] = useState<string[]>(cfgIds);
  const [draftPoll, setDraftPoll] = useState(String(pollSec));

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/claraos/system/target-stats?ids=${encodeURIComponent(cfgIds.join(","))}`,
      );
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      const list: TargetStats[] = Array.isArray(data.targets) ? data.targets : [];
      setPveConfigured(data.pve_configured !== false);
      // keep the order from the config
      const byId = new Map(list.map((t) => [t.id, t]));
      setStats(cfgIds.map((id) => byId.get(id)).filter(Boolean) as TargetStats[]);
      setError(false);
      for (const t of list) {
        if (t.cpu == null) continue;
        const h = historyRef.current.get(t.id) ?? [];
        h.push(t.cpu);
        if (h.length > HISTORY_LEN) h.shift();
        historyRef.current.set(t.id, h);
      }
      bumpHistory((n) => n + 1);
    } catch {
      setError(true);
    }
  }, [cfgIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const t = setInterval(load, pollSec * 1000);
    return () => clearInterval(t);
  }, [load, pollSec]);

  // load the target list only when the settings open
  useEffect(() => {
    if (!settingsOpen || available !== null) return;
    fetch("/api/claraos/system/targets")
      .then((r) => (r.ok ? r.json() : { targets: [] }))
      .then((d) => {
        setAvailable(Array.isArray(d.targets) ? d.targets : []);
        setPveConfigured(d.pve_configured !== false);
      })
      .catch(() => setAvailable([]));
  }, [settingsOpen, available]);

  useEffect(() => {
    if (settingsOpen) {
      setDraftIds(cfgIds);
      setDraftPoll(String(pollSec));
    }
  }, [settingsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = useCallback(() => {
    updateWidgetConfig(widgetId, { targets: draftIds, pollSec: parseInt(draftPoll, 10) });
    setSettingsOpen(false);
    setStats(null);
  }, [widgetId, draftIds, draftPoll, updateWidgetConfig, setSettingsOpen]);

  const grouped = useMemo(() => {
    if (!available) return { node: [], vm: [], device: [] } as Record<string, Target[]>;
    return {
      node: available.filter((t) => t.kind === "node"),
      vm: available.filter((t) => t.kind === "vm"),
      device: available.filter((t) => t.kind === "device"),
    };
  }, [available]);

  return (
    <div className={styles.sys}>
      <div className={styles.sysTitle}>{tr("widgets.systemStats.title")}</div>
      <div className={styles.sysScroll} data-no-drag>
        {stats === null && !error && <div className={styles.sysEmpty}>{tr("widgets.systemStats.loading")}</div>}
        {error && <div className={styles.sysEmpty}>{tr("widgets.systemStats.unreachable")}</div>}
        {stats !== null && !error && stats.length === 0 && (
          <div className={styles.sysEmpty}>
            {pveConfigured ? tr("widgets.systemStats.noTargets") : SYSTEM_LABELS.tokenMissing}
          </div>
        )}
        {(stats ?? []).map((t) => {
          const memPct = pct(t.mem, t.maxmem);
          const running = t.status === "running" || t.status === "online";
          return (
            <div key={t.id} className={styles.sysTarget}>
              <div className={styles.sysTargetHead}>
                <span
                  className={styles.sysDot}
                  style={{ background: running ? "#4ade80" : "#f87171" }}
                  title={t.status}
                />
                <span className={styles.sysTargetName}>{t.name}</span>
                <span className={styles.sysKind}>
                  {t.kind === "node" ? SYSTEM_LABELS.nodeKind : t.kind === "vm" ? "VM" : tr("widgets.systemStats.kindDevice")}
                </span>
                <Sparkline points={historyRef.current.get(t.id) ?? []} />
              </div>
              <div className={styles.sysRow}>
                <span className={styles.sysLabel}>CPU</span>
                <div className={styles.sysTrack}>
                  <div className={styles.sysFill} style={{ width: `${t.cpu ?? 0}%` }} />
                </div>
                <span className={styles.sysVal}>{t.cpu != null ? `${Math.round(t.cpu)}%` : "—"}</span>
              </div>
              <div className={styles.sysRow}>
                <span className={styles.sysLabel}>RAM</span>
                <div className={styles.sysTrack}>
                  <div className={styles.sysFill} style={{ width: `${memPct ?? 0}%` }} />
                </div>
                <span className={styles.sysVal}>{memPct != null ? `${Math.round(memPct)}%` : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>

      {settingsOpen && (
        <SettingsOverlay
          title={tr("widgets.systemStats.title")}
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
        >
          {!pveConfigured && (
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {SYSTEM_LABELS.tokenMissingHint}
            </div>
          )}
          {(["node", "vm", "device"] as const).map((kind) =>
            grouped[kind].length ? (
              <div key={kind}>
                <GroupLabel>
                  {kind === "node" ? SYSTEM_LABELS.nodeGroup : kind === "vm" ? tr("widgets.systemStats.groupVm") : tr("widgets.systemStats.groupDevice")}
                </GroupLabel>
                <CheckList>
                  {grouped[kind].map((t) => (
                    <CheckRow
                      key={t.id}
                      label={t.node ? `${t.name} (${t.node})` : t.name}
                      checked={draftIds.includes(t.id)}
                      onChange={(v) =>
                        setDraftIds((cur) => (v ? [...cur, t.id] : cur.filter((x) => x !== t.id)))
                      }
                    />
                  ))}
                </CheckList>
              </div>
            ) : null,
          )}
          {available === null && <span style={{ fontSize: 11, opacity: 0.6 }}>{tr("widgets.systemStats.loadingTargets")}</span>}
          <SelectRow
            label={tr("widgets.systemStats.refresh")}
            value={draftPoll}
            onChange={setDraftPoll}
            options={[
              { value: "5", label: tr("widgets.systemStats.seconds", { count: 5 }) },
              { value: "10", label: tr("widgets.systemStats.seconds", { count: 10 }) },
              { value: "30", label: tr("widgets.systemStats.seconds", { count: 30 }) },
              { value: "60", label: tr("widgets.systemStats.minutes", { count: 1 }) },
            ]}
          />
        </SettingsOverlay>
      )}
    </div>
  );
}
