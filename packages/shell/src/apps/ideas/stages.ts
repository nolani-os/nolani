/** Maturity pipeline for ideas, used consistently everywhere (board columns, badges, stepper). */
import type { Stage } from "./types";
import type { IconName } from "../../components/Icon";

export interface StageDef {
  key: Stage;
  label: string;
  /** Legacy: emoji. Kept as a fallback for plain-text contexts. */
  icon: string;
  /** Drawn icon: device-independent and colorable. */
  iconName: IconName;
  /** Accent color (badges, column headers) */
  color: string;
  /** Shown as a board column? (done/archived only as filters) */
  board: boolean;
}

export const STAGES: StageDef[] = [
  { key: "spark", label: "Funke", icon: "💡", iconName: "idea", color: "#eab308", board: true },
  { key: "developing", label: "In Entwicklung", icon: "🔨", iconName: "concept", color: "#3b82f6", board: true },
  { key: "elaborated", label: "Ausgearbeitet", icon: "📐", iconName: "document", color: "#8b5cf6", board: true },
  { key: "planned", label: "Geplant", icon: "🚀", iconName: "target", color: "#22c55e", board: true },
  { key: "done", label: "Umgesetzt", icon: "✅", iconName: "done", color: "#16a34a", board: false },
  { key: "archived", label: "Archiv", icon: "🗄️", iconName: "archive", color: "#6b7280", board: false },
];

export const STAGE_BY_KEY: Record<string, StageDef> =
  Object.fromEntries(STAGES.map((s) => [s.key, s]));

export const BOARD_STAGES = STAGES.filter((s) => s.board);
