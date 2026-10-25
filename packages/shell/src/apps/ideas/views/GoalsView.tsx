/** Goal tree: vision → goals → sub-goals, each with a traffic light, progress
 * and KPIs.
 *
 * Important: the hierarchy is the existing page hierarchy (parent_id), not a
 * separate edge type: re-parenting, sorting and cycle protection already exist
 * there. KPIs, by contrast, attach to a goal via the 'measured_by' edge,
 * because the same KPI may contribute to several goals.
 *
 * Important: all percentages and traffic lights arrive pre-computed from the server. */
import { useTranslation, i18n, Trans } from "@claraos/core";
import { useCallback, useEffect, useState } from "react";
import styles from "../IdeasApp.module.css";
import { ideasApi } from "../api";
import type { GoalNode, KpiSource } from "../types";
import { KpiCard } from "../KpiCard";
import { KpiSourcePicker } from "../KpiSourcePicker";
import { ActionPlanPanel } from "../ActionPlanPanel";
import { SuggestIdeasModal } from "../SuggestIdeasModal";
import { KaizenPanel } from "../KaizenPanel";
import { Icon } from "../../../components/Icon";
import { fmtDate, fmtPct, statusColor, statusOf } from "../kpiStatus";

interface Props {
  currentUser: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
  /** Incremented when something changed elsewhere → reload the tree. */
  reloadTick: number;
}

type NewKind = "vision" | "goal" | "kpi";

interface Draft {
  kind: NewKind;
  parent: GoalNode | null;
}

export function GoalsView({ currentUser, onOpen, onChanged, reloadTick }: Props) {
  const { t } = useTranslation("wissen");
  const [tree, setTree] = useState<GoalNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [suggestFor, setSuggestFor] = useState<GoalNode | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await ideasApi.goalsTree();
      setTree(r.tree);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("wissen:views.goals.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, tick, reloadTick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const renderNode = (n: GoalNode) => {
    const st = statusOf(n.progress.status);
    const isCollapsed = collapsed[n.id];
    const hasChildren = n.children.length > 0 || n.kpis.length > 0;
    const due = typeof n.properties?.due_date === "string" ? n.properties.due_date : null;
    const mine = n.owner === currentUser;

    return (
      <li key={n.id} className={styles.goalNode}>
        {/* Grid instead of a flex row. Previously the bar (120 px), percentage
            (44 px), due date and three buttons had FIXED widths and the title
            got the rest — on a ~400 px phone that left ~60 px, i.e. "G···". Now the
            title owns the whole first line on phones and the metrics sit
            below it. On desktop everything stays on one line. */}
        <div className={styles.goalRow}>
          <button className={styles.goalToggle} disabled={!hasChildren}
                  onClick={() => setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] }))}
                  title={isCollapsed ? t("views.goals.expand") : t("views.goals.collapse")}
                  aria-label={isCollapsed ? t("views.goals.expand") : t("views.goals.collapse")}>
            {hasChildren ? <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={16} /> : null}
          </button>

          <button className={styles.goalTitle} onClick={() => onOpen(n.id)}>
            <Icon name={n.type === "vision" ? "vision" : "goal"} size={16}
                  className={styles.inlineIcon} />
            {n.title}
          </button>

          <div className={styles.goalMeta}>
            <span className={styles.goalStatus} title={
              n.progress.parts === 0
                ? t("views.goals.unknown")
                : t("views.goals.parts", { status: st.label, count: n.progress.parts })
            } style={{ color: statusColor(n.progress.status) }}>
              <Icon name={st.iconName} size={16} />
            </span>

            {/* No measurement, no bar: an empty track plus "—" took half the
                line and said nothing. The hint below explains the state
                anyway. */}
            {n.progress.attainment !== null && n.progress.attainment !== undefined && (
              <>
                <div className={styles.goalBar} title={t("views.goals.reached", { pct: fmtPct(n.progress.attainment) })}>
                  <span style={{
                    width: `${Math.max(0, Math.min(100, n.progress.attainment * 100))}%`,
                    background: statusColor(n.progress.status),
                  }} />
                </div>
                <span className={styles.goalPct}>{fmtPct(n.progress.attainment)}</span>
              </>
            )}
            {due && <span className={styles.goalDue} title={t("views.goals.due")}>{t("views.goals.until", { date: fmtDate(due) })}</span>}
          </div>

          {mine && (
            <span className={styles.goalActions}>
              <button className={styles.iconBtn} title={t("views.goals.addSub")}
                      aria-label={t("views.goals.addSub")}
                      onClick={() => setDraft({ kind: "goal", parent: n })}>
                <Icon name="plus" size={13} /><Icon name="target" size={17} />
              </button>
              <button className={styles.iconBtn} title={t("views.goals.addKpi")}
                      aria-label={t("views.goals.addKpi")}
                      onClick={() => setDraft({ kind: "kpi", parent: n })}>
                <Icon name="plus" size={13} /><Icon name="kpi" size={17} />
              </button>
              {n.type === "goal" && (
                <button className={styles.iconBtn} title={t("views.goals.suggest")}
                        aria-label={t("views.goals.suggest")}
                        onClick={() => setSuggestFor(n)}><Icon name="sparkle" size={18} /></button>
              )}
            </span>
          )}
        </div>

        {!isCollapsed && (
          <>
            {n.kpis.length > 0 && (
              <div className={styles.goalKpis}>
                {n.kpis.map((k) => (
                  <KpiCard key={k.id} kpi={k} currentUser={currentUser}
                           onOpen={onOpen} onChanged={refresh} />
                ))}
              </div>
            )}
            {/* Action plan only on real goals — a vision groups goals and has
                no task list of its own. */}
            {n.type === "goal" && (
              <div className={styles.goalPlan}>
                <ActionPlanPanel goalId={n.id} canEdit={mine} reloadTick={reloadTick} />
                {/* Kaizen only appears for red/amber status or when analyses
                    already exist — the panel decides that itself. */}
                <KaizenPanel goal={n} canEdit={mine} onOpen={onOpen}
                             onChanged={() => { refresh(); onChanged(); }} />
              </div>
            )}
            {n.children.length > 0 && (
              <ul className={styles.goalChildren}>{n.children.map(renderNode)}</ul>
            )}
            {/* This hint used to be two lines of prose under EVERY goal without
                a KPI and dominated the list. Now it is one short line — but the
                action stays attached to the goal instead of a collective hint
                at the top, where you no longer know which goal is meant. */}
            {n.kpis.length === 0 && n.children.length === 0 && mine && (
              <p className={styles.goalEmptyHint}>
                {t("views.goals.unmeasurable")}{" "}
                <button className={styles.linkBtn}
                        onClick={() => setDraft({ kind: "kpi", parent: n })}>
                  {t("views.goals.addKpi")}
                </button>
              </p>
            )}
          </>
        )}
      </li>
    );
  };

  return (
    <div className={styles.goals}>
      <div className={styles.visionsHead}>
        <h3><Icon name="target" size={18} className={styles.inlineIcon} />{t("views.goals.title")}</h3>
        <div>
          <button className={styles.btnGhost} onClick={() => setDraft({ kind: "vision", parent: null })}>
            <Icon name="plus" size={14} className={styles.inlineIcon} />{t("views.goals.vision")}
          </button>
          <button className={styles.btnPrimary} onClick={() => setDraft({ kind: "goal", parent: null })}>
            <Icon name="plus" size={14} className={styles.inlineIcon} />{t("views.goals.goal")}
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.empty}>{t("views.goals.loading")}</div>}

      {!loading && tree.length === 0 && (
        <div className={styles.empty}>
          <Trans t={t} i18nKey="views.goals.empty" components={{ b: <strong /> }} />
        </div>
      )}

      <ul className={styles.goalTree}>{tree.map(renderNode)}</ul>

      {draft && (
        <DraftModal draft={draft} onClose={() => setDraft(null)}
                    onDone={() => { setDraft(null); refresh(); onChanged(); }} />
      )}

      {suggestFor && (
        <SuggestIdeasModal goalId={suggestFor.id} goalTitle={suggestFor.title}
                           onClose={() => setSuggestFor(null)}
                           onAccepted={() => { refresh(); onChanged(); }} />
      )}
    </div>
  );
}

/** Create a vision / goal / KPI. A KPI gets its baseline, target and due
 * date right here — without those three it can never produce a traffic light,
 * and in practice nobody goes back to fill in an empty form later. */
function DraftModal({ draft, onClose, onDone }: {
  draft: Draft; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation("wissen");
  const { kind, parent } = draft;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [unit, setUnit] = useState("");
  const [baseline, setBaseline] = useState("");
  const [target, setTarget] = useState("");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState("");
  const [source, setSource] = useState<KpiSource>({ kind: "manual" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "kpi") {
        const b = num(baseline);
        const ziel = num(target);
        if (ziel === null || Number.isNaN(ziel)) throw new Error(t("views.goals.targetRequired"));
        if (b !== null && Number.isNaN(b)) throw new Error(t("views.goals.baselineNaN"));
        const kpi = await ideasApi.createObject({
          type: "kpi",
          title: title.trim(),
          body: body.trim(),
          properties: {
            unit: unit.trim(),
            baseline: b,
            target: ziel,
            // Direction follows from target vs. baseline — the calculation
            // doesn't need it, the display does.
            direction: b !== null && ziel < b ? "down" : "up",
            start_date: start || null,
            due_date: due || null,
            source,
          },
        });
        if (parent) await ideasApi.createLink(parent.id, kpi.id, "measured_by");
      } else {
        await ideasApi.createObject({
          type: kind,
          title: title.trim(),
          body: body.trim(),
          parent_id: parent ? parent.id : null,
          properties: due ? { due_date: due } : {},
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("views.goals.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const heads: Record<NewKind, string> = {
    vision: t("views.goals.newVision"),
    goal: parent ? t("views.goals.subOf", { title: parent.title }) : t("views.goals.newGoal"),
    kpi: parent ? t("views.goals.kpiFor", { title: parent.title }) : t("views.goals.newKpi"),
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3>{heads[kind]}</h3>
          <button className={styles.iconBtn} onClick={onClose} title={t("app.close")}>
            <Icon name="close" size={18} title={t("app.close")} />
          </button>
        </div>

        <input className={styles.input} autoFocus value={title}
               placeholder={kind === "kpi" ? t("views.goals.whatMeasured") : t("views.goals.about")}
               onChange={(e) => setTitle(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && kind !== "kpi") void submit(); }} />
        <textarea className={styles.input} rows={2} value={body}
                  placeholder={t("views.goals.desc")}
                  onChange={(e) => setBody(e.target.value)} />

        {kind === "kpi" ? (
          <div className={styles.kpiForm}>
            <label>{t("views.goals.unit")}
              <input className={styles.input} value={unit} placeholder={t("views.goals.unitPlaceholder")}
                     onChange={(e) => setUnit(e.target.value)} />
            </label>
            <label>{t("views.goals.baseline")}
              <input className={styles.input} inputMode="decimal" value={baseline}
                     onChange={(e) => setBaseline(e.target.value)} />
            </label>
            <label>{t("views.goals.target")}
              <input className={styles.input} inputMode="decimal" value={target}
                     onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label>{t("views.goals.start")}
              <input className={styles.input} type="date" value={start}
                     onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>{t("views.goals.dueField")}
              <input className={styles.input} type="date" value={due}
                     onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
        ) : null}

        {kind === "kpi" ? (
          <KpiSourcePicker value={source} onChange={setSource} />
        ) : (
          <label className={styles.kpiFormRow}>{t("views.goals.dueOptional")}
            <input className={styles.input} type="date" value={due}
                   onChange={(e) => setDue(e.target.value)} />
          </label>
        )}

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.modalFoot}>
          <button className={styles.btnPrimary} disabled={!title.trim() || busy}
                  onClick={() => void submit()}>
            {t("views.goals.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
