import { useEffect, useState } from "react";

/**
 * ClaraOS presence in the frontend.
 *
 * Collects the usernames for which a status dot is currently visible somewhere
 * and queries them **in batches**. One request per avatar would, for a member
 * list, be a storm of small requests for the same answer.
 *
 * Important: if someone is missing from the response, they count as `unbekannt`
 * (unknown) — not `offline`. The server filters the request to people sharing a
 * team; someone filtered out is not necessarily away. Drawing them as offline
 * would turn a missing permission into a factual claim.
 */

export type Zustand =
  | "verfuegbar"
  | "beschaeftigt"
  | "nicht_stoeren"
  | "abwesend"
  | "offline"
  | "unbekannt";

export interface PraesenzEintrag {
  zustand: Zustand;
  selbst_gesetzt: boolean;
  zuletzt_gesehen: string | null;
  geraet: string | null;
}

const TAKT_MS = 30_000;

const gefragt = new Set<string>();
let stand: Record<string, PraesenzEintrag> = {};
const hoerer = new Set<() => void>();
let timer: number | null = null;

function melden() {
  hoerer.forEach((h) => h());
}

async function laden() {
  if (gefragt.size === 0) return;
  try {
    const users = [...gefragt].join(",");
    const r = await fetch(`/api/claraos/praesenz?users=${encodeURIComponent(users)}`, {
      credentials: "include",
    });
    if (!r.ok) return;
    stand = { ...stand, ...(await r.json()) };
    melden();
  } catch {
    // Network error: keep the last known state. Discarding it would drop all
    // dots to "unknown" although nothing changed about presence — only about
    // our connection.
  }
}

function starten() {
  if (timer !== null) return;
  void laden();
  timer = window.setInterval(laden, TAKT_MS);
}

function stoppen() {
  if (timer === null || hoerer.size > 0) return;
  window.clearInterval(timer);
  timer = null;
}

/** State of a person; registers them with the store while they are visible. */
export function usePraesenz(username: string | undefined): PraesenzEintrag | null {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!username) return;
    const h = () => tick((n) => n + 1);
    hoerer.add(h);
    const neu = !gefragt.has(username);
    gefragt.add(username);
    starten();
    if (neu) void laden();      // fetch immediately instead of waiting for the next tick
    return () => {
      hoerer.delete(h);
      stoppen();
    };
  }, [username]);

  if (!username) return null;
  return stand[username] ?? null;
}
