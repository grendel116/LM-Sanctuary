import sys
import os
import json

# Ensure the parent directory is in sys.path so we can import variables package
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

def _get_settings_path() -> str:
    from variables import VARIABLES_DIR
    return os.path.normpath(os.path.join(VARIABLES_DIR, "project_settings.json"))

def _load_settings() -> dict:
    path = _get_settings_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading project settings: {e}")
    return {}

def _save_settings(settings: dict):
    path = _get_settings_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving project settings: {e}")

def get_active_program() -> str:
    # Determine active program from settings first
    settings = _load_settings()
    active_prog = settings.get("active_program")
    if not active_prog:
        # Fall back to environment variable, then to default
        active_prog = os.getenv("ACTIVE_PROGRAM")
        if not active_prog:
            active_prog = "sebile"

    # Set environment variable
    os.environ["ACTIVE_PROGRAM"] = active_prog

    # Ensure settings file is in sync
    target_folder = os.path.normpath(os.path.join(PARENT_DIR, 'core', 'programs', active_prog))

    current_folders = settings.get("folders", [])
    current_active = settings.get("active_program")

    needs_update = False
    if current_active != active_prog:
        needs_update = True
    if not current_folders or os.path.normpath(current_folders[0]) != target_folder:
        needs_update = True

    if needs_update:
        settings["active_program"] = active_prog
        settings["folders"] = [target_folder]
        _save_settings(settings)
        print(f"[Settings] Synced active program '{active_prog}' and folder '{target_folder}' to project settings")

    return active_prog

def set_active_program(program_id: str):
    os.environ["ACTIVE_PROGRAM"] = program_id
    settings = _load_settings()
    settings["active_program"] = program_id
    default_folder = os.path.normpath(os.path.join(PARENT_DIR, 'core', 'programs', program_id))
    settings["folders"] = [default_folder]
    _save_settings(settings)

def get_active_user() -> str:
    # Determine active user from settings first
    settings = _load_settings()
    active_usr = settings.get("active_user")
    if not active_usr:
        # Fall back to environment variable, then to default
        active_usr = os.getenv("ACTIVE_USER")
        if not active_usr:
            active_usr = "builder"

    # Set environment variable
    os.environ["ACTIVE_USER"] = active_usr

    # Ensure settings file is in sync
    current_active = settings.get("active_user")

    if current_active != active_usr:
        settings["active_user"] = active_usr
        _save_settings(settings)
        print(f"[Settings] Synced active user '{active_usr}' to project settings")

    return active_usr

def set_active_user(username: str):
    os.environ["ACTIVE_USER"] = username
    settings = _load_settings()
    settings["active_user"] = username
    _save_settings(settings)

def get_tts_voice() -> str:
    settings = _load_settings()
    active_program = settings.get("active_program")
    if active_program:
        companion_voices = settings.get("companion_voices", {})
        voice = companion_voices.get(active_program)
        if voice:
            return voice
    voice = settings.get("tts_voice")
    if not voice:
        # Fall back to environment variable, then default
        voice = os.getenv("TTS_VOICE", "af_heart")
    return voice

def set_tts_voice(voice: str):
    os.environ["TTS_VOICE"] = voice
    settings = _load_settings()
    settings["tts_voice"] = voice
    _save_settings(settings)

def set_tts_voice_for_program(program_id: str, voice: str):
    settings = _load_settings()
    if "companion_voices" not in settings:
        settings["companion_voices"] = {}
    settings["companion_voices"][program_id] = voice
    
    # Also sync global key and environment variable if this program is active
    if settings.get("active_program") == program_id:
        settings["tts_voice"] = voice
        os.environ["TTS_VOICE"] = voice
        
    _save_settings(settings)

