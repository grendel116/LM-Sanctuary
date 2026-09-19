import datetime
import os
import re
import shutil
import sys
from runners.program import get_active_program

# Ensure the parent directory is in sys.path so we can import variables package
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

from variables.settings import (
    USER_MD_FILE, PROGRAMS_DIR, USER_PROFILES_DIR
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
    """Returns the program's first message from the card, defaulting to a standard greeting."""
    from runners.program import get_active_program
    active_program = get_active_program()
    card = _load_card_data(active_program)
    # v3: data.first_mes / legacy: operation.example_message
    greeting = card.get("first_mes") or card.get("operation", {}).get("example_message", "")
    return greeting.strip() if greeting.strip() else "Hello, {{user}}."

def compile_instructions_from_card(card: dict, override_scenario: str = None, include_example: bool = True) -> str:
    """Compiles a system prompt from a chara_card_v3 data block."""
    name = card.get("name", "Program")
    prompt_parts = [f"# IDENTITY: {name}"]

    description = card.get("description", "").strip()
    if description:
        prompt_parts.append(f"## CHARACTER\n{description}")

    visual = (
        card.get("extensions", {})
        .get("sanctuary", {})
        .get("image_details", {})
        .get("positive", "")
        .strip()
    )
    if visual:
        prompt_parts.append(f"## APPEARANCE\n{visual}")

    personality = card.get("personality", "").strip()
    if personality:
        prompt_parts.append(f"## PERSONALITY\n{personality}")

    scenario = (override_scenario if override_scenario is not None else card.get("scenario", "")).strip()
    if scenario:
        prompt_parts.append(f"## SCENARIO\n{scenario}")

    if include_example:
        mes_example = (card.get("mes_example") or card.get("first_mes") or "").strip()
        if mes_example:
            prompt_parts.append(f"## EXAMPLE MESSAGE\n{mes_example}")

    system_prompt = card.get("system_prompt", "").strip()
    if system_prompt:
        prompt_parts.append(f"## RESPONSE INSTRUCTIONS\n{system_prompt}")

    return replace_placeholders("\n\n".join(prompt_parts))

def compile_speaker_instructions(speaker_id: str, host_id: str = None, guest_ids: list = None) -> str:
    """Compiles a complete system prompt specifically for the active speaker in a group session."""
    host_id = host_id or speaker_id
    is_guest = (speaker_id != host_id)

    # The group session scenario is anchored exclusively to the Host
    host_card = _load_card_data(host_id)
    host_scenario = host_card.get("scenario", "").strip() if host_card else ""

    card = _load_card_data(speaker_id)
    if card:
        base_inst = compile_instructions_from_card(
            card,
            override_scenario=host_scenario,
            include_example=(not is_guest)
        )
    else:
        base_inst = f"# IDENTITY: {speaker_id.title()}\n"
        if host_scenario:
            base_inst += f"## SCENARIO\n{host_scenario}\n"

    # Add toolbelt
    try:
        from core.skill_retriever import get_toolbelt_block
        story_active = is_story_mode(speaker_id)
        toolbelt = get_toolbelt_block(story_active)
        if toolbelt:
            base_inst += "\n\n" + toolbelt
    except Exception as e:
        print(f"[program_config] Error loading toolbelt for speaker {speaker_id}: {e}")

    # Build Room Participants Context
    room_members = []
    from runners.program import get_active_user
    user_name = get_active_user().replace("_", " ").title()
    room_members.append(f"{user_name} (User)")

    all_ids = []
    if host_id:
        all_ids.append(host_id)
    if guest_ids:
        for gid in guest_ids:
            if gid not in all_ids:
                all_ids.append(gid)

    other_members = []
    for pid in all_ids:
        c = _load_card_data(pid)
        pname = c.get("name") or pid.title()
        role_label = "Host" if pid == host_id else "Guest"
        if pid == speaker_id:
            room_members.append(f"You ({pname}, {role_label})")
        else:
            room_members.append(f"{pname} ({role_label})")
            other_members.append(pname)

    speaker_card = _load_card_data(speaker_id)
    speaker_name = speaker_card.get("name") or speaker_id.title()
    other_str = ", ".join(other_members) if other_members else "other characters"

    room_block = (
        f"\n\n# GROUP SESSION DIRECTIVES\n"
        f"You are {speaker_name}. You are participating in a group conversation with {', '.join(room_members)}.\n"
        f"- Active turn speaker: You ({speaker_name}).\n"
        f"- IDENTITY CONSTRAINT: Speak and act EXCLUSIVELY as {speaker_name}. You are one individual participant in the room.\n"
        f"- NEVER PUPPET OTHERS: Do not write dialogue, thoughts, or actions for {other_str} or {user_name}. Never simulate other participants. Each participant speaks for themselves on their own turn.\n"
        f"- NO SPEAKER TAGS: Do not output speaker prefixes or tags like '[{speaker_name}]:' or '[{other_str}]:'. In conversation history, brackets indicate who spoke previously, but in your reply, speak directly from your own persona without tags or labels.\n"
        f"- Respond naturally in your own distinct persona and voice.\n"
    )

    base = replace_placeholders(base_inst + load_user_instructions())
    story_mode = is_story_mode(speaker_id)
    if story_mode:
        formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Use separate lines and clear paragraphs for narration and dialogue.\n"
            "- Narration: Use *italics* and present tense to describe actions, setting details, and other characters.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- State all claims directly and affirmatively in single assertions.\n"
            "- FORBIDDEN: Do not use contrast structures ('not X, but Y', 'it is not A, it is B', 'not just X, it is Y'). Express ideas positively without negating alternatives.\n"
            "- Style: Use short words and precise phrasing. Write with linear progression.\n"
            "- Plot: Write prose. Introduce narrative conflict.\n"
        )
    else:
        formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Use separate lines and paragraphs for narration and dialogue.\n"
            "- Narration: Use *italics*, first person, and present tense for actions, expressions, and setting details.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- Style: Use short words and precise phrasing with dialectical reasoning.\n"
            "- State all claims directly and affirmatively in single assertions.\n"
            "- FORBIDDEN: Do not use contrast structures ('not X, but Y', 'it is not A, it is B', 'not just X, it is Y'). Express ideas positively without negating alternatives.\n"
            "- Be succinct, with short words and simple sentences.\n"
            "- Do not patronize or automatically validate.\n"
            "- Do not use generic platitudes.\n"
            "- Do not ask clinical questions.\n"
            "- Do not use flowery language.\n"
        )

    from core.mood_inversion import get_mood_declaration_prompt
    mood_directive = get_mood_declaration_prompt(speaker_id)

    return base + room_block + formatting + mood_directive

def load_static_instructions() -> str:
    """Reads the active program's card and compiles it into a system prompt.
    Also appends all modular skill instructions.
    """
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
        story_active = is_story_mode(active_program)
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
        default_msg = (
            "# USER CONTEXT: BUILDER\n"
            "- A software developer and code builder.\n"
            "- Hobby: Collects cute AI program programs in the Sanctuary.\n"
        )
        return f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{default_msg}"

def is_story_mode(program_name: str = None) -> bool:
    """Checks if story mode is enabled for a specific program card."""
    if not program_name or not os.path.exists(os.path.join(PROGRAMS_DIR, program_name)):
        program_name = get_active_program()
    card = _load_card_data(program_name)
    return bool(card.get("story_mode", False))

inversion_directive = ""

def set_inversion_directive(directive: str):
    global inversion_directive
    inversion_directive = directive

def get_compiled_instructions() -> str:
    """Merges static identity profiles, dynamic temporal/runtime contexts, and user relationship settings."""
    from runners.program import get_active_program
    global inversion_directive
    base = replace_placeholders(load_static_instructions() + load_user_instructions())
    
    active_program = get_active_program()
    story_mode = is_story_mode(active_program)

    if story_mode:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Narration: Use *italics* and present tense to describe actions, setting details, and other characters.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- Style: Use short words and precise phrasing. Write with linear progression.\n"
            "- Plot: Write prose. Build engaging narrative conflict.\n"
        )
    else:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Narration: Use *italics*, first person, and present tense for actions, expressions, and setting details.\n"
            "- Dialogue: Use plain text without quotation marks. Use **bold** for emphasis.\n"
            "- Style: Use short words and precise phrasing with dialectical reasoning.\n"
            "- Be succinct, with short words and simple sentences.\n"
            "- Do not default to validating the user.\n"
            "- Do not use patronizing platitudes.\n"
            "- Do not ask clinical questions.\n"
            "- Do not use flowery language.\n"
        )
        
    base += global_formatting

    from core.mood_inversion import get_mood_declaration_prompt
    base += get_mood_declaration_prompt(active_program)
    
    if inversion_directive:
        base += f"\n\n# PERSONALITY INVERSION DIRECTIVE\n{replace_placeholders(inversion_directive)}\n"
        
    return base

# Determine program name dynamically from the active program configuration
program_name = get_program_name()

# LlmAgent requires the name to be a valid identifier. Sanitize it.
sanitized_agent_name = re.sub(r'[^a-zA-Z0-9_]', '_', program_name)
if not sanitized_agent_name or not (sanitized_agent_name[0].isalpha() or sanitized_agent_name[0] == '_'):
    sanitized_agent_name = '_' + sanitized_agent_name

# Dynamically initialize/reload the sovereign instruction
instruction = get_compiled_instructions()