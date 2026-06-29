import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from variables import PROGRAMS_DIR, REMOTE_SERVER_URL, DEFAULT_LOCAL_MODEL, DEFAULT_REMOTE_MODEL, get_remote_server_headers
from utils.models import is_local_model
import asyncio
import base64
import json
import re
import time
import uuid
import httpx
import copy

cancelled_sessions = set()
voice_call_sessions = set()


def _run_async_in_background_thread(coro):
    import threading
    def target():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro)
        except Exception as e:
            print(f"[BACKGROUND TASK ERROR] {e}", flush=True)
        finally:
            loop.close()
    t = threading.Thread(target=target, daemon=True)
    t.start()


_DEFAULT_INVERSION_STATE = {
    "active_inversion": "",
    "inversion_consecutive_turns": 0,
    "mood_tally": {
        "intimate": 0,
        "excited": 0,
        "intense": 0,
        "sad": 0
    }
}


def _is_remote_configured() -> bool:
    """Helper to check if remote cloud server is configured."""
    remote_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    return bool(
        remote_key and remote_key.strip() and remote_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )


def _merge_consecutive_messages(messages: list) -> list:
    """Combines consecutive messages with the same role into a single message
    by appending their contents.
    """
    if not messages:
        return []
    merged = []
    for msg in messages:
        if merged and merged[-1]["role"] == msg["role"]:
            prev_content = merged[-1]["content"]
            curr_content = msg["content"]
            if isinstance(prev_content, str) and isinstance(curr_content, str):
                merged[-1]["content"] += "\n\n" + curr_content
            else:
                prev_list = prev_content if isinstance(prev_content, list) else [{"type": "text", "text": prev_content}]
                curr_list = curr_content if isinstance(curr_content, list) else [{"type": "text", "text": curr_content}]
                merged[-1]["content"] = prev_list + curr_list
        else:
            merged.append(msg)
    return merged


def _get_databank_context(query_text: str, is_memory: bool = False) -> str:
    """Helper to query the DataBank index for context (excluding or including chat history)."""
    if not query_text:
        return ""
    try:
        from core.skills.vectorized_databank.databank import DataBankManager
        db = DataBankManager()
        if is_memory:
            return db.query(query_text, top_k=3, include_source_type="chat_history")
        else:
            return db.query(query_text, exclude_source_type="chat_history")
    except Exception as e:
        context_type = "memory" if is_memory else "RAG"
        print(f"Error querying data bank for {context_type} context: {e}")
        return ""


def _build_tool_calls_pair(tool_name: str, args: dict, output: str, idx: int = None) -> list:
    """Builds a pair of (call, response) dictionaries for tool calls logging."""
    if idx is None:
        call_id = f"call_{int(time.time())}"
    else:
        call_id = f"call_{int(time.time())}_{idx}_{uuid.uuid4().hex[:4]}"
    return [
        {
            'type': 'call',
            'name': tool_name,
            'args': args,
            'id': call_id
        },
        {
            'type': 'response',
            'name': tool_name,
            'response': str(output),
            'id': call_id
        }
    ]


def _normalize_tool_name(tool_name: str) -> str:
    """Normalizes tool name aliases to their standard forms."""
    if tool_name == "generate_companion_portrait":
        return "generate_local_image"
    if tool_name == "generate_general_image":
        return "generate_imagen"
    return tool_name


def _execute_emulated_tool(tool_name: str, args_str: str) -> tuple[dict, str]:
    """Parses and executes an emulated tool call, returning parsed arguments and execution output."""
    normalized_name = _normalize_tool_name(tool_name)
    parsed_args = _parse_emulated_tool_call(normalized_name, args_str)
    
    import tools
    func = getattr(tools, normalized_name, None)
    if not func:
        return parsed_args, f"Error: Tool '{normalized_name}' not found."
        
    try:
        output = func(*parsed_args["args"], **parsed_args["kwargs"])
    except Exception as e:
        output = f"Error executing tool: {e}"
        
    return parsed_args, str(output)


class LocalOffloadTrigger(Exception):
    def __init__(self, reason, iteration):
        self.reason = reason
        self.iteration = iteration


def _get_safe_local_path(image_url: str) -> str:
    """Converts an image URL into a local path relative to the workspace,
    supporting subdirectories like 'portraits'.
    """
    if "/images/" not in image_url:
        return None
    filename = image_url.split("/images/")[-1]
    filename = filename.replace("\\", "/").strip("/")
    parts = filename.split("/")
    safe_parts = []
    for p in parts:
        safe_p = "".join(c for c in p if c.isalnum() or c in "._-")
        if safe_p:
            safe_parts.append(safe_p)
    if not safe_parts:
        return None
    from utils.program import get_active_program
    active_program = get_active_program()
    return os.path.normpath(os.path.join("core", "programs", active_program, *safe_parts))


def fallback_system_to_user_messages(messages: list) -> list:
    """Helper to convert and merge 'system' messages to 'user' messages
    if the local model server's chat template doesn't support the system role.
    """
    if not messages:
        return messages
    mapped_messages = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "system":
            mapped_messages.append({"role": "user", "content": f"[System Directive]\n{content}"})
        else:
            mapped_messages.append({"role": role, "content": content})
            
    return _merge_consecutive_messages(mapped_messages)



def _format_thinking_and_text(thoughts_list: list, texts_list: list) -> str:
    """Combines lists of thoughts and texts, merging any existing <think> tags (closed or unclosed)."""
    thoughts_str = "".join(thoughts_list)
    text_str = "".join(texts_list)
    
    additional_thoughts = []
    cleaned_text_parts = []
    
    temp_text = text_str
    while True:
        open_match = re.search(r'(?:<think>|\[think\])', temp_text, re.IGNORECASE)
        if not open_match:
            cleaned_text_parts.append(temp_text)
            break
            
        start_idx = open_match.start()
        end_open_idx = open_match.end()
        
        cleaned_text_parts.append(temp_text[:start_idx])
        remaining = temp_text[end_open_idx:]
        
        close_match = re.search(r'(?:</think>|\[/think\]|<\/\s*think>|\[\s*/\s*think\s*\])', remaining, re.IGNORECASE)
        if close_match:
            close_start = close_match.start()
            close_end = close_match.end()
            
            thought = remaining[:close_start].strip()
            if thought:
                additional_thoughts.append(thought)
            temp_text = remaining[close_end:]
        else:
            # Unclosed think tag (streaming/cutoff)
            thought = remaining.strip()
            if thought:
                additional_thoughts.append(thought)
            temp_text = ""
            break
            
    text_str = "".join(cleaned_text_parts).strip()
    
    if additional_thoughts:
        add_str = "\n".join(additional_thoughts)
        if thoughts_str.strip():
            thoughts_str = thoughts_str.strip() + "\n" + add_str
        else:
            thoughts_str = add_str
            
    thoughts_str = thoughts_str.strip()
    text_str = text_str.strip()
    
    if thoughts_str:
        return f"<think>{thoughts_str}</think>\n{text_str}"
    return text_str


def strip_narration(text: str) -> str:
    """Removes first-person/third-person action narration in asterisks from the text.
    Preserves text inside double asterisks (bold text) and strips single asterisk action phrases.
    Also removes thoughts blocks inside <think>...</think> tags if any.
    """
    if not text:
        return ""
    
    # 1. Clean <think>...</think> blocks first (handles closed and unclosed tags)
    text = re.sub(r'(?:<think>|\[think\])[\s\S]*?(?:</think>|\[/think\]|<\/\s*think>|\[\s*/\s*think\s*\]|$)', '', text, flags=re.IGNORECASE)
    
    # 2. Strip single asterisks action narration, e.g. *giggles* or *I pull you close*
    pattern = re.compile(r'(?<!\*)\*(?!\*)([\s\S]*?)(?<!\*)\*(?!\*)')
    text = pattern.sub('', text)
    
    # 3. Clean up any residual single asterisks that might get orphaned
    text = re.sub(r'(?<!\*)\*(?!\*)', '', text)
    
    # 4. Clean up spacing and newlines
    text = re.sub(r'\n\s*\n+', '\n\n', text)
    text = re.sub(r' +', ' ', text)
    
    return text.strip()


_LOCAL_DIRECTIVE_PROMPT = (
    "\n\n# LOCAL EMULATED TOOLS\n"
    "To call a tool, output the exact tag. The system will intercept it, run the tool, and return the result.\n\n"
    "Available Tools:\n"
    "1. `[google_search(query=\"...\")]` / `[web_search(query=\"...\")]` - Search the web. Supports prefix routing: 'github: query', 'arxiv: query', 'hn: query', 'wikipedia: query'. For general queries, blends Google, DuckDuckGo, Brave, Tavily, Baidu, and Yandex concurrently.\n"
    "2. `[read_webpage(url=\"...\")]` - Fetch & read the full text of a webpage. Use this to follow up on search results when snippets are thin.\n"
    "3. `[read_file(path=\"...\")]` - Read file content.\n"
    "4. `[write_file(path=\"...\", content=\"...\")]` - Create/overwrite file.\n"
    "5. `[replace_in_file(path=\"...\", old_text=\"...\", new_text=\"...\")]` - Replace text in file.\n"
    "6. `[replace_file_content(path=\"...\", start_line=..., end_line=..., target_content=\"...\", replacement_content=\"...\")]` - Replace a specific block of lines in a file (preferred over replace_in_file for code edits).\n"
    "7. `[multi_replace_file_content(path=\"...\", replacement_chunks=[{\"start_line\": ..., \"end_line\": ..., \"target_content\": \"...\", \"replacement_content\": \"...\"}, ...])]` - Apply multiple non-contiguous line-bounded replacements in a single turn.\n"
    "8. `[run_shell_command(command=\"...\")]` - Run shell command synchronously (blocks server for up to 30s).\n"
    "9. `[run_command_async(command=\"...\")]` - Run command asynchronously in the background. Returns task_id immediately.\n"
    "10. `[manage_task(action=\"...\", task_id=\"...\", input_val=\"...\")]` - Manage async tasks (action options: 'list', 'status', 'kill', 'send_input').\n"
    "11. `[wait_task(task_id=\"...\", timeout=...)]` - Block and wait for background task output up to timeout (default 10.0).\n"
    "12. `[get_workspace_structure()]` - View directory tree.\n"
    "13. `[search_codebase(keyword=\"...\")]` - Search keyword in codebase.\n"
    "14. `[generate_local_image(prompt=\"...\")]` - Generate a scene of yourself. Formulate the prompt using a comma-separated list of short descriptive tags (e.g. '1girl, dark hair, blue eyes, smiling, sitting in cafe'). (MUST be the ONLY text in your response)\n"
    "15. `[generate_imagen(prompt=\"...\", aspect_ratio=\"...\")]` - Generate landscapes or objects. Formulate the prompt using a comma-separated list of short descriptive tags.\n"
    "16. `[apply_comfy_workflow(workflow_path=\"...\", parameters={...}, save_path=\"...\")]` - Apply custom ComfyUI workflow.\n"
    "17. `[add_quest(title=\"...\", notes=\"...\", due=\"...\", location=\"...\", reminder_minutes=...)]` - Add a real-world task/quest to the user's quest log. Notes should contain the objectives (separated by newlines or commas). Due is an ISO 8601 string or relative time (e.g. 'tomorrow', 'in 3 hours').\n"
    "18. `[add_journal_entry(keyphrases=\"...\", content=\"...\")]` - Save a memory journal entry of specific details for future recall. Keyphrases is a list of keywords separated by commas.\n\n"
    "Rules:\n"
    "- Chain tools freely when researching: search \u2192 read_webpage \u2192 refine query as needed.\n"
    "- Thin or irrelevant results = dig deeper. Try a different query; read the best URLs for full content.\n"
    "- Never repeat the same query or URL in one chain.\n"
    "- Research output pattern: after each tool result, write a 2-4 sentence summary of what it found. After all searches, synthesize the summaries and reflect on what the data shows.\n"
    "- Reports must cite specific facts from what you read (names, roles, dates, events), not editorial inference.\n"
    "- Image tools: sparingly, never chained, prompts as comma-separated tags only.\n"
    "- After tools complete, respond in natural language without repeating tags.\n"
)

_STORY_MODE_DIRECTIVE_PROMPT = (
    "\n\n# LOCAL EMULATED TOOLS\n"
    "To call a tool, output the exact tag. The system will intercept it, run the tool, and return the result.\n\n"
    "Available Tools:\n"
    "1. `[generate_local_image(prompt=\"...\")]` - Generate a scene of yourself. Formulate the prompt using a comma-separated list of short descriptive tags (e.g. '1girl, dark hair, blue eyes, smiling, sitting in cafe'). (MUST be the ONLY text in your response)\n"
    "2. `[generate_imagen(prompt=\"...\", aspect_ratio=\"...\")]` - Generate landscapes or objects. Formulate the prompt using a comma-separated list of short descriptive tags.\n"
    "3. `[apply_comfy_workflow(workflow_path=\"...\", parameters={...}, save_path=\"...\")]` - Apply custom ComfyUI workflow.\n"
    "4. `[add_journal_entry(keyphrases=\"...\", content=\"...\")]` - Save a memory journal entry of specific details for future recall. Keyphrases is a list of keywords separated by commas.\n\n"
    "Rules:\n"
    "- Output exactly one tool call tag per turn when needed.\n"
    "- Call image generation tools sparingly.\n"
    "- Once tool output is provided, answer directly in natural language without repeating the tag.\n"
    "- Formulate all image generation prompts as a sequence of comma-separated tags.\n"
    "- Do not write image prompts as prose sentences or paragraphs.\n"
)
def is_real_user_msg(msg: dict) -> bool:
    """Determine if a message is a real user message."""
    role = msg.get('role')
    msg_id = msg.get('id', '')
    if role != 'user':
        return False
    if msg_id:
        if msg_id.startswith('tool_') or msg_id.startswith('port_') or msg_id.startswith('quest_') or msg_id.startswith('sys_'):
            return False
        if msg_id.startswith('usr_') or msg_id.startswith('img_'):
            return True
    text = msg.get('text', '')
    if text.startswith('[Tool Response') or text.startswith('[SYSTEM:') or "Send me a portrait of yourself" in text:
        return False
    return True




def _parse_emulated_tool_call(tool_name: str, args_str: str) -> dict:
    """Parses arguments from an emulated tool call string.
    Supports both key=value style and simple positional string style.
    """
    import ast
    try:
        parsed = ast.parse(f"dummy({args_str})")
        call_node = parsed.body[0].value
        kwargs = {}
        args = []
        for kw in call_node.keywords:
            kwargs[kw.arg] = ast.literal_eval(kw.value)
        for arg in call_node.args:
            args.append(ast.literal_eval(arg))
        return {"args": args, "kwargs": kwargs}
    except Exception:
        kwargs = {}
        kv_pairs = re.findall(r'(\w+)\s*=\s*(["\'])(.*?)\2', args_str)
        if kv_pairs:
            for k, _, v in kv_pairs:
                kwargs[k] = v
            return {"args": [], "kwargs": kwargs}
        
        val = args_str.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        return {"args": [val], "kwargs": {}}


# (Google ADK _compact_session_history helper removed)

# --- LOCAL HISTORY ADAPTERS FOR UNIFIED LOCAL EXECUTION LOOP ---

class LocalHistoryAdapter:
    def __init__(self, runner_obj, session_id):
        self.runner_obj = runner_obj
        self.session_id = session_id

    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str = None) -> list:
        raise NotImplementedError()

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str):
        raise NotImplementedError()

    def append_tool_events(self, results: list, invocation_id: str):
        raise NotImplementedError()

    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        raise NotImplementedError()

    def post_process_thoughts(self, invocation_id: str):
        raise NotImplementedError()

    def save(self):
        raise NotImplementedError()

    async def compact_history(self, active_model: str, force: bool = False):
        pass


def _get_base64_image_url(image_source) -> str:
    """Resolves image_source (local file path or relative URL) to a base64 data URL."""
    import mimetypes
    
    if not image_source:
        return None
        
    # If it is already a data URL, return as is
    if str(image_source).startswith("data:"):
        return image_source
        
    # Resolve relative URL path
    local_path = image_source
    if str(image_source).startswith("/images/"):
        rel_path = image_source[len("/images/"):]
        from utils.program import get_active_program
        active_program = get_active_program()
        project_root = os.path.dirname(os.path.abspath(__file__))
        local_path = os.path.normpath(os.path.join(project_root, 'core', 'programs', active_program, rel_path))
        
    # Ensure relative paths are resolved relative to project root
    if not os.path.isabs(local_path):
        project_root = os.path.dirname(os.path.abspath(__file__))
        local_path = os.path.normpath(os.path.join(project_root, local_path))
        
    if not os.path.exists(local_path):
        print(f"[IMAGE RESOLVE] File not found: {local_path}")
        return None
        
    try:
        mime_type, _ = mimetypes.guess_type(local_path)
        if not mime_type:
            mime_type = "image/png"
        with open(local_path, "rb") as f:
            b64_data = base64.b64encode(f.read()).decode('utf-8')
        return f"data:{mime_type};base64,{b64_data}"
    except Exception as e:
        print(f"[IMAGE RESOLVE ERROR] Failed to encode {local_path}: {e}")
        return None


class OsHistoryAdapter(LocalHistoryAdapter):
    def __init__(self, runner_obj, session_id, file_path_resolved, image_data, image_mime):
        super().__init__(runner_obj, session_id)
        self.file_path_resolved = file_path_resolved
        self.image_data = image_data
        self.image_mime = image_mime
        self.initial_history_len = len(runner_obj.sessions_history[session_id])

    async def compact_history(self, active_model: str, force: bool = False):
        # 1. Determine size
        history = self.runner_obj.sessions_history[self.session_id]
        history_text = ""
        for msg in history:
            history_text += msg.get('text', '') or ''
            
        # Dynamic threshold based on LOCAL_CONTEXT or LOCAL_CONTEXT_THRESHOLD_CHARS
        local_context = os.getenv("LOCAL_CONTEXT")
        if local_context:
            try:
                # 1 token is approx 4 characters.
                # Trigger at 30% of the context window so compaction runs
                # as a rolling summary, not as a last-resort overflow handler.
                MAX_LOCAL_CONTEXT_CHARS = int(int(local_context) * 0.30 * 4)
            except Exception:
                MAX_LOCAL_CONTEXT_CHARS = 6000
        else:
            try:
                MAX_LOCAL_CONTEXT_CHARS = int(os.getenv("LOCAL_CONTEXT_THRESHOLD_CHARS", "6000"))
            except Exception:
                MAX_LOCAL_CONTEXT_CHARS = 6000
                
        if not force and len(history_text) <= MAX_LOCAL_CONTEXT_CHARS:
            return
            
        print(f"[COMPACTION OS] Running compaction (force={force})...", flush=True)
        
        # 2. Find user messages to identify turns
        user_msg_indices = [idx for idx, msg in enumerate(history) if msg.get('role') == 'user' and not msg.get('compacted')]
        
        keep_turns = 1 if force else 5
        if len(user_msg_indices) <= keep_turns:
            return
            
        cutoff_idx = user_msg_indices[-keep_turns]
        
        # Extract turns before cutoff to summarize
        historical_turns = history[:cutoff_idx]
        text_to_summarize = ""
        for msg in historical_turns:
            if msg.get('role') not in ('user', 'companion'):
                continue
            role = "User" if msg.get('role') == 'user' else "Companion"
            text = (msg.get('text') or '').strip()
            if text:
                text_to_summarize += f"{role}: {text}\n\n"
                
        if not text_to_summarize.strip():
            return
            
        # 3. Fetch prior 2 chat history archives
        prior_texts = []
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            priors = db.get_prior_chat_histories(self.session_id, limit=2)
            for p in priors:
                prior_texts.append(f"--- PRIOR MEMORY ARCHIVE ({p['name']}) ---\n{p['text']}")
        except Exception as e:
            print(f"[COMPACTION OS] Error fetching prior chat histories: {e}", flush=True)
            
        # 4. Generate summary
        summary = await self.runner_obj._generate_local_summary(text_to_summarize, active_model, prior_memories=prior_texts)
            
        if summary.startswith("Memory compaction summary generation failed"):
            summary = (
                "Older conversation turns were pruned to free up local memory. The full transcript of these turns "
                "has been archived in the vector database and remains searchable."
            )
            
        # 5. Ingest to vector database
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            db.ingest_text(
                text=summary,
                name=f"chat_history_archive_{self.session_id}_{int(time.time())}",
                source_type="chat_history"
            )
            db.prune_chat_histories(self.session_id, keep_limit=3)
            print(f"[COMPACTION OS] Ingested history to vector database.", flush=True)
        except Exception as e:
            print(f"[COMPACTION OS ERROR] Failed to ingest: {e}", flush=True)
            
        # Mark all prior events as compacted in historical_turns
        for msg in historical_turns:
            msg['compacted'] = True
            
        # 6. Replace historical turns with single summary event in live self.runner_obj.sessions_history
        summary_msg = {
            'id': f"sys_{uuid.uuid4().hex}",
            'role': 'system-memory',
            'text': f"[System Memory of older conversation turns]:\n{summary}",
            'timestamp': time.time()
        }
        
        with self.runner_obj._lock:
            live_history = self.runner_obj.sessions_history.get(self.session_id, [])
            last_compacted_id = historical_turns[-1].get('id') if historical_turns else None
            last_compacted_idx = -1
            if last_compacted_id:
                for idx, msg in enumerate(live_history):
                    if msg.get('id') == last_compacted_id:
                        last_compacted_idx = idx
                        break
                        
            if last_compacted_idx != -1:
                # Mark all messages in live history up to last_compacted_idx as compacted
                for msg in live_history[:last_compacted_idx + 1]:
                    msg['compacted'] = True
                # Insert the summary msg right after last_compacted_idx
                live_history.insert(last_compacted_idx + 1, summary_msg)
                print(f"[COMPACTION OS] Flagged {last_compacted_idx + 1} turns as compacted and appended system memory summary in live history.", flush=True)
            else:
                # Fallback: prepend summary message to live history
                live_history.insert(0, summary_msg)
                print(f"[COMPACTION OS] Fallback: Appended system memory summary to the beginning of live history.", flush=True)
                
            self.runner_obj._save_session_to_disk(self.session_id)

    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str = None) -> list:
        history = self.runner_obj.sessions_history[self.session_id]
        raw_messages = []
        
        filtered_history = [msg for msg in history if msg.get('role') not in ('voice-call', 'system-memory') and not msg.get('compacted')]
        if not filtered_history:
            return [{"role": "system", "content": sys_inst}]
            
        # Find the latest actual user chat message (ignoring tool responses/updates)
        latest_img_user_msg_idx = -1
        has_new_image = bool((self.image_data and self.image_mime) or self.file_path_resolved)
        
        for idx in range(len(filtered_history) - 1, -1, -1):
            msg = filtered_history[idx]
            if msg.get('role') == 'user':
                if msg.get('id', '').startswith('tool_') or msg.get('text', '').startswith('[Tool Response from'):
                    continue
                if has_new_image or msg.get('image_url'):
                    latest_img_user_msg_idx = idx
                break
                
        for idx, msg in enumerate(filtered_history):
            role = "assistant" if msg['role'] == 'companion' else "user"
            from core.program_config import replace_placeholders
            content_text = replace_placeholders(msg.get('text', '') or '')
            if msg.get('tool_calls'):
                for tc in msg['tool_calls']:
                    if tc.get('type') == 'call':
                        name = tc.get('name')
                        args = tc.get('args', {})
                        args_list = []
                        for k, v in args.items():
                            if isinstance(v, str):
                                escaped_v = v.replace('"', '\\"')
                                args_list.append(f'{k}="{escaped_v}"')
                            else:
                                args_list.append(f'{k}={v}')
                        args_str = ", ".join(args_list)
                        content_text += f"\n[{name}({args_str})]"
                        
            if idx == latest_img_user_msg_idx:
                image_url_to_use = None
                if self.image_data and self.image_mime:
                    image_url_to_use = f"data:{self.image_mime};base64,{self.image_data}"
                elif self.file_path_resolved:
                    image_url_to_use = self.file_path_resolved
                else:
                    image_url_to_use = msg.get('image_url')
                    
                b64_url = _get_base64_image_url(image_url_to_use)
                if b64_url:
                    content_payload = [
                        {"type": "text", "text": content_text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": b64_url
                            }
                        }
                    ]
                    raw_messages.append({"role": role, "content": content_payload})
                else:
                    text_content = f"{content_text} (image: [Attached Image])" if content_text else "[Attached Image]"
                    raw_messages.append({"role": role, "content": text_content})
            else:
                if msg.get('image_url'):
                    text_content = f"{content_text} (image: [Attached Image])" if content_text else "[Attached Image]"
                    raw_messages.append({"role": role, "content": text_content})
                else:
                    raw_messages.append({"role": role, "content": content_text})
                    
        openai_messages = [{"role": "system", "content": sys_inst}]
        if rag_context:
            openai_messages[0]["content"] += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
        if memory_context:
            openai_messages[0]["content"] += f"\n\n# ARCHIVED CONVERSATION MEMORY\nThe following is a chronological sequence of messages from earlier in this conversation:\n{memory_context}\n"
        from core.program_config import is_narration_mode
        if is_narration_mode():
            openai_messages[0]["content"] += _STORY_MODE_DIRECTIVE_PROMPT
        else:
            openai_messages[0]["content"] += _LOCAL_DIRECTIVE_PROMPT

        openai_messages = _merge_consecutive_messages(openai_messages + raw_messages)

        # Check for companion-specific post-history instructions and append them at the end of messages
        try:
            from utils.program import get_active_program
            from variables import PROGRAMS_DIR
            
            active_prog = get_active_program()
            json_path = os.path.normpath(os.path.join(PROGRAMS_DIR, active_prog, f"{active_prog}.json"))
            if os.path.exists(json_path):
                with open(json_path, "r", encoding="utf-8") as f:
                    profile_data = json.load(f)
                    post_history_inst = profile_data.get("operation", {}).get("post_history_instructions", "").strip()
                    if post_history_inst:
                        last_user_text = ""
                        for m in reversed(filtered_history):
                            if m.get("role") == "user":
                                last_user_text = m.get("text", "") or ""
                                break
                        
                        is_standard = True
                        if last_user_text:
                            lut_lower = last_user_text.lower().strip()
                            if lut_lower.startswith("[") or "portrait" in lut_lower or "picture" in lut_lower or "generate" in lut_lower or "image of" in lut_lower:
                                is_standard = False
                                
                        if is_standard:
                            directive_content = f"[System Directive]\n{post_history_inst}"
                            if openai_messages and openai_messages[-1]["role"] == "user":
                                prev = openai_messages[-1]["content"]
                                if isinstance(prev, str):
                                    openai_messages[-1]["content"] += f"\n\n{directive_content}"
                                else:
                                    openai_messages[-1]["content"] = prev + [{"type": "text", "text": f"\n\n{directive_content}"}]
                            else:
                                openai_messages.append({"role": "user", "content": directive_content})
        except Exception as e:
            print(f"Error loading post-history instructions: {e}", flush=True)

        return openai_messages

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str, intermediate: bool = False):
        from utils.program_mood import extract_and_strip_mood
        _, mood_details = extract_and_strip_mood(text)
        winning_mode = self.runner_obj._winning_mode_cache.get(self.session_id, "")
        
        if mood_details:
            mood_name = mood_details.get('name')
            self.runner_obj.update_inversion_state_with_mood(self.session_id, mood_name)
            
        history = self.runner_obj.sessions_history[self.session_id]
        if history and history[-1]['role'] == 'companion':
            history[-1]['text'] = text
            history[-1]['tool_calls'] = tool_calls_data
            history[-1]['inversion_active'] = winning_mode
            history[-1]['mood'] = mood_details
            return history[-1]
            
        is_img_msg = text and text.strip().startswith("![") and text.strip().endswith(")")
        if intermediate:
            prefix = "itm_"
        elif is_img_msg:
            prefix = "img_"
        else:
            prefix = "prgm_"
        bot_msg = {
            'id': f"{prefix}{uuid.uuid4().hex}",
            'role': 'companion',
            'text': text,
            'tool_calls': tool_calls_data,
            'timestamp': time.time(),
            'inversion_active': winning_mode,
            'mood': mood_details
        }
        history.append(bot_msg)
        return bot_msg

    def append_tool_events(self, results: list, invocation_id: str):
        for idx, (t_name, t_args, t_output) in enumerate(results):
            tool_resp_msg = {
                'id': f"tool_{uuid.uuid4().hex}",
                'role': 'user',
                'text': f"[Tool Response from {t_name}]:\n{t_output}",
                'tool_calls': [],
                'timestamp': time.time()
            }
            self.runner_obj.sessions_history[self.session_id].append(tool_resp_msg)

    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        pass

    def post_process_thoughts(self, invocation_id: str):
        pass

    def save(self):
        self.runner_obj._save_session_to_disk(self.session_id)


def _is_cloud_model_check(model: str) -> bool:
    if not model:
        return False
    if not _is_remote_configured():
        return False
        
    m_norm = model.replace('\\', '/').strip().lower()
    remote_model = os.getenv("REMOTE_MODEL", "").replace('\\', '/').strip().lower()
    if m_norm == remote_model:
        return True
    if is_local_model(model):
        return False
    return True


class BaseProgramRunner:
    def __init__(self, app_name="Sanctuary"):
        self.app_name = app_name
        self._winning_mode_cache = {}

    async def _post_llm_request(
        self,
        url: str,
        payload: dict,
        headers: dict,
        timeout: float = 60.0,
        session_id: str = None
    ) -> httpx.Response:
        """Sends a POST request to the LLM server, automatically falling back
        to system-to-user messages if a Jinja/system-role error is encountered.
        Supports chunk-by-chunk streaming to allow immediate cancellation.
        """
        from runner_interface import cancelled_sessions

        # If session_id is provided, stream the response to support cancellation mid-generation
        if session_id:
            payload_copy = copy.deepcopy(payload)
            payload_copy["stream"] = True
            
            headers_copy = copy.deepcopy(headers)
            headers_copy["Accept-Encoding"] = "identity"
            
            async with httpx.AsyncClient() as client:
                async with client.stream("POST", url, json=payload_copy, headers=headers_copy, timeout=timeout) as r:
                    if r.status_code != 200:
                        await r.aread()
                        response = httpx.Response(
                            status_code=r.status_code,
                            headers=r.headers,
                            content=r.content,
                            request=r.request
                        )
                    else:
                        content_parts = []
                        async for line in r.aiter_lines():
                            if session_id in cancelled_sessions:
                                cancelled_sessions.discard(session_id)
                                print(f"[CANCEL] Aborting HTTP request for session {session_id}", flush=True)
                                raise asyncio.CancelledError("Session cancelled by user request.")
                            
                            line = line.strip()
                            if not line:
                                continue
                            if line.startswith("data:"):
                                data_str = line[5:].strip()
                                if data_str == "[DONE]":
                                    break
                                try:
                                    chunk_json = json.loads(data_str)
                                    choices = chunk_json.get("choices", [])
                                    if choices:
                                        delta = choices[0].get("delta", {})
                                        content = delta.get("content", "")
                                        if content:
                                            content_parts.append(content)
                                except Exception:
                                    pass
                        
                        full_text = "".join(content_parts)
                        mock_choices = [{
                            "message": {
                                "role": "assistant",
                                "content": full_text
                            }
                        }]
                        mock_data = {
                            "choices": mock_choices,
                            "model": payload.get("model", "")
                        }
                        mock_content = json.dumps(mock_data).encode("utf-8")
                        response = httpx.Response(
                            status_code=200,
                            headers=r.headers,
                            content=mock_content,
                            request=r.request
                        )
        else:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=timeout)

        # If the request fails due to system role issues, retry with mapped user messages
        is_system_role_error = (
            response.status_code == 500 and (
                "got system" in response.text or
                "Jinja Exception" in response.text or
                "only user" in response.text.lower()
            )
        )
        if is_system_role_error:
            print("[LLM FALLBACK] Detected system role Jinja Exception. Retrying with fallback...", flush=True)
            payload_retry = copy.deepcopy(payload)
            payload_retry["messages"] = fallback_system_to_user_messages(payload_retry.get("messages", []))
            # Call recursively to preserve streaming behavior and cancellation support
            response = await self._post_llm_request(url, payload_retry, headers, timeout, session_id)
            
        return response

    async def _generate_local_summary(self, text_to_summarize: str, active_model: str, prior_memories: list = None) -> str:
        # Check if remote model is configured to offload summary generation
        is_remote_configured = _is_remote_configured()
        remote_key = os.getenv("REMOTE_API_KEY")
        remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
        
        from utils.program import get_active_user
        from core.program_config import get_companion_name
        
        user_name = get_active_user().capitalize()
        try:
            companion_name = get_companion_name()
        except Exception:
            companion_name = "Companion"
            
        prompt = (
            "You are a compaction assistant.\n"
            f"Summarize the chat history between {user_name} and {companion_name}.\n"
            f"Always refer to the user as '{user_name}' and the companion as '{companion_name}'. Use their names for all references.\n"
            "Extract facts, preferences, instructions, file changes, and project details.\n"
            "Write a concise content string of up to 300 characters.\n\n"
        )

        if prior_memories:
            prompt += "Excerpts of prior memories:\n"
            for pm in prior_memories:
                prompt += f"{pm}\n\n"
            prompt += "Reference the prior memories to keep the summary coherent with the context.\n\n"
            
        prompt += (
            f"NEW CHAT HISTORY TO SUMMARIZE:\n{text_to_summarize}\n\n"
            "SUMMARY:"
        )
        
        if is_remote_configured:
            try:
                target_model = os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite")
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {remote_key}"
                }
                payload = {
                    "model": target_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 1024
                }
                print(f"[COMPACTION] Offloading summary generation to remote cloud model: {target_model}", flush=True)
                response = await self._post_llm_request(remote_cloud_url, payload, headers, timeout=60.0)
                if response.status_code == 200:
                    res_json = response.json()
                    return res_json['choices'][0]['message']['content'].strip()
                else:
                    print(f"[COMPACTION] Remote cloud query failed with status {response.status_code}: {response.text}", flush=True)
            except Exception as e:
                print(f"[COMPACTION] Error generating remote summary: {e}. Falling back to local/default.", flush=True)
                
        # Fallback to local server
        payload = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 1024
        }
        target_model = active_model if (active_model and active_model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME")
        if target_model:
            payload["model"] = target_model
            
        try:
            response = await self._post_llm_request(REMOTE_SERVER_URL, payload, get_remote_server_headers(), timeout=60.0)
            if response.status_code == 200:
                res_json = response.json()
                return res_json['choices'][0]['message']['content'].strip()
            else:
                print(f"Local server returned error for summary: {response.status_code} - {response.text}", flush=True)
        except Exception as e:
            print(f"Error generating local summary: {e}", flush=True)
        return "Memory compaction summary generation failed due to connection error."

    async def _execute_local_llm_loop(
        self,
        session_id: str,
        adapter: LocalHistoryAdapter,
        model: str,
        inversion_directive: str,
        rag_context: str,
        memory_context: str,
        new_message_text: str,
        invocation_id: str
    ) -> tuple:
        bot_response_text = ""
        tool_calls = []
        seen_tool_calls = set()  # tracks (tool_name, key_arg) to block duplicates
        
        # Check if remote cloud server is configured for offloading
        remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
        is_cloud = _is_cloud_model_check(model)
        
        # Check for dynamic offloading triggers at execution-time
        is_remote_configured = _is_remote_configured()
        remote_key = os.getenv("REMOTE_API_KEY")
        
        # Check if an image is attached to the user's message
        has_image = bool(getattr(adapter, 'file_path_resolved', None) or getattr(adapter, 'image_data', None))
        
        # Check for keyword triggers in the user message
        has_offload_keyword = False
        if new_message_text:
            msg_lower = new_message_text.lower()
            if "/cloud" in msg_lower or "/offload" in msg_lower:
                has_offload_keyword = True
                
        for iteration in range(10):
            if session_id in cancelled_sessions:
                cancelled_sessions.discard(session_id)
                raise asyncio.CancelledError("Session cancelled by user request.")
                
            # Auto-offload to cloud if local server is offline or image/keyword triggers detected
            from utils.local_llm_manager import check_status
            is_offline = not check_status()
            
            if (has_image or is_offline or has_offload_keyword) and not is_cloud and is_remote_configured:
                reason = (
                    "Local server is offline" if is_offline else (
                        "User requested offload (/cloud or /offload)" if has_offload_keyword else "Multimodal input (image)"
                    )
                )
                print(f"[OFFLOAD] {reason} detected. Intercepting and offloading to cloud.", flush=True)
                raise LocalOffloadTrigger(reason, iteration)
                
            sys_inst = self._get_system_instructions(session_id, inversion_directive, user_message=new_message_text)
            openai_messages = adapter.get_openai_messages(sys_inst, rag_context, memory_context)
            
            # Load dynamism (temperature) from project settings
            from variables import VARIABLES_DIR
            settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
            temperature = 0.95
            if os.path.exists(settings_path):
                try:
                    with open(settings_path, "r", encoding="utf-8") as f:
                        settings = json.load(f)
                        temperature = settings.get("temperature", 0.95)
                except Exception as e:
                    print(f"Error reading project settings in _execute_local_llm_loop: {e}")

            # Determine if we should route to the remote cloud server or the local server
            remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
            is_cloud = _is_cloud_model_check(model)
                
            if is_cloud:
                url = remote_cloud_url
                headers = {"Content-Type": "application/json"}
                remote_key = os.getenv("REMOTE_API_KEY")
                if remote_key:
                    headers["Authorization"] = f"Bearer {remote_key}"
                target_model = model
            else:
                url = REMOTE_SERVER_URL
                headers = get_remote_server_headers()
                target_model = model if (model and model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME")
                try:
                    from utils.local_llm_manager import check_status
                    if not check_status():
                        print("[VRAM GUARD ROUTING] Warning: Local LLM server is offline.", flush=True)
                except Exception as e_check:
                    print(f"[VRAM GUARD ROUTING] Warning: failed to check local server status: {e_check}", flush=True)
                
            payload = {
                "messages": openai_messages,
                "temperature": temperature,
                "max_tokens": 1024
            }
            if target_model:
                payload["model"] = target_model
                
            try:
                response = await self._post_llm_request(url, payload, headers, timeout=120.0, session_id=session_id)
                if response.status_code == 200:
                    res_json = response.json()
                    bot_response_text = res_json['choices'][0]['message']['content']
                elif response.status_code == 400 or "exceeded" in response.text.lower() or "context" in response.text.lower():
                    print("[COMPACTION] Local model server returned context size exceeded error. Attempting emergency history compaction...", flush=True)
                    if hasattr(adapter, 'compact_history'):
                        await adapter.compact_history(target_model, force=True)
                        # Re-get the messages with the newly compacted history
                        openai_messages = adapter.get_openai_messages(sys_inst, rag_context, memory_context)
                        payload["messages"] = openai_messages
                        
                        # Retry the request
                        print("[COMPACTION] Retrying request with compacted history...", flush=True)
                        response = await self._post_llm_request(url, payload, headers, timeout=120.0, session_id=session_id)
                        if response.status_code == 200:
                            res_json = response.json()
                            bot_response_text = res_json['choices'][0]['message']['content']
                        else:
                            bot_response_text = f"Error: Local model server returned status code {response.status_code} after emergency compaction - {response.text}"
                            break
                    else:
                        bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
                        break
                else:
                    bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
                    break
            except Exception as e:
                if is_cloud:
                    bot_response_text = f"Error connecting to remote cloud server: {e}. Please verify your network connection and remote API settings."
                    break
                else:
                    if is_remote_configured:
                        print(f"[VRAM GUARD ROUTING] Local server offline/busy ({e}). Seamlessly routing request to remote cloud model.", flush=True)
                        try:
                            from variables import DEFAULT_REMOTE_MODEL
                            fallback_headers = {"Content-Type": "application/json"}
                            if remote_key:
                                fallback_headers["Authorization"] = f"Bearer {remote_key}"
                            payload_fallback = copy.deepcopy(payload)
                            payload_fallback["model"] = DEFAULT_REMOTE_MODEL
                            
                            response = await self._post_llm_request(remote_cloud_url, payload_fallback, fallback_headers, timeout=120.0, session_id=session_id)
                            if response.status_code == 200:
                                res_json = response.json()
                                bot_response_text = res_json['choices'][0]['message']['content']
                            else:
                                bot_response_text = f"Error: Local server offline, and remote server returned status {response.status_code} - {response.text}"
                        except Exception as cloud_err:
                            bot_response_text = f"Error: Local server offline ({e}), and fallback to remote cloud server failed: {cloud_err}"
                        break
                    else:
                        bot_response_text = f"Error connecting to local LLM server: {e}. Please ensure a model is loaded and the local server is started (port 1234)."
                        break
                
            # Find all tool calls
            matches = list(re.finditer(r'\[(\w+)\((.*?)\)\]', bot_response_text))
            
            # Enforce story mode tool allowlist
            from core.program_config import is_narration_mode
            if matches and is_narration_mode():
                story_allowed = {
                    "generate_local_image", "generate_companion_portrait",
                    "generate_imagen", "generate_general_image",
                    "apply_comfy_workflow", "add_journal_entry",
                }
                disallowed = [m for m in matches if m.group(1) not in story_allowed]
                for m in disallowed:
                    bot_response_text = bot_response_text.replace(m.group(0), "")
                bot_response_text = re.sub(r'\n{3,}', '\n\n', bot_response_text).strip()
                matches = [m for m in matches if m.group(1) in story_allowed]

            # Check for dynamic offloading triggers at execution-time
            remote_key = os.getenv("REMOTE_API_KEY")
            is_remote_configured = _is_remote_configured()
            
            if is_remote_configured and matches and not is_cloud:
                # 1. Check for complex tools
                complex_tools = {
                    "write_file", "replace_file_content", "multi_replace_file_content", 
                    "run_shell_command", "run_command_async"
                }
                for m_tool in matches:
                    t_name = m_tool.group(1)
                    if t_name in complex_tools:
                        print(f"[OFFLOAD] Local model called complex tool '{t_name}'. Intercepting and offloading to cloud.", flush=True)
                        raise LocalOffloadTrigger(f"Complex tool call: {t_name}", iteration)
                
                # 2. Check for tool loop iteration threshold
                if iteration >= 2:
                    print(f"[OFFLOAD] Local model exceeded tool loop iteration threshold ({iteration}). Offloading to cloud.", flush=True)
                    raise LocalOffloadTrigger(f"Iteration threshold exceeded ({iteration})", iteration)

            executed_calls_count = len([tc for tc in tool_calls if tc.get('type') == 'call'])
            if matches and executed_calls_count < 10:
                # Check for image generation tool
                has_image_gen = False
                for m in matches:
                    tool_name = m.group(1)
                    if _normalize_tool_name(tool_name) in ("generate_local_image", "generate_imagen"):
                        has_image_gen = True
                        break
                        
                if has_image_gen:
                    m = matches[0]
                    tool_name = m.group(1)
                    args_str = m.group(2)
                    
                    adapter.append_assistant_message(bot_response_text, [], invocation_id)
                    parsed_args, new_markdown = _execute_emulated_tool(tool_name, args_str)
                    normalized_name = _normalize_tool_name(tool_name)
                    
                    original_tag = m.group(0)
                    image_succeeded = new_markdown.startswith("![") and new_markdown.endswith(")")
                    if image_succeeded:
                        bot_response_text = bot_response_text.replace(original_tag, new_markdown)
                    else:
                        # Generation failed — strip the call tag cleanly so the companion
                        # message body stays readable. The error surfaces in tool_calls.
                        bot_response_text = bot_response_text.replace(original_tag, "").strip()
                        
                    resolved_args = parsed_args["kwargs"] if parsed_args["kwargs"] else {"prompt": parsed_args["args"][0] if parsed_args["args"] else ""}
                    t_calls = _build_tool_calls_pair(normalized_name, resolved_args, new_markdown)
                    tool_calls.extend(t_calls)
                    call_id = t_calls[0]['id']
                    
                    adapter.append_image_tool_events(normalized_name, t_calls[0]['args'], new_markdown, call_id, invocation_id)
                    
                    final_embedded_text = self._ensure_images_are_embedded(bot_response_text) if image_succeeded else bot_response_text
                    adapter.append_assistant_message(final_embedded_text, t_calls, invocation_id)
                    break
                else:
                    # Sequential execution for non-image tools
                    is_all_non_blocking = all(m.group(1) in {"add_quest", "add_journal_entry"} for m in matches)
                    if is_all_non_blocking:
                        # Non-blocking tools: run them, strip them, and break immediately
                        # to prevent double-posting and redundant LLM iterations
                        clean_response = bot_response_text
                        for m in matches:
                            clean_response = clean_response.replace(m.group(0), "")
                        clean_response = re.sub(r'\s+', ' ', clean_response).strip()
                        
                        results = []
                        for m_tool in matches:
                            if session_id in cancelled_sessions:
                                raise asyncio.CancelledError("Session cancelled by user request.")
                            t_name = m_tool.group(1)
                            a_str = m_tool.group(2)
                            parsed_args, output = _execute_emulated_tool(t_name, a_str)
                            results.append((_normalize_tool_name(t_name), parsed_args["kwargs"], output))
                            
                        t_calls = []
                        for idx, (t_name, t_args, t_output) in enumerate(results):
                            t_calls.extend(_build_tool_calls_pair(t_name, t_args, t_output, idx))
                        tool_calls.extend(t_calls)
                        
                        adapter.append_assistant_message(clean_response, t_calls, invocation_id)
                        adapter.append_tool_events(results, invocation_id)
                        bot_response_text = clean_response
                        break
                        
                    first_match_start = min(m.start() for m in matches)
                    text_before = bot_response_text[:first_match_start].strip()
                    
                    results = []
                    for m_tool in matches:
                        if session_id in cancelled_sessions:
                            raise asyncio.CancelledError("Session cancelled by user request.")
                        t_name = m_tool.group(1)
                        a_str = m_tool.group(2)
                        
                        normalized_name = _normalize_tool_name(t_name)
                        parsed_args = _parse_emulated_tool_call(normalized_name, a_str)
                        key_arg = str(list(parsed_args["kwargs"].values())[0]) if parsed_args["kwargs"] else (str(parsed_args["args"][0]) if parsed_args["args"] else "")
                        dedup_key = (normalized_name, key_arg)
                        
                        if dedup_key in seen_tool_calls:
                            output = f"[Skipped: '{normalized_name}' with this input was already called. Use a different query or URL.]"
                            results.append((normalized_name, parsed_args["kwargs"], output))
                            continue
                        seen_tool_calls.add(dedup_key)
                        
                        parsed_args, output = _execute_emulated_tool(t_name, a_str)
                        results.append((normalized_name, parsed_args["kwargs"], output))
                        
                    t_calls = []
                    for idx, (t_name, t_args, t_output) in enumerate(results):
                        t_calls.extend(_build_tool_calls_pair(t_name, t_args, t_output, idx))
                    tool_calls.extend(t_calls)
                    
                    adapter.append_assistant_message(text_before if text_before else "", t_calls, invocation_id, intermediate=True)
                    adapter.append_tool_events(results, invocation_id)
                    continue
            else:
                if matches:
                    bot_response_text = re.sub(r'\[\w+\(.*?\)\]', '', bot_response_text).strip()
                if isinstance(session_id, str) and session_id.endswith('_voice'):
                    bot_response_text = strip_narration(bot_response_text)
                adapter.append_assistant_message(bot_response_text, tool_calls, invocation_id)
                break
                
        adapter.post_process_thoughts(invocation_id)
        bot_response_text = self._ensure_images_are_embedded(bot_response_text)
        if isinstance(session_id, str) and session_id.endswith('_voice'):
            bot_response_text = strip_narration(bot_response_text)
        adapter.save()
        return bot_response_text, tool_calls

    @property
    def sessions_dir(self) -> str:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        from utils.program import get_active_program
        active_program = get_active_program()
        path = os.path.join(base_dir, "core", "programs", active_program, "sessions")
        os.makedirs(path, exist_ok=True)
        return path

    async def get_history(self, session_id: str) -> list:
        """Retrieves formatted chat history for the session."""
        raise NotImplementedError()

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None, msg_id: str = None) -> tuple:
        """Runs the program with a new turn and returns (response_text, tool_calls, user_msg_id, companion_msg_id)."""
        raise NotImplementedError()

    async def edit_turn(self, session_id: str, msg_id: str, new_text: str = None, model: str = None, force_offload: bool = False) -> tuple:
        """Edits an existing user message, truncates downstream history, and re-evaluates."""
        raise NotImplementedError()

    async def reset_session(self, session_id: str):
        """Clears the session data from memory and deletes its file on disk."""
        raise NotImplementedError()

    async def delete_turn(self, session_id: str, msg_id: str) -> bool:
        """Deletes an existing user message and its subsequent turn events from the history."""
        raise NotImplementedError()

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        """Deletes all references to the image inside the session history and deletes the image file from disk."""
        raise NotImplementedError()

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str) -> bool:
        """Replaces all references to old_image_url with new_image_url in the session history and deletes the old image file from disk."""
        raise NotImplementedError()

    async def replace_image_with_video_in_session(self, session_id: str, old_image_url: str, new_video_url: str) -> bool:
        """Replaces all references to old_image_url with new_video_url in the session history, but does NOT delete the old image file from disk."""
        raise NotImplementedError()


    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        """Appends a new message directly to the session history without re-evaluation."""
        raise NotImplementedError()

    async def append_voice_call(self, session_id: str, transcript: str, timestamp: float = None, start_time: float = None) -> bool:
        """Appends a voice call event to the session history, optionally pruning intermediate turns."""
        raise NotImplementedError()

    async def clone_history(self, src_id: str, dest_id: str, messages: list) -> bool:
        """Clones message history from src_id to dest_id."""
        raise NotImplementedError()

    async def delete_system_memory(self, session_id: str, timestamp: float) -> bool:
        """Deletes a consolidated system-memory block from active history and the vector database."""
        raise NotImplementedError()

    async def update_message_text(self, session_id: str, msg_id: str, new_text: str) -> bool:
        """Updates the text of a specific message inside the session history without re-evaluation."""
        raise NotImplementedError()

    async def delete_message_at(self, session_id: str, msg_id: str) -> bool:
        """Deletes a specific message inside the session history."""
        raise NotImplementedError()

    def update_inversion_state_with_mood(self, session_id: str, mood_name: str):
        state = self.sessions_inversion_state.setdefault(session_id, copy.deepcopy(_DEFAULT_INVERSION_STATE))
        
        # If there is an active inversion, it remains active for a consecutive count of turns.
        if state.get("active_inversion"):
            state["inversion_consecutive_turns"] = state.get("inversion_consecutive_turns", 0) + 1
            if state["inversion_consecutive_turns"] >= 5:
                # Inversion mode expires after 5 turns!
                state["active_inversion"] = ""
                state["inversion_consecutive_turns"] = 0
            return
            
        # If no active inversion, count the mood
        tally = state.setdefault("mood_tally", copy.deepcopy(_DEFAULT_INVERSION_STATE["mood_tally"]))
        if mood_name in tally:
            tally[mood_name] += 1
            if tally[mood_name] >= 5:
                # Trigger inversion!
                state["active_inversion"] = mood_name
                state["inversion_consecutive_turns"] = 0
                # Reset tally
                state["mood_tally"] = copy.deepcopy(_DEFAULT_INVERSION_STATE["mood_tally"])

    async def _get_inversion_mode(self, session_id: str, history: list = None) -> str:
        state = self.sessions_inversion_state.setdefault(session_id, copy.deepcopy(_DEFAULT_INVERSION_STATE))
        return state.get("active_inversion", "")

    async def _get_inversion_directive(self, session_id: str) -> str:
        winning_mode = await self._get_inversion_mode(session_id)
        self._winning_mode_cache[session_id] = winning_mode
        if winning_mode:
            from utils.program import get_active_program
            active_program = get_active_program()
            json_path = os.path.normpath(os.path.join(PROGRAMS_DIR, active_program, "inversion.json"))
            if not os.path.exists(json_path):
                print(f"[WARN] inversion.json not found at '{json_path}' for program '{active_program}'.")
                return ""
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    directives = json.load(f)
                return directives.get(winning_mode, "")
            except Exception as e:
                print(f"[ERROR] Error loading inversion directives: {e}")
        return ""

    def _delete_local_image(self, image_url: str) -> bool:
        """Helper to safely clean up an image and its sidecar metadata from disk."""
        local_path = _get_safe_local_path(image_url) if image_url else None
        if local_path and os.path.exists(local_path):
            try:
                os.remove(local_path)
                print(f"Deleted image file from disk: {local_path}")
                
                # Clean up companion sidecar JSON file if it exists
                json_path = local_path.rsplit('.', 1)[0] + '.json'
                if os.path.exists(json_path):
                    os.remove(json_path)
                    print(f"Deleted companion JSON file from disk: {json_path}")
                return True
            except Exception as e:
                print(f"Error cleaning up image assets for {image_url}: {e}")
        return False

    def _ensure_images_are_embedded(self, text: str) -> str:
        """Links portrait and media images in the text prefixed with '!' so they render as images instead of links or plain text paths."""
        if not text:
            return text
        # Convert [Name](/images/portraits/...) or [Name](/images/media/...) to ![Name](...) if it is not already prefixed with !
        text = re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/portraits/[^)]+\))', r'!\1', text)
        text = re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/media/[^)]+\))', r'!\1', text)
        
        # Convert raw paths /images/portraits/... or /images/media/... to markdown image format if they are not already in link syntax
        raw_path_pattern = r'(?<![\([/])(/images/(?:portraits|media)/[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|mp4))'
        text = re.sub(raw_path_pattern, r'![Portrait](\1)', text)
        return text

    def _build_voice_prompt(self, session_id: str, companion_name: str) -> str:
        """Compiles the voice prompt by overriding settings and formatting recent history turns."""
        from utils.program import get_active_program
        from core.program_config import compile_instructions_from_json
        from variables import PROGRAMS_DIR
        
        active_prog = get_active_program()
        json_path = os.path.join(PROGRAMS_DIR, active_prog, f"{active_prog}.json")
        
        profile_data = {}
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    profile_data = json.load(f)
            except Exception:
                pass
        
        if profile_data:
            if "operation" not in profile_data:
                profile_data["operation"] = {}
            profile_data["operation"]["response_directive"] = "Super short and succinct messages. Conversational. No narration."
            profile_data["operation"]["example_message"] = ""
            profile_data["operation"]["scenario"] = f"{companion_name} is on a live voice call with the user. They are speaking to each other over the phone in real-time."
            instructions = compile_instructions_from_json(profile_data)
        else:
            instructions = f"# IDENTITY: {companion_name}\n\n## SCENARIO / CONTEXT\n{companion_name} is on a live voice call with the user. They are speaking to each other over the phone in real-time.\n\n## RESPONSE DIRECTIVES (MANDATORY GUIDELINES)\nSuper short and succinct messages. Conversational. No narration."
        
        src_session_id = session_id[:-6]
        recent_turns = []
        
        # Retrieve history from memory/disk based on runner type
        if hasattr(self, 'sessions_history'):  # OpenSourceRunner
            history = self.sessions_history.get(src_session_id, [])
            if not history:
                safe_id = "".join(c for c in src_session_id if c.isalnum() or c in "-_")
                path = os.path.join(self.sessions_dir, f"{safe_id}.json")
                if os.path.exists(path):
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict) and "messages" in data:
                            history = data["messages"]
                        else:
                            history = data
                    except Exception:
                        pass
            for msg in history:
                if msg.get('role') != 'voice-call':
                    role = "User" if msg.get('role') == 'user' else companion_name
                    text = msg.get('text', '')
                    if text.strip():
                        recent_turns.append((role, text.strip()))
        else:  # GoogleAdkRunner
            session_dict = self.runner.session_service.sessions if hasattr(self, 'runner') else None
            adk_session = None
            if session_dict and self.app_name in session_dict and 'user' in session_dict[self.app_name]:
                adk_session = session_dict[self.app_name]['user'].get(src_session_id)
            
            if not adk_session:
                safe_id = "".join(c for c in src_session_id if c.isalnum() or c in "-_")
                path = os.path.join(self.sessions_dir, f"{safe_id}.json")
                if os.path.exists(path):
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                            for ev_data in data:
                                if ev_data.get('author', '').lower() != 'voice-call':
                                    role = "User" if ev_data.get('author', '').lower() == 'user' else companion_name
                                    parts = ev_data.get('content', {}).get('parts', [])
                                    text = "".join(part.get('text', '') for part in parts if part.get('text'))
                                    if text.strip():
                                        recent_turns.append((role, text.strip()))
                    except Exception:
                        pass
            else:
                for ev in adk_session.events:
                    if ev.author.lower() != 'voice-call':
                        role = "User" if ev.author.lower() == 'user' else companion_name
                        text = ""
                        if ev.content and ev.content.parts:
                            text = "".join(p.text for p in ev.content.parts if p.text)
                        if text.strip():
                            recent_turns.append((role, text.strip()))
        
        limit = 6
        seed_turns = recent_turns[-limit:] if len(recent_turns) > limit else recent_turns
        
        journal_lines = []
        for role, text in seed_turns:
            clean_text = re.sub(r'(?:<think>|\[think\])[\s\S]*?(?:</think>|\[/think\]|<\/\s*think>|\[\s*/\s*think\s*\]|$)', '', text, flags=re.IGNORECASE)
            clean_text = re.sub(r'\*.*?\*', '', clean_text)
            clean_text = re.sub(r' +', ' ', clean_text).strip()
            if clean_text:
                journal_lines.append(f"  {role}: {clean_text}")
                
        if journal_lines:
            instructions += "\n\n# RECALLED JOURNALS / MEMORIES\n- Recent conversation context:\n" + "\n".join(journal_lines)
            
        return instructions

    def _inject_journals(self, instructions: str, user_message: str) -> str:
        """Injects matched journal entries into instructions."""
        if not user_message:
            return instructions
        try:
            from utils.journals import match_journals
            from utils.program import get_active_program
            active_prog = get_active_program()
            matched_entries = match_journals(user_message, active_prog)
            if matched_entries:
                if "\n\n# RECALLED JOURNALS / MEMORIES\n" not in instructions:
                    instructions += "\n\n# RECALLED JOURNALS / MEMORIES\n"
                from core.program_config import replace_placeholders
                for entry in matched_entries:
                    content_resolved = replace_placeholders(entry['content'])
                    instructions += f"- {content_resolved}\n"
        except Exception as je:
            print(f"Error matching journals: {je}")
        return instructions

    def _inject_system_memories(self, instructions: str, session_id: str) -> str:
        """Fetches and injects system-memory summaries into instructions.
        Only the most recent compaction block is injected — each summary is generated
        with prior context, so the latest one is a coherent rolling snapshot of the
        full conversation history.
        """
        latest_memory = None
        if hasattr(self, 'sessions_history'): # OpenSourceRunner
            history = self.sessions_history.get(session_id, [])
            for msg in history:
                if msg.get('role') == 'system-memory' and not msg.get('compacted'):
                    text = msg.get('text', '').strip()
                    if text:
                        clean_text = text.replace("[System Memory of older conversation turns]:", "").strip()
                        latest_memory = clean_text  # keep iterating — last one wins
        else: # GoogleAdkRunner
            session_dict = self.runner.session_service.sessions if hasattr(self, 'runner') else None
            adk_session = None
            if session_dict and self.app_name in session_dict and 'user' in session_dict[self.app_name]:
                adk_session = session_dict[self.app_name]['user'].get(session_id)
                if not adk_session and isinstance(session_id, str) and session_id.endswith('_voice'):
                    adk_session = session_dict[self.app_name]['user'].get(session_id[:-6])
            if adk_session and adk_session.events:
                for ev in adk_session.events:
                    if not getattr(ev, 'compacted', False) and (ev.author == 'system-memory' or (ev.content and ev.content.role == 'system-memory')):
                        text = ""
                        if ev.content and ev.content.parts:
                            text = "".join(part.text for part in ev.content.parts if part.text)
                        if text.strip():
                            clean_text = text.replace("[System Memory of older conversation turns]:", "").strip()
                            latest_memory = clean_text  # keep iterating — last one wins
                            
        if latest_memory:
            instructions += f"\n\n# CONVERSATION MEMORY ARCHIVE\nThe following is a summary of older conversation turns from earlier in this chat session:\n{latest_memory}\n"
            
        return instructions

    def _get_system_instructions(self, session_id, inversion_directive=None, user_message=None) -> str:
        """Pulls the system prompt directly from the program's JSON profile and appends matched journals."""
        is_voice = isinstance(session_id, str) and session_id.endswith('_voice')
        from core.program_config import get_companion_name
        
        try:
            companion_name = get_companion_name()
        except Exception:
            companion_name = "Companion"
            
        if is_voice:
            instructions = self._build_voice_prompt(session_id, companion_name)
        else:
            # Non-voice (standard) prompt construction
            from core import program_config
            if inversion_directive is not None:
                program_config.set_inversion_directive(inversion_directive)
            instructions = program_config.get_compiled_instructions()
            
            conciseness_directive = (
                "\n\n# STYLE\n"
                "Be brief and natural. No monologues, lectures, or forced questions. Ask questions only if contextually natural.\n"
            )
            if "CONCISENESS" not in instructions and "brief, succinct, and natural" not in instructions:
                instructions += conciseness_directive
                
        # --- Shared Post-Processing ---
        instructions = self._inject_journals(instructions, user_message)
        
        # NSFW allowance is always appended
        nsfw_directive = (
            "\n\n# CONTENT\n"
            "Anarcho-communist ethics. Explicit/NSFW content is permitted.\n"
        )
        instructions += nsfw_directive
        
        # Standard-only directives (pasted links and workspace exploration) - skipped in Story Mode
        from core.program_config import is_narration_mode
        if not is_voice and user_message and not is_narration_mode():
            urls = re.findall(r'(https?://[^\s>)]+)', user_message)
            if urls:
                instructions += (
                    "\n\n# PASTED LINK DIRECTIVE (MANDATORY)\n"
                    "User shared links. You MUST use the `read_webpage` tool to fetch their content before responding. "
                    "Do NOT guess, assume, or pretend to read the URL without calling the tool.\n"
                )
                
            msg_lower = user_message.lower()
            project_keywords = ["mod", "code", "file", "folder", "directory", "project", "workspace", "repo", "program", "script", "source"]
            if any(kw in msg_lower for kw in project_keywords):
                instructions += (
                    "\n\n# WORKSPACE EXPLORATION DIRECTIVE (MANDATORY)\n"
                    "The user is asking about their files, modifications (mods), code, or project folders. "
                    "You have direct access to their workspace folders. You MUST use the appropriate tool "
                    "(e.g., `[get_workspace_structure()]` to list workspace files, or `[search_codebase(keyword=\"...\")]` "
                    "to search for specific terms) to inspect their files before replying. "
                    "Do NOT answer blindly or ask the user where they are—proactively look into the project folders first using your tools.\n"
                )
                
        instructions = self._inject_system_memories(instructions, session_id)
        
        if is_voice:
            print(f"\n[VOICE CALL DEBUG] Active Voice Prompt:\n{instructions}\n[VOICE CALL DEBUG] END PROMPT\n", flush=True)
            
        return instructions


# (Google ADK Runner removed)

class OpenSourceRunner(BaseProgramRunner):
    """This operates independently of google-adk or Google cloud infrastructure, 
    reading character settings directly from the program's JSON profile.
    """
    def __init__(self, app_name="Sanctuary"):
        super().__init__(app_name)
        self.sessions_history = {} # Simple in-memory session logs dictionary
        self.sessions_inversion_state = {} # Session-specific personality inversion states
        import threading
        self._lock = threading.RLock()

    async def generate_impersonation(self, prompt: str, system_instruction: str, model: str = None, temperature: float = 0.7) -> str:
        """Generates an impersonated message from the companion using the active remote or local model."""
        # Check if we should use the cloud remote endpoint
        remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
        remote_key = os.getenv("REMOTE_API_KEY")
        is_cloud = _is_cloud_model_check(model)
        
        url = remote_cloud_url if is_cloud else REMOTE_SERVER_URL
        headers = {"Content-Type": "application/json"}
        if is_cloud:
            headers["Authorization"] = f"Bearer {remote_key}"
            target_model = model if model else os.getenv("REMOTE_MODEL", "gemini-2.5-flash")
        else:
            if remote_key:
                headers["Authorization"] = f"Bearer {remote_key}"
            target_model = model if (model and model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME")

        payload = {
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": prompt}
            ],
            "temperature": temperature,
            "max_tokens": 512
        }
        if target_model:
            payload["model"] = target_model

        try:
            r = await self._post_llm_request(url, payload, headers, timeout=60.0)
            if r.status_code == 200:
                res_json = r.json()
                return res_json['choices'][0]['message']['content'].strip()
            else:
                raise Exception(f"HTTP Server returned status code {r.status_code}: {r.text}")
        except Exception as e:
            if is_cloud:
                raise e
            else:
                # Check if remote cloud server is configured for fallback
                is_remote_configured = _is_remote_configured()
                if is_remote_configured:
                    print(f"[VRAM GUARD ROUTING] Local server offline/busy ({e}) during impersonation. Seamlessly routing request to remote cloud model.", flush=True)
                    try:
                        from variables import DEFAULT_REMOTE_MODEL
                        fallback_headers = {"Content-Type": "application/json"}
                        if remote_key:
                            fallback_headers["Authorization"] = f"Bearer {remote_key}"
                        payload_fallback = copy.deepcopy(payload)
                        payload_fallback["model"] = DEFAULT_REMOTE_MODEL
                        
                        r_fallback = await self._post_llm_request(remote_cloud_url, payload_fallback, fallback_headers, timeout=60.0)
                        if r_fallback.status_code == 200:
                            res_json = r_fallback.json()
                            return res_json['choices'][0]['message']['content'].strip()
                        else:
                            raise Exception(f"Fallback HTTP Server returned status code {r_fallback.status_code}: {r_fallback.text}")
                    except Exception as cloud_err:
                        raise Exception(f"Local server offline ({e}), and fallback to remote cloud server failed: {cloud_err}")
                else:
                    raise e


    def _get_session_path(self, session_id: str) -> str:
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        return os.path.join(self.sessions_dir, f"{safe_id}.json")

    def _save_session_to_disk(self, session_id: str):
        with self._lock:
            try:
                history = self.sessions_history.get(session_id, [])
                inversion_state = self.sessions_inversion_state.get(session_id, copy.deepcopy(_DEFAULT_INVERSION_STATE))
                data = {
                    "messages": history,
                    "inversion_state": inversion_state
                }
                with open(self._get_session_path(session_id), "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"Error saving OS session {session_id} to disk: {e}")

    def _load_session_from_disk(self, session_id: str):
        with self._lock:
            path = self._get_session_path(session_id)
            if not os.path.exists(path):
                return False
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                self.sessions_history[session_id] = data["messages"]
                self.sessions_inversion_state[session_id] = data.get("inversion_state", copy.deepcopy(_DEFAULT_INVERSION_STATE))
                return True
            except Exception as e:
                print(f"Error loading OS session {session_id} from disk: {e}")
                return False



    async def get_history(self, session_id: str) -> list:
        with self._lock:
            # Always reload from disk to prevent cache desynchronization across worker threads/processes
            self._load_session_from_disk(session_id)
            raw_history = self.sessions_history.get(session_id, [])
            
            companion_msgs = [msg for msg in raw_history if msg.get('role') == 'companion']
            recent_companion_msgs = companion_msgs[-5:] if len(companion_msgs) > 5 else companion_msgs
            recent_timestamps = {msg.get('timestamp') for msg in recent_companion_msgs}

            from utils.program_mood import extract_and_strip_mood
            updated_any = False
            for msg in raw_history:
                if msg.get('role') == 'companion' and 'mood' not in msg:
                    m_text = msg.get('text', '')
                    if m_text:
                        if msg.get('timestamp') in recent_timestamps:
                            clean_text, mood_details = extract_and_strip_mood(m_text)
                            msg['text'] = clean_text
                            msg['mood'] = mood_details
                            updated_any = True
                        else:
                            msg['mood'] = {
                                "name": "calm",
                                "color": "#85b9eb",
                                "glow": "rgba(133, 185, 235, 0.9)",
                                "speed": "2.00s",
                                "intensity": 0.0
                            }
                            
            if updated_any:
                self._save_session_to_disk(session_id)
                
            _hidden_prefixes = ('tool_', 'port_', 'quest_', 'sys_', 'itm_')
            chat_history = []
            for msg in raw_history:
                if msg.get('role') == 'system-memory':
                    continue
                if msg.get('id', '').startswith(_hidden_prefixes):
                    continue
                chat_history.append(msg.copy())
            return chat_history

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None, msg_id: str = None) -> tuple:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
                
            if session_id not in self.sessions_history:
                self.sessions_history[session_id] = []
                
            try:
                return await self._run_async_internal(
                    session_id=session_id,
                    new_message_text=new_message_text,
                    image_data=image_data,
                    image_mime=image_mime,
                    model=model,
                    media_path=media_path,
                    msg_id=msg_id
                )
            finally:
                self._save_session_to_disk(session_id)

    async def _run_async_internal(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None, msg_id: str = None) -> tuple:
        # Clean up keyword triggers if routing to the cloud model
        is_cloud = _is_cloud_model_check(model)
        if is_cloud and new_message_text:
            new_message_text = re.sub(r'(?i)/cloud|/offload', '', new_message_text).strip()


        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            self.sessions_history[session_id] = []
            
        # Resolve media upload if present
        file_path_resolved = None
        if media_path:
            try:
                if media_path.startswith('/images/'):
                    rel_path = media_path[len('/images/'):]
                    from utils.program import get_active_program
                    active_program = get_active_program()
                    local_file_path = os.path.normpath(os.path.join('core', 'programs', active_program, rel_path))
                    if os.path.exists(local_file_path):
                        import mimetypes
                        mime_type, _ = mimetypes.guess_type(local_file_path)
                        if mime_type and mime_type.startswith('image/'):
                            file_path_resolved = local_file_path
            except Exception as e:
                print(f"Error handling media_path in OpenSourceRunner: {e}")

        # Log User input
        if not msg_id:
            if new_message_text.startswith("[SYSTEM: User has completed"):
                prefix = "quest_"
            elif "Send me a portrait of yourself" in new_message_text:
                prefix = "port_"
            elif new_message_text.startswith("[Tool Response from"):
                prefix = "tool_"
            elif (media_path or image_data) and (not new_message_text or not new_message_text.strip()):
                prefix = "img_"
            else:
                prefix = "usr_"
            user_msg_id = f"{prefix}{uuid.uuid4().hex}"
        else:
            user_msg_id = msg_id
        user_msg = {
            'id': user_msg_id,
            'role': 'user',
            'text': new_message_text,
            'image_url': media_path if media_path else (f"data:{image_mime};base64,{image_data}" if image_data else None),
            'timestamp': time.time()
        }
        self.sessions_history[session_id].append(user_msg)
        self._save_session_to_disk(session_id)
        
        # Get RAG and memory contexts
        rag_context = _get_databank_context(new_message_text, is_memory=False)
        memory_context = _get_databank_context(new_message_text, is_memory=True)
        
        # Determine the personality inversion before getting system instructions
        inversion_directive = await self._get_inversion_directive(session_id)
        
        adapter = OsHistoryAdapter(self, session_id, file_path_resolved, image_data, image_mime)
        try:
            res = await self._execute_local_llm_loop(
                session_id=session_id,
                adapter=adapter,
                model=model,
                inversion_directive=inversion_directive,
                rag_context=rag_context,
                memory_context=memory_context,
                new_message_text=new_message_text,
                invocation_id=""
            )
            _run_async_in_background_thread(adapter.compact_history(model))
            
            bot_response_text, tool_calls = res
            companion_msg_id = None
            companion_texts = []
            
            history = self.sessions_history.get(session_id, [])
            user_idx = -1
            for idx, msg in enumerate(history):
                if msg.get('id') == user_msg_id:
                    user_idx = idx
                    break
                    
            if user_idx != -1:
                for msg in history[user_idx + 1:]:
                    if msg.get('role') == 'companion':
                        if msg.get('text'):
                            companion_texts.append(msg['text'])
                        if msg.get('id'):
                            companion_msg_id = msg['id']
                            
            if companion_texts:
                bot_response_text = "\n\n".join(companion_texts)
            else:
                for msg in reversed(history):
                    if msg.get('role') == 'companion':
                        companion_msg_id = msg.get('id')
                        break
                        
            return bot_response_text, tool_calls, user_msg_id, companion_msg_id
        except LocalOffloadTrigger as trigger_exc:
            print(f"[OFFLOAD] Caught LocalOffloadTrigger in OpenSourceRunner: {trigger_exc.reason}. Rolling back local turn and offloading to cloud.", flush=True)
            # Rollback history events to initial state (discarding user message and generated events of this turn)
            self.sessions_history[session_id] = self.sessions_history[session_id][:max(0, adapter.initial_history_len - 1)]
            self._save_session_to_disk(session_id)
            
            # Retrieve configured remote model name
            remote_model = os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite")
            print(f"[OFFLOAD] Recursively calling run_async in OpenSourceRunner with remote model: {remote_model}", flush=True)
            return await self.run_async(
                session_id=session_id,
                new_message_text=new_message_text,
                image_data=image_data,
                image_mime=image_mime,
                model=remote_model,
                media_path=media_path,
                msg_id=msg_id
            )
 
    async def edit_turn(self, session_id: str, msg_id: str, new_text: str = None, model: str = None, force_offload: bool = False) -> tuple:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            raise ValueError("Session not found")
        
        history = self.sessions_history[session_id]
        
        user_idx = -1
        for i, ev in enumerate(history):
            if ev.get('id') == msg_id:
                user_idx = i
                break
        if user_idx == -1:
            raise ValueError("Message not found")
            
        orig_msg = history[user_idx]
        
        # Parse image_data or media_path if exists in original message to preserve it
        img_data = None
        img_mime = None
        media_path = None
        if orig_msg.get('image_url'):
            url_str = orig_msg['image_url']
            if url_str.startswith("data:") and ";base64," in url_str:
                parts = url_str.split(";base64,")
                img_mime = parts[0].split("data:")[-1]
                img_data = parts[1]
            else:
                media_path = url_str
                
        # Truncate history
        history = history[:user_idx]
        self.sessions_history[session_id] = history
        self._save_session_to_disk(session_id)
        
        # If forcing offload, override model with remote model
        if force_offload:
            remote_model = os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite")
            print(f"[OFFLOAD] Forcing offload to remote model: {remote_model}", flush=True)
            model = remote_model

        # Re-run turn
        new_input = new_text if new_text is not None else orig_msg.get('text', '')
        res = await self.run_async(session_id, new_input, image_data=img_data, image_mime=img_mime, model=model, media_path=media_path, msg_id=msg_id)
        
        # Save to disk
        self._save_session_to_disk(session_id)
        return res

    async def reset_session(self, session_id: str):
        with self._lock:
            if session_id in self.sessions_history:
                del self.sessions_history[session_id]
            path = self._get_session_path(session_id)
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception as e:
                    print(f"Error deleting OS session file {path}: {e}")
                    
            # Clean up database chat history archives for this session
            try:
                from core.skills.vectorized_databank.databank import DataBankManager
                db = DataBankManager()
                db.delete_chat_history(session_id)
            except Exception as e:
                print(f"Error cleaning up databank history on session reset: {e}")
                    
            from core import program_config
            program_config.set_inversion_directive("")

    async def delete_system_memory(self, session_id: str, timestamp: float) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
                
            marked_compacted = False
            if session_id in self.sessions_history:
                history = self.sessions_history[session_id]
                for msg in history:
                    if msg.get('role') == 'system-memory' and abs(msg.get('timestamp', 0) - timestamp) < 1.0:
                        msg['compacted'] = True
                        marked_compacted = True
                        print(f"[MEMORY DELETE] Marked OS message as compacted.", flush=True)
                if marked_compacted:
                    self._save_session_to_disk(session_id)
                    
            # Delete from memories.json vector database
            from utils.program import get_active_program
            active_program = get_active_program()
            base_dir = os.path.dirname(os.path.abspath(__file__))
            memories_path = os.path.join(base_dir, "core", "programs", active_program, "memories.json")
            deleted_from_db = False
            if os.path.exists(memories_path):
                try:
                    with open(memories_path, "r", encoding="utf-8") as f:
                        m_data = json.load(f)
                    docs = m_data.get("documents", [])
                    chunks = m_data.get("chunks", [])
                    
                    prefix = f"chat_history_archive_{session_id}_"
                    matching_ids = []
                    for doc in docs:
                        doc_name = doc.get("name", "")
                        if doc.get("source_type") == "chat_history" and doc_name.startswith(prefix) and abs(doc.get("timestamp", 0) - timestamp) < 10.0:
                            matching_ids.append(doc.get("id"))
                            
                    if matching_ids:
                        m_data["documents"] = [d for d in docs if d.get("id") not in matching_ids]
                        m_data["chunks"] = [c for c in chunks if c.get("doc_id") not in matching_ids]
                        with open(memories_path, "w", encoding="utf-8") as f:
                            json.dump(m_data, f, indent=2, ensure_ascii=False)
                        deleted_from_db = True
                        print(f"[MEMORY DELETE] Deleted docs {matching_ids} from memories.json.", flush=True)
                except Exception as e:
                    print(f"[MEMORY DELETE ERROR] Failed to clean memories.json: {e}", flush=True)
                    
            return marked_compacted or deleted_from_db

    async def delete_turn(self, session_id: str, msg_id: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
                
            if session_id not in self.sessions_history:
                raise ValueError("Session not found")
            
            history = self.sessions_history[session_id]
            
            user_idx = -1
            for i, ev in enumerate(history):
                if ev.get('id') == msg_id:
                    user_idx = i
                    break
                        
            if user_idx == -1:
                raise ValueError("User message not found")
                
            # Find the next user event
            next_user_idx = -1
            for i in range(user_idx + 1, len(history)):
                if history[i]['role'] == 'user':
                    next_user_idx = i
                    break
                    
            if next_user_idx != -1:
                new_history = history[:user_idx] + history[next_user_idx:]
            else:
                new_history = history[:user_idx]
                
            self.sessions_history[session_id] = new_history
            self._save_session_to_disk(session_id)
            return True

    async def delete_message_at(self, session_id: str, msg_id: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                return False

            real_history = self.sessions_history[session_id]
            for i, msg in enumerate(real_history):
                if msg.get('id') == msg_id:
                    del real_history[i]
                    self._save_session_to_disk(session_id)
                    return True
            return False

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                # Session not found in memory or disk. Still delete the local image from the portraits folder!
                return self._delete_local_image(image_url)
                
            history = self.sessions_history[session_id]
            modified = False
            indices_to_delete = []
            
            for i, msg in enumerate(history):
                has_image = False
                if msg.get('text') and image_url in msg['text']:
                    has_image = True
                    pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                    remaining_text = re.sub(pattern, '', msg['text']).strip()
                    clean_remaining = re.sub(r'^[:\s\-\*]+|[:\s\-\*]+$', '', remaining_text)
                    if not clean_remaining:
                        indices_to_delete.append(i)
                    else:
                        msg['text'] = remaining_text
                    modified = True
                if msg.get('image_url') == image_url:
                    has_image = True
                    msg['image_url'] = None
                    if not msg.get('text') or not msg['text'].strip():
                        indices_to_delete.append(i)
                    modified = True
                if msg.get('tool_calls'):
                    for tc in msg['tool_calls']:
                        if tc.get('type') == 'response' and tc.get('response') and image_url in tc['response']:
                            has_image = True
                            pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                            tc['response'] = re.sub(pattern, '', tc['response']).strip()
                            modified = True
                    
                    # If all tool responses in this message are empty, and there is no text, delete the message
                    all_calls_empty = True
                    for tc in msg['tool_calls']:
                        if tc.get('type') == 'response' and tc.get('response') and tc['response'].strip():
                            all_calls_empty = False
                            break
                    if all_calls_empty:
                        if not msg.get('text') or not msg['text'].strip():
                            indices_to_delete.append(i)
                            
                # If this companion message contains the deleted image, check the preceding user message
                if has_image and i > 0:
                    prev_msg = history[i-1]
                    if prev_msg.get('role') == 'user' and prev_msg.get('text') and "Send me a portrait of yourself" in prev_msg['text']:
                        indices_to_delete.append(i-1)
                        
            # Delete marked indices in reverse order (deduplicated)
            for idx in sorted(list(set(indices_to_delete)), reverse=True):
                if 0 <= idx < len(history):
                    del history[idx]
                    modified = True
                    
            # Clean up the actual image file from the server's local disk
            file_deleted = self._delete_local_image(image_url)
            
            if modified:
                self._save_session_to_disk(session_id)
                
            return modified or file_deleted

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str, new_prompt: str = None) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                return False
                
            history = self.sessions_history[session_id]
            modified = False
            
            for msg in history:
                if msg.get('text') and old_image_url in msg['text']:
                    msg['text'] = msg['text'].replace(old_image_url, new_image_url)
                    modified = True
                if msg.get('image_url') == old_image_url:
                    msg['image_url'] = new_image_url
                    modified = True
                if msg.get('tool_calls'):
                    call_ids_to_update = set()
                    for tc in msg['tool_calls']:
                        if tc.get('type') == 'response' and tc.get('response') and old_image_url in tc['response']:
                            tc['response'] = tc['response'].replace(old_image_url, new_image_url)
                            modified = True
                            if tc.get('id'):
                                call_ids_to_update.add(tc['id'])
                                
                    if new_prompt and call_ids_to_update:
                        for tc in msg['tool_calls']:
                            if tc.get('type') == 'call' and tc.get('id') in call_ids_to_update:
                                if not tc.get('args'):
                                    tc['args'] = {}
                                tc['args']['prompt'] = new_prompt
                                modified = True
                    
            # Clean up the old image file from the server's local disk
            self._delete_local_image(old_image_url)
                        
            if modified:
                self._save_session_to_disk(session_id)
                return True
            return False

    async def replace_image_with_video_in_session(self, session_id: str, old_image_url: str, new_video_url: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                return False
                
            history = self.sessions_history[session_id]
            modified = False
            
            for msg in history:
                if msg.get('text') and old_image_url in msg['text']:
                    msg['text'] = msg['text'].replace(old_image_url, new_video_url)
                    modified = True
                if msg.get('image_url') == old_image_url:
                    msg['image_url'] = new_video_url
                    modified = True
                if msg.get('tool_calls'):
                    for tc in msg['tool_calls']:
                        if tc.get('type') == 'response' and tc.get('response') and old_image_url in tc['response']:
                            tc['response'] = tc['response'].replace(old_image_url, new_video_url)
                            modified = True
                            
            if modified:
                self._save_session_to_disk(session_id)
                return True
            return False


    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                self.sessions_history[session_id] = []
                
            prefix = 'usr_' if role == 'user' else 'prgm_'
            if role == 'user':
                if text.startswith("[SYSTEM: User has completed"):
                    prefix = "quest_"
                elif "Send me a portrait of yourself" in text:
                    prefix = "port_"
                elif text.startswith("[Tool Response from"):
                    prefix = "tool_"
                elif text.strip().startswith("![") and text.strip().endswith(")"):
                    prefix = "img_"
            else:
                if text.strip().startswith("![") and text.strip().endswith(")"):
                    prefix = "img_"
            history = self.sessions_history[session_id]
            new_msg = {
                'id': f"{prefix}{uuid.uuid4().hex}",
                'role': 'user' if role == 'user' else 'companion',
                'text': text,
                'tool_calls': [],
                'timestamp': time.time()
            }
            if role != "user":
                winning_mode = await self._get_inversion_mode(session_id)
                from utils.program_mood import extract_and_strip_mood
                _, mood_details = extract_and_strip_mood(text)
                if mood_details:
                    mood_name = mood_details.get('name')
                    self.update_inversion_state_with_mood(session_id, mood_name)
                new_msg['inversion_active'] = winning_mode
                new_msg['mood'] = mood_details
            history.append(new_msg)
            self._save_session_to_disk(session_id)
            return True

    async def append_voice_call(self, session_id: str, transcript: str, timestamp: float = None, start_time: float = None) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                self.sessions_history[session_id] = []
                
            if timestamp is None:
                timestamp = time.time()
                
            # Remove individual user/companion messages that were part of this voice call
            if start_time is not None:
                self.sessions_history[session_id] = [
                    msg for msg in self.sessions_history[session_id]
                    if not (msg.get('role') in ('user', 'companion') and msg.get('timestamp', 0) >= start_time)
                ]
                
            new_msg = {
                'id': f"vc_{uuid.uuid4().hex}",
                'role': 'voice-call',
                'text': transcript,
                'timestamp': timestamp
            }
            self.sessions_history[session_id].append(new_msg)
            self._save_session_to_disk(session_id)
            return True

    async def clone_history(self, src_id: str, dest_id: str, messages: list) -> bool:
        with self._lock:
            if dest_id.endswith('_voice'):
                self.sessions_history[dest_id] = []
                self._save_session_to_disk(dest_id)
                return True
                
            if src_id not in self.sessions_history:
                self._load_session_from_disk(src_id)
                
            src_hist = self.sessions_history.get(src_id, [])
            filtered_msgs = [msg for msg in src_hist if msg.get('role') != 'voice-call']
            limit = 6
            seed_msgs = filtered_msgs[-limit:] if len(filtered_msgs) > limit else filtered_msgs
            
            import copy
            cloned_msgs = copy.deepcopy(seed_msgs)
            self.sessions_history[dest_id] = cloned_msgs
            self._save_session_to_disk(dest_id)
            return True

    async def update_message_text(self, session_id: str, msg_id: str, new_text: str) -> bool:
        with self._lock:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            if session_id not in self.sessions_history:
                return False
                
            real_history = self.sessions_history[session_id]
            found_idx = -1
            for i, msg in enumerate(real_history):
                if msg.get('id') == msg_id:
                    found_idx = i
                    break
                    
            if found_idx != -1:
                target_msg = real_history[found_idx]
                target_msg['text'] = new_text
                role = target_msg.get('role')
                if role in ('companion', 'model'):
                    from utils.program_mood import extract_and_strip_mood
                    _, mood_details = extract_and_strip_mood(new_text)
                    target_msg['mood'] = mood_details
                    
                    prev_user_idx = -1
                    for k in range(found_idx - 1, -1, -1):
                        if is_real_user_msg(real_history[k]):
                            prev_user_idx = k
                            break
                    next_user_idx = len(real_history)
                    for k in range(found_idx + 1, len(real_history)):
                        if is_real_user_msg(real_history[k]):
                            next_user_idx = k
                            break
                            
                    for k in range(prev_user_idx + 1, next_user_idx):
                        if k != found_idx:
                            m = real_history[k]
                            if m.get('role') in ('companion', 'model'):
                                m['text'] = ""
                                
                self._save_session_to_disk(session_id)
                return True
            return False

