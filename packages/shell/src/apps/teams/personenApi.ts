/**
 * People in the Teams app — access to /api/claraos/teams/personen.
 *
 * Security: the SERVER makes the selection: only people who share a team with
 * the signed-in user are returned. Therefore there is NO extra filtering here
 * and no "all users" list is built — the client could not decide that
 * correctly, and a second filter would only obscure where the rule really
 * lives.
 *
 * `klasse` also comes from the server. It states what ClaraOS can really do
 * on this path — "foederiert" means chat from here, "bridge"/"verweis" mean:
 * leads outside. The UI may display this but must never decide it itself.
 */

export type Wegklasse = "foederiert" | "bridge" | "verweis";

export interface Weg {
  dienst: string;
  name: string;
  handle: string;
  klasse: Wegklasse;
  chat_moeglich: boolean;
  anruf_moeglich: boolean;
  hinweis: string;
  quelle: "konto" | "kontakt";
}

export interface Person {
  username: string;
  name: string;
  email: string;
  teams: string[];
}

export interface Profil extends Person {
  wege: Weg[];
}

async function hol<T>(pfad: string): Promise<T> {
  const r = await fetch(pfad, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

export function personenSuchen(q: string): Promise<Person[]> {
  const p = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return hol<Person[]>(`/api/claraos/teams/personen${p}`);
}

export function profilLaden(username: string): Promise<Profil> {
  return hol<Profil>(`/api/claraos/teams/personen/${encodeURIComponent(username)}`);
}

export interface TalkGespraech {
  dienst: "nctalk";
  token: string;
  url: string;
  anruf_url: string;
}

/**
 * Open a Talk conversation. The server creates it with the signed-in user's
 * credentials — that is why this cannot be done directly from the browser.
 */
export async function talkOeffnen(username: string): Promise<TalkGespraech> {
  const r = await fetch(
    `/api/claraos/teams/personen/${encodeURIComponent(username)}/talk`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok) {
    let grund = `${r.status}`;
    try {
      grund = (await r.json())?.detail ?? grund;
    } catch {
      /* response without JSON — then the status code is the answer */
    }
    throw new Error(grund);
  }
  return (await r.json()) as TalkGespraech;
}

export interface FremdGespraech {
  dienst: "nctalk";
  id: string;
  name: string;
  ungelesen: number;
  letzte_nachricht: string;
  zeit: number | null;
  url: string;
}

/**
 * Conversations outside Matrix (currently Nextcloud Talk).
 * Matrix rooms do NOT come from here — the client knows them through its own
 * session, including live updates. Two sources for the same room would be two
 * truths.
 */
export async function fremdGespraeche(): Promise<FremdGespraech[]> {
  try {
    const r = await fetch("/api/claraos/teams/gespraeche", { credentials: "include" });
    if (!r.ok) return [];
    return (await r.json()) as FremdGespraech[];
  } catch {
    // Talk unreachable: then the overview just shows Matrix. An empty section
    // is better than an error message about a service the user may not even
    // use.
    return [];
  }
}

/**
 * Nextcloud Talk is **no longer shown** in the Teams app.
 *
 * Users should neither see the Nextcloud or Element UI nor be redirected to
 * Nextcloud or Element. Talk was the last place doing exactly that — the
 * entries in the sidebar and the profile card opened Nextcloud in a **new
 * browser tab**. There is no native equivalent: Talk is a separate service
 * with its own rooms, not another view of Matrix.
 *
 * The conversations are **not deleted** — they remain reachable in Nextcloud,
 * just no longer from within this app.
 *
 * One switch, three callers (sidebar, mobile list, profile card). Setting it
 * back to `true` fully restores the old display — which is why the code stays
 * instead of being deleted.
 */
export const TALK_ANZEIGEN = false;
