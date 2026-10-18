/**
 * Static tour definitions.
 *
 * The guide assistant delivers tours at runtime using the same structure
 * (tool `start_tour`/`show_tour_step`); the IDs here must exist in the
 * TOUR_ANCHORS manifest — `resolveTour` validates that.
 */
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

export const TOURS: Record<string, TourDef> = {
  "claraos-basics": {
    id: "claraos-basics",
    name: "ClaraOS kennenlernen",
    steps: [
      {
        anchor: "center",
        title: "Willkommen bei ClaraOS! 👋",
        content:
          "Schön, dass du da bist. Ich zeige dir in einer kurzen Tour die wichtigsten " +
          "Bereiche — das dauert keine zwei Minuten.\n\nDu kannst jederzeit unten eine " +
          "Frage stellen oder die Tour mit ✕ beenden.",
        placement: "center",
      },
      {
        anchor: "taskbar-clara",
        title: "Das ist Clara",
        content:
          "Der wichtigste Knopf in ClaraOS: Er öffnet das Startmenü. Dort findest du " +
          "alle Apps — und Clara, deine Assistentin, die dir bei allem hilft.",
      },
      {
        anchor: "startmenu-input",
        title: "Suchen — oder einfach fragen",
        content:
          "Hier tippst du los: Ein App-Name startet die App. Alles andere beantwortet " +
          "Clara dir direkt — zum Beispiel „Wie füge ich Fotos hinzu?“ oder " +
          "„Erstell mir eine Einkaufsliste“.",
      },
      {
        anchor: "startmenu-pinned",
        title: "Deine Apps",
        content:
          "Die wichtigsten Apps auf einen Blick. Ein Klick öffnet sie im eigenen " +
          "Fenster — wie auf einem richtigen Computer.",
      },
      {
        anchor: "taskbar-pinned",
        title: "Schnellzugriff in der Leiste",
        content:
          "Deine Lieblings-Apps sind auch unten in der Leiste angepinnt. " +
          "Offene Apps erkennst du am kleinen Punkt.",
      },
      {
        anchor: "taskbar-tray",
        title: "Benachrichtigungen & Einstellungen",
        content:
          "Rechts findest du die Glocke für Benachrichtigungen, das Zahnrad für " +
          "Schnelleinstellungen (z. B. Lautstärke, Nicht stören) und die Uhr mit Kalender.",
      },
      {
        anchor: "taskbar-voice",
        title: "Mit Clara sprechen",
        content:
          "Keine Lust zu tippen? Mit dem Mikrofon-Knopf sprichst du direkt mit Clara.",
      },
      {
        anchor: "center",
        title: "Das war's! 🎉",
        content:
          "Du kennst jetzt die Grundlagen. Probier einfach Dinge aus — kaputt machen " +
          "kannst du nichts. Und wenn du nicht weiterweißt: Frag Clara, dafür ist sie da.",
        placement: "center",
      },
    ],
  },
};

TOURS["files-basics"] = {
  id: "files-basics",
  name: "Files kennenlernen",
  steps: [
    {
      anchor: "center",
      title: "Deine Dateien 📁",
      content:
        "Ich zeige dir kurz die Files-App — hier wohnen deine Dokumente, Fotos " +
        "und Downloads. Ich öffne sie gleich für dich.",
      placement: "center",
    },
    {
      anchor: "files-sidebar",
      title: "Deine Orte",
      content:
        "Links wählst du, wo du bist: deine eigenen Dateien, die Familien-Ablage " +
        "oder andere Quellen. Ein Klick wechselt den Ort.",
    },
    {
      anchor: "files-content",
      title: "Ordner & Dateien",
      content:
        "Hier siehst du den Inhalt. Doppelklick öffnet, Rechtsklick zeigt alle " +
        "Möglichkeiten (teilen, umbenennen, löschen). Zum Hochladen ziehst du " +
        "Dateien einfach hier hinein.",
    },
    {
      anchor: "files-search",
      title: "Suchen statt klicken",
      content:
        "Tippen filtert den aktuellen Ordner, Enter durchsucht auch alle " +
        "Unterordner — praktisch, wenn du nicht mehr weißt, wo etwas liegt.",
    },
    {
      anchor: "files-new-folder",
      title: "Ordnung halten",
      content: "Mit diesem Knopf legst du einen neuen Ordner an.",
    },
    {
      anchor: "center",
      title: "Das war Files! ✅",
      content:
        "Übrigens: Du kannst mich auch einfach bitten, Dateien zu finden oder " +
        "aufzuräumen — sag z. B. „Clara, find meine Steuerunterlagen“.",
      placement: "center",
    },
  ],
};

TOURS["fotos-basics"] = {
  id: "fotos-basics",
  name: "Fotos kennenlernen",
  steps: [
    {
      anchor: "center",
      title: "Eure Fotos 📸",
      content:
        "Ich zeige dir die Fotos-App — hier liegen alle Familienfotos, sicher " +
        "bei euch zuhause. Ich öffne sie gleich.",
      placement: "center",
    },
    {
      anchor: "immich-frame",
      title: "Die Fotos-App",
      content:
        "Das ist eure Foto-Zentrale: alle Bilder in einer Zeitleiste, " +
        "automatisch nach Personen und Orten sortiert. Vom Handy aus sichern " +
        "sich Fotos von selbst hierher.",
    },
    {
      anchor: "immich-photos",
      title: "Die Zeitleiste",
      content:
        "Unter „Fotos“ siehst du alle Aufnahmen chronologisch — einfach " +
        "scrollen, wie in der Galerie am Handy.",
    },
    {
      anchor: "immich-albums",
      title: "Alben",
      content:
        "Unter „Alben“ sammelst du Bilder zu Anlässen — Urlaub, Geburtstage, " +
        "was du magst.",
    },
    {
      anchor: "center",
      title: "Mein Tipp 💡",
      content:
        "Du musst Alben nicht selbst zusammensuchen: Sag mir einfach " +
        "„Erstell ein Album mit den Fotos vom letzten Wochenende“ — ich " +
        "übernehme das und zeige dir das Ergebnis.",
      placement: "center",
    },
  ],
};

TOURS["geraete-setup"] = {
  id: "geraete-setup",
  name: "Clara für unterwegs einrichten",
  steps: [
    {
      anchor: "center",
      title: "Clara überall dabei 📱",
      content:
        "Bis jetzt erreichst du ClaraOS nur hier im Browser. Ich zeige dir, " +
        "wie du es auf dein Handy bekommst — dann erreichen dich meine " +
        "Nachrichten auch unterwegs.",
      placement: "center",
    },
    {
      anchor: "settings-push",
      title: "Alles für dein Handy",
      content:
        "Hier ist deine persönliche Einrichtungs-Ecke: Scanne den QR-Code mit " +
        "der Handy-Kamera und folge den Schritten — ClaraOS landet als App auf " +
        "deinem Startbildschirm, und Benachrichtigungen sind gleich mit dabei.",
    },
    {
      anchor: "center",
      title: "Und am Computer? 💻",
      content:
        "Für PC und Laptop gibt es die ClaraOS-Companion-App — frag mich " +
        "einfach danach, wenn du sie möchtest.\n\nSobald dein Handy " +
        "eingerichtet ist, sag kurz Bescheid — dann teste ich, ob meine " +
        "Nachrichten ankommen.",
      placement: "center",
    },
  ],
};

/** Validates all anchors of a tour against the manifest (throws on unknown ID). */
export function resolveTour(tourId: string): TourDef {
  const tour = TOURS[tourId];
  if (!tour) throw new Error(`Unbekannte Tour: ${tourId}`);
  for (const step of tour.steps) {
    if (!TOUR_ANCHORS[step.anchor]) {
      throw new Error(`Tour ${tourId}: unbekannter Anker ${step.anchor}`);
    }
  }
  return tour;
}
