/** Sammlung anlegen — Name/Icon/Typ/Sichtbarkeit, optional inline einen
 * NEUEN Typ mit Property-Schema definieren (Schema-Editor). */
import { useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { KbPropDef, KbType, Visibility } from "./types";

const KINDS: { v: KbPropDef["kind"]; label: string }[] = [
  { v: "text", label: "Text" }, { v: "number", label: "Zahl" },
  { v: "date", label: "Datum" }, { v: "select", label: "Auswahl" },
  { v: "multi_select", label: "Mehrfach-Auswahl" }, { v: "url", label: "Link" },
  { v: "checkbox", label: "Checkbox" },
];

interface Props {
  types: KbType[];
  onDone: () => void;
  onClose: () => void;
}

export function CollectionModal({ types, onDone, onClose }: Props) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🗂️");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [typeId, setTypeId] = useState("note");
  const [newType, setNewType] = useState(false);
  const [ntId, setNtId] = useState("");
  const [ntName, setNtName] = useState("");
  const [ntIcon, setNtIcon] = useState("📄");
  const [props, setProps] = useState<KbPropDef[]>([{ key: "", label: "", kind: "text" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let dt = typeId;
      if (newType) {
        const clean = props
          .map((p) => ({ ...p, key: p.key.trim() || p.label.trim().toLowerCase().replace(/\s+/g, "_") }))
          .filter((p) => p.label.trim());
        const t = await ideasApi.createType({
          id: ntId.trim().toLowerCase() || ntName.trim().toLowerCase().replace(/\s+/g, "-"),
          name: ntName.trim(), icon: ntIcon, prop_schema: clean,
        });
        dt = t.id;
      }
      await ideasApi.createCollection({
        name: name.trim(), icon, visibility, default_type: dt,
      });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="collections" size={16} className={styles.inlineIcon} />Neue Sammlung</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title="Schließen" /></button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.formRow}>
          <input className={styles.input} style={{ width: 64 }} value={icon} maxLength={4}
                 onChange={(e) => setIcon(e.target.value)} title="Icon (Emoji)" />
          <input className={styles.input} style={{ flex: 1 }} placeholder="Name der Sammlung" autoFocus
                 value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label className={styles.propLabel}>Einträge sind</label>
          <select className={styles.input} value={newType ? "__new__" : typeId}
                  onChange={(e) => {
                    if (e.target.value === "__new__") setNewType(true);
                    else { setNewType(false); setTypeId(e.target.value); }
                  }}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.icon ?? ""} {t.name}</option>
            ))}
            <option value="__new__">＋ Neuer Typ…</option>
          </select>
          <div className={styles.segmented} style={{ flex: 1 }}>
            <button className={visibility === "private" ? styles.segActive : ""}
                    onClick={() => setVisibility("private")}>🔒 Privat</button>
            <button className={visibility === "family" ? styles.segActive : ""}
                    onClick={() => setVisibility("family")}>👪 Familie</button>
          </div>
        </div>

        {newType && (
          <div className={styles.typeEditor}>
            <div className={styles.formRow}>
              <input className={styles.input} style={{ width: 64 }} value={ntIcon} maxLength={4}
                     onChange={(e) => setNtIcon(e.target.value)} title="Typ-Icon" />
              <input className={styles.input} style={{ flex: 1 }} placeholder="Typ-Name (z.B. Rezept)"
                     value={ntName} onChange={(e) => setNtName(e.target.value)} />
              <input className={styles.input} style={{ width: 130 }} placeholder="Kürzel (automatisch)"
                     value={ntId} onChange={(e) => setNtId(e.target.value)} />
            </div>
            <div className={styles.propLabel}>Eigenschaften</div>
            {props.map((p, i) => (
              <div key={i} className={styles.formRow}>
                <input className={styles.input} style={{ flex: 1 }} placeholder="Label (z.B. Dauer)"
                       value={p.label}
                       onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <select className={styles.input} value={p.kind}
                        onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, kind: e.target.value as KbPropDef["kind"] } : x)))}>
                  {KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
                </select>
                {(p.kind === "select" || p.kind === "multi_select") && (
                  <input className={styles.input} style={{ flex: 1 }} placeholder="Optionen, kommagetrennt"
                         value={(p.options ?? []).join(", ")}
                         onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i
                           ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)))} />
                )}
                <button className={styles.linkRemove}
                        onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className={styles.btnSecondary}
                    onClick={() => setProps((ps) => [...ps, { key: "", label: "", kind: "text" }])}>
              ＋ Eigenschaft
            </button>
          </div>
        )}

        <div className={styles.modalFoot}>
          <button className={styles.btnPrimary}
                  disabled={!name.trim() || busy || (newType && !ntName.trim())}
                  onClick={() => void create()}>
            {busy ? "…" : "Anlegen"}
          </button>
        </div>
      </div>
    </div>
  );
}
