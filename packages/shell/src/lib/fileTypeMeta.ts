/**
 * fileTypeMeta — THE single source of truth for file-type presentation.
 *
 * Replaces three divergent emoji maps (FileBrowserApp FILE_ICONS,
 * DesktopIcons getFileIcon, FilePickerModal binary 📁/📄) with one
 * category table that drives <FileTypeIcon> (color + glyph + label)
 * and stays alongside fileTypeRouter (which owns ext → viewer app).
 */

export type FileCategory =
  | "pdf"
  | "text"
  | "doc"
  | "sheet"
  | "slides"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "data"
  | "model3d"
  | "mail"
  | "calendar"
  | "contact"
  | "geo"
  | "ebook"
  | "font"
  | "package"
  | "design"
  | "unknown";

export interface CategoryMeta {
  /** Accent color for the label pill / glyph (clara-glass palette). */
  color: string;
  /** German name for tooltips/properties. */
  name: string;
}

export const CATEGORY_META: Record<FileCategory, CategoryMeta> = {
  pdf:     { color: "#F87171", name: "PDF-Dokument" },
  text:    { color: "#38BDF8", name: "Textdatei" },
  doc:     { color: "#60A5FA", name: "Dokument" },
  sheet:   { color: "#4ADE80", name: "Tabelle" },
  slides:  { color: "#FB923C", name: "Präsentation" },
  image:   { color: "#A78BFA", name: "Bild" },
  video:   { color: "#F472B6", name: "Video" },
  audio:   { color: "#2DD4BF", name: "Audio" },
  archive: { color: "#FBBF24", name: "Archiv" },
  code:    { color: "#93C5FD", name: "Code" },
  data:    { color: "#7DD3FC", name: "Daten" },
  model3d: { color: "#E879F9", name: "3D-Modell" },
  mail:     { color: "#818CF8", name: "E-Mail" },
  calendar: { color: "#F97316", name: "Termin" },
  contact:  { color: "#34D399", name: "Kontakt" },
  geo:      { color: "#22C55E", name: "Karte / Strecke" },
  ebook:    { color: "#FACC15", name: "E-Book" },
  font:     { color: "#C4B5FD", name: "Schrift" },
  package:  { color: "#94A3B8", name: "Programm / Abbild" },
  design:   { color: "#F472B6", name: "Grafik-Projekt" },
  unknown: { color: "#8C93A8", name: "Datei" },
};

const EXT_TO_CATEGORY: Record<string, FileCategory> = {
  pdf: "pdf",
  // Text / notes
  txt: "text", md: "text", log: "text", rtf: "text", mdx: "text", rst: "text", adoc: "text",
  org: "text", tex: "text", bib: "text", srt: "text", vtt: "text", nfo: "text",
  diff: "text", patch: "text",
  // Files WITHOUT an extension that are text by convention
  readme: "text", license: "text", licence: "text", changelog: "text", authors: "text",
  copying: "text", notice: "text", todo: "text",
  // Office
  doc: "doc", docx: "doc", odt: "doc",
  xls: "sheet", xlsx: "sheet", ods: "sheet", csv: "sheet", tsv: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides",
  // Images
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image",
  webp: "image", bmp: "image", ico: "image", avif: "image", heic: "image",
  heif: "image", tif: "image", tiff: "image", jfif: "image", raw: "image", cr2: "image",
  nef: "image", dng: "image", arw: "image",
  // Video
  mp4: "video", webm: "video", mkv: "video", mov: "video", avi: "video",
  m4v: "video", "3gp": "video", ogv: "video", mpg: "video", mpeg: "video", wmv: "video",
  // Audio
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", opus: "audio",
  aac: "audio", amr: "audio", wma: "audio", m4b: "audio", weba: "audio", mid: "audio", midi: "audio",
  // Archive
  zip: "archive", tar: "archive", gz: "archive", bz2: "archive",
  xz: "archive", rar: "archive", "7z": "archive", tgz: "archive", zst: "archive",
  // Code
  py: "code", js: "code", ts: "code", jsx: "code", tsx: "code",
  html: "code", css: "code", scss: "code", less: "code",
  sh: "code", bash: "code", zsh: "code", bat: "code", ps1: "code",
  go: "code", rs: "code", java: "code", c: "code", cpp: "code",
  h: "code", hpp: "code", rb: "code", php: "code", lua: "code",
  sql: "code", dockerfile: "code", makefile: "code",
  mjs: "code", cjs: "code", vue: "code", svelte: "code", astro: "code", kt: "code", kts: "code",
  swift: "code", cs: "code", dart: "code", scala: "code", r: "code", pl: "code", ex: "code",
  exs: "code", hs: "code", zig: "code", gradle: "code", ipynb: "code",
  // Structured data / config
  json: "data", xml: "data", yaml: "data", yml: "data",
  toml: "data", ini: "data", conf: "data", env: "data",
  jsonl: "data", ndjson: "data", cfg: "data", properties: "data", plist: "data", lock: "data",
  service: "data", drawio: "design",
  // Everyday formats
  eml: "mail", msg: "mail", mbox: "mail",
  ics: "calendar", ical: "calendar",
  vcf: "contact", vcard: "contact",
  gpx: "geo", kml: "geo", kmz: "geo", geojson: "geo", fit: "geo", tcx: "geo",
  epub: "ebook", mobi: "ebook", azw3: "ebook", djvu: "ebook",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  apk: "package", exe: "package", msi: "package", deb: "package", rpm: "package",
  dmg: "package", iso: "package", img: "package", appimage: "package",
  psd: "design", xcf: "design", kra: "design", ai: "design", afdesign: "design", sketch: "design",
  fig: "design", odg: "design",
  pages: "doc", key: "slides", numbers: "sheet",
  // 3D / CAD
  stl: "model3d", obj: "model3d", step: "model3d", iges: "model3d",
  fcstd: "model3d", "3mf": "model3d", gltf: "model3d", glb: "model3d",
  dxf: "model3d", dwg: "model3d", stp: "model3d", igs: "model3d", blend: "model3d", ply: "model3d",
  splat: "model3d", ksplat: "model3d", fbx: "model3d",
};

export interface FileTypeInfo {
  category: FileCategory;
  color: string;
  /** Short uppercase label for the icon pill (max 4 chars), e.g. "PDF". */
  label: string;
  /** German category name. */
  name: string;
}

/** File names without an extension that are text by convention (README, LICENSE …). */
export const TEXT_NAMES = new Set([
  "readme", "license", "licence", "changelog", "authors", "copying", "notice", "todo",
  "dockerfile", "makefile", "procfile", "gemfile", "vagrantfile", "jenkinsfile",
]);

export function getExt(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (TEXT_NAMES.has(lower)) return lower;
  const idx = lower.lastIndexOf(".");
  return idx > 0 ? lower.slice(idx + 1) : "";
}

export function getFileTypeInfo(fileName: string): FileTypeInfo {
  const ext = getExt(fileName);
  const category = EXT_TO_CATEGORY[ext] ?? "unknown";
  const meta = CATEGORY_META[category];
  // README/LICENSE: label "TXT" instead of a truncated name ("READ", "LICE")
  const label = TEXT_NAMES.has(ext) && category === "text" ? "TXT"
    : ext ? ext.toUpperCase().slice(0, 4) : "";
  return { category, color: meta.color, label, name: meta.name };
}
