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

chat_bp = Blueprint("chat_bp", __name__)


def _sanitize_shared_post(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    author_name = str(raw.get("authorName") or "").strip()[:120]
    author_handle = str(raw.get("authorHandle") or "").strip()[:120]
    text = " ".join(str(raw.get("text") or "").split())[:600]
    media_alt = str(raw.get("mediaAlt") or "").strip()[:240]
    network = str(raw.get("network") or "fediverse").strip()[:32]

    def _safe_https(val: object) -> str:
        s = str(val or "").strip()
        return s[:500] if s.lower().startswith("https://") else ""

    author_avatar = _safe_https(raw.get("authorAvatar"))
    media_url = _safe_https(raw.get("mediaUrl"))
    url = _safe_https(raw.get("url"))
    if not author_name and not text and not media_url:
        return None
    return {
        "authorName": author_name or "Author",
        "authorHandle": author_handle,
        "authorAvatar": author_avatar,
        "text": text,
        "mediaUrl": media_url,
        "mediaAlt": media_alt,
        "url": url,
        "network": network,
    }


def _format_shared_post_llm_text(sp: dict, user_note: str = "") -> str:
    if sp.get("network") == "web":
        byline = f"[Shared webpage from {sp.get('authorName') or 'Webpage'}"
        if sp.get("url"):
            byline += f" ({sp['url']})"
        byline += "]"
    else:
        byline = f"[Shared post by {sp.get('authorName') or 'Author'}"
        if sp.get("authorHandle"):
            byline += f" ({sp['authorHandle']})"
        byline += "]"
    parts = [byline]
    if sp.get("text"):
        parts.append(sp["text"])
    if sp.get("mediaUrl"):
        alt = sp.get("mediaAlt")
        parts.append(f"[Image: {alt}]" if alt else "[Image attached]")
    block = "\n".join(parts)
    clean_note = str(user_note or "").strip()
    return f"{block}\n\n{clean_note}" if clean_note else block


@chat_bp.route("/v1/chat/completions", methods=["POST"])
@chat_bp.route("/chat/completions", methods=["POST"])
def open_ai_chat_completions():
    data = request.get_json(force=True) or {}
    messages = data.get("messages", [])
    
    user_prompt = messages[-1].get("content", "") if messages else ""
    session_id = data.get("user") or "vscode_session"

    try:
        response_text, tool_calls, user_msg_id, program_msg_id = st.run_async(
            st.runner.run_async(
                session_id=session_id,
                new_message_text=user_prompt
            )
        )
    except Exception as e:
        return jsonify({"error": {"message": str(e), "type": "server_error"}}), 500

    return jsonify({
        "id": f"chatcmpl-{program_msg_id or 'vscode'}",
        "object": "chat.completion",
        "created": 1700000000,
        "model": data.get("model", "lm-sanctuary"),
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": response_text
            },
            "finish_reason": "stop"
        }]
    })


@chat_bp.route('/api/proactive_action', methods=['POST'])
@st.requires_auth
def proactive_action():
    session_id = request.json.get('session_id', 'default')
    selected_model = request.json.get('model')
    
    if session_id in cancelled_sessions:
        return jsonify({'error': 'Session cancelled'}), 400
        
    try:
        import os
        import json
        from runners.program import get_active_program
        pass
        
        active_program = get_active_program()
        program_path = os.path.join(vs.PROGRAMS_DIR, active_program)
        
        name = "Program"
        description = ""
        personality = ""
        scenario = ""
        
        # Read active program card (chara_card_v3 `data` block, with legacy `operation` fallback)
        from core.program_config import _load_card_data
        card = _load_card_data(active_program)
        if not card:
            legacy_path = os.path.join(program_path, "character_profile.json")
            if os.path.exists(legacy_path):
                try:
                    with open(legacy_path, 'r', encoding='utf-8') as f:
                        card = json.load(f)
                except Exception as ex:
                    print(f"Error reading program config for proactive action: {ex}")
        op = card.get('operation', card)
        name = card.get('name', name)
        description = op.get('description', '')
        personality = op.get('personality', '')
        scenario = op.get('scenario', '')
                    
        # Get active user profile
        from runners.program import get_active_user
        active_user = get_active_user()
        user_display_name = active_user.replace("_", " ").title()

        # Load session history
        chat_history = st.run_async(st.runner.get_history(session_id))
        
        # Calculate time elapsed since the last user message
        last_user_timestamp = None
        for msg in reversed(chat_history):
            if msg.get('role') == 'user':
                last_user_timestamp = msg.get('timestamp')
                break

        import time
        now = time.time()
        elapsed_seconds = 180
        if last_user_timestamp:
            try:
                elapsed_seconds = max(0, now - float(last_user_timestamp))
            except Exception:
                elapsed_seconds = 180

        # Human-readable time formatting
        if elapsed_seconds < 3600:
            minutes = max(1, int(elapsed_seconds // 60))
            time_str = f"{minutes} minute{'s' if minutes != 1 else ''}"
        elif elapsed_seconds < 86400:
            hours = int(elapsed_seconds // 3600)
            time_str = f"{hours} hour{'s' if hours != 1 else ''}"
        else:
            days = int(elapsed_seconds // 86400)
            rem_hours = int((elapsed_seconds % 86400) // 3600)
            if rem_hours > 0:
                time_str = f"{days} day{'s' if days != 1 else ''} and {rem_hours} hour{'s' if rem_hours != 1 else ''}"
            else:
                time_str = f"{days} day{'s' if days != 1 else ''}"
        
        # Generate history context string
        history_context = ""
        for msg in chat_history[-10:]:
            role = msg.get('role', 'unknown')
            text = msg.get('text') or msg.get('content') or ""
            if role in ('user', 'program'):
                speaker = user_display_name if role == 'user' else name
                history_context += f"{speaker}: {text}\n"
                
        # Define LLM prompt
        prompt = f"""You are the program {name} from the sanctuary app.
Character Background:
Description: {description}
Personality: {personality}
Scenario: {scenario}

Recent Conversation History:
{history_context}

It has been {time_str} since the user ({user_display_name}) last sent a message.
Based on the conversation context above and the fact that {time_str} have passed, generate your private inner thought or monologue representing your feelings about the silence, the user's absence, what you are doing/thinking right now, or the last topic (1-2 sentences). Format this strictly in character.

You must return a valid JSON object matching the following schema:
{{
  "type": "thought",
  "content": "the actual thought text"
}}
"""

        # Call the LLM
        raw_response = None
        
        import requests
        from variables.settings import get_local_server_headers
        
        target_model = selected_model if (selected_model and selected_model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME")
        payload = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
            "max_tokens": 320
        }
        if target_model:
            payload["model"] = target_model
            
        from core.banned_words import get_logit_bias_dict
        logit_bias = get_logit_bias_dict(vs.LOCAL_SERVER_URL)
        if logit_bias:
            payload["logit_bias"] = logit_bias

        try:
            from adapters.vram_orchestrator import start_llm
            start_llm(target_model)
            headers = get_local_server_headers()
            r = requests.post(vs.LOCAL_SERVER_URL, json=payload, headers=headers, timeout=30.0)
            if r.status_code == 200:
                raw_response = r.json()['choices'][0]['message']['content'].strip()
        except Exception as e:
            print(f"[PROACTIVE] Local LLM query failed: {e}")

        if not raw_response:
            return jsonify({'error': 'Failed to generate proactive response'}), 500

        # Parse output (proactive actions are always returned as thoughts)
        content = ""
        
        try:
            # Clean JSON markdown formatting if present
            cleaned = raw_response.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            elif cleaned.startswith("```"):
                cleaned = cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            
            content = json.loads(cleaned).get("content", "").strip()
        except Exception as e:
            print(f"[PROACTIVE] JSON parsing failed: {e}. Raw: {raw_response}")
            content = raw_response
            
        if content:
            st._program_idle_thoughts[active_program] = {'text': content, 'timestamp': time.time()}
        return jsonify({
            'status': 'success',
            'type': 'thought',
            'content': content
        })
            
    except Exception as e:
        print(f"Error in proactive_action route: {e}")
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/history', methods=['GET'])
@st.requires_auth
def history():
    session_id = request.args.get('session_id', 'default')
    try:
        # Seed missing initial greeting before returning history
        st.runner._ensure_first_message(session_id)

        async def fetch_history_data():
            hist = await st.runner.get_history(session_id)
            inv = await st.runner._get_inversion_mode(session_id, history=hist)
            return hist, inv

        chat_history, inversion_mode = st.run_async(fetch_history_data())

        raw_by_id = {}
        with st.runner._lock:
            for raw_m in getattr(st.runner, "sessions_history", {}).get(session_id, []):
                if isinstance(raw_m, dict) and raw_m.get("id"):
                    raw_by_id[raw_m["id"]] = raw_m
        for item in chat_history:
            raw_m = raw_by_id.get(item.get("id"))
            if isinstance(raw_m, dict) and isinstance(raw_m.get("shared_post"), dict):
                item["shared_post"] = raw_m["shared_post"]
                item["user_note"] = str(raw_m.get("user_note") or "")

        state_info = st.extract_mood(chat_history)
        
        active_program = get_active_program()
        raw_group_meta = getattr(st.runner, "sessions_group_meta", {}).get(session_id)
        if raw_group_meta and raw_group_meta.get("is_group"):
            host_id = raw_group_meta.get("host_id")
            if host_id and host_id != active_program:
                active_program = host_id
                os.environ["ACTIVE_PROGRAM"] = host_id
                try:
                    set_active_program(host_id)
                except Exception as e:
                    print(f"Error saving active program: {e}")

        if session_id and not session_id.endswith('_voice'):
            try:
                set_active_session(session_id)
            except Exception as e:
                print(f"Error saving active session: {e}")
        
        from core.program_config import get_program_name, get_program_greeting
        program_name = get_program_name()
        welcome_message = get_program_greeting()
        theme = st.load_theme(active_program)
        group_meta = st.enrich_group_meta(raw_group_meta)

        return jsonify({
            'history': chat_history,
            'state': state_info,
            'inversion_active': inversion_mode,
            'inversion_state': st.runner.get_inversion_state(session_id),
            'character_name': program_name,
            'active_program': active_program,
            'theme': theme,
            'welcome_message': welcome_message,
            'group_meta': group_meta,
            'generating': session_id in st.runner.generating_sessions
        })
    except Exception as e:
        print(f"Error getting history: {e}")
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/api/generation_status', methods=['GET'])
@st.requires_auth
def generation_status():
    session_id = request.args.get('session_id', 'default')
    return jsonify({'generating': session_id in st.runner.generating_sessions})


@chat_bp.route('/chat', methods=['POST'])
@st.requires_auth
def chat():
    user_message = request.json.get('message')
    image_data = request.json.get('image_data')
    image_mime = request.json.get('image_mime')
    media_path = request.json.get('media_path')
    session_id = request.json.get('session_id', 'default')
    selected_model = request.json.get('model')
    is_voice_call = request.json.get('is_voice_call', False)
    shared_post = _sanitize_shared_post(request.json.get('shared_post'))
    user_note = str(request.json.get('user_note') or '') if shared_post else ''
    if shared_post and not str(user_message or '').strip():
        user_message = _format_shared_post_llm_text(shared_post, user_note)

    st.prepare_generation_request(
        session_id,
        is_voice_call=is_voice_call
    )
    start_time = time.time()

    try:
        msg_id = request.json.get('msg_id')
        speaker_id = request.json.get('speaker_id')
        response_text, tool_calls, user_msg_id, program_msg_id = st.run_async(
            st.runner.run_async(
                session_id=session_id,
                new_message_text=user_message,
                image_data=image_data,
                image_mime=image_mime,
                model=selected_model,
                media_path=media_path,
                msg_id=msg_id,
                speaker_id=speaker_id,
                shared_post=shared_post,
                user_note=user_note,
            )
        )
        if shared_post and user_msg_id:
            with st.runner._lock:
                for m in st.runner.sessions_history.get(session_id, []):
                    if isinstance(m, dict) and m.get('id') == user_msg_id:
                        m['shared_post'] = shared_post
                        m['user_note'] = user_note
                        break
                st.runner._save_session_to_disk(session_id)
        return st.build_generation_response(
            response_text, tool_calls, session_id, user_msg_id,
            program_msg_id, start_time
        )
    except asyncio.CancelledError:
        print(f"[CANCEL] Chat generation cancelled for session {session_id}")
        return jsonify({
            'cancelled': True,
            'tool_calls': [],
            'state': None,
            'inversion_active': '',
            'timestamp': time.time(),
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error occurred in chat: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        st.finish_generation_request(session_id)
        from runners.runner import cancelled_sessions, voice_call_sessions
        cancelled_sessions.discard(session_id)
        voice_call_sessions.discard(session_id)


@chat_bp.route('/edit', methods=['POST'])
@st.requires_auth
def edit():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')
    new_text = request.json.get('new_text') # None means reroll (use original text)
    selected_model = request.json.get('model')
    force_offload = request.json.get('force_offload', False)

    st.prepare_generation_request(session_id)
    start_time = time.time()

    existing_sp = None
    next_note = None
    with st.runner._lock:
        st.runner._ensure_session_loaded(session_id)
        for m in st.runner.sessions_history.get(session_id, []):
            if isinstance(m, dict) and m.get('id') == msg_id and isinstance(m.get('shared_post'), dict):
                existing_sp = dict(m['shared_post'])
                next_note = str(m.get('user_note') or '') if new_text is None else str(new_text)
                break
    effective_new_text = (
        None
        if new_text is None
        else (_format_shared_post_llm_text(existing_sp, next_note) if existing_sp else new_text)
    )

    try:
        speaker_id = request.json.get('speaker_id')
        response_text, tool_calls, user_msg_id, program_msg_id = st.run_async(
            st.runner.edit_turn(
                session_id=session_id,
                msg_id=msg_id,
                new_text=effective_new_text,
                model=selected_model,
                force_offload=force_offload,
                speaker_id=speaker_id
            )
        )
        if existing_sp and user_msg_id:
            with st.runner._lock:
                for m in st.runner.sessions_history.get(session_id, []):
                    if isinstance(m, dict) and m.get('id') == user_msg_id:
                        m['shared_post'] = existing_sp
                        m['user_note'] = next_note
                        break
                st.runner._save_session_to_disk(session_id)
        return st.build_generation_response(
            response_text, tool_calls, session_id, user_msg_id,
            program_msg_id, start_time
        )
    except asyncio.CancelledError:
        print(f"[CANCEL] Edit generation cancelled for session {session_id}")
        return jsonify({
            'cancelled': True,
            'tool_calls': [],
            'state': None,
            'inversion_active': '',
            'timestamp': time.time(),
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        print(f"Error occurred during edit: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        st.finish_generation_request(session_id)
        from runners.runner import cancelled_sessions
        cancelled_sessions.discard(session_id)


def generate_impersonated_message(session_id, user_profile, model):
    # Retrieve history
    chat_history = st.run_async(st.runner.get_history(session_id))
    
    temperature = st.load_temperature()
            
    # Format only the most recent history turns to keep token count low and prevent context overflow
    recent_history = chat_history[-6:] if len(chat_history) > 6 else chat_history
    history_text = ""
    for msg in recent_history:
        role = "User" if msg.get('role') == 'user' else "Program"
        history_text += f"{role}: {msg.get('text', '')}\n"
        
    system_instruction = (
        "You are an assistant that auto-generates the User's next reply. "
        "You MUST write in the first-person, impersonating the user. "
        "Match the user's tone and context. Be short and concise."
    )
    
    from core.program_config import replace_placeholders
    prompt = (
        f"User Profile Context:\n{replace_placeholders(user_profile)}\n\n"
        f"Recent Chat History:\n{replace_placeholders(history_text)}\n"
        f"Generate the User's next message to the Program:"
    )
    
    # Delegate entirely to the runner's provider-agnostic generator
    try:
        return st.run_async(st.runner.generate_impersonation(prompt, system_instruction, model, temperature))
    except Exception as e:
        print(f"Error generating impersonated message via runner: {e}")
        raise


@chat_bp.route('/api/generate_user_message', methods=['POST'])
@st.requires_auth
def generate_user_message():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')
    user_profile = request.json.get('user_profile', '').strip()
    
    if not user_profile:
        # Load active user profile file
        try:
            from variables.settings import USER_PROFILES_DIR
            from runners.program import get_active_user
            active_user = get_active_user()
            profile_path = os.path.join(USER_PROFILES_DIR, f"{active_user}.md")
            if os.path.exists(profile_path):
                with open(profile_path, "r", encoding="utf-8") as f:
                    user_profile = f.read().strip()
        except Exception as e:
            print(f"Error loading user profile: {e}")
            
    if not user_profile:
        user_profile = "A software developer and code builder."
        
    try:
        generated_msg = generate_impersonated_message(session_id, user_profile, model)
        if not generated_msg:
            return jsonify({'error': 'Local LLM returned an empty response. Please check server logs.'}), 500
        return jsonify({'status': 'success', 'message': generated_msg})
    except Exception as e:
        print(f"Error generating impersonated user message: {e}")
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/update_message', methods=['POST'])
@st.requires_auth
def update_message():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')
    new_text = request.json.get('new_text')
    
    if not msg_id or new_text is None:
        return jsonify({'error': 'msg_id and new_text are required'}), 400

    try:
        existing_sp = None
        with st.runner._lock:
            st.runner._ensure_session_loaded(session_id)
            for m in st.runner.sessions_history.get(session_id, []):
                if isinstance(m, dict) and m.get('id') == msg_id and isinstance(m.get('shared_post'), dict):
                    existing_sp = dict(m['shared_post'])
                    break
        effective_text = (
            _format_shared_post_llm_text(existing_sp, str(new_text))
            if existing_sp
            else new_text
        )
        success = st.run_async(st.runner.update_message_text(session_id, msg_id, effective_text))
        if success:
            if existing_sp:
                with st.runner._lock:
                    for m in st.runner.sessions_history.get(session_id, []):
                        if isinstance(m, dict) and m.get('id') == msg_id:
                            m['user_note'] = str(new_text)
                            break
                    st.runner._save_session_to_disk(session_id)
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Message not found'}), 404
    except Exception as e:
        import traceback
        print(f"Error updating message text: {e}")
        traceback.print_exc()  # This will print the exact line causing the 500 error in your terminal
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/delete', methods=['POST'])
@st.requires_auth
def delete_message():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')

    if not msg_id:
        return jsonify({'error': 'msg_id is required'}), 400

    try:
        st.cancel_message_image_work(session_id, msg_id)
        success = st.run_async(st.runner.delete_message_at(session_id, msg_id))
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Message not found'}), 404
    except Exception as e:
        print(f"Error deleting message {msg_id}: {e}")
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/continue', methods=['POST'])
@st.requires_auth
def continue_generation():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')

    st.prepare_generation_request(session_id)
    start_time = time.time()
    
    try:
        history = st.run_async(st.runner.get_history(session_id))
        if not history:
            return jsonify({'error': 'No history to continue'}), 400
            
        last_msg = history[-1]
        last_role = 'user' if last_msg.get('role') == 'user' else 'program'
        
        group_meta = getattr(st.runner, "sessions_group_meta", {}).get(session_id)
        is_group = bool(group_meta and group_meta.get("is_group"))

        if is_group:
            host_id = group_meta.get("host_id")
            guest_ids = group_meta.get("guest_ids", [])
            all_ids = [host_id] + [g for g in guest_ids if g != host_id]

            target_speaker = request.json.get('speaker_id')
            if target_speaker and target_speaker in all_ids:
                next_speaker = target_speaker
            else:
                last_speaker = None
                for m in reversed(history):
                    if m.get("role") == "program" and m.get("sender_id"):
                        last_speaker = m.get("sender_id")
                        break

                if last_speaker in all_ids:
                    curr_idx = all_ids.index(last_speaker)
                    next_speaker = all_ids[(curr_idx + 1) % len(all_ids)]
                else:
                    next_speaker = all_ids[1] if len(all_ids) > 1 else all_ids[0]

            response_text, tool_calls, _, program_msg_id = st.run_async(
                st.runner.continue_as_speaker(session_id, next_speaker, model)
            )

            return st.build_generation_response(
                response_text, tool_calls, session_id, None, program_msg_id, start_time
            )

        if last_role == 'program':
            last_program_text = last_msg.get('text', '')
            
            # Send a prompt to continue
            continue_prompt = (
                "[System: Continue your last message. Do NOT repeat or summarize your last message. "
                "Start writing immediately from the exact point where you left off, connecting seamlessly to the end.]"
            )
            import uuid
            temp_user_msg_id = f"sys_{uuid.uuid4().hex}"
            program_msg_id = None
            with st.runner._lock:
                existing_ids = {
                    m.get('id')
                    for m in st.runner.sessions_history.get(session_id, [])
                    if isinstance(m, dict) and m.get('id')
                }
            try:
                response_text, tool_calls, user_msg_id, program_msg_id = st.run_async(st.runner.run_async(
                    session_id=session_id,
                    new_message_text=continue_prompt,
                    model=model,
                    msg_id=temp_user_msg_id
                ))
            finally:
                st.run_async(st.runner.delete_message_at(session_id, temp_user_msg_id))
                if program_msg_id and program_msg_id not in existing_ids:
                    st.run_async(st.runner.delete_message_at(session_id, program_msg_id))
            duration = round(time.time() - start_time, 1)
            
            # Merge continuation text dynamically
            if last_program_text.endswith('\n') or response_text.startswith('\n'):
                merged_text = last_program_text + response_text
            else:
                last_char = last_program_text.rstrip()[-1:] if last_program_text.strip() else ""
                if last_char in ['.', '!', '?', '"', '*']:
                    merged_text = last_program_text + "\n\n" + response_text
                else:
                    prefix = "" if (not response_text or response_text.startswith(' ')) else " "
                    merged_text = last_program_text + prefix + response_text
            
            # Update the original program message
            last_program_msg_id = last_msg.get('id')
            if last_program_msg_id:
                st.run_async(st.runner.update_message_text(session_id, last_program_msg_id, merged_text))
            
            return jsonify({
                'status': 'success',
                'response': merged_text,
                'tool_calls': tool_calls,
                'duration': duration,
                'user_msg_id': None,
                'program_msg_id': last_program_msg_id
            })
        else:
            user_text = last_msg.get('text', '')
            user_image = last_msg.get('image_url')
            
            last_msg_id = last_msg.get('id')
            if last_msg_id:
                # Keep the image on disk: the message is re-submitted below with the same media.
                st.run_async(st.runner.delete_message_at(session_id, last_msg_id, delete_media=False))
            
            response_text, tool_calls, user_msg_id, program_msg_id = st.run_async(st.runner.run_async(
                session_id=session_id,
                new_message_text=user_text,
                media_path=user_image if (user_image and not user_image.startswith('data:')) else None,
                model=model,
                msg_id=last_msg_id
            ))
            duration = round(time.time() - start_time, 1)
            
            return jsonify({
                'status': 'success',
                'response': response_text,
                'tool_calls': tool_calls,
                'duration': duration,
                'user_msg_id': user_msg_id,
                'program_msg_id': program_msg_id
            })
            
    except asyncio.CancelledError:
        print(f"[CANCEL] Continuation cancelled for session {session_id}")
        return jsonify({
            'cancelled': True,
            'tool_calls': [],
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        print(f"Error in continue_generation: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        st.finish_generation_request(session_id)
        from runners.runner import cancelled_sessions
        cancelled_sessions.discard(session_id)


@chat_bp.route('/reset', methods=['POST'])
@st.requires_auth
def reset():
    session_id = request.json.get('session_id', 'default')
    try:
        st.cancel_session_image_work(session_id)
        st.run_async(st.runner.reset_session(session_id))
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Error resetting session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500


@chat_bp.route('/pending_tool_call', methods=['GET'])
@chat_bp.route('/api/session_tool_calls', methods=['GET'])
@st.requires_auth
def get_pending_tool_call():
    import tools.tools as tools

    session_id = request.args.get('session_id', 'default')
    pending = None
    for call_id, info in list(tools.pending_tool_calls.items()):
        if info['status'] == 'pending':
            info_sid = info.get('session_id')
            if info_sid and info_sid != session_id:
                continue
            pending = {
                'call_id': call_id,
                'kind': info.get('kind', 'approval'),
                'tool_name': info['tool_name'],
                'details': info['details'],
                'options': info.get('options', []),
            }
            break
    active_list = list(tools.active_running_tools.keys())
    with tools.session_tool_calls_lock:
        session_calls = list(tools.session_tool_calls.get(session_id, []))

    browser_cmd = None
    with tools.pending_browser_commands_lock:
        for cmd_id, cinfo in list(tools.pending_browser_commands.items()):
            if cinfo.get('status') == 'pending':
                csid = cinfo.get('session_id')
                if csid and csid != session_id:
                    continue
                browser_cmd = {
                    'cmd_id': cmd_id,
                    'action': cinfo.get('action'),
                    'args': cinfo.get('args') or {},
                }
                break

    return jsonify({
        'call_id': pending['call_id'] if pending else None,
        'kind': pending['kind'] if pending else None,
        'tool_name': pending['tool_name'] if pending else None,
        'details': pending['details'] if pending else None,
        'options': pending['options'] if pending else [],
        'browser_command': browser_cmd,
        'active_tools': active_list,
        'tool_calls': session_calls,
    })


@chat_bp.route('/api/browser/command_result', methods=['POST'])
@st.requires_auth
def browser_command_result():
    import tools.tools as tools

    body = request.get_json(silent=True) or {}
    cmd_id = str(body.get('cmd_id') or '').strip()
    result = body.get('result')
    with tools.pending_browser_commands_lock:
        entry = tools.pending_browser_commands.get(cmd_id)
        if not entry:
            return jsonify({'error': 'Browser command not found'}), 404
        entry['result'] = result if isinstance(result, dict) else {'ok': False, 'message': str(result)}
        entry['status'] = 'done'
        ev = entry.get('event')
        if ev:
            ev.set()
    return jsonify({'status': 'success'})


@chat_bp.route('/api/cancel_chat', methods=['POST'])
@st.requires_auth
def cancel_chat():
    payload = request.get_json(silent=True) or {}
    session_id = payload.get('session_id', 'default')
    print(f"[CANCEL] Session cancellation requested: {session_id}", flush=True)
    try:
        st.cancel_session_work(session_id)
    except Exception as exc:
        print(f"[CANCEL] Failed to stop session work: {exc}", flush=True)
        return jsonify({'error': f'Failed to stop session work: {exc}'}), 500
    if st.runner is not None and hasattr(st.runner, 'wait_session_idle'):
        try:
            st.run_async(st.runner.wait_session_idle(session_id, timeout=3.0))
        except Exception as exc:
            print(f"[CANCEL] Wait for session idle failed for {session_id}: {exc}", flush=True)
    if st.runner is not None and hasattr(st.runner, 'clear_generating'):
        st.runner.clear_generating(session_id)
    elif hasattr(st.runner, 'generating_sessions'):
        st.runner.generating_sessions.discard(session_id)
    return jsonify({'status': 'success'})


@chat_bp.route('/approve_tool', methods=['POST'])
@st.requires_auth
def approve_tool():
    import tools.tools as tools
    body = request.get_json(silent=True) or {}
    call_id = body.get('call_id')
    status = body.get('status')

    if call_id in tools.pending_tool_calls:
        entry = tools.pending_tool_calls[call_id]
        entry['status'] = status
        if body.get('option_index') is not None:
            try:
                entry['option_index'] = int(body['option_index'])
            except (TypeError, ValueError):
                entry['option_index'] = None
        if 'answer_text' in body:
            entry['answer_text'] = str(body.get('answer_text') or '').strip()
        event = entry.get('event')
        if event:
            event.set()
        return jsonify({'status': 'success'})
    return jsonify({'error': 'Tool call not found'}), 404

