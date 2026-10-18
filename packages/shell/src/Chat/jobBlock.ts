/**
 * job.started / job.done / job.failed -> the chat card (kind `job`).
 *
 * Mirror of the API's `services/jobs.py` (normalisieren + job_block): both
 * sides must build the same card, because the API stores its copy when the
 * browser is gone and the shell builds its own while it is connected. The
 * field aliases cover the agent's job registry until its names are final.
 */
import type { ChatBlock } from "./api";

const STATUS: Record<string, "laeuft" | "fertig" | "fehler"> = {
  "job.started": "laeuft",
  "job.done": "fertig",
  "job.failed": "fehler",
};
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const FELDER = {
  job_id: ["job_id", "id", "jobId"],
  titel: ["titel", "title", "name"],
  ergebnis_url: ["ergebnis_url", "result_url", "url", "link"],
  fehler: ["fehler", "error", "detail"],
} as const;

function feld(ev: Record<string, unknown>, namen: readonly string[]): string {
  for (const n of namen) {
    const v = ev[n];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  return "";
}

export function jobBlock(ev: Record<string, unknown>): ChatBlock | null {
  const status = STATUS[String(ev.type)];
  if (!status) return null;
  const jobId = feld(ev, FELDER.job_id);
  if (!JOB_ID_RE.test(jobId)) return null;
  let url = feld(ev, FELDER.ergebnis_url);
  // Links only to our own pages or https — never javascript: or data:.
  if (url && !((url.startsWith("/") && !url.startsWith("//")) || url.startsWith("https://"))) url = "";
  const props: Record<string, unknown> = { job_id: jobId, status };
  const titel = feld(ev, FELDER.titel).slice(0, 200);
  const fehler = feld(ev, FELDER.fehler).slice(0, 500);
  if (titel) props.titel = titel;
  if (url) props.ergebnis_url = url.slice(0, 1000);
  if (fehler) props.fehler = fehler;
  return { id: `job-${jobId}`, kind: "job", props };
}
