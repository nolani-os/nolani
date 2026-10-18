/** Client for contacts (routers/contacts.py).
 *
 * Important: ClaraOS holds the data itself — `data` is the superset and may
 * carry fields no target format knows. That's why it is deliberately typed
 * loosely here: whatever we don't know, we return unchanged instead of losing
 * it on save.
 */

const BASE = "/api/claraos/contacts";

export interface Mail { wert: string; label?: string; pref?: boolean }
export interface Telefon { wert: string; label?: string; pref?: boolean; e164?: string }
export interface Adresse {
  strasse?: string; plz?: string; ort?: string; region?: string; land?: string; label?: string;
}
export interface KontaktDaten {
  namen?: {
    vorname?: string; nachname?: string; mittelname?: string; praefix?: string;
    suffix?: string; anzeigename?: string; spitzname?: string; sortiername?: string;
  };
  mails?: Mail[];
  telefone?: Telefon[];
  adressen?: Adresse[];
  organisation?: { firma?: string; abteilung?: string; position?: string; rolle?: string };
  daten?: { geburtstag?: string; jahrestag?: string };
  webseiten?: { url: string; label?: string }[];
  kategorien?: string[];
  notizen?: string;
  /** Whatever came from a source and fits no field. NEVER shown-and-
   *  discarded: sent back unchanged on save. */
  frei?: Record<string, string[]>;
  [k: string]: unknown;
}

export interface Handle {
  service: string;
  handle: string;
  /** foederiert (federated) = we can really do something · verweis (reference)
   *  = only open the profile. The difference MUST stay visible, otherwise the
   *  card promises something that doesn't exist. */
  klasse: "foederiert" | "verweis" | "bridge";
  verifiziert?: boolean;
}

export interface Kontakt {
  id: string;
  owner: string;
  photo_id?: string | null;
  data: KontaktDaten;
  anzeigename: string;
  state: "active" | "removed";
  created_at: string;
  updated_at: string;
  /** true = someone shared it with me, it doesn't belong to me. */
  fremd?: boolean;
  handles?: Handle[];
  links?: { username: string; matched_on: string; confidence: string }[];
  quellen?: { source: string; account: string; last_seen_at: string; state: string }[];
}

export interface Fassung {
  id: string; seq: number; data: KontaktDaten; anzeigename: string;
  changed_by: string; changed_at: string; reason: string;
}

export interface ImportErgebnis {
  gesehen: number; neu: number; geaendert: number;
  unveraendert: number; uebersprungen: number; fehler: string[];
}

/** Extract the error text from `detail` — shown raw, it would display JSON
 *  braces instead of a sentence (same lesson as in the Planner). */
async function fehlertext(r: Response, rueckfall: string): Promise<string> {
  const text = await r.text().catch(() => "");
  if (!text) return rueckfall;
  try {
    const d = JSON.parse(text)?.detail;
    if (typeof d === "string" && d.trim()) return d;
  } catch { /* not JSON */ }
  return text.slice(0, 300) || rueckfall;
}

async function http<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${pfad}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(await fehlertext(r, `${r.status} ${r.statusText}`));
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export const kontakteApi = {
  liste: (q?: string, papierkorb = false) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (papierkorb) p.set("papierkorb", "true");
    const s = p.toString();
    return http<{ count: number; contacts: Kontakt[] }>(s ? `?${s}` : "");
  },
  einer: (id: string) => http<Kontakt>(`/${id}`),
  anlegen: (data: KontaktDaten) =>
    http<{ id: string }>("", { method: "POST", body: JSON.stringify({ data }) }),
  aendern: (id: string, data: KontaktDaten) =>
    http<{ id: string; geaendert: boolean }>(`/${id}`, { method: "PUT", body: JSON.stringify({ data }) }),
  entfernen: (id: string) => http<unknown>(`/${id}`, { method: "DELETE" }),
  wiederherstellen: (id: string) => http<unknown>(`/${id}/restore`, { method: "POST" }),
  /** Irreversible. `bestaetigt` is mandatory on the server — a permanent
   *  step must not look the same as a reversible one. */
  endgueltigLoeschen: (id: string) =>
    http<{ fassungen: number }>(`/${id}/purge?bestaetigt=true`, { method: "DELETE" }),

  fassungen: (id: string) => http<{ versions: Fassung[] }>(`/${id}/versions`),
  fassungZurueck: (id: string, seq: number) =>
    http<unknown>(`/${id}/versions/${seq}/restore`, { method: "POST" }),

  dienste: () => http<{ dienste: Dienst[] }>("/dienste"),
  /** Important: `klasse` is NOT sent — the server derives it from the
   *  service. If it came from here, one could pass LinkedIn off as "federated". */
  handleSetzen: (id: string, service: string, handle: string) =>
    http<{ service: string; handle: string; klasse: Handle["klasse"] }>(
      `/${id}/handles`, { method: "POST", body: JSON.stringify({ service, handle }) }),
  handleWeg: (id: string, service: string, handle: string) =>
    http<unknown>(`/${id}/handles?service=${encodeURIComponent(service)}&handle=${encodeURIComponent(handle)}`,
                  { method: "DELETE" }),

  importCarddav: () =>
    http<ImportErgebnis & { adressbuecher: string[]; bilder: number }>(
      "/import/carddav", { method: "POST" }),

  async importVcf(datei: File): Promise<ImportErgebnis> {
    const fd = new FormData();
    fd.append("datei", datei);
    const r = await fetch(`${BASE}/import/vcf`, { method: "POST", credentials: "include", body: fd });
    if (!r.ok) throw new Error(await fehlertext(r, "Import fehlgeschlagen"));
    return r.json();
  },

  exportUrl: () => `${BASE}/export.vcf`,
  /** A contact's photo. Goes through the same gate — whoever may not see
   *  the contact gets 404. */
  fotoUrl: (id: string) => `${BASE}/${id}/foto`,

  // ── Google ────────────────────────────────────────────────────────────
  googleStatus: () => http<GoogleStatus>("/google/status"),
  googleStart: () => http<{ url: string; hinweis: string }>("/google/start"),
  googleSync: (voll = false) =>
    http<GoogleLauf>(`/google/sync${voll ? "?voll=true" : ""}`, { method: "POST" }),
  googleTrennen: () => http<{ hinweis: string }>("/google", { method: "DELETE" }),

  // ── User matching ─────────────────────────────────────────────────────
  vorschlaege: () => http<{ count: number; vorschlaege: Vorschlag[] }>("/abgleich/vorschlaege"),
  linkSetzen: (id: string, username: string, matched_on: string, bestaetigt: boolean) =>
    http<unknown>(`/${id}/link`, {
      method: "POST", body: JSON.stringify({ username, matched_on, bestaetigt }),
    }),
  linkLoesen: (id: string, username: string) =>
    http<unknown>(`/${id}/link/${encodeURIComponent(username)}`, { method: "DELETE" }),
  meineTeams: () => http<MeineTeams>("/teams/meine"),

  // ── Sharing, blocking, reachability ───────────────────────────────────
  regelLesen: () => http<RegelStatus>("/regel"),
  regelSetzen: (wert: string) =>
    http<unknown>(`/regel?wert=${encodeURIComponent(wert)}`, { method: "PUT" }),
  freigaben: (id: string) => http<{ freigaben: Freigabe[]; blocks: Block[] }>(`/${id}/freigaben`),
  teilen: (id: string, mit: string) =>
    http<{ shared_with: string; name: string }>(`/${id}/freigaben`, {
      method: "POST", body: JSON.stringify({ mit, permission: "read" }),
    }),
  teilenZurueck: (id: string, mit: string) =>
    http<unknown>(`/${id}/freigaben/${encodeURIComponent(mit)}`, { method: "DELETE" }),
  blocken: (id: string, service: string) =>
    http<Block & { hinweis: string }>(`/${id}/block`, {
      method: "POST", body: JSON.stringify({ service }),
    }),
  blockAufheben: (id: string, service: string) =>
    http<unknown>(`/${id}/block/${encodeURIComponent(service)}`, { method: "DELETE" }),

  // ── Projection onto the phone ─────────────────────────────────────────
  projektionStatus: () => http<ProjektionStatus>("/projektion/status"),
  projektionSync: () => http<ProjektionLauf>("/projektion/sync", { method: "POST" }),
};

export interface Dienst {
  id: string;
  label: string;
  klasse: Handle["klasse"];
  platzhalter: string;
  hinweis: string;
}

export interface Vorschlag {
  contact_id: string;
  anzeigename: string;
  username: string;
  nutzer_name: string;
  teams: string[];
  matched_on: string;
  begruendung: string;
  /** true = only a hint (same name). Must look visibly different from a
   *  mail or phone match, otherwise it gets confirmed just the same. */
  schwach: boolean;
}

export interface MeineTeams {
  teams: string[];
  darf_einladen: boolean;
  hinweis: string | null;
}

export interface RegelStatus {
  erreichbar: "alle" | "team" | "team_und_kontakte";
  /** Where the rule really applies — and where explicitly not. Both must be
   *  shown, otherwise you think you are protected where you are not. */
  greift_in: string[];
  greift_nicht_in: string[];
}

export interface Freigabe {
  shared_with: string;
  permission: string;
  created_at: string;
}

export interface Block {
  service: string;
  /** `durchgesetzt` = ClaraOS really did something · `ausgeblendet` = only
   *  hidden on our side · `fehlgeschlagen` = wanted to, couldn't. */
  zustand: "durchgesetzt" | "ausgeblendet" | "fehlgeschlagen";
  since?: string;
}

export interface ProjektionStatus {
  moeglich: boolean;
  adressbuch: string;
  kontakte: number;
  draussen: number;
  mit_fehler: number;
  zuletzt: string | null;
  hinweis?: string;
}

export interface ProjektionLauf {
  adressbuch: string;
  neu_angelegt: boolean;
  geprueft: number; geschrieben: number; unveraendert: number;
  geloescht: number; fehler: number; fehler_texte: string[];
}

export interface GoogleStatus {
  moeglich: boolean;
  verbunden: boolean;
  konto?: string;
  hinweis?: string;
  /** Always true — ClaraOS only requests `contacts.readonly` and CANNOT
   *  write to Google. That belongs visibly in the UI. */
  nur_lesend?: boolean;
  zeiger?: { source: string; account: string; inkrementell: boolean; last_run: string | null }[];
}

export interface GoogleLauf {
  konto: string;
  vollabgleich: boolean;
  gesehen: number; neu: number; geaendert: number;
  unveraendert: number; uebersprungen: number; konflikt: number;
  fehler: string[];
}

/** Where a reference handle leads. Deliberately conservative: whatever we
 *  don't know for sure gets no button — better no link than a wrong one. */
export function profilUrl(h: Handle): string | null {
  const w = h.handle.trim();
  if (/^https?:\/\//i.test(w)) return w;
  const nutzer = w.replace(/^@/, "");
  switch (h.service) {
    case "linkedin": return `https://www.linkedin.com/in/${encodeURIComponent(nutzer)}`;
    case "x": case "twitter": return `https://x.com/${encodeURIComponent(nutzer)}`;
    case "facebook": return `https://www.facebook.com/${encodeURIComponent(nutzer)}`;
    case "instagram": return `https://www.instagram.com/${encodeURIComponent(nutzer)}`;
    case "github": return `https://github.com/${encodeURIComponent(nutzer)}`;
    case "mastodon": {
      // @user@instance → https://instance/@user
      const t = nutzer.split("@");
      return t.length === 2 ? `https://${t[1]}/@${t[0]}` : null;
    }
    case "matrix": return `https://matrix.to/#/${encodeURIComponent(w.startsWith("@") ? w : "@" + w)}`;
    default: return null;
  }
}
