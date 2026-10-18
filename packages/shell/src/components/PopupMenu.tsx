/**
 * PopupMenu — imperative context menu at a fixed screen position.
 *
 * Radix' ContextMenu needs a declarative trigger wrapper; the GLOBAL
 * right-click fallback (GlobalContextMenu) gets its position from the
 * event instead. Reuses WindowContextMenu's item shape + stylesheet so
 * both menu kinds look identical. Submenus render as inline expandable
 * groups (one level).
 */
import { useEffect, useRef, useState } from "react";
import type { ContextMenuItem } from "./WindowContextMenu";
import styles from "./WindowContextMenu.module.css";

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function PopupMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [onClose]);

  // Keep the menu on-screen.
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y, items]);

  const renderItem = (item: ContextMenuItem, sub = false) => {
    if (item.label === "---") {
      return <div key={item.id} className={styles.separator} />;
    }
    if (item.submenu && item.submenu.length > 0) {
      const open = openSub === item.id;
      return (
        <div key={item.id}>
          <button
            type="button"
            className={styles.item}
            disabled={item.disabled}
            onClick={() => setOpenSub(open ? null : item.id)}
          >
            {item.icon && <span className={styles.icon}>{item.icon}</span>}
            <span className={styles.label}>{item.label}</span>
            <span className={styles.arrow}>{open ? "▾" : "›"}</span>
          </button>
          {open && (
            <div style={{ paddingLeft: 12 }}>{item.submenu.map((s) => renderItem(s, true))}</div>
          )}
        </div>
      );
    }
    return (
      <button
        key={item.id}
        type="button"
        className={`${styles.item} ${item.variant === "destructive" ? styles.destructive : ""}`}
        disabled={item.disabled}
        style={sub ? { fontSize: "0.95em" } : undefined}
        onClick={() => {
          // The confirmation lives in the ITEM and is triggered here. Otherwise
          // every caller would have to remember it — exactly how delete buttons
          // without confirmation come about.
          if (item.confirm && !window.confirm(item.confirm)) return;
          onClose();
          item.onSelect?.();
        }}
      >
        {item.icon && <span className={styles.icon}>{item.icon}</span>}
        <span className={styles.label}>{item.label}</span>
        {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      data-popup-menu
      data-shell-part="context-menu"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 10500 }}
    >
      {items.map((i) => renderItem(i))}
    </div>
  );
}
