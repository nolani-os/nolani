/**
 * Dialogs — in-panel replacement for window.confirm / prompt / alert.
 *
 * Native browser dialogs block the whole tab, look foreign and are not
 * skinnable. This host renders a small glass card as an overlay inside
 * the chat panel. Promise-based API via useDialogs():
 *
 *   const { dialogHost, confirmDlg, promptDlg, alertDlg } = useDialogs();
 *   if (await confirmDlg("Delete 3 folders?")) { … }
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@claraos/core";
import styles from "./Dialogs.module.css";

type DialogKind = "confirm" | "prompt" | "alert" | "choose";

/** One button of the choice dialog (chooseDlg). */
export interface DialogChoice {
  value: string;
  label: string;
  primary?: boolean;
}

/** Result of chooseDlg — null = cancel/Esc. */
export interface ChoiceResult {
  value: string;
  /** State of the optional checkbox (e.g. "apply to all"). */
  checked: boolean;
}

interface DialogState {
  kind: DialogKind;
  message: string;
  defaultValue?: string;
  confirmLabel?: string;
  choices?: DialogChoice[];
  checkboxLabel?: string;
  resolve: (value: string | boolean | ChoiceResult | null) => void;
}

export function useDialogs() {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const open = useCallback(
    (kind: DialogKind, message: string,
     opts?: { defaultValue?: string; confirmLabel?: string; choices?: DialogChoice[]; checkboxLabel?: string }) =>
      new Promise<string | boolean | ChoiceResult | null>((resolve) => {
        setDialog({ kind, message, ...opts, resolve });
      }),
    [],
  );

  const close = useCallback((value: string | boolean | ChoiceResult | null) => {
    setDialog((d) => {
      d?.resolve(value);
      return null;
    });
  }, []);

  const confirmDlg = useCallback(
    (message: string, confirmLabel?: string) => open("confirm", message, { confirmLabel }).then((v) => v === true),
    [open],
  );
  const promptDlg = useCallback(
    (message: string, defaultValue = "") =>
      open("prompt", message, { defaultValue }).then((v) => (typeof v === "string" ? v : null)),
    [open],
  );
  const alertDlg = useCallback(
    (message: string) => open("alert", message).then(() => undefined),
    [open],
  );

  /** Multiple answers instead of yes/no (e.g. a name conflict: "Replace ·
   *  Keep both · Skip"), optionally with a checkbox. */
  const chooseDlg = useCallback(
    (message: string, choices: DialogChoice[], checkboxLabel?: string) =>
      open("choose", message, { choices, checkboxLabel })
        .then((v) => (v && typeof v === "object" ? v : null)),
    [open],
  );

  const dialogHost = dialog ? <DialogCard dialog={dialog} onClose={close} /> : null;

  return { dialogHost, confirmDlg, promptDlg, alertDlg, chooseDlg };
}

function DialogCard({
  dialog,
  onClose,
}: {
  dialog: DialogState;
  onClose: (value: string | boolean | ChoiceResult | null) => void;
}) {
  const { t } = useTranslation("chat");
  const [value, setValue] = useState(dialog.defaultValue ?? "");
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const cancel = () => onClose(dialog.kind === "prompt" || dialog.kind === "choose" ? null : false);
  const ok = () => onClose(dialog.kind === "prompt" ? value : true);

  return (
    <div
      className={styles.overlay}
      onClick={cancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div
        className={`${styles.card} ${dialog.kind === "choose" ? styles.cardWide : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.message}>{dialog.message}</div>
        {dialog.kind === "prompt" && (
          <input
            ref={inputRef}
            className={styles.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ok();
              }
            }}
          />
        )}
        {dialog.kind === "choose" && dialog.checkboxLabel && (
          <label className={styles.check}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {dialog.checkboxLabel}
          </label>
        )}
        {dialog.kind === "choose" ? (
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={cancel}>
              {t("camera.cancel")}
            </button>
            {(dialog.choices ?? []).map((c) => (
              <button
                key={c.value}
                type="button"
                className={`${styles.btn} ${c.primary ? styles.btnPrimary : ""}`}
                autoFocus={c.primary}
                onClick={() => onClose({ value: c.value, checked })}
              >
                {c.label}
              </button>
            ))}
          </div>
        ) : (
        <div className={styles.actions}>
          {dialog.kind !== "alert" && (
            <button type="button" className={styles.btn} onClick={cancel}>
              {t("camera.cancel")}
            </button>
          )}
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={ok} autoFocus={dialog.kind !== "prompt"}>
            {dialog.confirmLabel ?? t("dialog.ok")}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
