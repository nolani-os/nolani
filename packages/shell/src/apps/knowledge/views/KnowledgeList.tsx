/** Object list of the Knowledge Suite — filterable by type + full text.
 * Deliberately does NOT reuse ListView (apps/ideas): that one is stage-centric
 * (`stage ?? "spark"` would misclassify stage-less notes). */
import { useMemo, useState } from "react";
import styles from "../../ideas/IdeasApp.module.css";
import { Icon, iconFuerEmoji, type IconName } from "../../../components/Icon";
import type { KbObjectSlim, KbType } from "../../ideas/types";

interface Props {
  objects: KbObjectSlim[];
  types: KbType[];
  currentUser: string;
  /** true = type is fixed (e.g. notes tab) → no type select */
  fixedType?: boolean;
  onOpen: (id: string) => void;
}


/** as in KnowledgeApp: known emoji -> icon, unknown ones unchanged */
function ObjektSymbol({ icon, ersatz = "document", size = 14 }: {
  icon?: string | null; ersatz?: IconName; size?: number;
}) {
  const name = iconFuerEmoji(icon) ?? (icon ? null : ersatz);
  if (name) return <Icon name={name} size={size} className={styles.inlineIcon} />;
  return <span className={styles.inlineIcon}>{icon}</span>;
}

export function KnowledgeList({ objects, types, currentUser, fixedType = false, onOpen }: Props) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [mineOnly, setMineOnly] = useState(false);

  const typeById = useMemo(
    () => Object.fromEntries(types.map((t) => [t.id, t])),
    [types],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return objects.filter((o) => {
      if (!fixedType && typeFilter !== "all" && o.type !== typeFilter) return false;
      if (mineOnly && o.owner !== currentUser) return false;
      if (needle && !`${o.title} ${o.body_preview}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [objects, typeFilter, q, mineOnly, currentUser, fixedType]);

  return (
    <div className={styles.listView}>
      <div className={styles.listFilters}>
        <input
          className={styles.input}
          placeholder="Filtern…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {!fixedType && (
          <select
            className={styles.input}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">Alle Typen</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Nur meine
        </label>
      </div>
      <div className={styles.listRows}>
        {filtered.map((o) => {
          const t = typeById[o.type];
          return (
            <button key={o.id} className={styles.listRow} onClick={() => onOpen(o.id)}>
              {/* .stageBadge has no background of its own (ListView set it via
                  inline style) → neutral grey for type badges */}
              <span className={styles.stageBadge} style={{ background: "var(--text-secondary, #6b7280)" }}>
                <ObjektSymbol icon={t?.icon} size={13} />{t?.name ?? o.type}
              </span>
              <span className={styles.listTitle}>{o.title}</span>
              <span className={styles.listMeta}>
                {o.visibility === "family" && <Icon name="people" size={12} className={styles.inlineIcon} />}
                {o.owner !== currentUser ? `${o.owner} · ` : ""}
                {new Date(o.updated_at).toLocaleDateString("de-DE")}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className={styles.empty}>Nichts gefunden — leg mit „＋ Notiz" los.</div>
        )}
      </div>
    </div>
  );
}
