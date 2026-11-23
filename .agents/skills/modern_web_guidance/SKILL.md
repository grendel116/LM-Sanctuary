---
name: modern-web-guidance
title: Modern Web Guidance
description: Search and retrieve up-to-date Chrome, Firefox, Edge, and MDN web platform best practices before implementing HTML, CSS, accessibility, security, or client-side JS features.
triggers: html, css, dom, modal, dialog, popover, accordion, details, dark mode, accessibility, aria, csp, sanitize, iframe, form, web component, animation
---
# Modern Web Guidance

Before writing or refactoring HTML, CSS, accessibility, web security, or client-side JavaScript UI patterns, query the open-source `modern-web-guidance` catalog so you use Baseline native platform primitives instead of legacy JS workarounds.

## Workflow
1. **Search focused 2-5 word capability queries** (use `npx.cmd` on Windows, `npx` on POSIX):
   ```sh
   npx -y modern-web-guidance@latest search "disclosure accordion details"
   ```
2. **Retrieve matching guide IDs**:
   ```sh
   npx -y modern-web-guidance@latest retrieve "accordion,html,security"
   ```
   If output is written to a temp file, read that file in full.
3. **Core Rules Always Enforced**:
   - Prefer native `<dialog>` (`showModal()`), `[popover]`, and `<details>` + `<summary>` over custom JS overlays.
   - Never place headings (`<h1>`–`<h6>`) or interactive `<button>` / `<a>` elements inside `<summary>`.
   - Prefer `document.createElement` and `textContent` over `innerHTML` for untrusted/dynamic strings.
   - Never set `aria-hidden="true"` or `role="none"` on focusable elements (such as interactive `<iframe>` embeds); give `<iframe>` an accessible `title`.
   - When handling `window.postMessage`, strictly validate `event.source` and `event.origin` (never trust wildcards).
