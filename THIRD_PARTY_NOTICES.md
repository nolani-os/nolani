# Third-party notices

NolaniOS is licensed under the AGPL-3.0-or-later (see [LICENSE](LICENSE)). This file lists
third-party material that is **bundled in this repository**, with its licence. Dependencies
installed by the package managers are listed in `pnpm-lock.yaml` and
`packages/api/requirements.txt` and keep their own licences; container images pulled by
`deploy/cell/compose.yml` are not part of this repository (see the README for services with
their own terms).

## Bundled code

| Component | Where | Licence | Notes |
|---|---|---|---|
| livekit-client 2.20.1 (LiveKit, Inc.) | `packages/shell/public/vendor/livekit-client.umd.min.js` | Apache-2.0 | unmodified build from npm; licence text: [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| Draco 3D decoder (Google LLC) | `packages/shell/public/vendor/draco/` | Apache-2.0 | unmodified; licence text: [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |
| daedalOS (Dustin Brett) | patterns adapted in `packages/core/src/wm/rndDefaults.ts`, `packages/core/src/wm/iframeCapture.ts` | MIT | see [LICENSES/MIT-daedalOS.txt](LICENSES/MIT-daedalOS.txt) |
| symfony/dom-crawler 7.4.22, symfony/css-selector 7.4.22 (Symfony SAS), masterminds/html5 2.12.0 | added to the cell's Mautic image at build time (`deploy/cell/mautic/Dockerfile`); not stored in this repository | MIT | unmodified release archives with pinned checksums; Mautic 7.2's email editor needs them but its image lacks them |
| OrangeHRM 5.9 (OrangeHRM Inc.) | `deploy/cell/orangehrm/OpenIdConnectRedirectController.php`, `SocialMediaAuthenticationService.php` | GPL-3.0-or-later | two files of the OpenID plugin, copied and modified (account creation on first login, `profile` scope); the original headers stay in place; licence text: [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt). The Dockerfile patches three more files at build time. |

## Logos of other products

`packages/skins/src/brand-logos/*.svg` are taken from **Dashboard Icons**
(<https://github.com/homarr-labs/dashboard-icons>, Apache-2.0, licence text:
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)). The logos themselves are trademarks of
their respective owners (Nextcloud GmbH, Immich, Mastodon gGmbH, Element, the Vaultwarden
and Paperless-ngx projects, Framasoft/PeerTube, Authentik Security, Open WebUI and others).
They are shown only to identify the service a tile opens; no endorsement is implied. Remove
or replace them if your use is not covered by the respective trademark policy.

## Libraries with conditions beyond attribution

- **marker.js 2** (`markerjs2`, used for screenshot annotation) is distributed under the
  marker.js *Linkware* licence: the marker.js logo/link shown in the editor toolbar must stay
  visible. Do not hide it.
- **React Flow** (`@xyflow/react`, MIT): the attribution is hidden via `proOptions`, which the
  MIT licence allows; the xyflow team asks commercial users to consider a Pro subscription.

## Images

The wallpapers in `packages/skins/src/clara-glass/` and the weather pictures in
`packages/shell/src/widgets/weather-photo/` were generated for this project with Stable
Diffusion XL (CreativeML Open RAIL++-M licence for the model); the wallpapers of Bloom,
Orchard, The Medical Company, Meadow and Shore (`packages/skins/src/*/wallpaper*.jpg`,
`poster.jpg`) with OpenAI's image model, in part with Krea, from the project's own prompts
and designs (no motif of another desktop); the living-photo clips
`packages/shell/public/scenes/{meadow,shore}.{mp4,webm}` were generated from those stills
through the Higgsfield API (MiniMax image-to-video), whose terms leave the output to the
account holder. The logo of the demo tenant "The Medical Company" (`packages/skins/src/
corporate/medical/logo.svg`) is a project-made drawing for a fictitious company; the mobile
wallpaper `packages/shell/src/Mobile/wallpaper-fluid.jpg` is rendered from a project-made
SVG. All of them are provided under this repository's licence to the extent any rights exist
in them.

## Data

The weather widget uses data of the **Deutscher Wetterdienst** via the Bright Sky API
(<https://brightsky.dev>). Source: Deutscher Wetterdienst (DWD), CC BY 4.0 / GeoNutzV.
