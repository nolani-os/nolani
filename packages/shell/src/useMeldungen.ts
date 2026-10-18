import { useEffect } from "react";
import { useIstZelle, useUIStore } from "@claraos/core";

/**
 * Notifications for deployments without a push service (a cell): polls
 * /api/claraos/meldungen once a minute and puts new ones into the same bell that
 * ntfy feeds at home. The last seen id is remembered per browser, so a reload does
 * not repeat old notifications.
 */
const KEY = "claraos.meldungen.seit";
const INTERVAL_MS = 60_000;

interface Meldung { id: number; titel: string; text: string; app: string | null; gelesen: string | null }

export function useMeldungen() {
  const istZelle = useIstZelle();
  const addNotification = useUIStore((s) => s.addNotification);

  useEffect(() => {
    if (!istZelle) return;
    let aktiv = true;
    let seit = 0;
    try { seit = Number(localStorage.getItem(KEY) || 0); } catch { /* private mode */ }

    async function holen() {
      try {
        const r = await fetch(`/api/claraos/meldungen?seit=${seit}`);
        if (!r.ok || !aktiv) return;
        const data: { meldungen: Meldung[] } = await r.json();
        for (const m of [...data.meldungen].reverse()) {         // oldest first
          if (!m.gelesen) {
            addNotification({
              title: m.titel, body: m.text, icon: "🔁", sourceId: `meldung-${m.id}`,
              actions: m.app ? [{ id: "open-window", label: "Öffnen", primary: true, payload: { appId: m.app } }] : [],
            });
          }
          seit = Math.max(seit, m.id);
        }
        try { localStorage.setItem(KEY, String(seit)); } catch { /* private mode */ }
      } catch { /* offline — next round */ }
    }

    holen();
    const t = setInterval(holen, INTERVAL_MS);
    return () => { aktiv = false; clearInterval(t); };
  }, [istZelle, addNotification]);
}
