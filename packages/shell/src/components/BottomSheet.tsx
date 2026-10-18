/**
 * BottomSheet — generic mobile sheet (Google Files pattern).
 *
 * Important: a portal on document.body is mandatory: MobileShell renders app
 * surfaces with CSS transforms (recents carousel) — position:fixed INSIDE a
 * transformed element anchors to the element instead of the viewport.
 *
 * Animation via plain CSS keyframes (no framer-motion — it is not a shell
 * dependency). Swipe down on the handle or tap on the backdrop closes it;
 * max. 70dvh with inner scroll; safe-area inset at the bottom.
 */
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./BottomSheet.module.css";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  const dragStartY = useRef<number | null>(null);

  if (!open) return null;

  return createPortal(
    <div className={styles.layer}>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        <div
          className={styles.handleArea}
          onPointerDown={(e) => {
            dragStartY.current = e.clientY;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragStartY.current !== null && e.clientY - dragStartY.current > 80) {
              dragStartY.current = null;
              onClose();
            }
          }}
          onPointerUp={() => { dragStartY.current = null; }}
        >
          <div className={styles.handle} />
          {title && <div className={styles.title}>{title}</div>}
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
