// Desktop/mobile widget: quick idea capture.
// One-liner → POST /api/claraos/knowledge/objects (type=idea, stage=spark);
// Clara's automatic analysis (kb_analyst) then attaches follow-up questions. No
// state of its own in the widget — ideas live in the "Ideas" app (onOpenApp opens it).
import { useCallback, useRef, useState } from "react";
import type { WidgetProps } from "./registry";
import s from "./IdeaCapture.module.css";

export default function IdeaCaptureWidget({ guardRef, onOpenApp }: WidgetProps) {
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t || state === "busy") return;
    setState("busy");
    try {
      const r = await fetch("/api/claraos/knowledge/objects", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "idea", title: t, stage: "spark" }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setTitle("");
      setState("done");
      if (doneTimer.current) clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("error");
    }
  }, [title, state]);

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span>💡 Idee festhalten</span>
        {onOpenApp && (
          <button
            className={s.openBtn}
            title="Ideen-App öffnen"
            onClick={() => { if (!guardRef?.current) onOpenApp(); }}
          >↗</button>
        )}
      </div>
      <div className={s.row}>
        <input
          className={s.input}
          placeholder="Was geht dir durch den Kopf?"
          value={title}
          disabled={state === "busy"}
          onChange={(e) => { setTitle(e.target.value); if (state === "error") setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          onClick={(e) => e.stopPropagation()}
        />
        <button className={s.sendBtn} disabled={!title.trim() || state === "busy"}
                onClick={(e) => { e.stopPropagation(); void submit(); }}>
          {state === "busy" ? "…" : "＋"}
        </button>
      </div>
      {state === "done" && <div className={s.hint}>✓ Erfasst — Clara denkt mit.</div>}
      {state === "error" && <div className={s.hintErr}>Speichern fehlgeschlagen.</div>}
    </div>
  );
}
