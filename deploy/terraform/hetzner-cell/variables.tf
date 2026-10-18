variable "hcloud_token" {
  description = "Hetzner Cloud API token (read+write). ONLY via TF_VAR_hcloud_token, never in files."
  type        = string
  sensitive   = true
}

variable "cell_name" {
  description = "Name of the cell — yields claraos-<name> (server) and claraos-<name>-fw (firewall)."
  type        = string
  default     = "demo"
}

variable "created_by" {
  description = "Label created-by (who or what created the cell)."
  type        = string
  default     = "opentofu"
}

variable "server_type" {
  description = "CX43: 8 vCPU / 16 GB / 160 GB (measured ~6 GB when idle, office needs headroom). 8 GB (CX33) is too tight."
  type        = string
  default     = "cx43"
}

variable "location" {
  description = "Location (nbg1 = Nuremberg, fsn1 = Falkenstein — both in Germany)."
  type        = string
  default     = "nbg1"
}

variable "ssh_key_name" {
  description = "Name of the SSH key in the Hetzner project (one for all cells)."
  type        = string
  default     = "claraos-admin"
}

variable "ssh_public_key" {
  description = "Public key of the operator (cloud-init installs it for the user clara)."
  type        = string
}

variable "admin_cidrs" {
  description = "Networks allowed to reach the cell via SSH (e.g. the operator's public IP)."
  type        = list(string)
}
