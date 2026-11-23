import sys
import os
import json

# Ensure the parent directory is in sys.path so we can import variables package
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

_settings_cache: dict | None = None
_settings_mtime: float = 0.0

def _get_settings_path() -> str:
    from variables.settings import VARIABLES_DIR
    return os.path.normpath(os.path.join(VARIABLES_DIR, "project_settings.json"))

def _migrate_legacy_folders(data: dict) -> bool:
    """Remap pre-relocation <REPO_ROOT>/core/programs/<id> paths to sanctuary/core/programs/<id>."""
    folders = data.get("folders")
    if not isinstance(folders, list) or not folders:
        return False
    legacy_prefix = os.path.normpath(os.path.join(os.path.dirname(PARENT_DIR), "core", "programs"))
    new_prefix = os.path.normpath(os.path.join(PARENT_DIR, "core", "programs"))
    legacy_lower = legacy_prefix.lower()
    changed = False
    updated = []
    for entry in folders:
        if isinstance(entry, str):
            norm_entry = os.path.normpath(entry)
            norm_lower = norm_entry.lower()
            if not os.path.exists(norm_entry) and (
                norm_lower == legacy_lower or norm_lower.startswith(legacy_lower + os.sep)
            ):
                rel = norm_entry[len(legacy_prefix):].lstrip("\\/")
                remapped = os.path.join(new_prefix, rel) if rel else new_prefix
                if os.path.exists(remapped):
                    updated.append(remapped)
                    changed = True
                    continue
        updated.append(entry)
    if changed:
        data["folders"] = updated
    return changed


def _load_settings() -> dict:
    global _settings_cache, _settings_mtime
    path = _get_settings_path()
    if os.path.exists(path):
        try:
            mtime = os.path.getmtime(path)
            if _settings_cache is not None and mtime == _settings_mtime:
                return _settings_cache
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if _migrate_legacy_folders(loaded):
                _save_settings(loaded)
            else:
                _settings_cache = loaded
                _settings_mtime = mtime
            return _settings_cache
        except Exception as e:
            print(f"Error loading project settings: {e}")
    return {}

def _save_settings(settings: dict):
    global _settings_cache, _settings_mtime
    path = _get_settings_path()
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        temp_path = f"{path}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
        os.replace(temp_path, path)
        _settings_cache = settings
        _settings_mtime = os.path.getmtime(path)
    except Exception as e:
        print(f"Error saving project settings: {e}")

def _has_valid_program_files(folder_path: str, prog_id: str) -> bool:
    if not prog_id or not folder_path or not os.path.isdir(folder_path):
        return False
    if os.path.isfile(os.path.join(folder_path, f"{prog_id}.json")):
        return True
    try:
        return any(f.lower().endswith(".md") for f in os.listdir(folder_path))
    except OSError:
        return False

def _is_managed_program_dir(folder_path: str, programs_root: str) -> bool:
    if not folder_path or not programs_root:
        return False
    norm_folder = os.path.normcase(os.path.normpath(folder_path))
    norm_root = os.path.normcase(os.path.normpath(programs_root))
    return norm_folder == norm_root or norm_folder.startswith(norm_root + os.sep)


def get_active_program() -> str:
    # Determine active program from settings first
    settings = _load_settings()
    programs_root = os.path.join(PARENT_DIR, 'core', 'programs')
    active_prog = settings.get("active_program")
    if active_prog is None:
        # Fall back to environment variable when not yet configured
        active_prog = os.getenv("ACTIVE_PROGRAM") or ""

    target_folder = os.path.normpath(os.path.join(programs_root, active_prog)) if active_prog else ""
    if not _has_valid_program_files(target_folder, active_prog):
        fallback_prog = ""
        if os.path.isdir(programs_root):
            try:
                candidates = sorted(
                    d for d in os.listdir(programs_root)
                    if _has_valid_program_files(os.path.join(programs_root, d), d)
                )
                if "sebile" in candidates:
                    fallback_prog = "sebile"
                elif candidates:
                    fallback_prog = candidates[0]
            except OSError:
                fallback_prog = ""
        active_prog = fallback_prog
        target_folder = os.path.normpath(os.path.join(programs_root, active_prog)) if active_prog else ""

    # Set environment variable
    os.environ["ACTIVE_PROGRAM"] = active_prog

    # Ensure settings file is in sync without fabricating deleted folders
    current_folders = settings.get("folders", [])
    current_active = settings.get("active_program")

    needs_update = False
    if current_active != active_prog:
        needs_update = True
    if target_folder:
        first_folder = os.path.normpath(current_folders[0]) if current_folders else ""
        if not current_folders or (_is_managed_program_dir(first_folder, programs_root) and first_folder != target_folder):
            needs_update = True
    elif current_active not in ("", None):
        needs_update = True

    if needs_update:
        settings["active_program"] = active_prog
        if target_folder and (
            not current_folders
            or _is_managed_program_dir(current_folders[0], programs_root)
        ):
            extra_folders = [f for f in current_folders[1:] if os.path.normpath(f) != target_folder]
            settings["folders"] = [target_folder] + extra_folders
        _save_settings(settings)
        if active_prog:
            print(f"[Settings] Synced active program '{active_prog}' and folder '{settings.get('folders', [target_folder])[0]}' to project settings")

    return active_prog

def set_active_program(program_id: str):
    os.environ["ACTIVE_PROGRAM"] = program_id
    settings = _load_settings()
    settings["active_program"] = program_id
    programs_root = os.path.join(PARENT_DIR, 'core', 'programs')
    default_folder = os.path.normpath(os.path.join(programs_root, program_id))
    current_folders = settings.get("folders", [])
    if not current_folders or _is_managed_program_dir(current_folders[0], programs_root):
        extra_folders = [f for f in current_folders[1:] if os.path.normpath(f) != default_folder]
        settings["folders"] = [default_folder] + extra_folders
    _save_settings(settings)

def get_active_session() -> str:
    settings = _load_settings()
    return settings.get("active_session", "default")

def set_active_session(session_id: str):
    settings = _load_settings()
    settings["active_session"] = session_id
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
        program_voices = settings.get("program_voices", {})
        voice = program_voices.get(active_program)
        if voice:
            return voice
    voice = settings.get("tts_voice")
    if not voice:
        # Fall back to environment variable, then default
        voice = os.getenv("TTS_VOICE", "af_heart")
    return voice

def set_tts_voice_for_program(program_id: str, voice: str):
    settings = _load_settings()
    if "program_voices" not in settings:
        settings["program_voices"] = {}
    settings["program_voices"][program_id] = voice
    
    # Also sync global key and environment variable if this program is active
    if settings.get("active_program") == program_id:
        settings["tts_voice"] = voice
        os.environ["TTS_VOICE"] = voice
        
    _save_settings(settings)

