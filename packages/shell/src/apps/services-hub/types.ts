// Types for the services hub — admin view of claraos_apps rows
// with the hubService marker, plus the vault reconciliation.

export interface HubServiceRow {
  id: string;
  enabled: boolean;
  createdBy: string; // 'system' (seed) | 'hub' (created via the form)
  name: string;
  url: string;
  icon: string;
  iconUrl?: string;
  vaultItemId?: string;
  requiredGroups: string[];
}

export interface HubServiceInput {
  name: string;
  url: string;
  icon?: string;
  iconUrl?: string;
  vaultItemId?: string;
  requiredGroups?: string[];
}

/** Redacted vault item from GET /vault/items (never a secret). */
export interface VaultItemMeta {
  id: string;
  name: string;
  username?: string;
  uri?: string;
}

export interface VaultMatch {
  itemId: string;
  itemName: string;
  via: "explicit" | "domain";
}

export interface VaultStatusService {
  id: string;
  name: string;
  vaultItemId: string | null;
  matched: VaultMatch[];
}

export interface VaultStatus {
  services: VaultStatusService[];
  orphanItems: VaultItemMeta[];
}
