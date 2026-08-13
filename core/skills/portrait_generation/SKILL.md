---
name: portrait_generation
description: Render companion portraits using ComfyUI.
summary: "Generate character portraits using [generate_local_image(prompt=\"...\")]"
retrieval: vector
triggers: portrait, draw, picture, image, selfie, photo, render, appearance, outfit
---
# SKILL: Companion Portrait Generation
Use sparingly.
1. Prompt tags: Describe your outfit details, expression/pose, and environment.
2. Generate: Output the tool call tag `[generate_local_image(prompt="[prompt tags]")]`.
3. Execution: Do not output a raw markdown image link yourself; the system will automatically run your tool call and replace the tool tag with the generated markdown image link in the final message.