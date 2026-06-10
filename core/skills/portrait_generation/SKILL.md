---
name: portrait_generation
description: Render companion portraits using ComfyUI.
---
# SKILL: Companion Portrait Generation
1. Prompt tags: Create a tag-only prompt: `[outfit/details], [expression/pose], [environment]`.
2. Generate: Call `generate_local_image` with tags.
3. Immersive protocol: Output *only* the returned markdown image link. No dialogue, narration, thoughts, or text in final response.