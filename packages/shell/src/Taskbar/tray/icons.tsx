/**
 * Live glyphs for the tray bar. Same style as Chat/icons.tsx:
 * inline SVG, stroke currentColor, 16 px, lucide-like — skins color them
 * via the button color.
 */

export function VolumeGlyph({ level, muted }: { level: number; muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {muted ? (
        <>
          <line x1="16" y1="9" x2="22" y2="15" />
          <line x1="22" y1="9" x2="16" y2="15" />
        </>
      ) : (
        <>
          {level > 0 && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
          {level > 55 && <path d="M18.5 5.5a9.5 9.5 0 0 1 0 13" />}
        </>
      )}
    </svg>
  );
}

export function MicGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      {muted && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

export function WifiGlyph({ signal, off, btConnected }: {
  signal: number | null; off?: boolean; btConnected?: boolean;
}) {
  const s = signal ?? 0;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" opacity={off ? 0.4 : 1} />
      <path d="M8.5 15.5a5 5 0 0 1 7 0" opacity={off || s < 15 ? 0.25 : 1} />
      <path d="M5.5 12a9.5 9.5 0 0 1 13 0" opacity={off || s < 45 ? 0.25 : 1} />
      <path d="M2.5 8.5a14 14 0 0 1 19 0" opacity={off || s < 75 ? 0.25 : 1} />
      {off && <line x1="4" y1="4" x2="20" y2="20" />}
      {btConnected && (
        <path d="M20 16.2l2.2 2.2-2.2 2.2v-4.4zm0 0l2.2-2.2-2.2-2.2v4.4"
          strokeWidth="1.2" transform="scale(0.9) translate(1.5 1.5)" />
      )}
    </svg>
  );
}

export function BatteryGlyph({ percent, charging }: { percent: number; charging: boolean }) {
  const width = Math.max(0.5, (percent / 100) * 14);
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="7" width="18" height="10" rx="2" />
      <line x1="22.5" y1="10.5" x2="22.5" y2="13.5" />
      <rect x="4" y="9" width={width} height="6" rx="1" fill="currentColor" stroke="none" />
      {charging && (
        <path d="M12.5 4.5 9 12h3l-1.5 7 5.5-9h-3.5l1.5-5.5z" fill="currentColor"
          stroke="var(--bg-taskbar, #1c2034)" strokeWidth="1" />
      )}
    </svg>
  );
}

export function BrightnessGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function BluetoothGlyph({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      opacity={off ? 0.5 : 1}>
      <path d="M7 7l10 10-5 5V2l5 5L7 17" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}
