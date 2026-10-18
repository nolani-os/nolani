import { useEffect } from "react";

/**
 * Presence heartbeat of the shell.
 *
 * Deliberately lives in the shell, not in the Teams app: presence means
 * "this person has ClaraOS open" — not "this person has Teams open right now".
 * Someone working in the file manager is just as present.
 *
 * Important: **only report while the UI is actually visible.** A background
 * browser tab keeps running; without this check a tab left open for days would
 * report "available" forever and the indicator would become decoration. When
 * the page becomes visible we report immediately so the status does not lag
 * a minute behind.
 */

const TAKT_MS = 60_000;

function geraetName(): string {
  const b = navigator.userAgent;
  if (/Android|iPhone|iPad|Mobile/i.test(b)) return "Handy";
  return "Rechner";
}

async function melden(): Promise<void> {
  try {
    await fetch("/api/claraos/praesenz/herzschlag", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geraet: geraetName() }),
    });
  } catch {
    // A missed heartbeat is not an error: the server-side timeout is more
    // generous than the interval precisely for this reason.
  }
}

export function usePraesenzHerzschlag(): void {
  useEffect(() => {
    let gestoppt = false;

    const schlag = () => {
      if (gestoppt) return;
      if (document.visibilityState !== "visible") return;
      void melden();
    };

    schlag();
    const timer = window.setInterval(schlag, TAKT_MS);
    document.addEventListener("visibilitychange", schlag);

    return () => {
      gestoppt = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", schlag);
    };
  }, []);
}
