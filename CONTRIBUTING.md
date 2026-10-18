# Contributing to ClaraOS

Thanks for your interest in ClaraOS! This document explains how to propose changes.

> ClaraOS is in early preview. Interfaces and layout still change; please open an issue to
> discuss larger changes before you start working on them.

## Ground rules

- **English** for code, comments, commit messages and documentation. (The user interface is
  currently German; translations are welcome as a separate effort.)
- **No personal data, no secrets.** Never commit API keys, passwords, tokens, real e-mail
  addresses, names of real people, or addresses of a private network. Use `example.com`,
  `alice`/`bob` and documentation IP ranges (`192.0.2.0/24`, `203.0.113.0/24`) in examples
  and tests. CI scans every push for secrets.
- **Configuration, not constants.** Installation-specific values (URLs, hosts, accounts)
  come from environment variables. `betriebsprofil.heim_default("VAR")` returns an empty
  string in a cell when the variable is unset, so a missing setting turns a feature off
  instead of connecting it to the wrong place.
- **Comments explain why.** Describe the reason and the pitfall, not the history of how it
  was found — that belongs in the commit message.

## Development

Repository layout: see [README.md](README.md).

**API** (Python 3.11, FastAPI):

```bash
cd packages/api
pip install -r requirements.txt pytest respx
python -m pytest -q
```

**Frontend** (Node 20, pnpm): the images are the reference build.

```bash
docker build -f docker/Dockerfile.api .
docker build -f docker/Dockerfile.frontend .   # runs the smoke test and the Vite build
```

**End-to-end** on a running cell: `deploy/cell/run_tests.sh` (creates and removes a throw-away
test account).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep a pull request focused on one change; add or update tests where it makes sense.
3. Make sure CI is green (secret scan, API tests, image builds).
4. **Sign off your commits** (Developer Certificate of Origin, <https://developercertificate.org>):

   ```bash
   git commit -s -m "Describe the change"
   ```

   The sign-off certifies that you wrote the change or have the right to submit it under the
   project's license (AGPL-3.0).

## Security issues

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
