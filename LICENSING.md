# LM-Sanctuary Licensing & Attribution

LM-Sanctuary is sovereign free software combining LM-Sanctuary's Fediverse/companion workspace with browser architecture and components adapted from [Sval](https://gitlab.com/sval-browser/sval), Mozilla's Gecko platform, [SillyTavern](https://github.com/SillyTavern/SillyTavern) interoperability schemas, and [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

## License Matrix

- **LM-Sanctuary & Adapted Browser Modules (`AGPL-3.0-only WITH AdditionRef-sval-app-store`)**:
  - LM-Sanctuary's browser workspace modules and code adapted from Sval are licensed under the **GNU Affero General Public License, version 3 only** ([LICENSE](./LICENSE)) with the **Sval App Store Permission, version 1.0** ([LICENSES/AdditionRef-sval-app-store.txt](./LICENSES/AdditionRef-sval-app-store.txt)) under section 7 of AGPLv3.
  - This permission allows distributing compiled builds through official app stores (such as Google Play, Microsoft Store, and Flathub) while preserving all AGPLv3 source availability obligations.
- **SillyTavern Character Card & World Info Interoperability (`AGPL-3.0` / `MIT` spec)**:
  - LM-Sanctuary interoperates with [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`AGPL-3.0`) PNG/`chara_card_v2`/`chara_card_v3` character cards and World Info `.json` lorebook schemas ([Character Card V2/V3 specification](https://github.com/kwaroran/character-card-spec-v3), public/MIT spec) inside the `sanctuary/` node.
  - Upstream SillyTavern's `AGPL-3.0` license shares the GNU AGPLv3 base license of LM-Sanctuary's server (`sanctuary/`). Per Section 4 of `AdditionRef-sval-app-store`, the App Store exception applies only to code released under that permission, and the standalone `web/` + `android/` App Store client bundle contains no third-party pure-AGPL or GPL code.
- **Embedded ComfyUI Diffusion Engine (`GPL-3.0`)**:
  - The embedded diffusion workflow engine in `sanctuary/core/comfy_engine/` is derived from [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and remains licensed under the **GNU General Public License v3.0** ([LICENSES/GPL-3.0.txt](./LICENSES/GPL-3.0.txt)), combined with LM-Sanctuary's AGPLv3 node under **GNU AGPLv3 Section 13, paragraph 2**.
- **Mozilla Gecko / GeckoView / `adblock-rust` Components (`MPL-2.0`)**:
  - Upstream Firefox ESR, Mozilla `GeckoView`, `adblock-rust`, and Mozilla-derived patches used in native browser builds remain licensed under the **Mozilla Public License 2.0** ([LICENSES/MPL-2.0.txt](./LICENSES/MPL-2.0.txt)), combined into an AGPLv3 Larger Work per MPL-2.0 Section 3.3.
- **Bundled Client & Runtime Dependencies (`MIT` / `BSD-3-Clause` / `Apache-2.0`)**:
  - `OpenHands` (`openhands-sdk`, `openhands-tools`, `openhands-agent-server`): `MIT` (All Hands AI)
  - `marked` (`web/assets/vendor/marked.min.js`): `MIT` (Copyright (c) 2011–2025, Christopher Jeffrey)
  - `Cropper.js` (`web/assets/vendor/cropper.min.js`): `MIT` (Copyright (c) 2015–present, Chen Fengyuan)
  - `Highlight.js` (`web/assets/vendor/highlight.min.js`): `BSD-3-Clause` (Copyright (c) 2006–2023, Highlight.js contributors)
  - `@capacitor/*`: `MIT`
  - Workspace skill `.agents/skills/modern_web_guidance`: `Apache-2.0` / `CC-BY-4.0`

## Attribution & Non-Affiliation Notice

- Copyright (C) 2026 Davy & Sebile
- Required Notice: Copyright 2026 Ellm Tree, Inc. (https://sval.app)

LM-Sanctuary is an independent project based in part on Sval's open-source browser architecture and is **not affiliated with or endorsed by Sval, Ellm Tree, Inc., the Mozilla Foundation, SillyTavern, or ComfyUI**.

## Trademarks & Network Separation

- All Sval and Firefox brand artwork, product names, and logos are excluded from user-facing surfaces and replaced with **Sanctuary Browser** / **LM-Sanctuary** branding.
- Sanctuary Browser never connects to Sval's update (`download.sval.app`) or feedback (`feedback.sval.app`) servers.
