# LM-Sanctuary Desktop Browser Build & Packaging (Windows & Linux)

This directory overlays stock Mozilla **Firefox ESR 153** (`FIREFOX_153_7_0esr_RELEASE`, revision `9aecd40e03ebf6e866e32a0a3001488ed751228d`) with LM-Sanctuary's own branding, privacy preferences, native `SanctuaryHost` and `SanctuaryAgentPage` `JSWindowActor` bridges, and KeePassXC Native Messaging registration.

> LM-Sanctuary is an independent project distributed under `AGPL-3.0-or-later` (with `MPL-2.0` Gecko components) and is not affiliated with or endorsed by the Mozilla Foundation.

---

## Build Modes

| Mode | Command | Purpose |
| :--- | :--- | :--- |
| Template verification | `python browser-desktop/bootstrap_gecko.py --verify-templates` | Validates `upstream.json`, branding, actor security gates, and packaging templates. |
| Fast Artifact build | `python browser-desktop/bootstrap_gecko.py --mode artifact` | Downloads prebuilt Gecko binaries and compiles LM-Sanctuary's chrome & branding into `omni.ja`. |
| Full Gecko release | `python browser-desktop/bootstrap_gecko.py --mode gecko` | Compiles C++ / Rust `libxul` (`MOZ_APP_VENDOR=LMSanctuary`, `MOZ_APP_NAME=lm-sanctuary`). |

- **Windows**: Run inside MozillaBuild bash shell (for `artifact` or `gecko` compilation).
- **Linux**: Ensure `python3`, `git`, `dpkg-buildpackage`, `debhelper`, and `rpmbuild` (plus optional `appimagetool`) are installed.

## KeePassXC-Browser Integration

Because LM-Sanctuary sets its own Gecko vendor and Linux profile directory (`LMSanctuary` / `.lm-sanctuary`), `browser-desktop/keepassxc_nmh.py` automatically discovers an existing KeePassXC proxy (`keepassxc-proxy`) and registers `org.keepassxc.keepassxc_browser` (`keepassxc-browser@keepassxc.org`):

- **Windows**: `HKCU\Software\LMSanctuary\NativeMessagingHosts\org.keepassxc.keepassxc_browser` -> `%APPDATA%\LMSanctuary\NativeMessagingHosts\org.keepassxc.keepassxc_browser.json`
- **Linux**: `~/.lm-sanctuary/native-messaging-hosts/org.keepassxc.keepassxc_browser.json`

## Packaging Commands

- **Windows (`.zip` & optional NSIS `.exe`):**
  ```powershell
  powershell -ExecutionPolicy Bypass -File browser-desktop/packaging/package_windows.ps1 -Mode gecko
  ```
- **Linux (`.deb`, `.rpm`, `.AppImage`):**
  ```bash
  ./browser-desktop/packaging/package_linux.sh browser-desktop/build/firefox/objdir-sanctuary-gecko/dist/lm-sanctuary-*.tar.xz 2.0.0 1
  ```
