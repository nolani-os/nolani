import type { ComponentType } from "react";

// Start-up hooks of this installation (optional heim/boot.ts). Kept in its own module so main.tsx can import it AFTER the session
// guard — eager globs are hoisted to the top of the importing file.
interface HeimBoot {
  heimDebugStores?: Record<string, unknown>;
  startHeim?: () => void;
}

const boots = import.meta.glob<HeimBoot>("./heim/boot.ts", { eager: true });

export const heimBoot: HeimBoot | undefined = Object.values(boots)[0];

/** UI pieces of this installation that product components render in fixed
 *  places (optional heim/slots.tsx). */
export interface HeimSlots {
  /** Quick settings: extra status row(s) under the system stats (not in a cell). */
  QuickSettingsStatus?: ComponentType;
  /** Teams invite dialog: extra fields of the invite result. */
  InviteResultExtra?: ComponentType<{ result: Record<string, unknown> }>;
}

const slots = import.meta.glob<HeimSlots>("./heim/slots.tsx", { eager: true });

export const heimSlots: HeimSlots = Object.values(slots)[0] ?? {};
