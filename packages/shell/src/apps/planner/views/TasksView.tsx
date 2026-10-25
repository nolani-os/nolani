/** Tasks v2 — cross-project list with search, filters, selectable
 * sorting/grouping, smart lists (+ saved filters, persisted in prefs),
 * multi-select with bulk actions and inline edit (priority/due date). */
import { useEffect, useMemo, useRef, useState } from "react";
import { i18n, useTranslation } from "@claraos/core";
import styles from "../PlannerApp.module.css";
import { Icon } from "../../../components/Icon";
import { plannerApi } from "../api";
import type { VikLabel, VikProject, VikTask, VikUser } from "../types";
import { TaskRow, prioLabel } from "../shared";
import { BottomSheet } from "../../../components/BottomSheet";
import { PopupMenu } from "../../../components/PopupMenu";
import { Leerzustand } from "../../../components/Leerzustand";
import { useIsMobile } from "../../../Mobile/useIsMobile";
import {
  applyFilter, EMPTY_FILTER, gleicherFilter, groupTasks, isEmptyFilter, SMART_LISTS, sortTasks,
  type FilterState, type GroupKey, type SavedFilter, type SortKey,
} from "./taskQuery";

/** Option tables; `label` is a getter, so it is always in the current UI language. */
const SORT_KEYS: SortKey[] = ["due", "priority", "alpha", "created"];
const SORT_OPTIONS: { readonly key: SortKey; readonly label: string }[] = SORT_KEYS.map((key) => ({
  key, get label() { return i18n.t(`planner:views.tasks.sortOption.${key}`); },
}));
const GROUP_KEYS: GroupKey[] = ["due", "project", "priority", "label", "none"];
const GROUP_OPTIONS: { readonly key: GroupKey; readonly label: string }[] = GROUP_KEYS.map((key) => ({
  key, get label() { return i18n.t(`planner:views.tasks.groupOption.${key}`); },
}));
const DUE_FILTER_KEYS: Record<FilterState["due"], string> = {
  any: "dates.any", overdue: "dates.overdue", today: "dates.today", week: "dates.thisWeek", none: "dates.withoutDate",
};
const dueFilterLabel = (k: FilterState["due"]): string => i18n.t(`planner:${DUE_FILTER_KEYS[k]}`);

interface BulkProgress { done: number; total: number; label: string }

export function TasksView({
  tasks, projects, projectTitles, onToggle, onOpen, onReload,
}: {
  tasks: VikTask[];
  projects: VikProject[];
  projectTitles: Map<number, string>;
  onToggle: (t: VikTask) => void;
  onOpen: (t: VikTask) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation("planner");
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortKey>("due");
  const [group, setGroup] = useState<GroupKey>("due");
  // Multi-select is a mode, not a permanent state — while it is off, each row
  // carries exactly ONE checkbox (the one for completing).
  const [auswahlModus, setAuswahlModus] = useState(false);
  const [ansicht, setAnsicht] = useState<{ x: number; y: number } | null>(null);
  /** "Create task" in the empty state needs the field that accepts it. */
  const neuFeld = useRef<HTMLInputElement>(null);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [labels, setLabels] = useState<VikLabel[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<BulkProgress | null>(null);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newProject, setNewProject] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const filterPopRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    plannerApi.listLabels().then((l) => setLabels(l || [])).catch(() => undefined);
    plannerApi.getPlannerPrefs()
      .then((p) => Array.isArray(p.saved_filters) && setSavedFilters(p.saved_filters as SavedFilter[]))
      .catch(() => undefined);
  }, []);

  // Close the filter popover on outside click (desktop only — on mobile the
  // bottom sheet has its own backdrop)
  useEffect(() => {
    if (!filterOpen || isMobile) return;
    const close = (e: MouseEvent) => {
      if (!filterPopRef.current?.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [filterOpen]);

  const assigneeOptions = useMemo(() => {
    const m = new Map<number, VikUser>();
    tasks.forEach((x) => x.assignees?.forEach((a) => m.set(a.id, a)));
    return [...m.values()].sort((a, b) => a.username.localeCompare(b.username, "de"));
  }, [tasks]);

  const filteredOpen = useMemo(
    () => sortTasks(applyFilter(tasks, { ...filter, includeDone: false }), sort),
    [tasks, filter, sort],
  );
  const filteredDone = useMemo(
    () => applyFilter(tasks, { ...filter, includeDone: true }).filter((x) => x.done),
    [tasks, filter],
  );
  const groups = useMemo(
    () => groupTasks(filteredOpen, group, projectTitles),
    [filteredOpen, group, projectTitles],
  );

  // Important: which badge is highlighted is NOT stored in a separate flag —
  // it follows from the filter itself. So there is only one state, and the
  // highlight can no longer drift from reality.
  const alleListen = [...SMART_LISTS, ...savedFilters];
  const activeList = alleListen.find((l) => gleicherFilter(l.filter, filter))?.id ?? null;

  const setFilterManual = (f: FilterState) => setFilter(f);

  const applyList = (id: string, f: FilterState, s: SortKey, g: GroupKey) => {
    if (activeList === id) setFilter(EMPTY_FILTER);
    else { setFilter(f); setSort(s); setGroup(g); }
  };

  const persistSaved = async (next: SavedFilter[]) => {
    setSavedFilters(next);
    // PUT /prefs only merges top-level → read-modify-write the whole planner_app
    const prefs = await plannerApi.getPlannerPrefs();
    await plannerApi.savePlannerPrefs({ ...prefs, saved_filters: next });
  };

  const saveCurrentFilter = async () => {
    const label = saveName.trim();
    if (!label) return;
    const sf: SavedFilter = { id: `sf-${Date.now()}`, label, filter, sort, group };
    setSaveDialog(false); setSaveName("");
    await persistSaved([...savedFilters, sf]).catch(() => undefined);
  };

  const toggleSelect = (task: VikTask) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
      return next;
    });
  };
  const toggleSelectGroup = (items: VikTask[]) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const allIn = items.every((x) => next.has(x.id));
      items.forEach((x) => (allIn ? next.delete(x.id) : next.add(x.id)));
      return next;
    });
  };

  /** Bulk sequentially (no batch endpoint; read-modify-write per task). */
  const runBulk = async (label: string, fn: (id: number) => Promise<unknown>) => {
    const ids = [...selected];
    setBulkErrors([]);
    setBulk({ done: 0, total: ids.length, label });
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await fn(id);
      } catch (e) {
        errors.push(`#${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    setBulk(null);
    setSelected(new Set());
    setBulkErrors(errors);
    onReload();
  };

  const inlineEdit = async (task: VikTask, patch: Partial<VikTask>) => {
    try {
      await plannerApi.updateTaskFields(task.id, patch);
    } finally {
      onReload();
    }
  };

  const add = async () => {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const pid = newProject || projects.find((p) => p.title.toLowerCase() === "inbox")?.id || projects[0]?.id;
      if (!pid) throw new Error(t("errors.noProject"));
      await plannerApi.createTask(Number(pid), { title });
      setNewTitle("");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const filterChips: { label: string; clear: () => void }[] = [];
  if (filter.q.trim()) filterChips.push({ label: `„${filter.q.trim()}"`, clear: () => setFilterManual({ ...filter, q: "" }) });
  if (filter.priorityMin > 0) filterChips.push({ label: t("priority.chipMin", { level: filter.priorityMin }), clear: () => setFilterManual({ ...filter, priorityMin: 0 }) });
  filter.labelIds.forEach((id) => filterChips.push({
    label: `🏷 ${labels.find((l) => l.id === id)?.title ?? id}`,
    clear: () => setFilterManual({ ...filter, labelIds: filter.labelIds.filter((x) => x !== id) }),
  }));
  filter.projectIds.forEach((id) => filterChips.push({
    label: `📋 ${projectTitles.get(id) ?? id}`,
    clear: () => setFilterManual({ ...filter, projectIds: filter.projectIds.filter((x) => x !== id) }),
  }));
  if (filter.due !== "any") filterChips.push({ label: `📅 ${dueFilterLabel(filter.due)}`, clear: () => setFilterManual({ ...filter, due: "any" }) });
  if (filter.assigneeId != null) filterChips.push({
    label: `👤 ${assigneeOptions.find((a) => a.id === filter.assigneeId)?.username ?? filter.assigneeId}`,
    clear: () => setFilterManual({ ...filter, assigneeId: null }),
  });

  const toggleMulti = (arr: number[], id: number) =>
    arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];

  /* Filter contents — desktop popover AND mobile bottom sheet use the same. */
  const filterControls = (
    <>
      <div className={styles.fieldRow}>
        <label>{t("priority.label")}</label>
        <select className={styles.select} value={filter.priorityMin}
                onChange={(e) => setFilterManual({ ...filter, priorityMin: Number(e.target.value) })}>
          <option value={0}>{t("views.tasks.all")}</option>
          {[1, 2, 3, 4].map((p) => <option key={p} value={p}>≥ {prioLabel(p)}</option>)}
          <option value={5}>{prioLabel(5)}</option>
        </select>
      </div>
      <div className={styles.fieldRow}>
        <label>{t("dates.due")}</label>
        <select className={styles.select} value={filter.due}
                onChange={(e) => setFilterManual({ ...filter, due: e.target.value as FilterState["due"] })}>
          {(Object.keys(DUE_FILTER_KEYS) as FilterState["due"][]).map((k) => (
            <option key={k} value={k}>{dueFilterLabel(k)}</option>
          ))}
        </select>
      </div>
      {assigneeOptions.length > 0 && (
        <div className={styles.fieldRow}>
          <label>{t("detail.assigned")}</label>
          <select className={styles.select} value={filter.assigneeId ?? ""}
                  onChange={(e) => setFilterManual({ ...filter, assigneeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t("views.tasks.all")}</option>
            {assigneeOptions.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
          </select>
        </div>
      )}
      {isMobile && (
        <>
          <div className={styles.fieldRow}>
            <label>{t("views.tasks.sort")}</label>
            <select className={styles.select} value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div className={styles.fieldRow}>
            <label>{t("views.tasks.group")}</label>
            <select className={styles.select} value={group}
                    onChange={(e) => setGroup(e.target.value as GroupKey)}>
              {GROUP_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        </>
      )}
      {labels.length > 0 && (
        <div className={styles.filterGroup}>
          <span className={styles.filterGroupLabel}>{t("views.tasks.tags")}</span>
          <div className={styles.labelPicker}>
            {labels.map((l) => (
              <button key={l.id}
                      className={`${styles.labelChip} ${filter.labelIds.includes(l.id) ? styles.labelChipActive : ""}`}
                      style={l.hex_color ? { borderColor: `#${l.hex_color}` } : undefined}
                      onClick={() => setFilterManual({ ...filter, labelIds: toggleMulti(filter.labelIds, l.id) })}>
                {l.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.filterGroup}>
        <span className={styles.filterGroupLabel}>{t("nav.projects")}</span>
        <div className={styles.labelPicker}>
          {projects.map((p) => (
            <button key={p.id}
                    className={`${styles.labelChip} ${filter.projectIds.includes(p.id) ? styles.labelChipActive : ""}`}
                    onClick={() => setFilterManual({ ...filter, projectIds: toggleMulti(filter.projectIds, p.id) })}>
              {p.title}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.dialogActions}>
        <button className={styles.btn} onClick={() => setFilterManual(EMPTY_FILTER)}>{t("actions.reset")}</button>
        <button className={styles.btn} disabled={isEmptyFilter(filter)}
                onClick={() => { setFilterOpen(false); setSaveDialog(true); }}>
          {t("actions.saveEllipsis")}
        </button>
      </div>
    </>
  );

  return (
    <div className={styles.view}>
      <header className={styles.viewHeader}>
        <h2><Icon name="check" size={18} /> {t("nav.tasks")}</h2>
        <div className={styles.viewTools}>
          <input
            className={`${styles.input} ${styles.searchInput}`}
            placeholder={t("views.tasks.searchPlaceholder")}
            value={filter.q}
            onChange={(e) => setFilterManual({ ...filter, q: e.target.value })}
          />
          <div className={styles.filterWrap} ref={filterPopRef}>
            <button
              className={`${styles.btn} ${!isEmptyFilter(filter) ? styles.btnActive : ""}`}
              onClick={() => setFilterOpen((o) => !o)}
            >
              ⚙ {t("views.tasks.filter")}{filterChips.length > 0 ? ` (${filterChips.length})` : ""}
            </button>
            {filterOpen && !isMobile && (
              <div className={styles.filterPop}>{filterControls}</div>
            )}
          </div>
          {/* Warning (found visually): there used to be TWO native select
              fields side by side, both labelled "due date" — one sorted,
              the other grouped, and you could only tell them apart by the
              tiny ↕ or ⊞. Now one menu in which both questions are named. */}
          {!isMobile && (
            <div className={styles.filterWrap}>
              <button className={styles.btn} title={t("views.tasks.sortAndGroup")}
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setAnsicht(ansicht ? null : { x: r.left, y: r.bottom + 4 });
                      }}>
                ↕ {t("views.tasks.view")}
              </button>
              {ansicht && (
                <PopupMenu
                  x={ansicht.x} y={ansicht.y}
                  onClose={() => setAnsicht(null)}
                  items={[
                    { id: "s-kopf", label: t("views.tasks.sortBy"), disabled: true },
                    ...SORT_OPTIONS.map((o) => ({
                      id: `s-${o.key}`, label: o.label, checked: sort === o.key,
                      onSelect: () => setSort(o.key),
                    })),
                    { id: "trenner", label: "---" },
                    { id: "g-kopf", label: t("views.tasks.groupBy"), disabled: true },
                    ...GROUP_OPTIONS.map((o) => ({
                      id: `g-${o.key}`, label: o.label, checked: group === o.key,
                      onSelect: () => setGroup(o.key),
                    })),
                  ]}
                />
              )}
            </div>
          )}
          {/* Warning: each row carried TWO checkboxes — one for completing,
              one for selecting. Side by side they can't be told apart, and
              the selection checkbox is rarely needed. It now only appears in
              this mode. */}
          <button
            className={`${styles.btn} ${auswahlModus ? styles.btnActive : ""}`}
            title={auswahlModus ? t("views.tasks.endMultiSelect") : t("views.tasks.selectMultiple")}
            onClick={() => {
              setAuswahlModus((a) => !a);
              if (auswahlModus) setSelected(new Set());
            }}
          >
            <Icon name="check" size={13} /> {t("actions.select")}
          </button>
        </div>
      </header>

      {/* Mobile: filter/sort/group as a bottom sheet */}
      {isMobile && (
        <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title={t("views.tasks.filterAndSort")}>
          <div className={styles.filterSheetBody}>{filterControls}</div>
        </BottomSheet>
      )}

      <div className={styles.smartChips}>
        {SMART_LISTS.map((s) => (
          <button key={s.id}
                  className={`${styles.labelChip} ${activeList === s.id ? styles.labelChipActive : ""}`}
                  onClick={() => applyList(s.id, s.filter, s.sort, s.group)}>
            {s.label}
          </button>
        ))}
        {savedFilters.map((s) => (
          <span key={s.id} className={`${styles.labelChip} ${styles.savedChip} ${activeList === s.id ? styles.labelChipActive : ""}`}>
            <button className={styles.savedChipBtn} onClick={() => applyList(s.id, s.filter, s.sort, s.group)}>
              <Icon name="star" size={12} /> {s.label}
            </button>
            <button className={styles.savedChipDel} title={t("views.tasks.deleteSavedFilter")}
                    onClick={() => {
                      if (activeList === s.id) setFilter(EMPTY_FILTER);
                      persistSaved(savedFilters.filter((x) => x.id !== s.id)).catch(() => undefined);
                    }}><Icon name="close" size={14} title={t("actions.close")} /></button>
          </span>
        ))}
      </div>

      {/* Important: when a preset is active, its badge at the top already
          says everything — otherwise "📆 This week" and "📅 This week" would
          appear twice side by side (found visually). */}
      {filterChips.length > 0 && !activeList && (
        <div className={styles.activeChips}>
          {filterChips.map((c, i) => (
            <span key={i} className={`${styles.labelChip} ${styles.labelChipActive}`}>
              {c.label} <button className={styles.savedChipDel} onClick={c.clear}><Icon name="close" size={14} title={t("actions.close")} /></button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.quickAdd}>
        <input className={styles.input} ref={neuFeld} placeholder={t("views.tasks.newTaskPlaceholder")} value={newTitle}
               onChange={(e) => setNewTitle(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && add()} />
        <select className={styles.select} value={newProject}
                onChange={(e) => setNewProject(e.target.value ? Number(e.target.value) : "")}>
          <option value="">{t("views.tasks.inbox")}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <button aria-label={t("task.add")} title={t("task.add")} className={styles.btnPrimary} disabled={!newTitle.trim() || busy} onClick={add}>+</button>
      </div>

      {bulkErrors.length > 0 && (
        <div className={styles.errorBox}>
          {t("views.tasks.bulkFailed", { count: bulkErrors.length, list: bulkErrors.join(" · ") })}
          <button className={styles.btn} onClick={() => setBulkErrors([])}>{t("actions.ok")}</button>
        </div>
      )}

      {groups.map(({ id, label, tasks: items }) => (
        <section key={id} className={styles.section}>
          <h3 className={`${styles.sectionTitle} ${id === "due:overdue" ? styles.overdue : ""}`}>
            {auswahlModus && (
              <input type="checkbox" className={styles.selectCheck}
                     checked={items.length > 0 && items.every((x) => selected.has(x.id))}
                     title={t("views.tasks.selectGroup")}
                     onChange={() => toggleSelectGroup(items)} />
            )}
            {label} <span className={styles.count}>{items.length}</span>
          </h3>
          {items.map((task) => (
            <TaskRow key={task.id} task={task}
                     projectTitle={group !== "project" ? projectTitles.get(task.project_id) : undefined}
                     selected={selected.has(task.id)}
                     onSelectToggle={auswahlModus ? toggleSelect : undefined}
                     onInlineEdit={isMobile ? undefined : inlineEdit}
                     onToggle={onToggle} onOpen={onOpen} />
          ))}
        </section>
      ))}
      {filteredOpen.length === 0 && (
        isEmptyFilter(filter) ? (
          <Leerzustand
            symbol="✓"
            titel={t("views.tasks.nothingOpen")}
            hinweis={t("views.tasks.nothingOpenHint")}
            aktionen={[{ label: `＋ ${t("views.tasks.createTask")}`, onClick: () => neuFeld.current?.focus() }]}
          />
        ) : (
          <Leerzustand
            symbol="⚙"
            titel={t("views.tasks.noResults")}
            hinweis={t("views.tasks.noResultsHint")}
            aktionen={[{ label: t("views.tasks.resetFilter"), zweitrangig: true,
                         onClick: () => setFilter(EMPTY_FILTER) }]}
          />
        )
      )}

      {filteredDone.length > 0 && (
        <section className={styles.section}>
          <button className={styles.doneToggle} onClick={() => setShowDone((s) => !s)}>
            {showDone ? "▾" : "▸"} {t("views.tasks.doneCount", { count: filteredDone.length })}
          </button>
          {showDone && filteredDone.map((task) => (
            <TaskRow key={task.id} task={task} projectTitle={projectTitles.get(task.project_id)}
                     onToggle={onToggle} onOpen={onOpen} />
          ))}
        </section>
      )}

      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          {bulk ? (
            <span className={styles.bulkProgress}>{bulk.label}: {bulk.done}/{bulk.total}…</span>
          ) : (
            <>
              <span className={styles.bulkCount}>{t("views.tasks.selectedCount", { count: selected.size })}</span>
              <button className={styles.btn}
                      onClick={() => runBulk(t("actions.complete"), (id) => plannerApi.updateTaskFields(id, { done: true }))}>
                <Icon name="check" size={13} /> {t("actions.complete")}
              </button>
              <select className={styles.select} value="" title={t("priority.set")}
                      onChange={(e) => {
                        if (e.target.value === "") return;
                        const prio = Number(e.target.value);
                        runBulk(t("priority.set"), (id) => plannerApi.updateTaskFields(id, { priority: prio }));
                      }}>
                <option value="">⚑ {t("priority.shortEllipsis")}</option>
                {[0, 1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{prioLabel(p)}</option>)}
              </select>
              <select className={styles.select} value="" title={t("views.tasks.moveTitle")}
                      onChange={(e) => {
                        if (e.target.value === "") return;
                        const pid = Number(e.target.value);
                        runBulk(t("views.tasks.move"), (id) => plannerApi.updateTaskFields(id, { project_id: pid }));
                      }}>
                <option value="">📋 {t("views.tasks.moveEllipsis")}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
              <button className={styles.btnDanger}
                      onClick={() => {
                        if (window.confirm(t("views.tasks.confirmBulkDelete", { count: selected.size }))) {
                          runBulk(t("actions.delete"), (id) => plannerApi.deleteTask(id));
                        }
                      }}>
                {t("actions.delete")}
              </button>
              <button className={styles.btn}
                      onClick={() => { setSelected(new Set()); setAuswahlModus(false); }}>{t("actions.cancel")}</button>
            </>
          )}
        </div>
      )}

      {saveDialog && (
        <div className={styles.dialogOverlay} onClick={() => setSaveDialog(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3>{t("views.tasks.saveFilter")}</h3>
            <input className={styles.input} autoFocus placeholder={t("views.tasks.filterNamePlaceholder")}
                   value={saveName} onChange={(e) => setSaveName(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && saveCurrentFilter()} />
            <div className={styles.dialogActions}>
              <button className={styles.btn} onClick={() => setSaveDialog(false)}>{t("actions.cancel")}</button>
              <button className={styles.btnPrimary} disabled={!saveName.trim()} onClick={saveCurrentFilter}>{t("actions.save")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
