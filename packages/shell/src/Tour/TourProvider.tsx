/**
 * Guided tours through the shell.
 *
 * Ways to start:
 *  - CustomEvent `claraos-start-tour` (detail: { tourId })  — predefined tour
 *  - CustomEvent `claraos-show-tour`  (detail: { name?, steps }) — dynamic
 *    tour from the guide assistant (actionBus `shell/show_tour`); steps are
 *    validated against the anchor manifest, unknown anchors are dropped.
 *  - URL parameter `?tour=<id>`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EVENTS, Joyride, type EventData, type Step } from "react-joyride";
import { TOUR_ANCHORS, tourSelector } from "./anchors";
import { clearFrameHighlight } from "./frameTour";
import { resolveTour, type TourStepDef } from "./tours";
import { TourCard } from "./TourCard";

export const tourDoneKey = (tourId: string) => `claraos-tour-done:${tourId}`;

const PLACEMENTS = new Set(["top", "bottom", "left", "right", "auto", "center"]);

function mapStep(s: TourStepDef): Step {
  const anchor = TOUR_ANCHORS[s.anchor];
  const centered = s.anchor === "center";
  return {
    target: centered ? "body" : tourSelector(s.anchor),
    placement: s.placement ?? (centered ? "center" : "auto"),
    title: s.title,
    content: s.content,
    // Always clear frame highlights of the previous step before the next one shows.
    before: async () => {
      if (!anchor.ensure) clearFrameHighlight();
      await anchor.ensure?.();
    },
    blockTargetInteraction: !s.spotlightClicks,
    ...(centered ? { hideOverlay: false, spotlightPadding: 0 } : {}),
  } as Step;
}

/** Raw steps (LLM/actionBus) -> validated TourStepDefs. */
function sanitizeSteps(raw: unknown): TourStepDef[] {
  if (!Array.isArray(raw)) return [];
  const defs: TourStepDef[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const anchor = String(r.anchor ?? "");
    if (!TOUR_ANCHORS[anchor]) {
      console.warn("[tour] unbekannter Anker verworfen:", anchor);
      continue;
    }
    const placement = String(r.placement ?? "");
    defs.push({
      anchor,
      title: String(r.title ?? ""),
      content: String(r.content ?? ""),
      placement: PLACEMENTS.has(placement)
        ? (placement as TourStepDef["placement"])
        : undefined,
      spotlightClicks: r.spotlight_clicks === true || r.spotlightClicks === true,
    });
  }
  return defs;
}

export function TourProvider() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const tourIdRef = useRef<string | null>(null);

  // doneId: only named tours get a done flag; dynamic ones do not.
  const startSteps = useCallback((defs: TourStepDef[], doneId: string | null) => {
    if (!defs.length) return;
    tourIdRef.current = doneId;
    setSteps(null); // hard-stop the running tour, then remount
    requestAnimationFrame(() => setSteps(defs.map(mapStep)));
  }, []);

  const start = useCallback((tourId: string) => {
    try {
      const tour = resolveTour(tourId);
      startSteps(tour.steps, tour.id);
    } catch (e) {
      console.warn("[tour]", e);
    }
  }, [startSteps]);

  useEffect(() => {
    const onStart = (e: Event) => {
      const tourId = (e as CustomEvent).detail?.tourId;
      if (typeof tourId === "string") start(tourId);
    };
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      startSteps(sanitizeSteps(detail.steps), null);
    };
    window.addEventListener("claraos-start-tour", onStart);
    window.addEventListener("claraos-show-tour", onShow);
    const bootTour = new URLSearchParams(window.location.search).get("tour");
    if (bootTour) start(bootTour);
    return () => {
      window.removeEventListener("claraos-start-tour", onStart);
      window.removeEventListener("claraos-show-tour", onShow);
    };
  }, [start, startSteps]);

  const onEvent = useCallback((data: EventData, controls: { next: () => void }) => {
    // Missing anchor (e.g. no pinned apps) => skip the step,
    // do not abort the whole tour.
    if (data.type === EVENTS.TARGET_NOT_FOUND) {
      controls.next();
      return;
    }
    if (data.type === EVENTS.TOUR_END) {
      clearFrameHighlight();
      const endedTourId = tourIdRef.current;
      if (endedTourId) {
        localStorage.setItem(tourDoneKey(endedTourId), new Date().toISOString());
        // Let the nudge engine (e.g. satisfaction nudge) re-evaluate right away
        // instead of only on the next shell reload.
        window.dispatchEvent(
          new CustomEvent("claraos-tour-done", { detail: { tourId: endedTourId } }),
        );
      }
      tourIdRef.current = null;
      setSteps(null);
    }
  }, []);

  if (!steps) return null;
  return (
    <Joyride
      steps={steps}
      run
      continuous
      onEvent={onEvent}
      tooltipComponent={TourCard}
      options={{
        skipBeacon: true,
        closeButtonAction: "skip",
        overlayClickAction: false,
        zIndex: 100000,
      }}
    />
  );
}
