/**
 * Volatile store for artifacts that Clara displays directly.
 *
 * `show_artifact` delivers the content via the action bus — there is no file.
 * The window store is persisted (localStorage); a 12 KB game does not belong
 * there. Hence: content kept here in memory, the window only carries
 * `source: "artefakt"` + `path: "<id>"`.
 *
 * Deliberately NOT persisted: after a page reload the artifact is gone, and
 * the viewer says so honestly instead of showing an empty window. Clara can
 * send it again at any time.
 */
export interface Artefakt {
  inhalt: string;
  mime: string;
  titel: string;
  art: string;
}

const speicher = new Map<string, Artefakt>();
let zaehler = 0;

/** Maximum number of artifacts held at once — the oldest gets evicted. */
const MAX = 12;

export function merken(a: Artefakt): string {
  const id = `a${++zaehler}`;
  speicher.set(id, a);
  while (speicher.size > MAX) {
    const aeltester = speicher.keys().next().value;
    if (aeltester === undefined) break;
    speicher.delete(aeltester);
  }
  return id;
}

export function holen(id: string): Artefakt | undefined {
  return speicher.get(id);
}

/** Does the content look like a complete HTML page? */
export function istHtml(inhalt: string, mime = ""): boolean {
  if (mime.includes("html")) return true;
  const kopf = inhalt.slice(0, 400).toLowerCase();
  return kopf.includes("<!doctype html") || kopf.includes("<html");
}
