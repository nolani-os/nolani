/**
 * Object-URI: canonical reference to a ClaraOS app object.
 *
 *   claraos://app/<appId>/object/<urlencoded-key>
 *
 * Used by the unified Clara chat to bind a chat session to whatever the user
 * has open in an app (a file path, a wrapp node id, a CAD model …).
 */

const PROTOCOL = "claraos:";
const PREFIX = "//app/";
const OBJECT_PREFIX = "/object/";

export interface ObjectUri {
  appId: string;
  /** decoded form of the object key (no urlencoding) */
  objectKey: string;
}

/** Build a canonical object-URI string for the given app + object key. */
export function buildObjectUri(appId: string, objectKey: string): string {
  if (!appId) throw new Error("buildObjectUri: appId is required");
  return `${PROTOCOL}${PREFIX}${encodeURIComponent(appId)}${OBJECT_PREFIX}${encodeURIComponent(objectKey ?? "")}`;
}

/** Parse a canonical object-URI back into its parts. Returns null on malformed input. */
export function parseObjectUri(uri: string): ObjectUri | null {
  if (typeof uri !== "string") return null;
  if (!uri.startsWith(`${PROTOCOL}${PREFIX}`)) return null;
  const rest = uri.slice(`${PROTOCOL}${PREFIX}`.length);
  const sep = rest.indexOf(OBJECT_PREFIX);
  if (sep < 0) return null;
  const appId = decodeURIComponent(rest.slice(0, sep));
  const objectKey = decodeURIComponent(rest.slice(sep + OBJECT_PREFIX.length));
  if (!appId) return null;
  return { appId, objectKey };
}

/**
 * Short, human-readable label for an object key — used as auto-folder name.
 * Strips paths, keeps the trailing segment, drops the URL scheme prefix.
 *
 *   nextcloud://alice/docs/report.pdf      →  report.pdf
 *   sftp://server/srv/app/compose.yml      →  compose.yml
 *   wrapp://ws1/diagram-1                  →  diagram-1
 *   ""                                     →  "(unbenannt)"
 */
export function objectShortName(objectKey: string): string {
  if (!objectKey) return "(unbenannt)";
  let s = objectKey;
  const schemeIdx = s.indexOf("://");
  if (schemeIdx >= 0) s = s.slice(schemeIdx + 3);
  const lastSlash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  return s || "(unbenannt)";
}

/**
 * Default auto-folder path for chats bound to an app object.
 * Convention: "🤖 App Chats" / <appId> / <object short name>
 */
export function defaultAppChatFolderPath(appId: string, objectKey?: string): string[] {
  const root = "🤖 App Chats";
  if (!objectKey) return [root, appId];
  return [root, appId, objectShortName(objectKey)];
}

export const QUICK_CHATS_FOLDER = "⚡ Quick Chats";
