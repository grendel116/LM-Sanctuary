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

async def trigger_auto_journal(history: list, program_id: str, model: str):
    """Generates an automatic journal entry from the recent conversation context."""
    import httpx
    # Only take the last 15 messages for compaction
    segment = history[-15:]
    formatted_chat = []
    for msg in segment:
        role = "User" if msg.get("role") == "user" else "Companion"
        text = msg.get("text", "")
        # Strip thinking blocks for summarization
        import re
        text = re.sub(r'<think>[\s\S]*?</think>', '', text).strip()
        formatted_chat.append(f"{role}: {text}")
        
    chat_block = "\n".join(formatted_chat)
    
    prompt = (
        "You are an AI companion's memory consolidation daemon.\n"
        "Analyze the following conversation segment. If there are any important new details, facts, preferences, promises, or relationship developments "
        "about the User or Companion that should be remembered long-term, summarize them in 1 to 3 sentences max (written in 3rd person present tense, e.g. 'The user mentioned...').\n"
        "Also extract 2 to 5 relevant comma-separated trigger keywords or short phrases (e.g. 'rent, job application, whiskers').\n\n"
        "Output format must be EXACTLY:\n"
        "KEYPHRASES: [keywords/phrases]\n"
        "CONTENT: [concise summary of 1-3 sentences, maximum 300 characters]\n\n"
        "If there are absolutely no new significant details/facts, reply with EXACTLY 'NO_MEMORY'.\n\n"
        f"CONVERSATION SEGMENT:\n{chat_block}\n"
    )
    
    from utils.models import is_local_model
    use_local = is_local_model(model)
    response_text = ""
    
    try:
        if use_local:
            local_url = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME", "local-lm-studio")
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": "You are a memory consolidation assistant."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.2,
                "max_tokens": 512
            }
            headers = {"Content-Type": "application/json"}
            async with httpx.AsyncClient() as client:
                res = await client.post(local_url, json=payload, headers=headers, timeout=60.0)
                if res.status_code == 200:
                    res_json = res.json()
                    response_text = res_json['choices'][0]['message']['content'].strip()
        else:
            api_key = os.getenv("GEMINI_API_KEY")
            if api_key:
                from google.genai import Client
                from variables import DEFAULT_GEMINI_MODEL
                client = Client(api_key=api_key)
                response = client.models.generate_content(
                    model=model if model else DEFAULT_GEMINI_MODEL,
                    contents=prompt,
                    config={
                        "system_instruction": "You are a memory consolidation assistant."
                    }
                )
                response_text = response.text.strip()
    except Exception as e:
        print(f"Error in background journal extraction LLM call: {e}")
        return
        
    if not response_text or "NO_MEMORY" in response_text:
        return
        
    # Parse KEYPHRASES and CONTENT
    kp_match = re.search(r'KEYPHRASES:\s*(.*)', response_text, re.IGNORECASE)
    content_match = re.search(r'CONTENT:\s*(.*)', response_text, re.IGNORECASE)
    
    if kp_match and content_match:
        keyphrases_str = kp_match.group(1).strip()
        content = content_match.group(1).strip()
        if keyphrases_str and content:
            # Add to journals.json
            add_journal_entry(keyphrases_str, content, program_id)
            print(f"[BACKGROUND JOURNALING] Created new memory journal entry for '{program_id}': {content}")

def get_history_from_json(program_id: str, session_id: str) -> list:
    """Reads session JSON directly from disk and parses it into standard history format."""
    path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, "sessions", f"{session_id}.json"))
    is_os = False
    if not os.path.exists(path):
        path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, "sessions", f"{session_id}_os.json"))
        is_os = True
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            history = []
            for item in data:
                if is_os:
                    role = item.get("role", "user")
                    text = item.get("text", "")
                    history.append({"role": role, "text": text})
                else:
                    role = item.get("content", {}).get("role", "")
                    if not role:
                        role = item.get("author", "user")
                    if role.lower() in ["model", "companion", "sebile", "arthur"]:
                        role = "companion"
                    else:
                        role = "user"
                    
                    parts = item.get("content", {}).get("parts", [])
                    text = ""
                    for part in parts:
                        if isinstance(part, dict) and "text" in part:
                            text += part["text"]
                        elif isinstance(part, str):
                            text += part
                    history.append({"role": role, "text": text})
            return history
    except Exception as e:
        print(f"Error reading session JSON in get_history_from_json: {e}")
        return []

def background_journaling_thread(program_id: str, session_id: str, model: str):
    """Entrypoint for background thread. Loads history and consolidation daemon."""
    try:
        history = get_history_from_json(program_id, session_id)
        if len(history) > 0 and len(history) % 10 == 0:
            import asyncio
            asyncio.run(trigger_auto_journal(history, program_id, model))
    except Exception as e:
        print(f"Error in background_journaling_thread: {e}")

def trigger_journal_in_background(program_id: str, session_id: str, model: str):
    """Spawns a background thread to process journals. Prevents async loop conflicts."""
    import threading
    t = threading.Thread(
        target=background_journaling_thread,
        args=(program_id, session_id, model),
        daemon=True
    )
    t.start()
