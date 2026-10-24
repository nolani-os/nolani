// Wording of the system monitor (widget and task manager). The product names
// the hypervisor generically; an installation can name its own
// (optional heim.config.ts SYSTEM_LABELS).
import { i18n } from "@claraos/core";

export interface SystemLabels {
  /** Widget: empty state when the hypervisor API has no token. */
  tokenMissing: string;
  /** Widget settings: hint above the target list. */
  tokenMissingHint: string;
  /** Task manager → System: hint above the table. */
  tokenMissingTab: string;
  /** Widget settings: group heading of the hypervisor nodes. */
  nodeGroup: string;
  /** Task manager → System: kind column for a hypervisor node. */
  nodeKind: string;
}

const heimConfig = import.meta.glob<{ SYSTEM_LABELS?: Partial<SystemLabels> }>("../heim.config.ts", { eager: true });
const overrides: Partial<SystemLabels> = Object.values(heimConfig)[0]?.SYSTEM_LABELS ?? {};

const KEYS: (keyof SystemLabels)[] = [
  "tokenMissing", "tokenMissingHint", "tokenMissingTab", "nodeGroup", "nodeKind",
];

// Getters: each read returns the text in the current UI language, an
// installation's own wording wins over the translation.
export const SYSTEM_LABELS = Object.defineProperties(
  {} as SystemLabels,
  Object.fromEntries(
    KEYS.map((k) => [
      k,
      {
        enumerable: true,
        get: () => overrides[k] ?? i18n.t(`desktop:widgets.systemLabels.${k}`),
      },
    ]),
  ),
);
