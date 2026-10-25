/**
 * Why could a file not be displayed?
 *
 * `<img>`/`<video>` only report "error", without a reason. For the user it
 * matters whether the file is MISSING (pick another one) or whether the browser
 * merely CANNOT render it (download it, use another program).
 *
 * Important: no HEAD request — the download endpoint only supports GET and
 * answers HEAD with 405, which would read as "error 405" instead of "not found".
 * Fetching a single byte via Range is enough for the status; the rest is not loaded.
 */
import { i18n } from "@claraos/core";

export async function ladeGrund(url: string, art: "Bild" | "Video"): Promise<string> {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    r.body?.cancel().catch(() => {});
    if (r.status === 404) return i18n.t("components:loadReason.notFound");
    if (r.status === 401 || r.status === 403) return i18n.t("components:loadReason.noAccess");
    if (!r.ok) return i18n.t("components:loadReason.serverError", { status: r.status });
  } catch {
    return i18n.t("components:loadReason.noConnection");
  }
  return art === "Bild"
    ? i18n.t("components:loadReason.image")
    : i18n.t("components:loadReason.video");
}
