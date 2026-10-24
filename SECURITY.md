# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting instead: on this repository, go to
**Security → Report a vulnerability**. You will receive a response as soon as possible.

Please include what you found, how to reproduce it, and the affected version or commit.

## Supported versions

NolaniOS is in early preview. Only the latest commit on the default branch receives fixes.

## Security model in short

- **One cell = one trust boundary.** All users of a cell trust its administrators. Cells are
  not multi-tenant hosting.
- **Identity comes from the reverse proxy.** Caddy authenticates every request with Authentik
  (forward auth), drops identity headers a client sent itself, and adds a proxy secret that
  only it knows. The API trusts identity headers only next to that secret, or from internal
  services holding the service token. The API port is bound to loopback.
- **The API refuses to start in a cell without its trust secrets** (`setup.sh` generates them).

## Known limitations

These are known and accepted for now; reports that show a practical exploit are still welcome.

- **The browser controller holds the Docker socket** (`browser-ctl`, to create each user's
  personal browser container). A flaw in it means control of the host. It has no published
  port, its own token, and only builds container names itself.
- **Row-level security is being introduced table by table.** Tables already moved run under
  a non-superuser role with restrictive per-user policies; the remaining tables are
  protected by the API's own per-user queries only.
- **WOPI access tokens** (Collabora editing) are bearer tokens in the query string, valid for
  up to 10 hours, and Collabora's proof keys are not verified yet.
