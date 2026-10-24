// Desktop widget: sticky note. Text + colour live in widget.config and
// persist through updateWidgetConfig (debounced — the workspace store
// writes through to the backend on every change). No backend of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore, useTranslation } from "@claraos/core";
import type { WidgetProps } from "./registry";
import s from "./StickyNote.module.css";

export const NOTE_COLORS = ["yellow", "blue", "green", "pink"] as const;
type NoteColor = (typeof NOTE_COLORS)[number];

const SAVE_DEBOUNCE_MS = 600;

export default function StickyNoteWidget({ widgetId, config }: WidgetProps) {
  const updateWidgetConfig = useWorkspaceStore((st) => st.updateWidgetConfig);
  const { t } = useTranslation("desktop");
  const color: NoteColor = NOTE_COLORS.includes(config?.color as NoteColor)
    ? (config?.color as NoteColor)
    : "yellow";

  const [text, setText] = useState(typeof config?.text === "string" ? config.text : "");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateWidgetConfig(widgetId, { text: value });
      }, SAVE_DEBOUNCE_MS);
    },
    [widgetId, updateWidgetConfig],
  );

  // Flush a pending save on unmount so no keystrokes are lost.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        updateWidgetConfig(widgetId, { text: textRef.current });
      }
    };
  }, [widgetId, updateWidgetConfig]);

  return (
    <div className={`${s.note} ${s[color]}`}>
      {/* schmale Greif-Leiste: einzige nicht-interaktive Fläche → Drag-Zone */}
      <div className={s.grabStrip} aria-hidden />
      <textarea
        className={s.text}
        data-no-drag
        data-native-menu
        value={text}
        placeholder={t("widgets.stickyNote.placeholder")}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className={s.colors} data-no-drag>
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            className={`${s.dot} ${s[`dot_${c}`]} ${c === color ? s.dotActive : ""}`}
            onClick={() => updateWidgetConfig(widgetId, { color: c })}
            aria-label={t("widgets.stickyNote.colorLabel", { color: t(`widgets.stickyNote.color.${c}`) })}
          />
        ))}
      </div>
    </div>
  );
}
