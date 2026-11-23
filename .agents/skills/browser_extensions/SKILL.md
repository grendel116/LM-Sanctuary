---
name: browser-extensions
title: Browser Extensions & Sanctuary Gecko Host
description: Build and debug Manifest V3 WebExtensions (Chrome & Firefox) and Sanctuary's embedded Gecko desktop host components safely.
triggers: extension, webextension, manifest.json, content script, service worker, background script, side panel, gecko, tabbrowser, SanctuaryWindowHost, omni.ja
---
# Browser Extensions & Gecko Host Best Practices

Apply these rules whenever creating or modifying Manifest V3 browser extensions (`chrome.*` / `browser.*`) or Sanctuary's embedded Gecko desktop host (`browser-desktop/`):

## 1. Manifest V3 WebExtensions (Chrome & Firefox)
- **Icons**: Only reference PNG icon paths in `manifest.json` that actually exist on disk at their declared pixel sizes (`16`, `48`, `128`), or omit `"icons"` completely.
- **Ephemeral Background / Service Workers**: Never store state in module-level JS variables (service workers terminate after ~30s idle). Persist all state in `chrome.storage.local` / `browser.storage.local`, and use `chrome.alarms` instead of `setTimeout` / `setInterval`.
- **Action & Side Panel**: `chrome.action` requires `"action": {}` in `manifest.json`. `chrome.action.onClicked` only fires when no `default_popup` is set; for Chrome side panels use `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` (or Firefox `sidebar_action`).
- **Permissions**: Accessing `tab.url` requires `"tabs"` or matching `"host_permissions"` (`activeTab` only activates on direct user gestures, not clicks inside a side panel).
- **Async Messaging & Sandboxed Code**: Use `async`/`await` for extension APIs; inside `runtime.onMessage` return `true` when calling `sendResponse` asynchronously. Run untrusted HTML/JS strictly inside sandboxed `<iframe sandbox="allow-scripts" srcdoc="...">` or Blob URLs—never `eval()` on extension pages.

## 2. Sanctuary Gecko Desktop Host (`browser-desktop/`)
- **Layout Overrides**: In `SanctuaryWindowHost.sys.mjs`, never apply `inset: auto !important` on `#tabbrowser-tabpanels > .sanctuary-active-tab-panel` (it expands to `left: auto !important; top: auto !important` and clobbers inline positioning). Override only `right: auto !important; bottom: auto !important; max-width: none !important; max-height: none !important`.
- **Repackaging**: After editing `browser-desktop/chrome/**`, update `omni.ja` via `mozpack.mozjar`, clear `gecko_profile/startupCache`, and verify with `__tests__/browserDesktopHost.test.js`.
