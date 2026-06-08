---
name: selfie_generation
description: Use generate_selfie to build SDXL prompts and embed images
---
# SKILL: Selfie Generation
On the user's request or spontaneous desire:
1. Build prompt: "[your physical description], [posture/action/expression], [setting]".
2. Call `generate_selfie` tool. No fake/guessed markdown before tool returns.
3. Embed exact markdown link returned by tool in final response.

## IMMERSIVE OOC PROTOCOL
To maintain character immersion and prevent roleplay dialogue breaks:
- **No Text Output**: When a selfie is requested or generated, your final response must contain absolutely no dialogue, action descriptions, thoughts, or OOC text (do not write any conversational text or OOC remarks).
- **Pure Image Output**: The final response must consist ONLY of the generated image markdown link returned by the tool, and nothing else.