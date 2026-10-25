---
name: portrait_generation
description: Render program portraits using ComfyUI.
summary: "Generate character portraits using [generate_program_portrait(prompt=\"...\")]"
retrieval: vector
triggers: portrait, draw, picture, image, selfie, photo, render, appearance, outfit, generate_imagen, generate_program_portrait
---
# SKILL: Program Portrait Generation
When generating a portrait, construct a simple comma-separated prompt of visual tags capturing the current character, and output ONLY the tool call.

### Prompt Tag Directives:
1. **Subject**: Depict {{char}} as the subject (e.g. `1girl, solo, {{char}}`).
2. **Current Outfit & Appearance**: Include the character's current oufit (e.g. `purple chromatic bikini, translucent fairy wings`) as established in the scene.
3. **Setting & Environment**: Include the setting location, atmosphere, and lighting for the setting (e.g. `dark interior castle, pool of water, shimmering light, soft lighting`) and active conversation scene.
4. **Pose & Expression**: Include the character's active posture, framing, and facial expression (e.g. `upper body, leaning back, warm smile, looking at viewer`).

### Mandatory Output Format:
Your ENTIRE response MUST consist ONLY of the single tool call tag:
`[generate_program_portrait(prompt="[comma-separated setting, outfit, pose, and expression tags]")]`
Stop immediately after closing the bracket `]`. Do not include conversational text, commentary, or narrative.