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
export async function ladeGrund(url: string, art: "Bild" | "Video"): Promise<string> {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    r.body?.cancel().catch(() => {});
    if (r.status === 404) return "Die Datei gibt es nicht (mehr) — sie wurde verschoben, umbenannt oder gelöscht.";
    if (r.status === 401 || r.status === 403) return "Auf diese Datei hast du keinen Zugriff.";
    if (!r.ok) return `Der Server hat die Datei nicht geliefert (Fehler ${r.status}).`;
  } catch {
    return "Keine Verbindung zum Server — die Datei konnte nicht geladen werden.";
  }
  return art === "Bild"
    ? "Das Bild ließ sich nicht anzeigen — das Format kann der Browser nicht darstellen, oder die Datei ist beschädigt."
    : "Das Video ließ sich nicht abspielen — der Browser kennt das Format nicht (häufig bei MKV/AVI), oder die Datei ist beschädigt.";
}
