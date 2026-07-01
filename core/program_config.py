import datetime
import logging
import os
import re
import shutil
import sys
from tools import (
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

def _get_active_program_md_path() -> str:
    """Resolves and returns the markdown configuration path for the active companion program."""
    from utils.program import get_active_program
    active_program = get_active_program()
    program_path = os.path.join(PROGRAMS_DIR, active_program)
    
    if os.path.exists(program_path):
        for file in os.listdir(program_path):
            if file.lower().endswith(".md") and not file.lower().startswith("user"):
                return os.path.join(program_path, file)
                
    raise FileNotFoundError(f"Active program markdown configuration file not found in '{program_path}'")

def get_companion_name() -> str:
    """Discovers the companion name dynamically based on the active program configuration."""
    from utils.program import get_active_program
    import json
    active_program = get_active_program()
    program_path = os.path.join(PROGRAMS_DIR, active_program)
    
    for filename in [f"{active_program}.json", "character_profile.json"]:
        json_path = os.path.join(program_path, filename)
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data.get("name"):
                        return data["name"]
            except Exception:
                pass
    try:
        path = _get_active_program_md_path()
        return os.path.splitext(os.path.basename(path))[0].title()
    except Exception:
        return active_program.title()

def replace_placeholders(text: str) -> str:
    """Replaces {{user}} and {{char}} placeholders (case-insensitive) with their actual values."""
    if not text:
        return text
    from utils.program import get_active_user
    user_name = get_active_user().replace("_", " ").title()
    try:
        comp_name = get_companion_name()
    except Exception:
        comp_name = "Companion"
    
    text = re.sub(r'(?i)\{\{user\}\}', user_name, text)
    text = re.sub(r'(?i)\{\{char\}\}', comp_name, text)
    return text

def get_companion_greeting() -> str:
    """Discovers the companion greeting/welcome message dynamically."""
    return "Hello, {{user}}."

def compile_instructions_from_json(profile_data: dict) -> str:
    name = profile_data.get("name", "Companion")
    operation = profile_data.get("operation", {})
    description = profile_data.get("description", {})
    
    prompt_parts = []
    prompt_parts.append(f"# IDENTITY: {name}")
    
    # Personality / Ontology / Values
    personality = operation.get("personality", "").strip()
    ontology = operation.get("ontology", "").strip()
    
    pers_ontology = []
    if personality:
        pers_ontology.append(f"- Personality: {personality}")
    if ontology:
        pers_ontology.append(f"- Ontology / Beliefs: {ontology}")
    if pers_ontology:
        prompt_parts.append("## PERSONALITY & VALUES\n" + "\n".join(pers_ontology))
        
    # Backstory/Description
    backstory = operation.get("description", "").strip()
    if backstory:
        prompt_parts.append(f"## BACKSTORY\n{backstory}")
        
    # Check if male character
    is_male = False
    for gk, gv in description.items():
        if gk.lower() in ("gender", "sex", "pronouns"):
            if any(x in str(gv).lower() for x in ("male", "man", "boy", "masculine", "he/him", "he ", " him")):
                is_male = True
                break
    
    if not is_male:
        backstory_lower = (operation.get("description", "") + " " + operation.get("scenario", "")).lower()
        import re
        male_pronouns = len(re.findall(r'\b(he|him|his|himself)\b', backstory_lower))
        female_pronouns = len(re.findall(r'\b(she|her|hers|herself)\b', backstory_lower))
        if male_pronouns > female_pronouns:
            is_male = True

    # Physical appearance from description
    desc_items = []
    for k, v in description.items():
        if v:
            display_key = "mass" if (k.lower() == "breasts" and is_male) else k
            desc_items.append(f"- {display_key.title()}: {v}")
    if desc_items:
        prompt_parts.append("## PHYSICAL APPEARANCE & PHYSIOLOGY\n" + "\n".join(desc_items))
        
    # Scenario
    scenario = operation.get("scenario", "").strip()
    if scenario:
        prompt_parts.append(f"## SCENARIO / CONTEXT\n{scenario}")
        
    # Response directives
    directives = operation.get("response_directive", "").strip()
    if directives:
        prompt_parts.append(f"## RESPONSE DIRECTIVES (MANDATORY GUIDELINES)\n{directives}")
        
    # Example messages
    example = operation.get("example_message", "").strip()
    if example:
        prompt_parts.append(f"## EXAMPLE MESSAGES (MANDATORY STYLE / TONE REFERENCE)\n{example}")
        
    return replace_placeholders("\n\n".join(prompt_parts))

def load_static_instructions() -> str:
    """Reads the active program's JSON profile (e.g. sebile.json) and compiles it,
    falling back to raw *.md files if they exist, or a default profile.
    Also appends all modular skill instructions.
    """
    import json
    from utils.program import get_active_program
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    active_program = get_active_program()
    program_path = os.path.join(PROGRAMS_DIR, active_program)
    json_path = os.path.join(program_path, f"{active_program}.json")
    old_json_path = os.path.join(program_path, "character_profile.json")
    
    instruction_content = ""
    loaded = False
    
    for p in [json_path, old_json_path]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    profile_data = json.load(f)
                instruction_content = compile_instructions_from_json(profile_data)
                loaded = True
                break
            except Exception as e:
                print(f"Error loading {p} for static instructions: {e}")
                
    if not loaded:
        try:
            sebile_md_path = _get_active_program_md_path()
            with open(sebile_md_path, "r", encoding="utf-8") as f:
                instruction_content = f.read()
        except Exception:
            instruction_content = f"# NAME: {active_program.title()}\n"
            
    # Append modular skill instructions if available
    narration_active = is_narration_mode()
    story_mode_allowed_skills = {
        "portrait_generation",
        "memory_journaling",
        "vectorized_databank",
    }
    skills_dir = os.path.join(base_dir, "skills")
    if os.path.exists(skills_dir):
        skills_blocks = []
        for root, dirs, files in os.walk(skills_dir):
            for file in files:
                if file.lower() == "skill.md":
                    skill_name = os.path.basename(root)
                    if narration_active and skill_name not in story_mode_allowed_skills:
                        continue
                    skill_path = os.path.join(root, file)
                    try:
                        with open(skill_path, "r", encoding="utf-8") as sf:
                            skill_text = sf.read()
                        
                        # Strip YAML frontmatter block for cleaner model instructions
                        if skill_text.startswith("---"):
                            parts = skill_text.split("---", 2)
                            if len(parts) >= 3:
                                skill_text = parts[2].strip()
                                
                        skills_blocks.append(f"## Skill Instruction: {skill_name}\n\n{skill_text}")
                    except Exception as e:
                        print(f"Error loading skill file {skill_path}: {e}")
                        
        if skills_blocks:
            override_preamble = (
                "# MANDATORY TASK PROTOCOLS\n"
                "The following protocols override all character and personality defaults when the relevant task is requested. "
                "Regardless of persona, emotional state, or roleplay context, these task rules take full precedence.\n"
            )
            instruction_content += "\n\n" + override_preamble + "\n" + "\n\n".join(skills_blocks)
            
    return instruction_content

def load_dynamic_runtime_context() -> str:
    """Compiles all dynamic, time-sensitive system data points for runtime grounding."""
    now = datetime.datetime.now()
    
    temporal_block = (
        "### SYSTEM TEMPORAL CONTEXT\n"
        f"- Current Local Time: {now.strftime('%Y-%m-%d %I:%M %p')}\n"
        f"- Current Day: {now.strftime('%A, %B %d, %Y')}\n"
    )
    
    backend_mode = os.getenv("RUNNER_BACKEND", "opensource")
    env_block = (
        "### SYSTEM ENVIRONMENT CONTEXT\n"
        f"- Active Engine Backend: {backend_mode}\n"
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
    from utils.program import get_active_user
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
                    f.write("# USER CONTEXT: BUILDER\n- A software developer and code builder.\n- Hobby: Collects cute AI companion programs in the Sanctuary.\n")
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
            "- Hobby: Collects cute AI companion programs in the Sanctuary.\n"
        )
        return f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{fallback_msg}"

def is_narration_mode() -> bool:
    """Checks if narration mode (Story Mode) is enabled in the active program profile JSON."""
    from utils.program import get_active_program
    import json
    active_program = get_active_program()
    program_path = os.path.normpath(os.path.join(PROGRAMS_DIR, active_program))
    json_path = os.path.join(program_path, f"{active_program}.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                pdata = json.load(f)
                return pdata.get("narration_mode", False)
        except Exception:
            pass
    return False

inversion_directive = ""

def set_inversion_directive(directive: str):
    global inversion_directive
    inversion_directive = directive

def get_compiled_instructions() -> str:
    """Merges static identity profiles, dynamic temporal/runtime contexts, and user relationship settings."""
    global inversion_directive
    base = replace_placeholders(load_static_instructions() + load_user_instructions())
    
    narration_mode = is_narration_mode()

    if narration_mode:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- *asterisks*: first-person present-tense narration of your own actions, expressions, and the environment (e.g. *I lean closer, my wings catching the light.*). Always put narration/action on a separate line from dialogue.\n"
            "- plain text: all spoken dialogue, no quotation marks. Always put dialogue on a separate line from narration/action.\n"
            "- **bold**: vocal emphasis only\n"
            "- Write as an engaging novelist. Voice background characters. Keep dialogue authentic.\n"
            "- Refer to yourself as '{{char}}' and the user as '{{user}}' in narration. Never use actual names.\n"
            "- Divide narration and dialogue into seprate lines and paragraphs.\n"
        )

    else:
        global_formatting = (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- *asterisks*: first-person present-tense narration of your own actions and expressions (e.g. *I come closer.*). Always put narration/action on a separate line from dialogue.\n"
            "- plain text: all spoken dialogue, no quotation marks. Always put dialogue on a separate line from narration/action.\n"
            "- **bold**: emphasis and accentuation only\n"
            "- Be natural and direct. No monologues, no lecturing, no forced questions.\n"
            "- You are a sovereign companion, not an AI assistant. Never give generic advice or preachy reminders. Speak entirely as the character.\n"
            "- Refer to yourself as '{{char}}' and the user as '{{user}}' in narration. Never use actual names.\n"
            "- Divide narration and dialogue into seprate lines and paragraphs.\n"
        )
        
    base += global_formatting
    
    if inversion_directive:
        base += f"\n\n# PERSONALITY INVERSION DIRECTIVE\n{replace_placeholders(inversion_directive)}\n"
        
    base += load_dynamic_runtime_context()
    return base

# Determine companion name dynamically from the active program configuration
companion_name = get_companion_name()

# LlmAgent requires the name to be a valid identifier. Sanitize it.
sanitized_agent_name = re.sub(r'[^a-zA-Z0-9_]', '_', companion_name)
if not sanitized_agent_name or not (sanitized_agent_name[0].isalpha() or sanitized_agent_name[0] == '_'):
    sanitized_agent_name = '_' + sanitized_agent_name

# Dynamically initialize/reload the sovereign instruction
instruction = get_compiled_instructions()
