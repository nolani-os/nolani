/** Client for the calendar business page (routers/planner_business.py).
 *
 * A separate file instead of `planner/api.ts`: the resource conflict (409)
 * carries **structured** data here — who has already booked when. The shared
 * http helper turns that into text and throws the list away; but the UI needs
 * exactly that list to show "booked by <name>, 9–12".
 */
import { i18n } from "@claraos/core";

const BASE = "/api/claraos/planner";

export interface Ressource {
  id: string; name: string; art: string; beschreibung: string;
  kalender_uri: string; aktiv: boolean;
}
export interface Belegung { uid: string; titel: string; von: string; bis: string | null; wer: string }
export interface Umfrage {
  id: string; ersteller: string; titel: string; ort: string; dauer_min: number;
  optionen: string[]; teilnehmer: string[]; status: string; gewaehlt: number | null;
  erstellt_am?: string; habe_abgestimmt?: boolean;
}
export interface UmfrageDetail {
  umfrage: Umfrage;
  auszaehlung: { ja: number; vielleicht: number; nein: number }[];
  je_person: Record<string, Record<number, string>>;
  empfehlung: number | null;
  ich: string;
  meine_stimmen: Record<number, string>;
}

export interface Buchungsseite {
  aktiv: boolean; dauer_min: number; von_uhr: number; bis_uhr: number;
  werktags: boolean; titel: string; hinweis: string;
}

/** 409 of a resource booking — with the bookings standing in the way. */
export class BelegtError extends Error {
  constructor(public readonly konflikte: Belegung[], meldung: string) {
    super(meldung);
    this.name = "BelegtError";
  }
}

async function http<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${pfad}`, {
    credentials: "include", ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (r.ok) return (r.status === 204 ? undefined : await r.json()) as T;
  let detail: unknown = null;
  try { detail = (await r.json())?.detail; } catch { /* then without it */ }
  if (r.status === 409 && detail && typeof detail === "object" && "konflikte" in (detail as object)) {
    const d = detail as { meldung?: string; konflikte?: Belegung[] };
    throw new BelegtError(d.konflikte ?? [], d.meldung ?? i18n.t("planner:business.alreadyTaken"));
  }
  throw new Error(typeof detail === "string" ? detail : `${r.status} ${r.statusText}`);
}

export const businessApi = {
  ressourcen: () => http<{ ressourcen: Ressource[]; arten: { id: string; name: string }[] }>("/ressourcen"),
  ressourceAnlegen: (b: { id: string; name: string; art: string; beschreibung?: string; gruppe?: string }) =>
    http<{ ok: boolean; id: string }>("/ressourcen", { method: "POST", body: JSON.stringify(b) }),
  belegung: (rid: string, von: string, bis: string) =>
    http<{ ressource: { id: string; name: string }; belegung: Belegung[] }>(
      `/ressourcen/${encodeURIComponent(rid)}/belegung?von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`),
  buchen: (rid: string, b: { von: string; bis: string; titel: string; notiz?: string }) =>
    http<{ ok: boolean; uid: string; ressource: string; von: string; bis: string }>(
      `/ressourcen/${encodeURIComponent(rid)}/buchung`, { method: "POST", body: JSON.stringify(b) }),
  stornieren: (rid: string, uid: string) =>
    http<{ ok: boolean }>(`/ressourcen/${encodeURIComponent(rid)}/buchung/${encodeURIComponent(uid)}`,
      { method: "DELETE" }),

  umfragen: () => http<{ umfragen: Umfrage[] }>("/umfragen"),
  umfrage: (id: string) => http<UmfrageDetail>(`/umfragen/${encodeURIComponent(id)}`),
  umfrageAnlegen: (b: { titel: string; ort?: string; dauer_min: number; optionen: string[]; teilnehmer: string[] }) =>
    http<{ ok: boolean; id: string }>("/umfragen", { method: "POST", body: JSON.stringify(b) }),
  stimmen: (id: string, stimmen: Record<number, string>) =>
    http<{ ok: boolean }>(`/umfragen/${encodeURIComponent(id)}/stimme`,
      { method: "POST", body: JSON.stringify({ stimmen }) }),
  festlegen: (id: string, optionIdx: number) =>
    http<{ ok: boolean; termin_angelegt: boolean; hinweis: string | null; start: string }>(
      `/umfragen/${encodeURIComponent(id)}/festlegen`, { method: "POST", body: JSON.stringify({ option_idx: optionIdx }) }),

  buchungsseite: () => http<{ einstellung: Buchungsseite }>("/buchungsseite"),
  buchungsseiteSetzen: (b: Buchungsseite) =>
    http<{ ok: boolean }>("/buchungsseite", { method: "PUT", body: JSON.stringify(b) }),
  gastgeber: () => http<{ gastgeber: { username: string; dauer_min: number; titel: string; hinweis: string }[] }>(
    "/buchungsseiten"),
  zeiten: (gastgeber: string, tage = 14) =>
    http<{ gastgeber: string; dauer_min: number; titel: string; hinweis: string;
           zeiten: { von: string; bis: string }[] }>(
      `/buchungsseite/${encodeURIComponent(gastgeber)}/zeiten?tage=${tage}`),
  terminBuchen: (gastgeber: string, von: string, thema: string) =>
    http<{ ok: boolean; von: string; bis: string }>(
      `/buchungsseite/${encodeURIComponent(gastgeber)}/buchen`,
      { method: "POST", body: JSON.stringify({ von, thema }) }),

  besprechung: (titel: string, teilnehmer: string[]) =>
    http<{ ok: boolean; room_id: string; link: string; eingeladen: string[];
           ohne_matrix_konto: string[]; hinweis: string }>("/besprechung",
      { method: "POST", body: JSON.stringify({ titel, teilnehmer }) }),
};

/** People for attendee lists — the same source as the free/busy assistant. */
export const personenApi = {
  liste: () => fetch(`${BASE}/people`, { credentials: "include" })
    .then((r) => (r.ok ? r.json() : { people: [] }))
    .then((d: { people?: { username: string; name?: string }[] }) => d.people ?? []),
};
