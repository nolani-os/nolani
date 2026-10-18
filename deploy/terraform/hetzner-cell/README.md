# Hetzner cell (OpenTofu) — server, firewall, SSH key

This describes a cell's server resources. An existing server can be imported (afterwards `tofu plan` → "No changes").
The services run via Compose (`../../cell/`).

## Creating a new cell

```bash
cd deploy/terraform/hetzner-cell
cp zellen/example.tfvars.example zellen/<name>.tfvars        # adjust cell_name, admin_cidrs
export TF_VAR_hcloud_token="$(cat /dev/shm/…)"    # never in files; from your password vault
tofu init
tofu workspace new <name>                          # one state per cell
tofu apply -var-file=zellen/<name>.tfvars          # → ipv4/ipv6
# DNS from the operator's side (no DNS key on the cell): point <name>.example.com and
#   *.<name>.example.com (A/AAAA) at the ipv4/ipv6 outputs with your DNS provider
# Then copy ../../cell/ to /opt/claraos and run ./setup.sh <name>.example.com
```
If the operator's network uses a local DNS resolver, also add an override `<name>` / `*.<name>` → IP.

## What is deliberately NOT here
- **DNS** — the cell must not know a DNS provider key; records are set on the operator's side.
- **Services** — `setup.sh` (Compose). **IP changes** — by hand (see pitfall below).

## State
Local (`terraform.tfstate`, gitignored), one workspace per cell. Contains no secrets (the token
only comes via the environment), but does contain IDs. Note: with several cells, move it to a remote backend.

## Pitfalls
- Warning: **import + `public_net`:** after `tofu import` the `public_net` block is missing from the state; the first
  `apply` **stopped and restarted** the server because of it (a couple of minutes of downtime), even though
  nothing changed. It is now in `ignore_changes`. Read the plan before every `apply`: "update in-place" on
  `hcloud_server` can mean a reboot.
- `user_data`, `ssh_keys`, `image` cannot be read back via the API → also ignored, otherwise
  OpenTofu plans a **rebuild** (with data loss).
- The admin's WAN IP may be dynamic: when it changes, adjust `admin_cidrs` and run `tofu apply` (firewall only).
