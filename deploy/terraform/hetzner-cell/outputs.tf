output "ipv4" {
  description = "Public IPv4 — for the cell's DNS records"
  value       = hcloud_server.cell.ipv4_address
}

output "ipv6" {
  description = "Public IPv6 (…::1 of the network) — for the cell's DNS records"
  value       = hcloud_server.cell.ipv6_address
}

output "server_id" {
  value = hcloud_server.cell.id
}
