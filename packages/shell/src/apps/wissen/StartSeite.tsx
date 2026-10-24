/** Start page of the Knowledge section.
 *
 * Why: a grid of collection cards shows the filing system, not the content.
 * "What is due?", "What was I working on last?", "What did I save?" — a start
 * page should answer these without clicking into a collection and searching.
 *
 * All three blocks hide themselves when they would be empty. On the first day
 * you therefore see only the collections — plus the offer to let Clara do it.
 * A start screen showing empty boxes is worse than none.
 *
 * Important: "due" is computed from the collections' date columns, not from
 * the Planner. The Planner remains the only task list; this is about
 * collection entries that carry a date (contract expires, recipe for
 * Saturday). Two different things that merely sound similar.
 */
import { getBrand } from "@claraos/core";
import { useEffect, useMemo, useState } from "react";
import styles from "./Wissen.module.css";
import geteilt from "../ideas/IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { ideasApi } from "../ideas/api";
import { FieldType } from "../ideas/types";
import type { KbCollection, KbField, KbObjectSlim } from "../ideas/types";
import { formatDatum } from "../ideas/format";
import { datumInWorten, tagesDiff } from "../../lib/datumsWorte";

/** How many days ahead counts as "due". A week is the horizon in which a
 *  household actually plans. */
const VORLAUF_TAGE = 7;
/** …and how far back. Without this limit, an entry that was 29 days overdue
 *  and long since done would show at the very top. What is a month old is no
 *  longer due but history.
 *  Deliberately NO checkbox evaluation: the field registry does not know which
 *  checkbox column means "done" — that would be guessing, and guessing hides
 *  entries someone wanted to see. The time limit hides nothing, it only
 *  classifies. */
const RUECKSCHAU_TAGE = 14;

interface Props {
  objekte: KbObjectSlim[];
  sammlungen: KbCollection[];
  favoriten: KbObjectSlim[];
  onOpen: (id: string) => void;
  onClara: () => void;
}

export function StartSeite({ objekte, sammlungen, favoriten, onOpen, onClara }: Props) {
  const [datumsFelder, setDatumsFelder] = useState<KbField[]>([]);

  // The date columns of all collections — once when the start page opens.
  useEffect(() => {
    if (!sammlungen.length) { setDatumsFelder([]); return; }
    let weg = false;
    void Promise.all(sammlungen.map((c) => ideasApi.listFields(c.id).catch(() => [] as KbField[])))
      .then((listen) => {
        if (weg) return;
        const gesehen = new Set<string>();
        const raus: KbField[] = [];
        for (const liste of listen) {
          for (const f of liste) {
            if (f.field_type !== FieldType.Date || gesehen.has(f.key)) continue;
            gesehen.add(f.key);
            raus.push(f);
          }
        }
        setDatumsFelder(raus);
      });
    return () => { weg = true; };
  }, [sammlungen]);

  const faellig = useMemo(() => {
    if (!datumsFelder.length) return [];
    const treffer: { obj: KbObjectSlim; feld: string; iso: string; tage: number }[] = [];
    for (const o of objekte) {
      for (const f of datumsFelder) {
        const wert = o.properties?.[f.key];
        if (typeof wert !== "string" || !wert) continue;
        const tage = tagesDiff(wert);
        if (tage === null || tage > VORLAUF_TAGE || tage < -RUECKSCHAU_TAGE) continue;
        treffer.push({ obj: o, feld: f.name, iso: wert, tage });
        break;   // one date per entry is enough
      }
    }
    return treffer.sort((a, b) => a.tage - b.tage).slice(0, 6);
  }, [objekte, datumsFelder]);

  const zuletzt = useMemo(
    () => [...objekte]
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 6),
    [objekte],
  );

  const eintrag = (o: KbObjectSlim, rechts?: React.ReactNode) => (
    <button key={o.id} className={styles.startZeile} onClick={() => onOpen(o.id)}>
      <span className={styles.startSymbol}>{o.icon || "📄"}</span>
      <span className={styles.startName}>{o.title}</span>
      {rechts}
    </button>
  );

  return (
    <div className={styles.start}>
      {/* Without a heading, the page on phones would start abruptly with
          "Recently edited" — no title, no location. On desktop the window
          bar carries the name; on phones there is none. A screen without a
          header feels like landing in the middle of something. */}
      {/* No icon: "Collections" below already has one, and the same symbol
          twice in a row says nothing new. */}
      <h3 className={styles.startKopf}>Wissen</h3>
      {faellig.length > 0 && (
        <section className={styles.startBlock}>
          <h4 className={styles.startTitel}>
            <Icon name="calendar" size={14} className={geteilt.inlineIcon} />Demnächst fällig
          </h4>
          {faellig.map((t) => eintrag(t.obj, (
            <Chip klein ton={t.tage < 0 ? 5 : t.tage === 0 ? 3 : undefined}
                  title={`${t.feld}: ${formatDatum(t.iso)}`}>
              {datumInWorten(t.iso)}
            </Chip>
          )))}
        </section>
      )}

      {favoriten.length > 0 && (
        <section className={styles.startBlock}>
          <h4 className={styles.startTitel}>
            <Icon name="star" size={14} className={geteilt.inlineIcon} />Gemerkt
          </h4>
          {favoriten.slice(0, 6).map((o) => eintrag(o))}
        </section>
      )}

      {zuletzt.length > 0 && (
        <section className={styles.startBlock}>
          <h4 className={styles.startTitel}>
            <Icon name="today" size={14} className={geteilt.inlineIcon} />Zuletzt bearbeitet
          </h4>
          {zuletzt.map((o) => eintrag(o))}
        </section>
      )}

      {/* Clara can create collections, columns and views — this is the
          visible path to it. The sentence deliberately gives a complete
          example: people who don't know what they may say, say nothing. */}
      <section className={styles.startClara}>
        <span className={styles.startClaraText}>
          Oder sag es einfach {getBrand().assistant} — <em>„Leg mir eine Sammlung für den Urlaub an,
          mit Ort, Datum und Kosten"</em>.
        </span>
        <Button stufe="tonal" icon="sparkle" onClick={onClara}>Mit {getBrand().assistant} anlegen</Button>
      </section>
    </div>
  );
}
