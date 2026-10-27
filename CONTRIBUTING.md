# Contributing to NolaniOS

Thanks for your interest in NolaniOS! This document explains how to propose changes. Please
also read the [Code of Conduct](CODE_OF_CONDUCT.md).

> NolaniOS is in early preview. Interfaces and layout still change; please open an issue to
> discuss larger changes before you start working on them.

## Ground rules

- **English** for code, comments, commit messages and documentation. User-facing texts live in
  the translation catalogs (`packages/shell/src/locales/<language>/*.json`); German and
  English are maintained, more languages are welcome.
- **Names come from the brand.** Never hard-code the product or assistant name in user-facing
  text: use `{{product}}` / `{{assistant}}` in catalogs, `getBrand()` / `useBrand()` in the
  shell and `PRODUCT_NAME` / `ASSISTANT_NAME` (`betriebsprofil.py`) in the API.
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

**API** (Python 3.14, FastAPI):

```bash
cd packages/api
pip install -r requirements.txt pytest respx pytest-asyncio
python -m pytest -q
```

**Frontend** (Node 26, pnpm): the images are the reference build.

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
   project's license (AGPL-3.0-or-later).

### How an accepted pull request lands

This repository is published from the maintainers' development tree, so a pull request is not
merged with the button on GitHub. Instead, the change is applied to that tree, tested there,
and the next publish creates a merge commit that has your pull request as a parent. GitHub then
shows the pull request as merged, and your commits stay in the history of `main` under your
name. If we adjust your change on the way (for example after review), the pull request
conversation says what changed. Publishing happens in the evening (Central European Time), so
there can be a delay of a day between approval and merge.

## Security issues

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
