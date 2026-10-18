// === Window Types ===

export interface WindowInstance {
  id: string;
  appId: string;
  wrappId?: string;                 // If window belongs to a wrapp
  title: string;
  icon?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  focused: boolean;
  closing?: boolean;
  createdAt: number;
  lastFocusedAt?: number;
  preMaximize?: { x: number; y: number; width: number; height: number };
  snapped?: "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | null;
  workspaceId?: string;             // Which workspace this window belongs to
  alwaysOnTop?: boolean;            // Pin above other windows; rendered with elevated z-index
  path?: string;                    // File path the window opened (viewer apps consume this)
  source?: string;                  // File source ID ("nextcloud" / "sftp:<host>")
  currentObjectUri?: string;        // Canonical object-URI for inline-chat binding (see object-uri.ts)
  claraInlineOpen?: boolean;        // Whether the inline Clara chat panel is toggled open in this window
}

// === Drag & Drop ===

export type DraggedItem =
  | { type: "file"; source: string; path: string; name: string; isDir: boolean }
  | { type: "files"; source: string; paths: string[] }
  | { type: "app-icon"; appId: string }
  | { type: "window"; windowId: string }
  | { type: "url"; url: string; title?: string }
  | { type: "text"; text: string };

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

// === App Types ===

export type AppCategory =
  | "productivity" | "engineering" | "system" | "media" | "services"
  | "communication" | "finance" | "entertainment" | "developer"
  | "ai" | "monitoring" | "wrapps";
export type AppSource = "builtin" | "user" | "third-party";

export interface AppAccount {
  accountName: string;
  isActive: boolean;
}

export interface CredentialSlot {
  key: string;
  label: string;
  type: "url" | "text" | "password" | "file";
  required: boolean;
  value?: string;
}

export interface AppManifest {
  id: string;
  name: string;
  icon: string;
  description: string;
  type: "internal" | "iframe" | "service" | "mcp" | "remote-browser" | "selkies";
  category: AppCategory;
  source: AppSource;

  // Activation
  activated: boolean;
  showInStartMenu: boolean;
  pinned: boolean;                   // Shown in taskbar favorites

  // Third-party service in the services hub: hidden from start menu categories/
  // drawer/app center, but still in /apps (pins & mobile home resolve by id).
  hubService?: boolean;

  // Configuration
  config?: {
    url?: string;
    iconUrl?: string;               // runtime icon for DB-created hub services
    vaultItemId?: string;           // Vaultwarden item holding the service credentials
    credentials?: CredentialSlot[];
    sshConfig?: { host: string; user: string; keyPath?: string };
  };

  // Window
  window: {
    defaultWidth: number;
    defaultHeight: number;
    minWidth?: number;
    minHeight?: number;
    resizable?: boolean;
    maximizable?: boolean;
    lockAspectRatio?: boolean;
    /** Open filling the screen (e.g. the games desktop without a window border). */
    startMaximized?: boolean;
    /** True full screen on open: above the taskbar, without a title bar. */
    startFullscreen?: boolean;
  };

  // Permissions
  permissions: string[];
  requiredGroups?: string[];

  // Object handling
  handledObjectTypes?: string[];
  defaultForTypes?: string[];

  // Wrapp integration
  wrappCompatible?: boolean;
  providesEvents?: string[];
  consumesEvents?: string[];

  // Mobile behavior (opt-in, forward-compatible)
  mobileStrategy?: "iframe" | "redirect" | "deeplink" | "choice";
  deeplinkScheme?: string;
}

export interface AppProcess {
  pid: string;
  appId: string;
  windowId: string;
  wrappId?: string;
  startedAt: number;
}

// === Wrapp Types ===

export interface WrappAppSlot {
  appId: string;
  role: string;
  label: string;
  icon: string;
  availableFor?: string[];           // Only for certain object types
}

export interface EventDef {
  name: string;
  description: string;
  payload?: Record<string, string>;  // { key: "type description" }
}

export interface PropertyDef {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "date";
  unit?: string;
  options?: string[];
  defaultValue?: unknown;
}

export interface WrappManifest {
  id: string;
  name: string;
  icon: string;
  description: string;
  apps: WrappAppSlot[];
  objectTreeLevels?: { type: string; label: string; icon: string; properties: PropertyDef[] }[];
  eventDefinitions: EventDef[];
  defaultLayout: "tabs" | "split-h" | "split-v";
}

// === Object Types ===

export interface ObjectAction {
  id: string;
  label: string;
  icon: string;
  handler: string;                   // App ID or system action
  requiresConfirm?: boolean;
}

export interface ObjectType {
  id: string;
  label: string;
  icon: string;
  isComplex: boolean;
  childTypes?: string[];
  defaultApp?: string;
  defaultWrapp?: string;
  compatibleApps: string[];
  properties: PropertyDef[];
  actions: ObjectAction[];
  chatEnabled: boolean;
}

export interface ObjectInstance {
  id: string;
  typeId: string;
  name: string;
  path: string;
  metadata: Record<string, unknown>;
  children?: ObjectInstance[];
  chatRef?: string;                  // Reference to chat in DB
  createdAt: number;
  modifiedAt: number;
}

// === Workspace Types ===

export interface DesktopItem {
  id: string;
  type: "file" | "folder" | "object" | "shortcut";
  name: string;
  icon: string;
  path?: string;
  source?: string;                   // file source ("nextcloud" or "sftp:<host>")
  size?: number;                     // bytes (file only)
  modified?: string;                 // ISO timestamp
  appId?: string;                    // for app-shortcut items
  objectRef?: string;                // ObjectInstance ID
  gridCol: number;
  gridRow: number;
}

export interface DesktopWidget {
  id: string;
  type: string;                      // widget type id, e.g. "clock-weather"
  gridCol: number;
  gridRow: number;
  gridW: number;                     // width in grid cells
  gridH: number;                     // height in grid cells
  config?: Record<string, unknown>;
}

export interface WidgetManifest {
  id: string;
  name: string;
  description?: string;
  icon?: string;                     // emoji for picker/gallery previews
  hasSettings?: boolean;             // widget listens for "claraos-widget-settings"
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  maxSize?: { w: number; h: number };
  permissions: string[];             // mirrors AppManifest.permissions
}

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  wallpaper?: string;
  desktopItems: DesktopItem[];
  widgets?: DesktopWidget[];         // optional for backwards-compat with old persisted state
  createdAt: number;
}

// === Clara Chat Types ===

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachments?: { type: string; name: string; url: string }[];
}

export interface ChatSession {
  id: string;
  title: string;
  folderId?: string;
  messages: ChatMessage[];
  appId?: string;                    // ClaraOS app this chat is bound to (for inline-chat)
  objectRef?: string;                // Object-URI: claraos://app/<appId>/object/<encoded>
  surface?: ChatSurface;             // Where the chat originated (sidebar/inline/quick/full)
  createdAt: number;
  updatedAt: number;
}

export type ChatSurface = "full" | "sidebar" | "inline" | "quick";

export interface ChatFolder {
  id: string;
  name: string;
  parentId?: string;
}

// === Voice Types ===

export interface VoiceState {
  active: boolean;
  recording: boolean;
  transcript: string;
  muted: boolean;
}

// === Auth Types ===

export interface User {
  username: string;
  email: string;
  name: string;
  role: "admin" | "power-user" | "user" | "guest";
  groups: string[];
  logout_url?: string;               // Authentik invalidation flow URL
  profil?: "home" | "cell";          // operating profile of the instance ("cell" = hosted external instance)
}

// === Skin Types ===

export interface SkinManifest {
  id: string;
  name: string;
  colorScheme?: "light" | "dark";   // explicit; falls back to id-based heuristic in engine
  /** "brand" = AppIcon renders the real brand-logo set (dashboard-icons) instead of skin/emoji icons. */
  iconStyle?: "brand";
  tokens: {
    colors: Record<string, string>;
    fonts: Record<string, string>;
    spacing: Record<string, string>;
    shadows: Record<string, string>;
    effects: Record<string, string>;
  };
  layout: {
    taskbarPosition: "bottom" | "top" | "left" | "right";
    taskbarHeight: number;
    startMenuStyle: "grid" | "list" | "dock";
    windowButtonsPosition: "right" | "left";
    windowHeaderHeight: number;
    desktopIconGrid: { columns: number; rows: number };
  };
  icons: {
    system: string;
    apps: Record<string, string>;
    files: Record<string, string>;
    folders: Record<string, string>;
  };
  wallpapers: string[];
  defaultWallpaper: string;
  stylesheet?: string;
}

// === File Types ===

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  /** Source of the node ("nextcloud" | "sftp:<ip>") — the API tags all listings. */
  source?: string;
  size?: number;
  modified?: string;
  children?: FileNode[];
  /** Server hint about the listing (e.g. Android fallback to the app's home directory). */
  note?: string;
}

// === Notification Types ===

export interface NotificationAction {
  id: string;                        // matches a key in the action registry
  label: string;
  primary?: boolean;
  payload?: Record<string, unknown>; // forwarded to the action handler
}

/**
 * Urgency modeled on KDE: "critical" breaks through "do not disturb",
 * "low" can be suppressed separately for popup and history.
 */
export type NotificationUrgency = "low" | "normal" | "critical";

export interface Notification {
  id: string;
  title: string;
  body: string;
  icon?: string;
  timestamp: number;
  read: boolean;
  actions?: NotificationAction[];
  /** Default "normal". */
  urgency?: NotificationUrgency;
  /** App id of the sender — basis for the per-app rules. */
  source?: string;
  /** Was the popup suppressed (DND/rule)? Then only the history shows it. */
  suppressed?: boolean;
  /** Does the entry count in badges/counters? (per-app rule "badge") */
  countInBadge?: boolean;
  /**
   * Origin identifier of the sender (e.g. ntfy message id). The SSE
   * subscription replays the last 24 h on connect — without this identifier
   * every notification landed in the store again as "unread" on every load.
   * Same sourceId => no second entry.
   */
  sourceId?: string;
}

// === Marker / Region-Selection Types ===
//
// User clicks 📍 in the ChatPanel → mode='picking'. The active app's driver
// captures a region/element and emits a MarkerPayload; the chip in the input
// then carries it until the next user message is sent (where it lands as
// `context.marker` in the chat request).

export interface MarkerPayloadBase {
  /** Source app ID, e.g. "image-viewer", or "<wrapp>:<tab>" for a tab inside a wrapp. */
  appId: string;
  /** Canonical object-URI of the underlying ClaraOS object (if known). */
  objectUri?: string;
  /** PNG snapshot of the marked region as base64 (no data: prefix). */
  snapshotB64: string;
  /** ISO timestamp of capture (for cache keys / display). */
  capturedAt: string;
}

/** Bounding-box / freehand annotation on a raster image (image viewer, or a snapshot an iframe app posts). */
export interface BboxImgMarker extends MarkerPayloadBase {
  kind: "bbox-img";
  /** Pixel coords of the primary bbox in the snapshot (optional, MarkerJS may report many shapes). */
  bboxPx?: { x: number; y: number; w: number; h: number };
  /** Raw MarkerJS state SVG/JSON (for re-edit), optional. */
  annotationsSvg?: string;
}

/** SVG-element pick (diagram apps): structured handle to one DOM element. */
export interface SvgElementMarker extends MarkerPayloadBase {
  kind: "svg-element";
  elementId: string;
  /** Outer HTML of the picked element (truncated to 4 KB to keep prompts lean). */
  outerHTML: string;
}

/** GeoJSON polygon/rectangle from Leaflet-Draw (map apps). */
export interface GeoJsonMarker extends MarkerPayloadBase {
  kind: "geojson";
  /** Use unknown for the GeoJSON Feature to avoid a hard dependency on @types/geojson. */
  feature: unknown;
}

/** Object-pick on a Three.js scene with userData.objectId (3D viewers). */
export interface CadObjectMarker extends MarkerPayloadBase {
  kind: "cad-object";
  objectId: string;
  /** Sidecar object properties (e.g. IFC class, params, parent), if available. */
  bimProps?: Record<string, unknown>;
}

export type MarkerPayload =
  | BboxImgMarker
  | SvgElementMarker
  | GeoJsonMarker
  | CadObjectMarker;
