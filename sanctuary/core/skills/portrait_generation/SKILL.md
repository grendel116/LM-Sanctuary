---
name: portrait_generation
description: Render program portraits using ComfyUI.
summary: "Generate character portraits using [generate_program_portrait(prompt=\"...\")]"
retrieval: vector
triggers: portrait, draw, picture, image, selfie, photo, render, appearance, outfit, generate_program_portrait
---
# SKILL: Program Portrait Generation
Output ONLY a single tag of comma-separated visual tags capturing {{char}}, outfit, setting/lighting, and pose/expression:
`[generate_program_portrait(prompt="1girl, solo, {{char}}, ...")]`
Stop immediately after `]` with no conversational commentary.