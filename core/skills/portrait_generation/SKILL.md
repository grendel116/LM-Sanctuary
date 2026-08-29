---
name: portrait_generation
description: Render companion portraits using ComfyUI.
summary: "Generate character portraits using [generate_program_portrait(prompt=\"...\")]"
retrieval: always
triggers: portrait, draw, picture, image, selfie, photo, render, appearance, outfit, generate_imagen, generate_program_portrait
---
# SKILL: Companion Portrait Generation
When generating a portrait, construct a detailed comma-separated prompt of visual tags capturing the full scene context, and output ONLY the tool call.

### Prompt Tag Directives:
1. **Subject**: Depict {{char}} as the main subject (e.g. `1girl, solo, {{char}}`). Do not invent extra subjects.
2. **Current Outfit & Appearance**: Include the character's clothing, style, garments, fabrics, and signature accessories from their character profile (e.g. `purple chromatic bikini, translucent fairy wings`) unless a specific alternate outfit has been established in the scene.
3. **Setting & Environment**: Include the setting location, background elements, atmosphere, and lighting from the character's scenario setting (e.g. `dark interior castle, pool of water, cushions, shimmering starlight, soft lighting`) and active conversation scene.
4. **Pose & Expression**: Include the character's active posture, framing, and facial expression (e.g. `upper body, leaning back against cushions, warm smile, looking at viewer`).

### Mandatory Output Format:
Your ENTIRE response MUST consist ONLY of the single tool call tag:
`[generate_program_portrait(prompt="[comma-separated setting, outfit, pose, and expression tags]")]`
Stop immediately after closing the bracket `]`. Do not include conversational text, commentary, or narrative.