# Changelog

All notable changes to this project are documented here. The project is in early preview and
does not follow semantic versioning yet.

## Unreleased — first public preview

- Renamed from ClaraOS to **NolaniOS**; product and assistant names are configurable per
  installation (`CLARAOS_PRODUCT_NAME`, `CLARAOS_ASSISTANT_NAME`). Internal identifiers keep
  the old name for now.
- Security hardening before publication: identity headers sent by clients are dropped before
  forward auth; CORS limited to the installation's own host names; the API refuses to start
  in a cell without its trust secrets; the tool proxy accepts machine callers only; planner
  writes check the caller's own access first; resource bookings can only be cancelled by
  whoever made them (or an administrator); the web clipper connects only to the address it
  checked; container images pinned; Valkey instead of Redis.
- Shell origin hardened: mail attachments and cloud files render inline only for safe types
  (everything else downloads, with `nosniff` and a sandboxing CSP); mail HTML is sanitised
  with an allowlist parser (nh3) and again with DOMPurify in the composer; iframe bridge
  messages are bound to the embedding origins; mail archive attachments unpack at most 2 MB;
  Caddy sets HSTS, `nosniff`, a referrer policy, `frame-ancestors` and a body limit on the
  shell host, the full Content-Security-Policy runs report-only for now; no production
  sourcemaps.
- Third-party notices, licence texts, code of conduct and issue templates added.
