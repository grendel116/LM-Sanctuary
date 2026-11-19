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

voice_bp = Blueprint("voice_bp", __name__)


@voice_bp.route('/sparkle.mp3')
@st.requires_auth
def serve_sparkle_mp3():
    core_dir = os.path.join(st.base_dir, 'core')
    return send_from_directory(core_dir, 'sparkle.mp3')


@voice_bp.route('/speech_cache/<path:filename>')
@st.requires_auth
def serve_speech_cache(filename):
    cache_dir = os.path.join(str(st.base_dir), "core", "skills", "speech_generation", "speech_cache")
    return send_from_directory(cache_dir, filename)


@voice_bp.route('/api/tts', methods=['POST'])
@st.requires_auth
def api_tts():
    try:
        data = request.get_json() or {}
        message_id = data.get('message_id')
        text = data.get('text')
        
        if not message_id or not text:
            return jsonify({'error': 'Missing message_id or text'}), 400
            
        from core.program_config import replace_placeholders
        text = replace_placeholders(text)
        
        from core.skills.speech_generation.speech import SpeechManager
        manager = SpeechManager()
        audio_url = manager.get_speech_file(text, message_id)
        if audio_url:
            return jsonify({'success': True, 'audio_url': audio_url})
        else:
            return jsonify({'success': False, 'error': 'Speech generation failed'}), 500
    except Exception as e:
        print(f"Error in /api/tts: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@voice_bp.route('/api/voice_call/start', methods=['POST'])
@st.requires_auth
def start_voice_call_api():
    try:
        data = request.get_json() or {}
        session_id = data.get('session_id', 'default')
        voice_session_id = f"{session_id}_voice"
        
        # 1. Reset/Clear any existing voice session
        st.run_async(st.runner.reset_session(voice_session_id))
        
        # 2. Clone context from main session to voice session
        st.run_async(st.runner.clone_history(session_id, voice_session_id, []))
        
        print(f"[VOICE CALL] Initialized voice session: {voice_session_id} cloned from {session_id}")
        return jsonify({'success': True})
    except Exception as e:
        print(f"Error in /api/voice_call/start: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@voice_bp.route('/api/voice_call/save', methods=['POST'])
@st.requires_auth
def save_voice_call():
    try:
        data = request.get_json() or {}
        session_id = data.get('session_id', 'default')
        transcript = data.get('transcript')
        voice_session_id = f"{session_id}_voice"
        
        if not transcript:
            return jsonify({'error': 'Missing transcript'}), 400
            
        # 1. Save consolidated transcript message to main session history
        voice_msg = st.run_async(st.runner.append_voice_call(session_id, transcript))
        
        # 2. Reset/Clean up temporary voice session from memory/disk
        st.run_async(st.runner.reset_session(voice_session_id))
        
        print(f"[VOICE CALL] Saved transcript to main session {session_id} and cleared temporary voice session {voice_session_id}")
        
        if voice_msg:
            return jsonify({
                'success': True,
                'message': st.runner._normalize_message(voice_msg) if isinstance(voice_msg, dict) else None,
            })
        else:
            return jsonify({'success': False, 'error': 'Failed to append voice call to session'}), 500
    except Exception as e:
        print(f"Error in /api/voice_call/save: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@voice_bp.route('/api/voice_call/transcribe', methods=['POST'])
@st.requires_auth
def transcribe_voice_api():
    """Transcribes incoming audio chunks from MediaRecorder using local faster-whisper."""
    try:
        from core import stt
        audio_bytes = b""
        if 'audio' in request.files:
            audio_bytes = request.files['audio'].read()
        elif request.data:
            audio_bytes = request.data

        if not audio_bytes:
            return jsonify({'text': '', 'error': 'No audio data received'}), 400

        language = request.args.get('language', 'en')
        text = stt.transcribe_audio_bytes(audio_bytes, language=language)
        return jsonify({'text': text, 'success': True})
    except Exception as e:
        print(f"Error in /api/voice_call/transcribe: {e}")
        return jsonify({'text': '', 'error': str(e)}), 500

