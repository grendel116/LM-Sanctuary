import os
import json
import uuid
import time
import re
from utils.program import get_active_program
from variables import PROGRAMS_DIR

def _get_journals_path(program_id: str = None) -> str:
    if not program_id:
        program_id = get_active_program()
    return os.path.join(PROGRAMS_DIR, program_id, "journals.json")

def get_journal_entries(program_id: str = None) -> list:
    path = _get_journals_path(program_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading journals from {path}: {e}")
        return []

def save_journal_entries(entries: list, program_id: str = None):
    path = _get_journals_path(program_id)
    try:
        # Ensure parent folder exists
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entries, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving journals to {path}: {e}")

def add_journal_entry(keyphrases_str: str, content: str, program_id: str = None) -> dict:
    entries = get_journal_entries(program_id)
    
    # Normalize keyphrases to lowercase list
    keyphrases = [k.strip().lower() for k in keyphrases_str.split(",") if k.strip()]
    
    entry = {
        "id": str(uuid.uuid4()),
        "keyphrases": keyphrases,
        "content": content.strip()[:300],  # Keep it small and focused (max 300 chars)
        "timestamp": time.time()
    }
    entries.append(entry)
    save_journal_entries(entries, program_id)
    return entry

def delete_journal_entry(entry_id: str, program_id: str = None) -> bool:
    entries = get_journal_entries(program_id)
    initial_len = len(entries)
    entries = [e for e in entries if e.get("id") != entry_id]
    if len(entries) < initial_len:
        save_journal_entries(entries, program_id)
        return True
    return False

def match_journals(user_message: str, program_id: str = None) -> list:
    """Finds top 3 matching journal entries based on keywords in user message."""
    if not user_message:
        return []
        
    entries = get_journal_entries(program_id)
    if not entries:
        return []
        
    msg_clean = user_message.lower()
    matched = []
    
    for entry in entries:
        kps = entry.get("keyphrases", [])
        content = entry.get("content", "")
        if not content:
            continue
            
        score = 0
        for kp in kps:
            # Word boundary check for short keyphrases, substring check for multi-word phrases
            if len(kp) <= 3:
                # Require word boundaries for very short words (e.g. 'cat', 'job')
                pattern = r'\b' + re.escape(kp) + r'\b'
                if re.search(pattern, msg_clean):
                    score += 1
            else:
                # Substring check for longer phrases
                if kp in msg_clean:
                    score += len(kp) # longer matches get higher weight
                    
        if score > 0:
            matched.append((score, entry))
            
    # Sort by score descending, then by timestamp descending
    matched.sort(key=lambda x: (x[0], x[1].get("timestamp", 0)), reverse=True)
    
    # Return top 3 entries
    return [item[1] for item in matched[:3]]

