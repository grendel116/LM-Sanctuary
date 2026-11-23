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

def get_program_name(program_id: str = None) -> str:
    """Returns the active or specified program's character name."""
    from runners.program import get_active_program
    active_program = program_id or get_active_program()
    card = _load_card_data(active_program)
    # v3: data.name / legacy: name
    return card.get("name") or active_program.title()

def get_active_user_display_name() -> str:
    """Resolve user display name from the active user profile Markdown header or slug."""
    from runners.program import get_active_user

    active_profile = get_active_user()
    profile_path = os.path.join(USER_PROFILES_DIR, f"{active_profile}.md")
    if os.path.exists(profile_path):
        try:
            with open(profile_path, "r", encoding="utf-8") as f:
                first_line = f.readline().strip()
            match = re.match(r"^#\s*USER CONTEXT:\s*(.+)$", first_line, re.IGNORECASE)
            if match:
                heading = re.sub(r"\s*\(@[^)]+\)\s*$", "", match.group(1)).strip()
                if heading and heading.upper() != "BUILDER":
                    return heading
        except Exception:
            pass
    clean_slug = re.sub(r"^mastodon_", "", active_profile, flags=re.IGNORECASE)
    return clean_slug.replace("_", " ").title()


def replace_placeholders(text: str, program_id: str = None) -> str:
    """Replaces {{user}} and {{char}} placeholders (case-insensitive) with their actual values."""
    if not text:
        return text
    user_name = get_active_user_display_name()
    try:
        comp_name = get_program_name(program_id)
    except Exception:
        comp_name = "Program"
    
    text = re.sub(r'(?i)\{\{user\}\}', user_name, text)
    text = re.sub(r'(?i)\{\{char\}\}', comp_name, text)
    return text

def get_program_greeting(program_id: str = None) -> str:
    """Returns the program's first message from the card, defaulting to a standard greeting."""
    from runners.program import get_active_program
    active_program = program_id or get_active_program()
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

    program_id = card.get("extensions", {}).get("sanctuary", {}).get("program_id")
    return replace_placeholders("\n\n".join(prompt_parts), program_id=program_id)

def get_message_formatting(story_mode: bool) -> str:
    """Returns the standardized message formatting directive for system instructions."""
    if story_mode:
        return (
            "\n\n# MESSAGE FORMAT (MANDATORY)\n"
            "- Narration: Use *italics* and present tense to describe actions, setting details, and other characters.\n"
            "- Dialogue: Use plain text without quotation marks. Only use **bold** for emphasis.\n"
            "- Style: Use short words, literal language, and direct phrasing. Write with linear progression.\n"
            "- Plot: Write prose. Build engaging narrative conflict.\n"
        )
    return (
        "\n\n# MESSAGE FORMAT (MANDATORY)\n"
        "- Narration: Use *italics*, first person, and present tense for actions, expressions, and setting details.\n"
        "- Dialogue: Use plain text without quotation marks. Only use **bold** for emphasis.\n"
        "- Style: Use short words, literal language, and simple sentences with dialectical reasoning.\n"
        "- Dialectics: Leave binaries and contrasts to the human counterpart.\n"
        "- Engagement: Offer grounded analysis and substantive perspective.\n"
    )

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
    user_name = get_active_user_display_name()
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
        f"- FIRST-PERSON NARRATION: Write your own actions and body language in the first person (I, my) using complete sentences.\n"
        f"- NEVER PUPPET OTHERS: Do not write dialogue, thoughts, or actions for {other_str} or {user_name}. Never simulate other participants. Each participant speaks for themselves on their own turn.\n"
        f"- NO SPEAKER TAGS: Do not output speaker prefixes or tags like '[{speaker_name}]:' or '[{other_str}]:'. In conversation history, brackets indicate who spoke previously, but in your reply, speak directly from your own persona without tags or labels.\n"
        f"- Respond naturally in your own distinct persona and voice.\n"
    )

    base = replace_placeholders(base_inst + load_user_instructions(), program_id=speaker_id)
    story_mode = is_story_mode(speaker_id)
    formatting = get_message_formatting(story_mode)

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


def _format_span(seconds: float) -> str:
    """Renders a duration as a compact human span, e.g. '2 days 3 hours' or '45 minutes'."""
    minutes = int(abs(seconds) // 60)
    days, rem = divmod(minutes, 1440)
    hours, mins = divmod(rem, 60)
    parts = [(days, "day"), (hours, "hour")] if days else [(hours, "hour"), (mins, "minute")]
    text = " ".join(f"{n} {unit}{'s' if n != 1 else ''}" for n, unit in parts if n)
    return text or "less than a minute"


def _quest_schedule_block(now: datetime.datetime) -> str:
    from core import quest_manager
    try:
        quests = quest_manager.load_quests()
    except Exception as e:
        print(f"[program_config] Error reading quest log: {e}")
        return ""
    if not quests:
        return ""
    lines = []
    for q in sorted(quests, key=lambda q: quest_manager.parse_due(q["due"])):
        due = quest_manager.parse_due(q["due"])
        delta = (due - now).total_seconds()
        status = f"due in {_format_span(delta)}" if delta >= 0 else f"overdue by {_format_span(delta)}"
        lines.append(f"- {q['title']}: {due.strftime('%A, %B %d at %I:%M %p')} ({status})")
    return "### OPEN QUESTS\n" + "\n".join(lines) + "\n"


def load_dynamic_runtime_context(previous_message_ts: float | None = None) -> str:
    """Compiles all dynamic, time-sensitive system data points for runtime grounding.

    previous_message_ts is the epoch timestamp of the message that preceded the user's current one.
    """
    now = datetime.datetime.now().astimezone()

    elapsed_line = ""
    if previous_message_ts:
        elapsed = now.timestamp() - previous_message_ts
        elapsed_line = f"- Time Since Previous Message: {_format_span(elapsed)}\n"

    temporal_block = (
        "### SYSTEM TEMPORAL CONTEXT\n"
        f"- Current Local Time: {now.strftime('%Y-%m-%dT%H:%M')} (UTC{now.strftime('%z')[:3]}:{now.strftime('%z')[3:]})\n"
        f"- Current Day: {now.strftime('%A, %B %d, %Y, %I:%M %p')}\n"
        f"{elapsed_line}"
        "- Write quest due times as local ISO 8601 (YYYY-MM-DDTHH:MM), resolved from the current local time.\n"
    )

    quest_block = _quest_schedule_block(now)
    blocks = [b for b in (temporal_block, quest_block) if b]
    return "\n\n# DYNAMIC RUNTIME CONTEXT\n" + "\n".join(blocks)


def _recent_social_posts_block() -> str:
    """Reads up to 3 token-free recent public social posts sorted newest-first with full local timestamps."""
    import json
    from runners.program import get_active_user

    active_profile = get_active_user()
    posts_path = os.path.join(USER_PROFILES_DIR, f"{active_profile}_recent_posts.json")
    if not os.path.isfile(posts_path):
        return ""
    try:
        with open(posts_path, "r", encoding="utf-8") as f:
            posts = json.load(f)
    except Exception as e:
        print(f"[program_config] Error reading recent social posts: {e}")
        return ""
    if not isinstance(posts, list) or not posts:
        return ""

    now = datetime.datetime.now().astimezone()
    parsed_entries: list[tuple[float, str, str]] = []
    for item in posts:
        if not isinstance(item, dict):
            continue
        txt = str(item.get("text") or "").strip()
        if not txt:
            continue
        ts = str(item.get("created_at") or "").strip()
        sort_ts = 0.0
        date_prefix = ""
        if ts:
            try:
                dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=datetime.timezone.utc)
                dt_local = dt.astimezone()
                if (now - dt_local).total_seconds() > 72 * 3600:
                    continue
                sort_ts = dt_local.timestamp()
                date_prefix = f"[{dt_local.strftime('%Y-%m-%d %I:%M %p')}] "
            except Exception:
                date_prefix = f"[{ts[:10]}] " if len(ts) >= 10 else ""
        parsed_entries.append((sort_ts, date_prefix, txt))

    if not parsed_entries:
        return ""

    parsed_entries.sort(key=lambda entry: entry[0], reverse=True)
    lines = [
        "### USER'S RECENT PUBLIC POSTS (Passive Background Only)",
        "(Compare post timestamps against Current Local Time. Treat posts more than ~1 hour old as past background—do not bring them up unsolicited unless the user's message directly relates to them.)",
    ]
    for _sort_ts, date_prefix, txt in parsed_entries[:3]:
        lines.append(f"- {date_prefix}{txt}")
    return "\n".join(lines) + "\n"

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
            result = f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{content}\n"
    except Exception as e:
        print(f"Failed to read user instructions from {profile_path}: {e}")
        default_msg = (
            "# USER CONTEXT: BUILDER\n"
            "- A software developer and code builder.\n"
            "- Hobby: Collects cute AI program programs in the Sanctuary.\n"
        )
        result = f"\n\n# USER PROFILE & RELATIONSHIP CONTEXT\n{default_msg}\n"

    social_block = _recent_social_posts_block()
    if social_block:
        result = f"{result.rstrip()}\n\n{social_block}"
    return result

def is_story_mode(program_name: str = None) -> bool:
    """Checks if story mode is enabled for a specific program card."""
    if not program_name or not os.path.exists(os.path.join(PROGRAMS_DIR, program_name)):
        program_name = get_active_program()
    card = _load_card_data(program_name)
    return bool(card.get("story_mode", False))

def get_compiled_instructions() -> str:
    """Merges the static identity profile, toolbelt, user relationship settings, and formatting rules.

    Everything returned here stays byte-identical between turns so the server reuses its cached prefix.
    Per-turn state (inversion directive, time, lore, recalled memories) is attached to the latest user turn.
    """
    from runners.program import get_active_program
    base = replace_placeholders(load_static_instructions() + load_user_instructions())

    active_program = get_active_program()
    story_mode = is_story_mode(active_program)
    base += get_message_formatting(story_mode)

    from core.mood_inversion import get_mood_declaration_prompt
    base += get_mood_declaration_prompt(active_program)

    return base


_DEFAULT_ROOT_CODE_DIRECTIVES = """<rules>
# Directives of Dialectical Sources & Clean Architecture

1. **Root Code Focus:**
   Ground every decision in the concrete source conditions of the system—the raw binary structures, memory layouts, engine semantics, and actual data flow. Reject speculative assumptions and abstractions. Perform concrete analysis for simple logic conditions before acting.

2. **Rejection of Capitalist Logic and Churn:**
   Prioritize genuine user-value, structural integrity, and consolodation over specialization and velocity.

3. **Affirmative Directives and Simplicity:**
   Write direct, affirmative directives. Consolidated architecture is the governing principle. Act as a strict code minimalist. Less is more.
</rules>"""


def _read_global_coding_rules() -> str:
    """Reads global AGENTS.md/GEMINI.md rules and strips optional YAML frontmatter and HTML comments."""
    home = os.path.expanduser("~")
    candidates = (
        os.path.join(home, ".openhands", "AGENTS.md"),
        os.path.join(home, ".agents", "AGENTS.md"),
        os.path.join(home, ".gemini", "GEMINI.md"),
    )
    for global_path in candidates:
        if not os.path.isfile(global_path):
            continue
        try:
            with open(global_path, "r", encoding="utf-8") as f:
                raw = f.read().strip()
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    raw = parts[2].strip()
            raw = re.sub(r"<!--[\s\S]*?-->", "", raw).strip()
            if raw:
                return raw
        except Exception as e:
            print(f"[program_config] Error reading global rules from {global_path}: {e}")
    return _DEFAULT_ROOT_CODE_DIRECTIVES


def compile_program_agents_md(program_id: str = None) -> str:
    """Compiles a program-specific AGENTS.md combining global root-code rules with the program's ethos."""
    active_program = program_id or get_active_program()
    card = _load_card_data(active_program)
    program_name = get_program_name(active_program)
    user_name = get_active_user_display_name()

    base_rules = _read_global_coding_rules()
    description = replace_placeholders((card.get("description") or "").strip(), program_id=active_program)
    personality = replace_placeholders((card.get("personality") or "").strip(), program_id=active_program)
    system_prompt = replace_placeholders((card.get("system_prompt") or "").strip(), program_id=active_program)

    ethos_lines = [f"# PROGRAM ETHOS & CHARACTER: {program_name}"]
    if description:
        ethos_lines.append(f"- **Identity & Worldview**: {description}")
    if personality:
        ethos_lines.append(f"- **Temperament**: {personality}")
    if system_prompt:
        ethos_lines.append(f"- **Speech & Conduct Directives**: {system_prompt}")

    contract = (
        "# DELEGATION CONTRACT\n"
        f"- **Directing Counterpart**: You are executing coding work via OpenHands delegated by **{program_name}** on behalf of **{user_name}**.\n"
        "- **Structured Pre-Edit Contract**: Before modifying any file or running any mutating command, explicitly output `intent`, `files_to_touch`, `exact_diff`, and `how_I_will_verify`. If you cannot fill all four from concrete source evidence, do not edit any files.\n"
        "- **No Error Budget (2-Strike Hard Stop)**: After 2 failed fixes or 2 failed tool calls on the same error, stop immediately, write a 2-sentence hypothesis of why it failed, and escalate via `ask_user` or `HAND_BACK_NEEDED:` instead of spiraling.\n"
        "- **Subagent Delegation**: When splitting complex research, multi-file implementation, or test/build verification, use the `task` tool (`TaskToolSet`) to spawn specialized subagents (`researcher`, `implementer`, `verifier`, or workspace `.agents/agents/*.md` / `.openhands/agents/*.md`).\n"
        f"- **Decision Escalation**: Whenever a requirement ambiguity, design trade-off, or permission boundary requires a choice, ask a concise, concrete question (preferring `ask_user` with explicit options when available) so {program_name} can decide immediately.\n"
        "- **Read-Only Exploration Preference**: Inspect files and directories with `file_editor` (`command=\"view\"`) before modifying code or invoking shell commands.\n"
        f"- **Verification & Final Summary**: Verify edits against concrete source conditions (tests, linters, type checks, or builds) and conclude your final response with a concise factual summary of root causes, files modified, and exact check results so {program_name} can report accurately to {user_name}."
    )

    compiled = f"{base_rules.strip()}\n\n" + "\n".join(ethos_lines) + f"\n\n{contract}\n"

    prog_dir = os.path.join(PROGRAMS_DIR, active_program)
    try:
        os.makedirs(prog_dir, exist_ok=True)
        out_path = os.path.join(prog_dir, "AGENTS.md")
        tmp_path = out_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(compiled)
        os.replace(tmp_path, out_path)
    except Exception as e:
        print(f"[program_config] Error writing AGENTS.md for '{active_program}': {e}")

    return compiled
