/** Icon set of the Idea Suite — hand-drawn.
 *
 * Why no emoji: emoji look different on every device (Apple, Android and
 * Windows render the same string differently), cannot be colored, do not
 * scale with the font, are read out literally by screen readers ("red
 * circle") and only cover what happens to have an emoji. They therefore look
 * arbitrary — "very AI-like".
 *
 * Why no library: all apps share the shell bundle. For two dozen glyphs a
 * package is not worth it, and an own set keeps the meanings (vision, metric,
 * kaizen) precise instead of bending them to foreign metaphors.
 *
 * Rules of the set — they apply WITHOUT EXCEPTION, otherwise it looks
 * cobbled together again:
 *   · grid 24 × 24, usable area 20 × 20 (2 px margin stays free)
 *   · stroke width 1.5 · round caps and joins · no fill
 *   · `currentColor` — color always comes from outside (status, text, mode)
 *   · basic shapes instead of freehand paths
 *   · optical compensation: a circle may be slightly larger than a
 *     square, otherwise it looks smaller
 *
 * Accessibility: `aria-hidden` by default, because a word stands next to
 * every icon. Only when a button consists ONLY of the icon does it get a
 * name via `title`.
 */
import type { CSSProperties } from "react";

export type IconName =
  // Views
  | "dashboard" | "board" | "list" | "target" | "matrix" | "horizon" | "graph"
  // Object kinds
  | "vision" | "goal" | "kpi" | "idea" | "concept" | "analysis"
  // States
  | "done" | "on_track" | "at_risk" | "blind" | "behind"
  // Actions and signs
  | "plus" | "chevronRight" | "chevronDown" | "close" | "plan" | "sparkle"
  | "warning" | "trendUp" | "trendDown" | "trendFlat" | "more"
  // Planner and Knowledge (stage 3)
  | "check" | "calendar" | "today" | "collections" | "document" | "note"
  | "star" | "bell" | "trash" | "people" | "person" | "globe"
  | "import" | "export" | "comment" | "money" | "link" | "archive"
  | "blocked" | "flag" | "attachment" | "arrowUp" | "mail" | "repeat"
  | "restore" | "search" | "lock" | "lockOpen"
  // System and shell — replace the emoji in quick settings and
  // navigation.
  | "wifi" | "bluetooth" | "moon" | "dnd" | "mic" | "vibrate" | "fullscreen"
  | "devices" | "hotspot" | "sun" | "volume" | "volumeOff" | "gear" | "pen"
  | "power" | "history" | "camera" | "home" | "folder" | "android"
  | "flashlight" | "battery" | "share" | "arrowRight" | "chevronLeft"
  | "play" | "reload" | "back" | "recents" | "textSize" | "cube" | "image" | "copy" | "scissors" | "terminal" | "cloud" | "radar";

/* All shapes live in the 24 grid. Numbers are deliberately "uneven" (9.5 instead
   of 10) where optical compensation requires it. */
const FORMEN: Record<IconName, React.ReactNode> = {
  // ── Views ──────────────────────────────────────────────────────────────
  // Overview: three bars of different height on a baseline.
  dashboard: (<>
    <path d="M4 20h16" />
    <path d="M7 20v-6" /><path d="M12 20V7" /><path d="M17 20v-9" />
  </>),
  // Board: three columns (kanban).
  board: (<>
    <rect x="3.5" y="4.5" width="4.5" height="15" rx="1.5" />
    <rect x="9.75" y="4.5" width="4.5" height="10" rx="1.5" />
    <rect x="16" y="4.5" width="4.5" height="13" rx="1.5" />
  </>),
  // List: three rows with bullets.
  list: (<>
    <path d="M4 6.5h.01" /><path d="M8 6.5h12" />
    <path d="M4 12h.01" /><path d="M8 12h12" />
    <path d="M4 17.5h.01" /><path d="M8 17.5h12" />
  </>),
  // Goal: target. Circles may be slightly larger than a square.
  target: (<>
    <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="1" />
  </>),
  // Matrix: four-quadrant grid.
  matrix: (<>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M12 3.5v17" /><path d="M3.5 12h17" />
  </>),
  // Vision/horizon: sun above the line — looking ahead, not a "sunrise emoji".
  horizon: (<>
    <path d="M3 18h18" />
    <path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
    <path d="M12 5.5v2" /><path d="M5.6 8.1l1.4 1.4" /><path d="M18.4 8.1l-1.4 1.4" />
  </>),
  // Graph: three nodes, two edges.
  graph: (<>
    <circle cx="6" cy="17.5" r="2.5" /><circle cx="12" cy="6.5" r="2.5" />
    <circle cx="18" cy="15.5" r="2.5" />
    <path d="M7.6 15.6l3-6.7" /><path d="M14 8.2l2.6 5.1" />
  </>),

  // ── Object kinds ───────────────────────────────────────────────────────
  vision: (<>
    <path d="M3 18h18" />
    <path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
    <path d="M12 5.5v2" /><path d="M5.6 8.1l1.4 1.4" /><path d="M18.4 8.1l-1.4 1.4" />
  </>),
  goal: (<>
    <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="1" />
  </>),
  // Metric: measurement curve with axis — not the "chart emoji".
  kpi: (<>
    <path d="M4 4v16h16" />
    <path d="M7.5 15.5l3.5-4 2.5 2.5 4.5-6" />
  </>),
  // Idea: light bulb, reduced to the essentials.
  idea: (<>
    <path d="M9 17.5h6" /><path d="M10 20.5h4" />
    <path d="M12 3.5a5.5 5.5 0 0 0-3.2 9.98c.5.36.7.9.7 1.42v.6h5v-.6c0-.52.2-1.06.7-1.42A5.5 5.5 0 0 0 12 3.5z" />
  </>),
  // Concept: two layers — an idea becomes something built.
  concept: (<>
    <path d="M12 3.5l8.5 4.5L12 12.5 3.5 8z" />
    <path d="M3.5 13.5L12 18l8.5-4.5" />
  </>),
  // Analysis: magnifying glass.
  analysis: (<>
    <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.2 15.2l5.3 5.3" />
  </>),

  // ── States ─────────────────────────────────────────────────────────────
  // The five must be distinguishable WITHOUT color too — red-green color
  // blindness affects about one in twelve men, and in print color is gone anyway.
  done: (<><circle cx="12" cy="12" r="8.5" /><path d="M8.2 12.3l2.6 2.6 5-5.4" /></>),
  on_track: (<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.5l3-3.5 2 2 2.5-3.5" /></>),
  at_risk: (<>
    <path d="M12 4.5L21 19.5H3z" /><path d="M12 10v3.5" /><path d="M12 16.6h.01" />
  </>),
  blind: (<>
    {/* Dashed circle = "no measurement", not "all good". */}
    <circle cx="12" cy="12" r="8.5" strokeDasharray="3 3" />
    <path d="M9 12h6" />
  </>),
  behind: (<>
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5" /><path d="M12 16.1h.01" />
  </>),

  // ── Actions and signs ──────────────────────────────────────────────────
  plus: (<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  chevronRight: (<path d="M9.5 5.5l6.5 6.5-6.5 6.5" />),
  chevronDown: (<path d="M5.5 9.5l6.5 6.5 6.5-6.5" />),
  close: (<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>),
  // Action plan: clipboard with a check mark.
  plan: (<>
    <rect x="4.5" y="4.5" width="15" height="16" rx="2" />
    <path d="M9 4.5V3.5h6v1" />
    <path d="M8.5 12l2.2 2.2 4.8-4.8" />
  </>),
  // Clara suggestion: spark. Four points, no magic-wand cliché.
  sparkle: (<>
    <path d="M12 4l1.7 4.8L18.5 10.5l-4.8 1.7L12 17l-1.7-4.8L5.5 10.5l4.8-1.7z" />
    <path d="M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </>),
  warning: (<>
    <path d="M12 4.5L21 19.5H3z" /><path d="M12 10v3.5" /><path d="M12 16.6h.01" />
  </>),
  trendUp: (<><path d="M4 17l6-6 3.5 3.5L20 8" /><path d="M15 8h5v5" /></>),
  trendDown: (<><path d="M4 8l6 6 3.5-3.5L20 17" /><path d="M15 17h5v-5" /></>),
  trendFlat: (<><path d="M4 12h13" /><path d="M14.5 8.5L18.5 12l-4 3.5" /></>),
  more: (<>
    <circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" />
    <circle cx="18.5" cy="12" r="1.2" />
  </>),

  // ── Planner and Knowledge (stage 3) ───────────────────────────────────
  check: (<path d="M5 12.5l4.5 4.5L19 7.5" />),
  calendar: (<>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 9.5h17" /><path d="M8 3.5v3" /><path d="M16 3.5v3" />
  </>),
  // "Today": calendar page with a dot — not the sun, which means vision.
  today: (<>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 9.5h17" /><path d="M8 3.5v3" /><path d="M16 3.5v3" />
    <circle cx="12" cy="15" r="1.6" />
  </>),
  collections: (<>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2.2h8a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M3.5 11.5h17" />
  </>),
  document: (<>
    <path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" />
    <path d="M13 3.5V9h5" />
  </>),
  note: (<>
    <path d="M5 4.5h14v10.5l-4.5 4.5H5z" /><path d="M19 15h-4.5v4.5" />
    <path d="M8 9h8" /><path d="M8 12.5h5" />
  </>),
  star: (<path d="M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6L12 16.9 7 19.5l1-5.6-4-3.9 5.5-.8z" />),
  bell: (<>
    <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.5.9 5 1.8 6H4.7c.9-1 1.8-2.5 1.8-6z" />
    <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
  </>),
  trash: (<>
    <path d="M4.5 6.5h15" /><path d="M9.5 6.5V4.6h5v1.9" />
    <path d="M6.5 6.5l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.1" />
    <path d="M10.5 10.5v6" /><path d="M13.5 10.5v6" />
  </>),
  person: (<>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </>),
  people: (<>
    <circle cx="9" cy="8.5" r="3" /><path d="M3 19.5a6 6 0 0 1 12 0" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6" /><path d="M17.5 19.5a6 6 0 0 0-2.2-4.6" />
  </>),
  globe: (<>
    <circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" />
    <path d="M12 3.5a13 13 0 0 1 0 17" /><path d="M12 3.5a13 13 0 0 0 0 17" />
  </>),
  import: (<>
    <path d="M12 4v10" /><path d="M8 10.5l4 4 4-4" />
    <path d="M4.5 17.5v1.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </>),
  export: (<>
    <path d="M12 15V5" /><path d="M8 8.5l4-4 4 4" />
    <path d="M4.5 17.5v1.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </>),
  comment: (<path d="M4.5 5.5h15v10h-8.5L6.5 19v-3.5h-2z" />),
  // Cost: coin with a stroke — no currency sign, that depends on the country.
  money: (<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 9.5h6" /><path d="M8.5 13h6" />
    <path d="M12 6.5v11" /></>),
  link: (<>
    <path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.8" />
    <path d="M14 10a4 4 0 0 0-5.7 0L5.5 12.8a4 4 0 0 0 5.7 5.7l1.3-1.3" />
  </>),
  archive: (<>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
    <path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9" />
    <path d="M10 13h4" />
  </>),
  blocked: (<><circle cx="12" cy="12" r="8.5" /><path d="M6.4 6.4l11.2 11.2" /></>),
  // Lock: shackle + body. An emoji (🔓) brings its own color: it glowed golden
  // next to the trash can and read like a warning. Locking is the opposite of
  // danger. A drawn icon takes on the color of its surroundings — which is
  // exactly why this set exists.
  lock: (<>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </>),
  // ── System and shell — stroke 1.5, basic shapes, 20 px usable area ─────────
  wifi: (<>
    <path d="M4.5 10.2a11.5 11.5 0 0 1 15 0" /><path d="M7.3 13.3a7.5 7.5 0 0 1 9.4 0" />
    <path d="M10.1 16.4a3.5 3.5 0 0 1 3.8 0" /><path d="M12 19.5h.01" />
  </>),
  bluetooth: (<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9" />),
  moon: (<path d="M12.5 3.5a7.5 7.5 0 0 0 8 10.5 8.5 8.5 0 1 1-8-10.5Z" />),
  dnd: (<><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12h7" /></>),
  mic: (<>
    <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5v3" />
  </>),
  vibrate: (<>
    <rect x="8" y="4.5" width="8" height="15" rx="1.5" />
    <path d="M4 8.5l1.2 1.7L4 12l1.2 1.7L4 15.5" /><path d="M20 8.5l-1.2 1.7L20 12l-1.2 1.7L20 15.5" />
  </>),
  fullscreen: (<>
    <path d="M8.5 4H5.5a1.5 1.5 0 0 0-1.5 1.5v3" /><path d="M20 8.5v-3A1.5 1.5 0 0 0 18.5 4h-3" />
    <path d="M4 15.5v3A1.5 1.5 0 0 0 5.5 20h3" /><path d="M15.5 20h3a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </>),
  devices: (<>
    <rect x="3.5" y="5" width="17" height="11" rx="1.5" /><path d="M9 20h6" /><path d="M12 16v4" />
  </>),
  hotspot: (<>
    <circle cx="12" cy="12" r="1.8" />
    <path d="M15.6 8.4a5 5 0 0 1 0 7.2" /><path d="M8.4 15.6a5 5 0 0 1 0-7.2" />
    <path d="M18.4 5.6a9 9 0 0 1 0 12.8" /><path d="M5.6 18.4a9 9 0 0 1 0-12.8" />
  </>),
  sun: (<>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" />
  </>),
  volume: (<>
    <path d="M10.5 5.5L6 9H3.5v6H6l4.5 3.5z" />
    <path d="M14.5 9a4.2 4.2 0 0 1 0 6" /><path d="M17.5 6.5a8 8 0 0 1 0 11" />
  </>),
  volumeOff: (<>
    <path d="M10.5 5.5L6 9H3.5v6H6l4.5 3.5z" /><path d="M15 9.5l5 5M20 9.5l-5 5" />
  </>),
  gear: (<>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" />
    <circle cx="12" cy="12" r="7" />
  </>),
  pen: (<path d="M16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1 1-4z" />),
  power: (<><path d="M12 3.5v8" /><path d="M7.2 7.2a7 7 0 1 0 9.6 0" /></>),
  history: (<>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4.5v4h4" /><path d="M12 8v4.5l3 1.8" />
  </>),
  camera: (<>
    <path d="M4 8.5h3.2l1.6-2.5h6.4l1.6 2.5H20v10.5H4z" /><circle cx="12" cy="13.3" r="3.2" />
  </>),
  home: (<path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H14v-6h-4v6H5.5A1.5 1.5 0 0 1 4 19.5z" />),
  folder: (<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />),
  android: (<>
    <path d="M5 16a7 7 0 0 1 14 0v2H5z" /><path d="M8 8.5L6.5 6M16 8.5L17.5 6" />
    <circle cx="9.5" cy="12.5" r=".5" fill="currentColor" /><circle cx="14.5" cy="12.5" r=".5" fill="currentColor" />
  </>),
  flashlight: (<>
    <path d="M8.5 3.5h7v3l-1.8 2.7v9.3a1.5 1.5 0 0 1-1.5 1.5h-.4a1.5 1.5 0 0 1-1.5-1.5V9.2L8.5 6.5z" /><path d="M8.5 6.5h7" />
  </>),
  battery: (<>
    <rect x="3" y="7.5" width="15" height="9" rx="1.8" /><path d="M20.5 10.5v3" /><path d="M11 9.5l-2.5 3h3l-2.5 3" />
  </>),
  share: (<>
    <circle cx="17.5" cy="6" r="2.2" /><circle cx="6.5" cy="12" r="2.2" /><circle cx="17.5" cy="18" r="2.2" />
    <path d="M8.5 13l7 4M15.5 7l-7 4" />
  </>),
  arrowRight: (<><path d="M4.5 12h15" /><path d="M13.5 6.5L19.5 12l-6 5.5" /></>),
  chevronLeft: (<path d="M14.5 6.5L9 12l5.5 5.5" />),
  play: (<path d="M8 5.5v13l10-6.5z" fill="currentColor" />),
  reload: (<><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" /></>),
  back: (<path d="M15 5.5L8.5 12l6.5 6.5" />),
  recents: (<rect x="5" y="5" width="14" height="14" rx="2" />),
  cube: (<><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z" /><path d="M12 12l8-4.5M12 12v8.5M12 12L4 7.5" /></>),
  image: (<><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M3.5 15.5l4.5-4.5 4 4 3-3 5.5 5.5" /><circle cx="16" cy="9.2" r="1.4" /></>),
  radar: (<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 12l6-6" /></>),
  cloud: (<path d="M7 18.5a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18.2 11H18.5a3.75 3.75 0 0 1 0 7.5z" />),
  terminal: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></>),
  copy: (<><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M5 15.5A1.5 1.5 0 0 1 3.5 14V5.5A1.5 1.5 0 0 1 5 4h8.5A1.5 1.5 0 0 1 15 5.5" /></>),
  scissors: (<><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /><path d="M20 4 8.3 15.7M8.3 8.3 14 14M20 20l-6-6" /></>),
  textSize: (<><path d="M4 18L9 6h1l5 12" /><path d="M6 14h7" /><path d="M16.5 18l2-5h.5l2 5" /></>),
  lockOpen: (<>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" />
  </>),
  flag: (<><path d="M6 21V4" /><path d="M6 5h11l-2.2 3.6L17 12H6z" /></>),
  attachment: (<path d="M18 11.5l-6.6 6.6a4 4 0 0 1-5.7-5.7l7.4-7.4a2.8 2.8 0 0 1 4 4l-7.4 7.4a1.6 1.6 0 0 1-2.2-2.2l6.6-6.6" />),
  arrowUp: (<><path d="M12 19.5V5" /><path d="M6.5 10.5L12 5l5.5 5.5" /></>),
  mail: (<>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="M4 7l8 5.5L20 7" />
  </>),
  repeat: (<>
    <path d="M4.5 11a6.5 6.5 0 0 1 6.5-6.5h5.5" /><path d="M14 2.5l2.8 2-2.8 2" />
    <path d="M19.5 13a6.5 6.5 0 0 1-6.5 6.5H7.5" /><path d="M10 21.5l-2.8-2 2.8-2" />
  </>),
  restore: (<>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5" /><path d="M4 4v4h4" />
    <path d="M12 8v4.5l3 1.8" />
  </>),
  search: (<><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.2 15.2l5.3 5.3" /></>),
};

interface Props {
  name: IconName;
  /** Edge length in px. Default 18 — fits next to 13–14 px text. */
  size?: number;
  /** Only set when the icon stands ALONE (no word next to it). */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 18, title, className, style }: Props) {
  const form = FORMEN[name];
  if (!form) return null;
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {form}
    </svg>
  );
}

/** Map emoji from the database to an icon.
 *
 * Deliberately NO database migration: the Idea Suite shares the object kinds
 * with the Knowledge Suite. Rewriting the `icon` column there would change the
 * other app too — and a typo would leave empty fields. The mapping therefore
 * happens at display time. Anything not in the table is passed through
 * unchanged: unknown characters never disappear, they just keep looking as
 * before.
 */
const AUS_EMOJI: Record<string, IconName> = {
  "🌅": "vision", "🎯": "goal", "📈": "kpi", "💡": "idea",
  "📐": "concept", "🔨": "concept", "🚀": "concept",
  "🔍": "analysis", "🧭": "matrix", "🕸️": "graph", "🕸": "graph",
  "📊": "dashboard", "📋": "plan", "☰": "list", "✅": "done",
  "🟢": "on_track", "🟡": "at_risk", "⚪": "blind", "🔴": "behind",
  "⚠": "warning", "⚠️": "warning",
  // Stage 3: Planner and Knowledge
  "✓": "check", "✔": "check", "☑": "done", "☐": "blind",
  "📅": "calendar", "🗓": "calendar", "☀": "today", "☀️": "today",
  "🗂": "collections", "🗂️": "collections", "📄": "document", "📝": "note",
  "★": "star", "⭐": "star", "🔔": "bell", "🗑": "trash", "🗑️": "trash",
  "👪": "people", "👥": "people", "👤": "person", "🌐": "globe",
  "📥": "import", "📤": "export", "💬": "comment",
  "💶": "money", "💰": "money", "🪙": "money", "🔗": "link", "🗄": "archive",
  "⛔": "blocked", "⚑": "flag", "🚩": "flag", "📎": "attachment",
  "⬆": "arrowUp", "✉": "mail", "🔁": "repeat", "♻": "restore", "🎉": "sparkle",
};

export function iconFuerEmoji(zeichen: string | null | undefined): IconName | null {
  if (!zeichen) return null;
  return AUS_EMOJI[zeichen.trim()] ?? null;
}
