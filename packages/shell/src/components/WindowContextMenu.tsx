import { type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import styles from "./WindowContextMenu.module.css";

export interface ContextMenuItem {
  /** Unique within a menu — used as React key. */
  id: string;
  /** Display label. Use `"---"` to render a separator instead. */
  label: string;
  /** Action invoked on selection. Omit for separators or disabled headers. */
  onSelect?: () => void;
  /** Optional shortcut hint shown right-aligned. */
  shortcut?: string;
  /** Optional icon: character, emoji — or a drawn icon.
   *  Typed as ReactNode, not just `string`: otherwise an app wanting to show
   *  `<Icon name="trash" />` would need its own menu — a second menu because of
   *  a type. The renderer always supported ReactNode. */
  icon?: ReactNode;
  /** When true, item appears greyed out and isn't clickable. */
  disabled?: boolean;
  /** Renders a sub-menu instead of an action. */
  submenu?: ContextMenuItem[];
  /** Visual emphasis — usually for destructive actions like Delete. */
  variant?: "default" | "destructive";
  /** Check mark (view/sort menus). undefined = no check slot. */
  checked?: boolean;
  /** Confirmation before triggering — the dialog text. Without it, no
   *  confirmation is asked. Belongs to the item, not the caller: otherwise the
   *  next call site forgets it (deleting must never be a misclick). */
  confirm?: string;
}

export interface WindowContextMenuProps {
  /** Element that triggers the context menu — usually a wrapper div. */
  children: ReactNode;
  /** Top-level items to render. */
  items: ContextMenuItem[];
}

function renderItem(item: ContextMenuItem): ReactNode {
  if (item.label === "---") {
    return <ContextMenu.Separator key={item.id} className={styles.separator} />;
  }

  if (item.submenu && item.submenu.length > 0) {
    return (
      <ContextMenu.Sub key={item.id}>
        <ContextMenu.SubTrigger className={styles.item} disabled={item.disabled}>
          {item.icon && <span className={styles.icon}>{item.icon}</span>}
          <span className={styles.label}>{item.label}</span>
          <span className={styles.arrow}>›</span>
        </ContextMenu.SubTrigger>
        <ContextMenu.Portal>
          <ContextMenu.SubContent className={styles.menu} data-shell-part="context-menu">
            {item.submenu.map(renderItem)}
          </ContextMenu.SubContent>
        </ContextMenu.Portal>
      </ContextMenu.Sub>
    );
  }

  return (
    <ContextMenu.Item
      key={item.id}
      className={`${styles.item} ${item.variant === "destructive" ? styles.destructive : ""}`}
      disabled={item.disabled}
      onSelect={() => {
        if (item.confirm && !window.confirm(item.confirm)) return;
        item.onSelect?.();
      }}
    >
      {item.icon && <span className={styles.icon}>{item.icon}</span>}
      <span className={styles.label}>{item.label}</span>
      {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
    </ContextMenu.Item>
  );
}

/**
 * Generic context-menu wrapper used across the shell:
  * - Window titlebar
  * - Pinned taskbar apps
  * - Desktop and desktop icons (replaces inline Radix)
 *
 * Items can be flat or nested via `submenu`. Separators are rendered with
 * `label === "---"`. The component intentionally has no opinions on
 * positioning — its parent's pointer-events region is the trigger.
 */
export function WindowContextMenu({ children, items }: WindowContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.menu} data-shell-part="context-menu">
          {items.map(renderItem)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
