/**
 * Map a file name to the ClaraOS app that should open it.
 *
 * Used by DesktopIcons (double-click) and FileBrowserApp (double-click on
 * non-directory). Unknown extensions fall back to the Files app, which
 * gracefully shows the file in its native browser-renderer or download UI.
 */
import { TEXT_NAMES } from "./fileTypeMeta";

export type ViewerAppId =
  | "image-viewer"
  | "pdf-viewer"
  | "video-player"
  | "text-editor"
  | "office-viewer"
  | "model-viewer"
  | "files";

const EXT_TO_APP: Record<string, ViewerAppId> = {
  // Web pages open in the viewer — a generated page should RUN, not sit in
  // the editor as source. The viewer offers a toggle to show the source.
  html: "image-viewer", htm: "image-viewer",

  // Images
  png: "image-viewer", jpg: "image-viewer", jpeg: "image-viewer",
  gif: "image-viewer", svg: "image-viewer", webp: "image-viewer",
  bmp: "image-viewer", ico: "image-viewer", avif: "image-viewer",
  // Browsers cannot render HEIC/TIFF — the viewer uses Nextcloud's preview instead
  heic: "image-viewer", heif: "image-viewer", tif: "image-viewer", tiff: "image-viewer",
  jfif: "image-viewer",

  // PDF
  pdf: "pdf-viewer",

  // Office → Collabora (embedded via Nextcloud /f/<fileId>)
  doc: "office-viewer", docx: "office-viewer", odt: "office-viewer",
  xls: "office-viewer", xlsx: "office-viewer", ods: "office-viewer",
  ppt: "office-viewer", pptx: "office-viewer", odp: "office-viewer",
  odg: "office-viewer",

  // 3D → three.js viewer (three cannot read STEP/IGES — those stay with files/CAD)
  stl: "model-viewer", obj: "model-viewer", ply: "model-viewer",
  glb: "model-viewer", gltf: "model-viewer",
  // Gaussian splat scenes (room scans). The viewer detects splat PLY by its header.
  splat: "model-viewer", ksplat: "model-viewer",

  // Video
  mp4: "video-player", webm: "video-player", mkv: "video-player",
  mov: "video-player", avi: "video-player",
  m4v: "video-player", "3gp": "video-player", ogv: "video-player",

  // Audio — falls back to video-player which handles <audio> too
  mp3: "video-player", wav: "video-player", flac: "video-player",
  ogg: "video-player", m4a: "video-player", opus: "video-player", aac: "video-player",
  m4b: "video-player", weba: "video-player",

  // Text + code → text-editor (Monaco)
  txt: "text-editor", md: "text-editor", json: "text-editor",
  yaml: "text-editor", yml: "text-editor", toml: "text-editor",
  ini: "text-editor", conf: "text-editor", log: "text-editor", env: "text-editor",
  py: "text-editor", js: "text-editor", ts: "text-editor",
  jsx: "text-editor", tsx: "text-editor",
  css: "text-editor", scss: "text-editor", less: "text-editor",
  sh: "text-editor", bash: "text-editor", zsh: "text-editor",
  go: "text-editor", rs: "text-editor", java: "text-editor",
  c: "text-editor", cpp: "text-editor", h: "text-editor", hpp: "text-editor",
  rb: "text-editor", php: "text-editor", lua: "text-editor",
  sql: "text-editor", csv: "text-editor", tsv: "text-editor", xml: "text-editor",
  dockerfile: "text-editor", bat: "text-editor", ps1: "text-editor", rtf: "text-editor",

  // Text-based everyday formats — the editor displays them fine, so no need
  // for the "Open with…" dialog.
  eml: "text-editor", mbox: "text-editor", ics: "text-editor", vcf: "text-editor",
  gpx: "text-editor", kml: "text-editor", geojson: "text-editor", tcx: "text-editor",
  jsonl: "text-editor", ndjson: "text-editor", ipynb: "text-editor", drawio: "text-editor",
  mjs: "text-editor", cjs: "text-editor", vue: "text-editor", svelte: "text-editor",
  astro: "text-editor", kt: "text-editor", kts: "text-editor", swift: "text-editor",
  cs: "text-editor", dart: "text-editor", scala: "text-editor", r: "text-editor",
  pl: "text-editor", ex: "text-editor", exs: "text-editor", hs: "text-editor", zig: "text-editor",
  gradle: "text-editor", cfg: "text-editor", properties: "text-editor", plist: "text-editor",
  lock: "text-editor", service: "text-editor", mdx: "text-editor", rst: "text-editor",
  adoc: "text-editor", org: "text-editor", tex: "text-editor", bib: "text-editor",
  srt: "text-editor", vtt: "text-editor", nfo: "text-editor", diff: "text-editor", patch: "text-editor",
  makefile: "text-editor",
  readme: "text-editor", license: "text-editor", licence: "text-editor", changelog: "text-editor",
  authors: "text-editor", copying: "text-editor", notice: "text-editor", todo: "text-editor",
  procfile: "text-editor", gemfile: "text-editor", vagrantfile: "text-editor", jenkinsfile: "text-editor",
};

/** Extension of a file name (lowercase, "" if none). README & co. count their
 *  whole name as the "extension" (same rule as fileTypeMeta.getExt). */
export function fileExt(name: string): string {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return lower;
  const idx = lower.lastIndexOf(".");
  return idx > 0 ? lower.slice(idx + 1) : "";
}

/**
 * Viewer app for a file — or null if no viewer fits.
 * User overrides ("always open with this app", prefs) win over the built-in
 * table. null → the caller shows the "Open with…" dialog instead of silently
 * falling back to the Files app.
 */
export function resolveFileApp(
  name: string,
  overrides?: Record<string, string>,
): ViewerAppId | null {
  const lower = name.toLowerCase();
  const ext = fileExt(name);
  const override = overrides?.[ext];
  if (override && isViewerAppId(override)) return override;
  if (TEXT_NAMES.has(lower)) return "text-editor";
  if (name.startsWith(".")) {
    // dotfiles — most are config text
    return "text-editor";
  }
  return EXT_TO_APP[ext] ?? null;
}

const VIEWER_APP_IDS: readonly string[] = [
  "image-viewer", "pdf-viewer", "video-player", "text-editor",
  "office-viewer", "model-viewer", "files",
];
export function isViewerAppId(id: string): id is ViewerAppId {
  return VIEWER_APP_IDS.includes(id);
}

/** Return the recommended viewer app for a file by name. */
export function getFileAppId(name: string): ViewerAppId {
  return resolveFileApp(name) ?? "files";
}

/** Default window size hint per viewer; lets handlers open right-sized. */
export function getViewerSize(app: ViewerAppId): { width: number; height: number } {
  switch (app) {
    case "image-viewer": return { width: 900, height: 700 };
    case "pdf-viewer":   return { width: 900, height: 1000 };
    case "video-player": return { width: 960, height: 600 };
    case "text-editor":  return { width: 900, height: 700 };
    case "office-viewer": return { width: 1150, height: 780 };
    case "model-viewer": return { width: 1000, height: 700 };
    case "files":
    default:             return { width: 750, height: 520 };
  }
}

/** Size hint with file context: audio in the video player → compact window. */
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "m4a", "opus", "aac"]);
export function getViewerSizeForFile(app: ViewerAppId, name: string): { width: number; height: number } {
  if (app === "video-player" && AUDIO_EXTS.has(fileExt(name))) {
    return { width: 520, height: 220 };
  }
  return getViewerSize(app);
}

/** File without a known extension: is it text? Reads only the first 4 KB
 *  (Range) and looks for null bytes — binary files almost always contain some. */
export async function sniffIsText(source: string, path: string): Promise<boolean> {
  try {
    const q = new URLSearchParams({ source, path, inline: "1" });
    const r = await fetch(`/api/claraos/files/v2/download?${q.toString()}`, { headers: { Range: "bytes=0-4095" } });
    if (!r.ok) return false;
    const buf = new Uint8Array(await r.arrayBuffer()).subarray(0, 4096);
    return !buf.includes(0);
  } catch {
    return false;
  }
}
