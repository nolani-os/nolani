/**
 * Load reports from viewer apps.
 *
 * Why: "window opened" does not answer "does the user see anything?". A naive
 * implementation acknowledged the window creation and reported `rendered: 1`
 * while the window said "file could not be loaded" — a half-truth that lets
 * the assistant claim "done!" when nothing is visible. So the app itself reports
 * what became of the content; only then is the acknowledgement sent.
 */
export interface Bericht {
  ok: boolean;
  detail: string;
}

const wartende = new Map<string, (b: Bericht) => void>();
/** Reports that arrived before anyone waited for them (a cold app loading from cache). */
const frueh = new Map<string, Bericht>();

/** Apps that send a load report — only these are waited for. */
export const MELDENDE_APPS = new Set(["image-viewer"]);

export function meldeInhalt(windowId: string, ok: boolean, detail: string): void {
  const aufloesen = wartende.get(windowId);
  if (aufloesen) {
    wartende.delete(windowId);
    aufloesen({ ok, detail });
    return;
  }
  frueh.set(windowId, { ok, detail });
  // Do not collect forever: unclaimed reports expire.
  window.setTimeout(() => frueh.delete(windowId), 15_000);
}

/**
 * Discard a stale report BEFORE triggering a new display.
 *
 * Why: `frueh` keeps unclaimed reports for 15 s — e.g. because the user opened
 * the file themselves via the file picker. If the same window is then pointed
 * at a DIFFERENT file shortly afterwards, `warteAufInhalt` would immediately
 * return that old report ("visible in the viewer") — about the previous image.
 * Exactly the kind of half-truth this module exists to prevent.
 */
export function berichtVerwerfen(windowId: string): void {
  frueh.delete(windowId);
}

/** Wait for the load report. `null` = the app did not report. */
export function warteAufInhalt(windowId: string, fristMs = 3000): Promise<Bericht | null> {
  const fertig = frueh.get(windowId);
  if (fertig) {
    frueh.delete(windowId);
    return Promise.resolve(fertig);
  }
  return new Promise((res) => {
    const uhr = window.setTimeout(() => {
      wartende.delete(windowId);
      res(null);
    }, fristMs);
    wartende.set(windowId, (b) => {
      window.clearTimeout(uhr);
      res(b);
    });
  });
}
