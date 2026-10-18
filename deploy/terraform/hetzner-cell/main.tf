# ClaraOS cell on Hetzner Cloud — server, firewall, SSH key.
# Describes the RUNNING cell (built via
# the API and imported here — `tofu plan` must then report "No changes"). The services
# come from deploy/cell/setup.sh (Compose), DNS is set by the operator —
# both deliberately NOT here (the cell must not know a DNS key).
terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.52"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

locals {
  labels = {
    projekt        = "claraos-${var.cell_name}"
    zelle          = var.cell_name
    "angelegt-von" = var.created_by
  }
}

# One key per Hetzner project (the operator's automation key), shared by all cells.
resource "hcloud_ssh_key" "admin" {
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
  labels     = local.labels
}

# Only what the cell needs is open: SSH exclusively from the admin addresses,
# web for everyone, media ports for calls (LiveKit). Mail ports only once needed.
resource "hcloud_firewall" "cell" {
  name   = "claraos-${var.cell_name}-fw"
  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
    description = "SSH from admin addresses only"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "HTTP (ACME/Redirect)"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "HTTPS"
  }
  rule {
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "HTTP/3"
  }
  # Calls (LiveKit): media directly, not through Caddy.
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "7881"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "LiveKit TCP (Medien-Fallback)"
  }
  rule {
    direction   = "in"
    protocol    = "udp"
    port        = "50100-50200"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "LiveKit UDP (Medien)"
  }
  rule {
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Ping"
  }
}

resource "hcloud_server" "cell" {
  name         = "claraos-${var.cell_name}"
  image        = "debian-13"
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.cell.id]
  backups      = true
  labels       = local.labels
  user_data    = file("${path.module}/../../cell/cloud-init.yaml")

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  # user_data, ssh_keys and image only take effect at creation and cannot be read back
  # via the API. Without this line an imported server would consider them "changed" and
  # OpenTofu would REBUILD it — losing all data.
  # Warning: public_net: after an import the block is missing from the state; the first
  # apply STOPPED and restarted the server because of it (a couple of minutes of downtime),
  # although no value changed. So IP changes are deliberately done by hand, never via this file.
  lifecycle {
    ignore_changes = [user_data, ssh_keys, image, public_net]
  }
}
