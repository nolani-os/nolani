/** Maturity pipeline for ideas, used consistently everywhere (board columns, badges, stepper). */
import type { Stage } from "./types";
import type { IconName } from "../../components/Icon";
import { i18n } from "@claraos/core";

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

const stufe = (key: Stage, rest: Omit<StageDef, "key" | "label">): StageDef =>
  ({ key, ...rest, get label() { return i18n.t(`wissen:stage.${key}`); } });

export const STAGES: StageDef[] = [
  stufe("spark", { icon: "💡", iconName: "idea", color: "#eab308", board: true }),
  stufe("developing", { icon: "🔨", iconName: "concept", color: "#3b82f6", board: true }),
  stufe("elaborated", { icon: "📐", iconName: "document", color: "#8b5cf6", board: true }),
  stufe("planned", { icon: "🚀", iconName: "target", color: "#22c55e", board: true }),
  stufe("done", { icon: "✅", iconName: "done", color: "#16a34a", board: false }),
  stufe("archived", { icon: "🗄️", iconName: "archive", color: "#6b7280", board: false }),
];

export const STAGE_BY_KEY: Record<string, StageDef> =
  Object.fromEntries(STAGES.map((s) => [s.key, s]));

export const BOARD_STAGES = STAGES.filter((s) => s.board);
