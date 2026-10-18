/**
 * FileTypeIcon — procedural SVG file/folder icon in the clara-glass
 * design language (navy glass body, ice-blue rim, top sheen) with a
 * per-category accent: colored label pill + mono glyph.
 *
 * One template instead of N asset files; driven by lib/fileTypeMeta.
 * Replaces the legacy emoji maps in FileBrowser, DesktopIcons and
 * FilePickerModal. Sizes via `px` (list 18 · grid-small 28 · grid 44 ·
 * desktop 48).
 */
import { memo, useId } from "react";
import { getFileTypeInfo, type FileCategory } from "../lib/fileTypeMeta";

interface Props {
  /** File name (extension drives category); ignored for folders. */
  name?: string;
  isDir?: boolean;
  /** Rendered size in px (square). */
  px?: number;
  className?: string;
  title?: string;
}

/** Category glyph, drawn in the accent color around center (24, 22). */
function Glyph({ category, color }: { category: FileCategory; color: string }) {
  const s = { stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (category) {
    case "image":
      return (
        <g {...s}>
          <rect x="14" y="14" width="20" height="15" rx="2" />
          <circle cx="19.5" cy="19" r="1.8" fill={color} stroke="none" />
          <path d="M15 27l5.5-5.5 3.5 3.5 4.5-4.5 5 5" />
        </g>
      );
    case "video":
      return <path d="M19.5 15.5l11.5 6.7-11.5 6.7z" fill={color} stroke="none" />;
    case "audio":
      return (
        <g {...s}>
          <circle cx="20.5" cy="26.5" r="2.8" />
          <path d="M23.3 26.5V14.5l8 1.8v4.5" />
        </g>
      );
    case "archive":
      return (
        <g {...s}>
          <path d="M24 13v3m0 3v3m0 3v3" />
          <rect x="21" y="25" width="6" height="4.5" rx="1" />
        </g>
      );
    case "code":
      return (
        <g {...s}>
          <path d="M17.5 17l-5 5.5 5 5.5" />
          <path d="M30.5 17l5 5.5-5 5.5" />
          <path d="M26.5 14.5l-5 16" />
        </g>
      );
    case "data":
      return (
        <g {...s}>
          <path d="M18 14.5h-3.5v16H18" />
          <path d="M30 14.5h3.5v16H30" />
          <circle cx="24" cy="22.5" r="1.4" fill={color} stroke="none" />
        </g>
      );
    case "sheet":
      return (
        <g {...s} strokeWidth={1.8}>
          <rect x="14.5" y="14.5" width="19" height="14" rx="1.5" />
          <path d="M14.5 19.5h19M21 14.5v14M27.5 14.5v14" />
        </g>
      );
    case "slides":
      return (
        <g {...s} strokeWidth={1.8}>
          <rect x="14.5" y="14.5" width="19" height="12.5" rx="1.5" />
          <path d="M24 27v3.5M20 30.5h8" />
        </g>
      );
    case "model3d":
      return (
        <g {...s} strokeWidth={1.8}>
          <path d="M24 13.5l8.5 4.7v9.6L24 32.5l-8.5-4.7v-9.6z" />
          <path d="M24 13.5v9.5m0 0l8.5-4.8M24 23l-8.5-4.8" />
        </g>
      );
    case "mail":
      return (
        <g {...s} strokeWidth={1.8}>
          <rect x="14.5" y="15.5" width="19" height="13" rx="1.5" />
          <path d="M14.5 16.5l9.5 7 9.5-7" />
        </g>
      );
    case "calendar":
      return (
        <g {...s} strokeWidth={1.8}>
          <rect x="15" y="15.5" width="18" height="14" rx="1.5" />
          <path d="M15 19.5h18M19.5 13.5v3.5M28.5 13.5v3.5" />
          <circle cx="24" cy="24.5" r="1.4" fill={color} stroke="none" />
        </g>
      );
    case "contact":
      return (
        <g {...s} strokeWidth={1.8}>
          <circle cx="24" cy="19" r="3.5" />
          <path d="M17 29.5c1.2-3.6 4-5.3 7-5.3s5.8 1.7 7 5.3" />
        </g>
      );
    case "geo":
      return (
        <g {...s} strokeWidth={1.8}>
          <path d="M24 30s-6-6.2-6-10.5a6 6 0 0 1 12 0C30 23.8 24 30 24 30z" />
          <circle cx="24" cy="19.5" r="2" />
        </g>
      );
    case "ebook":
      return (
        <g {...s} strokeWidth={1.8}>
          <path d="M24 17.5c-2.5-1.8-5.5-2-9-1.5v12.5c3.5-.5 6.5-.3 9 1.5 2.5-1.8 5.5-2 9-1.5V16c-3.5-.5-6.5-.3-9 1.5z" />
          <path d="M24 17.5v12.5" />
        </g>
      );
    case "font":
      return (
        <g {...s} strokeWidth={2}>
          <path d="M17.5 29.5l6.5-15 6.5 15M20 24h8" />
        </g>
      );
    case "package":
      return (
        <g {...s} strokeWidth={1.8}>
          <path d="M24 14l8.5 4.3v9.4L24 32l-8.5-4.3v-9.4z" />
          <path d="M15.5 18.3L24 22.6l8.5-4.3M24 22.6V32" />
        </g>
      );
    case "design":
      return (
        <g {...s} strokeWidth={1.8}>
          <path d="M16 30l3-7.5L28.5 13l3.5 3.5-9.5 9.5z" />
          <path d="M26 15.5l3.5 3.5" />
        </g>
      );
    // unknown: neutral document (lines) + extension badge — never a "?"
    // (a question mark would otherwise show for many everyday file types)
    // pdf / text / doc — document lines
    default:
      return (
        <g {...s}>
          <path d="M16.5 17.5h15M16.5 22.5h15M16.5 27.5h9" />
        </g>
      );
  }
}

export const FileTypeIcon = memo(function FileTypeIcon({ name, isDir, px = 40, className, title }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bodyId = `ftb-${uid}`;
  const sheenId = `fts-${uid}`;

  if (isDir) {
    return (
      <svg width={px} height={px} viewBox="0 0 48 48" className={className} aria-hidden={!title} role={title ? "img" : undefined}>
        {title && <title>{title}</title>}
        <defs>
          <linearGradient id={bodyId} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor="#2A4370" />
            <stop offset="0.55" stopColor="#16233F" />
            <stop offset="1" stopColor="#0A1224" />
          </linearGradient>
        </defs>
        {/* back tab */}
        <path
          d="M5 15a4 4 0 0 1 4-4h9.5l4 4H39a4 4 0 0 1 4 4v2H5z"
          fill="#33507F"
        />
        {/* body */}
        <rect x="5" y="18" width="38" height="21" rx="4" fill={`url(#${bodyId})`} stroke="rgba(147,197,253,0.45)" strokeWidth="1" />
        {/* top sheen */}
        <path d="M6.5 19.5h35a0 0 0 0 1 0 0v3a0 0 0 0 1 0 0h-35z" fill="rgba(180,205,253,0.14)" />
      </svg>
    );
  }

  const info = getFileTypeInfo(name ?? "");
  return (
    <svg width={px} height={px} viewBox="0 0 48 48" className={className} aria-hidden={!title} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={bodyId} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#22375F" />
          <stop offset="0.5" stopColor="#131F3A" />
          <stop offset="1" stopColor="#080E1E" />
        </linearGradient>
        <linearGradient id={sheenId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(190,215,255,0.28)" />
          <stop offset="1" stopColor="rgba(190,215,255,0)" />
        </linearGradient>
      </defs>
      {/* document body with dog-ear */}
      <path
        d="M12 3.5h15.5L38 14v26.5a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4v-33a4 4 0 0 1 4-4z"
        fill={`url(#${bodyId})`}
        stroke="rgba(147,197,253,0.45)"
        strokeWidth="1"
      />
      {/* dog-ear */}
      <path d="M27.5 3.5V10a4 4 0 0 0 4 4H38z" fill="#33507F" stroke="rgba(147,197,253,0.35)" strokeWidth="0.8" />
      {/* top sheen following the body edge */}
      <path d="M9.5 5.5a2.5 2.5 0 0 1 2.5-2h14v3.5H9.5z" fill={`url(#${sheenId})`} opacity="0.8" />
      <Glyph category={info.category} color={info.color} />
      {/* label pill */}
      {info.label && (
        <>
          <rect x="9" y="33" width="30" height="10" rx="5" fill={info.color} />
          <text x="24" y="40.6" textAnchor="middle" fontSize="7.2" fontWeight={800} fill="#0A1020" style={{ letterSpacing: 0.4 }}>
            {info.label}
          </text>
        </>
      )}
    </svg>
  );
});
