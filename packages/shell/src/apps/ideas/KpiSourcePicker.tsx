/** Data source picker for a KPI.
 *
 * The whole point: KPIs that fill themselves. Manually maintained numbers
 * tend to go stale after a few weeks, which is why the picker sits directly
 * in the create dialog and not in a submenu. */
import type { ComponentType } from "react";
import styles from "./IdeasApp.module.css";
import type { KpiSource, KpiSourceKind } from "./types";
import { useTranslation, i18n } from "@claraos/core";

interface KindEntry { key: KpiSourceKind; label: string; hint: string }

/** Built-in kinds read label and hint in the UI language (getters); site-specific
 *  kinds below bring their own text. */
const art = (key: KpiSourceKind): KindEntry => ({
  key,
  get label() { return i18n.t(`wissen:kpiSource.kinds.${key}`); },
  get hint() { return i18n.t(`wissen:kpiSource.hints.${key}`); },
});
const KINDS: KindEntry[] = [art("manual"), art("planner"), art("formula")];

// Optional site-specific data sources (heim/kpiSources.tsx): each kind is
// inserted after the kind named by `after`, and its config form renders for
// that kind.
const heim = Object.values(import.meta.glob<{
  heimKpiKinds?: (KindEntry & { after: KpiSourceKind })[];
  HeimKpiSourceForm?: ComponentType<{ kind: KpiSourceKind; cfg: Record<string, string>; setCfg: (patch: Record<string, unknown>) => void }>;
}>("../../heim/kpiSources.tsx", { eager: true }))[0];
for (const k of heim?.heimKpiKinds ?? []) {
  const i = KINDS.findIndex((e) => e.key === k.after);
  KINDS.splice(i < 0 ? KINDS.length : i + 1, 0, { key: k.key, label: k.label, hint: k.hint });
}
const HeimForm = heim?.HeimKpiSourceForm;

const METRICS = ["done_ratio", "done", "open", "total"];

interface Props {
  value: KpiSource;
  onChange: (next: KpiSource) => void;
}

export function KpiSourcePicker({ value, onChange }: Props) {
  const { t } = useTranslation("wissen");
  const cfg = (value.config ?? {}) as Record<string, string>;
  const setCfg = (patch: Record<string, unknown>) =>
    onChange({ ...value, config: { ...value.config, ...patch } });

  const active = KINDS.find((k) => k.key === value.kind) ?? KINDS[0];

  return (
    <div className={styles.sourceBox}>
      <div className={styles.sourceTabs}>
        {KINDS.map((k) => (
          <button key={k.key} type="button"
                  className={`${styles.sourceTab} ${value.kind === k.key ? styles.sourceTabActive : ""}`}
                  onClick={() => onChange({ kind: k.key, config: {} })}>
            {k.label}
          </button>
        ))}
      </div>
      <p className={styles.metaHint}>{active.hint}</p>

      {HeimForm && <HeimForm kind={value.kind} cfg={cfg} setCfg={setCfg} />}

      {value.kind === "planner" && (
        <div className={styles.kpiForm}>
          <label>{t("kpiSource.project")}
            <input className={styles.input} inputMode="numeric" placeholder={t("kpiSource.projectPlaceholder")}
                   value={cfg.project_id ?? ""}
                   onChange={(e) => setCfg({ project_id: e.target.value })} />
          </label>
          <label>{t("kpiSource.what")}
            <select className={styles.input} value={cfg.metric ?? "done_ratio"}
                    onChange={(e) => setCfg({ metric: e.target.value })}>
              {METRICS.map((m) => <option key={m} value={m}>{t(`kpiSource.metrics.${m}`)}</option>)}
            </select>
          </label>
        </div>
      )}

      {value.kind === "formula" && (
        <label className={styles.kpiFormRow}>{t("kpiSource.formula")}
          <input className={styles.input} placeholder='prop("a") / prop("b") * 100'
                 value={cfg.expression ?? ""}
                 onChange={(e) => setCfg({ expression: e.target.value })} />
          <span className={styles.metaHint}>
            {t("kpiSource.formulaHint")}
          </span>
        </label>
      )}

      {value.kind !== "manual" && (
        <label className={styles.kpiFormRow}>{t("kpiSource.every")}
          <input className={styles.input} inputMode="numeric" placeholder="60"
                 value={value.every_minutes ?? ""}
                 onChange={(e) => onChange({
                   ...value,
                   every_minutes: e.target.value ? Number(e.target.value) : undefined,
                 })} />
        </label>
      )}
    </div>
  );
}
