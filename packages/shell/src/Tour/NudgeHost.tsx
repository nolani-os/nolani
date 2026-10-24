/**
 * Proactive prompts ("nudges") of the guide companion — generalizes the
 * welcome card.
 *
 * Rules (product decision + CHI 2025 research):
 *  - only in the shell, bottom right, always politely dismissible
 *  - "Later" => server-side backoff (24h, doubles with each dismissal,
 *    capped at 30 days) — Clara leaves the user alone until a better moment
 *  - globally at most ONE new nudge per day (the same one may return)
 *  - opt-out per user (Settings -> "What Clara knows about me")
 * The state lives on the server (cross-device), the conditions here
 * (tour flags are localStorage).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@claraos/core";
import { tourDoneKey } from "./TourProvider";
import styles from "./NudgeHost.module.css";

interface NudgeState {
  shown?: number;
  dismissed?: number;
  done?: boolean;
  next_after?: string;
  last_shown?: string;
}

interface ServerState {
  optout: boolean;
  last_any_shown?: string | null;
  last_any_id?: string | null;
  nudges: Record<string, NudgeState>;
}

interface Facts {
  profileExists: boolean;
  tourDone: (id: string) => boolean;
}

/** Texts live in the "tour" catalog: `nudges.<id>.title|text|primary|secondary`. */
interface NudgeDef {
  id: string;
  testId: string;
  eligible: (f: Facts) => boolean;
  primary: { run: () => void };
  secondary?: { run: () => void };
}

const startTour = (tourId: string) => () =>
  window.dispatchEvent(new CustomEvent("claraos-start-tour", { detail: { tourId } }));

/** Order = priority. */
const NUDGES: NudgeDef[] = [
  {
    id: "welcome",
    testId: "welcome-card",
    eligible: (f) => !f.profileExists && !f.tourDone("claraos-basics"),
    primary: { run: startTour("claraos-basics") },
    secondary: {
      run: () => window.dispatchEvent(new CustomEvent("claraos-open-clara-chat")),
    },
  },
  {
    id: "device-setup",
    testId: "nudge-device-setup",
    eligible: (f) => f.tourDone("claraos-basics") && !f.tourDone("geraete-setup"),
    primary: { run: startTour("geraete-setup") },
  },
  {
    id: "files-tour",
    testId: "nudge-files-tour",
    eligible: (f) => f.tourDone("claraos-basics") && !f.tourDone("files-basics"),
    primary: { run: startTour("files-basics") },
  },
  {
    id: "fotos-tour",
    testId: "nudge-fotos-tour",
    eligible: (f) => f.tourDone("claraos-basics") && !f.tourDone("fotos-basics"),
    primary: { run: startTour("fotos-basics") },
  },
  {
    // Satisfaction nudge — applies as soon as at least one tour has been
    // completed (preferably right after a tour ends, via claraos-tour-done).
    // Opens the global feedback dialog; the answer goes through
    // POST /api/claraos/feedback into the configured feedback inbox.
    id: "feedback-after-tour",
    testId: "nudge-feedback",
    eligible: (f) =>
      ["claraos-basics", "geraete-setup", "files-basics", "fotos-basics"].some((t) =>
        f.tourDone(t),
      ),
    primary: {
      run: () =>
        window.dispatchEvent(
          new CustomEvent("claraos-open-feedback", { detail: { source: "nudge" } }),
        ),
    },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep respecting the legacy flag (the user had closed the card with X). */
function legacyWelcomeBlocked(): boolean {
  const v = localStorage.getItem("claraos-welcome-dismissed");
  if (!v) return false;
  if (v === "forever") return true;
  return Date.now() < Date.parse(v);
}

function pickNudge(server: ServerState, facts: Facts): NudgeDef | null {
  if (server.optout) return null;
  const lastAny = server.last_any_shown ? Date.parse(server.last_any_shown) : 0;
  for (const def of NUDGES) {
    const st = server.nudges[def.id] ?? {};
    if (st.done) continue;
    if (def.id === "welcome" && legacyWelcomeBlocked()) continue;
    if (st.next_after && Date.now() < Date.parse(st.next_after)) continue;
    if (!def.eligible(facts)) continue;
    // Daily cap: a DIFFERENT nudge only 24h after the last one; the same
    // (still unanswered) one may stay.
    if (lastAny && Date.now() - lastAny < DAY_MS && server.last_any_id !== def.id) {
      continue;
    }
    return def;
  }
  return null;
}

export function NudgeHost() {
  const [nudge, setNudge] = useState<NudgeDef | null>(null);
  const { t } = useTranslation("tour");

  // Evaluation lives in a function instead of the mount effect so it can also
  // run after a tour ends (claraos-tour-done) — otherwise a tour-dependent
  // nudge only appeared on the next shell reload.
  useEffect(() => {
    let cancelled = false;
    const evaluate = async () => {
      try {
        const [profileRes, nudgeRes] = await Promise.all([
          fetch("/api/claraos/guide/profile", { credentials: "include" }),
          fetch("/api/claraos/guide/nudges", { credentials: "include" }),
        ]);
        const profile = await profileRes.json();
        const server: ServerState = await nudgeRes.json();
        if (cancelled) return;
        const facts: Facts = {
          profileExists: Boolean(profile.exists),
          tourDone: (id) => Boolean(localStorage.getItem(tourDoneKey(id))),
        };
        const picked = pickNudge(server, facts);
        if (!picked) return;
        setNudge(picked);
        // only count 'shown' if this nudge was not already freshly displayed
        const last = server.nudges[picked.id]?.last_shown;
        if (!last || Date.now() - Date.parse(last) > 6 * 60 * 60 * 1000) {
          void report(picked.id, "shown");
        }
      } catch {
        /* API unreachable => better not to nag */
      }
    };
    void evaluate();
    const onTourDone = () => void evaluate();
    window.addEventListener("claraos-tour-done", onTourDone);
    return () => {
      cancelled = true;
      window.removeEventListener("claraos-tour-done", onTourDone);
    };
  }, []);

  if (!nudge) return null;
  const key = `nudges.${nudge.id}`;

  const act = (outcome: "accepted" | "dismissed", run?: () => void) => {
    void report(nudge.id, outcome);
    setNudge(null);
    run?.();
  };

  return (
    <div className={styles.card} data-testid={nudge.testId} data-nudge={nudge.id}>
      <button className={styles.close} title={t("nudge.later")}
              onClick={() => act("dismissed")}>✕</button>
      <div className={styles.title}>{t(`${key}.title`)}</div>
      <div className={styles.text}>{t(`${key}.text`)}</div>
      <div className={styles.btns}>
        <button className={styles.primary}
                onClick={() => act("accepted", nudge.primary.run)}>
          {t(`${key}.primary`)}
        </button>
        {nudge.secondary && (
          <button className={styles.secondary}
                  onClick={() => act("accepted", nudge.secondary!.run)}>
            {t(`${key}.secondary`)}
          </button>
        )}
        <button className={styles.ghost} onClick={() => act("dismissed")}>
          {t("nudge.later")}
        </button>
      </div>
    </div>
  );
}

function report(id: string, outcome: string) {
  return fetch(`/api/claraos/guide/nudges/${id}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  }).catch(() => undefined);
}
