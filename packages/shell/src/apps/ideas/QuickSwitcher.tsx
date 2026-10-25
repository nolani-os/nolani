/** Quick switcher (Ctrl/Cmd+K) for the knowledge suite.
 *
 * Two-stage, following Outline's pattern: whatever is already loaded is
 * filtered locally IMMEDIATELY (no network, no flicker); in parallel a
 * debounced server search runs and its results are merged in. The list feels
 * native but also finds things that were never loaded.
 *
 * Scope: KRunner remains the shell's system-wide search; this is in-app
 * navigation. */
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./IdeasApp.module.css";
import { ideasApi } from "./api";
import type { KbCollection, KbObjectSlim } from "./types";
import { useTranslation } from "@claraos/core";

interface Props {
  /** Objects already loaded: basis for the instant matches */
  local: KbObjectSlim[];
  collections: KbCollection[];
  onOpenObject: (id: string) => void;
  onOpenCollection: (id: string) => void;
  onClose: () => void;
}

/** Simple substring scoring: title start > word start > contains */
function score(title: string, q: string): number {
  const t = title.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

export function QuickSwitcher({ local, collections, onOpenObject, onOpenCollection, onClose }: Props) {
  const { t } = useTranslation("wissen");
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<KbObjectSlim[]>([]);
  const [cursor, setCursor] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Debounced server search (supplements the local matches)
  useEffect(() => {
    clearTimeout(timer.current);
    const needle = q.trim();
    if (needle.length < 2) {
      setRemote([]);
      return;
    }
    timer.current = setTimeout(() => {
      ideasApi.search(needle).then(setRemote).catch(() => setRemote([]));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const colls = collections
      .filter((c) => !needle || score(c.name, needle) > 0)
      .map((c) => ({ kind: "collection" as const, id: c.id, title: c.name, icon: c.icon ?? "🗂️",
                     rank: needle ? score(c.name, needle) : 1 }));
    const seen = new Set<string>();
    const objs = [...local, ...remote]
      .filter((o) => {
        if (seen.has(o.id)) return false;
        seen.add(o.id);
        return !needle || score(o.title, needle) > 0;
      })
      .map((o) => ({ kind: "object" as const, id: o.id, title: o.title, icon: o.icon ?? "📄",
                     rank: needle ? score(o.title, needle) : 0 }));
    return [...colls, ...objs].sort((a, b) => b.rank - a.rank).slice(0, 20);
  }, [q, local, remote, collections]);

  useEffect(() => { setCursor(0); }, [q]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    if (r.kind === "collection") onOpenCollection(r.id);
    else onOpenObject(r.id);
    onClose();
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.modal} ${styles.switcher}`} onClick={(e) => e.stopPropagation()}>
        <input
          className={styles.input}
          autoFocus
          placeholder={t("switcher.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); choose(cursor); }
            if (e.key === "Escape") onClose();
          }}
        />
        <div className={styles.switcherList}>
          {results.map((r, i) => (
            <button key={`${r.kind}:${r.id}`}
                    className={`${styles.switcherRow} ${i === cursor ? styles.switcherRowActive : ""}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(i)}>
              <span>{r.icon}</span>
              <span className={styles.listTitle}>{r.title}</span>
              <span className={styles.listMeta}>{r.kind === "collection" ? t("switcher.collection") : t("switcher.object")}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className={styles.empty}>{t("switcher.nothing")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
