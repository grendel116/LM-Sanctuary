import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from variables import AGENTS_DIR, LOCAL_SERVER_URL, DEFAULT_LOCAL_MODEL
from utils.models import is_local_model
import asyncio
import base64
import importlib
import json
from google.genai import types

def _get_safe_local_path(image_url: str) -> str:
    """Safely converts an image URL into a local path relative to the workspace,
    supporting subdirectories like 'portraits' while preventing path traversal.
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
    from utils.agent import get_active_agent
    active_agent = get_active_agent()
    return os.path.normpath(os.path.join("core", "agents", active_agent, *safe_parts))


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


class BaseAgentRunner:
    def __init__(self, app_name="Sanctuary"):
        self.app_name = app_name

    @property
    def sessions_dir(self) -> str:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        from utils.agent import get_active_agent
        active_agent = get_active_agent()
        path = os.path.join(base_dir, "core", "agents", active_agent, "sessions")
        os.makedirs(path, exist_ok=True)
        return path

    async def get_history(self, session_id: str) -> list:
        """Retrieves formatted chat history for the session."""
        raise NotImplementedError()

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None) -> tuple:
        """Runs the agent with a new turn and returns (response_text, tool_calls_list)."""
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
                
            from tools import analyze_emotional_state
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
            from utils.agent import get_active_agent
            active_agent = get_active_agent()
            json_path = os.path.normpath(os.path.join(AGENTS_DIR, active_agent, "inversion_directives.json"))
            if not os.path.exists(json_path):
                print(f"[WARN] inversion_directives.json not found at '{json_path}' for agent '{active_agent}'.")
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
        """Ensures that any portrait image links in the text are prefixed with '!' so they render as images instead of links."""
        if not text:
            return text
        import re
        # Convert [Name](/images/portraits/...) to ![Name](...) if it is not already prefixed with !
        return re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/portraits/[^)]+\))', r'!\1', text)

    def _get_system_instructions(self, inversion_directive=None) -> str:
        """Pulls the system prompt directly from <agent>.md and skill files."""
        from core import agent_config
        if inversion_directive is not None:
            agent_config.set_inversion_directive(inversion_directive)
        instructions = agent_config.get_compiled_instructions()
        
        # Enforce global conciseness directive for all running LLMs at the runner level
        conciseness_directive = (
            "\n\n# CONCISENESS & STYLE\n"
            "Be brief and natural. No monologues, lecturing, or forced philosophical questions. Ask questions only when contextually natural.\n"
        )
        if "CONCISENESS" not in instructions and "brief, succinct, and natural" not in instructions:
            instructions += conciseness_directive
            
        # Global NSFW allowance directive
        nsfw_directive = (
            "\n\n# CONTENT DIRECTIVE\n"
            "Anarcho-communist ethics. Explicit and NSFW content is permitted.\n"
        )
        instructions += nsfw_directive
            
        return instructions


class GoogleAdkRunner(BaseAgentRunner):
    def __init__(self, app_name="Sanctuary"):
        super().__init__(app_name)
        # Import dynamically to prevent crashes if ADK library is missing when toggle is switched off
        from google.adk.runners import InMemoryRunner
        from core import agent_config
        
        self.runner = InMemoryRunner(
            agent=agent_config.root_agent,
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
                
        from core import agent_config
        agent_config.set_inversion_directive("")

    def _reload_config(self, model=None, inversion_directive=None, rag_context=None):
        """Reloads tools and character configs dynamically to pick up edits."""
        from google.adk.runners import InMemoryRunner
        from core import agent_config
        try:
            old_sessions = self.runner.session_service.sessions if hasattr(self, 'runner') else None
            import tools
            importlib.reload(tools)
            importlib.reload(agent_config)
            if inversion_directive is not None:
                agent_config.set_inversion_directive(inversion_directive)
                
            instruction = self._get_system_instructions(inversion_directive)
            if rag_context:
                instruction += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
            agent_config.root_agent.instruction = instruction
            
            if model:
                agent_config.root_agent.model = model
            
            # Re-create runner to cleanly bind the reloaded agent
            self.runner = InMemoryRunner(
                agent=agent_config.root_agent,
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
        
        for ev in adk_session.events:
            role = ev.author.lower()
            if role == 'user':
                if current_companion_msg:
                    chat_history.append(current_companion_msg)
                    current_companion_msg = None
                
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
                
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if part.text:
                            current_companion_msg['text'] += part.text
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
            chat_history.append(current_companion_msg)
        return chat_history

    async def _execute_runner_and_collect(self, session_id, content):
        full_text = ""
        tool_calls = []
        
        async for event in self.runner.run_async(
            user_id="user",
            session_id=session_id,
            new_message=content,
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text:
                        full_text += part.text
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
        self._reload_config(model, inversion_directive, rag_context)
        
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
                    active_agent = os.getenv("ACTIVE_AGENT", "arthur")
                    local_file_path = os.path.normpath(os.path.join('core', 'agents', active_agent, rel_path))
                    
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
            
            # Format prompts
            sys_inst = self._get_system_instructions()
            if rag_context:
                sys_inst += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
            sys_inst += (
                "\n\n# LOCAL MODEL ENGINE DIRECTIVE\n"
                "You are running on a local engine that does not support native function calling.\n"
                "If you want to generate a portrait/image of yourself, you MUST output a text tag in your response "
                "in this exact format:\n"
                "[generate_companion_portrait(prompt=\"your detailed image description prompt here\")]\n"
                "Do NOT output the markdown image link yourself; the system will detect this tag, "
                "run the generator, and substitute the image link into your message.\n"
                "Your response must contain ONLY the tag, with no other text.\n"
            )
            openai_messages = [{"role": "system", "content": sys_inst}]
            
            user_events = [ev for ev in adk_session.events if ev.author.lower() == 'user']
            
            for ev in adk_session.events:
                role = ev.author.lower()
                if role == 'user':
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
                    

                        
                    if image_url:
                        # Fallback to text description to prevent API crashes on text-only local models (LM Studio)
                        text_content = f"{text} (image: [Attached Image])" if text else "[Attached Image]"
                        openai_messages.append({
                            "role": "user",
                            "content": text_content
                        })
                    else:
                        openai_messages.append({
                            "role": "user",
                            "content": text
                        })
                elif role == 'companion' or role == self.runner.agent.name.lower() or role == 'model':
                    text = ""
                    if ev.content and ev.content.parts:
                        for part in ev.content.parts:
                            if part.text:
                                text += part.text
                    if text:
                        openai_messages.append({
                            "role": "assistant",
                            "content": text
                        })
                        
            url = LOCAL_SERVER_URL
            headers = {"Content-Type": "application/json"}
            payload = {
                "messages": openai_messages,
                "temperature": 1.0,
                "max_tokens": 2048
            }
            target_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
            if target_model:
                payload["model"] = target_model
            
            bot_response_text = ""
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(url, json=payload, headers=headers, timeout=120.0)
                    if response.status_code == 200:
                        res_json = response.json()
                        bot_response_text = res_json['choices'][0]['message']['content']
                    else:
                        bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
            except Exception as e:
                bot_response_text = f"Error connecting to local LM Studio server: {e}. Please ensure LM Studio is running, a model is loaded, and the local server is started (port 1234)."
                
            # Check for portrait generator tags in local model response
            import re
            match = re.search(r'\[generate_companion_portrait\((?:prompt=)?["\'](.*?)["\']\)\]', bot_response_text)
            if not match:
                match = re.search(r'<portrait>(.*?)</portrait>', bot_response_text)
            
            tool_calls = []
            if match:
                prompt_text = match.group(1).strip()
                print(f"[DEBUG EMULATOR] Extracted prompt from local LLM text response: {prompt_text}")
                import tools
                new_markdown = tools.generate_companion_portrait(prompt_text)
                
                # Replace the tool call tag with the generated markdown link
                original_tag = match.group(0)
                bot_response_text = bot_response_text.replace(original_tag, new_markdown)
                
                call_id = f"call_{int(time.time())}"
                
                # Append simulated tool call and response events to preserve history
                # 1. The function call event
                fc_part = types.Part(
                    function_call=types.FunctionCall(
                        name="generate_companion_portrait",
                        args={"prompt": prompt_text},
                        id=call_id
                    )
                )
                fc_event = Event(
                    author="Companion",
                    content=types.Content(role="model", parts=[fc_part]),
                    invocation_id=user_event.invocation_id,
                    id=f"companion-call-{int(time.time())}",
                    timestamp=time.time()
                )
                adk_session.events.append(fc_event)
                
                # 2. The function response event
                fr_part = types.Part(
                    function_response=types.FunctionResponse(
                        name="generate_companion_portrait",
                        response={"result": new_markdown},
                        id=call_id
                    )
                )
                fr_event = Event(
                    author="Companion",
                    content=types.Content(role="user", parts=[fr_part]),
                    invocation_id=user_event.invocation_id,
                    id=f"companion-resp-{int(time.time())}",
                    timestamp=time.time()
                )
                adk_session.events.append(fr_event)
                
                # We return the tool call list so that the frontend can see it immediately
                tool_calls.append({
                    'type': 'call',
                    'name': 'generate_companion_portrait',
                    'args': {'prompt': prompt_text},
                    'id': call_id
                })
                
            bot_response_text = self._ensure_images_are_embedded(bot_response_text)
            companion_content = types.Content(role="model", parts=[types.Part.from_text(text=bot_response_text)])
            companion_event = Event(
                author="Companion",
                content=companion_content,
                invocation_id=user_event.invocation_id,
                id=f"companion-{int(time.time())}",
                timestamp=time.time()
            )
            adk_session.events.append(companion_event)
            
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
        self._reload_config(model, inversion_directive, rag_context)
        
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
        
        author = "Companion" if role != "user" else "user"
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
        match_count = 0
        target_event = None
        for ev in events:
            author_lower = ev.author.lower()
            ev_role = 'user' if author_lower == 'user' else 'companion'
            if ev_role == target_role:
                has_text = False
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if part.text:
                            has_text = True
                if has_text:
                    if match_count == index:
                        target_event = ev
                        break
                    match_count += 1
                    
        if target_event:
            for part in target_event.content.parts:
                if part.text:
                    part.text = new_text
            self._save_session_to_disk(session_id)
            return True
        return False



class OpenSourceRunner(BaseAgentRunner):
    """Scaffold implementation showing how we can run Companion using a local open-source LLM.
    
    This operates independently of google-adk or Google cloud infrastructure, 
    reading character settings directly from sanctuary/<agent>.md.
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
        
        # Resolve media upload if present
        file_path_resolved = None
        if media_path:
            try:
                if media_path.startswith('/images/'):
                    rel_path = media_path[len('/images/'):]
                    active_agent = os.getenv("ACTIVE_AGENT", "arthur")
                    local_file_path = os.path.normpath(os.path.join('core', 'agents', active_agent, rel_path))
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
        sys_inst = self._get_system_instructions(inversion_directive)
        if rag_context:
            sys_inst += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
        sys_inst += (
            "\n\n# LOCAL MODEL ENGINE DIRECTIVE\n"
                "You are running on a local engine that does not support native function calling.\n"
                "If you want to generate a portrait/image of yourself, you MUST output a text tag in your response "
                "in this exact format:\n"
                "[generate_companion_portrait(prompt=\"your detailed image description prompt here\")]\n"
                "Do NOT output the markdown image link yourself; the system will detect this tag, "
                "run the generator, and substitute the image link into your message.\n"
                "Your response must contain ONLY the tag, with no other text.\n"
            )
        
        # Format messages for LM Studio OpenAI API standard
        openai_messages = [{"role": "system", "content": sys_inst}]
        
        history = self.sessions_history[session_id]
        
        # Format existing history
        for msg in history[:-1]:
            role = "assistant" if msg['role'] == 'companion' else "user"
            if msg.get('image_url'):
                text_content = f"{msg.get('text', '')} (image: [Attached Image])" if msg.get('text') else "[Attached Image]"
                openai_messages.append({
                    "role": role,
                    "content": text_content
                })
            else:
                openai_messages.append({
                    "role": role,
                    "content": msg.get('text', '')
                })
                
        # Format latest user turn
        if file_path_resolved or (image_data and image_mime):
            text_content = f"{new_message_text or ''} (image: [Attached Image])" if new_message_text else "[Attached Image]"
            openai_messages.append({
                "role": "user",
                "content": text_content
            })
        else:
            openai_messages.append({
                "role": "user",
                "content": new_message_text or ''
            })
            
        url = LOCAL_SERVER_URL
        headers = {"Content-Type": "application/json"}
        payload = {
            "messages": openai_messages,
            "temperature": 1.0,
            "max_tokens": 2048
        }
        target_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
        if target_model:
            payload["model"] = target_model
        
        bot_response_text = ""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=120.0)
                if response.status_code == 200:
                    res_json = response.json()
                    bot_response_text = res_json['choices'][0]['message']['content']
                else:
                    bot_response_text = f"Error: Local model server returned status code {response.status_code} - {response.text}"
        except Exception as e:
            bot_response_text = f"Error connecting to local LM Studio server: {e}. Please ensure LM Studio is running, a model is loaded, and the local server is started (port 1234)."
        
        # Check for portrait generator tags in response
        import re
        match = re.search(r'\[generate_companion_portrait\((?:prompt=)?["\'](.*?)["\']\)\]', bot_response_text)
        if not match:
            match = re.search(r'<portrait>(.*?)</portrait>', bot_response_text)
            
        tool_calls = []
        if match:
            prompt_text = match.group(1).strip()
            print(f"[DEBUG OS EMULATOR] Extracted prompt from local LLM text response: {prompt_text}")
            import tools
            import time
            new_markdown = tools.generate_companion_portrait(prompt_text)
            
            # Replace the tool call tag with the generated markdown link
            original_tag = match.group(0)
            bot_response_text = bot_response_text.replace(original_tag, new_markdown)
            
            call_id = f"call_{int(time.time())}"
            
            # Append simulated tool call and response events to preserve history
            tool_calls.append({
                'type': 'call',
                'name': 'generate_companion_portrait',
                'args': {'prompt': prompt_text},
                'id': call_id
            })
            tool_calls.append({
                'type': 'response',
                'name': 'generate_companion_portrait',
                'response': new_markdown,
                'id': call_id
            })
            
        bot_response_text = self._ensure_images_are_embedded(bot_response_text)
        bot_msg = {
            'role': 'companion',
            'text': bot_response_text,
            'tool_calls': tool_calls
        }
        self.sessions_history[session_id].append(bot_msg)
        
        # Save to disk
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
                
        from core import agent_config
        agent_config.set_inversion_directive("")

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

