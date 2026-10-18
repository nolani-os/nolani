// Wording of the system monitor (widget and task manager). The product names
// the hypervisor generically; an installation can name its own
// (optional heim.config.ts SYSTEM_LABELS).
export interface SystemLabels {
  /** Widget: empty state when the hypervisor API has no token. */
  tokenMissing: string;
  /** Widget settings: hint above the target list. */
  tokenMissingHint: string;
  /** Task manager → System: hint above the table. */
  tokenMissingTab: string;
  /** Widget settings: group heading of the hypervisor nodes. */
  nodeGroup: string;
  /** Task manager → System: kind column for a hypervisor node. */
  nodeKind: string;
}

const heimConfig = import.meta.glob<{ SYSTEM_LABELS?: Partial<SystemLabels> }>("../heim.config.ts", { eager: true });

export const SYSTEM_LABELS: SystemLabels = {
  tokenMissing: "Hypervisor-Token fehlt",
  tokenMissingHint: "Hinweis: Hypervisor-API-Token nicht konfiguriert — Nodes/VMs erscheinen erst danach.",
  tokenMissingTab: "Hypervisor-API-Token nicht konfiguriert — Nodes und VMs erscheinen erst danach.",
  nodeGroup: "Nodes",
  nodeKind: "Node",
  ...Object.values(heimConfig)[0]?.SYSTEM_LABELS,
};
