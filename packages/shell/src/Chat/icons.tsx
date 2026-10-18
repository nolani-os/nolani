/**
 * Chat icon set — inline SVGs in lucide style to match Open WebUI's chat input.
 * Stroke-only (currentColor), 24×24 viewBox, 1.5px stroke width.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: Props & { children: React.ReactNode }) {
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

/** 📎 — paperclip, "attach" */
export function PaperclipIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8-8" />
    </Icon>
  );
}

/** 📍 — map-pin, marker / region selection */
export function PinIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </Icon>
  );
}

/** 🎤 — microphone, push-to-talk dictation */
export function MicIcon(props: Props) {
  return (
    <Icon {...props}>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </Icon>
  );
}

/** Waveform — voice mode (continuous loop) */
export function AudioLinesIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </Icon>
  );
}

/** ✕ — close / remove chip */
export function XIcon(props: Props) {
  return (
    <Icon {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Icon>
  );
}

/** ⏹ — stop generation */
export function StopIcon(props: Props) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  );
}

/** ➤ — send arrow (WebUI-style up-arrow inside circle) */
export function SendIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  );
}

/** ▾ — chevron-down for dropdown caret */
export function ChevronDownIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

/** 🤖 — Bot/assistant icon (legacy, kept for compatibility) */
export function BotIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </Icon>
  );
}

/** ✦ — 4-pointed sparkles (used in the Clara/Copilot-style toggle button).
 * Filled, white-on-gradient; no stroke. */
export function SparklesIcon({ size = 14, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 2 13.5 8.5 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Z" />
      <path d="M19 14 19.8 17.2 23 18l-3.2.8L19 22l-.8-3.2L15 18l3.2-.8L19 14Z" opacity="0.85" />
      <path d="M5 14 5.7 16.7 8.5 17.5 5.7 18.3 5 21 4.3 18.3 1.5 17.5 4.3 16.7 5 14Z" opacity="0.6" />
    </svg>
  );
}

/** 📡 — radio waves, live conversation (LiveKit full-duplex) */
export function LiveVoiceIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
      <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    </Icon>
  );
}
