/**
 * Teams icon set — inline SVGs in lucide style (same pattern as Chat/icons.tsx).
 * Stroke-only (currentColor), 24×24 viewBox. Replaces the emoji icons that
 * clashed with the clara-glass shell aesthetic.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 🔍 search */
export function SearchIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  );
}

/** 🔔 activity */
export function BellIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Icon>
  );
}

/** 💬 chat */
export function MessageIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </Icon>
  );
}

/** 👥 teams */
export function UsersIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

/** 📅 calendar */
export function CalendarIcon(props: Props) {
  return (
    <Icon {...props}>
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Icon>
  );
}

/** 📞 calls */
export function PhoneIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Icon>
  );
}

/** 📁 files */
export function FolderIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  );
}

/** 📝 posts */
export function PostsIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Icon>
  );
}

/** 📋 plan / kanban */
export function KanbanIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M6 5v11M12 5v6M18 5v14" />
    </Icon>
  );
}

/** 📚 wiki */
export function BookIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </Icon>
  );
}

/** 📎 attach */
export function PaperclipIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8-8" />
    </Icon>
  );
}

/** 😀 emoji */
export function SmileIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" x2="9.01" y1="9" y2="9" />
      <line x1="15" x2="15.01" y1="9" y2="9" />
    </Icon>
  );
}

/** ➤ send */
export function SendIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </Icon>
  );
}

/** 🔒 encrypted room */
export function LockIcon(props: Props) {
  return (
    <Icon {...props}>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

/** # channel */
export function HashIcon(props: Props) {
  return (
    <Icon {...props}>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </Icon>
  );
}

/** 👤+ invite member */
export function UserPlusIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M2 21a8 8 0 0 1 13.29-6" />
      <circle cx="10" cy="8" r="5" />
      <path d="M19 16v6M22 19h-6" />
    </Icon>
  );
}

/** 🔗 invite link / guest */
export function LinkIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  );
}

/** Member list (right panel) */
export function PanelUsersIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="9" r="3.5" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.9" />
      <path d="M17.2 14.1A5.5 5.5 0 0 1 20.5 19" />
    </Icon>
  );
}

/** 📌 pin */
export function PinIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Icon>
  );
}

/** 🔖 saved/bookmark */
export function BookmarkIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </Icon>
  );
}

/** ↓ jump to bottom */
export function ArrowDownIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Icon>
  );
}

/** Thread — message with a branch */
export function ThreadIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <path d="M8 10h8M8 14h4" />
    </Icon>
  );
}

/** + add */
export function PlusIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M5 12h14M12 5v14" />
    </Icon>
  );
}

/** × close */
export function XIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

/* ── Messenger badges ──────────────────────────────────────────────────────
   Show in the chat overview which service a conversation runs over.
   Deliberately distinguishable by SHAPE, not color: in a list the icon sits
   small next to the name — two similarly colored dots would be impossible
   to tell apart there. */

/** Matrix — the three corners of the bracket logo, heavily simplified. */
export function MatrixIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M4 3H3v18h1M20 3h1v18h-1" />
      <path d="M8 15V9m0 0c0-1 3-1 3 0v6m0-6c0-1 3-1 3 0v6" />
    </Icon>
  );
}

/** Nextcloud Talk — speech bubble with the three dots of the Nextcloud brand. */
export function TalkIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M21 12a8 8 0 1 1-3.2-6.4" />
      <path d="M21 4.5v4.2h-4.2" />
      <circle cx="8.5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="15.5" cy="12" r="1" />
    </Icon>
  );
}

// ── Messenger badges ────────────────────────────────────────────────────────
// Chats should be distinguishable by the icon of their service (Signal,
// ClaraOS, …). Deliberately simple, single-color shapes — they sit as a small
// badge on the round avatar and must stay legible at 12 px rather than
// reproduce the brand logo.

export function ClaraIcon(props: Props) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round">
      {/* open ring = the "C" of the ClaraOS brand */}
      <path d="M17.5 6.5A7 7 0 1 0 19 12" />
    </svg>
  );
}

export function SignalIcon(props: Props) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinejoin="round">
      {/* speech bubble with a detached tail — Signal's basic shape */}
      <path d="M12 3.2c-4.9 0-8.8 3.4-8.8 7.6 0 2.3 1.2 4.4 3.1 5.8L5 20.8l4.6-1.6c.8.2 1.6.3 2.4.3 4.9 0 8.8-3.4 8.8-7.7S16.9 3.2 12 3.2Z" />
    </svg>
  );
}

export function WhatsAppIcon(props: Props) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M12 3.4a8.6 8.6 0 0 0-7.4 13l-1.2 4.2 4.3-1.1A8.6 8.6 0 1 0 12 3.4Z" />
      <path d="M9 9.2c.3 1.9 2.2 4.3 4.2 5 .8.3 1.4-.1 1.7-.8" strokeWidth="1.6" />
    </svg>
  );
}

export function TelegramIcon(props: Props) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinejoin="round">
      <path d="M21 4.5 2.8 11.4l5.3 1.7L19 6.8l-8.3 8.1.3 5 2.6-3.6 4.2 3Z" />
    </svg>
  );
}
