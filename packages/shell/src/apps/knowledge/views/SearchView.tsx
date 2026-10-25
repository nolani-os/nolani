/** Full-text search of the Knowledge Suite — BFF GET /search (tsvector, german).
 * Ideas/visions are filtered out (they belong to the Idea Suite). */
import { useEffect, useRef, useState } from "react";
import styles from "../../ideas/IdeasApp.module.css";
import kStyles from "../Knowledge.module.css";
import { ideasApi } from "../../ideas/api";
import type { KbObjectSlim } from "../../ideas/types";
import { regionLocale, useTranslation } from "@claraos/core";

const PIPELINE_TYPES = new Set(["idea", "vision"]);

interface Props {
  onOpen: (id: string) => void;
}

export function SearchView({ onOpen }: Props) {
  const { t } = useTranslation("wissen");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<KbObjectSlim[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await ideasApi.search(query);
        setResults(r.filter((o) => !PIPELINE_TYPES.has(o.type)));
        setError(null);
        setSearched(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div className={styles.listView}>
      <div className={kStyles.searchBar}>
        <input
          className={styles.input}
          placeholder={t("search.placeholder")}
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
        <span className={kStyles.searchState}>{busy ? t("search.searching") : searched ? t("search.hits", { count: results.length }) : ""}</span>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.listRows}>
        {results.map((o) => (
          <button key={o.id} className={styles.listRow} onClick={() => onOpen(o.id)}>
            <span className={styles.listTitle}>{o.title}</span>
            <span className={styles.listMeta}>
              {o.type} · {new Date(o.updated_at).toLocaleDateString(regionLocale())}
            </span>
          </button>
        ))}
        {searched && !busy && results.length === 0 && (
          <div className={styles.empty}>{t("search.none", { q: q.trim() })}</div>
        )}
        {!searched && !busy && (
          <div className={styles.empty}>{t("search.minChars")}</div>
        )}
      </div>
    </div>
  );
}
