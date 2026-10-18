/**
 * FolderTree — chat-history sidebar.
 *
 * 2026 chat-app pattern (ChatGPT/Claude/Gemini): the PRIMARY nav is the
 * flat, date-grouped history of ALL chats (incl. folder chats — the
 * backend merges them via include_folders). Folders are a compact,
 * collapsed-by-default secondary section; empty folders are hidden.
 * Row actions live behind ONE hover "…" menu (rename / move / delete)
 * instead of always-visible micro-icons. Search filters live.
 *
 * Open WebUI gives us folders flat with parent_id pointers; we build a
 * tree client-side. Chats stay draggable onto folder headers.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WebUIChatSummary, WebUIFolder } from "./api";
import { chats as chatsApi } from "./api";
import { WindowContextMenu, type ContextMenuItem } from "../components/WindowContextMenu";
import styles from "./ClaraChatPanel.module.css";

interface Props {
  folders: WebUIFolder[];
  chats: WebUIChatSummary[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: (folderId?: string) => void;
  onCreateFolder?: (parentId?: string) => void;
  onDeleteChat?: (id: string) => void;
  onRenameChat?: (id: string, currentTitle: string) => void;
  onRenameFolder?: (id: string, currentName: string) => void;
  onDeleteFolder?: (id: string, name: string) => void;
  onRefresh?: () => void;
  /** Cleanup empty auto-folders (🤖 App Chats / ⚡ Quick Chats children). */
  onCleanupAutoFolders?: () => void;
}

interface TreeNode {
  folder: WebUIFolder;
  children: TreeNode[];
  chats: WebUIChatSummary[];
  /** chats in this folder + all descendants */
  totalChats: number;
}

// ── Date group helpers (German — the shell is a German-first OS) ──
type DateGroup = "Heute" | "Gestern" | "Diese Woche" | "Dieser Monat" | "Älter";

function getDateGroup(updatedAt: number | undefined): DateGroup {
  if (!updatedAt) return "Älter";
  const ts = updatedAt < 1e12 ? updatedAt * 1000 : updatedAt;
  const diff = Date.now() - ts;
  if (diff < 86_400_000) return "Heute";
  if (diff < 2 * 86_400_000) return "Gestern";
  if (diff < 7 * 86_400_000) return "Diese Woche";
  if (diff < 30 * 86_400_000) return "Dieser Monat";
  return "Älter";
}

const DATE_GROUP_ORDER: DateGroup[] = ["Heute", "Gestern", "Diese Woche", "Dieser Monat", "Älter"];

function groupByDate(chats: WebUIChatSummary[]): Map<DateGroup, WebUIChatSummary[]> {
  const map = new Map<DateGroup, WebUIChatSummary[]>();
  for (const c of chats) {
    const g = getDateGroup(c.updated_at);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(c);
  }
  return map;
}

// ── Tree builder ──
function buildTree(folders: WebUIFolder[], chats: WebUIChatSummary[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const f of folders) {
    map.set(f.id, { folder: f, children: [], chats: [], totalChats: 0 });
  }
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    const parentId = node.folder.parent_id;
    if (parentId && map.has(parentId)) {
      map.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const c of chats) {
    if (c.folder_id && map.has(c.folder_id)) {
      map.get(c.folder_id)!.chats.push(c);
    }
  }
  const finish = (n: TreeNode): number => {
    n.children.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    n.chats.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    n.totalChats = n.chats.length + n.children.reduce((s, c) => s + finish(c), 0);
    return n.totalChats;
  };
  roots.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
  roots.forEach(finish);
  return roots;
}

/** Hide empty folders — they are auto-folder debris, not navigation. */
function visibleNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .filter((n) => n.totalChats > 0)
    .map((n) => ({ ...n, children: visibleNodes(n.children) }));
}

// Module-level drag state (avoids context overhead)
let draggedChatId: string | null = null;

const FOLDERS_OPEN_KEY = "claraos-chat-folders-open";

// ── Row "…" menu ──
interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function RowMenu({
  items,
  moveTargets,
  onMove,
  title = "Aktionen",
}: {
  items: MenuItem[];
  /** When set, a "Verschieben" entry expands an inline folder list. */
  moveTargets?: { id: string | null; label: string }[];
  onMove?: (folderId: string | null) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setMoveOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={styles.rowMenuWrap} ref={ref}>
      <button
        type="button"
        className={`${styles.rowMenuBtn} ${open ? styles.rowMenuBtnOpen : ""}`}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
          setMoveOpen(false);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className={styles.rowMenu} role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className={`${styles.rowMenuItem} ${it.danger ? styles.rowMenuItemDanger : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
          {moveTargets && onMove && (
            <>
              <button
                type="button"
                className={styles.rowMenuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  setMoveOpen((o) => !o);
                }}
              >
                In Ordner verschieben {moveOpen ? "▾" : "▸"}
              </button>
              {moveOpen &&
                moveTargets.map((t) => (
                  <button
                    key={t.id ?? "__root__"}
                    type="button"
                    className={`${styles.rowMenuItem} ${styles.rowMenuItemSub}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      setMoveOpen(false);
                      onMove(t.id);
                    }}
                  >
                    {t.label}
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ──
export function FolderTree(props: Props) {
  const [query, setQuery] = useState("");
  const [foldersOpen, setFoldersOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FOLDERS_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  const roots = useMemo(() => buildTree(props.folders, props.chats), [props.folders, props.chats]);
  const shownRoots = useMemo(() => visibleNodes(roots), [roots]);
  const folderCount = useMemo(() => {
    const count = (ns: TreeNode[]): number => ns.reduce((s, n) => s + 1 + count(n.children), 0);
    return count(shownRoots);
  }, [shownRoots]);

  // History = ALL chats, flat, newest first (folder chats included).
  const allChats = useMemo(
    () => [...props.chats].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    [props.chats],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return allChats.filter((c) => (c.title || "").toLowerCase().includes(q));
  }, [allChats, query]);

  const dateGroups = useMemo(() => groupByDate(allChats), [allChats]);

  const moveTargets = useMemo(
    () => [
      { id: null, label: "· Ohne Ordner" },
      ...props.folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({ id: f.id as string | null, label: f.name })),
    ],
    [props.folders],
  );

  const toggleFolders = () => {
    setFoldersOpen((o) => {
      try {
        localStorage.setItem(FOLDERS_OPEN_KEY, o ? "0" : "1");
      } catch {
        /* non-fatal */
      }
      return !o;
    });
  };

  const moveChat = async (chatId: string, folderId: string | null) => {
    try {
      await chatsApi.moveToFolder(chatId, folderId);
      props.onRefresh?.();
    } catch (err) {
      console.error("moveToFolder failed", err);
    }
  };

  // Same actions for the hover "⋯" menu AND right-click.
  const chatCtxItems = (c: WebUIChatSummary): ContextMenuItem[] => [
    ...(props.onRenameChat
      ? [{ id: "rename", label: "Umbenennen", onSelect: () => props.onRenameChat!(c.id, c.title || "") }]
      : []),
    {
      id: "move",
      label: "In Ordner verschieben",
      submenu: moveTargets.map((t) => ({
        id: `mv-${t.id ?? "root"}`,
        label: t.label,
        onSelect: () => moveChat(c.id, t.id),
      })),
    },
    ...(props.onDeleteChat
      ? [
          { id: "sep", label: "---" },
          { id: "delete", label: "Löschen", variant: "destructive" as const, onSelect: () => props.onDeleteChat!(c.id) },
        ]
      : []),
  ];

  const chatRow = (c: WebUIChatSummary) => (
    // Wrapper div: Radix asChild needs a DOM element (ChatItem does not forward a ref).
    <WindowContextMenu key={c.id} items={chatCtxItems(c)}>
      <div>
      <ChatItem
        chat={c}
        active={c.id === props.activeChatId}
        onSelect={() => props.onSelectChat(c.id)}
        menu={
          <RowMenu
            items={[
              ...(props.onRenameChat
                ? [{ label: "Umbenennen", onClick: () => props.onRenameChat!(c.id, c.title || "") }]
                : []),
              ...(props.onDeleteChat
                ? [{ label: "Löschen", danger: true, onClick: () => props.onDeleteChat!(c.id) }]
                : []),
            ]}
            moveTargets={moveTargets}
            onMove={(fid) => moveChat(c.id, fid)}
          />
        }
      />
      </div>
    </WindowContextMenu>
  );

  return (
    <div className={styles.folderTree}>
      <div className={styles.treeHeader}>
        <button type="button" className={styles.newChatBtn} onClick={() => props.onNewChat()}>
          ＋ Neuer Chat
        </button>
      </div>
      <div className={styles.treeSearch}>
        <input
          className={styles.treeSearchInput}
          placeholder="Chats durchsuchen …"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.treeBody}>
        {/* ── Search results (flat) ── */}
        {filtered ? (
          <>
            {filtered.map(chatRow)}
            {filtered.length === 0 && <div className={styles.treeEmpty}>Keine Treffer.</div>}
          </>
        ) : (
          <>
            {/* ── Folders — compact secondary section, collapsed by default ── */}
            {(folderCount > 0 || props.onCreateFolder) && (
              <div className={styles.foldersSection}>
                <div className={styles.foldersSectionHeader}>
                  <button type="button" className={styles.foldersToggle} onClick={toggleFolders}>
                    <span className={styles.folderChevron}>{foldersOpen ? "▾" : "▸"}</span>
                    <span>Ordner</span>
                    {folderCount > 0 && <span className={styles.folderCount}>{folderCount}</span>}
                  </button>
                  <RowMenu
                    title="Ordner-Aktionen"
                    items={[
                      ...(props.onCreateFolder
                        ? [{ label: "Neuer Ordner", onClick: () => props.onCreateFolder!() }]
                        : []),
                      ...(props.onCleanupAutoFolders
                        ? [{ label: "Leere Auto-Ordner aufräumen", onClick: props.onCleanupAutoFolders }]
                        : []),
                    ]}
                  />
                </div>
                {foldersOpen &&
                  shownRoots.map((node) => (
                    <FolderNode
                      key={node.folder.id}
                      node={node}
                      depth={0}
                      activeChatId={props.activeChatId}
                      chatRow={chatRow}
                      onNewChat={props.onNewChat}
                      onCreateFolder={props.onCreateFolder}
                      onRenameFolder={props.onRenameFolder}
                      onDeleteFolder={props.onDeleteFolder}
                      onRefresh={props.onRefresh}
                    />
                  ))}
                {foldersOpen && shownRoots.length === 0 && (
                  <div className={styles.treeEmpty}>Keine Ordner mit Inhalt.</div>
                )}
              </div>
            )}

            {/* ── History — the primary navigation ── */}
            {DATE_GROUP_ORDER.map((group) => {
              const groupChats = dateGroups.get(group);
              if (!groupChats?.length) return null;
              return (
                <div key={group} className={styles.dateGroup}>
                  <div className={styles.dateGroupLabel}>{group}</div>
                  {groupChats.map(chatRow)}
                </div>
              );
            })}

            {allChats.length === 0 && <div className={styles.treeEmpty}>Noch keine Chats.</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ── Folder node ──
interface FolderNodeProps {
  node: TreeNode;
  depth: number;
  activeChatId: string | null;
  chatRow: (c: WebUIChatSummary) => React.ReactNode;
  onNewChat: (folderId?: string) => void;
  onCreateFolder?: (parentId?: string) => void;
  onRenameFolder?: (id: string, currentName: string) => void;
  onDeleteFolder?: (id: string, name: string) => void;
  onRefresh?: () => void;
}

function FolderNode({
  node,
  depth,
  activeChatId,
  chatRow,
  onNewChat,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRefresh,
}: FolderNodeProps) {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!draggedChatId) return;
    const id = draggedChatId;
    draggedChatId = null;
    try {
      await chatsApi.moveToFolder(id, node.folder.id);
      onRefresh?.();
    } catch (err) {
      console.error("moveToFolder failed", err);
    }
  };

  const folderCtxItems: ContextMenuItem[] = [
    { id: "new-chat", label: "Neuer Chat hier", onSelect: () => onNewChat(node.folder.id) },
    ...(onCreateFolder
      ? [{ id: "new-sub", label: "Neuer Unterordner", onSelect: () => onCreateFolder(node.folder.id) }]
      : []),
    ...(onRenameFolder
      ? [{ id: "rename", label: "Umbenennen", onSelect: () => onRenameFolder(node.folder.id, node.folder.name) }]
      : []),
    ...(onDeleteFolder
      ? [
          { id: "sep", label: "---" },
          { id: "delete", label: "Löschen", variant: "destructive" as const, onSelect: () => onDeleteFolder(node.folder.id, node.folder.name) },
        ]
      : []),
  ];

  return (
    <div className={styles.folderNode} style={{ paddingLeft: depth * 10 }}>
      <WindowContextMenu items={folderCtxItems}>
      <div
        className={`${styles.folderHeader} ${dragOver ? styles.folderHeaderDragOver : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.folderChevron}>{open ? "▾" : "▸"}</span>
        <span className={styles.folderName}>{node.folder.name}</span>
        <span className={styles.folderCount}>{node.totalChats}</span>
        <RowMenu
          title="Ordner-Aktionen"
          items={[
            { label: "Neuer Chat hier", onClick: () => onNewChat(node.folder.id) },
            ...(onCreateFolder
              ? [{ label: "Neuer Unterordner", onClick: () => onCreateFolder(node.folder.id) }]
              : []),
            ...(onRenameFolder
              ? [{ label: "Umbenennen", onClick: () => onRenameFolder(node.folder.id, node.folder.name) }]
              : []),
            ...(onDeleteFolder
              ? [{ label: "Löschen", danger: true, onClick: () => onDeleteFolder(node.folder.id, node.folder.name) }]
              : []),
          ]}
        />
      </div>
      </WindowContextMenu>
      {open && (
        <div className={styles.folderChildren}>
          {node.chats.map((c) => chatRow(c))}
          {node.children.map((child) => (
            <FolderNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              activeChatId={activeChatId}
              chatRow={chatRow}
              onNewChat={onNewChat}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Chat item (draggable) ──
function ChatItem({
  chat,
  active,
  onSelect,
  menu,
}: {
  chat: WebUIChatSummary;
  active: boolean;
  onSelect: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      className={`${styles.chatItem} ${active ? styles.chatItemActive : ""}`}
      draggable
      onDragStart={(e) => {
        draggedChatId = chat.id;
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        draggedChatId = null;
      }}
    >
      <button type="button" className={styles.chatItemBtn} onClick={onSelect}>
        <span className={styles.chatItemTitle}>{chat.title || "(ohne Titel)"}</span>
      </button>
      {menu}
    </div>
  );
}
