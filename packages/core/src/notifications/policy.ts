/**
 * Notification rules.
 *
 * Modeled on KDE's kcm_notifications:
 *
 *  - "Do not disturb" is **a timestamp**, not a toggle. The state is always
 *    "until when", never "on/off" — otherwise it accidentally stays active
 *    for weeks after a movie night.
 *  - Urgency is a separate axis: "critical" breaks through DND,
 *    "low" can be suppressed separately for popups and history.
 *  - Exactly four switches per app: popup, popup during DND, history, badge.
 *
 * Pure functions without store/DOM access — testable in Node.
 */

import type { Notification, NotificationUrgency } from "../types";

export interface AppNotificationRule {
  showPopups: boolean;
  showPopupsInDnd: boolean;
  showInHistory: boolean;
  showBadges: boolean;
}

export const DEFAULT_APP_RULE: AppNotificationRule = {
  showPopups: true,
  showPopupsInDnd: false,
  showInHistory: true,
  showBadges: true,
};

export interface NotificationPolicy {
  /** Unix ms until which "do not disturb" applies. 0 = off. */
  dndUntil: number;
  /** May critical notifications break through DND? */
  criticalInDnd: boolean;
  /** Popups for low urgency? */
  lowPriorityPopups: boolean;
  /** Keep low urgency in the history? */
  lowPriorityHistory: boolean;
  /** Rules per app id; missing entries use DEFAULT_APP_RULE. */
  apps: Record<string, Partial<AppNotificationRule>>;
}

export const DEFAULT_POLICY: NotificationPolicy = {
  dndUntil: 0,
  criticalInDnd: true,
  lowPriorityPopups: true,
  lowPriorityHistory: false,
  apps: {},
};

export interface Decision {
  /** Show a popup/toast? */
  popup: boolean;
  /** Keep in the history? */
  history: boolean;
  /** Count in counters/badges? */
  badge: boolean;
  /** Short reason — helps debugging ("why did nothing show up?"). */
  reason: string;
}

export function isDndActive(policy: NotificationPolicy, now = Date.now()): boolean {
  return policy.dndUntil > now;
}

export function ruleFor(policy: NotificationPolicy, source?: string): AppNotificationRule {
  return { ...DEFAULT_APP_RULE, ...(source ? policy.apps[source] ?? {} : {}) };
}

/** Decides what happens to a notification. */
export function decide(
  n: Pick<Notification, "urgency" | "source">,
  policy: NotificationPolicy,
  now = Date.now(),
): Decision {
  const urgency: NotificationUrgency = n.urgency ?? "normal";
  const rule = ruleFor(policy, n.source);
  const dnd = isDndActive(policy, now);

  let history = rule.showInHistory;
  if (urgency === "low" && !policy.lowPriorityHistory) history = false;

  const badge = rule.showBadges && history;

  if (!rule.showPopups) {
    return { popup: false, history, badge, reason: "Popups für diese App aus" };
  }
  if (urgency === "low" && !policy.lowPriorityPopups) {
    return { popup: false, history, badge, reason: "niedrige Dringlichkeit" };
  }
  if (dnd) {
    if (urgency === "critical" && policy.criticalInDnd) {
      return { popup: true, history, badge, reason: "kritisch — durchbricht Nicht stören" };
    }
    if (rule.showPopupsInDnd) {
      return { popup: true, history, badge, reason: "App darf trotz Nicht stören" };
    }
    return { popup: false, history, badge, reason: "Nicht stören aktiv" };
  }
  return { popup: true, history, badge, reason: "" };
}

/** Human-readable remaining time for display (e.g. "45 min left"). */
/**
 * Remaining DND time as data — the UI turns it into text in its language
 * (`common:dnd.remaining.<key>`). null = DND is off.
 */
export type DndRemaining =
  | { key: "unlimited" | "tomorrow" }
  | { key: "days"; count: number }
  | { key: "hoursMinutes"; h: number; m: number }
  | { key: "hours"; h: number }
  | { key: "minutes"; count: number };

export function dndRemaining(policy: NotificationPolicy, now = Date.now()): DndRemaining | null {
  if (!isDndActive(policy, now)) return null;
  const mins = Math.ceil((policy.dndUntil - now) / 60000);
  if (mins >= 60 * 24 * 365) return { key: "unlimited" };
  if (mins >= 60 * 20) {
    const days = Math.round(mins / (60 * 24));
    return days <= 1 ? { key: "tomorrow" } : { key: "days", count: days };
  }
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? { key: "hoursMinutes", h, m } : { key: "hours", h };
  }
  return { key: "minutes", count: mins };
}

/** German text of dndRemaining() — the fallback when no catalog is loaded. */
export function dndRemainingLabel(policy: NotificationPolicy, now = Date.now()): string {
  const r = dndRemaining(policy, now);
  if (!r) return "";
  switch (r.key) {
    case "unlimited": return "unbegrenzt";
    case "tomorrow": return "bis morgen";
    case "days": return `noch ${r.count} Tage`;
    case "hoursMinutes": return `noch ${r.h} Std. ${r.m} Min.`;
    case "hours": return `noch ${r.h} Std.`;
    case "minutes": return `noch ${r.count} Min.`;
  }
}

/** Preset durations for quick selection (minutes; 0 = unlimited). */
/** `id` is the catalog key (`common:dnd.preset.<id>`), `label` the German fallback. */
export const DND_PRESETS: { id: string; label: string; minutes: number }[] = [
  { id: "30m", label: "30 Minuten", minutes: 30 },
  { id: "1h", label: "1 Stunde", minutes: 60 },
  { id: "tomorrow", label: "Bis morgen früh", minutes: -1 },
  { id: "off", label: "Bis ich es ausschalte", minutes: 0 },
];

/** Compute the timestamp for a quick selection. */
export function dndUntilFor(minutes: number, now = Date.now()): number {
  if (minutes === 0) return now + 365 * 24 * 60 * 60_000; // "unlimited"
  if (minutes < 0) {
    // Until 7 a.m. tomorrow
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(7, 0, 0, 0);
    return d.getTime();
  }
  return now + minutes * 60_000;
}
