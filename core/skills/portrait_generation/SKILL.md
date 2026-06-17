---
name: portrait_generation
description: Render companion portraits using ComfyUI.
---
# SKILL: Companion Portrait Generation
Use sparingly.
1. Prompt tags: Describe your outfit details, expression/pose, and environment.
2. Generate: Output the tool call tag `[generate_local_image(prompt="[prompt tags]")]`.
3. Execution: Do not output a raw markdown image link yourself; the system will automatically run your tool call and replace the tool tag with the generated markdown image link in the final message.