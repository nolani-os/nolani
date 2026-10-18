import { useEffect, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import { getMatrixClient } from "../matrixClient";
import { personenSuchen, type Person } from "../personenApi";
import { Avatar } from "./Avatar";
import { ProfilKarte } from "./ProfilKarte";
import styles from "./SearchView.module.css";

interface SearchResult {
  roomId: string;
  roomName: string;
  sender: string;
  body: string;
  ts: number;
}

export function SearchView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // People load while typing; message search waits for Enter.
  // Deliberately treated differently: the people list is small and comes from
  // ClaraOS, while Matrix full-text search spans all rooms and is expensive.
  const [personen, setPersonen] = useState<Person[]>([]);
  const [offenesProfil, setOffenesProfil] = useState<string | null>(null);
  const rooms = useMatrixStore((s) => s.rooms);
  const setActiveRoom = useMatrixStore((s) => s.setActiveRoom);
  const setRailView = useMatrixStore((s) => s.setRailView);

  const handleSearch = async () => {
    if (!query.trim()) return;
    const client = getMatrixClient();
    if (!client) return;

    setLoading(true);
    try {
      const resp = await client.searchMessageText({ searchTerm: query.trim() });
      const hits = resp?.search_categories?.room_events?.results ?? [];
      setResults(
        hits.map((hit: any) => ({
          roomId: hit.result?.room_id ?? "",
          roomName: rooms[hit.result?.room_id]?.name ?? hit.result?.room_id ?? "",
          sender: hit.result?.sender ?? "",
          body: hit.result?.content?.body ?? "",
          ts: hit.result?.origin_server_ts ?? 0,
        })).slice(0, 50)
      );
    } catch (err) {
      console.error("[Search]", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let abgebrochen = false;
    const t = setTimeout(() => {
      personenSuchen(query)
        .then((p) => !abgebrochen && setPersonen(p))
        .catch(() => !abgebrochen && setPersonen([]));
    }, 200);
    return () => {
      abgebrochen = true;
      clearTimeout(t);
    };
  }, [query]);

  const handleClick = (roomId: string) => {
    setActiveRoom(roomId);
    setRailView("teams");
  };

  return (
    <div className={styles.searchView}>
      <div className={styles.header}>
        <input
          autoFocus
          className={styles.searchInput}
          placeholder="Personen und Nachrichten suchen…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button className={styles.searchBtn} onClick={handleSearch} disabled={loading}>
          {loading ? "..." : "Search"}
        </button>
      </div>
      <div className={styles.body}>
      <div className={styles.results}>
        {personen.length > 0 && (
          <>
            <h3 className={styles.abschnitt}>Personen</h3>
            {personen.map((p) => (
              <button
                key={p.username}
                className={styles.person}
                onClick={() => setOffenesProfil(p.username)}
              >
                <Avatar name={p.name} size={32} praesenzUser={p.username} />
                <span className={styles.personText}>
                  <span className={styles.personName}>{p.name}</span>
                  <span className={styles.personTeams}>{p.teams.join(" · ")}</span>
                </span>
              </button>
            ))}
          </>
        )}
        {results.length > 0 && <h3 className={styles.abschnitt}>Nachrichten</h3>}
        {results.length === 0 && personen.length === 0 && !loading && query && (
          <div className={styles.empty}>Nichts gefunden für „{query}"</div>
        )}
        {results.map((r, i) => (
          <button key={i} className={styles.result} onClick={() => handleClick(r.roomId)}>
            <div className={styles.resultTop}>
              <span className={styles.resultRoom}>#{r.roomName}</span>
              <span className={styles.resultSender}>{r.sender}</span>
              <span className={styles.resultTime}>
                {new Date(r.ts).toLocaleDateString("de-DE")}
              </span>
            </div>
            <div className={styles.resultBody}>{r.body}</div>
          </button>
        ))}
      </div>
      {offenesProfil && (
        <ProfilKarte username={offenesProfil} onSchliessen={() => setOffenesProfil(null)} />
      )}
      </div>
    </div>
  );
}
