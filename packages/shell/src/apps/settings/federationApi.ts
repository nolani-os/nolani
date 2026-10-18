// Thin client for /api/claraos/federation/* — Federation-Partner-Registry
// + pairing flow.

const BASE = "/api/claraos/federation";

export type TrustLevel = "full" | "partial" | "per_app";
export type LayerState = "ok" | "degraded" | "unreachable" | "n/a";

export interface LayerStatus {
  state: LayerState;
  detail: string;
}

export interface FederationStatus {
  oidc?: LayerStatus;
  matrix?: LayerStatus;
  nextcloud?: LayerStatus;
  probed_at?: string;
}

export interface FederationPartner {
  id: string;
  name: string;
  base_domain: string;
  authentik_url: string;
  matrix_server: string | null;
  nextcloud_url: string | null;
  trust_level: TrustLevel;
  oidc_source_slug: string | null;
  status: FederationStatus;
  created_at: string;
  updated_at: string;
}

async function j<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${body}`);
  }
  return (await resp.json()) as T;
}

export async function fetchPartners(signal?: AbortSignal): Promise<FederationPartner[]> {
  return j(await fetch(`${BASE}/partners`, { signal }));
}

export async function mintPairingCode(): Promise<{ code: string; expires_in: number; base_domain: string }> {
  return j(await fetch(`${BASE}/pairing-code`, { method: "POST" }));
}

export async function connectPartner(body: {
  name: string;
  base_domain: string;
  pairing_code: string;
  trust_level: TrustLevel;
}): Promise<FederationPartner> {
  return j(await fetch(`${BASE}/partners`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function probePartner(id: string): Promise<{ status: FederationStatus }> {
  return j(await fetch(`${BASE}/partners/${id}/status`));
}

export async function disconnectPartner(id: string): Promise<void> {
  const resp = await fetch(`${BASE}/partners/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`disconnect: HTTP ${resp.status}`);
  }
}
