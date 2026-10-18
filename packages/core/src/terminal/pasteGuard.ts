/**
 * Paste protection for the terminal.
 *
 * Modeled on Konsole's `TerminalDisplay::doPaste()`. The attack in question is
 * not "the user accidentally pastes too much", but **hidden control characters
 * in copied text**: a web page can prepare text so that a `\r` sits in the
 * middle when pasted and the command runs immediately, before it could be
 * read — or so that escape sequences manipulate the terminal state.
 *
 * Rules (taken from the original):
 *   1. Everything in the Unicode category "Other, control" except \t \r \n is
 *      considered unsafe and is listed, not silently filtered.
 *   2. Line breaks are normalized to \r.
 *   3. With bracketed paste active, ESC (0x1B) is REMOVED from the text —
 *      otherwise the content itself could contain the end marker \e[201~ and
 *      break out of the bracket.
 *   4. Very large pastes are reported (Konsole: > 8000 characters).
 *
 * Pure functions without DOM — the tests run in Node.
 */

export const HUGE_PASTE_THRESHOLD = 8000;

/** Characters that are legitimate in terminal input. */
const ALLOWED_CONTROL = new Set(["\t", "\r", "\n"]);

export interface ControlCharFinding {
  /** Position in the original text */
  index: number;
  /** Codepoint */
  code: number;
  /** "U+0003" */
  unicode: string;
  /** Caret notation, e.g. "^C" */
  caret: string;
  /** Plain-text reason why this is dangerous */
  meaning: string;
}

export interface PasteAnalysis {
  /** Text with control characters removed, \r-normalized (and without ESC if bracketed) */
  sanitized: string;
  /** Original text, only \r-normalized */
  raw: string;
  /** unsafe control characters found (deduplicated by code) */
  findings: ControlCharFinding[];
  /** Character count above the warning threshold? */
  huge: boolean;
  /** Does the text contain line breaks? (=> would execute immediately) */
  multiline: boolean;
  /** true if it may be pasted without confirmation */
  safe: boolean;
}

const MEANINGS: Record<number, string> = {
  0x03: "Programmabbruch (Ctrl+C)",
  0x04: "Eingabeende (Ctrl+D) — kann die Sitzung beenden",
  0x07: "Signalton",
  0x08: "Rückschritt — kann Text unsichtbar überschreiben",
  0x0b: "Vertikaltabulator",
  0x0c: "Seitenvorschub",
  0x13: "Ausgabe anhalten (Ctrl+S) — Terminal wirkt eingefroren",
  0x1a: "Prozess anhalten (Ctrl+Z)",
  0x1b: "Escape — steuert den Terminalzustand",
  0x1c: "Beenden (Ctrl+\\)",
  0x7f: "Löschen",
};

function caretNotation(code: number): string {
  if (code === 0x7f) return "^?";
  if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

function isUnsafeControl(ch: string): boolean {
  if (ALLOWED_CONTROL.has(ch)) return false;
  const code = ch.codePointAt(0) ?? 0;
  // C0 range, DEL and C1 range (0x80–0x9F, home of CSI/OSC among others)
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Analyze paste text.
 *
 * @param bracketedPaste  Is bracketed paste currently active in the terminal? Then
 *                        ESC must also be removed from the "full" text (breakout protection).
 */
export function analyzePaste(text: string, bracketedPaste = true): PasteAnalysis {
  // Normalize line endings: \r\n → \r, then \n → \r (Konsole, bug 421480)
  const raw = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");

  const seen = new Set<number>();
  const findings: ControlCharFinding[] = [];
  let sanitized = "";

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isUnsafeControl(ch)) {
      const code = ch.codePointAt(0) ?? 0;
      if (!seen.has(code)) {
        seen.add(code);
        findings.push({
          index: i,
          code,
          unicode: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
          caret: caretNotation(code),
          meaning: MEANINGS[code] ?? "Steuerzeichen",
        });
      }
      continue; // remove from the sanitized text
    }
    sanitized += ch;
  }

  const multiline = raw.includes("\r");
  const huge = raw.length > HUGE_PASTE_THRESHOLD;

  return {
    sanitized,
    // The "paste everything" path must not contain ESC with bracketed paste
    // either, otherwise the content breaks out of the bracket.
    raw: bracketedPaste ? raw.replace(/\x1b/g, "") : raw,
    findings,
    huge,
    multiline,
    safe: findings.length === 0 && !huge,
  };
}

/** Short, human-readable reason why confirmation is requested. */
export function pasteWarningSummary(a: PasteAnalysis): string {
  const parts: string[] = [];
  if (a.findings.length > 0) {
    parts.push(
      `${a.findings.length} Steuerzeichen (${a.findings
        .slice(0, 4)
        .map((f) => `${f.caret} ${f.meaning}`)
        .join(", ")}${a.findings.length > 4 ? ", …" : ""})`,
    );
  }
  if (a.huge) parts.push(`${a.raw.length.toLocaleString("de-DE")} Zeichen`);
  return parts.join(" · ");
}
