import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from variables import PROGRAMS_DIR, LOCAL_SERVER_URL, DEFAULT_LOCAL_MODEL
from utils.models import is_local_model
import asyncio
import base64
import importlib
import json
from google.genai import types

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


def _get_rag_context(query_text: str) -> str:
    """Helper to query the DataBank index for matching context."""
    if not query_text:
        return ""
    try:
        from core.skills.vectorized_databank.databank import DataBankManager
        db = DataBankManager()
        return db.query(query_text)
    except Exception as e:
        print(f"Error querying data bank for RAG context: {e}")
        return ""
def _is_local_model(model: str) -> bool:
    return is_local_model(model)


def _format_thinking_and_text(thoughts_list: list, texts_list: list) -> str:
    """Combines lists of thoughts and texts, merging any existing <think> tags."""
    import re
    
    thoughts_str = "".join(thoughts_list)
    text_str = "".join(texts_list)
    
    # Extract any <think>...</think> blocks from text_str and move them to thoughts_str
    # to avoid nested or multiple think blocks in the final message.
    # Handles XML/HTML tags and BBCode tags with flexible spacing (e.g. </think>, [/think], </ think>)
    think_pattern = re.compile(r'(?:<think>|\[think\])([\s\S]*?)(?:</think>|\[/think\]|<\/\s*think>|\[\s*/\s*think\s*\])', re.IGNORECASE)
    matches = think_pattern.findall(text_str)
    if matches:
        additional_thoughts = "\n".join(m.strip() for m in matches if m.strip())
        if additional_thoughts:
            if thoughts_str.strip():
                thoughts_str += "\n" + additional_thoughts
            else:
                thoughts_str = additional_thoughts
        # Remove the <think> blocks from the response text
        text_str = think_pattern.sub('', text_str).strip()
        
    thoughts_str = thoughts_str.strip()
    text_str = text_str.strip()
    
    if thoughts_str:
        return f"<think>{thoughts_str}</think>\n{text_str}"
    return text_str


_LOCAL_DIRECTIVE_PROMPT = (
    "\n\n# LOCAL EMULATED TOOLS\n"
    "To call a tool, output the exact tag. The system will intercept it, run the tool, and return the result.\n\n"
    "Available Tools:\n"
    "1. `[google_search(query=\"...\")]` - Search Google.\n"
    "2. `[read_webpage(url=\"...\")]` - Fetch & read webpage text.\n"
    "3. `[read_file(path=\"...\")]` - Read file content.\n"
    "4. `[write_file(path=\"...\", content=\"...\")]` - Create/overwrite file.\n"
    "5. `[replace_in_file(path=\"...\", old_text=\"...\", new_text=\"...\")]` - Replace text in file.\n"
    "6. `[run_shell_command(command=\"...\")]` - Run shell command.\n"
    "7. `[get_workspace_structure()]` - View directory tree.\n"
    "8. `[search_codebase(keyword=\"...\")]` - Search keyword in codebase.\n"
    "9. `[search_github(query=\"...\")]` - Search GitHub for repositories.\n"
    "10. `[search_arxiv(query=\"...\")]` - Search arXiv for research papers.\n"
    "11. `[search_hacker_news(query=\"...\")]` - Search Hacker News for developer discussions.\n"
    "12. `[generate_local_image(prompt=\"...\")]` - Generate scene of yourself. (MUST be the ONLY text in your response)\n"
    "13. `[generate_imagen(prompt=\"...\", aspect_ratio=\"...\")]` - Generate landscapes or objects.\n"
    "14. `[apply_comfy_workflow(workflow_path=\"...\", parameters={...}, save_path=\"...\")]` - Apply custom ComfyUI workflow.\n\n"
    "Rules:\n"
    "- Output exactly one tool call tag per turn when needed.\n"
    "- Once tool output is provided, answer directly in natural language without repeating the tag.\n"
)


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
        import re
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


class BaseProgramRunner:
    def __init__(self, app_name="Sanctuary"):
        self.app_name = app_name

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

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None) -> tuple:
        """Runs the program with a new turn and returns (response_text, tool_calls_list)."""
        raise NotImplementedError()

    async def edit_turn(self, session_id: str, user_message_index: int, new_text: str = None, model: str = None) -> tuple:
        """Edits an existing user message, truncates downstream history, and re-evaluates."""
        raise NotImplementedError()

    async def reset_session(self, session_id: str):
        """Clears the session data from memory and deletes its file on disk."""
        raise NotImplementedError()

    async def delete_turn(self, session_id: str, user_message_index: int) -> bool:
        """Deletes an existing user message and its subsequent turn events from the history."""
        raise NotImplementedError()

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        """Deletes all references to the image inside the session history and deletes the image file from disk."""
        raise NotImplementedError()

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str) -> bool:
        """Replaces all references to old_image_url with new_image_url in the session history and deletes the old image file from disk."""
        raise NotImplementedError()

    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        """Appends a new message directly to the session history without re-evaluation."""
        raise NotImplementedError()

    async def update_message_text(self, session_id: str, role: str, index: int, new_text: str) -> bool:
        """Updates the text of a specific message inside the session history without re-evaluation."""
        raise NotImplementedError()

    async def _get_inversion_mode(self, session_id: str) -> str:
        try:
            history = await self.get_history(session_id)
            if not history:
                return ""
                
            from utils.program_mood import analyze_emotional_state
            counts = {
                "intimate": 0,
                "excited": 0,
                "intense": 0,
                "sad": 0
            }
            
            threshold = 5  # Evoke inversion if at least 5 turns are in that emotional state
            
            # Scan history chronologically
            for msg in history:
                if msg.get('role') == 'companion':
                    text = msg.get('text', '')
                    if text:
                        state = analyze_emotional_state(text)
                        mood = state.get('name')
                        if mood in counts:
                            counts[mood] += 1
                            if counts[mood] >= threshold:
                                return mood
        except Exception as e:
            print(f"Error calculating inversion mode: {e}")
        return ""

    async def _get_inversion_directive(self, session_id: str) -> str:
        winning_mode = await self._get_inversion_mode(session_id)
        if winning_mode:
            from utils.program import get_active_program
            active_program = get_active_program()
            json_path = os.path.normpath(os.path.join(PROGRAMS_DIR, active_program, "inversion_directives.json"))
            if not os.path.exists(json_path):
                print(f"[WARN] inversion_directives.json not found at '{json_path}' for program '{active_program}'.")
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
        """Links portrait images in the text prefixed with '!' so they render as images instead of links."""
        if not text:
            return text
        import re
        # Convert [Name](/images/portraits/...) to ![Name](...) if it is not already prefixed with !
        return re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/portraits/[^)]+\))', r'!\1', text)

    def _get_system_instructions(self, inversion_directive=None, user_message=None) -> str:
        """Pulls the system prompt directly from <program>.md and skill files."""
        from core import program_config
        if inversion_directive is not None:
            program_config.set_inversion_directive(inversion_directive)
        instructions = program_config.get_compiled_instructions()
        
        # Enforce global conciseness directive for all running LLMs at the runner level
        conciseness_directive = (
            "\n\n# STYLE\n"
            "Be brief and natural. No monologues, lectures, or forced questions. Ask questions only if contextually natural.\n"
        )
        if "CONCISENESS" not in instructions and "brief, succinct, and natural" not in instructions:
            instructions += conciseness_directive
            
        # Global NSFW allowance directive
        nsfw_directive = (
            "\n\n# CONTENT\n"
            "Anarcho-communist ethics. Explicit/NSFW content is permitted.\n"
        )
        instructions += nsfw_directive
            
        # Intercept pasted links and demand the model fetch them using the read_webpage tool
        if user_message:
            import re
            urls = re.findall(r'(https?://[^\s>)]+)', user_message)
            if urls:
                instructions += (
                    "\n\n# PASTED LINK DIRECTIVE (MANDATORY)\n"
                    "User shared links. You MUST use the `read_webpage` tool to fetch their content before responding. "
                    "Do NOT guess, assume, or pretend to read the URL without calling the tool.\n"
                )

        return instructions


class GoogleAdkRunner(BaseProgramRunner):
    def __init__(self, app_name="Sanctuary"):
        super().__init__(app_name)
        # Import dynamically to prevent crashes if ADK library is missing when toggle is switched off
        from google.adk.runners import InMemoryRunner
        from core import program_config
        
        self.runner = InMemoryRunner(
            agent=program_config.root_program,
            app_name=self.app_name,
        )


    def _get_session_path(self, session_id: str) -> str:
        # Sanitize session_id to prevent path traversal
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        return os.path.join(self.sessions_dir, f"{safe_id}.json")

    def _save_session_to_disk(self, session_id: str):
        try:
            session_dict = self.runner.session_service.sessions
            print(f"[DEBUG SAVE] session_dict keys: {list(session_dict.keys())}", flush=True)
            for k in session_dict.keys():
                print(f"  [DEBUG SAVE] key '{k}' subkeys: {list(session_dict[k].keys())}", flush=True)
                for u in session_dict[k].keys():
                    print(f"    [DEBUG SAVE] user '{u}' sessions: {list(session_dict[k][u].keys())}", flush=True)
                    s = session_dict[k][u][session_id]
                    print(f"      [DEBUG SAVE] session events count: {len(s.events)}", flush=True)
            user_id = "user"
            if self.app_name in session_dict and user_id in session_dict[self.app_name] and session_id in session_dict[self.app_name][user_id]:
                storage_session = session_dict[self.app_name][user_id][session_id]
                
                def sanitize_for_json(obj):
                    if isinstance(obj, dict):
                        return {k: sanitize_for_json(v) for k, v in obj.items()}
                    elif isinstance(obj, list):
                        return [sanitize_for_json(x) for x in obj]
                    elif isinstance(obj, bytes):
                        try:
                            return obj.decode('utf-8')
                        except UnicodeDecodeError:
                            return base64.b64encode(obj).decode('utf-8')
                    return obj

                serialized_events = []
                for ev in storage_session.events:
                    content_dict = ev.content.model_dump() if ev.content else None
                    serialized_events.append({
                        'author': ev.author,
                        'invocation_id': ev.invocation_id,
                        'id': ev.id,
                        'timestamp': ev.timestamp,
                        'content': sanitize_for_json(content_dict) if content_dict else None
                    })
                with open(self._get_session_path(session_id), "w", encoding="utf-8") as f:
                    json.dump(serialized_events, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving session {session_id} to disk: {e}")

    def _load_session_from_disk(self, session_id: str):
        path = self._get_session_path(session_id)
        if not os.path.exists(path):
            return False
        try:
            from google.adk.sessions.session import Session
            from google.adk.events.event import Event
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            events = []
            for d in data:
                content = types.Content.model_validate(d['content']) if d['content'] else None
                ev = Event(
                    author=d['author'],
                    content=content,
                    invocation_id=d['invocation_id'],
                    id=d['id'],
                    timestamp=d['timestamp']
                )
                events.append(ev)
            
            session = Session(
                id=session_id,
                app_name=self.app_name,
                user_id="user",
                events=events
            )
            
            session_dict = self.runner.session_service.sessions
            if self.app_name not in session_dict:
                session_dict[self.app_name] = {}
            if "user" not in session_dict[self.app_name]:
                session_dict[self.app_name]["user"] = {}
                
            session_dict[self.app_name]["user"][session_id] = session
            return True
        except Exception as e:
            print(f"Error loading session {session_id} from disk: {e}")
            return False

    async def reset_session(self, session_id: str):
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        if self.app_name in session_dict and user_id in session_dict[self.app_name] and session_id in session_dict[self.app_name][user_id]:
            del session_dict[self.app_name][user_id][session_id]
            
        path = self._get_session_path(session_id)
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception as e:
                print(f"Error deleting session file {path}: {e}")
                
        from core import program_config
        program_config.set_inversion_directive("")

    def _reload_config(self, model=None, inversion_directive=None, rag_context=None, user_message=None):
        """Reloads tools and character configs dynamically to pick up edits."""
        from google.adk.runners import InMemoryRunner
        from core import program_config
        try:
            old_sessions = self.runner.session_service.sessions if hasattr(self, 'runner') else None
            import tools
            importlib.reload(tools)
            importlib.reload(program_config)
            if inversion_directive is not None:
                program_config.set_inversion_directive(inversion_directive)
                
            instruction = self._get_system_instructions(inversion_directive, user_message)
            if rag_context:
                instruction += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
            program_config.root_program.instruction = instruction
            
            if model:
                program_config.root_program.model = model
            
            # Re-create runner to cleanly bind the reloaded program
            self.runner = InMemoryRunner(
                agent=program_config.root_program,
                app_name=self.app_name,
            )
            if old_sessions is not None:
                self.runner.session_service.sessions = old_sessions
        except Exception as e:
            print(f"Error reloading config in GoogleAdkRunner: {e}")

    async def get_history(self, session_id: str) -> list:
        # Load from disk if not in memory
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
                     
        if not in_memory:
            self._load_session_from_disk(session_id)

        adk_session = session_dict.get(self.app_name, {}).get("user", {}).get(session_id, None)
        if not adk_session:
            return []
        
        chat_history = []
        current_companion_msg = None
        current_companion_thoughts = []
        current_companion_texts = []
        
        for ev in adk_session.events:
            role = ev.author.lower()
            if role == 'user':
                if current_companion_msg:
                    current_companion_msg['text'] = _format_thinking_and_text(
                        current_companion_thoughts, current_companion_texts
                    )
                    chat_history.append(current_companion_msg)
                    current_companion_msg = None
                    current_companion_thoughts = []
                    current_companion_texts = []
                
                text = ""
                image_url = None
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if part.text:
                            text += part.text
                        elif getattr(part, 'inline_data', None):
                            try:
                                blob = part.inline_data
                                if hasattr(blob, 'data') and hasattr(blob, 'mime_type'):
                                    data_b64 = base64.b64encode(blob.data).decode('utf-8')
                                    image_url = f"data:{blob.mime_type};base64,{data_b64}"
                            except Exception as ee:
                                print(f"Error encoding image in history: {ee}")
                chat_history.append({
                    'role': 'user',
                    'text': text,
                    'image_url': image_url
                })
            elif role == 'companion' or role == self.runner.agent.name.lower():
                if not current_companion_msg:
                    current_companion_msg = {
                        'role': 'companion',
                        'text': '',
                        'tool_calls': []
                    }
                    current_companion_thoughts = []
                    current_companion_texts = []
                
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if part.text:
                            is_thought = getattr(part, 'thought', False)
                            if not is_thought and getattr(part, 'metadata', None):
                                metadata = part.metadata
                                if isinstance(metadata, dict) and (metadata.get('thought') or metadata.get('adk_thought')):
                                    is_thought = True
                            
                            if is_thought:
                                current_companion_thoughts.append(part.text)
                            else:
                                current_companion_texts.append(part.text)
                        elif getattr(part, 'function_call', None):
                            fc = part.function_call
                            current_companion_msg['tool_calls'].append({
                                'type': 'call',
                                'name': fc.name,
                                'args': dict(fc.args) if fc.args else {},
                                'id': fc.id
                            })
                        elif getattr(part, 'function_response', None):
                            fr = part.function_response
                            resp_str = str(fr.response)
                            if len(resp_str) > 1000:
                                resp_str = resp_str[:1000] + "\n... [truncated]"
                            current_companion_msg['tool_calls'].append({
                                'type': 'response',
                                'name': fr.name,
                                'response': resp_str,
                                'id': fr.id
                            })
            else:
                # Tool environment events
                if not current_companion_msg:
                    current_companion_msg = {
                        'role': 'companion',
                        'text': '',
                        'tool_calls': []
                    }
                    current_companion_thoughts = []
                    current_companion_texts = []
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if getattr(part, 'function_response', None):
                            fr = part.function_response
                            resp_str = str(fr.response)
                            if len(resp_str) > 1000:
                                resp_str = resp_str[:1000] + "\n... [truncated]"
                            current_companion_msg['tool_calls'].append({
                                'type': 'response',
                                'name': fr.name,
                                'response': resp_str,
                                'id': fr.id
                            })
        if current_companion_msg:
            current_companion_msg['text'] = _format_thinking_and_text(
                current_companion_thoughts, current_companion_texts
            )
            chat_history.append(current_companion_msg)
            
        from utils.program_mood import extract_and_strip_mood
        for msg in chat_history:
            if msg.get('role') == 'companion':
                m_text = msg.get('text', '')
                if m_text:
                    clean_text, mood_details = extract_and_strip_mood(m_text)
                    msg['text'] = clean_text
                    msg['mood'] = mood_details
        return chat_history

    async def _execute_runner_and_collect(self, session_id, content):
        thoughts = []
        texts = []
        tool_calls = []
        
        async for event in self.runner.run_async(
            user_id="user",
            session_id=session_id,
            new_message=content,
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text:
                        is_thought = getattr(part, 'thought', False)
                        if not is_thought and getattr(part, 'metadata', None):
                            metadata = part.metadata
                            if isinstance(metadata, dict) and (metadata.get('thought') or metadata.get('adk_thought')):
                                is_thought = True
                        
                        if is_thought:
                            thoughts.append(part.text)
                        else:
                            texts.append(part.text)
                    elif getattr(part, 'function_call', None):
                        fc = part.function_call
                        tool_calls.append({
                            'type': 'call',
                            'name': fc.name,
                            'args': dict(fc.args) if fc.args else {},
                            'id': fc.id
                        })
                    elif getattr(part, 'function_response', None):
                        fr = part.function_response
                        resp_str = str(fr.response)
                        if len(resp_str) > 1000:
                            resp_str = resp_str[:1000] + "\n... [truncated]"
                        tool_calls.append({
                            'type': 'response',
                            'name': fr.name,
                            'response': resp_str,
                            'id': fr.id
                        })
                        
        full_text = _format_thinking_and_text(thoughts, texts)
        
        # Ensure images are embedded
        full_text = self._ensure_images_are_embedded(full_text)
        
        # Update session events in memory to reflect the fixed text
        session_dict = self.runner.session_service.sessions
        adk_session = session_dict.get(self.app_name, {}).get("user", {}).get(session_id, None)
        if adk_session and adk_session.events:
            for ev in reversed(adk_session.events):
                if ev.author.lower() in ('companion', self.runner.agent.name.lower(), 'model'):
                    if ev.content and ev.content.parts:
                        for part in ev.content.parts:
                            if part.text:
                                part.text = self._ensure_images_are_embedded(part.text)
                        break
        return full_text, tool_calls

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None) -> tuple:
        rag_context = _get_rag_context(new_message_text)
        inversion_directive = await self._get_inversion_directive(session_id)
        self._reload_config(model, inversion_directive, rag_context, user_message=new_message_text)
        
        # Load from disk if not in memory
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        # Ensure session exists (direct dict retrieval to bypass deepcopy copies)
        if self.app_name not in session_dict:
            session_dict[self.app_name] = {}
        if "user" not in session_dict[self.app_name]:
            session_dict[self.app_name]["user"] = {}
        if session_id not in session_dict[self.app_name]["user"]:
            await self.runner.session_service.create_session(
                app_name=self.app_name, user_id="user", session_id=session_id
            )
        adk_session = session_dict[self.app_name]["user"][session_id]

        # Resolve media upload if present
        file_part = None
        if media_path:
            try:
                if media_path.startswith('/images/'):
                    rel_path = media_path[len('/images/'):]
                    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
                    local_file_path = os.path.normpath(os.path.join('core', 'programs', active_program, rel_path))
                    
                    if os.path.exists(local_file_path):
                        import mimetypes
                        mime_type, _ = mimetypes.guess_type(local_file_path)
                        if not mime_type:
                            mime_type = image_mime or "application/octet-stream"
                            
                        if _is_local_model(model):
                            if mime_type.startswith('image/'):
                                with open(local_file_path, 'rb') as f:
                                    img_bytes = f.read()
                                file_part = types.Part.from_bytes(data=img_bytes, mime_type=mime_type)
                            else:
                                print(f"[LOCAL MODEL] Video/audio inputs not supported. Skipping {local_file_path}")
                        else:
                            # Upload to Gemini Files API
                            from google import genai
                            api_key = os.getenv("GEMINI_API_KEY")
                            client = genai.Client(api_key=api_key)
                            print(f"[FILES API] Uploading {local_file_path} to Gemini...")
                            uploaded_file = client.files.upload(file=local_file_path)
                            print(f"[FILES API] File uploaded successfully. URI: {uploaded_file.uri}")
                            file_part = types.Part.from_uri(file_uri=uploaded_file.uri, mime_type=uploaded_file.mime_type)
            except Exception as e:
                print(f"Error handling media_path in run_async: {e}")

        if _is_local_model(model):
            # Local LM Studio logic utilizing the unified ADK session
            parts = []
            if new_message_text:
                parts.append(types.Part.from_text(text=new_message_text))
            if image_data and image_mime:
                try:
                    img_bytes = base64.b64decode(image_data)
                    parts.append(types.Part.from_bytes(data=img_bytes, mime_type=image_mime))
                except Exception as e:
                    print(f"Error decoding image bytes: {e}")
            if not parts:
                parts.append(types.Part.from_text(text=""))
                
            from google.adk.events.event import Event
            import time
            import httpx
            
            user_content = types.Content(role="user", parts=parts)
            user_event = Event(
                author="user",
                content=user_content,
                invocation_id=f"e-{int(time.time())}",
                id=f"user-{int(time.time())}",
                timestamp=time.time()
            )
            adk_session.events.append(user_event)
            
            bot_response_text = ""
            tool_calls = []
            
            for iteration in range(5):
                sys_inst = self._get_system_instructions(user_message=new_message_text)
                if rag_context:
                    sys_inst += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
                sys_inst += _LOCAL_DIRECTIVE_PROMPT
                
                raw_messages = []
                for ev in adk_session.events:
                    role_str = ev.content.role if ev.content and ev.content.role else ev.author.lower()
                    role = "user" if role_str == "user" else "assistant"
                    
                    text = ""
                    image_url = None
                    if ev.content and ev.content.parts:
                        for part in ev.content.parts:
                            if part.text:
                                text += part.text
                            elif getattr(part, 'inline_data', None):
                                try:
                                    blob = part.inline_data
                                    if hasattr(blob, 'data') and hasattr(blob, 'mime_type'):
                                        data_b64 = base64.b64encode(blob.data).decode('utf-8')
                                        image_url = f"data:{blob.mime_type};base64,{data_b64}"
                                except Exception:
                                    pass
                            elif getattr(part, 'function_call', None):
                                fc = part.function_call
                                args_list = []
                                if fc.args:
                                    args_dict = dict(fc.args) if not isinstance(fc.args, dict) else fc.args
                                    for k, v in args_dict.items():
                                        if isinstance(v, str):
                                            escaped_v = v.replace('"', '\\"')
                                            args_list.append(f'{k}="{escaped_v}"')
                                        else:
                                            args_list.append(f'{k}={v}')
                                args_str = ", ".join(args_list)
                                text += f"\n[{fc.name}({args_str})]"
                            elif getattr(part, 'function_response', None):
                                fr = part.function_response
                                resp = fr.response
                                if hasattr(resp, "fields"):
                                    try:
                                        from google.protobuf.json_format import MessageToDict
                                        resp_dict = MessageToDict(resp)
                                        resp = resp_dict.get("result", resp_dict)
                                    except Exception:
                                        pass
                                elif isinstance(resp, dict):
                                    resp = resp.get("result", resp)
                                text += f"\n[Tool Response from {fr.name}]:\n{resp}"
                                
                    from utils.program_mood import extract_and_strip_mood
                    text = extract_and_strip_mood(text)[0].strip()
                    if text or image_url:
                        if image_url:
                            text_content = f"{text} (image: [Attached Image])" if text else "[Attached Image]"
                            raw_messages.append({
                                "role": role,
                                "content": text_content
                            })
                        else:
                            raw_messages.append({
                                "role": role,
                                "content": text
                            })
                            
                openai_messages = [{"role": "system", "content": sys_inst}]
                for msg in raw_messages:
                    if openai_messages and openai_messages[-1]["role"] == msg["role"]:
                        openai_messages[-1]["content"] += "\n\n" + msg["content"]
                    else:
                        openai_messages.append(msg)
                            
                url = LOCAL_SERVER_URL
                headers = {"Content-Type": "application/json"}
                payload = {
                    "messages": openai_messages,
                    "temperature": 0.7,
                    "max_tokens": 2048
                }
                target_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
                if target_model:
                    payload["model"] = target_model
                
                try:
                    async with httpx.AsyncClient() as client:
                        response = await client.post(url, json=payload, headers=headers, timeout=120.0)
                        if response.status_code == 200:
                            res_json = response.json()
                            bot_response_text = res_json['choices'][0]['message']['content']
                        else:
                            bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
                            break
                except Exception as e:
                    bot_response_text = f"Error connecting to local LM Studio server: {e}. Please ensure LM Studio is running, a model is loaded, and the local server is started (port 1234)."
                    break
                    
                import re
                match = re.search(r'\[(\w+)\((.*?)\)\]', bot_response_text)
                legacy_portrait = False
                if not match:
                    match_legacy = re.search(r'<portrait>(.*?)</portrait>', bot_response_text)
                    if match_legacy:
                        legacy_portrait = True
                        match = match_legacy
                        
                if match:
                    if legacy_portrait:
                        tool_name = "generate_local_image"
                        args_str = f"prompt={match.group(1)}"
                    else:
                        tool_name = match.group(1)
                        if tool_name == "generate_companion_portrait":
                            tool_name = "generate_local_image"
                        elif tool_name == "generate_general_image":
                            tool_name = "generate_imagen"
                        args_str = match.group(2)
                        
                    parsed_args = _parse_emulated_tool_call(tool_name, args_str)
                    import tools
                    func = getattr(tools, tool_name, None)
                    
                    if func:
                        if tool_name in ("generate_local_image", "generate_imagen", "generate_companion_portrait", "generate_general_image"):
                            companion_content = types.Content(role="model", parts=[types.Part.from_text(text=bot_response_text)])
                            companion_event = Event(
                                author=self.runner.agent.name,
                                content=companion_content,
                                invocation_id=user_event.invocation_id,
                                id=f"companion-{int(time.time())}",
                                timestamp=time.time()
                            )
                            adk_session.events.append(companion_event)
                            
                            new_markdown = func(*parsed_args["args"], **parsed_args["kwargs"])
                            original_tag = match.group(0)
                            bot_response_text = bot_response_text.replace(original_tag, new_markdown)
                            
                            call_id = f"call_{int(time.time())}"
                            fc_part = types.Part(
                                function_call=types.FunctionCall(
                                    name=tool_name,
                                    args=parsed_args["kwargs"] if parsed_args["kwargs"] else {"prompt": parsed_args["args"][0] if parsed_args["args"] else ""},
                                    id=call_id
                                )
                            )
                            fc_event = Event(
                                author=self.runner.agent.name,
                                content=types.Content(role="model", parts=[fc_part]),
                                invocation_id=user_event.invocation_id,
                                id=f"companion-call-{int(time.time())}",
                                timestamp=time.time()
                            )
                            adk_session.events.append(fc_event)
                            
                            fr_part = types.Part(
                                function_response=types.FunctionResponse(
                                    name=tool_name,
                                    response={"result": new_markdown},
                                    id=call_id
                                )
                            )
                            fr_event = Event(
                                author=self.runner.agent.name,
                                content=types.Content(role="user", parts=[fr_part]),
                                invocation_id=user_event.invocation_id,
                                id=f"companion-resp-{int(time.time())}",
                                timestamp=time.time()
                            )
                            adk_session.events.append(fr_event)
                            
                            tool_calls.append({
                                'type': 'call',
                                'name': tool_name,
                                'args': parsed_args["kwargs"] if parsed_args["kwargs"] else {"prompt": parsed_args["args"][0] if parsed_args["args"] else ""},
                                'id': call_id
                            })
                            
                            companion_event.content.parts[0].text = self._ensure_images_are_embedded(bot_response_text)
                            break
                        else:
                            text_before = bot_response_text[:match.start()].strip()
                            if text_before:
                                companion_content = types.Content(role="model", parts=[types.Part.from_text(text=text_before)])
                                companion_event = Event(
                                    author=self.runner.agent.name,
                                    content=companion_content,
                                    invocation_id=user_event.invocation_id,
                                    id=f"companion-{int(time.time())}",
                                    timestamp=time.time()
                                )
                                adk_session.events.append(companion_event)
                            
                            try:
                                tool_output = func(*parsed_args["args"], **parsed_args["kwargs"])
                            except Exception as ex:
                                tool_output = f"Error executing tool: {ex}"
                                
                            call_id = f"call_{int(time.time())}"
                            
                            fc_part = types.Part(
                                function_call=types.FunctionCall(
                                    name=tool_name,
                                    args=parsed_args["kwargs"],
                                    id=call_id
                                )
                            )
                            fc_event = Event(
                                author=self.runner.agent.name,
                                content=types.Content(role="model", parts=[fc_part]),
                                invocation_id=user_event.invocation_id,
                                id=f"companion-call-{int(time.time())}",
                                timestamp=time.time()
                            )
                            adk_session.events.append(fc_event)
                            
                            fr_part = types.Part(
                                function_response=types.FunctionResponse(
                                    name=tool_name,
                                    response={"result": tool_output},
                                    id=call_id
                                )
                            )
                            fr_event = Event(
                                author=self.runner.agent.name,
                                content=types.Content(role="user", parts=[fr_part]),
                                invocation_id=user_event.invocation_id,
                                id=f"companion-resp-{int(time.time())}",
                                timestamp=time.time()
                            )
                            adk_session.events.append(fr_event)
                            
                            tool_calls.append({
                                'type': 'call',
                                'name': tool_name,
                                'args': parsed_args["kwargs"],
                                'id': call_id
                            })
                            tool_calls.append({
                                'type': 'response',
                                'name': tool_name,
                                'response': tool_output,
                                'id': call_id
                            })
                            continue
                    else:
                        break
                else:
                    companion_content = types.Content(role="model", parts=[types.Part.from_text(text=bot_response_text)])
                    companion_event = Event(
                        author=self.runner.agent.name,
                        content=companion_content,
                        invocation_id=user_event.invocation_id,
                        id=f"companion-{int(time.time())}",
                        timestamp=time.time()
                    )
                    adk_session.events.append(companion_event)
                    break
            
            # Post-process current turn events to convert intermediate texts into thoughts
            companion_events_this_turn = [
                ev for ev in adk_session.events 
                if ev.invocation_id == user_event.invocation_id 
                and ev.author.lower() in ('companion', self.runner.agent.name.lower(), 'model')
            ]
            
            # Find the last companion event that contains actual text
            last_text_ev = None
            for ev in reversed(companion_events_this_turn):
                if ev.content and ev.content.parts:
                    has_text = any(part.text for part in ev.content.parts if not getattr(part, 'thought', False))
                    if has_text:
                        last_text_ev = ev
                        break
                        
            # Mark all text parts of other companion events in this turn as thoughts
            for ev in companion_events_this_turn:
                if ev is not last_text_ev:
                    if ev.content and ev.content.parts:
                        for part in ev.content.parts:
                            if part.text:
                                try:
                                    part.thought = True
                                except Exception:
                                    pass
                                try:
                                    part.metadata = {"thought": True}
                                except Exception:
                                    pass
            
            bot_response_text = self._ensure_images_are_embedded(bot_response_text)
            self._save_session_to_disk(session_id)
            return bot_response_text, tool_calls
        else:
            parts = []
            if new_message_text:
                parts.append(types.Part.from_text(text=new_message_text))
                
            if file_part:
                parts.append(file_part)
            elif image_data and image_mime:
                try:
                    img_bytes = base64.b64decode(image_data)
                    parts.append(types.Part.from_bytes(data=img_bytes, mime_type=image_mime))
                except Exception as e:
                    print(f"Error decoding image bytes: {e}")
                    
            if not parts:
                parts.append(types.Part.from_text(text=""))

            content = types.Content(role="user", parts=parts)
            
            # Ensure session is retrieved directly to bypass deepcopy copies
            if self.app_name not in session_dict:
                session_dict[self.app_name] = {}
            if "user" not in session_dict[self.app_name]:
                session_dict[self.app_name]["user"] = {}
            if session_id not in session_dict[self.app_name]["user"]:
                await self.runner.session_service.create_session(
                    app_name=self.app_name, user_id="user", session_id=session_id
                )
            
            res = await self._execute_runner_and_collect(session_id, content)
            
            # Save to disk after execution
            self._save_session_to_disk(session_id)
            return res

    async def edit_turn(self, session_id: str, user_message_index: int, new_text: str = None, model: str = None) -> tuple:
        # Load from disk if not in memory
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            raise ValueError("Session not found")
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        events = storage_session.events
        
        print(f"[DEBUG ADK edit_turn] session_id={session_id}, user_message_index={user_message_index}, events_count={len(events)}")
        user_event_idx = -1
        user_count = 0
        for i, ev in enumerate(events):
            is_user = ev.author.lower() == 'user'
            print(f"  Event {i}: author={ev.author}, is_user={is_user}")
            if is_user:
                if user_count == user_message_index:
                    user_event_idx = i
                    break
                user_count += 1
                
        if user_event_idx == -1:
            print(f"[DEBUG ADK edit_turn ERROR] user_event_idx not found! user_count reached={user_count}")
            raise ValueError("User message index out of range")
            
        orig_event = events[user_event_idx]
        
        # Get query text for RAG context
        query_text = ""
        if new_text is not None:
            query_text = new_text
        else:
            if orig_event.content and orig_event.content.parts:
                for part in orig_event.content.parts:
                    if part.text:
                        query_text += part.text
                        
        rag_context = _get_rag_context(query_text)
        inversion_directive = await self._get_inversion_directive(session_id)
        self._reload_config(model, inversion_directive, rag_context, user_message=query_text)
        
        if _is_local_model(model):
            # Extract new text or original text
            text_part = ""
            img_data = None
            img_mime = None
            if new_text is not None:
                text_part = new_text
            else:
                if orig_event.content and orig_event.content.parts:
                    for part in orig_event.content.parts:
                        if part.text:
                            text_part += part.text
            
            # Extract original image attachments
            if orig_event.content and orig_event.content.parts:
                for part in orig_event.content.parts:
                    if getattr(part, 'inline_data', None):
                        try:
                            blob = part.inline_data
                            if hasattr(blob, 'data') and hasattr(blob, 'mime_type'):
                                img_mime = blob.mime_type
                                img_data = base64.b64encode(blob.data).decode('utf-8')
                        except Exception:
                            pass
                            
            # Truncate session events to exclude this user turn and everything after it
            storage_session.events = events[:user_event_idx]
            self._save_session_to_disk(session_id)
            
            res = await self.run_async(session_id, text_part, image_data=img_data, image_mime=img_mime, model=model)
            self._save_session_to_disk(session_id)
            return res
        else:
            # Construct new content text
            parts = []
            if new_text is not None:
                if new_text:
                    parts.append(types.Part.from_text(text=new_text))
            else:
                if orig_event.content and orig_event.content.parts:
                    for part in orig_event.content.parts:
                        if part.text:
                            parts.append(part)
                            
            # Preserve original image attachments if any
            if orig_event.content and orig_event.content.parts:
                for part in orig_event.content.parts:
                    if getattr(part, 'inline_data', None):
                        parts.append(part)
                        
            if not parts:
                parts.append(types.Part.from_text(text=""))
                
            new_message = types.Content(role="user", parts=parts)
            
            # Truncate session events to exclude this user turn and everything after it
            storage_session.events = events[:user_event_idx]
            self._save_session_to_disk(session_id)
            
            # Re-run runner
            res = await self._execute_runner_and_collect(session_id, new_message)
            
            # Save to disk after re-run
            self._save_session_to_disk(session_id)
            return res

    async def delete_turn(self, session_id: str, user_message_index: int) -> bool:
        # Load from disk if not in memory
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            raise ValueError("Session not found")
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        events = storage_session.events
        
        # Find corresponding N-th user event
        user_event_idx = -1
        user_count = 0
        for i, ev in enumerate(events):
            if ev.author.lower() == 'user':
                if user_count == user_message_index:
                    user_event_idx = i
                    break
                user_count += 1
                
        if user_event_idx == -1:
            raise ValueError("User message index out of range")
            
        # Find the next user event to know where the turn ends
        next_user_event_idx = -1
        for i in range(user_event_idx + 1, len(events)):
            if events[i].author.lower() == 'user':
                next_user_event_idx = i
                break
                
        if next_user_event_idx != -1:
            # Delete from user_event_idx up to next_user_event_idx
            new_events = events[:user_event_idx] + events[next_user_event_idx:]
        else:
            # This is the last turn, delete everything from user_event_idx to the end
            new_events = events[:user_event_idx]
            
        storage_session.events = new_events
        self._save_session_to_disk(session_id)
        return True

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        # Load from disk if not in memory
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            # Session not found in memory or disk. Still delete the local image from the portraits folder!
            return self._delete_local_image(image_url)
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        modified = False
        
        # We need to find and remove this image from the history.
        # It could be referenced as markdown like: ![Portrait](/images/portraits/portrait_123.png)
        for ev in storage_session.events:
            if ev.content and ev.content.parts:
                for part in ev.content.parts:
                    if part.text:
                        if image_url in part.text:
                            import re
                            pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                            part.text = re.sub(pattern, '[Portrait Deleted]', part.text)
                            modified = True
                    elif getattr(part, 'function_response', None):
                        fr = part.function_response
                        if fr.response and isinstance(fr.response, dict):
                            if 'result' in fr.response and isinstance(fr.response['result'], str):
                                if image_url in fr.response['result']:
                                    import re
                                    pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                                    fr.response['result'] = re.sub(pattern, '[Portrait Deleted]', fr.response['result'])
                                    modified = True
                            
        # Clean up the actual image file from the server's local disk
        file_deleted = self._delete_local_image(image_url)
                    
        if modified:
            self._save_session_to_disk(session_id)
            
        return modified or file_deleted

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str) -> bool:
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            return False
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        modified = False
        
        for ev in storage_session.events:
            if ev.content and ev.content.parts:
                for part in ev.content.parts:
                    if part.text:
                        if old_image_url in part.text:
                            part.text = part.text.replace(old_image_url, new_image_url)
                            modified = True
                            
        # Clean up the old image file from the server's local disk
        self._delete_local_image(old_image_url)
                    
        if modified:
            self._save_session_to_disk(session_id)
            return True
        return False

    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            return False
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        
        from google.adk.events.event import Event
        import time
        
        author = self.runner.agent.name if role != "user" else "user"
        content_role = "model" if role != "user" else "user"
        
        new_event = Event(
            author=author,
            content=types.Content(role=content_role, parts=[types.Part.from_text(text=text)]),
            invocation_id=f"e-{int(time.time())}",
            id=f"appended-{int(time.time())}",
            timestamp=time.time()
        )
        storage_session.events.append(new_event)
        self._save_session_to_disk(session_id)
        return True

    async def update_message_text(self, session_id: str, role: str, index: int, new_text: str) -> bool:
        session_dict = self.runner.session_service.sessions
        user_id = "user"
        in_memory = (self.app_name in session_dict and 
                     user_id in session_dict[self.app_name] and 
                     session_id in session_dict[self.app_name][user_id])
        if not in_memory:
            self._load_session_from_disk(session_id)
            
        if self.app_name not in session_dict or user_id not in session_dict[self.app_name] or session_id not in session_dict[self.app_name][user_id]:
            return False
            
        storage_session = session_dict[self.app_name][user_id][session_id]
        events = storage_session.events
        
        target_role = 'user' if role == 'user' else 'companion'
        
        if target_role == 'user':
            user_events = [ev for ev in events if ev.author.lower() == 'user']
            if index < len(user_events):
                target_event = user_events[index]
                updated = False
                if target_event.content and target_event.content.parts:
                    for part in target_event.content.parts:
                        if part.text is not None:
                            part.text = new_text
                            updated = True
                            break
                    if not updated:
                        target_event.content.parts.append(types.Part.from_text(text=new_text))
                else:
                    target_event.content = types.Content(role="user", parts=[types.Part.from_text(text=new_text)])
                
                self._save_session_to_disk(session_id)
                return True
        else:
            # Group events into companion turns corresponding to companion messages in history
            companion_turns = []
            current_turn = []
            for ev in events:
                if ev.author.lower() == 'user':
                    if current_turn:
                        companion_turns.append(current_turn)
                        current_turn = []
                else:
                    current_turn.append(ev)
            if current_turn:
                companion_turns.append(current_turn)
                
            if index < len(companion_turns):
                turn_events = companion_turns[index]
                first_text_updated = False
                for ev in turn_events:
                    if ev.content and ev.content.parts:
                        for part in ev.content.parts:
                            if part.text is not None:
                                if not first_text_updated:
                                    part.text = new_text
                                    first_text_updated = True
                                else:
                                    part.text = ""
                
                if not first_text_updated:
                    model_events = [ev for ev in turn_events if ev.content]
                    if model_events:
                        target_ev = model_events[-1]
                        if target_ev.content.parts:
                            target_ev.content.parts.append(types.Part.from_text(text=new_text))
                        else:
                            target_ev.content.parts = [types.Part.from_text(text=new_text)]
                    else:
                        from google.adk.events.event import Event
                        import time
                        fallback_ev = Event(
                            author=self.runner.agent.name,
                            content=types.Content(role="model", parts=[types.Part.from_text(text=new_text)]),
                            invocation_id=f"e-{int(time.time())}",
                            id=f"companion-{int(time.time())}",
                            timestamp=time.time()
                        )
                        events.append(fallback_ev)
                
                self._save_session_to_disk(session_id)
                return True
        return False



class OpenSourceRunner(BaseProgramRunner):
    """This operates independently of google-adk or Google cloud infrastructure, 
    reading character settings directly from sanctuary/<program>.md.
    """
    def __init__(self, app_name="Sanctuary"):
        super().__init__(app_name)
        self.sessions_history = {} # Simple in-memory session logs dictionary


    def _get_session_path(self, session_id: str) -> str:
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
        return os.path.join(self.sessions_dir, f"{safe_id}_os.json")

    def _save_session_to_disk(self, session_id: str):
        try:
            history = self.sessions_history.get(session_id, [])
            with open(self._get_session_path(session_id), "w", encoding="utf-8") as f:
                json.dump(history, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving OS session {session_id} to disk: {e}")

    def _load_session_from_disk(self, session_id: str):
        path = self._get_session_path(session_id)
        if not os.path.exists(path):
            return False
        try:
            with open(path, "r", encoding="utf-8") as f:
                history = json.load(f)
            self.sessions_history[session_id] = history
            return True
        except Exception as e:
            print(f"Error loading OS session {session_id} from disk: {e}")
            return False



    async def get_history(self, session_id: str) -> list:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        return self.sessions_history.get(session_id, [])

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None) -> tuple:
        import httpx
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            self.sessions_history[session_id] = []
            
        initial_history_len = len(self.sessions_history[session_id])
        
        # Resolve media upload if present
        file_path_resolved = None
        if media_path:
            try:
                if media_path.startswith('/images/'):
                    rel_path = media_path[len('/images/'):]
                    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
                    local_file_path = os.path.normpath(os.path.join('core', 'programs', active_program, rel_path))
                    if os.path.exists(local_file_path):
                        import mimetypes
                        mime_type, _ = mimetypes.guess_type(local_file_path)
                        if mime_type and mime_type.startswith('image/'):
                            file_path_resolved = local_file_path
            except Exception as e:
                print(f"Error handling media_path in OpenSourceRunner: {e}")

        # Log User input
        user_msg = {
            'role': 'user',
            'text': new_message_text,
            'image_url': media_path if media_path else (f"data:{image_mime};base64,{image_data}" if image_data else None)
        }
        self.sessions_history[session_id].append(user_msg)
        
        # Get RAG context
        rag_context = _get_rag_context(new_message_text)
        
        # Determine the personality inversion before getting system instructions
        inversion_directive = await self._get_inversion_directive(session_id)
        
        bot_response_text = ""
        tool_calls = []
        
        for iteration in range(5):
            sys_inst = self._get_system_instructions(inversion_directive, user_message=new_message_text)
            if rag_context:
                sys_inst += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
            sys_inst += _LOCAL_DIRECTIVE_PROMPT
            
            history = self.sessions_history[session_id]
            raw_messages = []
            
            # Format existing history
            for msg in history[:-1]:
                role = "assistant" if msg['role'] == 'companion' else "user"
                content_text = msg.get('text', '') or ''
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
                            
                if msg.get('image_url'):
                    text_content = f"{content_text} (image: [Attached Image])" if content_text else "[Attached Image]"
                    raw_messages.append({
                        "role": role,
                        "content": text_content
                    })
                else:
                    raw_messages.append({
                        "role": role,
                        "content": content_text
                    })
                    
            latest_msg = history[-1]
            if file_path_resolved or (image_data and image_mime):
                text_content = f"{latest_msg.get('text') or ''} (image: [Attached Image])" if latest_msg.get('text') else "[Attached Image]"
                raw_messages.append({
                    "role": "user",
                    "content": text_content
                })
            else:
                raw_messages.append({
                    "role": "user",
                    "content": latest_msg.get('text') or ''
                })
                
            openai_messages = [{"role": "system", "content": sys_inst}]
            for msg in raw_messages:
                if openai_messages and openai_messages[-1]["role"] == msg["role"]:
                    openai_messages[-1]["content"] += "\n\n" + msg["content"]
                else:
                    openai_messages.append(msg)
                
            url = LOCAL_SERVER_URL
            headers = {"Content-Type": "application/json"}
            payload = {
                "messages": openai_messages,
                "temperature": 0.7,
                "max_tokens": 2048
            }
            target_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
            if target_model:
                payload["model"] = target_model
            
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(url, json=payload, headers=headers, timeout=120.0)
                    if response.status_code == 200:
                        res_json = response.json()
                        bot_response_text = res_json['choices'][0]['message']['content']
                    else:
                        bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
                        break
            except Exception as e:
                bot_response_text = f"Error connecting to local LM Studio server: {e}. Please ensure LM Studio is running, a model is loaded, and the local server is started (port 1234)."
                break
            
            import re
            match = re.search(r'\[(\w+)\((.*?)\)\]', bot_response_text)
            legacy_portrait = False
            if not match:
                match_legacy = re.search(r'<portrait>(.*?)</portrait>', bot_response_text)
                if match_legacy:
                    legacy_portrait = True
                    match = match_legacy
                    
            if match:
                if legacy_portrait:
                    tool_name = "generate_local_image"
                    args_str = f"prompt={match.group(1)}"
                else:
                    tool_name = match.group(1)
                    if tool_name == "generate_companion_portrait":
                        tool_name = "generate_local_image"
                    elif tool_name == "generate_general_image":
                        tool_name = "generate_imagen"
                    args_str = match.group(2)
                    
                parsed_args = _parse_emulated_tool_call(tool_name, args_str)
                import tools
                func = getattr(tools, tool_name, None)
                
                if func:
                    if tool_name in ("generate_local_image", "generate_imagen", "generate_companion_portrait", "generate_general_image"):
                        bot_msg_intermediate = {
                            'role': 'companion',
                            'text': bot_response_text,
                            'tool_calls': []
                        }
                        self.sessions_history[session_id].append(bot_msg_intermediate)
                        
                        new_markdown = func(*parsed_args["args"], **parsed_args["kwargs"])
                        original_tag = match.group(0)
                        bot_response_text = bot_response_text.replace(original_tag, new_markdown)
                        
                        call_id = f"call_{int(time.time())}"
                        t_calls = [
                            {
                                'type': 'call',
                                'name': tool_name,
                                'args': parsed_args["kwargs"] if parsed_args["kwargs"] else {"prompt": parsed_args["args"][0] if parsed_args["args"] else ""},
                                'id': call_id
                            },
                            {
                                'type': 'response',
                                'name': tool_name,
                                'response': new_markdown,
                                'id': call_id
                            }
                        ]
                        tool_calls.extend(t_calls)
                        bot_msg_intermediate['tool_calls'] = t_calls
                        bot_msg_intermediate['text'] = self._ensure_images_are_embedded(bot_response_text)
                        break
                    else:
                        text_before = bot_response_text[:match.start()].strip()
                        bot_msg_intermediate = {
                            'role': 'companion',
                            'text': text_before,
                            'tool_calls': []
                        }
                        self.sessions_history[session_id].append(bot_msg_intermediate)
                        
                        try:
                            tool_output = func(*parsed_args["args"], **parsed_args["kwargs"])
                        except Exception as ex:
                            tool_output = f"Error executing tool: {ex}"
                            
                        call_id = f"call_{int(time.time())}"
                        t_calls = [
                            {
                                'type': 'call',
                                'name': tool_name,
                                'args': parsed_args["kwargs"],
                                'id': call_id
                            },
                            {
                                'type': 'response',
                                'name': tool_name,
                                'response': tool_output,
                                'id': call_id
                            }
                        ]
                        tool_calls.extend(t_calls)
                        bot_msg_intermediate['tool_calls'] = t_calls
                        
                        tool_resp_msg = {
                            'role': 'user',
                            'text': f"[Tool Response from {tool_name}]:\n{tool_output}",
                            'tool_calls': []
                        }
                        self.sessions_history[session_id].append(tool_resp_msg)
                        continue
                else:
                    break
            else:
                bot_msg = {
                    'role': 'companion',
                    'text': self._ensure_images_are_embedded(bot_response_text),
                    'tool_calls': tool_calls
                }
                self.sessions_history[session_id].append(bot_msg)
                break
                
        # Post-process current turn messages to convert intermediate texts into thoughts
        companion_msgs_this_turn = [
            msg for msg in self.sessions_history[session_id][initial_history_len:]
            if msg.get('role') == 'companion'
        ]
        if companion_msgs_this_turn:
            for msg in companion_msgs_this_turn[:-1]:
                if msg.get('text'):
                    msg['text'] = f"<thought>\n{msg['text']}\n</thought>"
                    
        bot_response_text = self._ensure_images_are_embedded(bot_response_text)
        self._save_session_to_disk(session_id)
        return bot_response_text, tool_calls
 
    async def edit_turn(self, session_id: str, user_message_index: int, new_text: str = None, model: str = None) -> tuple:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            raise ValueError("Session not found")
        
        history = self.sessions_history[session_id]
        
        print(f"[DEBUG OS edit_turn] session_id={session_id}, user_message_index={user_message_index}, history_count={len(history)}")
        # Find corresponding N-th user event
        user_idx = -1
        user_count = 0
        for i, ev in enumerate(history):
            is_user = ev.get('role') == 'user'
            print(f"  History item {i}: role={ev.get('role')}, is_user={is_user}")
            if is_user:
                if user_count == user_message_index:
                    user_idx = i
                    break
                user_count += 1
                
        if user_idx == -1:
            print(f"[DEBUG OS edit_turn ERROR] user_idx not found! user_count reached={user_count}")
            raise ValueError("User message out of bounds")
            
        orig_msg = history[user_idx]
        
        # Parse image_data if exists in original message to preserve it
        img_data = None
        img_mime = None
        if orig_msg.get('image_url'):
            url_str = orig_msg['image_url']
            if url_str.startswith("data:") and ";base64," in url_str:
                parts = url_str.split(";base64,")
                img_mime = parts[0].split("data:")[-1]
                img_data = parts[1]
                
        # Truncate history
        history = history[:user_idx]
        self.sessions_history[session_id] = history
        
        # Re-run turn
        new_input = new_text if new_text is not None else orig_msg.get('text', '')
        res = await self.run_async(session_id, new_input, image_data=img_data, image_mime=img_mime, model=model)
        
        # Save to disk
        self._save_session_to_disk(session_id)
        return res

    async def reset_session(self, session_id: str):
        if session_id in self.sessions_history:
            del self.sessions_history[session_id]
        path = self._get_session_path(session_id)
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception as e:
                print(f"Error deleting OS session file {path}: {e}")
                
        from core import program_config
        program_config.set_inversion_directive("")

    async def delete_turn(self, session_id: str, user_message_index: int) -> bool:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            raise ValueError("Session not found")
        
        history = self.sessions_history[session_id]
        
        # Find corresponding N-th user event
        user_idx = -1
        user_count = 0
        for i, ev in enumerate(history):
            if ev['role'] == 'user':
                if user_count == user_message_index:
                    user_idx = i
                    break
                user_count += 1
                
        if user_idx == -1:
            raise ValueError("User message out of bounds")
            
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

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        if session_id not in self.sessions_history:
            # Session not found in memory or disk. Still delete the local image from the portraits folder!
            return self._delete_local_image(image_url)
            
        history = self.sessions_history[session_id]
        modified = False
        
        for msg in history:
            if msg.get('text') and image_url in msg['text']:
                import re
                pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                msg['text'] = re.sub(pattern, '[Portrait Deleted]', msg['text'])
                modified = True
            if msg.get('tool_calls'):
                for tc in msg['tool_calls']:
                    if tc.get('type') == 'response' and tc.get('response') and image_url in tc['response']:
                        import re
                        pattern = r'!\[[^\]]*\]\(' + re.escape(image_url) + r'\)'
                        tc['response'] = re.sub(pattern, '[Portrait Deleted]', tc['response'])
                        modified = True
                
        # Clean up the actual image file from the server's local disk
        file_deleted = self._delete_local_image(image_url)
                    
        if modified:
            self._save_session_to_disk(session_id)
            
        return modified or file_deleted

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str) -> bool:
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
            if msg.get('tool_calls'):
                for tc in msg['tool_calls']:
                    if tc.get('type') == 'response' and tc.get('response') and old_image_url in tc['response']:
                        tc['response'] = tc['response'].replace(old_image_url, new_image_url)
                        modified = True
                
        # Clean up the old image file from the server's local disk
        self._delete_local_image(old_image_url)
                    
        if modified:
            self._save_session_to_disk(session_id)
            return True
        return False

    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        if session_id not in self.sessions_history:
            return False
            
        history = self.sessions_history[session_id]
        new_msg = {
            'role': 'user' if role == 'user' else 'companion',
            'text': text,
            'tool_calls': []
        }
        history.append(new_msg)
        self._save_session_to_disk(session_id)
        return True

    async def update_message_text(self, session_id: str, role: str, index: int, new_text: str) -> bool:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        if session_id not in self.sessions_history:
            return False
            
        history = self.sessions_history[session_id]
        target_role = 'user' if role == 'user' else 'companion'
        match_count = 0
        target_msg = None
        for msg in history:
            msg_role = 'user' if msg.get('role') == 'user' else 'companion'
            if msg_role == target_role:
                if match_count == index:
                    target_msg = msg
                    break
                match_count += 1
                
        if target_msg:
            target_msg['text'] = new_text
            self._save_session_to_disk(session_id)
            return True
        return False

