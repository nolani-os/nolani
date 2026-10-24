// Types
export type {
  WindowInstance,
  Position,
  Size,
  AppManifest,
  AppProcess,
  AppCategory,
  AppSource,
  AppAccount,
  CredentialSlot,
  WrappManifest,
  WrappAppSlot,
  EventDef,
  PropertyDef,
  ObjectType,
  ObjectInstance,
  ObjectAction,
  DesktopItem,
  DesktopWidget,
  WidgetManifest,
  Workspace,
  ChatMessage,
  ChatSession,
  ChatFolder,
  ChatSurface,
  VoiceState,
  User,
  SkinManifest,
  FileNode,
  Notification,
  NotificationAction,
  DraggedItem,
  MarkerPayload,
  MarkerPayloadBase,
  BboxImgMarker,
  SvgElementMarker,
  GeoJsonMarker,
  CadObjectMarker,
} from "./types";

// Store Types
export type { WindowsStore, WindowsState, WindowsActions } from "./stores/windows";
export type { UIStore, UIState, UIActions } from "./stores/ui";
export type { AuthStore } from "./stores/auth";
export type { ProcessStore, ProcessState, ProcessActions } from "./stores/process";
export type { FileStore, FileState, FileActions, ViewMode, FileSourceInfo, FileError, SortKey, SortDir, GroupBy, TrashItem, FileTabState, TabLocation, SplitPane, PlaceEntry, FileOpResult, ConflictMode } from "./stores/files";
export { activePaneOf } from "./stores/files";
export type { ClaraStore } from "./stores/clara";
export type { AppCenterStore } from "./stores/appcenter";
export type { SettingDef, SettingType, SettingsModuleDef, SettingsCategoryDef } from "./stores/settings";
export type { ObjectTypeStore } from "./stores/objecttypes";
export type { WrappStore, WrappInstance, WrappExtensions, SharedObjectNode } from "./stores/wrapp";
export type { VoiceStore, VoiceUiState } from "./stores/voice";
export type { WorkspaceStore } from "./stores/workspace";
export type { AppRegistryStore } from "./stores/appregistry";
export type { CredentialsStore } from "./stores/credentials";
export type { MatrixStore, MatrixState, MatrixActions, MatrixRoom, MatrixMessage, MatrixSpace, RailView } from "./stores/matrix";

// Stores
export { useWindowsStore, windowCloseGuards, requestCloseWindow } from "./stores/windows";
export { useUIStore } from "./stores/ui";
export { useAuthStore, useIstZelle } from "./stores/auth";
export { DEFAULT_BRAND, getBrand, setBrand, useBrand, brandVariables } from "./brand";
export type { Brand } from "./brand";
export { useProcessStore } from "./stores/process";
export { useFileStore } from "./stores/files";
export { useClaraStore } from "./stores/clara";
export { useAppCenterStore } from "./stores/appcenter";
export { useSettingsStore, useSetting } from "./stores/settings";
export { analyzePaste, pasteWarningSummary, HUGE_PASTE_THRESHOLD } from "./terminal/pasteGuard";
export {
  formatNumber,
  formatCurrency,
  formatDate,
  formatTime,
  formatDateTime as formatDateTimeLocale,
  formatBytes as formatBytesLocale,
  formatRelative,
  firstDayOfWeek,
  DEFAULT_FORMAT_PREFS,
} from "./format";
export type { FormatPrefs } from "./format";
export {
  i18n,
  initI18n,
  initialUiLanguage,
  applyUiLanguage,
  useTranslation,
  Trans,
  settingsModuleName,
  settingsCategoryName,
  settingText,
  dndRemainingText,
  dndPresetLabel,
  commandLabel,
  commandCategory,
} from "./i18n";
export type { CatalogLoader, TFunction } from "./i18n";
export {
  LANGUAGES,
  FALLBACK_LANGUAGE,
  resolveUiLanguage,
  languageName,
} from "./i18n/languages";
export type { LanguageCode, UiLanguageSetting } from "./i18n/languages";
export { useFormatPrefs, getFormatPrefs, loadFormatPrefs, regionLocale } from "./stores/useFormatPrefs";
export {
  decide as decideNotification,
  isDndActive,
  ruleFor as notificationRuleFor,
  dndRemainingLabel,
  dndUntilFor,
  DND_PRESETS,
  DEFAULT_POLICY as DEFAULT_NOTIFICATION_POLICY,
  DEFAULT_APP_RULE as DEFAULT_NOTIFICATION_APP_RULE,
} from "./notifications/policy";
export type { NotificationPolicy, AppNotificationRule } from "./notifications/policy";
export {
  COMMANDS,
  normalizeBinding,
  bindingFromEvent,
  effectiveBindings,
  commandForEvent,
  findConflicts,
  displayBinding,
  commandById,
} from "./shortcuts/registry";
export type { CommandDef, BindingMap, Conflict } from "./shortcuts/registry";
export type { PasteAnalysis, ControlCharFinding } from "./terminal/pasteGuard";
export { useObjectTypeStore } from "./stores/objecttypes";
export { useWrappStore } from "./stores/wrapp";
export { useVoiceStore } from "./stores/voice";
export { useWorkspaceStore } from "./stores/workspace";
export { useAppRegistryStore } from "./stores/appregistry";
export { useCredentialsStore } from "./stores/credentials";
export { useDeviceStore, noteLocalWrite, isEchoSuppressed } from "./stores/device";
export type {
  DeviceStore, DeviceAudio, DeviceBattery, DeviceMount, DeviceWifi, DeviceBluetooth, DeviceMic,
} from "./stores/device";
export { getNativeDevice, DEVICE_EVENT } from "./device/bridge";
export type {
  DeviceCap, ClaraOSNativeBridge, ClaraOSNativeDevice, BridgeDeviceState,
  BridgeWifiNetwork, BridgeBtDevice, BridgeAudioDevice, DeviceEventDetail, DevicePanel,
} from "./device/bridge";
export { useMatrixStore } from "./stores/matrix";
export { useDragStore } from "./stores/drag";
export type { DragStore } from "./stores/drag";
export { useMarkerStore } from "./stores/marker";
export type { MarkerStore } from "./stores/marker";
export { useClipboardStore } from "./stores/clipboard";
export type { ClipboardStore, ClipboardEntry } from "./stores/clipboard";
export { useClaraChatSettings } from "./stores/claraChatSettings";
export type { ClaraChatSettingsStore } from "./stores/claraChatSettings";
export { useMobilePrefs } from "./stores/mobilePrefs";
export type { MobilePrefsStore, ShadeAufbau } from "./stores/mobilePrefs";
export { inferViewerForPath, isImagePath, isTextPath } from "./file-types";
export { useIframeAppStore } from "./stores/iframeApps";
export type { IframeAppContext } from "./stores/iframeApps";

// Permissions
export { parsePermission, permissionCovers, hasPermission, hasAppPermissions } from "./permissions";
export type { Permission, PermissionAction } from "./permissions";

// Object-URI helpers (unified clara-chat object binding)
export {
  buildObjectUri,
  parseObjectUri,
  objectShortName,
  defaultAppChatFolderPath,
  QUICK_CHATS_FOLDER,
} from "./object-uri";
export type { ObjectUri } from "./object-uri";

// Window Manager utilities available via deep imports:
//   @claraos/core/wm/rndDefaults
//   @claraos/core/wm/functions
//   @claraos/core/wm/useSnapToEdge
//   @claraos/core/wm/iframeCapture

// ── Domain-SSOT ────────────────────────────────────────────────────────
// Generated from claraos/domains.yaml (scripts/domains/gen.py).
// NEVER hardcode host names — use svc()/shellUrl(); otherwise hard-coded hosts
// drift apart again, which once broke ~400 places during a domain migration.
export {
  BASE_DOMAIN,
  LEGACY_DOMAIN,
  APP_HOSTS,
  PENDING_HOSTS,
  SHELL_HOST,
  host as appHost,
  url as appUrl,
  shellUrl,
} from "./domains.generated";
