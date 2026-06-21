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
    
    from utils.program import get_active_user
    from core.program_config import get_companion_name
    
    user_name = get_active_user().capitalize()
    try:
        prog_name = get_companion_name()
    except Exception:
        prog_name = program_id.capitalize()
        
    for msg in segment:
        role = user_name if msg.get("role") == "user" else prog_name
        text = msg.get("text", "")
        text = re.sub(r'(?:<think>|\[think\])[\s\S]*?(?:</think>|\[/think\]|<\/\s*think>|\[\s*/\s*think\s*\]|$)', '', text, flags=re.IGNORECASE).strip()
        formatted_chat.append(f"{role}: {text}")
        
    chat_block = "\n".join(formatted_chat)
    
    # Load last 20 journal entries to prevent duplication in LLM generation
    existing_entries = get_journal_entries(program_id)[-20:]
    existing_memories_text = ""
    if existing_entries:
        existing_memories_text = "Existing remembered facts / journals:\n" + "\n".join([f"- {e.get('content')}" for e in existing_entries]) + "\n\n"
    
    prompt = (
        "You are an AI companion's memory consolidation assistant.\n"
        f"Analyze the following conversation segment. Focus exclusively on extracting major life milestones, significant achievements, key career changes, or permanent, foundational preferences concerning {user_name} or {prog_name}. Keep the memory bank highly focused and poignant.\n"
        f"Summarize the new facts in 1 to 3 sentences max (written in 3rd person present tense, e.g. '{user_name} mentioned...').\n"
        f"Always refer to the user as '{user_name}' and the companion as '{prog_name}'. Use their specific names for all references.\n"
        "Also extract 2 to 5 relevant comma-separated trigger keywords or short phrases (e.g. 'rent, job application, whiskers').\n\n"
        f"{existing_memories_text}"
        "Compare the conversation segment against the existing remembered facts list. Only extract completely new facts that are absent from this list.\n\n"
        "Output format must be EXACTLY:\n"
        "KEYPHRASES: [keywords/phrases]\n"
        "CONTENT: [concise summary of 1-3 sentences, maximum 300 characters]\n\n"
        "Limit memory creation exclusively to major milestones. Respond with EXACTLY 'NO_MEMORY' if the conversation segment contains only general discussion, small talk, or minor details.\n\n"
        f"CONVERSATION SEGMENT:\n{chat_block}\n"
    )
    
    from utils.models import is_local_model
    use_local = is_local_model(model)
    response_text = ""
    
    try:
        if use_local:
            local_url = os.getenv("REMOTE_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME", "local-llm")
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
            api_key = os.getenv("REMOTE_API_KEY")
            if api_key:
                from google.genai import Client
                from variables import DEFAULT_REMOTE_MODEL
                client = Client(api_key=api_key)
                response = client.models.generate_content(
                    model=model if model else DEFAULT_REMOTE_MODEL,
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
            # Check for duplication in python before adding
            existing_contents = [e.get('content', '').lower() for e in get_journal_entries(program_id)]
            is_dup = False
            clean_new = re.sub(r'[^a-z0-9]', '', content.lower())
            for ec in existing_contents:
                clean_ec = re.sub(r'[^a-z0-9]', '', ec)
                if clean_new in clean_ec or clean_ec in clean_new:
                    is_dup = True
                    break
            
            if not is_dup:
                add_journal_entry(keyphrases_str, content, program_id)
                print(f"[BACKGROUND JOURNALING] Created new memory journal entry for '{program_id}': {content}")
            else:
                print(f"[BACKGROUND JOURNALING] Skipped duplicate memory: {content}")

def get_history_from_json(program_id: str, session_id: str) -> list:
    """Reads session JSON directly from disk and parses it into standard history format."""
    path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, "sessions", f"{session_id}.json"))
    if not os.path.exists(path):
        path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, "sessions", f"{session_id}_os.json"))
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
            # Support both root list (old/Gemini format) and root dict with "messages" (OS format)
            messages_list = []
            if isinstance(data, dict):
                if "messages" in data:
                    messages_list = data["messages"]
            elif isinstance(data, list):
                messages_list = data
                
            history = []
            for item in messages_list:
                role = item.get("role", "")
                if not role:
                    role = item.get("content", {}).get("role", "")
                if not role:
                    role = item.get("author", "user")
                
                # Normalize role
                if role.lower() in ["model", "companion", "sebile", "arthur"]:
                    role = "companion"
                else:
                    role = "user"
                
                # Extract text
                text = item.get("text", "")
                if not text:
                    parts = item.get("content", {}).get("parts", [])
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

_last_processed_lens = {}

def background_journaling_thread(program_id: str, session_id: str, model: str):
    """Entrypoint for background thread. Loads history and consolidation task."""
    try:
        history = get_history_from_json(program_id, session_id)
        h_len = len(history)
        if h_len >= 12:
            key = f"{program_id}_{session_id}"
            last_len = _last_processed_lens.get(key, 0)
            
            # Trigger every 6 turns (12 messages) starting from turn 6 (12 messages)
            if h_len - last_len >= 12:
                _last_processed_lens[key] = h_len
                import asyncio
                asyncio.run(trigger_auto_journal(history, program_id, model))
    except Exception as e:
        print(f"Error in background_journaling_thread: {e}")

def trigger_journal_in_background(program_id: str, session_id: str, model: str):
    """Spawns a background thread to process journals. Prevents async loop conflicts."""
    # Disabled: journaling is now a skill invoked by the companion instead of a turn-based background thread.
    pass
