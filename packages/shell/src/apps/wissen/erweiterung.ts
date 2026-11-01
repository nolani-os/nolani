/** Extension points of the Knowledge app.
 *
 * The core (`WissenKern`) knows only knowledge: collections, pages, search,
 * graph, inbox, trash. Two things come from outside:
 *
 * - **Sections** such as Strategy register their rail entries and views
 *   (`WissenSektion`). The core never imports their views, so a build without
 *   the section does not contain them (the standalone app relies on this).
 * - **Functions** that need the rest of the installation — the assistant,
 *   web clipping, sharing with other people, comments, shopping baskets —
 *   are switched through `WissenFunktionenContext`. The shell has all of
 *   them; a device-local app without server and without other users has none.
 */
import { createContext, useContext, type ReactNode } from "react";
import { i18n } from "@claraos/core";
import type { IconName } from "../../components/Icon";
import type { KbObjectSlim, Stage } from "../ideas/types";

export type Bereich = "wissen" | "strategie";

export interface RailItem {
  key: string;
  icon: IconName;
  label: string;
  bereich: Bereich;
}

/** `label` is a getter, read in the UI language whenever it is shown. */
export const railItem = (key: string, icon: IconName, bereich: Bereich): RailItem =>
  ({ key, icon, bereich, get label() { return i18n.t(`wissen:nav.${key}`); } });

/** What a section's view gets from the core. */
export interface SektionKontext {
  objects: KbObjectSlim[];
  currentUser: string;
  reloadTick: number;
  reload: () => void;
  onOpen: (id: string) => void;
  onMoveStage: (id: string, stage: Stage) => void;
}

export interface WissenSektion {
  bereich: Bereich;
  rails: RailItem[];
  /** The four tabs shown on phones while this section is active. */
  mobileTabs: string[];
  start: string;
  /** Rail the `open_dashboard` action leads to, if the section has one. */
  dashboard?: string;
  /** Path segments of the iframe navigator (`/goals` …) → rail. */
  pfade: Record<string, string>;
  render: (rail: string, k: SektionKontext) => ReactNode;
}

export interface WissenFunktionen {
  /** Assistant buttons ("Develop", "Create with …") and its questions in the detail view. */
  assistent: boolean;
  /** Save a web page as an entry (needs the server's fetcher). */
  clip: boolean;
  /** Visibility, inviting people, sharing collections. */
  teilen: boolean;
  kommentare: boolean;
  /** "Shopping basket for this idea" (needs the shopping app). */
  einkauf: boolean;
  /** Turns a stored file address (attachment) into one the editor can show.
   *  Unset: the address is used as is (the server serves it). */
  dateiAufloesen?: (url: string) => Promise<string>;
  /** Saves a download (export archive) where links cannot. Unset: plain link. */
  herunterladen?: (url: string) => Promise<void>;
  /** Opens the host's own settings (device-local app). Unset: no entry. */
  einstellungen?: () => void;
  /** Opens a web link. Unset: the installation's own browser window. */
  linkOeffnen?: (url: string) => void;
}

export const ALLE_FUNKTIONEN: WissenFunktionen = {
  assistent: true, clip: true, teilen: true, kommentare: true, einkauf: true,
};

export const NUR_LOKAL: WissenFunktionen = {
  assistent: false, clip: false, teilen: false, kommentare: false, einkauf: false,
};

export const WissenFunktionenContext = createContext<WissenFunktionen>(ALLE_FUNKTIONEN);

export const useWissenFunktionen = () => useContext(WissenFunktionenContext);
