/** Web clipper: save a web page to the knowledge base.
 * The fetch happens SERVER-SIDE (services/kb_clip.py); the browser only sends
 * the URL. The server rejects internal addresses; its message is shown here
 * unchanged instead of being swallowed. */
import { i18n, useTranslation } from "@claraos/core";
import { useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";

interface Props {
  onClipped: (objectId: string) => void;
  onClose: () => void;
}

export function ClipModal({ onClipped, onClose }: Props) {
  const { t } = useTranslation("wissen");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookmarklet, setBookmarklet] = useState<string>("");

  useEffect(() => {
    ideasApi.getBookmarklet().then((b) => setBookmarklet(b.bookmarklet)).catch(() => undefined);
    // Offer the clipboard: usually the copied URL is exactly what is wanted
    navigator.clipboard?.readText?.()
      .then((t) => { if (/^https?:\/\/\S+$/i.test(t.trim())) setUrl(t.trim()); })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ideasApi.clipPage({ url: url.trim(), note: note.trim() });
      if (res.warning) {
        // Object was created but the page could not be fetched; say so honestly
        setError(i18n.t("wissen:clip.savedBut", { warning: res.warning }));
        setTimeout(() => onClipped(res.object.id), 1800);
      } else {
        onClipped(res.object.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h3><Icon name="globe" size={16} className={styles.inlineIcon} />{t("clip.title")}</h3>
          <button className={styles.iconBtn} onClick={onClose} title={t("app.close")}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>

        <input
          className={styles.input}
          autoFocus
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
        <textarea
          className={styles.input}
          rows={2}
          placeholder={t("clip.why")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}

        <p className={styles.metaHint}>
          {t("clip.hint")}
        </p>

        {bookmarklet && (
          <p className={styles.metaHint}>
            {t("clip.onTheGo")}{" "}
            <a href={bookmarklet}
               className={styles.propLink}
               onClick={(e) => e.preventDefault()}
               draggable
               title={t("clip.bookmarkTitle")}><Icon name="attachment" size={14} className={styles.inlineIcon} />{t("clip.bookmark")}
            </a>{" "}
            {t("clip.dragHint")}
          </p>
        )}

        <div className={styles.modalFoot}>
          <button className={styles.btnPrimary} disabled={!url.trim() || busy}
                  onClick={() => void submit()}>
            {busy ? t("clip.fetching") : t("clip.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
