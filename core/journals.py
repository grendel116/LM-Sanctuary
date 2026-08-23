import os
import json
import uuid
import time
import re
from runners.program import get_active_program
from variables.settings import PROGRAMS_DIR

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
    """Finds top 3 matching journal entries using keyword matching, semantic similarity, and recent entries fallback."""
    if not user_message:
        return []
        
    entries = get_journal_entries(program_id)
    if not entries:
        return []
        
    msg_clean = user_message.lower()
    
    # Generic memory query check
    memory_keywords = {"journal", "journals", "memory", "memories", "remember", "remembering", "recollect", "recalled", "notes", "past", "history"}
    has_memory_keyword = any(re.search(r'\b' + re.escape(kw) + r'\b', msg_clean) for kw in memory_keywords)
    
    # Fast path: keyword matching
    matched = []
    
    for entry in entries:
        kps = entry.get("keyphrases", [])
        content = entry.get("content", "")
        if not content:
            continue
            
        score = 0
        for kp in kps:
            # Word boundary check for short keyphrases, substring check for multi word phrases
            if len(kp) <= 3:
                pattern = r'\b' + re.escape(kp) + r'\b'
                if re.search(pattern, msg_clean):
                    score += 1
            else:
                if kp in msg_clean:
                    score += len(kp)
                    
        if score > 0:
            matched.append((score, entry))
            
    # Sort by score descending, then by timestamp descending
    matched.sort(key=lambda x: (x[0], x[1].get("timestamp", 0)), reverse=True)
    
    if matched:
        return [item[1] for item in matched[:3]]
    
    # Semantic fallback: vector similarity when keyword matching finds nothing
    try:
        import numpy as np
        from core.skills.vectorized_databank.databank import get_embedding_model
        model = get_embedding_model()
        query_vec = model.encode(user_message)
        query_norm = np.linalg.norm(query_vec)
        if query_norm > 0:
            semantic_matched = []
            for entry in entries:
                content = entry.get("content", "")
                if not content:
                    continue
                content_vec = model.encode(content)
                content_norm = np.linalg.norm(content_vec)
                if content_norm == 0:
                    continue
                similarity = float(np.dot(query_vec, content_vec) / (query_norm * content_norm))
                if similarity >= 0.25:
                    semantic_matched.append((similarity, entry))
            
            semantic_matched.sort(key=lambda x: x[0], reverse=True)
            if semantic_matched:
                return [item[1] for item in semantic_matched[:3]]
    except Exception as e:
        print(f"[Journals] Semantic fallback error: {e}")
        
    # If user inquired about memories/journals or if no specific topic matched, return most recent entries
    if has_memory_keyword or len(entries) <= 3:
        sorted_recent = sorted(entries, key=lambda x: x.get("timestamp", 0), reverse=True)
        return sorted_recent[:3]

    return []

