/** Comment panel for an object.
 * Comments are attached to a QUOTE, not to a marker in the Markdown, so each
 * entry shows its anchor text and, if the text has since been rewritten, an
 * honest "context lost" badge. */
import { useCallback, useEffect, useState } from "react";
import styles from "./IdeasApp.module.css";
import { Icon } from "../../components/Icon";
import { ideasApi } from "./api";
import type { KbComment } from "./types";
import { regionLocale, getBrand, useTranslation } from "@claraos/core";

interface Props {
  objectId: string;
  currentUser: string;
  isOwner: boolean;
  /** Text currently selected in the editor (for "comment on selection") */
  selection: { text: string; prefix: string; suffix: string } | null;
  onClearSelection: () => void;
}

export function CommentsPanel({ objectId, currentUser, isOwner, selection, onClearSelection }: Props) {
  const { t } = useTranslation("wissen");
  const [comments, setComments] = useState<KbComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ideasApi.listComments(objectId, showResolved).then(setComments).catch(() => setComments([]));
  }, [objectId, showResolved]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await ideasApi.createComment(objectId, {
        body: text,
        parent_id: replyTo ?? undefined,
        anchor_text: replyTo ? "" : (selection?.text ?? ""),
        anchor_prefix: replyTo ? "" : (selection?.prefix ?? ""),
        anchor_suffix: replyTo ? "" : (selection?.suffix ?? ""),
      });
      setDraft("");
      setReplyTo(null);
      onClearSelection();
      load();
    } finally {
      setBusy(false);
    }
  };

  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);

  return (
    <section className={styles.comments}>
      <div className={styles.commentsHead}>
        <h4><Icon name="comment" size={16} className={styles.inlineIcon} />{t("comments.title")} {roots.length > 0 && <span className={styles.metaHint}>({roots.length})</span>}</h4>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={showResolved}
                 onChange={(e) => setShowResolved(e.target.checked)} />
          {t("comments.showResolved")}
        </label>
      </div>

      {selection && !replyTo && (
        <div className={styles.commentAnchorPreview}>
          <span className={styles.metaHint}>{t("comments.commentOn")}</span>
          <blockquote>„{selection.text.slice(0, 160)}“</blockquote>
          <button className={styles.linkRemove} title={t("comments.discardSelection")}
                  onClick={onClearSelection}><Icon name="close" size={14} title={t("app.close")} /></button>
        </div>
      )}

      <div className={styles.commentDraft}>
        <textarea
          className={styles.input}
          rows={2}
          placeholder={replyTo ? t("comments.reply") : selection ? t("comments.atSelection") : t("comments.onObject")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className={styles.commentDraftFoot}>
          {replyTo && (
            <button className={styles.btnSecondary} onClick={() => setReplyTo(null)}>
              {t("comments.cancelReply")}
            </button>
          )}
          <button className={styles.btnPrimary} disabled={!draft.trim() || busy}
                  onClick={() => void submit()}>
            {busy ? "…" : t("comments.send")}
          </button>
        </div>
      </div>

      <ul className={styles.commentList}>
        {roots.map((c) => (
          <li key={c.id} className={c.resolved ? styles.commentResolved : ""}>
            {c.anchor_text && (
              <div className={styles.commentAnchor}>
                <blockquote>„{c.anchor_text.slice(0, 120)}“</blockquote>
                {c.anchor_status === "orphan" && (
                  <span className={styles.anchorLost} title={t("comments.lostTitle")}>
                    {t("comments.lost")}
                  </span>
                )}
                {c.anchor_status === "fuzzy" && (
                  <span className={styles.anchorFuzzy} title={t("comments.fuzzyTitle")}>
                    {t("comments.fuzzy")}
                  </span>
                )}
              </div>
            )}
            <div className={styles.commentHead}>
              <b>{c.author === "clara" ? `🤖 ${getBrand().assistant}` : c.author}</b>
              <span className={styles.metaHint}>
                {new Date(c.created_at).toLocaleString(regionLocale(), { dateStyle: "short", timeStyle: "short" })}
              </span>
              {c.resolved && <span className={styles.metaHint}>{t("comments.resolved")}</span>}
            </div>
            <div className={styles.commentBody}>{c.body}</div>
            <div className={styles.commentActions}>
              <button className={styles.linkBtn} onClick={() => setReplyTo(c.id)}>{t("comments.replyAction")}</button>
              {(c.author === currentUser || isOwner) && (
                <button className={styles.linkBtn}
                        onClick={async () => {
                          await ideasApi.patchComment(c.id, { resolved: !c.resolved });
                          load();
                        }}>
                  {c.resolved ? t("comments.reopen") : t("comments.resolve")}
                </button>
              )}
              {(c.author === currentUser || isOwner) && (
                <button className={styles.linkBtn}
                        onClick={async () => { await ideasApi.deleteComment(c.id); load(); }}>
                  {t("comments.delete")}
                </button>
              )}
            </div>
            {repliesOf(c.id).length > 0 && (
              <ul className={styles.commentReplies}>
                {repliesOf(c.id).map((r) => (
                  <li key={r.id}>
                    <div className={styles.commentHead}>
                      <b>{r.author === "clara" ? `🤖 ${getBrand().assistant}` : r.author}</b>
                      <span className={styles.metaHint}>
                        {new Date(r.created_at).toLocaleString(regionLocale(), { dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </div>
                    <div className={styles.commentBody}>{r.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {roots.length === 0 && (
          <li className={styles.metaHint}>
            {t("comments.none")}
          </li>
        )}
      </ul>
    </section>
  );
}
