/** Share a collection: who has access, with which permission — and add more
 * ClaraOS users.
 *
 * Two permissions, deliberately no more: **read** (view + comment) and
 * **edit** (change and create notes, columns/views). Deleting, visibility and
 * sharing stay with the owner — the server enforces that
 * (`_fetch_coll(owner_only=…)`); here it is simply not offered.
 *
 * User selection: `GET /api/claraos/teams/personen?q=` — the same visibility
 * boundary as everywhere (shared team/contacts), no free guessing of
 * usernames. */
import { useEffect, useMemo, useState } from "react";
import styles from "../ideas/IdeasApp.module.css";
import leiste from "./Wissen.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "../ideas/api";
import type { CollPermission, KbCollection, KbCollectionShare } from "../ideas/types";
import { useTranslation } from "@claraos/core";

interface Person { username: string; name?: string | null; email?: string | null }

interface Props {
  collection: KbCollection;
  currentUser: string;
  onClose: () => void;
  /** After every change — the collection list and the permissions reload. */
  onChanged: () => void;
}



export function SammlungTeilen({ collection, currentUser, onClose, onChanged }: Props) {
  const { t } = useTranslation("wissen");
  const isOwner = collection.owner === currentUser;
  const [shares, setShares] = useState<KbCollectionShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suche, setSuche] = useState("");
  const [personen, setPersonen] = useState<Person[]>([]);
  const [gewaehlt, setGewaehlt] = useState<string>("");
  const [recht, setRecht] = useState<CollPermission>("write");

  const laden = () => {
    ideasApi.listCollectionShares(collection.id)
      .then((r) => setShares(r.shares))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(laden, [collection.id]);

  // People suggestions (owner only) — briefly debounced so that not every
  // keystroke queries the server.
  useEffect(() => {
    if (!isOwner) return;
    const timer = window.setTimeout(() => {
      const p = new URLSearchParams();
      if (suche.trim()) p.set("q", suche.trim());
      fetch(`/api/claraos/teams/personen?${p}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : []))
        .then((liste: Person[]) => setPersonen(Array.isArray(liste) ? liste : []))
        .catch(() => setPersonen([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [suche, isOwner]);

  const vorhanden = useMemo(() => new Set([collection.owner, ...(shares ?? []).map((s) => s.username)]), [shares, collection.owner]);
  const kandidaten = useMemo(
    () => personen.filter((p) => p.username && !vorhanden.has(p.username)).slice(0, 8),
    [personen, vorhanden],
  );

  const mit = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); laden(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const hinzu = () => {
    const u = (gewaehlt || suche).trim().toLowerCase();
    if (!u) return;
    void mit(async () => {
      await ideasApi.addCollectionShare(collection.id, u, recht);
      setSuche(""); setGewaehlt("");
    });
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="people" size={16} className={styles.inlineIcon} />
            {isOwner ? t("share.title") : t("share.whoHasAccess")}</h3>
          <button className={styles.iconBtn} onClick={onClose}><Icon name="close" size={14} title={t("common.close")} /></button>
        </div>
        <p className={styles.metaHint} style={{ margin: "0 0 10px" }}>
          {collection.icon ?? "🗂️"} {collection.name}
          {collection.visibility === "family" ? t("share.familyVisible") : ""}
        </p>
        {error && <div className={styles.error}>{error}</div>}

        {/* Owner */}
        <div className={leiste.leisteZeile} style={{ cursor: "default" }}>
          <span className={leiste.leisteSymbol}><Icon name="person" size={14} /></span>
          <span className={leiste.leisteName}>{collection.owner}{collection.owner === currentUser ? t("share.me") : ""}</span>
          <span className={leiste.leisteWert}>{t("share.owner")}</span>
        </div>

        {/* Members */}
        {shares === null && !error && <p className={leiste.leisteText}>{t("common.loading")}</p>}
        {(shares ?? []).map((s) => (
          <div key={s.username} className={leiste.leisteZeile} style={{ cursor: "default" }}>
            <span className={leiste.leisteSymbol}><Icon name="person" size={14} /></span>
            <span className={leiste.leisteName}>{s.username}{s.username === currentUser ? t("share.me") : ""}</span>
            {isOwner ? (
              <select className={styles.input} style={{ width: "auto", padding: "2px 6px" }}
                      value={s.permission} disabled={busy}
                      title={t("share.changeRight")}
                      onChange={(e) => void mit(() =>
                        ideasApi.patchCollectionShare(collection.id, s.username, e.target.value as CollPermission))}>
                <option value="read">{t("share.read")}</option>
                <option value="write">{t("share.write")}</option>
              </select>
            ) : (
              <span className={leiste.leisteWert}>{t(`share.${s.permission}`)}</span>
            )}
            {(isOwner || s.username === currentUser) && (
              <button className={leiste.leisteWeg} disabled={busy}
                      title={s.username === currentUser ? t("share.leave") : t("share.remove")}
                      onClick={() => void mit(async () => {
                        await ideasApi.removeCollectionShare(collection.id, s.username);
                        if (s.username === currentUser) onClose();
                      })}>×</button>
            )}
          </div>
        ))}
        {shares !== null && shares.length === 0 && (
          <p className={leiste.leisteText}>{t("share.nobody")}</p>
        )}

        {/* Add people (owner only) */}
        {isOwner && (
          <div style={{ marginTop: 12 }}>
            <div className={styles.propLabel}>{t("share.addPerson")}</div>
            <div className={styles.formRow}>
              <input className={styles.input} style={{ flex: 1 }} autoFocus
                     placeholder={t("share.searchPlaceholder")}
                     value={suche}
                     onChange={(e) => { setSuche(e.target.value); setGewaehlt(""); }}
                     onKeyDown={(e) => { if (e.key === "Enter") hinzu(); if (e.key === "Escape") onClose(); }} />
              <div className={styles.segmented}>
                <button className={recht === "read" ? styles.segActive : ""}
                        title={t("share.readTitle")}
                        onClick={() => setRecht("read")}>{t("share.read")}</button>
                <button className={recht === "write" ? styles.segActive : ""}
                        title={t("share.writeTitle")}
                        onClick={() => setRecht("write")}>{t("share.write")}</button>
              </div>
              <button className={styles.btnPrimary} disabled={busy || !(gewaehlt || suche.trim())}
                      onClick={hinzu}>{t("share.share")}</button>
            </div>
            {kandidaten.length > 0 && (
              <div className={leiste.leisteChips} style={{ marginTop: 6 }}>
                {kandidaten.map((p) => (
                  <button key={p.username}
                          className={`${styles.btnSecondary} ${gewaehlt === p.username ? styles.segActive : ""}`}
                          style={{ padding: "3px 8px", fontSize: "0.8rem" }}
                          title={p.email ?? p.username}
                          onClick={() => { setGewaehlt(p.username); setSuche(p.name || p.username); }}>
                    {p.name || p.username}
                    {p.name && p.name !== p.username ? <span className={styles.metaHint}> {p.username}</span> : null}
                  </button>
                ))}
              </div>
            )}
            <p className={leiste.leisteText}>
              {t("share.explain")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
