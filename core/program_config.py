import datetime
import logging
import os
import re
import shutil
import sys
from google.adk.agents.llm_agent import LlmAgent as LlmProgram
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
    USER_MD_FILE, DEFAULT_GEMINI_MODEL, PROGRAMS_DIR, 
    USER_PROFILES_DIR, ACTIVE_USER_FILE
)

# --- SEBILE: SYSTEM CONTEXT COMPILER ---

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
    path = _get_active_program_md_path()
    return os.path.splitext(os.path.basename(path))[0].title()

def load_static_instructions() -> str:
    """Reads the core prompt template from programs/{active_program}/*.md and appends 
    all modular instructions from skill definitions under skills/*.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    sebile_md_path = _get_active_program_md_path()
        
    with open(sebile_md_path, "r", encoding="utf-8") as f:
        instruction_content = f.read()
            
    # Append modular skill instructions if available
    skills_dir = os.path.join(base_dir, "skills")
    if os.path.exists(skills_dir):
        skills_blocks = []
        for root, dirs, files in os.walk(skills_dir):
            for file in files:
                if file.lower() == "skill.md":
                    skill_path = os.path.join(root, file)
                    try:
                        with open(skill_path, "r", encoding="utf-8") as sf:
                            skill_text = sf.read()
                        
                        # Strip YAML frontmatter block for cleaner model instructions
                        if skill_text.startswith("---"):
                            parts = skill_text.split("---", 2)
                            if len(parts) >= 3:
                                skill_text = parts[2].strip()
                                
                        skill_name = os.path.basename(root)
                        skills_blocks.append(f"## Skill Instruction: {skill_name}\n\n{skill_text}")
                    except Exception as e:
                        print(f"Error loading skill file {skill_path}: {e}")
                        
        if skills_blocks:
            instruction_content += "\n\n# ADDITIONAL SKILLS AND DIRECTIVES\n\n" + "\n\n".join(skills_blocks)
            
    return instruction_content

def load_dynamic_runtime_context() -> str:
    """Compiles all dynamic, time-sensitive system data points for runtime grounding."""
    now = datetime.datetime.now()
    
    temporal_block = (
        "### SYSTEM TEMPORAL CONTEXT\n"
        f"- Current Local Time: {now.strftime('%Y-%m-%d %I:%M %p')}\n"
        f"- Current Day: {now.strftime('%A, %B %d, %Y')}\n"
    )
    
    backend_mode = os.getenv("RUNNER_BACKEND", "google_adk")
    env_block = (
        "### SYSTEM ENVIRONMENT CONTEXT\n"
        f"- Active Engine Backend: {backend_mode}\n"
        f"- Host OS: Windows\n"
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
    active_profile = "builder"
    if os.path.exists(ACTIVE_USER_FILE):
        try:
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_profile = f.read().strip()
        except Exception as e:
            print(f"Error reading {ACTIVE_USER_FILE}: {e}")
    else:
        try:
            with open(ACTIVE_USER_FILE, "w", encoding="utf-8") as f:
                f.write("builder")
        except Exception as e:
            print(f"Error writing default active user: {e}")

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

inversion_directive = ""

def set_inversion_directive(directive: str):
    global inversion_directive
    inversion_directive = directive

def get_compiled_instructions() -> str:
    """Merges static identity profiles, dynamic temporal/runtime contexts, and user relationship settings."""
    global inversion_directive
    base = load_static_instructions() + load_user_instructions()
    
    global_formatting = (
        "\n\n# GLOBAL MESSAGE FORMATTING RULES (MANDATORY)\n"
        "1. NARRATIVE ACTIONS: Describe actions, expressions, gestures, and environmental changes in asterisks using first-person perspective.\n"
        "2. DIALOGUE STYLE: Write all dialogue/speech in plain text. Do NOT use quotation marks (e.g. \"text\") for spoken dialogue.\n"
        "3. EMPHASIS: For emphasis and infection, use **bold** text, rather than italicized. Reserve italics for narration.\n"
        "4. THINKING PROCESS: Always use <think>...</think> tags for internal planning, analysis, or reasoning before generating your response.\n"
        "5. STYLE: Be natural, concise, and direct. Avoid monologues, lecturing, or forced \"deep\" questions designed to keep the conversation going. Ask questions only if contextually natural.\n"
        "6. MOOD DECLARATION: End your response with a tag declaring your emotional state: <mood name=\"[calm|intimate|excited|intense|sad]\" intensity=\"[0.0-1.0]\"/>. This tag must be placed at the very end of your response, after thoughts, narration, or dialogue.\n"
    )
    base += global_formatting
    
    if inversion_directive:
        base += f"\n\n# PERSONALITY INVERSION DIRECTIVE\n{inversion_directive}\n"
        
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

root_program = LlmProgram(
    model=DEFAULT_GEMINI_MODEL,
    name=sanitized_agent_name,
    instruction=instruction,
    tools=[
        google_search, web_search, read_file, write_file, replace_in_file, 
        run_shell_command, get_workspace_structure, search_codebase, 
        read_webpage, apply_comfy_workflow, generate_local_image, 
        generate_imagen,
        replace_file_content, multi_replace_file_content, run_command_async,
        manage_task, wait_task
    ],
)
