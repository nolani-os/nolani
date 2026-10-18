// Thin fetch wrapper for the services hub (same pattern as the other app API clients).
// The user grid needs NONE of these routes (it comes from the appregistry store);
// everything here is admin surface (clara-admins; mutations additionally human-only).

import type { HubServiceInput, HubServiceRow, VaultItemMeta, VaultStatus } from "./types";

const BASE = "/api/claraos/hub";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* body was not JSON — the status code is enough */ }
    throw new HubApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export class HubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const listServices = () => req<HubServiceRow[]>("/services");

export const createService = (input: HubServiceInput) =>
  req<HubServiceRow>("/services", { method: "POST", body: JSON.stringify(input) });

export const updateService = (id: string, input: Partial<HubServiceInput>) =>
  req<HubServiceRow>(`/services/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const deleteService = (id: string) =>
  req<{ status: string }>(`/services/${encodeURIComponent(id)}`, { method: "DELETE" });

export const vaultStatus = () => req<VaultStatus>("/vault-status");

/** Create tiles from the vault collection "Drittdienste" (third-party services).
 *  Only creates, never deletes — orphaned tiles stay in place and visible. */
export const syncVault = () =>
  req<{ created: { id: string; name: string }[]; skipped: { name: string; grund: string }[] }>(
    "/services/sync-vault",
    { method: "POST", body: "{}" },
  );

/** Enable/disable goes through the existing apps endpoint (admin-gated). */
export async function toggleService(id: string): Promise<void> {
  const res = await fetch(`/api/claraos/apps/${encodeURIComponent(id)}/toggle`, { method: "POST" });
  if (!res.ok) throw new HubApiError(res.status, `HTTP ${res.status}`);
}

/** Vault items (redacted, without secrets) for the link dropdown. */
export async function listVaultItems(): Promise<VaultItemMeta[]> {
  const res = await fetch("/api/claraos/vault/items");
  if (!res.ok) throw new HubApiError(res.status, `HTTP ${res.status}`);
  const items = (await res.json()) as Array<{
    id?: string;
    name?: string;
    login?: { username?: string; uris?: Array<{ uri?: string }> };
  }>;
  return items
    .filter((it) => it.id && it.name)
    .map((it) => ({
      id: it.id as string,
      name: it.name as string,
      username: it.login?.username,
      uri: it.login?.uris?.[0]?.uri,
    }));
}
