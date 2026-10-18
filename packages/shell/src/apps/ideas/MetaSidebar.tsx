/** Right sidebar in the detail view: maturity, properties, visibility, links.
 * Write access only for the owner (the backend enforces this anyway).
 *
 * No boxes: **four framed cards** with ALL-CAPS headings stacked on 260 px
 * give seven vertical edges and a sidebar that looks like a control panel
 * rather than page properties. Instead: rows with an icon, groups separated
 * only by a hairline, headings in normal case.
 *
 * No native `<select>` for linking: an `<option>` list of all objects is
 * already unusable at 50 entries, and its height looks different on every
 * system. Instead: search field + result list (like the @-mention in the
 * editor) and a row of pills for the relation type.
 *
 * "Move to trash" and "Shopping research" live in the header's ⋯ menu, not
 * as equal-ranked buttons here, so delete is not one misclick away from a
 * secondary function.
 */
import { useMemo, useState } from "react";
import styles from "./IdeasApp.module.css";
import leiste from "../wissen/Wissen.module.css";
import { Icon } from "../../components/Icon";
import { PopupMenu } from "../../components/PopupMenu";
import type { KbObject, KbObjectSlim, KbPropDef, Stage, Visibility } from "./types";
import { STAGES, STAGE_BY_KEY } from "./stages";
import { PropertyFields } from "./PropertyFields";
import { formatZeitpunkt } from "./format";

const REL_LABEL: Record<string, string> = {
  relates_to: "verwandt",
  part_of_vision: "Teil der Vision",
  inspired_by: "inspiriert von",
  duplicates: "Duplikat",
};

const ART_SYMBOL: Record<string, string> = { vision: "🌅", idea: "💡" };

interface Props {
  object: KbObject;
  isOwner: boolean;
  /** Content (maturity, properties) may also be changed by a collection member
   *  with write access; access/links remain with the owner. */
  canEdit?: boolean;
  /** Property schema of the object type (empty → no properties section) */
  propSchema?: KbPropDef[];
  onSaveProp?: (key: string, value: unknown) => void;
  /** Candidates for links (already loaded object list) */
  linkCandidates: KbObjectSlim[];
  onSetStage: (stage: Stage) => void;
  onSetVisibility: (v: Visibility) => void;
  onAddShare?: (username: string) => void;
  onRemoveShare?: (username: string) => void;
  onLink: (toId: string, rel: string) => void;
  onUnlink: (linkId: string) => void;
  onOpenObject: (id: string) => void;
  /** In the sheet (phone) or side peek the sidebar fills the full width. */
  breit?: boolean;
}

export function MetaSidebar({
  object, isOwner, canEdit, propSchema = [], onSaveProp, linkCandidates,
  onSetStage, onSetVisibility, onAddShare, onRemoveShare,
  onLink, onUnlink, onOpenObject, breit,
}: Props) {
  const [linkRel, setLinkRel] = useState("relates_to");
  const [suche, setSuche] = useState("");
  const [sucheOffen, setSucheOffen] = useState(false);
  const [shareName, setShareName] = useState("");
  const [teilenOffen, setTeilenOffen] = useState(false);
  const [sichtMenue, setSichtMenue] = useState<{ x: number; y: number } | null>(null);
  const schreib = canEdit ?? isOwner;

  const candidates = useMemo(
    () => linkCandidates.filter(
      (c) => c.id !== object.id && !object.links.some((l) => l.other_id === c.id)),
    [linkCandidates, object],
  );
  const treffer = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return (q ? candidates.filter((c) => c.title.toLowerCase().includes(q)) : candidates)
      .slice(0, 6);
  }, [candidates, suche]);

  const isIdea = object.type === "idea";
  const sicht = object.visibility;
  const sichtText = sicht === "family" ? "Familie"
    : sicht === "shared" ? `${object.shares?.length ?? 0} Person(en)` : "Privat";

  return (
    <aside className={`${leiste.leiste} ${breit ? leiste.leisteBreit : ""}`}>
      {isIdea && (
        <div className={leiste.leisteGruppe}>
          <h4 className={leiste.leisteTitel}>Reifegrad</h4>
          <div className={styles.stageStepper}>
            {STAGES.map((s) => (
              <button
                key={s.key}
                className={`${styles.stageStep} ${(object.stage ?? "spark") === s.key ? styles.stageStepActive : ""}`}
                style={(object.stage ?? "spark") === s.key ? { background: s.color } : undefined}
                disabled={!schreib}
                title={s.label}
                onClick={() => onSetStage(s.key)}
              >
                <Icon name={s.iconName} size={14} /> <span className={styles.stageStepLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {propSchema.length > 0 && onSaveProp && (
        <div className={leiste.leisteGruppe}>
          <h4 className={leiste.leisteTitel}>Eigenschaften</h4>
          <div className={leiste.leisteFeld}>
            <PropertyFields schema={propSchema} properties={object.properties ?? {}}
                            readOnly={!schreib} onSaveProp={onSaveProp} />
          </div>
        </div>
      )}

      <div className={leiste.leisteGruppe}>
        <h4 className={leiste.leisteTitel}>Zugriff</h4>
        <button className={leiste.leisteZeile} disabled={!isOwner}
                title={isOwner ? "Sichtbarkeit ändern" : undefined}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSichtMenue(sichtMenue ? null : { x: r.left, y: r.bottom + 4 });
                }}>
          <span className={leiste.leisteSymbol}>
            <Icon name={sicht === "private" ? "blind" : sicht === "family" ? "people" : "link"} size={14} />
          </span>
          <span className={leiste.leisteName}>Sichtbar für</span>
          <span className={leiste.leisteWert}>{sichtText}</span>
        </button>
        {sichtMenue && isOwner && (
          <PopupMenu
            x={sichtMenue.x} y={sichtMenue.y}
            onClose={() => setSichtMenue(null)}
            items={[
              { id: "privat", label: "Nur ich", icon: <Icon name="blind" size={14} />,
                checked: sicht === "private", onSelect: () => onSetVisibility("private") },
              { id: "familie", label: "Familie", icon: <Icon name="people" size={14} />,
                checked: sicht === "family", onSelect: () => onSetVisibility("family") },
            ]}
          />
        )}
        {sicht === "family" && (
          <p className={leiste.leisteText}>Die Familie kann lesen und kommentieren.</p>
        )}

        {(object.shares ?? []).map((u) => (
          <div key={u} className={leiste.leisteZeile} style={{ cursor: "default" }}>
            <span className={leiste.leisteSymbol}><Icon name="person" size={14} /></span>
            <span className={leiste.leisteName}>{u}</span>
            {isOwner && (
              <button className={leiste.leisteWeg} title="Freigabe entfernen"
                      onClick={() => onRemoveShare?.(u)}>×</button>
            )}
          </div>
        ))}
        {isOwner && onAddShare && (
          teilenOffen ? (
            <div className={leiste.leisteFeld}>
              <input className={styles.input} autoFocus placeholder="Benutzername… (Enter)"
                     value={shareName}
                     onChange={(e) => setShareName(e.target.value)}
                     onKeyDown={(e) => {
                       const n = shareName.trim();
                       if (e.key === "Enter" && n) { onAddShare(n); setShareName(""); setTeilenOffen(false); }
                       if (e.key === "Escape") setTeilenOffen(false);
                     }} />
              <p className={leiste.leisteText}>Sie können lesen und kommentieren.</p>
            </div>
          ) : (
            <button className={leiste.leisteZeile} onClick={() => setTeilenOffen(true)}>
              <span className={leiste.leisteSymbol}><Icon name="plus" size={14} /></span>
              <span className={leiste.leisteName}>Einzelne Person einladen</span>
            </button>
          )
        )}
      </div>

      <div className={leiste.leisteGruppe}>
        <h4 className={leiste.leisteTitel}>Verknüpfungen</h4>
        {object.links.length === 0 && !sucheOffen && (
          <p className={leiste.leisteText}>Noch keine.</p>
        )}
        {object.links.map((l) => (
          <div key={l.id} className={leiste.leisteZeile} style={{ cursor: "default" }}>
            <span className={leiste.leisteSymbol}>{ART_SYMBOL[l.other_type] ?? "📝"}</span>
            <button className={leiste.leisteName}
                    style={{ border: "none", background: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", padding: 0 }}
                    onClick={() => onOpenObject(l.other_id)}>{l.other_title}</button>
            <span className={leiste.leisteWert}>{REL_LABEL[l.rel] ?? "verwandt"}</span>
            {isOwner && (
              <button className={leiste.leisteWeg} title="Verknüpfung lösen"
                      onClick={() => onUnlink(l.id)}>×</button>
            )}
          </div>
        ))}
        {isOwner && (sucheOffen ? (
          <>
            <div className={leiste.leisteChips}>
              {Object.entries(REL_LABEL).map(([key, label]) => (
                <button key={key}
                        className={`${leiste.leisteChip} ${linkRel === key ? leiste.leisteChipAn : ""}`}
                        onClick={() => setLinkRel(key)}>{label}</button>
              ))}
            </div>
            <div className={leiste.leisteFeld}>
              <input className={styles.input} autoFocus placeholder="Eintrag suchen…"
                     value={suche}
                     onChange={(e) => setSuche(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Escape") { setSucheOffen(false); setSuche(""); } }} />
            </div>
            {treffer.map((c) => (
              <button key={c.id} className={leiste.leisteZeile}
                      onClick={() => { onLink(c.id, linkRel); setSuche(""); setSucheOffen(false); }}>
                <span className={leiste.leisteSymbol}>{ART_SYMBOL[c.type] ?? "📝"}</span>
                <span className={leiste.leisteName}>{c.title}</span>
              </button>
            ))}
            {treffer.length === 0 && (
              <p className={leiste.leisteText}>
                {candidates.length ? "Kein Treffer." : "Alles schon verknüpft."}
              </p>
            )}
          </>
        ) : (
          <button className={leiste.leisteZeile} disabled={!candidates.length}
                  onClick={() => setSucheOffen(true)}>
            <span className={leiste.leisteSymbol}><Icon name="link" size={14} /></span>
            <span className={leiste.leisteName}>Verknüpfen mit…</span>
          </button>
        ))}
      </div>

      {typeof object.properties?.planner_project_id === "number" && (
        <div className={leiste.leisteGruppe}>
          <button
            className={leiste.leisteZeile}
            onClick={() => {
              const pid = object.properties.planner_project_id as number;
              // Open the planner and navigate to the project once its
              // navigator is mounted (poll, same pattern as shell navigate_to)
              import("@claraos/core").then(({ useWindowsStore }) =>
                useWindowsStore.getState().openWindow("planner", { title: "Planner" }));
              import("../iframeNavigator").then(({ navigateIframe }) => {
                let tries = 0;
                const t = window.setInterval(() => {
                  if (navigateIframe("planner", `/project/${pid}/gantt`) || ++tries > 20) {
                    window.clearInterval(t);
                  }
                }, 250);
              });
            }}
          >
            <span className={leiste.leisteSymbol}><Icon name="plan" size={14} /></span>
            <span className={leiste.leisteName}>Im Planner öffnen</span>
          </button>
        </div>
      )}

      <div className={leiste.leisteGruppe}>
        <p className={leiste.leisteText}>
          {STAGE_BY_KEY[object.stage ?? ""] ? `${STAGE_BY_KEY[object.stage!].label} · ` : ""}
          von {object.owner}{object.created_by === "clara" ? " (via Clara 🤖)" : ""}<br />
          angelegt {formatZeitpunkt(object.created_at)}<br />
          geändert {formatZeitpunkt(object.updated_at)}
        </p>
      </div>
    </aside>
  );
}
