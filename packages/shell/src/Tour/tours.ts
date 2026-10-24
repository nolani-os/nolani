/**
 * Static tour definitions.
 *
 * The guide assistant delivers tours at runtime using the same structure
 * (tool `start_tour`/`show_tour_step`); the IDs here must exist in the
 * TOUR_ANCHORS manifest — `resolveTour` validates that.
 *
 * Static tours carry only keys; their texts live in the "tour" catalog
 * (`tours.<tourId>.steps.<key>.title|content`) and are resolved when the tour
 * starts, so they follow the UI language.
 */
import { i18n } from "@claraos/core";
import { TOUR_ANCHORS } from "./anchors";

export interface TourStepDef {
  anchor: string;
  title: string;
  content: string;
  placement?: "top" | "bottom" | "left" | "right" | "auto" | "center";
  /** Let clicks through to the highlighted element (e.g. "try it out"). */
  spotlightClicks?: boolean;
}

export interface TourDef {
  id: string;
  name: string;
  steps: TourStepDef[];
}

/** A step of a static tour: texts come from the catalog via `key`. */
interface StaticStepDef extends Omit<TourStepDef, "title" | "content"> {
  key: string;
}

interface StaticTourDef {
  id: string;
  steps: StaticStepDef[];
}

export const TOURS: Record<string, StaticTourDef> = {
  "claraos-basics": {
    id: "claraos-basics",
    steps: [
      { key: "welcome", anchor: "center", placement: "center" },
      { key: "clara", anchor: "taskbar-clara" },
      { key: "search", anchor: "startmenu-input" },
      { key: "apps", anchor: "startmenu-pinned" },
      { key: "taskbar", anchor: "taskbar-pinned" },
      { key: "tray", anchor: "taskbar-tray" },
      { key: "voice", anchor: "taskbar-voice" },
      { key: "done", anchor: "center", placement: "center" },
    ],
  },
  "files-basics": {
    id: "files-basics",
    steps: [
      { key: "intro", anchor: "center", placement: "center" },
      { key: "places", anchor: "files-sidebar" },
      { key: "content", anchor: "files-content" },
      { key: "search", anchor: "files-search" },
      { key: "newFolder", anchor: "files-new-folder" },
      { key: "done", anchor: "center", placement: "center" },
    ],
  },
  "fotos-basics": {
    id: "fotos-basics",
    steps: [
      { key: "intro", anchor: "center", placement: "center" },
      { key: "app", anchor: "immich-frame" },
      { key: "timeline", anchor: "immich-photos" },
      { key: "albums", anchor: "immich-albums" },
      { key: "tip", anchor: "center", placement: "center" },
    ],
  },
  "geraete-setup": {
    id: "geraete-setup",
    steps: [
      { key: "intro", anchor: "center", placement: "center" },
      { key: "push", anchor: "settings-push" },
      { key: "computer", anchor: "center", placement: "center" },
    ],
  },
};

/**
 * Validates all anchors of a tour against the manifest (throws on unknown ID)
 * and resolves its texts in the current UI language.
 */
export function resolveTour(tourId: string): TourDef {
  const tour = TOURS[tourId];
  if (!tour) throw new Error(`Unbekannte Tour: ${tourId}`);
  for (const step of tour.steps) {
    if (!TOUR_ANCHORS[step.anchor]) {
      throw new Error(`Tour ${tourId}: unbekannter Anker ${step.anchor}`);
    }
  }
  const base = `tour:tours.${tourId}`;
  return {
    id: tour.id,
    name: i18n.t(`${base}.name`),
    steps: tour.steps.map(({ key, ...step }) => ({
      ...step,
      title: i18n.t(`${base}.steps.${key}.title`),
      content: i18n.t(`${base}.steps.${key}.content`),
    })),
  };
}
