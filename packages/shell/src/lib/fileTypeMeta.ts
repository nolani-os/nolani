/**
 * fileTypeMeta — THE single source of truth for file-type presentation.
 *
 * Replaces three divergent emoji maps (FileBrowserApp FILE_ICONS,
 * DesktopIcons getFileIcon, FilePickerModal binary 📁/📄) with one
 * category table that drives <FileTypeIcon> (color + glyph + label)
 * and stays alongside fileTypeRouter (which owns ext → viewer app).
 */
import { i18n } from "@claraos/core";

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
  /** Display name for tooltips/properties, in the UI language
   *  (`common:fileTypes.<category>`, resolved on every read). */
  readonly name: string;
}

const CATEGORY_COLORS: Record<FileCategory, string> = {
  pdf:      "#F87171",
  text:     "#38BDF8",
  doc:      "#60A5FA",
  sheet:    "#4ADE80",
  slides:   "#FB923C",
  image:    "#A78BFA",
  video:    "#F472B6",
  audio:    "#2DD4BF",
  archive:  "#FBBF24",
  code:     "#93C5FD",
  data:     "#7DD3FC",
  model3d:  "#E879F9",
  mail:     "#818CF8",
  calendar: "#F97316",
  contact:  "#34D399",
  geo:      "#22C55E",
  ebook:    "#FACC15",
  font:     "#C4B5FD",
  package:  "#94A3B8",
  design:   "#F472B6",
  unknown:  "#8C93A8",
};

/** Display name of a category in the UI language. */
export function categoryName(category: FileCategory): string {
  return i18n.t(`common:fileTypes.${category}`);
}

/** Display name for folders (same group as the category names). */
export function folderTypeName(): string {
  return i18n.t("common:fileTypes.folder");
}

export const CATEGORY_META: Record<FileCategory, CategoryMeta> = Object.fromEntries(
  (Object.keys(CATEGORY_COLORS) as FileCategory[]).map((category) => [
    category,
    {
      color: CATEGORY_COLORS[category],
      // Getter: the language can change at runtime, so never cache the text
      get name() { return categoryName(category); },
    },
  ]),
) as Record<FileCategory, CategoryMeta>;

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
  /** Category name in the UI language. */
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
