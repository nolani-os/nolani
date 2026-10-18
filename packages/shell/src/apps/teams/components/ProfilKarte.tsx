import { useEffect, useState } from "react";
import { useMatrixStore } from "@claraos/core";
import { profilLaden, talkOeffnen, TALK_ANZEIGEN, type Profil, type Weg } from "../personenApi";
import { startCall, startDM } from "../matrixClient";
import { Avatar } from "./Avatar";
import styles from "./ProfilKarte.module.css";

/**
 * A person's profile: who they are, whether they are present, and how to reach
 * them.
 *
 * Each channel honestly shows what it can do. A channel ClaraOS can actually
 * write through looks different from one that only leads outside — otherwise
 * you click "Signal" and wonder why nothing happens. The classification comes
 * from the server (`klasse`), not from this file.
 *
 * **Each channel carries its own action.** No picker behind a "Chat" button:
 * you see at a glance which messengers really work and choose directly. A
 * dropdown would hide the choice and make unequal options look equal. Where
 * ClaraOS cannot write, there is no button — a button that does nothing makes
 * a false promise.
 */

type Vorgang = { weg: string; art: "chat" | "anruf" } | null;

function WegZeile({
  weg,
  person,
  laeuft,
  onChat,
  onAnruf,
}: {
  weg: Weg;
  person: string;
  laeuft: Vorgang;
  onChat: (w: Weg) => void;
  onAnruf: (w: Weg) => void;
}) {
  const nutzbar = weg.chat_moeglich || weg.anruf_moeglich;
  const beschaeftigt = laeuft?.weg === weg.dienst;

  return (
    <li className={`${styles.weg} ${nutzbar ? styles.wegAktiv : styles.wegPassiv}`}>
      <span className={styles.wegName}>{weg.name}</span>
      {!nutzbar && (
        <span className={styles.marke} data-art="passiv" title={weg.hinweis}>
          {weg.klasse === "bridge" ? "Brücke aus" : "nur Verweis"}
        </span>
      )}
      <span className={styles.wegHandle}>{weg.handle}</span>

      {nutzbar && (
        <span className={styles.aktionen}>
          {weg.chat_moeglich && (
            <button
              className={styles.aktion}
              onClick={() => onChat(weg)}
              disabled={beschaeftigt}
              title={`Chat über ${weg.name} mit ${person}`}
            >
              {beschaeftigt && laeuft?.art === "chat" ? "…" : "Chat"}
            </button>
          )}
          {weg.anruf_moeglich && (
            <button
              className={styles.aktion}
              onClick={() => onAnruf(weg)}
              disabled={beschaeftigt}
              title={`Anruf über ${weg.name} mit ${person}`}
            >
              {beschaeftigt && laeuft?.art === "anruf" ? "…" : "Anruf"}
            </button>
          )}
        </span>
      )}
    </li>
  );
}

export function ProfilKarte({
  username,
  onSchliessen,
}: {
  username: string;
  onSchliessen: () => void;
}) {
  const [profil, setProfil] = useState<Profil | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<Vorgang>(null);
  const setActiveRoom = useMatrixStore((s) => s.setActiveRoom);
  const setRailView = useMatrixStore((s) => s.setRailView);

  useEffect(() => {
    let abgebrochen = false;
    setProfil(null);
    setFehler(null);
    profilLaden(username)
      .then((p) => !abgebrochen && setProfil(p))
      .catch(() => !abgebrochen && setFehler("Profil konnte nicht geladen werden."));
    return () => {
      abgebrochen = true;
    };
  }, [username]);

  async function starten(weg: Weg, art: "chat" | "anruf") {
    setFehler(null);
    setLaeuft({ weg: weg.dienst, art });
    try {
      if (weg.dienst === "matrix") {
        const raum = await startDM(weg.handle);
        if (!raum) throw new Error("Matrix-Unterhaltung konnte nicht geöffnet werden.");
        setActiveRoom(raum);
        setRailView("teams");
        if (art === "anruf") await startCall(raum);
        onSchliessen();
      } else if (weg.dienst === "nctalk") {
        const g = await talkOeffnen(username);
        // Talk lives outside the shell — deliberately a separate window rather
        // than pretending it runs in here.
        window.open(art === "anruf" ? g.anruf_url : g.url, "_blank", "noopener");
      }
    } catch (e) {
      setFehler(e instanceof Error ? e.message : "Der Versuch ist fehlgeschlagen.");
    } finally {
      setLaeuft(null);
    }
  }

  const sichtbareWege = (profil?.wege ?? []).filter(
    (w) => TALK_ANZEIGEN || w.dienst !== "nctalk",
  );

  return (
    <aside className={styles.karte} aria-label={`Profil von ${username}`}>
      <button className={styles.schliessen} onClick={onSchliessen} aria-label="Profil schließen">
        ✕
      </button>

      {fehler && <p className={styles.fehler}>{fehler}</p>}
      {!profil && !fehler && <p className={styles.laedt}>Lädt…</p>}

      {profil && (
        <>
          <div className={styles.kopf}>
            <Avatar name={profil.name} size={64} praesenzUser={profil.username} />
            <div>
              <h2 className={styles.name}>{profil.name}</h2>
              <p className={styles.mail}>{profil.email}</p>
            </div>
          </div>

          {profil.teams.length > 0 && (
            <section className={styles.block}>
              <h3 className={styles.blockTitel}>Gemeinsame Teams</h3>
              <ul className={styles.teams}>
                {profil.teams.map((t) => (
                  <li key={t} className={styles.team}>
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={styles.block}>
            <h3 className={styles.blockTitel}>Erreichbar über</h3>
            {/* Channels that lead out of ClaraOS (currently only Nextcloud
                Talk — it opens a new browser tab) are hidden. The server still
                delivers them; the decision lives here in the UI, see
                TALK_ANZEIGEN. */}
            {sichtbareWege.length === 0 ? (
              <p className={styles.leer}>Kein bekannter Weg.</p>
            ) : (
              <ul className={styles.wege}>
                {sichtbareWege.map((w) => (
                  <WegZeile
                    key={`${w.dienst}:${w.handle}`}
                    weg={w}
                    person={profil.name}
                    laeuft={laeuft}
                    onChat={(x) => void starten(x, "chat")}
                    onAnruf={(x) => void starten(x, "anruf")}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
