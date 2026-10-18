/**
 * ToolbarMenu — click dropdown for toolbar buttons (Radix DropdownMenu).
 *
 * Renders the same ContextMenuItem definitions as WindowContextMenu/
 * PopupMenu and uses their stylesheet — context menus and toolbar menus
 * thus look identical. `checked` renders a check mark (view/sort).
 */
import { type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ContextMenuItem } from "./WindowContextMenu";
import styles from "./WindowContextMenu.module.css";

export interface ToolbarMenuProps {
  /** Button content (text/icon). */
  trigger: ReactNode;
  items: ContextMenuItem[];
  /** CSS class for the trigger button (e.g. Files toolbar .toolBtn). */
  triggerClassName?: string;
  /** Tooltip. */
  title?: string;
}

function renderItem(item: ContextMenuItem): ReactNode {
  if (item.label === "---") {
    return <Dropdown.Separator key={item.id} className={styles.separator} />;
  }

  if (item.submenu && item.submenu.length > 0) {
    return (
      <Dropdown.Sub key={item.id}>
        <Dropdown.SubTrigger className={styles.item} disabled={item.disabled}>
          {item.icon && <span className={styles.icon}>{item.icon}</span>}
          <span className={styles.label}>{item.label}</span>
          <span className={styles.arrow}>›</span>
        </Dropdown.SubTrigger>
        <Dropdown.Portal>
          <Dropdown.SubContent className={styles.menu} data-shell-part="toolbar-menu">
            {item.submenu.map(renderItem)}
          </Dropdown.SubContent>
        </Dropdown.Portal>
      </Dropdown.Sub>
    );
  }

  return (
    <Dropdown.Item
      key={item.id}
      className={`${styles.item} ${item.variant === "destructive" ? styles.destructive : ""}`}
      disabled={item.disabled}
      onSelect={() => item.onSelect?.()}
    >
      {item.checked !== undefined && (
        <span className={styles.icon}>{item.checked ? "✓" : " "}</span>
      )}
      {item.icon && <span className={styles.icon}>{item.icon}</span>}
      <span className={styles.label}>{item.label}</span>
      {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
    </Dropdown.Item>
  );
}

export function ToolbarMenu({ trigger, items, triggerClassName, title }: ToolbarMenuProps) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button className={triggerClassName} title={title} type="button">{trigger}</button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={styles.menu} data-shell-part="toolbar-menu" align="end" sideOffset={4}>
          {items.map(renderItem)}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
