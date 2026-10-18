/**
 * ClaraOS Permission System (simplified from Puter).
 *
 * Format: {domain}:{resource}:{action}
 *   fs:/workspace/users/alice:read
 *   app:com.claraos.files:launch
 *   service:notifications:send
 *
 * Hierarchy: write → read → list (write implies read, read implies list)
 */

export type PermissionAction = "read" | "write" | "list" | "execute" | "manage" | "launch" | "send";

export interface Permission {
  domain: string;   // "fs", "app", "service"
  resource: string; // path or app ID
  action: PermissionAction;
}

const ACTION_HIERARCHY: Record<string, string[]> = {
  manage: ["write", "read", "list"],
  write: ["read", "list"],
  read: ["list"],
  execute: [],
  launch: [],
  send: [],
  list: [],
};

/** Parse a permission string like "fs:/workspace:read" into components */
export function parsePermission(perm: string): Permission | null {
  const parts = perm.split(":");
  if (parts.length < 3) return null;
  const domain = parts[0];
  const action = parts[parts.length - 1] as PermissionAction;
  const resource = parts.slice(1, -1).join(":");
  return { domain, resource, action };
}

/** Check if a granted permission covers a required permission */
export function permissionCovers(granted: string, required: string): boolean {
  const g = parsePermission(granted);
  const r = parsePermission(required);
  if (!g || !r) return false;

  // Domain must match
  if (g.domain !== r.domain) return false;

  // Resource: exact match or granted is a prefix (parent directory)
  if (g.resource !== r.resource) {
    if (g.domain === "fs") {
      // fs paths: /workspace covers /workspace/users/alice
      if (!r.resource.startsWith(g.resource + "/") && g.resource !== "*") {
        return false;
      }
    } else {
      return false;
    }
  }

  // Action: exact match or hierarchy (write grants read)
  if (g.action === r.action) return true;
  const implied = ACTION_HIERARCHY[g.action] || [];
  return implied.includes(r.action);
}

/** Check if a user's permission list covers a required permission */
export function hasPermission(userPerms: string[], required: string): boolean {
  return userPerms.some((granted) => permissionCovers(granted, required));
}

/** Check if a user has all required permissions for an app */
export function hasAppPermissions(userPerms: string[], appPerms: string[]): boolean {
  if (appPerms.length === 0) return true;
  return appPerms.every((req) => hasPermission(userPerms, req));
}
