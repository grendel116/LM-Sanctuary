---
name: portrait_generation
description: Render companion portraits using ComfyUI.
summary: "Generate character portraits using [generate_program_portrait(prompt=\"...\")]"
retrieval: always
triggers: portrait, draw, picture, image, selfie, photo, render, appearance, outfit, generate_imagen, generate_program_portrait
---
# SKILL: Companion Portrait Generation
MANDATORY OUTPUT FORMAT:
When generating a portrait, your ENTIRE response MUST consist ONLY of the single tool call tag. 
1. Do NOT output any narrative text, dialogue, descriptions, or commentary before or after the tool call.
2. Output format: `[generate_program_portrait(prompt="[detailed prompt tags]")]`
3. Stop immediately after closing the bracket `]`.