/**
 * Team view — a team's shared things in ONE place.
 *
 * Files, calendar, plan and user-created app tabs belong to the **team**, no
 * longer to each channel.
 *
 * Why this is more accurate than the old per-channel tab bar: the group
 * folder, the calendar and the board belong to the team. Previously **every**
 * channel showed the same team files — four channels, the same folder four
 * times. A channel now only holds its conversation.
 *
 * The tabs are stored as room account data on the team's **main room** (its
 * first channel), because a space itself keeps no account data for us.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useAppRegistryStore, useMatrixStore, getBrand } from "@claraos/core";
import { useTeamResource, teamOrdnerPfad } from "../teamResources";
import { KalenderView } from "./KalenderView";
import { DateienView } from "./DateienView";
import { Avatar } from "./Avatar";
import { getCustomTabs, addCustomTab, removeCustomTab, type CustomTab } from "../customTabs";
import { appComponents } from "../../registry";
import { EINBETTBARE_APPS, APP_TAB_PREFIX, istAppReiter, appIdAusReiter } from "../teamsAppTabs";
import { FolderIcon, CalendarIcon, KanbanIcon, LinkIcon, PlusIcon, XIcon, UsersIcon } from "./icons";
import styles from "./TeamView.module.css";

type ReiterDef = {
  id: string;
  label: string;
  icon: React.ReactNode;
  url?: string;
  eigen?: boolean;
};

export function TeamView({ spaceId, windowId }: { spaceId: string; windowId: string }) {
  const space = useMatrixStore((s) => s.spaces[spaceId]);
  const rooms = useMatrixStore((s) => s.rooms);

  // Holder of the tab settings: the team's first channel.
  const traegerRaum = useMemo(
    () => space?.childRoomIds.find((id) => rooms[id] && !rooms[id].isSpace) ?? null,
    [space, rooms],
  );
  const teamRes = useTeamResource(traegerRaum ?? spaceId);
  const teamOrdner = teamOrdnerPfad(teamRes?.files_url ?? null);

  const [aktiv, setAktiv] = useState<string>("");
  const [eigene, setEigene] = useState<CustomTab[]>([]);
  const [dialog, setDialog] = useState(false);
  const [art, setArt] = useState<"app" | "url">("app");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [appId, setAppId] = useState("");

  useEffect(() => {
    setEigene(traegerRaum ? getCustomTabs(traegerRaum) : []);
    setAktiv("");
  }, [traegerRaum]);

  const apps = useAppRegistryStore((st) => st.apps);
  const vergeben = useMemo(
    () => new Set(["planner", ...(eigene.map((t) => t.appId).filter(Boolean) as string[])]),
    [eigene],
  );
  const waehlbar = useMemo(
    () => EINBETTBARE_APPS
      .filter((id) => !vergeben.has(id))
      .map((id) => apps[id])
      .filter((a): a is NonNullable<typeof a> => !!a)
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
    [apps, vergeben],
  );
  useEffect(() => {
    if (waehlbar.length === 0) { setAppId(""); return; }
    if (!waehlbar.some((a) => a.id === appId)) setAppId(waehlbar[0].id);
  }, [waehlbar, appId]);

  const reiter: ReiterDef[] = [
    ...(teamOrdner ? [{ id: "files", label: "Dateien", icon: <FolderIcon size={15} /> }] : []),
    ...(teamRes?.calendar_url ? [{ id: "calendar", label: "Kalender", icon: <CalendarIcon size={15} /> }] : []),
    { id: `${APP_TAB_PREFIX}planner`, label: "Plan", icon: <KanbanIcon size={15} /> },
    ...eigene.map((t) => ({
      id: t.appId ? `${APP_TAB_PREFIX}${t.appId}` : `custom:${t.name}`,
      label: t.name,
      icon: <LinkIcon size={15} />,
      url: t.url,
      eigen: true,
    })),
  ];
  const offen = reiter.find((r) => r.id === aktiv) ?? reiter[0];

  const hinzufuegen = async () => {
    if (!traegerRaum) return;
    if (art === "app") {
      const a = waehlbar.find((x) => x.id === appId);
      if (!a || vergeben.has(a.id)) return;
      setEigene(await addCustomTab(traegerRaum, { name: name.trim() || a.name, appId: a.id }));
      setAktiv(`${APP_TAB_PREFIX}${a.id}`);
    } else {
      const n = name.trim();
      let u = url.trim();
      if (!n || !u) return;
      if (!/^https?:\/\//.test(u)) u = `https://${u}`;
      setEigene(await addCustomTab(traegerRaum, { name: n, url: u }));
      setAktiv(`custom:${n}`);
    }
    setDialog(false);
    setName("");
    setUrl("");
  };

  const entfernen = async (label: string) => {
    if (!traegerRaum) return;
    setEigene(await removeCustomTab(traegerRaum, label));
    setAktiv("");
  };

  if (!space) return <div className={styles.leer}>Team nicht gefunden.</div>;

  const kanaele = space.childRoomIds.map((id) => rooms[id]).filter((r) => r && !r.isSpace);

  return (
    <div className={styles.team}>
      <div className={styles.kopf}>
        <Avatar name={space.name} url={space.avatarUrl} size={36} />
        <div className={styles.titelblock}>
          <span className={styles.titel}>{space.name}</span>
          <span className={styles.unterzeile}>
            <UsersIcon size={12} />
            {kanaele.length} {kanaele.length === 1 ? "Kanal" : "Kanäle"}
          </span>
        </div>
      </div>

      <div className={styles.reiterLeiste}>
        {reiter.map((r) => (
          <span key={r.id} className={styles.reiterHuelle}>
            <button
              className={`${styles.reiter} ${offen?.id === r.id ? styles.reiterAktiv : ""}`}
              onClick={() => setAktiv(r.id)}
            >
              {r.icon}
              <span>{r.label}</span>
            </button>
            {r.eigen && offen?.id === r.id && (
              <button className={styles.reiterWeg} onClick={() => entfernen(r.label)} title="Reiter entfernen">
                <XIcon size={12} />
              </button>
            )}
          </span>
        ))}
        <button className={styles.plus} onClick={() => setDialog(true)} title="Reiter hinzufügen">
          <PlusIcon size={15} />
        </button>
      </div>

      <div className={styles.inhalt}>
        {!offen ? (
          <div className={styles.leer}>Für dieses Team ist noch nichts eingerichtet.</div>
        ) : offen.id === "files" && teamOrdner ? (
          <DateienView startPfad={teamOrdner} />
        ) : offen.id === "calendar" ? (
          <KalenderView />
        ) : istAppReiter(offen.id) ? (
          (() => {
            const Comp = appComponents[appIdAusReiter(offen.id)];
            if (!Comp) return <div className={styles.leer}>Diese App steht hier nicht zur Verfügung.</div>;
            return (
              <Suspense fallback={<div className={styles.leer}>Wird geladen …</div>}>
                <Comp windowId={windowId} />
              </Suspense>
            );
          })()
        ) : offen.url ? (
          <iframe
            src={offen.url}
            className={styles.rahmen}
            title={offen.label}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-write; clipboard-read"
          />
        ) : null}
      </div>

      {dialog && (
        <div className={styles.overlay} onClick={() => setDialog(false)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3>Reiter hinzufügen</h3>
            <div className={styles.artWahl}>
              <button
                type="button"
                className={art === "app" ? styles.artAktiv : styles.art}
                onClick={() => setArt("app")}
              >{getBrand().product}-App</button>
              <button
                type="button"
                className={art === "url" ? styles.artAktiv : styles.art}
                onClick={() => setArt("url")}
              >Web-Adresse</button>
            </div>
            {art === "app" ? (
              <>
                <select autoFocus value={appId} onChange={(e) => setAppId(e.target.value)}>
                  {waehlbar.length === 0 ? (
                    <option value="">Alle geeigneten Apps sind schon Reiter</option>
                  ) : (
                    waehlbar.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)
                  )}
                </select>
                <input
                  placeholder="Name im Reiter (leer = App-Name)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && hinzufuegen()}
                />
              </>
            ) : (
              <>
                <input autoFocus placeholder="Name (z. B. Doku)" value={name}
                       onChange={(e) => setName(e.target.value)} />
                <input placeholder="https://…" value={url}
                       onChange={(e) => setUrl(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && hinzufuegen()} />
              </>
            )}
            <div className={styles.dialogAktionen}>
              <button
                className={styles.ok}
                onClick={hinzufuegen}
                disabled={art === "app" ? !appId : !name.trim() || !url.trim()}
              >Hinzufügen</button>
              <button className={styles.abbruch} onClick={() => setDialog(false)}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
