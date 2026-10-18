/** Visions — the big picture: vision cards with their assigned ideas and
 * progress by stage distribution. Assignment = links rel=part_of_vision
 * (idea → vision). The MVP is deliberately a grouping; a graph can come later. */
import { useEffect, useState } from "react";
import styles from "../IdeasApp.module.css";
import { Icon } from "../../../components/Icon";
import { ideasApi } from "../api";
import type { KbObject, KbObjectSlim } from "../types";
import { STAGE_BY_KEY } from "../stages";

interface Props {
  objects: KbObjectSlim[];
  currentUser: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

export function VisionsView({ objects, currentUser, onOpen, onChanged }: Props) {
  const visions = objects.filter((o) => o.type === "vision");
  const [details, setDetails] = useState<Record<string, KbObject>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  // Linked ideas are only in the detail payload (links) — there are few
  // visions, so loading them in parallel is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await Promise.all(
        visions.map((v) => ideasApi.getObject(v.id).catch(() => null)),
      );
      if (!cancelled) {
        setDetails(Object.fromEntries(loaded.filter(Boolean).map((d) => [d!.id, d!])));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visions.map((v) => `${v.id}:${v.updated_at}`).join(",")]);

  const create = async () => {
    if (!title.trim()) return;
    await ideasApi.createObject({ type: "vision", title: title.trim(), body: desc.trim() });
    setTitle("");
    setDesc("");
    setShowCreate(false);
    onChanged();
  };

  return (
    <div className={styles.visions}>
      <div className={styles.visionsHead}>
        <h3><Icon name="vision" size={16} className={styles.inlineIcon} />Visionen</h3>
        <button className={styles.btnPrimary} onClick={() => setShowCreate(true)}>＋ Vision</button>
      </div>

      {visions.length === 0 && !showCreate && (
        <div className={styles.empty}>
          Noch keine Vision. Eine Vision bündelt Ideen zu einem großen Ziel —
          verknüpfe Ideen im Detail über „Teil der Vision".
        </div>
      )}

      <div className={styles.visionGrid}>
        {visions.map((v) => {
          const det = details[v.id];
          const ideaLinks = (det?.links ?? []).filter(
            (l) => l.rel === "part_of_vision" && l.other_type === "idea",
          );
          const stages = ideaLinks.map((l) => {
            const o = objects.find((x) => x.id === l.other_id);
            return o?.stage ?? "spark";
          });
          return (
            <div key={v.id} className={styles.visionCard}>
              <button className={styles.visionTitle} onClick={() => onOpen(v.id)}>
                🌅 {v.title}
              </button>
              {v.body_preview && <p className={styles.cardPreview}>{v.body_preview}</p>}
              {stages.length > 0 && (
                <div className={styles.visionBar} title={`${stages.length} Ideen`}>
                  {["planned", "elaborated", "developing", "spark"].map((s) => {
                    const n = stages.filter((x) => (x ?? "spark") === s).length;
                    return n > 0 ? (
                      <span key={s} style={{
                        flex: n,
                        background: STAGE_BY_KEY[s]?.color,
                      }} title={`${STAGE_BY_KEY[s]?.label}: ${n}`} />
                    ) : null;
                  })}
                </div>
              )}
              <ul className={styles.visionIdeas}>
                {ideaLinks.map((l) => (
                  <li key={l.id}>
                    <button className={styles.linkChip} onClick={() => onOpen(l.other_id)}>
                      💡 {l.other_title}
                    </button>
                  </li>
                ))}
                {ideaLinks.length === 0 && (
                  <li className={styles.metaHint}>Noch keine Ideen zugeordnet.</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>

      {showCreate && (
        <div className={styles.modalBackdrop} onClick={() => setShowCreate(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3><Icon name="vision" size={16} className={styles.inlineIcon} />Neue Vision</h3>
              <button className={styles.iconBtn} onClick={() => setShowCreate(false)}><Icon name="close" size={14} title="Schließen" /></button>
            </div>
            <input className={styles.input} placeholder="Wohin soll die Reise gehen?"
                   value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
                   onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
            <textarea className={styles.input} rows={3} placeholder="Beschreibung (optional)"
                      value={desc} onChange={(e) => setDesc(e.target.value)} />
            <div className={styles.modalFoot}>
              <button className={styles.btnPrimary} disabled={!title.trim()} onClick={() => void create()}>
                Anlegen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
