/**
 * NavActionCards — clickable deep-link cards under finished assistant
 * messages.
 *
 * Source: toolCalls with `navArgs` (successful claraos_action_navigate_to
 * calls; the args come from the agent in the tool.end event). A click repeats
 * the navigation via POST /api/claraos/actions/navigate — the same path
 * Clara uses (action bus → shell opens/aligns the app window).
 */
import { useState } from "react";
import { useAuthStore } from "@claraos/core";
import type { ClaraToolCall } from "./api";
import styles from "./NavActionCards.module.css";

function cardLabel(nav: NonNullable<ClaraToolCall["navArgs"]>): string {
  const app = String(nav.app_id ?? "app");
  const pretty = app.charAt(0).toUpperCase() + app.slice(1);
  const params = nav.params ?? {};
  const hint =
    (params as Record<string, unknown>).query ??
    (params as Record<string, unknown>).id ??
    (params as Record<string, unknown>).display_id ??
    "";
  const key = String(nav.pattern_key ?? "");
  const detail = hint ? ` · ${String(hint)}` : key ? ` · ${key}` : "";
  return `${pretty}${detail}`;
}

export function NavActionCards({ toolCalls }: { toolCalls: ClaraToolCall[] }) {
  const username = useAuthStore((s) => s.user?.username);
  const [busy, setBusy] = useState<string>("");

  // dedupe: show identical navigations (app+pattern+params) only once
  const seen = new Set<string>();
  const navs: NonNullable<ClaraToolCall["navArgs"]>[] = [];
  for (const tc of toolCalls) {
    if (!tc.navArgs || !tc.ok) continue;
    const key = JSON.stringify([tc.navArgs.app_id, tc.navArgs.pattern_key, tc.navArgs.params]);
    if (seen.has(key)) continue;
    seen.add(key);
    navs.push(tc.navArgs);
  }
  if (navs.length === 0 || !username) return null;

  const open = async (nav: NonNullable<ClaraToolCall["navArgs"]>) => {
    const key = JSON.stringify(nav);
    setBusy(key);
    try {
      await fetch("/api/claraos/actions/navigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_user: username,
          app_id: nav.app_id,
          pattern_key: nav.pattern_key,
          params: nav.params ?? {},
          from: "chat-nav-card",
        }),
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className={styles.row} data-claraos-nav-cards>
      {navs.map((nav) => {
        const key = JSON.stringify(nav);
        return (
          <button
            key={key}
            type="button"
            className={styles.card}
            disabled={busy === key}
            onClick={() => void open(nav)}
            title={`${nav.app_id} → ${nav.pattern_key}`}
          >
            <span className={styles.icon}>🔗</span>
            <span className={styles.label}>{cardLabel(nav)}</span>
            <span className={styles.action}>{busy === key ? "…" : "öffnen"}</span>
          </button>
        );
      })}
    </div>
  );
}
