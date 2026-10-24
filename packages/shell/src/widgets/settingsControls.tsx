// Shared building blocks for widget settings overlays. Opening works the same
// everywhere: the frame context menu fires "claraos-widget-settings" with the
// widgetId (DesktopWidgets.tsx), and the widget listens via useWidgetSettingsOpen.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@claraos/core";
import s from "./WidgetSettings.module.css";

/** true as soon as the frame menu picks "Einstellungen…" (Settings) for this widget. */
export function useWidgetSettingsOpen(
  widgetId: string,
): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onSettings = (e: Event) => {
      if ((e as CustomEvent).detail?.widgetId === widgetId) setOpen(true);
    };
    window.addEventListener("claraos-widget-settings", onSettings);
    return () => window.removeEventListener("claraos-widget-settings", onSettings);
  }, [widgetId]);
  return [open, setOpen];
}

export function SettingsOverlay({
  title,
  onCancel,
  onSave,
  children,
}: {
  title: string;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("desktop");
  return (
    <div
      className={s.overlay}
      data-no-drag
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className={s.title}>{title}</div>
      <div className={s.body}>{children}</div>
      <div className={s.actions}>
        <button className={s.btn} onClick={onCancel}>
          {t("widgets.settings.cancel")}
        </button>
        <button className={`${s.btn} ${s.primary}`} onClick={onSave}>
          {t("widgets.settings.save")}
        </button>
      </div>
    </div>
  );
}

export function CheckRow({
  label,
  checked,
  onChange,
  disabled,
  swatch,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** optional colour dot (e.g. calendar colour) */
  swatch?: string;
}) {
  return (
    <label className={`${s.checkRow} ${disabled ? s.disabled : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {swatch && <span className={s.swatch} style={{ background: swatch }} />}
      <span className={s.checkLabel}>{label}</span>
    </label>
  );
}

export function SelectRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className={s.fieldRow}>
      <span className={s.fieldLabel}>{label}</span>
      <select
        className={s.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GroupLabel({ children }: { children: ReactNode }) {
  return <div className={s.groupLabel}>{children}</div>;
}

export function CheckList({ children }: { children: ReactNode }) {
  return <div className={s.checkList}>{children}</div>;
}
