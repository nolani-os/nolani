// Home-screen layout model for the mobile shell.
//
// Android-style: multiple home *pages*, each a fixed grid of cells, plus a
// persistent *dock* row shared across all pages. Icons are placed at explicit
// grid positions (drag & drop), not just appended like the old pin list.
// v3 adds *widgets*: multi-cell rectangles (col/row/w/h per page) that live in
// a parallel array so the icon cell model stays untouched.
//
// Persisted to localStorage. Migrations lift v2 layouts (and the even older
// per-workspace pin arrays) forward so existing users don't lose anything.

export const GRID_COLS = 4;
export const GRID_ROWS = 5;
export const CELLS_PER_PAGE = GRID_COLS * GRID_ROWS; // 20
export const DOCK_SIZE = 3; // 3 app slots — the Clara button occupies column 1

/** A home-screen widget instance occupying a col/row/w/h rectangle on a page. */
export interface MobileWidget {
  id: string;
  type: string; // widget registry key, e.g. "flip-clock-weather"
  page: number;
  col: number; // 0..GRID_COLS-1
  row: number; // 0..GRID_ROWS-1
  w: number; // width in cells (1..GRID_COLS)
  h: number; // height in cells (1..GRID_ROWS)
  config?: Record<string, unknown>;
}

// pages[p][cellIndex] = appId | null (empty cell). dock = compact appId list.
export interface HomeLayout {
  pages: (string | null)[][];
  dock: string[];
  widgets: MobileWidget[];
}

const LAYOUT_KEY = "claraos.mobile.homeLayout.v4";
const V3_KEY = "claraos.mobile.homeLayout.v3"; // migrated on load (clock 4x3)
const V2_KEY = "claraos.mobile.homeLayout.v2"; // kept in place as rollback backup
const LEGACY_WORKSPACES_KEY = "claraos.mobile.workspaces";
const LEGACY_PINS_KEY = "claraos.mobile.pins";

// Sensible first-run layout: a few core apps on page 0 + a dock.
// Android-style favourites tray next to the fixed assistant button: the built-in
// Teams and Post apps and the browser. It used to name nextcloud-talk and
// bulwark-mail, which only exist in some installations — elsewhere (the demo
// cell) the tray showed the browser alone.
export const DEFAULT_DOCK = ["teams-workspace", "post", "selkies-browser"];
// First-run icons; this installation sets its own (heim.config.ts).
const heimConfig = import.meta.glob<{ MOBILE_DEFAULT_PAGE0?: string[] }>("../heim.config.ts", { eager: true });
const DEFAULT_PAGE0: string[] = Object.values(heimConfig)[0]?.MOBILE_DEFAULT_PAGE0 ?? [
  "open-webui", "nextcloud", "immich",
];

// Default widgets mirror a common Android home-screen layout: a tall 4x3 flip-clock+weather
// on top (clock, big cloud, date+temp, 5-day), a 2-row calendar agenda below —
// together they fill page 0's five rows; app icons live on page 1.
const DEFAULT_CLOCK_WIDGET: MobileWidget =
  { id: "w-clock-0", type: "flip-clock-weather", page: 0, col: 0, row: 0, w: 4, h: 3 };
const DEFAULT_AGENDA_WIDGET: MobileWidget =
  { id: "w-agenda-0", type: "calendar-agenda", page: 0, col: 0, row: 3, w: 4, h: 2 };

function emptyPage(): (string | null)[] {
  return new Array(CELLS_PER_PAGE).fill(null);
}

function sanitizePage(raw: unknown): (string | null)[] {
  const page = emptyPage();
  if (Array.isArray(raw)) {
    for (let i = 0; i < CELLS_PER_PAGE; i++) {
      const v = raw[i];
      page[i] = typeof v === "string" && v ? v : null;
    }
  }
  return page;
}

/** Drop malformed/out-of-bounds widgets; drop overlapping duplicates (first wins).
 *  Runs on every load so a bad persist can never brick the homescreen. */
function sanitizeWidgets(raw: unknown, pages: (string | null)[][]): MobileWidget[] {
  if (!Array.isArray(raw)) return [];
  const out: MobileWidget[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const { id, type, page, col, row, w: ww, h } = w as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof type !== "string" || !type) continue;
    if (![page, col, row, ww, h].every((n) => typeof n === "number" && Number.isInteger(n))) continue;
    const wg: MobileWidget = {
      id, type,
      page: page as number, col: col as number, row: row as number,
      w: ww as number, h: h as number,
      config: (w as MobileWidget).config,
    };
    if (wg.page < 0 || wg.w < 1 || wg.h < 1) continue;
    if (wg.col < 0 || wg.row < 0 || wg.col + wg.w > GRID_COLS || wg.row + wg.h > GRID_ROWS) continue;
    if (out.some((o) => o.id === wg.id || (o.page === wg.page && rectOverlap(o, wg)))) continue;
    // Overlapping an icon cell is tolerated on load (icons win visually is
    // worse than dropping the widget) — drop the widget, keep icons intact.
    const cells = widgetCoveredCells(wg);
    const pg = pages[wg.page];
    if (pg && cells.some((c) => pg[c] !== null)) continue;
    out.push(wg);
  }
  return out;
}

function buildDefault(): HomeLayout {
  // Page 0 is fully occupied by the two widgets (clock 4x3 + agenda 4x2), so
  // all default app icons go on page 1.
  const page0 = emptyPage();
  const page1 = emptyPage();
  DEFAULT_PAGE0.forEach((id, i) => { if (i < CELLS_PER_PAGE) page1[i] = id; });
  return {
    pages: [page0, page1],
    dock: [...DEFAULT_DOCK],
    widgets: [{ ...DEFAULT_CLOCK_WIDGET }, { ...DEFAULT_AGENDA_WIDGET }],
  };
}

// Place a flat list of appIds into freshly created grid pages.
function placeSequential(ids: string[]): (string | null)[][] {
  const pages: (string | null)[][] = [];
  let page = emptyPage();
  let cell = 0;
  for (const id of ids) {
    if (cell >= CELLS_PER_PAGE) {
      pages.push(page);
      page = emptyPage();
      cell = 0;
    }
    page[cell++] = id;
  }
  pages.push(page);
  return pages;
}

function migrateLegacy(): HomeLayout | null {
  try {
    const wsRaw = localStorage.getItem(LEGACY_WORKSPACES_KEY);
    let pins: string[] = [];
    if (wsRaw) {
      const ws = JSON.parse(wsRaw);
      if (ws && typeof ws === "object") {
        // Prefer the "main" workspace; fall back to the union of all.
        const main = Array.isArray(ws.main) ? ws.main : [];
        const all = Object.values(ws).flat().filter((x): x is string => typeof x === "string");
        pins = (main.length ? main : all);
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_PINS_KEY);
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) pins = arr.filter((x) => typeof x === "string");
      }
    }
    if (!pins.length) return null;
    const uniq = [...new Set(pins)];
    const dock = uniq.slice(0, DOCK_SIZE);
    const rest = uniq.slice(DOCK_SIZE);
    const pages = rest.length ? placeSequential(rest) : [emptyPage()];
    return { pages, dock, widgets: defaultWidgetsIfFree(pages) };
  } catch {
    return null;
  }
}

/** One-shot lift for pre-4x3 layouts: early v4 defaults stored the clock as
 *  4x2. There is no resize UI, so a smaller clock is always a legacy artifact,
 *  never a user choice — and at 4x2 the widget cannot reach the reference
 *  look. Grow it to 4x3 when the row below can be made free: it must hold no
 *  icons, and at most one full-width widget directly below (the default
 *  agenda) that can slide down one row into icon-free space. Otherwise the
 *  layout is returned unchanged. Idempotent (h>=3 → no-op). */
function liftLegacyClock(layout: HomeLayout): HomeLayout {
  const clock = layout.widgets.find((w) => w.type === "flip-clock-weather");
  if (!clock || clock.h >= 3 || clock.w !== GRID_COLS) return layout;
  const page = layout.pages[clock.page];
  if (!page) return layout;
  const iconInRows = (from: number, to: number) => {
    for (let r = from; r <= to; r++) {
      for (let c = 0; c < GRID_COLS; c++) if (page[r * GRID_COLS + c]) return true;
    }
    return false;
  };
  const growRow = clock.row + clock.h; // the row the clock expands into
  if (growRow >= GRID_ROWS || iconInRows(growRow, growRow)) return layout;
  const others = layout.widgets.filter((w) => w !== clock && w.page === clock.page);
  const blockers = others.filter((w) => w.row <= growRow && growRow < w.row + w.h);
  if (blockers.length === 0) {
    return { ...layout, widgets: layout.widgets.map((w) => (w === clock ? { ...w, h: 3 } : w)) };
  }
  if (blockers.length === 1) {
    const b = blockers[0];
    const newBottom = b.row + 1 + b.h;
    const slideOk =
      b.row === growRow && b.w === GRID_COLS && newBottom <= GRID_ROWS &&
      !iconInRows(b.row + b.h, newBottom - 1) &&
      !others.some((o) => o !== b && o.row < newBottom && o.row + o.h > b.row + 1);
    if (slideOk) {
      return {
        ...layout,
        widgets: layout.widgets.map((w) =>
          w === clock ? { ...w, h: 3 } : w === b ? { ...w, row: b.row + 1 } : w,
        ),
      };
    }
  }
  return layout;
}

/** An empty favourites row is useless (the Clara button is fixed anyway) —
 *  refill it with the defaults on load, skipping apps the user already
 *  placed on the grid. Docks with 1+ apps are a user choice and stay. */
function refillEmptyDock(layout: HomeLayout): HomeLayout {
  if (layout.dock.length > 0) return layout;
  const used = new Set(layout.pages.flat().filter(Boolean));
  const dock = DEFAULT_DOCK.filter((id) => !used.has(id)).slice(0, DOCK_SIZE);
  if (!dock.length) return layout;
  return { ...layout, dock };
}

/** Non-destructive widget defaults for migrated users: only claim rows that
 *  hold no icons on page 0. Icons are NEVER moved during migration. */
function defaultWidgetsIfFree(pages: (string | null)[][]): MobileWidget[] {
  const p0 = pages[0];
  if (!p0) return [];
  const rowsFree = (from: number, to: number) => {
    for (let r = from; r <= to; r++) {
      for (let c = 0; c < GRID_COLS; c++) if (p0[r * GRID_COLS + c] !== null) return false;
    }
    return true;
  };
  // clock is 4x3 (rows 0-2), agenda 4x2 (rows 3-4).
  if (rowsFree(0, 4)) return [{ ...DEFAULT_CLOCK_WIDGET }, { ...DEFAULT_AGENDA_WIDGET }];
  if (rowsFree(0, 2)) return [{ ...DEFAULT_CLOCK_WIDGET }];
  return [];
}

function parseIconLayout(raw: string): { pages: (string | null)[][]; dock: string[] } | null {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.pages) || !Array.isArray(parsed.dock)) return null;
  const pages = parsed.pages.length ? parsed.pages.map(sanitizePage) : [emptyPage()];
  const dock = parsed.dock
    .filter((x: unknown): x is string => typeof x === "string")
    .slice(0, DOCK_SIZE);
  return { pages, dock };
}

export function loadHomeLayout(): HomeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const base = parseIconLayout(raw);
      if (base) {
        const parsed = JSON.parse(raw);
        const loaded: HomeLayout = { ...base, widgets: sanitizeWidgets(parsed.widgets, base.pages) };
        const normalized = refillEmptyDock(liftLegacyClock(loaded));
        if (normalized !== loaded) saveHomeLayout(normalized);
        return normalized;
      }
    }
    // v3 → v4: the clock widget grows to 4x3, so page 0 becomes widgets-only;
    // all existing app icons move to page 1+, the dock is preserved.
    const v3raw = localStorage.getItem(V3_KEY);
    if (v3raw) {
      const base = parseIconLayout(v3raw);
      if (base) {
        const allIcons = base.pages.flat().filter((x): x is string => !!x);
        const iconPages = allIcons.length ? placeSequential(allIcons) : [emptyPage()];
        const migrated: HomeLayout = {
          pages: [emptyPage(), ...iconPages],
          dock: base.dock,
          widgets: [{ ...DEFAULT_CLOCK_WIDGET }, { ...DEFAULT_AGENDA_WIDGET }],
        };
        saveHomeLayout(migrated);
        return migrated;
      }
    }
    // v2 → v4: keep icons/dock verbatim, add default widgets only into free
    // rows. The v2 key stays in localStorage as a rollback backup.
    const v2raw = localStorage.getItem(V2_KEY);
    if (v2raw) {
      const base = parseIconLayout(v2raw);
      if (base) {
        const migrated: HomeLayout = { ...base, widgets: defaultWidgetsIfFree(base.pages) };
        saveHomeLayout(migrated);
        return migrated;
      }
    }
    const migrated = migrateLegacy();
    if (migrated) {
      saveHomeLayout(migrated);
      return migrated;
    }
  } catch { /* ignore */ }
  return buildDefault();
}

export function saveHomeLayout(layout: HomeLayout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

// --- Pure layout transforms (return new layout, never mutate) ---

// `?? []` throughout: transforms stay tolerant of pre-v3 {pages,dock} shapes.
const clone = (l: HomeLayout): HomeLayout => ({
  pages: l.pages.map((p) => [...p]),
  dock: [...l.dock],
  widgets: (l.widgets ?? []).map((w) => ({ ...w })),
});

export function isOnHome(layout: HomeLayout, appId: string): boolean {
  return layout.dock.includes(appId) || layout.pages.some((p) => p.includes(appId));
}

function removeEverywhere(l: HomeLayout, appId: string) {
  l.dock = l.dock.filter((id) => id !== appId);
  for (const page of l.pages) {
    for (let i = 0; i < page.length; i++) if (page[i] === appId) page[i] = null;
  }
}

// --- Widget geometry helpers ---

type Rect = { col: number; row: number; w: number; h: number };

function rectOverlap(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w
    && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** Cell indices covered by a widget rect — for icon collision checks. */
export function widgetCoveredCells(wg: Rect): number[] {
  const cells: number[] = [];
  for (let r = wg.row; r < wg.row + wg.h; r++) {
    for (let c = wg.col; c < wg.col + wg.w; c++) cells.push(r * GRID_COLS + c);
  }
  return cells;
}

/** Set of cells covered by any widget on the given page. */
export function coveredCellsOnPage(layout: HomeLayout, pageIdx: number): Set<number> {
  const covered = new Set<number>();
  for (const wg of layout.widgets ?? []) {
    if (wg.page !== pageIdx) continue;
    for (const c of widgetCoveredCells(wg)) covered.add(c);
  }
  return covered;
}

/** True iff a w×h widget anchored at col/row fits on the page: inside the
 *  grid, no overlap with other widgets, no overlap with icon cells. */
export function canPlaceWidget(
  layout: HomeLayout, pageIdx: number, col: number, row: number, w: number, h: number,
  ignoreId?: string,
): boolean {
  if (col < 0 || row < 0 || w < 1 || h < 1) return false;
  if (col + w > GRID_COLS || row + h > GRID_ROWS) return false;
  const rect: Rect = { col, row, w, h };
  for (const wg of layout.widgets ?? []) {
    if (wg.page !== pageIdx || wg.id === ignoreId) continue;
    if (rectOverlap(wg, rect)) return false;
  }
  const page = layout.pages[pageIdx];
  if (page) {
    for (const c of widgetCoveredCells(rect)) if (page[c] !== null) return false;
  }
  return true;
}

/** First anchor (row-major) where a w×h widget fits on the page, or null. */
export function firstFreeWidgetRect(
  layout: HomeLayout, pageIdx: number, w: number, h: number,
): { col: number; row: number } | null {
  for (let row = 0; row + h <= GRID_ROWS; row++) {
    for (let col = 0; col + w <= GRID_COLS; col++) {
      if (canPlaceWidget(layout, pageIdx, col, row, w, h)) return { col, row };
    }
  }
  return null;
}

let widgetCounter = 0;
function newWidgetId(): string {
  return `w-${Date.now().toString(36)}-${widgetCounter++}`;
}

/** Add a new widget instance. Tries `at` first, then the first free rect on
 *  at.page (default 0) and all later pages, finally a fresh page. */
export function addWidget(
  layout: HomeLayout, type: string, w: number, h: number,
  at?: { page: number; col: number; row: number }, config?: Record<string, unknown>,
): HomeLayout {
  const l = clone(layout);
  const wg: MobileWidget = { id: newWidgetId(), type, page: 0, col: 0, row: 0, w, h, config };
  if (at && canPlaceWidget(l, at.page, at.col, at.row, w, h)) {
    Object.assign(wg, at);
  } else {
    let placed = false;
    for (let p = at?.page ?? 0; p < l.pages.length; p++) {
      const spot = firstFreeWidgetRect(l, p, w, h);
      if (spot) { wg.page = p; wg.col = spot.col; wg.row = spot.row; placed = true; break; }
    }
    if (!placed) {
      l.pages.push(emptyPage());
      wg.page = l.pages.length - 1; wg.col = 0; wg.row = 0;
    }
  }
  while (l.pages.length <= wg.page) l.pages.push(emptyPage());
  l.widgets.push(wg);
  return l;
}

/** Move a widget to page/col/row. Invalid targets return the SAME layout
 *  reference so the caller can treat it as a snap-back no-op. */
export function moveWidget(
  layout: HomeLayout, id: string, pageIdx: number, col: number, row: number,
): HomeLayout {
  const wg = (layout.widgets ?? []).find((x) => x.id === id);
  if (!wg || pageIdx < 0) return layout;
  const c = Math.max(0, Math.min(col, GRID_COLS - wg.w));
  const r = Math.max(0, Math.min(row, GRID_ROWS - wg.h));
  if (!canPlaceWidget(layout, pageIdx, c, r, wg.w, wg.h, id)) return layout;
  const l = clone(layout);
  while (l.pages.length <= pageIdx) l.pages.push(emptyPage());
  const moved = l.widgets.find((x) => x.id === id)!;
  moved.page = pageIdx; moved.col = c; moved.row = r;
  return l;
}

/** True iff a w×h widget anchored at col/row is INSIDE the grid — occupancy
 *  is ignored. Drop preview for the displacing move: everything that fits the
 *  page bounds is a valid (green) target, occupants make way on drop. */
export function widgetRectInBounds(col: number, row: number, w: number, h: number): boolean {
  return col >= 0 && row >= 0 && col + w <= GRID_COLS && row + h <= GRID_ROWS;
}

/** Move a widget to page/col/row, DISPLACING whatever occupies the target:
 *  overlapped widgets are relocated to the first free rect (row-major, from
 *  page 0, fresh page as last resort), covered icons to the first free cell —
  *  same convention as the dock ("displaced items move to the first free
  *  slot"). Only out-of-bounds targets snap back (same-reference return). */
export function moveWidgetDisplacing(
  layout: HomeLayout, id: string, pageIdx: number, col: number, row: number,
): HomeLayout {
  const simple = moveWidget(layout, id, pageIdx, col, row);
  if (simple !== layout) return simple;
  const wg = (layout.widgets ?? []).find((x) => x.id === id);
  if (!wg || pageIdx < 0) return layout;
  const c = Math.max(0, Math.min(col, GRID_COLS - wg.w));
  const r = Math.max(0, Math.min(row, GRID_ROWS - wg.h));
  if (!widgetRectInBounds(c, r, wg.w, wg.h)) return layout;

  const l = clone(layout);
  while (l.pages.length <= pageIdx) l.pages.push(emptyPage());
  const rect: Rect = { col: c, row: r, w: wg.w, h: wg.h };
  // Anchor the dragged widget FIRST so displaced occupants can't take the spot.
  const moved = l.widgets.find((x) => x.id === id)!;
  moved.page = pageIdx; moved.col = c; moved.row = r;
  // Covered icons → first free cell anywhere.
  const page = l.pages[pageIdx];
  for (const cell of widgetCoveredCells(rect)) {
    const appId = page[cell];
    if (appId !== null) { page[cell] = null; placeFirstFree(l, appId); }
  }
  // Overlapped widgets → first rect that fits (fresh page as last resort).
  const blockers = l.widgets.filter((x) => x.id !== id && x.page === pageIdx && rectOverlap(x, rect));
  for (const b of blockers) {
    let placed = false;
    for (let p = 0; p < l.pages.length && !placed; p++) {
      for (let row2 = 0; row2 + b.h <= GRID_ROWS && !placed; row2++) {
        for (let col2 = 0; col2 + b.w <= GRID_COLS && !placed; col2++) {
          if (canPlaceWidget(l, p, col2, row2, b.w, b.h, b.id)) {
            b.page = p; b.col = col2; b.row = row2; placed = true;
          }
        }
      }
    }
    if (!placed) {
      l.pages.push(emptyPage());
      b.page = l.pages.length - 1; b.col = 0; b.row = 0;
    }
  }
  trimTrailingPages(l);
  return l;
}

export function removeWidget(layout: HomeLayout, id: string): HomeLayout {
  const l = clone(layout);
  l.widgets = l.widgets.filter((w) => w.id !== id);
  trimTrailingPages(l);
  return l;
}

/** A page is empty when it has no icons AND no widgets. */
function pageIsEmpty(l: HomeLayout, idx: number): boolean {
  return l.pages[idx].every((c) => c === null)
    && !(l.widgets ?? []).some((w) => w.page === idx);
}

/** Trim trailing empty pages (keep at least one). Only trailing pages are
 *  ever removed so widget page indices always stay valid. */
function trimTrailingPages(l: HomeLayout) {
  while (l.pages.length > 1 && pageIsEmpty(l, l.pages.length - 1)) {
    l.pages.pop();
  }
}

/** Place appId into a specific page+cell. If the cell is occupied, the
 *  existing icon is pushed to the nearest free cell on that page. Cells
 *  covered by a widget are rejected (same-ref return = snap back). */
export function placeOnGrid(
  layout: HomeLayout, appId: string, pageIdx: number, cell: number,
): HomeLayout {
  const covered = coveredCellsOnPage(layout, pageIdx);
  if (covered.has(cell)) return layout;
  const l = clone(layout);
  removeEverywhere(l, appId);
  while (l.pages.length <= pageIdx) l.pages.push(emptyPage());
  const page = l.pages[pageIdx];
  const occupant = page[cell];
  page[cell] = appId;
  if (occupant && occupant !== appId) {
    const free = page.findIndex((c, i) => c === null && !covered.has(i));
    if (free >= 0) page[free] = occupant;
    // if page full, occupant is dropped silently (edge case)
  }
  return l;
}

export function addToDock(layout: HomeLayout, appId: string): HomeLayout {
  const l = clone(layout);
  if (l.dock.includes(appId)) return l;
  if (l.dock.length >= DOCK_SIZE) return layout; // dock full → no-op
  removeEverywhere(l, appId);
  l.dock.push(appId);
  return l;
}

/** First free icon cell across pages (appends a page when everything is full). */
function placeFirstFree(l: HomeLayout, appId: string) {
  for (let p = 0; p < l.pages.length; p++) {
    // Skip cells covered by widgets: an icon parked under a widget is
    // invisible AND makes sanitizeWidgets drop that widget on next load.
    const covered = coveredCellsOnPage(l, p);
    const i = l.pages[p].findIndex((c, idx) => c === null && !covered.has(idx));
    if (i >= 0) { l.pages[p][i] = appId; return; }
  }
  const page = emptyPage();
  page[0] = appId;
  l.pages.push(page);
}

/** Drop an app onto a specific dock slot (drag & drop, like the home grid):
 *  reorders within the dock, fills a free slot, or — when the dock is full —
 *  swaps: the displaced app moves to the first free grid cell. */
export function addToDockAt(layout: HomeLayout, appId: string, slot: number): HomeLayout {
  const l = clone(layout);
  const wasInDock = l.dock.includes(appId);
  const displaced = !wasInDock && l.dock.length >= DOCK_SIZE
    ? l.dock[Math.max(0, Math.min(slot, l.dock.length - 1))]
    : null;
  removeEverywhere(l, appId);
  if (displaced) l.dock = l.dock.filter((id) => id !== displaced);
  const s = Math.max(0, Math.min(slot, l.dock.length));
  l.dock.splice(s, 0, appId);
  l.dock = l.dock.slice(0, DOCK_SIZE);
  if (displaced) placeFirstFree(l, displaced);
  return l;
}

export function removeFromHome(layout: HomeLayout, appId: string): HomeLayout {
  const l = clone(layout);
  removeEverywhere(l, appId);
  trimTrailingPages(l);
  return l;
}

/** Ensure there is always one trailing empty page to drop onto (Android-like). */
export function withTrailingEmptyPage(layout: HomeLayout): HomeLayout {
  const lastIdx = layout.pages.length - 1;
  const lastUsed = layout.pages[lastIdx]?.some((c) => c !== null)
    || (layout.widgets ?? []).some((w) => w.page === lastIdx);
  if (lastUsed) {
    return {
      pages: [...layout.pages, emptyPage()],
      dock: layout.dock,
      widgets: layout.widgets ?? [],
    };
  }
  return layout;
}
