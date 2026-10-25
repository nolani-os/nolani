/**
 * QuestionCard — AskUserQuestion UI.
 *
 * When Clara calls `ask_user_question`, the frontend shows a card with
 * the question + 2-4 buttons (options). Click → POST /question-response →
 * the backend stores the answer in Postgres, and clara-agent polls it via
 * HTTP. Buttons lock only after a confirmed POST; an error is shown and the
 * choice stays open.
 *
 * With `fields` the card is a compact form (text, choice, date, number).
 * Submitting sends the JSON object {name: value} as the answer over the same
 * endpoint; the option buttons stay below it as secondary actions.
 */
import { useTranslation } from "@claraos/core";
import { useState, type FormEvent } from "react";
import type { ClaraPendingQuestion, ClaraQuestionField } from "./api";
import { buildFormAnswer, FIELD_MAX_LEN, type FormValues } from "./questionForm";
import styles from "./PlanCard.module.css";
import form from "./QuestionCard.module.css";

interface QuestionCardProps {
  question: ClaraPendingQuestion;
}

/** true = answer arrived (200) or already answered (409). */
async function postQuestionResponse(qid: string, answer: string): Promise<boolean> {
  try {
    const resp = await fetch("/api/claraos/chat/v2/question-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ question_id: qid, answer }),
    });
    return resp.ok || resp.status === 409;
  } catch (err) {
    console.warn("[question-response] failed", err);
    return false;
  }
}

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ClaraQuestionField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = `qf-${field.name}`;
  if (field.type === "choice" && field.options) {
    return (
      <div className={form.chips} role="radiogroup" aria-labelledby={`${id}-label`}>
        {field.options.map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            className={`${form.chip} ${value === opt ? form.chipOn : ""}`}
            disabled={disabled}
            onClick={() => onChange(value === opt ? "" : opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    );
  }
  return (
    <input
      id={id}
      className={form.input}
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      placeholder={field.placeholder}
      maxLength={FIELD_MAX_LEN}
      value={value}
      required={field.required}
      aria-required={field.required || undefined}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function QuestionCard({ question }: QuestionCardProps) {
  const { t } = useTranslation("chat");
  const [answered, setAnswered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const fields = question.fields ?? [];
  const hasForm = fields.length > 0;
  const anyRequired = fields.some((f) => f.required);
  const locked = answered || submitting;

  const send = async (answer: string) => {
    if (locked) return;
    setSubmitting(true);
    setError(null);
    const ok = await postQuestionResponse(question.questionId, answer);
    setSubmitting(false);
    if (ok) {
      setAnswered(true);
    } else {
      setError(t("question.sendFailed"));
    }
  };

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    const { answer, missing } = buildFormAnswer(fields, values);
    if (missing.length) {
      setError(t("question.missing", { fields: missing.join(", ") }));
      return;
    }
    void send(answer);
  };

  return (
    <div className={styles.card} data-claraos-question-card>
      <div className={styles.header}>
        <span className={styles.title}>❓ {question.question}</span>
      </div>
      {hasForm && (
        <form className={form.form} onSubmit={submitForm} noValidate data-claraos-question-form>
          {fields.map((f) => (
            <div key={f.name} className={form.row}>
              <label id={`qf-${f.name}-label`} htmlFor={`qf-${f.name}`} className={form.label}>
                {f.label}
                {f.required && (
                  <span className={form.req} title={t("question.required")} aria-label={t("question.required")}>
                    *
                  </span>
                )}
              </label>
              <FieldInput
                field={f}
                value={values[f.name] ?? ""}
                disabled={locked}
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [f.name]: v }));
                  setError(null);
                }}
              />
            </div>
          ))}
          <div className={form.footer}>
            <span className={form.hint}>
              {answered
                ? t("question.received")
                : anyRequired
                  ? t("question.hintRequired")
                  : t("question.hint")}
            </span>
            <button
              type="submit"
              className={`${styles.btn} ${styles.btnPrimary} ${form.submit}`}
              disabled={locked}
            >
              {submitting ? t("question.sending") : answered ? t("question.sent") : t("question.submit")}
            </button>
          </div>
        </form>
      )}
      <div
        className={styles.actions}
        style={
          hasForm
            ? { marginTop: 8, gap: 6 }
            : { flexDirection: "column", alignItems: "stretch", gap: 6 }
        }
      >
        {question.options.map((opt, i) =>
          hasForm ? (
            // Secondary next to the form: the fallback answers of the agent.
            <button
              key={i}
              type="button"
              className={form.secondary}
              onClick={() => void send(opt.label)}
              disabled={locked}
              title={opt.description}
            >
              {opt.label}
            </button>
          ) : (
            <button
              key={i}
              className={`${styles.btn} ${i === 0 ? styles.btnPrimary : ""}`}
              onClick={() => void send(opt.label)}
              disabled={locked}
              style={{ textAlign: "left", padding: "8px 12px" }}
            >
              <div style={{ fontWeight: 500 }}>{opt.label}</div>
              {opt.description && (
                <div style={{ fontSize: 10.5, opacity: 0.7, marginTop: 2 }}>{opt.description}</div>
              )}
            </button>
          ),
        )}
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 11, color: "var(--danger, #e5534b)", marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}
