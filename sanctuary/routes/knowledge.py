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
from core.skills.vectorized_databank.databank import DataBankManager

knowledge_bp = Blueprint("knowledge_bp", __name__)


@knowledge_bp.route('/api/databank/files', methods=['GET'])
@st.requires_auth
def databank_list_files():
    try:
        manager = DataBankManager()
        files = manager.list_documents()
        return jsonify({"files": files})
    except Exception as e:
        print(f"Error listing databank files: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/databank/upload', methods=['POST'])
@st.requires_auth
def databank_upload():
    if 'file' not in request.files:
        return jsonify({"error": "No file part in the request"}), 400
        
    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({"error": "No selected file"}), 400
        
    temp_path = None
    try:
        # Create temp folder inside workspace for uploads
        temp_dir = os.path.join(str(st.base_dir), "temp_uploads")
        os.makedirs(temp_dir, exist_ok=True)
        
        # Sanitize filename
        from werkzeug.utils import secure_filename
        filename = secure_filename(uploaded_file.filename)
        temp_path = os.path.join(temp_dir, filename)
        uploaded_file.save(temp_path)
        
        manager = DataBankManager()
        doc_id = manager.ingest_file(temp_path, uploaded_file.filename)
        return jsonify({"status": "success", "id": doc_id})
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error uploading to databank: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        # Clean up temp file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as re:
                print(f"Error cleaning up temporary file {temp_path}: {re}")


@knowledge_bp.route('/api/databank/text', methods=['POST'])
@st.requires_auth
def databank_text():
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '').strip()
    title = (data.get('title') or '').strip()
    if not text:
        return jsonify({"error": "Missing text content"}), 400
    if not title:
        first_line = text.splitlines()[0][:40].strip()
        title = first_line if first_line else "Text Document"
    try:
        manager = DataBankManager()
        doc_id = manager.ingest_text(text, title, "file")
        return jsonify({"status": "success", "id": doc_id})
    except Exception as e:
        print(f"Error ingesting text into databank: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/databank/scrape', methods=['POST'])
@st.requires_auth
def databank_scrape():
    url = (request.json.get('url') or '').strip()
    if not url:
        return jsonify({"error": "Missing URL"}), 400
        
    if ' ' in url or '\n' in url:
        return jsonify({"error": "The input contains spaces or multiple lines. Please enter a valid web URL (e.g. https://example.com/article) or use '+ Paste Text'."}), 400

    if not url.startswith('http://') and not url.startswith('https://'):
        if re.match(r'^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}', url):
            url = 'https://' + url
        else:
            return jsonify({"error": "Please enter a valid web URL starting with https:// (e.g. https://example.com/article)."}), 400

    try:
        manager = DataBankManager()
        doc_id = manager.ingest_url(url)
        return jsonify({"status": "success", "id": doc_id})
    except Exception as e:
        print(f"Error scraping url: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/databank/delete', methods=['POST'])
@st.requires_auth
def databank_delete():
    doc_id = request.json.get('id')
    if not doc_id:
        return jsonify({"error": "Missing document ID"}), 400
        
    try:
        manager = DataBankManager()
        success = manager.delete_document(doc_id)
        if success:
            return jsonify({"status": "success"})
        else:
            return jsonify({"error": "Document not found"}), 404
    except Exception as e:
        print(f"Error deleting document {doc_id}: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/databank/purge', methods=['POST'])
@st.requires_auth
def databank_purge():
    try:
        manager = DataBankManager()
        manager.purge_all()
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"Error purging databank: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/lorebooks', methods=['GET'])
@st.requires_auth
def list_lorebooks_route():
    try:
        from runners.program import get_active_program
        from tools.lorebook import list_lorebooks
        pass
        program_id = get_active_program()
        books = list_lorebooks(program_id, vs.PROGRAMS_DIR)
        for b in books:
            b['program_id'] = program_id
        return jsonify({'lorebooks': books, 'program_id': program_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/import', methods=['POST'])
@st.requires_auth
def import_lorebook_route():
    try:
        from runners.program import get_active_program
        from tools.lorebook import import_lorebook
        pass
        program_id = get_active_program()
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        f = request.files['file']
        if not f.filename or not f.filename.endswith('.json'):
            return jsonify({'error': 'Only .json lorebook files are accepted'}), 400
        book_data = json.loads(f.read().decode('utf-8'))
        dest = import_lorebook(program_id, book_data, f.filename, vs.PROGRAMS_DIR)
        return jsonify({'success': True, 'path': dest})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/<filename>/export', methods=['GET'])
@st.requires_auth
def export_lorebook_route(filename):
    try:
        from runners.program import get_active_program
        pass
        program_id = get_active_program()
        fpath = os.path.join(vs.PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        with open(fpath, encoding='utf-8') as lf:
            book_data = json.load(lf)
        resp = make_response(json.dumps(book_data, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json'
        resp.headers['Content-Disposition'] = f'attachment; filename="{filename}"'
        return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/<filename>/delete', methods=['POST'])
@st.requires_auth
def delete_lorebook_route(filename):
    try:
        from runners.program import get_active_program
        from tools.lorebook import delete_lorebook
        pass
        program_id = get_active_program()
        deleted = delete_lorebook(program_id, filename, vs.PROGRAMS_DIR)
        return jsonify({'success': deleted})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/card/entries', methods=['GET'])
@st.requires_auth
def get_card_lorebook_entries():
    """Return entries from the embedded character_book in the active program card."""
    try:
        from runners.program import get_active_program
        pass
        program_id = get_active_program()
        card_path = os.path.join(vs.PROGRAMS_DIR, program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Card not found'}), 404
        with open(card_path, encoding='utf-8') as f:
            card = json.load(f)
        cb = card.get('data', card).get('character_book', {})
        entries = cb.get('entries', [])
        if isinstance(entries, dict):
            entries = list(entries.values())
        return jsonify({'name': cb.get('name', program_id), 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/card/save', methods=['POST'])
@st.requires_auth
def save_card_lorebook_entries():
    """Write updated entries back into character_book in the active program card."""
    try:
        from runners.program import get_active_program
        pass
        program_id = get_active_program()
        card_path = os.path.join(vs.PROGRAMS_DIR, program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Card not found'}), 404
        data = request.get_json(silent=True) or {}
        with open(card_path, encoding='utf-8') as f:
            card = json.load(f)
        # Navigate to character_book regardless of v2/v3 wrapping
        data_block = card.get('data', card)
        if 'character_book' not in data_block:
            data_block['character_book'] = {'name': program_id, 'entries': []}
        if 'entries' in data:
            data_block['character_book']['entries'] = data['entries']
        with open(card_path, 'w', encoding='utf-8') as f:
            json.dump(card, f, indent=2, ensure_ascii=False)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/<filename>/entries', methods=['GET'])
@st.requires_auth
def get_lorebook_entries(filename):
    """Return the raw entry list for a lorebook file so the UI can render an editor."""
    try:
        from runners.program import get_active_program
        pass
        program_id = get_active_program()
        fpath = os.path.join(vs.PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        with open(fpath, encoding='utf-8') as lf:
            book = json.load(lf)
        # Normalise entries to list form
        entries = book.get('entries', [])
        if isinstance(entries, dict):
            entries = list(entries.values())
        return jsonify({'name': book.get('name', filename), 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/lorebooks/<filename>/save', methods=['POST'])
@st.requires_auth
def save_lorebook_entries(filename):
    """Overwrite a lorebook file with updated entries from the editor."""
    try:
        from runners.program import get_active_program
        pass
        program_id = get_active_program()
        fpath = os.path.join(vs.PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        data = request.get_json(silent=True) or {}
        with open(fpath, encoding='utf-8') as lf:
            book = json.load(lf)
        if 'entries' in data:
            # Store as list (v3 format)
            book['entries'] = data['entries']
        if 'name' in data:
            book['name'] = data['name']
        with open(fpath, 'w', encoding='utf-8') as lf:
            json.dump(book, lf, indent=2, ensure_ascii=False)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/quests', methods=['GET'])
@st.requires_auth
def list_quests():
    try:
        from core import quest_manager
        return jsonify({"quests": quest_manager.load_quests()})
    except Exception as e:
        print(f"Error loading quests: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/quests/<quest_id>/delete', methods=['POST'])
@st.requires_auth
def delete_quest(quest_id):
    try:
        from core import quest_manager
        quest_manager.remove_quest(quest_id)
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"Error deleting quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/quests/<quest_id>/complete', methods=['POST'])
@st.requires_auth
def complete_quest(quest_id):
    try:
        from core import quest_manager
        quest_data = quest_manager.remove_quest(quest_id)
        
        if not quest_data:
            return jsonify({"error": "Quest not found"}), 404
            
        session_id = 'default'
        if request.is_json:
            session_id = request.json.get('session_id', 'default')
            
        title = quest_data.get("title", "")
        objectives = quest_data.get("objectives", [])
        obj_text = f" with objectives: {', '.join(objectives)}" if objectives else ""
        system_message = f"[SYSTEM: User has completed the quest: \"{title}\"{obj_text}]"
        
        st.run_async(st.runner.append_message_to_session(session_id, "user", system_message))
        
        return jsonify({
            "status": "success",
            "title": title,
            "objectives": objectives
        })
    except Exception as e:
        print(f"Error completing quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/quests/<quest_id>/download', methods=['GET'])
@st.requires_auth
def download_quest(quest_id):
    try:
        from core import quest_manager
        from datetime import datetime, timedelta, timezone
        quest = next((q for q in quest_manager.load_quests() if q['id'] == quest_id), None)
        if not quest:
            return jsonify({"error": "Quest not found"}), 404

        title = quest.get('title', 'Quest')
        location = quest.get('location', '')
        objectives = quest.get('objectives', [])
        notes = "\n".join(objectives)

        dt_start = quest_manager.parse_due(quest['due']).astimezone(timezone.utc)
        dt_end = dt_start + timedelta(hours=1)
        
        stamp_str = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        start_str = dt_start.strftime("%Y%m%dT%H%M%SZ")
        end_str = dt_end.strftime("%Y%m%dT%H%M%SZ")
        
        clean_desc = notes.replace("\n", "\\n")
        
        try:
            trigger_minutes = int(quest.get('reminder_minutes', 15))
        except (ValueError, TypeError):
            trigger_minutes = 15

        ics_content = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//The Sanctuary//Quest Giver//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:{quest_id}@thesanctuary
DTSTAMP:{stamp_str}
DTSTART:{start_str}
DTEND:{end_str}
SUMMARY:{title}
DESCRIPTION:{clean_desc}
LOCATION:{location}
BEGIN:VALARM
TRIGGER:-PT{trigger_minutes}M
ACTION:DISPLAY
DESCRIPTION:Reminder: {title} is due soon!
END:VALARM
END:VEVENT
END:VCALENDAR"""

        return Response(
            ics_content.strip(),
            mimetype="text/calendar",
            headers={"Content-Disposition": f"attachment; filename=\"{quest_id}.ics\""}
        )
    except Exception as e:
        print(f"Error downloading quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500


@knowledge_bp.route('/api/programs/journals', methods=['GET'])
@st.requires_auth
def get_program_journals():
    try:
        from runners.program import get_active_program
        from tools.journals import get_journal_entries
        pass
        
        program_id = request.args.get('program_id') or get_active_program()
        session_id = request.args.get('session_id', 'default')
        entries = get_journal_entries(program_id)
        
        # Load memory metadata for the requested program and session
        safe_session_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        session_path = os.path.join(vs.PROGRAMS_DIR, program_id, "sessions", f"{safe_session_id}.json")
        memory_meta = None
        if os.path.exists(session_path):
            try:
                with open(session_path, "r", encoding="utf-8") as f:
                    sdata = json.load(f)
                    memory_meta = sdata.get("memory_state")
            except Exception as se:
                print(f"Error loading session file {session_path}: {se}")

        if memory_meta is None:
            with st.runner._lock:
                st.runner._ensure_session_loaded(session_id)
                memory_meta = st.runner._get_memory_meta(session_id)

        recent_chapters = memory_meta.get('recent_chapters', [])
        if len(recent_chapters) > 2:
            recent_chapters = recent_chapters[-2:]

        return jsonify({
            'journals': entries,
            'recent_chapters': recent_chapters,
            'epic_chronicle': memory_meta.get('epic_chronicle', '')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/programs/journals/delete', methods=['POST'])
@st.requires_auth
def delete_program_journals():
    try:
        from runners.program import get_active_program
        from tools.journals import delete_journal_entry
        
        data = request.get_json(silent=True) or {}
        entry_id = data.get('id')
        program_id = data.get('program_id') or get_active_program()
        
        if not entry_id:
            return jsonify({'error': 'Missing entry id'}), 400
            
        success = delete_journal_entry(entry_id, program_id)
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Failed to delete or entry not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/programs/journals/summary/save', methods=['POST'])
@st.requires_auth
def save_program_summary():
    try:
        data = request.get_json(silent=True) or {}
        session_id = data.get('session_id', 'default')
        summary = data.get('summary', data.get('epic_chronicle', '')).strip()

        st.run_async(st.runner.update_epic_chronicle(session_id, summary))
        return jsonify({'status': 'success', 'epic_chronicle': summary})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@knowledge_bp.route('/api/programs/journals/recent_chapters/save', methods=['POST'])
@st.requires_auth
def save_program_recent_chapter():
    try:
        data = request.get_json(silent=True) or {}
        session_id = data.get('session_id', 'default')
        index = int(data.get('index', 0))
        content = data.get('content', data.get('summary', '')).strip()

        with st.runner._lock:
            st.runner._ensure_session_loaded(session_id)
            chapters = st.runner._get_memory_meta(session_id).get('recent_chapters', [])
        actual_index = len(chapters) - 2 + index if (len(chapters) > 2 and 0 <= index < 2) else index

        success = st.run_async(st.runner.update_recent_chapter(session_id, actual_index, content))
        if success:
            return jsonify({'status': 'success', 'content': content})
        else:
            return jsonify({'error': 'Chapter index out of range or not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

