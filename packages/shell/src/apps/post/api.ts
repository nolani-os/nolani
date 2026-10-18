/** Client for the mail app (routers/post.py).
 *
 * The shell talks only to the ClaraOS API, which fetches mail via JMAP using
 * the user's mailbox credentials. No second login, no CORS.
 */

const BASE = "/api/claraos/post";

export interface Adresse { name?: string; email: string }

export interface MailZeile {
  id: string;
  thread_id: string | null;
  mailbox_ids: string[];
  from: Adresse[];
  to: Adresse[];
  subject: string;
  received_at: string | null;
  sent_at: string | null;
  preview: string;
  has_attachment: boolean;
  size: number | null;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  junk: boolean;
  pinned: boolean;
  snoozed: boolean;
  labels: string[];
  keywords: string[];
}

export interface Anhang {
  blob_id: string;
  name: string;
  type: string | null;
  size: number | null;
  cid: string | null;
  inline: boolean;
}

export interface Mail extends MailZeile {
  cc: Adresse[];
  bcc: Adresse[];
  reply_to: Adresse[];
  message_id: string[];
  in_reply_to: string[];
  html: string;
  text: string;
  attachments: Anhang[];
  thread: MailZeile[];
  mail_app_url: string;
}

export interface Ordner {
  id: string;
  name: string;
  raw_name: string;
  role: string | null;
  parent_id: string | null;
  total: number;
  unread: number;
  may_delete: boolean;
}

export interface ListeAntwort {
  messages: MailZeile[];
  total: number | null;
  position: number;
  query_state: string | null;
  /** What the server ACTUALLY sorted by — not necessarily what was requested. */
  sort?: SortFeld;
  order?: "asc" | "desc";
  /** true = the mailbox cannot sort this way; it fell back to date. */
  sort_unsupported?: boolean;
}

export interface BrueckenErgebnis {
  ok: boolean;
  kind: "task" | "event" | "contact" | "note";
  id?: number | string;
  message?: string;
  existing?: boolean;
}

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
  return r.json() as Promise<T>;
}

/** Sort fields JMAP actually supports (RFC 8621 §4.4.2) — see post.py. */
export type SortFeld = "datum" | "von" | "betreff" | "groesse" | "kennzeichen";

export interface ListeParams {
  accountId?: string;   // shared/group mailbox; empty = own mailbox
  mailbox?: string;
  q?: string;
  unread?: boolean;
  flagged?: boolean;
  label?: string;
  snoozed?: boolean;
  hasAttachment?: boolean;
  sort?: SortFeld;
  order?: "asc" | "desc";
  position?: number;
  limit?: number;
}

export const postApi = {
  ordner: (accountId?: string) =>
    http<{ mailboxes: Ordner[]; address: string; account_id: string; fremdes_konto: boolean }>(
      `/mailboxes${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ""}`),
  liste: (p: ListeParams) => {
    const qs = new URLSearchParams();
    if (p.accountId) qs.set("account_id", p.accountId);
    if (p.mailbox) qs.set("mailbox", p.mailbox);
    if (p.q) qs.set("q", p.q);
    if (p.unread) qs.set("unread", "true");
    if (p.flagged) qs.set("flagged", "true");
    if (p.label) qs.set("label", p.label);
    if (p.snoozed) qs.set("snoozed", "true");
    if (p.hasAttachment) qs.set("has_attachment", "true");
    if (p.sort && p.sort !== "datum") qs.set("sort", p.sort);
    if (p.order && p.order !== "desc") qs.set("order", p.order);
    if (p.position) qs.set("position", String(p.position));
    qs.set("limit", String(p.limit ?? 50));
    return http<ListeAntwort>(`/messages?${qs.toString()}`);
  },
  mail: (id: string, markRead = true, accountId?: string) =>
    http<{ message: Mail }>(`/message/${encodeURIComponent(id)}?mark_read=${markRead ? "true" : "false"}${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`),
  setzen: (body: {
    ids: string[]; add_keywords?: string[]; remove_keywords?: string[];
    move_to?: string; move_to_role?: string; destroy?: boolean; account_id?: string;
  }) => http<{ ok: boolean; updated?: string[]; destroyed?: string[] }>("/set", { method: "POST", body: JSON.stringify(body) }),
  blobUrl: (a: Anhang, accountId?: string) =>
    `${BASE}/blob/${encodeURIComponent(a.blob_id)}?name=${encodeURIComponent(a.name)}&type=${encodeURIComponent(a.type || "application/octet-stream")}${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`,
  bruecke: (art: "task" | "event" | "contact" | "note", body: { email_id: string; note?: string; when?: string; project_id?: number }) =>
    http<BrueckenErgebnis>(`/app/mail_to_${art}`, { method: "POST", body: JSON.stringify(body) }),
};

// ── Composing ─────────────────────────────────────────────────────────────
export interface Identitaet {
  id: string; name: string; email: string; reply_to: Adresse[]; bcc: Adresse[];
  text_signature: string; html_signature: string; may_delete: boolean;
}
export interface AnhangNeu { blob_id: string; name: string; type: string | null; size?: number | null }
export interface EntwurfDaten {
  draft_id?: string | null;
  identity_id: string;
  to: Adresse[]; cc: Adresse[]; bcc: Adresse[];
  subject: string; html: string; text?: string;
  attachments: AnhangNeu[];
  in_reply_to?: string | null; forward_of?: string | null;
  request_mdn?: boolean;
}
export interface AntwortVorlage {
  to: Adresse[]; cc: Adresse[]; subject: string; quote_html: string; quote_text: string;
  in_reply_to: string | null; forward_of: string | null; attachments: AnhangNeu[];
}
export interface Vorschlag { name: string; email: string; source: string }
export interface AusgangEintrag { submission_id: string; email_id: string; send_at: string | null; subject: string; to: Adresse[] }
/** Swipe gestures on mobile — like Outlook's "customize actions". */
export type WischAktion = "archiv" | "loeschen" | "gelesen" | "markieren" | "aufgabe" | "keine";

export interface PostPrefs { mein_tag?: boolean; default_identity?: string; undo_s?: number; request_mdn?: boolean; signature_on?: boolean; saved_searches?: GespeicherteSuche[]; labels?: string[]; swipe_links?: WischAktion; swipe_rechts?: WischAktion }

export const postSchreiben = {
  identitaeten: () => http<{ identities: Identitaet[]; address: string }>("/identities"),
  identitaetAendern: (id: string, patch: { name?: string; text_signature?: string; html_signature?: string }) =>
    http<{ ok: boolean }>(`/identities/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) }),
  hochladen: async (file: File): Promise<AnhangNeu> => {
    const fd = new FormData(); fd.append("file", file, file.name);
    const r = await fetch(`${BASE}/upload`, { method: "POST", credentials: "include", body: fd });
    if (!r.ok) throw new Error(await fehlertext(r, `${r.status} ${r.statusText}`));
    return r.json();
  },
  entwurf: (d: EntwurfDaten) => http<{ ok: boolean; draft_id: string }>("/draft", { method: "POST", body: JSON.stringify(d) }),
  senden: (d: EntwurfDaten & { delay_s?: number; send_at?: string | null }) =>
    http<{ ok: boolean; submission_id: string; email_id: string; send_at: string | null; undo_until_s: number; message: string }>("/send", { method: "POST", body: JSON.stringify(d) }),
  rueckgaengig: (submissionId: string) => http<{ ok: boolean; draft_id: string | null; message: string }>(`/send/${encodeURIComponent(submissionId)}/undo`, { method: "POST" }),
  ausgang: () => http<{ outbox: AusgangEintrag[] }>("/outbox"),
  vorlage: (id: string, mode: "reply" | "all" | "forward") => http<AntwortVorlage>(`/reply/${encodeURIComponent(id)}?mode=${mode}`),
  vorschlaege: (q: string) => http<{ suggestions: Vorschlag[] }>(`/suggest?q=${encodeURIComponent(q)}`),
  bausteine: () => http<{ snippets: { id: string; title: string; html: string; text: string }[] }>("/snippets"),
  prefs: async (): Promise<PostPrefs> => {
    const r = await fetch("/api/claraos/prefs", { credentials: "include" });
    if (!r.ok) return {};
    const p = await r.json().catch(() => null);
    return p && typeof p.post_app === "object" && p.post_app ? p.post_app : {};
  },
  prefsSpeichern: async (prefs: PostPrefs): Promise<void> => {
    await fetch("/api/claraos/prefs", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ post_app: prefs }) });
  },
};

// ── Rules, out-of-office, cleanup ────────────────────────────────────────
export interface RegelBedingung { field: string; op: string; value: string }
export interface RegelAktion { type: string; mailbox_id?: string | null; mailbox_name?: string | null; address?: string | null; label?: string | null }
export interface Regel { id: string; name: string; enabled: boolean; match: "all" | "any"; conditions: RegelBedingung[]; actions: RegelAktion[] }
export interface Abwesenheit { enabled: boolean; from_date: string | null; to_date: string | null; subject: string; text: string; html?: string }
export interface GespeicherteSuche { id: string; name: string; q?: string; unread?: boolean; flagged?: boolean; has_attachment?: boolean; mailbox?: string | null }

export const postRegeln = {
  laden: () => http<{ rules: Regel[]; script: string; installed: boolean; active: boolean; foreign_active: string[] }>("/rules"),
  speichern: (rules: Regel[]) => http<{ ok: boolean; script: string }>("/rules", { method: "PUT", body: JSON.stringify({ rules }) }),
  abwesenheit: () => http<{ vacation: Abwesenheit }>("/vacation"),
  abwesenheitSpeichern: (v: Abwesenheit) => http<{ vacation: Abwesenheit }>("/vacation", { method: "PUT", body: JSON.stringify(v) }),
  aufraeumen: (b: { sender: string; mailbox?: string | null; action: "delete" | "archive"; future: boolean }) =>
    http<{ ok: boolean; count: number; rule_added: boolean; message: string }>("/sweep", { method: "POST", body: JSON.stringify(b) }),
  blockieren: (sender: string) => http<{ ok: boolean; message: string }>("/block", { method: "POST", body: JSON.stringify({ sender }) }),
};

// ── Snooze ───────────────────────────────────────────────────────────────
export const postSchlummern = {
  schlummern: (ids: string[], until: string) => http<{ ok: boolean; snoozed: string[]; wake_at: string; message: string }>("/snooze", { method: "POST", body: JSON.stringify({ ids, until }) }),
  wecken: (ids: string[]) => http<{ ok: boolean; woken: number; message: string }>("/unsnooze", { method: "POST", body: JSON.stringify({ ids }) }),
  liste: () => http<{ snoozed: Record<string, string> }>("/snoozed"),
};

/** Display name (e.g. "Jane Doe"), or the address if there is no name. */
export function anzeigeName(a: Adresse | undefined): string {
  if (!a) return "";
  return (a.name || "").trim() || a.email;
}

export function adressListe(liste: Adresse[]): string {
  return liste.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

/** Short date: today → time, this year → "11 Sep", otherwise "11.09.25". */
export function datumKurz(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const jetzt = new Date();
  const gleicherTag = d.toDateString() === jetzt.toDateString();
  if (gleicherTag) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === jetzt.getFullYear()) return d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function datumLang(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function groesse(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Group mailboxes, sharing, directory, distribution lists ──────────────
export interface Konto {
  id: string; name: string; address: string;
  eigenes: boolean; nur_lesen: boolean; primaer: boolean; kann_senden: boolean;
}
export interface Geteilt { id: string; name: string; email: string; typ: string; stufe: string }
export interface FreigabeOrdner extends Ordner { darf_freigeben: boolean; geteilt_mit: Geteilt[] }
export interface VerzeichnisEintrag { name: string; email: string; typ: string; quelle: string; id: string }
export interface Verteiler { name: string; mitglieder: string[] }

export const postBusiness = {
  konten: (neu = false) =>
    http<{ konten: Konto[]; eigenes: string; hinweis?: string }>(`/konten${neu ? "?neu=1" : ""}`),
  freigaben: () => http<{ ordner: FreigabeOrdner[]; stufen: { id: string; name: string }[]; hinweis?: string }>("/freigaben"),
  freigabeSetzen: (mailboxId: string, person: string, stufe: string) =>
    http<{ ok: boolean; ordner: string; anzahl_freigaben: number }>("/freigaben",
      { method: "PUT", body: JSON.stringify({ mailbox_id: mailboxId, person, stufe }) }),
  verzeichnis: (q = "") => http<{ eintraege: VerzeichnisEintrag[]; anzahl: number; hinweis?: string }>(
    `/verzeichnis${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  verteiler: () => http<{ verteiler: Verteiler[] }>("/verteiler"),
  verteilerSetzen: (name: string, mitglieder: string[]) =>
    http<{ ok: boolean; name: string; anzahl: number }>("/verteiler",
      { method: "PUT", body: JSON.stringify({ name, mitglieder }) }),
  verteilerLoeschen: (name: string) =>
    http<{ ok: boolean }>(`/verteiler/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** Replace distribution-list names in a recipient list with their members. */
  aufloesen: (empfaenger: string[]) =>
    http<{ empfaenger: string[]; aufgeloest: string[] }>("/verteiler/aufloesen",
      { method: "POST", body: JSON.stringify({ empfaenger }) }),
};

// ── "One window": cross-source search and profile card ─────────────────
export interface SuchTreffer { id: string | number; titel: string; zeile?: string; datum?: string | null; ungelesen?: boolean }
export interface SucheErgebnis {
  mails: SuchTreffer[]; kontakte: SuchTreffer[]; aufgaben: SuchTreffer[]; termine: SuchTreffer[];
  suchbegriff: string; gesamt: number; nicht_erreicht: string[]; hinweis: string;
}
export interface Profil {
  email: string;
  kontakt: { id?: string; name: string; telefone?: string[]; firma?: string | null } | null;
  mails: SuchTreffer[];
  termine: SuchTreffer[];
  nicht_erreicht: string[];
}

export const postFenster = {
  suche: (q: string) => http<SucheErgebnis>(`/suche?q=${encodeURIComponent(q)}`),
  profil: (email: string) => http<Profil>(`/profil?email=${encodeURIComponent(email)}`),
};
