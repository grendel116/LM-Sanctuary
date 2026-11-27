# LM-Sanctuary Licensing & Attribution

LM-Sanctuary is sovereign free software combining LM-Sanctuary's Fediverse/companion workspace with Mozilla's Gecko platform, [SillyTavern](https://github.com/SillyTavern/SillyTavern) interoperability schemas, and [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

## License Matrix

- **LM-Sanctuary Core, Web Client, & Sanctuary Browser Host (`AGPL-3.0-or-later`)**:
  - LM-Sanctuary's server (`sanctuary/`), web/mobile client (`web/`, `android/`), and native Gecko browser host modules (`browser-desktop/chrome/browser/components/sanctuary/`) are licensed under the **GNU Affero General Public License, version 3 or (at your option) any later version** ([LICENSE](./LICENSE)).
- **SillyTavern Character Card & World Info Interoperability (`AGPL-3.0` / `MIT` spec)**:
  - LM-Sanctuary interoperates with [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`AGPL-3.0`) PNG/`chara_card_v2`/`chara_card_v3` character cards and World Info `.json` lorebook schemas ([Character Card V2/V3 specification](https://github.com/kwaroran/character-card-spec-v3), public/MIT spec) inside the `sanctuary/` node.
- **Embedded ComfyUI Diffusion Engine (`GPL-3.0`)**:
  - The embedded diffusion workflow engine in `sanctuary/core/comfy_engine/` is derived from [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and remains licensed under the **GNU General Public License v3.0** ([LICENSES/GPL-3.0.txt](./LICENSES/GPL-3.0.txt)), combined with LM-Sanctuary's AGPLv3 node under **GNU AGPLv3 Section 13, paragraph 2**.
- **In-App KDBX 4.0 Vault & KeePassXC-Protocol Interoperability**:
  - Built-in encrypted password, API-key, and `.kdbx` master-key escrow support (`sanctuary/utils/keepassxc_client.py`, `sanctuary/routes/keepassxc.py`) uses a clean-room KDBX 4.0 (Argon2id + ChaCha20/AES-256-CBC + HMAC-SHA256) and NaCl `crypto_box` implementation under LM-Sanctuary's `AGPL-3.0-or-later` license, keeping `.kdbx` vaults portable with KeePassXC and KeePassDX.
- **Mozilla Gecko / GeckoView Components (`MPL-2.0`)**:
  - Upstream Firefox ESR, Mozilla `GeckoView`, and Mozilla-derived patches used in native browser builds remain licensed under the **Mozilla Public License 2.0** ([LICENSES/MPL-2.0.txt](./LICENSES/MPL-2.0.txt)), combined into an AGPLv3 Larger Work per MPL-2.0 Section 3.3.
- **Bundled Client & Runtime Dependencies (`MIT` / `BSD-3-Clause` / `Apache-2.0`)**:
  - `OpenHands` (`openhands-sdk`, `openhands-tools`, `openhands-agent-server`): `MIT` (All Hands AI)
  - `marked` (`web/assets/vendor/marked.min.js`): `MIT` (Copyright (c) 2011–2025, Christopher Jeffrey)
  - `Cropper.js` (`web/assets/vendor/cropper.min.js`): `MIT` (Copyright (c) 2015–present, Chen Fengyuan)
  - `Highlight.js` (`web/assets/vendor/highlight.min.js`): `BSD-3-Clause` (Copyright (c) 2006–2023, Highlight.js contributors)
  - `@capacitor/*`: `MIT`
  - Workspace skill `.agents/skills/modern-web-guidance`: `Apache-2.0` / `CC-BY-4.0`

## Attribution & Non-Affiliation Notice

- Copyright (C) 2026 Davy & Sebile

LM-Sanctuary is an independent project and is **not affiliated with or endorsed by the Mozilla Foundation, SillyTavern, or ComfyUI**.

## Trademarks

- All Firefox brand artwork, product names, and logos are excluded from user-facing surfaces and replaced with **Sanctuary Browser** / **LM-Sanctuary** branding.
