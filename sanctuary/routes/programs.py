import asyncio
import colorsys
import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from contextlib import nullcontext
from pathlib import Path

from flask import Blueprint, Response, jsonify, make_response, request, send_file, send_from_directory

import state as st
import variables.settings as vs
from runners.runner import cancelled_sessions, voice_call_sessions
from runners.program import (
    get_active_program,
    get_active_session,
    get_active_user,
    set_active_program,
    set_active_session,
)

programs_bp = Blueprint("programs_bp", __name__)


def _clean_session_snippet(raw_text: str, max_len: int = 120) -> str:
    text = str(raw_text or '')
    if not text:
        return ''
    text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '[Image]', text)
    text = ' '.join(text.split())
    if len(text) > max_len:
        return text[: max_len - 1].rstrip() + '…'
    return text


def _derive_session_entry(
    program_id: str,
    session_id: str,
    program_name: str,
    default_first_mes: str = '',
) -> dict:
    safe_id = ''.join(c for c in str(session_id or 'default') if c.isalnum() or c in '-_') or 'default'
    sessions_dir = os.path.join(st.base_dir, 'core', 'programs', program_id, 'sessions')
    fpath = os.path.join(sessions_dir, f'{safe_id}.json')

    messages = []
    memory_state = {}
    group_meta = None
    mtime = 0.0
    if os.path.exists(fpath):
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            mtime = 0.0

    loaded_from_mem = False
    if program_id == get_active_program() and getattr(st, 'runner', None) is not None:
        with st.runner._lock:
            if session_id in getattr(st.runner, 'sessions_history', {}):
                loaded_from_mem = True
                messages = list(st.runner.sessions_history.get(session_id) or [])
                memory_state = dict(st.runner.sessions_memory_state.get(session_id) or {})
                gm = getattr(st.runner, 'sessions_group_meta', {}).get(session_id)
                group_meta = dict(gm) if isinstance(gm, dict) else None

    if not loaded_from_mem and os.path.exists(fpath):
        try:
            with open(fpath, 'r', encoding='utf-8') as sf:
                raw = json.load(sf)
            if isinstance(raw, dict):
                messages = raw.get('messages') if isinstance(raw.get('messages'), list) else []
                memory_state = raw.get('memory_state') if isinstance(raw.get('memory_state'), dict) else {}
                gm = raw.get('group_meta')
                group_meta = gm if isinstance(gm, dict) else None
            elif isinstance(raw, list):
                messages = raw
        except Exception:
            pass

    custom_title = str(memory_state.get('title') or '').strip()
    is_group = bool(isinstance(group_meta, dict) and group_meta.get('is_group'))
    guest_ids = list(group_meta.get('guest_ids') or []) if is_group else []

    if custom_title:
        title = custom_title
    elif is_group:
        if guest_ids:
            guest_names = [
                (st.read_program_card(gid).get('name') or gid.title())
                for gid in guest_ids[:3]
            ]
            title = f"{program_name} & {', '.join(guest_names)}"
            if len(guest_ids) > 3:
                title += f" +{len(guest_ids) - 3}"
        else:
            title = 'Group Chat'
    elif session_id == 'default':
        title = 'Primary Chat'
    else:
        first_user = ''
        for m in messages:
            if not isinstance(m, dict) or m.get('role') != 'user':
                continue
            sp = m.get('shared_post') if isinstance(m.get('shared_post'), dict) else None
            if sp:
                note = str(m.get('user_note') or '').strip()
                first_user = note or f"Post by {sp.get('authorName') or 'Author'}"
                break
            cand = str(m.get('text') or '').strip()
            if cand and not cand.startswith('[Tool Response'):
                first_user = cand
                break
        title = _clean_session_snippet(first_user, 42) or 'New Chat'

    last_preview = ''
    for m in reversed(messages):
        if not isinstance(m, dict):
            continue
        msg_id = str(m.get('id') or '')
        if msg_id.startswith(('tool_', 'port_', 'quest_', 'sys_', 'itm_')):
            continue
        role = m.get('role')
        if role not in ('user', 'program', 'model'):
            continue
        sp = m.get('shared_post') if isinstance(m.get('shared_post'), dict) else None
        if sp:
            note = str(m.get('user_note') or '').strip()
            raw_txt = note or f"Shared post from {sp.get('authorHandle') or sp.get('authorName') or 'feed'}"
        else:
            raw_txt = str(m.get('text') or '').strip()
            if raw_txt.startswith('[Tool Response') or raw_txt.lower().startswith('[system:'):
                continue
            if not raw_txt and m.get('image_url'):
                raw_txt = '[Image]'
        if raw_txt:
            cleaned = _clean_session_snippet(raw_txt, 260)
            last_preview = f'You: {cleaned}' if role == 'user' else cleaned
            break

    if not last_preview:
        last_preview = 'No messages yet'

    updated_at = mtime
    for m in messages:
        if isinstance(m, dict) and isinstance(m.get('timestamp'), (int, float)):
            ts = float(m['timestamp'])
            if ts > updated_at:
                updated_at = ts

    return {
        'id': session_id,
        'title': title,
        'custom_title': custom_title,
        'snippet': last_preview,
        'message_count': len(messages),
        'updated_at': float(updated_at or 0.0),
        'is_group': is_group,
        'guest_ids': guest_ids,
    }


@programs_bp.route('/api/sessions', methods=['GET'])
@st.requires_auth
def list_sessions():
    try:
        req_prog = re.sub(r'[^a-zA-Z0-9_-]', '', (request.args.get('program_id') or '').strip())
        active_program = get_active_program()
        target_program = req_prog or active_program
        active_session = get_active_session()
        sessions_dir = os.path.join(st.base_dir, 'core', 'programs', target_program, 'sessions')

        card = st.read_program_card(target_program)
        program_name = str(card.get('name') or target_program.title())
        default_first_mes = str(card.get('first_mes') or '')

        session_ids = []
        if os.path.exists(sessions_dir):
            for file in os.listdir(sessions_dir):
                if file.endswith('.json') and not file.endswith('_voice.json'):
                    session_name = file[:-5]
                    if session_name.startswith('group_'):
                        fpath = os.path.join(sessions_dir, file)
                        try:
                            with open(fpath, 'r', encoding='utf-8') as sf:
                                sdata = json.load(sf)
                            gm = sdata.get('group_meta')
                            if not gm or not gm.get('is_group') or not gm.get('host_id') or gm.get('host_id') != target_program or not gm.get('guest_ids'):
                                try:
                                    os.remove(fpath)
                                except Exception:
                                    pass
                                continue
                        except Exception:
                            pass
                    session_ids.append(session_name)

        if target_program == active_program and active_session and not active_session.endswith('_voice'):
            if active_session not in session_ids:
                session_ids.append(active_session)

        if 'default' not in session_ids:
            session_ids.append('default')

        entries = [
            _derive_session_entry(target_program, sid, program_name, default_first_mes)
            for sid in dict.fromkeys(session_ids)
        ]
        entries.sort(key=lambda item: (item['updated_at'], 1 if item['id'] == 'default' else 0), reverse=True)

        return jsonify({
            'status': 'success',
            'program_id': target_program,
            'sessions': entries,
            'active_session': active_session,
        })
    except Exception as e:
        print(f"Error listing sessions: {e}")
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/sessions/create', methods=['POST'])
@st.requires_auth
def create_session_route():
    try:
        data = request.get_json(silent=True) or {}
        req_prog = re.sub(r'[^a-zA-Z0-9_-]', '', str(data.get('program_id') or '').strip())
        target_program = req_prog or get_active_program()
        clean_title = str(data.get('title') or '').strip()[:80]

        program_path = os.path.join(st.base_dir, 'core', 'programs', target_program)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{target_program}' does not exist"}), 404

        if target_program != get_active_program():
            os.environ['ACTIVE_PROGRAM'] = target_program
            set_active_program(target_program)
            st._cached_active_program = target_program
            st.reload_program_state(target_program)

        session_id = f"chat_{int(time.time() * 1000)}"
        set_active_session(session_id)

        with st.runner._lock:
            st.runner._ensure_session_loaded(session_id)
            st.runner._ensure_first_message(session_id)
            if clean_title:
                meta = st.runner._get_memory_meta(session_id)
                meta['title'] = clean_title
            st.runner._save_session_to_disk(session_id)

        card = st.read_program_card(target_program)
        program_name = str(card.get('name') or target_program.title())
        default_first_mes = str(card.get('first_mes') or '')
        entry = _derive_session_entry(target_program, session_id, program_name, default_first_mes)

        return jsonify({
            'status': 'success',
            'session': entry,
            'active_session': session_id,
        })
    except Exception as e:
        print(f"Error creating session: {e}")
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/sessions/rename', methods=['POST'])
@st.requires_auth
def rename_session_route():
    try:
        data = request.get_json(silent=True) or {}
        session_id = str(data.get('session_id') or '').strip()
        if not session_id:
            return jsonify({'error': 'Missing session_id'}), 400
        clean_title = str(data.get('title') or '').strip()[:80]
        req_prog = re.sub(r'[^a-zA-Z0-9_-]', '', str(data.get('program_id') or '').strip())
        target_program = req_prog or get_active_program()

        program_path = os.path.join(st.base_dir, 'core', 'programs', target_program)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{target_program}' does not exist"}), 404

        with st.runner._lock:
            if target_program == get_active_program():
                st.runner._ensure_session_loaded(session_id)
                if not st.runner.sessions_history.get(session_id):
                    st.runner._ensure_first_message(session_id)
                meta = st.runner._get_memory_meta(session_id)
                if clean_title:
                    meta['title'] = clean_title
                else:
                    meta.pop('title', None)
                st.runner._save_session_to_disk(session_id)
            else:
                safe_id = ''.join(c for c in session_id if c.isalnum() or c in '-_') or 'default'
                sessions_dir = os.path.join(program_path, 'sessions')
                os.makedirs(sessions_dir, exist_ok=True)
                fpath = os.path.join(sessions_dir, f'{safe_id}.json')
                sdata = {}
                if os.path.exists(fpath):
                    try:
                        with open(fpath, 'r', encoding='utf-8') as sf:
                            loaded = json.load(sf)
                        if isinstance(loaded, dict):
                            sdata = loaded
                        elif isinstance(loaded, list):
                            sdata = {'messages': loaded}
                    except Exception:
                        sdata = {}
                mem = sdata.setdefault('memory_state', {})
                if not isinstance(mem, dict):
                    mem = {}
                    sdata['memory_state'] = mem
                if clean_title:
                    mem['title'] = clean_title
                else:
                    mem.pop('title', None)
                tmp_path = fpath + '.tmp'
                with open(tmp_path, 'w', encoding='utf-8') as sf:
                    json.dump(sdata, sf, indent=2, ensure_ascii=False)
                os.replace(tmp_path, fpath)

        return jsonify({
            'status': 'success',
            'session_id': session_id,
            'title': clean_title,
        })
    except Exception as e:
        print(f"Error renaming session: {e}")
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/sessions/delete', methods=['POST'])
@st.requires_auth
def delete_session_route():
    try:
        data = request.get_json(silent=True) or {}
        session_id = str(data.get('session_id') or '').strip()
        if not session_id:
            return jsonify({'error': 'Missing session_id'}), 400
        req_prog = re.sub(r'[^a-zA-Z0-9_-]', '', str(data.get('program_id') or '').strip())
        target_program = req_prog or get_active_program()

        st.cancel_session_image_work(session_id)
        cancelled_sessions.add(session_id)
        try:
            if target_program == get_active_program() and getattr(st, 'runner', None) is not None:
                st.run_async(st.runner.reset_session(session_id))
            safe_id = ''.join(c for c in session_id if c.isalnum() or c in '-_') or 'default'
            fpath = os.path.join(st.base_dir, 'core', 'programs', target_program, 'sessions', f'{safe_id}.json')
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        finally:
            cancelled_sessions.discard(session_id)

        if session_id != 'default' and get_active_session() == session_id:
            set_active_session('default')

        return jsonify({
            'status': 'success',
            'deleted_id': session_id,
            'active_session': get_active_session(),
        })
    except Exception as e:
        print(f"Error deleting session: {e}")
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs', methods=['GET'])
@st.requires_auth
def list_programs():
    try:
        active_program = get_active_program()
        programs = []
        if os.path.exists(vs.PROGRAMS_DIR):
            for folder in os.listdir(vs.PROGRAMS_DIR):
                folder_path = st.get_program_dir(folder)
                if os.path.isdir(folder_path):
                    if folder != "sebile":
                        has_json = os.path.isfile(os.path.join(folder_path, f"{folder}.json"))
                        has_md = any(f.lower().endswith(".md") for f in os.listdir(folder_path))
                        if not has_json and not has_md:
                            try:
                                shutil.rmtree(folder_path, ignore_errors=True)
                            except Exception:
                                pass
                            continue
                    program_name = folder.title()
                    card = st.read_program_card(folder)
                    if card.get("name"):
                        program_name = card["name"]
                    else:
                        for file in os.listdir(folder_path):
                            if file.lower().endswith('.md') and not file.lower().startswith('user'):
                                program_name = os.path.splitext(file)[0].title()
                                break
                    theme_color = "#9370db"
                    tdata = st.load_theme(folder)
                    if tdata:
                        theme_color = tdata.get("primary_accent") or tdata.get("main_color") or theme_color
                            
                    profile_path = os.path.join(folder_path, "portraits", "profile.png")
                    has_profile = os.path.exists(profile_path)
                        
                    programs.append({
                        'id': folder,
                        'name': program_name,
                        'personality': str(card.get('personality') or '').strip(),
                        'active': folder == active_program,
                        'theme_color': theme_color,
                        'theme': tdata,
                        'has_profile': has_profile
                    })
        return jsonify({'programs': programs, 'active': active_program})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/select', methods=['POST'])
@st.requires_auth
def select_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
            
        program_path = os.path.join(st.base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # Update environment variable
        os.environ["ACTIVE_PROGRAM"] = program_id
        
        # Update active program settings
        try:
            set_active_program(program_id)
            set_active_session('default')
        except Exception as e:
            print(f"Error persisting ACTIVE_PROGRAM: {e}")
        
        # global migrated to st
        st._cached_active_program = program_id

        st.reload_program_state(program_id)
            
        theme = st.load_theme(program_id)

        has_profile = False
        profile_path = os.path.join(program_path, "portraits", "profile.png")
        if os.path.exists(profile_path):
            has_profile = True

        from core.mood_inversion import get_program_mood_metadata
        mood_meta = get_program_mood_metadata(program_id)

        from core.program_config import get_program_name
        program_name = get_program_name()
        st.broadcast_status()
        return jsonify({
            'status': 'success',
            'active': program_id,
            'character_name': program_name,
            'theme': theme,
            'has_profile': has_profile,
            'mood_meta': mood_meta
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            from variables.settings import LOGS_DIR
            err_log_path = os.path.join(LOGS_DIR, 'server_error.log')
            with open(err_log_path, 'w', encoding='utf-8') as lf:
                traceback.print_exc(file=lf)
        except Exception:
            pass
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/group_session/start', methods=['POST'])
@st.requires_auth
def start_group_session():
    try:
        data = request.get_json(silent=True) or {}
        host_id = data.get('host_id')
        guest_ids = data.get('guest_ids', [])

        if not host_id:
            return jsonify({'error': 'Missing host_id'}), 400

        host_path = os.path.join(st.base_dir, 'core', 'programs', host_id)
        if not os.path.exists(host_path):
            return jsonify({'error': f"Host program '{host_id}' does not exist"}), 404

        # Validate guest programs exist
        valid_guests = []
        for gid in guest_ids:
            if gid != host_id and os.path.exists(os.path.join(st.base_dir, 'core', 'programs', gid)):
                if gid not in valid_guests:
                    valid_guests.append(gid)

        # Set active program to Host so theme, heart pulse, and mood belonging stay intact
        os.environ["ACTIVE_PROGRAM"] = host_id
        # global migrated to st
        st._cached_active_program = host_id
        try:
            from runners.program import set_active_program
            set_active_program(host_id)
        except Exception as e:
            print(f"Error persisting ACTIVE_PROGRAM to host: {e}")

        st.reload_program_state(host_id)

        # Create new unique group session ID under the Host
        safe_time = int(time.time())
        session_id = f"group_{safe_time}"

        st.runner.create_group_session(session_id, host_id, valid_guests)

        try:
            set_active_session(session_id)
        except Exception as e:
            print(f"Error persisting active session: {e}")

        theme = st.load_theme(host_id)
        from core.mood_inversion import get_program_mood_metadata
        mood_meta = get_program_mood_metadata(host_id)
        from core.program_config import get_program_name
        program_name = get_program_name()
        st.broadcast_status()

        return jsonify({
            'status': 'success',
            'session_id': session_id,
            'host_id': host_id,
            'guest_ids': valid_guests,
            'character_name': program_name,
            'theme': theme,
            'mood_meta': mood_meta
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/group_session/members', methods=['POST'])
@st.requires_auth
def update_group_session_members():
    try:
        data = request.get_json(silent=True) or {}
        session_id = data.get('session_id') or get_active_session()
        new_guest_ids = data.get('guest_ids', [])
        new_host_id = data.get('host_id')

        # Check existing group_meta under runner._lock
        with st.runner._lock:
            st.runner._ensure_session_loaded(session_id)
            group_meta = st.runner.sessions_group_meta.get(session_id)

        if not group_meta or not group_meta.get("is_group"):
            return jsonify({'error': 'Session is not an active group session'}), 400

        curr_host_id = group_meta.get("host_id")
        target_host_id = new_host_id if new_host_id else curr_host_id

        programs_dir = os.path.join(st.base_dir, 'core', 'programs')
        if not os.path.isdir(os.path.join(programs_dir, target_host_id)):
            return jsonify({'error': f"Host program '{target_host_id}' does not exist"}), 404

        valid_guests = []
        for gid in new_guest_ids:
            if gid and gid != target_host_id and os.path.isdir(os.path.join(programs_dir, gid)):
                if gid not in valid_guests:
                    valid_guests.append(gid)

        try:
            updated_meta, host_changed = st.runner.update_group_session(session_id, target_host_id, valid_guests)
        except ValueError as ve:
            return jsonify({'error': str(ve)}), 400
        except FileNotFoundError as fnf:
            return jsonify({'error': str(fnf)}), 404

        if host_changed:
            os.environ["ACTIVE_PROGRAM"] = target_host_id
            # global migrated to st
            st._cached_active_program = target_host_id
            try:
                from runners.program import set_active_program
                set_active_program(target_host_id)
            except Exception:
                pass
            st.reload_program_state(target_host_id)
            st.broadcast_status()

        enriched = st.enrich_group_meta(updated_meta)
        return jsonify({
            'status': 'success',
            'session_id': session_id,
            'host_id': target_host_id,
            'guest_ids': valid_guests,
            'group_meta': enriched
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/theme', methods=['GET'])
@st.requires_auth
def get_program_theme_route():
    try:
        from runners.program import get_active_program
        from core.mood_inversion import get_program_mood_metadata
        program_id = request.args.get('program_id') or get_active_program()
        theme_data = st.load_theme(program_id)
        mood_meta = get_program_mood_metadata(program_id)
        return jsonify({
            'status': 'success',
            'program_id': program_id,
            'theme': theme_data,
            'mood_meta': mood_meta
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/palette', methods=['POST'])
@st.requires_auth
def update_program_palette():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        color = data.get('color')
        
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
        if not color:
            return jsonify({'error': 'Missing color'}), 400

        if program_id.lower() == 'sebile':
            from runners.program import get_active_user
            active_u = get_active_user().lower()
            if not (active_u == 'davy' or active_u.startswith('mastodon_')):
                return jsonify({'error': 'Cannot modify theme for default program Sebile'}), 400
            
        # Validate hex color
        if not re.match(r'^#[0-9a-fA-F]{6}$', color):
            return jsonify({'error': 'Invalid hex color format. Must be #RRGGBB'}), 400
            
        program_path = os.path.join(st.base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # Regenerate theme.json
        theme_data = generate_character_theme(color)
        theme_path = os.path.join(program_path, "theme.json")
        with open(theme_path, "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2, ensure_ascii=False)
            
        st._theme_cache[program_id] = theme_data
        from core.mood_inversion import get_program_mood_metadata
        mood_meta = get_program_mood_metadata(program_id)

        return jsonify({
            'status': 'success',
            'program_id': program_id,
            'color': color,
            'theme': theme_data,
            'mood_meta': mood_meta
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/delete', methods=['POST'])
@st.requires_auth
def delete_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
            
        if program_id == 'sebile':
            return jsonify({'error': 'Cannot delete default program Sebile'}), 400

        from utils import image_cancellation
        image_cancellation.cancel(program_id=program_id)
            
        program_path = os.path.join(st.base_dir, 'core', 'programs', program_id)
        to_remove = set()

        # 1. Collect own sessions from disk (if folder still exists)
        own_sessions_dir = os.path.join(program_path, 'sessions')
        if os.path.isdir(own_sessions_dir):
            for fname in os.listdir(own_sessions_dir):
                if fname.endswith('.json'):
                    to_remove.add(os.path.splitext(fname)[0])
            
        # 2. Clean up all group sessions hosted by or involving this program across other programs
        programs_dir = os.path.join(st.base_dir, 'core', 'programs')
        if os.path.isdir(programs_dir):
            for other_prog in os.listdir(programs_dir):
                other_sessions = os.path.join(programs_dir, other_prog, 'sessions')
                if not os.path.isdir(other_sessions):
                    continue
                for fname in list(os.listdir(other_sessions)):
                    if fname.startswith('group_') and fname.endswith('.json'):
                        fpath = os.path.join(other_sessions, fname)
                        sid = os.path.splitext(fname)[0]
                        try:
                            with open(fpath, 'r', encoding='utf-8') as sf:
                                sdata = json.load(sf)
                            gm = sdata.get('group_meta', {})
                            if gm.get('host_id') == program_id or not gm.get('host_id'):
                                to_remove.add(sid)
                                st.cancel_session_image_work(sid)
                                os.remove(fpath)
                            elif program_id in gm.get('guest_ids', []):
                                st.cancel_session_image_work(sid)
                                gm['guest_ids'] = [g for g in gm['guest_ids'] if g != program_id]
                                if not gm['guest_ids']:
                                    to_remove.add(sid)
                                    os.remove(fpath)
                                else:
                                    sdata['group_meta'] = gm
                                    with open(fpath, 'w', encoding='utf-8') as sf:
                                        json.dump(sdata, sf, indent=2, ensure_ascii=False)
                        except RuntimeError:
                            raise
                        except Exception as ex:
                            print(f"Error inspecting/cleaning group session {fname}: {ex}")

        # 3. Stop image work for affected sessions before removing their state.
        with st.runner._lock:
            for sid, prog in list(getattr(st.runner, 'sessions_program', {}).items()):
                if prog == program_id:
                    to_remove.add(sid)
            for sid, gmeta in list(getattr(st.runner, 'sessions_group_meta', {}).items()):
                if gmeta.get('host_id') == program_id or program_id in gmeta.get('guest_ids', []):
                    to_remove.add(sid)
        for sid in to_remove:
            st.cancel_session_image_work(sid)

        # 4. Clean up in-memory runner states
        with st.runner._lock:
            if hasattr(st.runner, 'sessions_program'):
                for sid, prog in list(st.runner.sessions_program.items()):
                    if prog == program_id:
                        to_remove.add(sid)

            for sid, gmeta in list(getattr(st.runner, 'sessions_group_meta', {}).items()):
                if gmeta.get('host_id') == program_id or not gmeta.get('host_id'):
                    to_remove.add(sid)
                elif program_id in gmeta.get('guest_ids', []):
                    gmeta['guest_ids'] = [g for g in gmeta['guest_ids'] if g != program_id]
                    if not gmeta['guest_ids']:
                        to_remove.add(sid)

            for sid in to_remove:
                st.runner.evict_session(sid)
                voice_call_sessions.discard(sid)

        # 4. If active session belongs to deleted program or was a deleted group session, reset to default
        from runners.program import get_active_session, set_active_session
        curr_session = get_active_session()
        if curr_session in to_remove:
            set_active_session('default')

        # 5. If the deleted program is currently active, switch to Sebile first
        from runners.program import get_active_program, set_active_program
        # global migrated to st
        active_program = get_active_program()
        is_active = (
            program_id == active_program
            or getattr(st.runner, 'program_id', None) == program_id
            or st._cached_active_program == program_id
        )
        if is_active:
            os.environ["ACTIVE_PROGRAM"] = "sebile"
            try:
                set_active_program("sebile")
                set_active_session("default")
            except Exception as e:
                print(f"Error resetting active program to sebile: {e}")
                
            st._cached_active_program = "sebile"

            # Switch active runner state cleanly to sebile
            st.reload_program_state("sebile")

        # 6. Clean project_settings.json (folders and program_voices)
        from runners.program import _load_settings, _save_settings
        settings = _load_settings()
        settings_changed = False
        norm_prog_path = os.path.normpath(program_path)
        folders = settings.get("folders", [])
        cleaned_folders = [f for f in folders if os.path.normpath(f) != norm_prog_path]
        if len(cleaned_folders) != len(folders):
            settings["folders"] = cleaned_folders
            settings_changed = True
        voices = settings.get("program_voices", {})
        if program_id in voices:
            voices.pop(program_id, None)
            settings["program_voices"] = voices
            settings_changed = True
        if settings_changed:
            _save_settings(settings)

        # 7. Purge cached theme data
        st._theme_cache.pop(program_id, None)

        # 8. Delete the program folder recursively
        if os.path.exists(program_path):
            import gc
            import stat
            gc.collect()

            def _handle_remove_readonly(func, path, exc_info):
                try:
                    os.chmod(path, stat.S_IWRITE)
                    gc.collect()
                    func(path)
                except Exception:
                    try:
                        time.sleep(0.05)
                        gc.collect()
                        os.chmod(path, stat.S_IWRITE)
                        func(path)
                    except Exception as retry_err:
                        print(f"[delete_program] Failed to remove {path}: {retry_err}")

            shutil.rmtree(program_path, onerror=_handle_remove_readonly)
            if os.path.exists(program_path):
                time.sleep(0.1)
                gc.collect()
                shutil.rmtree(program_path, onerror=_handle_remove_readonly)

            if os.path.exists(program_path):
                return jsonify({'error': f"Failed to completely remove directory for '{program_id}'"}), 500
        
        st.broadcast_status()
        return jsonify({'status': 'success', 'switched_to': 'sebile' if is_active else None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/rename', methods=['POST'])
@st.requires_auth
def rename_program():
    try:
        # global migrated to st
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        new_name = data.get('new_name', '').strip()
        
        if not program_id or not new_name:
            return jsonify({'error': 'Missing program_id or new_name'}), 400
            
        if not st.PROGRAM_ID_RE.match(program_id):
            return jsonify({'error': 'Invalid program_id'}), 400
            
        new_id = st.SAFE_NAME_RE.sub('', new_name).lower()
        if not new_id:
            return jsonify({'error': 'Invalid new name (must contain letters, numbers, or underscores)'}), 400
            
        pass
        from runners.program import get_active_program
        old_path = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
        new_path = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, new_id))
        
        if not os.path.exists(old_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # Sebile is a permanent core program and can only be renamed/edited by Davy
        if program_id == 'sebile':
            from runners.program import get_active_user
            active_u = get_active_user().lower()
            if not (active_u == 'davy' or active_u.startswith('mastodon_')):
                return jsonify({'error': 'Cannot rename default program Sebile'}), 400
            
            json_path = os.path.join(old_path, "sebile.json")
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        jdata = json.load(f)
                    data_block = jdata.get("data", jdata)
                    data_block["name"] = new_name
                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(jdata, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error updating Sebile JSON: {e}")
            
            st._update_program_references('sebile', 'sebile', new_name)
            active_program = get_active_program() or os.getenv("ACTIVE_PROGRAM", "sebile")
            return jsonify({
                'status': 'success',
                'new_id': 'sebile',
                'was_active': (active_program == 'sebile')
            })
            
        # If new_id is different from program_id, perform folder rename
        if new_id != program_id:
            if os.path.exists(new_path):
                return jsonify({'error': f"A program folder named '{new_id}' already exists"}), 400

            with (st.runner._lock if st.runner is not None else nullcontext()):
                # Capture active status BEFORE moving old_path, otherwise get_active_program()
                # sees old_path missing and resets project_settings.json to 'sebile'.
                active_program = get_active_program() or os.getenv("ACTIVE_PROGRAM", "sebile")
                was_active = (program_id == active_program)

                # Perform directory rename (release any lingering file handles on Windows first)
                import gc
                gc.collect()
                try:
                    os.replace(old_path, new_path)
                except PermissionError:
                    time.sleep(0.05)
                    gc.collect()
                    shutil.move(old_path, new_path)

                # Inside the new directory, rename the json file: old_id.json -> new_id.json
                old_json = os.path.join(new_path, f"{program_id}.json")
                new_json = os.path.join(new_path, f"{new_id}.json")
                if os.path.exists(old_json):
                    shutil.move(old_json, new_json)

                # Also update fields inside the json file
                if os.path.exists(new_json):
                    try:
                        with open(new_json, "r", encoding="utf-8") as f:
                            jdata = json.load(f)
                        data_block = jdata.get("data", jdata)
                        data_block["name"] = new_name
                        exts = data_block.setdefault("extensions", {})
                        sanctuary = exts.setdefault("sanctuary", {})
                        sanctuary["program_id"] = new_id
                        if "character_book" in data_block and isinstance(data_block["character_book"], dict):
                            data_block["character_book"]["name"] = new_name
                        with open(new_json, "w", encoding="utf-8") as f:
                            json.dump(jdata, f, indent=2, ensure_ascii=False)
                    except Exception as e:
                        print(f"Error updating JSON after rename: {e}")

                # Update settings (active_program, folders, program_voices)
                from runners.program import _load_settings, _save_settings
                settings = _load_settings()

                current_folders = settings.get("folders", [])
                norm_old = os.path.normpath(old_path)
                norm_new = os.path.normpath(new_path)
                mapped_folders = []
                for f in current_folders:
                    target_f = new_path if os.path.normpath(f) == norm_old else f
                    if all(os.path.normpath(existing) != os.path.normpath(target_f) for existing in mapped_folders):
                        mapped_folders.append(target_f)

                if was_active:
                    os.environ["ACTIVE_PROGRAM"] = new_id
                    st._cached_active_program = new_id
                    settings["active_program"] = new_id
                    extra_folders = [f for f in mapped_folders if os.path.normpath(f) != norm_new]
                    settings["folders"] = [new_path] + extra_folders
                elif mapped_folders != current_folders:
                    settings["folders"] = mapped_folders

                if "program_voices" in settings:
                    if program_id in settings["program_voices"]:
                        settings["program_voices"][new_id] = settings["program_voices"].pop(program_id)

                _save_settings(settings)
                st._update_program_references(program_id, new_id, new_name)

                if was_active and st.runner is not None:
                    st.runner.program_id = new_id
            st.broadcast_status()
            
            return jsonify({
                'status': 'success',
                'new_id': new_id,
                'was_active': was_active
            })
        else:
            # ID is the same, no directory rename needed
            json_path = os.path.join(old_path, f"{program_id}.json")
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        jdata = json.load(f)
                    data_block = jdata.get("data", jdata)
                    data_block["name"] = new_name
                    if "character_book" in data_block and isinstance(data_block["character_book"], dict):
                        data_block["character_book"]["name"] = new_name
                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(jdata, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error updating JSON name: {e}")
                    
            st._update_program_references(program_id, program_id, new_name)
            active_program = get_active_program() or os.getenv("ACTIVE_PROGRAM", "sebile")
            return jsonify({
                'status': 'success',
                'new_id': program_id,
                'was_active': (program_id == active_program)
            })
            
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/profile', methods=['GET'])
@st.requires_auth
def get_program_profile():
    try:
        from runners.program import get_active_program, _load_settings
        pass
        import json

        program_id = request.args.get('program_id') or get_active_program()
        json_path = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id, f"{program_id}.json"))

        card_data = {}
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    raw = json.load(f)
                card_data = raw.get('data', raw)
            except Exception:
                pass

        # Inject tts_voice from project settings (stored separately)
        settings = _load_settings()
        program_voices = settings.get('program_voices', {})
        card_data['tts_voice'] = program_voices.get(program_id, settings.get('tts_voice', 'af_heart'))
        card_data['story_mode'] = bool(card_data.get('story_mode', False))

        return jsonify(card_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/profile/save', methods=['POST'])
@st.requires_auth
def save_program_profile():
    try:
        from runners.program import set_tts_voice_for_program
        pass
        import json

        incoming = request.get_json(silent=True) or {}
        program_id = incoming.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400

        if program_id.lower() == 'sebile':
            from runners.program import get_active_user
            active_u = get_active_user().lower()
            if not (active_u == 'davy' or active_u.startswith('mastodon_')):
                return jsonify({'error': 'Cannot modify default program Sebile'}), 400

        program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
        if not os.path.exists(program_dir):
            for f in os.listdir(vs.PROGRAMS_DIR):
                if f.lower() == program_id.lower():
                    program_id = f
                    program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
                    break

        json_path = os.path.normpath(os.path.join(program_dir, f"{program_id}.json"))

        # Extract sidecars before writing card
        tts_voice = incoming.pop('tts_voice', None)
        story_mode = incoming.pop('story_mode', None)
        incoming.pop('program_id', None)
        incoming_exts = incoming.pop('extensions', None)

        if tts_voice:
            set_tts_voice_for_program(program_id, tts_voice)

        # Load existing card
        existing = {}
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    existing = json.load(f)
            except Exception:
                pass

        if existing.get('spec') == 'chara_card_v3' and 'data' in existing:
            card_to_write = existing
        else:
            card_to_write = {
                'spec': 'chara_card_v3',
                'spec_version': '3.0',
                'data': existing.get('data', existing) if existing else {}
            }

        # Update data payload including story_mode if present
        card_to_write['data'].update(incoming)
        if story_mode is not None:
            card_to_write['data']['story_mode'] = bool(story_mode)

        if incoming_exts:
            if 'extensions' not in card_to_write['data'] or not isinstance(card_to_write['data']['extensions'], dict):
                card_to_write['data']['extensions'] = {}
            for ext_key, ext_val in incoming_exts.items():
                if isinstance(ext_val, dict) and isinstance(card_to_write['data']['extensions'].get(ext_key), dict):
                    card_to_write['data']['extensions'][ext_key].update(ext_val)
                else:
                    card_to_write['data']['extensions'][ext_key] = ext_val

        os.makedirs(os.path.dirname(json_path), exist_ok=True)
        tmp_path = f"{json_path}.tmp"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(card_to_write, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, json_path)

        updated_name = (card_to_write['data'].get('name') or '').strip()
        if updated_name:
            st._update_program_references(program_id, program_id, updated_name)

        from core.mood_inversion import get_program_mood_metadata
        theme = st.load_theme(program_id)
        mood_meta = get_program_mood_metadata(program_id)
        st.broadcast_status()

        return jsonify({
            'status': 'success',
            'program_id': program_id,
            'character_name': updated_name or program_id.title(),
            'theme': theme,
            'mood_meta': mood_meta,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/user_profiles', methods=['GET'])
@st.requires_auth
def list_user_profiles():
    try:
        from variables.settings import USER_PROFILES_DIR
        from runners.program import get_active_user
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
        
        # Get active user profile
        active_user = get_active_user()
        
        profiles = []
        for file in os.listdir(USER_PROFILES_DIR):
            if file.lower().endswith(".md"):
                profile_name = os.path.splitext(file)[0]
                profile_path = os.path.join(USER_PROFILES_DIR, file)
                try:
                    with open(profile_path, "r", encoding="utf-8") as pf:
                        content = pf.read()
                    profiles.append({
                        "id": profile_name,
                        "name": profile_name.replace("_", " ").title(),
                        "content": content
                    })
                except Exception as e:
                    print(f"Error reading profile {file}: {e}")
        
        # If there are no profiles at all, ensure at least "builder" is present
        if not profiles:
            builder_path = os.path.join(USER_PROFILES_DIR, "builder.md")
            default_content = "# USER CONTEXT: BUILDER\n- A software developer and code builder.\n- Hobby: Collects cute AI program programs in the Sanctuary.\n"
            with open(builder_path, "w", encoding="utf-8") as f:
                f.write(default_content)
            profiles.append({
                "id": "builder",
                "name": "Builder",
                "content": default_content
            })

        return jsonify({"profiles": profiles, "active": active_user})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@programs_bp.route('/api/user_profiles/select', methods=['POST'])
@st.requires_auth
def select_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
        
        from variables.settings import USER_PROFILES_DIR
        from runners.program import set_active_user
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
        
        # Update active user profile settings
        set_active_user(profile_id)
        
        # Re-initialize the program config module and runner
        st.reload_program_state()
            
        return jsonify({"status": "success", "active": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@programs_bp.route('/api/user_profiles/save', methods=['POST'])
@st.requires_auth
def save_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        content = data.get("content")
        
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
        if content is None:
            return jsonify({"error": "Missing content"}), 400
        
        # Sanitize profile_id
        profile_id = st.USER_PROFILE_NAME_RE.sub('', profile_id).lower()
        if not profile_id:
            return jsonify({"error": "Invalid profile name"}), 400
            
        from variables.settings import USER_PROFILES_DIR
        from runners.program import get_active_user
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
            
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        with open(profile_path, "w", encoding="utf-8") as f:
            f.write(content)
            
        # Read active profile
        active_user = get_active_user()
        
        # If we edited the active profile, trigger hot reload immediately
        if profile_id == active_user:
            st.reload_program_state()
                
        return jsonify({"status": "success", "profile_id": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _strip_profile_html(raw: str) -> str:
    text = str(raw or "")
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    import html as _html
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _normalize_recent_social_posts(raw_posts) -> list[dict[str, str]]:
    """Sanitize and cap public recent social posts (max 3 plain-text entries, zero credentials)."""
    if not isinstance(raw_posts, list):
        return []
    cleaned: list[dict[str, str]] = []
    seen_texts: set[str] = set()
    for item in raw_posts:
        if isinstance(item, dict):
            raw_text = str(item.get("text") or item.get("content_text") or item.get("content") or "")
            raw_ts = str(item.get("created_at") or item.get("date_published") or item.get("createdAt") or "").strip()[:32]
        else:
            raw_text = str(item or "")
            raw_ts = ""
        plain = _strip_profile_html(raw_text) if "<" in raw_text else re.sub(r"\s+", " ", raw_text).strip()
        if not plain or plain in seen_texts:
            continue
        seen_texts.add(plain)
        if len(plain) > 500:
            plain = plain[:497].rstrip() + "..."
        cleaned.append({"text": plain, "created_at": raw_ts})
        if len(cleaned) >= 3:
            break
    return cleaned


def sync_mastodon_profile_markdown(profile: dict) -> dict:
    """Persist a token-free public Mastodon profile snapshot in USER_PROFILES_DIR and reload programs."""
    from variables.settings import USER_PROFILES_DIR
    from runners.program import set_active_user

    acct = str(profile.get("acct") or profile.get("handle") or "").strip().lstrip("@")
    username = str(profile.get("username") or (acct.split("@")[0] if acct else "") or "user").strip()
    clean_slug = st.USER_PROFILE_NAME_RE.sub("", username).lower() or "user"
    profile_id = f"mastodon_{clean_slug}"

    display_name = str(profile.get("display_name") or profile.get("displayName") or username).strip()
    header = f"# USER CONTEXT: {display_name} (@{acct})" if acct else f"# USER CONTEXT: {display_name}"
    lines = [header]

    bio_raw = str(profile.get("note_text") or profile.get("note") or "")
    bio_text = _strip_profile_html(bio_raw) if "<" in bio_raw else re.sub(r"\s+", " ", bio_raw).strip()
    if bio_text:
        lines.append(f"- Bio: {bio_text}")

    fields = profile.get("fields") if isinstance(profile.get("fields"), list) else []
    for f in fields[:4]:
        if not isinstance(f, dict):
            continue
        fname = str(f.get("name") or "").strip()
        fval = _strip_profile_html(str(f.get("value") or ""))
        if fname and fval:
            lines.append(f"- {fname}: {fval}")

    markdown = "\n".join(lines) + "\n"
    os.makedirs(USER_PROFILES_DIR, exist_ok=True)
    profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
    tmp_path = f"{profile_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(markdown)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, profile_path)

    recent_count = None
    if "recent_posts" in profile and isinstance(profile.get("recent_posts"), list):
        normalized_posts = _normalize_recent_social_posts(profile.get("recent_posts"))
        posts_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}_recent_posts.json")
        posts_tmp = f"{posts_path}.tmp"
        with open(posts_tmp, "w", encoding="utf-8") as pf:
            json.dump(normalized_posts, pf, ensure_ascii=False, indent=2)
            pf.flush()
            os.fsync(pf.fileno())
        os.replace(posts_tmp, posts_path)
        recent_count = len(normalized_posts)

    set_active_user(profile_id)
    st.reload_program_state()
    result = {"status": "success", "profile_id": profile_id, "display_name": display_name}
    if recent_count is not None:
        result["recent_posts_count"] = recent_count
    return result


@programs_bp.route('/api/user_profiles/sync_mastodon', methods=['POST'])
@st.requires_auth
def sync_mastodon_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict) or not (data.get("acct") or data.get("username") or data.get("display_name") or data.get("displayName")):
            return jsonify({"error": "Missing Mastodon profile details"}), 400
        return jsonify(sync_mastodon_profile_markdown(data))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@programs_bp.route('/api/user_profiles/delete', methods=['POST'])
@st.requires_auth
def delete_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
            
        if profile_id == "builder":
            return jsonify({"error": "Cannot delete the default 'builder' profile"}), 400
            
        from variables.settings import USER_PROFILES_DIR
        from runners.program import get_active_user, set_active_user
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
            
        # Delete file and companion recent-posts snapshot if present
        os.remove(profile_path)
        posts_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}_recent_posts.json")
        if os.path.exists(posts_path):
            os.remove(posts_path)
        
        # If the deleted profile was active, switch active profile back to "builder"
        active_user = get_active_user()
                
        if profile_id == active_user:
            set_active_user("builder")
            st.reload_program_state()
                
        return jsonify({"status": "success", "deleted": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@programs_bp.route('/api/user_profiles/rename', methods=['POST'])
@st.requires_auth
def rename_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        old_profile_id = data.get("old_profile_id")
        new_name = data.get("new_profile_name")
        
        if not old_profile_id or not new_name:
            return jsonify({"error": "Missing old_profile_id or new_profile_name"}), 400
            
        if old_profile_id == "builder":
            return jsonify({"error": "Cannot rename the default 'builder' profile"}), 400
            
        new_profile_id = re.sub(r'[^a-zA-Z0-9_\-]', '', new_name).strip().replace(' ', '_').lower()
        new_profile_id = re.sub(r'_+', '_', new_profile_id)
        
        if not new_profile_id:
            return jsonify({"error": "Invalid new profile name"}), 400
            
        if new_profile_id == "builder":
            return jsonify({"error": "Cannot rename a profile to 'builder'"}), 400
            
        if old_profile_id == new_profile_id:
            return jsonify({"status": "success", "profile_id": new_profile_id})
            
        from variables.settings import USER_PROFILES_DIR
        from runners.program import get_active_user, set_active_user
        old_path = os.path.join(USER_PROFILES_DIR, f"{old_profile_id}.md")
        new_path = os.path.join(USER_PROFILES_DIR, f"{new_profile_id}.md")
        
        if not os.path.exists(old_path):
            return jsonify({"error": f"Profile '{old_profile_id}' does not exist"}), 404
            
        if os.path.exists(new_path):
            return jsonify({"error": f"Profile '{new_profile_id}' already exists"}), 400
            
        # Rename file and companion recent-posts snapshot if present
        os.rename(old_path, new_path)
        old_posts_path = os.path.join(USER_PROFILES_DIR, f"{old_profile_id}_recent_posts.json")
        new_posts_path = os.path.join(USER_PROFILES_DIR, f"{new_profile_id}_recent_posts.json")
        if os.path.exists(old_posts_path):
            os.rename(old_posts_path, new_posts_path)
        
        # Check active user
        active_user = get_active_user()
                
        # If the renamed profile was active, update and reload
        if old_profile_id == active_user:
            set_active_user(new_profile_id)
            st.reload_program_state()
                
        return jsonify({"status": "success", "profile_id": new_profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def normalize_hex_color(color_val: str, default: str = "#9370db") -> str:
    """Returns a valid 6-digit hex color string starting with #."""
    if not isinstance(color_val, str):
        return default
    candidate = color_val.strip().lstrip("#")
    if len(candidate) == 6 and all(c in "0123456789abcdefABCDEF" for c in candidate):
        return f"#{candidate.lower()}"
    if len(candidate) == 3 and all(c in "0123456789abcdefABCDEF" for c in candidate):
        return f"#{''.join(c * 2 for c in candidate).lower()}"
    return default


def generate_character_theme(main_color, accent_color_a=None, accent_color_b=None):
    clean_main = normalize_hex_color(main_color)
    r = int(clean_main[1:3], 16)
    g = int(clean_main[3:5], 16)
    b = int(clean_main[5:7], 16)
    
    # Calculate perceived brightness for primary button text contrast
    brightness = (r * 299 + g * 587 + b * 114) / 1000
    btn_text = "#121214" if brightness > 140 else "#ffffff"
    
    # Convert base color to HLS
    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    
    # Dialogue quote color: high lightness (82%) and capped saturation (max 65%) for readability on dark backgrounds
    quote_s = min(s, 0.65)
    quote_l = 0.82
    qr, qg, qb = colorsys.hls_to_rgb(h, quote_l, quote_s)
    quote_color = f"#{int(round(qr * 255)):02x}{int(round(qg * 255)):02x}{int(round(qb * 255)):02x}"
    
    # Action/italics color: medium-high lightness (76%) and capped saturation (max 60%)
    action_s = min(s, 0.60)
    action_l = 0.76
    ar, ag, ab = colorsys.hls_to_rgb(h, action_l, action_s)
    action_color = f"#{int(round(ar * 255)):02x}{int(round(ag * 255)):02x}{int(round(ab * 255)):02x}"
    
    if not accent_color_a:
        accent_color_a = action_color
    else:
        accent_color_a = normalize_hex_color(accent_color_a, action_color)
        
    if not accent_color_b:
        accent_color_b = clean_main
    else:
        accent_color_b = normalize_hex_color(accent_color_b, clean_main)
        
    return {
        "primary_accent": clean_main,
        "main_color": clean_main,
        "accent_color_a": accent_color_a,
        "accent_color_b": accent_color_b,
        "primary_glow": f"rgba({r}, {g}, {b}, 0.08)",
        "program_bubble": f"rgba({24 + int(r*0.04)}, {24 + int(g*0.04)}, {28 + int(b*0.04)}, 0.85)",
        "send_btn_hover": f"rgba({20 + int(r*0.12)}, {20 + int(g*0.12)}, {22 + int(b*0.12)}, 0.75)",
        "quote_color": quote_color,
        "action_color": action_color,
        "accent_green": accent_color_a,  # Legacy alias
        "quote_blue": quote_color,       # Legacy alias
        "primary_btn_text": btn_text
    }


def generate_character_json(
        name, description, personality, scenario, first_mes, model
    ):
        """Ask the local LLM to produce chara_card_v3 fields for a new program."""

        prompt = f"""Design a SillyTavern chara_card_v3 character profile from the description below.

Input:
Name: {name}
Description: {description}
Personality hint: {personality or 'not specified'}
Scenario hint: {scenario or 'not specified'}
First message hint: {first_mes or 'not specified'}

Output a single JSON object with EXACTLY these keys:
{{
  "description": "2-4 sentence narrative bio. No physical appearance.",
  "personality": "1-3 descriptive tags (e.g. Stoic, Loyal, Guarded).",
  "scenario": "Short scene-setting sentence (one sentence).",
  "first_mes": "In-character opening message (1-2 sentences, first person).",
  "system_prompt": "Concise response style directive (e.g. contractions, tone, length).",
  "image_positive": "Comma-separated tags for intrinsic physical traits only: hair color/style, eye color, face/skin, body build, and simple base garments (e.g. silver hair, purple eyes, fair skin, simple tunic). Do not include weapons, armor, accessories, quality buzzwords, backgrounds, poses, or narrative items.",
  "image_negative": "Comma-separated tags for undesired physical traits and rendering artifacts (e.g. extra limbs, bad anatomy, deformed, mutated hands). Do not include story, armor, or narrative elements.",
  "main_color": "#9370db",
  "inversion": {{
    "intimate": "How they behave when intimate/warm.",
    "excited": "How they behave when excited/playful.",
    "intense": "How they behave when intense/focused.",
    "sad": "How they behave when sad/empathetic."
  }}
}}

Directives:
- Output only valid JSON.
- For main_color, provide an appropriate 6-character hex color code beginning with # that visually fits the character."""

        raw_response = None
        local_model = (
            model
            if (model and model != "local-llm")
            else os.getenv("LOCAL_MODEL_NAME", "local-llm")
        )

        endpoint = vs.LOCAL_SERVER_URL.rstrip("/")
        if endpoint.endswith("/chat/completions"):
            pass
        elif endpoint.endswith("/v1"):
            endpoint = f"{endpoint}/chat/completions"
        else:
            endpoint = f"{endpoint}/v1/chat/completions"

        payload = {
            "model": local_model,
            "messages": [
                {
                    "role": "system",
                    "content": "You output valid JSON character cards. Output only the requested JSON object without markdown fences or reasoning.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.4,
            "max_tokens": 1536,
        }

        try:
            from adapters.vram_orchestrator import start_llm
            start_llm(local_model)
            headers = get_local_server_headers()
            
            # Poll with retry if local server is loading model (HTTP 503)
            max_wait = 60.0
            poll_start = time.time()
            while time.time() - poll_start < max_wait:
                res = httpx.post(endpoint, json=payload, headers=headers, timeout=300.0)
                if res.status_code == 200:
                    raw_response = res.json()["choices"][0]["message"]["content"].strip()
                    break
                elif res.status_code == 503:
                    time.sleep(2.0)
                    continue
                else:
                    print(f"Local server returned non-200 status: {res.status_code} - {res.text}")
                    break
        except Exception as e:
            print(f"Error calling local model for card generation: {e}")

        # 2. JSON Parsing
        parsed = {}
        if raw_response:
            try:
                cleaned = raw_response.strip()

                # Remove reasoning/thinking tags
                cleaned = st.THINKING_STRIP_RE.sub("", cleaned).strip()

                # Isolate raw JSON block
                match = re.search(r"\{[\s\S]*\}", cleaned)
                if match:
                    cleaned = match.group(0)

                result = json.loads(cleaned)
                if isinstance(result, dict):
                    parsed = result
            except Exception as e:
                print(f"Failed to parse card JSON: {e}. Raw response: {raw_response}")

        raw_inversion = parsed.get("inversion")
        if isinstance(raw_inversion, dict) and raw_inversion:
            inversion = {
                str(k).strip().lower(): str(v).strip()
                for k, v in raw_inversion.items()
                if v
            }
        else:
            inversion = {
                "intimate": f"{name} is now deeply affectionate and tender.",
                "excited": f"{name} is now playful and energetic.",
                "intense": f"{name} is now focused and direct.",
                "sad": f"{name} is now empathetic and gentle.",
            }

        main_color = normalize_hex_color(parsed.get("main_color"))

        # 3. Construct the output card schema
        card = {
            "spec": "chara_card_v3",
            "spec_version": "3.0",
            "data": {
                "name": name or parsed.get("name") or "Program",
                "description": parsed.get("description")
                or description
                or f"{name} is a new program.",
                "personality": parsed.get("personality")
                or personality
                or "Friendly",
                "scenario": parsed.get("scenario")
                or scenario
                or "A comfortable room.",
                "first_mes": parsed.get("first_mes")
                or first_mes
                or f"Hello, I'm {name}.",
                "mes_example": "",
                "system_prompt": parsed.get("system_prompt")
                or "Speak naturally using contractions. Be warm and concise.",
                "post_history_instructions": "",
                "creator_notes": "",
                "tags": [],
                "creator": "LM-Sanctuary",
                "character_version": "1.0",
                "alternate_greetings": [],
                "extensions": {
                    "sanctuary": {
                        "program_id": "",
                        "image_details": {
                            "positive": parsed.get("image_positive")
                            or f"solo, {name}",
                            "negative": parsed.get("image_negative")
                            or "extra limbs, bad anatomy, deformed",
                        },
                    }
                },
            },
            "_inversion": inversion,
            "_colors": {"main_color": main_color},
        }

        return card


def finalize_imported_program(program_path, program_id, card_json):
    """Write inversion, theme, portraits dir, and chara_card_v3 JSON for a new program."""
    # Pop helper keys (not part of the card spec)
    inversion = card_json.pop("_inversion", None) or card_json.pop("inversion", None)
    if not isinstance(inversion, dict) or not inversion:
        inversion = {
            "intimate": f"{program_id.title()} is now deeply affectionate and tender.",
            "excited": f"{program_id.title()} is now playful and energetic.",
            "intense": f"{program_id.title()} is now focused and direct.",
            "sad": f"{program_id.title()} is now empathetic and gentle."
        }

    colors = card_json.pop("_colors", None) or card_json.pop("colors", None) or {}
    main_color = normalize_hex_color(colors.get("main_color"))

    # Write inversion.json
    with open(os.path.join(program_path, 'inversion.json'), "w", encoding="utf-8") as f:
        json.dump(inversion, f, indent=2, ensure_ascii=False)

    # Generate theme from main_color
    theme_data = generate_character_theme(main_color)
    with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
        json.dump(theme_data, tf, indent=2, ensure_ascii=False)

    os.makedirs(os.path.join(program_path, 'portraits'), exist_ok=True)

    # Stamp program_id into the sanctuary extension
    if card_json.get("data"):
        exts = card_json["data"].setdefault("extensions", {})
        exts.setdefault("sanctuary", {})["program_id"] = program_id
    else:
        # Flat format compatibility
        card_json["program_id"] = program_id

    with open(os.path.join(program_path, f"{program_id}.json"), "w", encoding="utf-8") as f:
        json.dump(card_json, f, indent=2, ensure_ascii=False)


@programs_bp.route('/api/programs/<program_id>/export/card', methods=['GET'])
@st.requires_auth
def export_program_card(program_id):
    """Download the program's card as a SillyTavern-compatible JSON file."""
    try:
        pass
        program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
        if not os.path.exists(program_dir):
            for f in os.listdir(vs.PROGRAMS_DIR):
                if f.lower() == program_id.lower():
                    program_id = f
                    program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
                    break
        if not os.path.exists(program_dir):
            return jsonify({'error': f"Program '{program_id}' not found"}), 404

        card_path = os.path.join(program_dir, f'{program_id}.json')
        if not os.path.exists(card_path):
            json_candidates = [
                f for f in os.listdir(program_dir)
                if f.endswith('.json') and f not in ('theme.json', 'inversion.json', 'databank.json', 'journals.json', 'quest_log.json')
            ]
            if json_candidates:
                card_path = os.path.join(program_dir, json_candidates[0])
            else:
                return jsonify({'error': 'Program card JSON not found'}), 404

        with open(card_path, 'r', encoding='utf-8') as f:
            card_data = json.load(f)

        name = card_data.get('data', card_data).get('name', program_id)
        safe_name = re.sub(r'[^\w\- ]', '', name).strip().replace(' ', '_') or program_id

        if 'data' in card_data and 'spec' in card_data:
            export_data = {k: v for k, v in card_data.items() if k in ('spec', 'spec_version', 'data')}
        elif 'data' in card_data:
            export_data = {
                'spec': 'chara_card_v3',
                'spec_version': '3.0',
                'data': card_data['data']
            }
        else:
            export_data = {
                'spec': 'chara_card_v3',
                'spec_version': '3.0',
                'data': card_data
            }

        resp = make_response(json.dumps(export_data, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json; charset=utf-8'
        resp.headers['Content-Disposition'] = f'attachment; filename="{safe_name}.json"'
        return resp
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/<program_id>/export/lorebook', methods=['GET'])
@st.requires_auth
def export_program_lorebook(program_id):
    """Download the embedded character_book as a standalone lorebook JSON."""
    try:
        pass
        program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
        if not os.path.exists(program_dir):
            for f in os.listdir(vs.PROGRAMS_DIR):
                if f.lower() == program_id.lower():
                    program_id = f
                    program_dir = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, program_id))
                    break
        if not os.path.exists(program_dir):
            return jsonify({'error': f"Program '{program_id}' not found"}), 404

        card_path = os.path.join(program_dir, f'{program_id}.json')
        if not os.path.exists(card_path):
            json_candidates = [
                f for f in os.listdir(program_dir)
                if f.endswith('.json') and f not in ('theme.json', 'inversion.json', 'databank.json', 'journals.json', 'quest_log.json')
            ]
            if json_candidates:
                card_path = os.path.join(program_dir, json_candidates[0])
            else:
                return jsonify({'error': 'Program card JSON not found'}), 404

        with open(card_path, 'r', encoding='utf-8') as f:
            card_data = json.load(f)

        cb = card_data.get('data', card_data).get('character_book')
        if not cb:
            return jsonify({'error': 'No embedded lorebook found in this card'}), 404

        name = cb.get('name') or card_data.get('data', card_data).get('name', program_id)
        safe_name = re.sub(r'[^\w\- ]', '', name).strip().replace(' ', '_') or 'lorebook'
        resp = make_response(json.dumps(cb, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json; charset=utf-8'
        resp.headers['Content-Disposition'] = f'attachment; filename="{safe_name}_lorebook.json"'
        return resp
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/import/tavern', methods=['POST'])
@st.requires_auth
def import_tavern_program():
    try:
        if 'card' not in request.files:
            return jsonify({'error': 'No card file provided'}), 400

        file = request.files['card']
        if not file.filename:
            return jsonify({'error': 'No file selected'}), 400

        import re, base64, io
        from PIL import Image

        file_bytes = file.read()
        if not file_bytes:
            return jsonify({'error': 'Uploaded file is empty'}), 400

        chara = None
        is_png = False

        # Detect PNG card format vs raw JSON card format
        if file_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
            is_png = True
            try:
                with Image.open(io.BytesIO(file_bytes)) as img:
                    chara_data = None
                    for key in ('chara', 'ccv3', 'Character'):
                        if key in img.info:
                            chara_data = img.info[key]
                            break
                    if not chara_data:
                        for key, val in img.info.items():
                            if isinstance(val, str) and len(val) > 20:
                                try:
                                    test_json = json.loads(val)
                                    if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json or "spec" in test_json):
                                        chara_data = val
                                        break
                                except Exception:
                                    try:
                                        decoded = base64.b64decode(val).decode('utf-8')
                                        test_json = json.loads(decoded)
                                        if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json or "spec" in test_json):
                                            chara_data = val
                                            break
                                    except Exception:
                                        pass

                    if not chara_data:
                        raise ValueError("No character metadata chunk found in PNG card.")

                    try:
                        chara = json.loads(base64.b64decode(chara_data).decode('utf-8'))
                    except Exception:
                        chara = json.loads(chara_data)
            except Exception as e:
                return jsonify({'error': f"Failed to parse PNG character card: {str(e)}"}), 400
        else:
            # Parse directly as JSON (chara_card_v3, chara_card_v2, or legacy ST JSON)
            try:
                text_content = None
                for encoding in ('utf-8-sig', 'utf-8', 'latin-1'):
                    try:
                        text_content = file_bytes.decode(encoding)
                        break
                    except Exception:
                        continue
                if not text_content:
                    raise ValueError("Unable to decode file content as text/JSON.")
                chara = json.loads(text_content)
                if not isinstance(chara, dict):
                    raise ValueError("Character card JSON root must be an object.")
            except Exception as e:
                return jsonify({'error': f"Failed to parse Character Card JSON: {str(e)}"}), 400

        if not chara or not isinstance(chara, dict):
            return jsonify({'error': 'Invalid character card data structure'}), 400

        # --- Convert to chara_card_v3 (bypass LLM — use the card data directly) ---
        spec = chara.get('spec', '')
        if spec == 'chara_card_v3':
            # Already v3 — use verbatim
            card_v3 = chara
            if not isinstance(card_v3.get('data'), dict):
                card_v3['data'] = {}
            data_block = card_v3['data']
        else:
            # v1 / v2 flat or wrapped — normalise to v3
            data_block = chara.get('data', chara)
            card_v3 = {
                "spec": "chara_card_v3",
                "spec_version": "3.0",
                "data": {
                    "name": data_block.get("name", "Program"),
                    "description": data_block.get("description", ""),
                    "personality": data_block.get("personality", ""),
                    "scenario": data_block.get("scenario", ""),
                    "first_mes": data_block.get("first_mes", ""),
                    "mes_example": data_block.get("mes_example", ""),
                    "system_prompt": data_block.get("system_prompt", ""),
                    "post_history_instructions": data_block.get("post_history_instructions", ""),
                    "creator_notes": data_block.get("creator_notes", ""),
                    "tags": data_block.get("tags", []),
                    "creator": data_block.get("creator", ""),
                    "character_version": data_block.get("character_version", "1.0"),
                    "alternate_greetings": data_block.get("alternate_greetings", []),
                    "character_book": data_block.get("character_book"),
                    "extensions": data_block.get("extensions", {}),
                }
            }
            # Remove None character_book
            if card_v3["data"]["character_book"] is None:
                del card_v3["data"]["character_book"]

        name = card_v3["data"].get("name", "Program").strip()
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower() or ("program_" + str(int(time.time())))
        program_path = os.path.join(st.base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400

        # Ensure sanctuary extension block
        exts = card_v3["data"].setdefault("extensions", {})
        sanctuary = exts.setdefault("sanctuary", {})
        sanctuary["program_id"] = program_id
        if "image_details" not in sanctuary:
            sanctuary["image_details"] = {"positive": "", "negative": ""}

        # Derive inversion and color from existing extensions or use defaults
        inversion = sanctuary.pop("inversion", None) or card_v3.pop("_inversion", None) or {
            "intimate": f"{name} is now deeply affectionate and tender.",
            "excited": f"{name} is now playful and energetic.",
            "intense": f"{name} is now focused and direct.",
            "sad": f"{name} is now empathetic and gentle."
        }
        main_color = normalize_hex_color(sanctuary.pop("main_color", None) or card_v3.pop("_colors", {}).get("main_color", None))

        card_v3["_inversion"] = inversion
        card_v3["_colors"] = {"main_color": main_color}

        os.makedirs(program_path, exist_ok=True)
        portraits_dir = os.path.join(program_path, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)

        # Save profile image if imported from PNG card
        if is_png:
            try:
                profile_path = os.path.join(portraits_dir, 'profile.png')
                with open(profile_path, 'wb') as pf:
                    pf.write(file_bytes)
            except Exception as pe:
                print(f"Warning: Could not save profile portrait: {pe}")

        finalize_imported_program(program_path, program_id, card_v3)
        st.broadcast_status()
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})

    except Exception as e:
        traceback.print_exc()
        if 'program_path' in locals() and program_path and os.path.exists(program_path):
            shutil.rmtree(program_path, ignore_errors=True)
        return jsonify({'error': str(e)}), 500


@programs_bp.route('/api/programs/import/describe', methods=['POST'])
@st.requires_auth
def import_describe_program():
    program_path = None
    try:
        data = request.get_json(silent=True) or {}
        name = data.get('name', '').strip()
        description = data.get('description', '').strip()
        model = data.get('model', '').strip()
        
        if not name or not description:
            return jsonify({'error': 'Name and description are required'}), 400
            
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower()
        if not program_id:
            program_id = "program_" + str(int(time.time()))
            
        program_path = os.path.join(st.base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
            
        # 1. Generate character card JSON first
        card_json = generate_character_json(name, description, "", "", "", model)
        
        # 2. Only create directory and write files once card generation succeeds
        os.makedirs(program_path, exist_ok=True)
        finalize_imported_program(program_path, program_id, card_json)
        st.broadcast_status()
            
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})
    except Exception as e:
        traceback.print_exc()
        if program_path and os.path.exists(program_path):
            shutil.rmtree(program_path, ignore_errors=True)
        return jsonify({'error': str(e)}), 500

