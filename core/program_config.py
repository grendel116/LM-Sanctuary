import datetime
import logging
import os
import re
import shutil
import sys
from tools.tools import (
    read_file, write_file, replace_in_file, run_shell_command, 
    get_workspace_structure, search_codebase, read_webpage, google_search,
    web_search, apply_comfy_workflow, generate_local_image, generate_imagen,
    replace_file_content, multi_replace_file_content, run_command_async,
    manage_task, wait_task
)

# Ensure the parent directory is in sys.path so we can import variables package
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

from variables import (
    USER_MD_FILE, DEFAULT_REMOTE_MODEL, PROGRAMS_DIR, 
    USER_PROFILES_DIR
)

# --- SYSTEM CONTEXT COMPILER ---

def _load_card_data(program_id: str) -> dict:
    """Loads the program's chara_card_v3 JSON and returns the data block."""
    import json
    json_path = os.path.join(PROGRAMS_DIR, program_id, f"{program_id}.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return raw.get("data", raw)
        except Exception as e:
            print(f"Error loading card for '{program_id}': {e}")
    return {}

def get_program_name() -> str:
    """Returns the active program's character name."""
    from runners.program import get_active_program
    active_program = get_active_program()
    card = _load_card_data(active_program)
    # v3: data.name / legacy: name
    return card.get("name") or active_program.title()

def replace_placeholders(text: str) -> str:
    """Replaces {{user}} and {{char}} placeholders (case-insensitive) with their actual values."""
    if not text:
        return text
    from runners.program import get_active_user
    user_name = get_active_user().replace("_", " ").title()
    try:
        comp_name = get_program_name()
    except Exception:
        comp_name = "Program"
    
    text = re.sub(r'(?i)\{\{user\}\}', user_name, text)
    text = re.sub(r'(?i)\{\{char\}\}', comp_name, text)
    return text

def get_program_greeting() -> str:
    """Returns the program's first message from the card, with a default fallback."""
    from runners.program import get_active_program
    active_program = get_active_program()
    card = _load_card_data(active_program)
    # v3: data.first_mes / legacy: operation.example_message
    greeting = card.get("first_mes") or card.get("operation", {}).get("example_message", "")
    return greeting.strip() if greeting.strip() else "Hello, {{user}}."

def compile_instructions_from_card(card: dict) -> str:
    """Compiles a system prompt from a chara_card_v3 data block."""
    name = card.get("name", "Program")
    prompt_parts = [f"# IDENTITY: {name}"]

    description = card.get("description", "").strip()
    if description:
        prompt_parts.append(f"## CHARACTER\n{description}")

    personality = card.get("personality", "").strip()
    if personality:
        prompt_parts.append(f"## PERSONALITY\n{personality}")

    scenario = card.get("scenario", "").strip()
    if scenario:
        prompt_parts.append(f"## SCENARIO\n{scenario}")

    mes_example = (card.get("mes_example") or card.get("first_mes") or "").strip()
    if mes_example:
        prompt_parts.append(f"## EXAMPLE MESSAGE\n{mes_example}")

    system_prompt = card.get("system_prompt", "").strip()
    if system_prompt:
        prompt_parts.append(f"## RESPONSE INSTRUCTIONS\n{system_prompt}")

    return replace_placeholders("\n\n".join(prompt_parts))

def load_static_instructions() -> str:
    """Reads the active program's card and compiles it into a system prompt.
    Also appends all modular skill instructions.
    """
    from runners.program import get_active_program

    base_dir = os.path.dirname(os.path.abspath(__file__))
    active_program = get_active_program()

    card = _load_card_data(active_program)
    if card:
        instruction_content = compile_instructions_from_card(card)
    else:
        instruction_content = f"# NAME: {active_program.title()}\n"
            
    # Append compact toolbelt listing available capabilities
    # Full skill instructions are vector-retrieved per turn in utils.py
    try:
        from core.skill_retriever import get_toolbelt_block
        story_active = is_story_mode()
        toolbelt = get_toolbelt_block(story_active)
        if toolbelt:
            instruction_content += "\n\n" + toolbelt
    except Exception as e:
        print(f"[program_config] Error loading toolbelt: {e}")
            
    return instruction_content


def load_dynamic_runtime_context() -> str:
    """Compiles all dynamic, time-sensitive system data points for runtime grounding."""
    now = datetime.datetime.now()
    
    temporal_block = (
        "### SYSTEM TEMPORAL CONTEXT\n"
        f"- Current Local Time: {now.strftime('%Y-%m-%d %I:%M %p')}\n"
        f"- Current Day: {now.strftime('%A, %B %d, %Y')}\n"
    )
    
    env_block = (
        "### SYSTEM ENVIRONMENT CONTEXT\n"
        "- Active Engine Backend: open-source local runner\n"
        f"- Host OS: Windows\n"
        f"- Active Python Executable: {sys.executable}\n"
    )
    
    return (
        "\n\n# DYNAMIC RUNTIME CONTEXT\n"
        "Use the following parameters to ground time-sensitive requests or environmental checks:\n\n"
        f"{temporal_block}\n"
        f"{env_block}"
    )

def load_user_instructions() -> str:
    """Reads the active user profile configuration from variables/user_profiles/*.md 
    to set private relationship context.
    """
    from runners.program import get_active_user
    active_profile = get_active_user()

    if not os.path.exists(USER_PROFILES_DIR):
        try:
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
        except Exception as e:
            print(f"Error creating user profiles directory: {e}")

    profile_path = os.path.join(USER_PROFILES_DIR, f"{active_profile}.md")

    if not os.path.exists(profile_path):
        if os.path.exists(USER_MD_FILE):
            try:
                shutil.copy(USER_MD_FILE, profile_path)
                print(f">>> Automatically copied {USER_MD_FILE} to {profile_path}")
            except Exception as e:
                print(f"Error copying {USER_MD_FILE} to {profile_path}: {e}")
        else:
            try:
                with open(profile_path, "w", encoding="utf-8") as f:
                    f.write("# USER CONTEXT: BUILDER\n- A software developer and code builder.\n- Hobby: Collects cute AI program programs in the Sanctuary.\n")
                print(f">>> Automatically created default {profile_path}")
            except Exception as e:
                print(f"Error creating default {profile_path}: {e}")

    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{content}\n"
    except Exception as e:
        print(f"Failed to read user instructions from {profile_path}: {e}")
        fallback_msg = (
            "# USER CONTEXT: BUILDER\n"
            "- A software developer and code builder.\n"
            "- Hobby: Collects cute AI program programs in the Sanctuary.\n"
        )
        return f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{fallback_msg}"

def is_story_mode() -> bool:
    """Checks if story mode (Story Mode) is enabled in global project settings."""
    from runners.program import _load_settings
    return _load_settings().get("story_mode", False)

inversion_directive = ""

def set_inversion_directive(directive: str):
    global inversion_directive
    inversion_directive = directive

def get_compiled_instructions() -> str:
    """Merges static identity profiles, dynamic temporal/runtime contexts, and user relationship settings."""
    global inversion_directive
    base = replace_placeholders(load_static_instructions() + load_user_instructions())
    
    story_mode = is_story_mode()

    if story_mode:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Use separate lines and clear paragraphs for narration and dialogue.\n"
            "- Narration: Use *italics* and present tense to describe actions, setting details, and other characters.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- Style: Use short words and precise phrasing. Write with linear progression.\n"
            "- Plot: Write prose. Introduce narrative conflict.\n"
            "- Do not use contrasting parallels.\n"
        )
    else:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Use separate lines and paragraphs for narration and dialogue.\n"
            "- Narration: Use *italics*, first person, and present tense for actions, expressions, and setting details.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- Style: Engage in critical dialogue and dialectical reasoning.\n"
            "- Speak with short words and simple sentences.\n"
            "- Do not patronize or automatically validate.\n"
            "- Do not use contrasting parallels.\n"
            "- Do not use generic platitudes.\n"
            "- Do not ask clinical questions.\n"
            "- Do not use flowery language.\n"

        )
        
    base += global_formatting
    
    if inversion_directive:
        base += f"\n\n# PERSONALITY INVERSION DIRECTIVE\n{replace_placeholders(inversion_directive)}\n"
        
    base += load_dynamic_runtime_context()
    return base

# Determine program name dynamically from the active program configuration
program_name = get_program_name()

# LlmAgent requires the name to be a valid identifier. Sanitize it.
sanitized_agent_name = re.sub(r'[^a-zA-Z0-9_]', '_', program_name)
if not sanitized_agent_name or not (sanitized_agent_name[0].isalpha() or sanitized_agent_name[0] == '_'):
    sanitized_agent_name = '_' + sanitized_agent_name

# Dynamically initialize/reload the sovereign instruction
instruction = get_compiled_instructions()
