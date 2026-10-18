/** Clara's open follow-up questions on an object, with inline answer fields.
 * "Open" = questions that came after the last answer (simple heuristic).
 * Answers are stored as kind='answer' in the activity log (quoting the
 * question), so the thinking loop persists on the OBJECT and Clara sees them
 * on the next get_object. */
import { useMemo, useState } from "react";
import styles from "./IdeasApp.module.css";
import type { KbActivity } from "./types";

interface Props {
  activity: KbActivity[];
  onAnswer: (question: KbActivity, answer: string) => Promise<void>;
}

export function ClaraSection({ activity, onAnswer }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const openQuestions = useMemo(() => {
    const lastAnswerTs = activity
      .filter((a) => a.kind === "answer")
      .reduce((max, a) => (a.created_at > max ? a.created_at : max), "");
    return activity.filter(
      (a) => a.kind === "question" && a.actor === "clara" && a.created_at > lastAnswerTs,
    );
  }, [activity]);

  if (openQuestions.length === 0) return null;

  return (
    <section className={styles.claraSection}>
      <h4>🤖 Clara möchte wissen</h4>
      {openQuestions.map((q) => (
        <div key={q.id} className={styles.claraQuestion}>
          <p>{q.content}</p>
          <div className={styles.claraAnswerRow}>
            <input
              className={styles.input}
              placeholder="Deine Antwort… (Enter)"
              value={drafts[q.id] ?? ""}
              disabled={busy === q.id}
              onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
              onKeyDown={async (e) => {
                const text = (drafts[q.id] ?? "").trim();
                if (e.key !== "Enter" || !text) return;
                setBusy(q.id);
                try {
                  await onAnswer(q, text);
                  setDrafts((d) => ({ ...d, [q.id]: "" }));
                } finally {
                  setBusy(null);
                }
              }}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
