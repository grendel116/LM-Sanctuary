import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from variables import PROGRAMS_DIR, LOCAL_SERVER_URL, DEFAULT_LOCAL_MODEL, DEFAULT_GEMINI_MODEL
from utils.models import is_local_model
import asyncio
import base64
import importlib
import json
import time
from google.genai import types

cancelled_sessions = set()

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


def _get_rag_context(query_text: str) -> str:
    """Helper to query the DataBank index for matching context (excluding chat history)."""
    if not query_text:
        return ""
    try:
        from core.skills.vectorized_databank.databank import DataBankManager
        db = DataBankManager()
        return db.query(query_text, exclude_source_type="chat_history")
    except Exception as e:
        print(f"Error querying data bank for RAG context: {e}")
        return ""


def _get_memory_context(query_text: str) -> str:
    """Helper to query the DataBank index for matching memory context (chat history only)."""
    if not query_text:
        return ""
    try:
        from core.skills.vectorized_databank.databank import DataBankManager
        db = DataBankManager()
        return db.query(query_text, top_k=3, include_source_type="chat_history")
    except Exception as e:
        print(f"Error querying data bank for memory context: {e}")
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
    "1. `[google_search(query=\"...\")]` / `[web_search(query=\"...\")]` - Search the web. Supports prefix routing for specific APIs (e.g. 'github: query', 'arxiv: query', 'hn: query') as well as concurrent hybrid blending.\n"
    "2. `[read_webpage(url=\"...\")]` - Fetch & read webpage text.\n"
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
    "14. `[generate_local_image(prompt=\"...\")]` - Generate scene of yourself. (MUST be the ONLY text in your response)\n"
    "15. `[generate_imagen(prompt=\"...\", aspect_ratio=\"...\")]` - Generate landscapes or objects.\n"
    "16. `[apply_comfy_workflow(workflow_path=\"...\", parameters={...}, save_path=\"...\")]` - Apply custom ComfyUI workflow.\n\n"
    "Rules:\n"
    "- Output exactly one tool call tag per turn when needed.\n"
    "- Call image generation tools sparingly.\n"
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


def _compact_session_history(adk_session, keep_turns: int = 3):
    """Prunes function calls and function response events from older turns to prevent token blowout."""
    if not adk_session or not hasattr(adk_session, 'events') or not adk_session.events:
        return
        
    # Chronological list of indices of user messages (excluding tool responses authored by user)
    user_event_indices = []
    for idx, ev in enumerate(adk_session.events):
        if ev.author.lower() == 'user':
            is_tool_response = False
            if ev.content and ev.content.parts:
                for part in ev.content.parts:
                    if getattr(part, 'function_response', None):
                        is_tool_response = True
                        break
            if not is_tool_response:
                user_event_indices.append(idx)
                
    # If history contains more than the keep threshold of user turns, prune old tool trace logs
    if len(user_event_indices) > keep_turns:
        # The cutoff index is the start of the first kept turn
        cutoff_idx = user_event_indices[-keep_turns]
        
        new_events = []
        for idx, ev in enumerate(adk_session.events):
            if idx >= cutoff_idx:
                new_events.append(ev)
                continue
                
            # For events before the cutoff, skip tool calls and responses entirely
            is_tool_event = False
            if ev.content and ev.content.parts:
                for part in ev.content.parts:
                    if getattr(part, 'function_call', None) or getattr(part, 'function_response', None):
                        is_tool_event = True
                        break
            if not is_tool_event:
                new_events.append(ev)
                
        pruned_count = len(adk_session.events) - len(new_events)
        if pruned_count > 0:
            print(f"[COMPACTION] Pruned {pruned_count} historical tool trace events prior to user turn index {cutoff_idx}.", flush=True)
            adk_session.events = new_events


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


class AdkHistoryAdapter(LocalHistoryAdapter):
    def __init__(self, runner_obj, session_id, adk_session, user_event):
        super().__init__(runner_obj, session_id)
        self.adk_session = adk_session
        self.user_event = user_event

    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str = None) -> list:
        import base64
        raw_messages = []
        for ev in self.adk_session.events:
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
                    raw_messages.append({"role": role, "content": text_content})
                else:
                    raw_messages.append({"role": role, "content": text})
                    
        openai_messages = [{"role": "system", "content": sys_inst}]
        if rag_context:
            openai_messages[0]["content"] += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
        if memory_context:
            openai_messages[0]["content"] += f"\n\n# ARCHIVED CONVERSATION MEMORY\nThe following is a chronological sequence of messages from earlier in this conversation:\n{memory_context}\n"
        openai_messages[0]["content"] += _LOCAL_DIRECTIVE_PROMPT

        for msg in raw_messages:
            if openai_messages and openai_messages[-1]["role"] == msg["role"]:
                openai_messages[-1]["content"] += "\n\n" + msg["content"]
            else:
                openai_messages.append(msg)
        return openai_messages

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str):
        from google.adk.events.event import Event
        from google.genai import types
        import time
        if self.adk_session.events:
            last_ev = self.adk_session.events[-1]
            if last_ev.author.lower() in ('companion', self.runner_obj.runner.agent.name.lower(), 'model') and last_ev.invocation_id == invocation_id:
                if last_ev.content and last_ev.content.parts:
                    for part in last_ev.content.parts:
                        if part.text is not None:
                            part.text = text
                            return last_ev
                            
        companion_content = types.Content(role="model", parts=[types.Part.from_text(text=text)])
        companion_event = Event(
            author=self.runner_obj.runner.agent.name,
            content=companion_content,
            invocation_id=invocation_id,
            id=f"companion-{int(time.time())}",
            timestamp=time.time()
        )
        self.adk_session.events.append(companion_event)
        return companion_event

    def append_tool_events(self, results: list, invocation_id: str):
        from google.adk.events.event import Event
        from google.genai import types
        import uuid
        import time
        for idx, (t_name, t_args, t_output) in enumerate(results):
            call_id = f"call_{int(time.time())}_{idx}_{uuid.uuid4().hex[:4]}"
            
            fc_part = types.Part(
                function_call=types.FunctionCall(
                    name=t_name,
                    args=t_args,
                    id=call_id
                )
            )
            fc_event = Event(
                author=self.runner_obj.runner.agent.name,
                content=types.Content(role="model", parts=[fc_part]),
                invocation_id=invocation_id,
                id=f"companion-call-{int(time.time())}-{idx}",
                timestamp=time.time()
            )
            self.adk_session.events.append(fc_event)
            
            fr_part = types.Part(
                function_response=types.FunctionResponse(
                    name=t_name,
                    response={"result": t_output},
                    id=call_id
                )
            )
            fr_event = Event(
                author=self.runner_obj.runner.agent.name,
                content=types.Content(role="user", parts=[fr_part]),
                invocation_id=invocation_id,
                id=f"companion-resp-{int(time.time())}-{idx}",
                timestamp=time.time()
            )
            self.adk_session.events.append(fr_event)

    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        from google.adk.events.event import Event
        from google.genai import types
        import time
        
        fc_part = types.Part(
            function_call=types.FunctionCall(
                name=tool_name,
                args=tool_args,
                id=call_id
            )
        )
        fc_event = Event(
            author=self.runner_obj.runner.agent.name,
            content=types.Content(role="model", parts=[fc_part]),
            invocation_id=invocation_id,
            id=f"companion-call-{int(time.time())}",
            timestamp=time.time()
        )
        self.adk_session.events.append(fc_event)
        
        fr_part = types.Part(
            function_response=types.FunctionResponse(
                name=tool_name,
                response={"result": new_markdown},
                id=call_id
            )
        )
        fr_event = Event(
            author=self.runner_obj.runner.agent.name,
            content=types.Content(role="user", parts=[fr_part]),
            invocation_id=invocation_id,
            id=f"companion-resp-{int(time.time())}",
            timestamp=time.time()
        )
        self.adk_session.events.append(fr_event)

    def post_process_thoughts(self, invocation_id: str):
        companion_events_this_turn = [
            ev for ev in self.adk_session.events 
            if ev.invocation_id == invocation_id 
            and ev.author.lower() in ('companion', self.runner_obj.runner.agent.name.lower(), 'model')
        ]
        
        last_text_ev = None
        for ev in reversed(companion_events_this_turn):
            if ev.content and ev.content.parts:
                has_text = any(part.text for part in ev.content.parts if not getattr(part, 'thought', False))
                if has_text:
                    last_text_ev = ev
                    break
                    
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

    def save(self):
        self.runner_obj._save_session_to_disk(self.session_id)


class OsHistoryAdapter(LocalHistoryAdapter):
    def __init__(self, runner_obj, session_id, file_path_resolved, image_data, image_mime):
        super().__init__(runner_obj, session_id)
        self.file_path_resolved = file_path_resolved
        self.image_data = image_data
        self.image_mime = image_mime
        self.initial_history_len = len(runner_obj.sessions_history[session_id])

    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str = None) -> list:
        history = self.runner_obj.sessions_history[self.session_id]
        raw_messages = []
        
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
                raw_messages.append({"role": role, "content": text_content})
            else:
                raw_messages.append({"role": role, "content": content_text})
                
        latest_msg = history[-1]
        if self.file_path_resolved or (self.image_data and self.image_mime):
            text_content = f"{latest_msg.get('text') or ''} (image: [Attached Image])" if latest_msg.get('text') else "[Attached Image]"
            raw_messages.append({"role": "user", "content": text_content})
        else:
            raw_messages.append({"role": "user", "content": latest_msg.get('text') or ''})
            
        openai_messages = [{"role": "system", "content": sys_inst}]
        if rag_context:
            openai_messages[0]["content"] += f"\n\n# KNOWLEDGE BASE CONTEXT\nUse the following verified context from your Data Bank to help answer questions if relevant:\n{rag_context}\n"
        if memory_context:
            openai_messages[0]["content"] += f"\n\n# ARCHIVED CONVERSATION MEMORY\nThe following is a chronological sequence of messages from earlier in this conversation:\n{memory_context}\n"
        openai_messages[0]["content"] += _LOCAL_DIRECTIVE_PROMPT

        for msg in raw_messages:
            if openai_messages and openai_messages[-1]["role"] == msg["role"]:
                openai_messages[-1]["content"] += "\n\n" + msg["content"]
            else:
                openai_messages.append(msg)
        return openai_messages

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str):
        import time
        history = self.runner_obj.sessions_history[self.session_id]
        if history and history[-1]['role'] == 'companion':
            history[-1]['text'] = text
            history[-1]['tool_calls'] = tool_calls_data
            return history[-1]
            
        bot_msg = {
            'role': 'companion',
            'text': text,
            'tool_calls': tool_calls_data,
            'timestamp': time.time()
        }
        history.append(bot_msg)
        return bot_msg

    def append_tool_events(self, results: list, invocation_id: str):
        import time
        for idx, (t_name, t_args, t_output) in enumerate(results):
            tool_resp_msg = {
                'role': 'user',
                'text': f"[Tool Response from {t_name}]:\n{t_output}",
                'tool_calls': [],
                'timestamp': time.time()
            }
            self.runner_obj.sessions_history[self.session_id].append(tool_resp_msg)

    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        pass

    def post_process_thoughts(self, invocation_id: str):
        history = self.runner_obj.sessions_history[self.session_id]
        companion_msgs_this_turn = [
            msg for msg in history[self.initial_history_len:]
            if msg.get('role') == 'companion'
        ]
        if companion_msgs_this_turn:
            for msg in companion_msgs_this_turn[:-1]:
                if msg.get('text'):
                    msg['text'] = f"<thought>\n{msg['text']}\n</thought>"

    def save(self):
        self.runner_obj._save_session_to_disk(self.session_id)


class BaseProgramRunner:
    def __init__(self, app_name="Sanctuary"):
        self.app_name = app_name

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
        import httpx
        import re
        import uuid
        import time
        import asyncio
        
        bot_response_text = ""
        tool_calls = []
        
        for iteration in range(10):
            if session_id in cancelled_sessions:
                cancelled_sessions.discard(session_id)
                raise asyncio.CancelledError("Session cancelled by user request.")
                
            sys_inst = self._get_system_instructions(inversion_directive, user_message=new_message_text)
            openai_messages = adapter.get_openai_messages(sys_inst, rag_context, memory_context)
            
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
                
            # Find all tool calls
            matches = list(re.finditer(r'\[(\w+)\((.*?)\)\]', bot_response_text))
            
            # Check for dynamic offloading triggers at execution-time
            gemini_key = os.getenv("GEMINI_API_KEY")
            project_id = os.getenv("PROJECT_ID")
            is_gemini_configured = bool(
                gemini_key and gemini_key.strip() and gemini_key != "your_gemini_api_key_here" and
                project_id and project_id.strip() and project_id != "your_gcp_project_id_here"
            )
            if is_gemini_configured and matches:
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

            legacy_portrait = False
            if not matches:
                match_legacy = re.search(r'<portrait>(.*?)</portrait>', bot_response_text)
                if match_legacy:
                    legacy_portrait = True
                    matches = [match_legacy]
                    
            executed_calls_count = len([tc for tc in tool_calls if tc.get('type') == 'call'])
            if matches and executed_calls_count < 10:
                # Check for image generation tool
                has_image_gen = False
                for m in matches:
                    if legacy_portrait:
                        tool_name = "generate_local_image"
                    else:
                        tool_name = m.group(1)
                        if tool_name == "generate_companion_portrait":
                            tool_name = "generate_local_image"
                        elif tool_name == "generate_general_image":
                            tool_name = "generate_imagen"
                    if tool_name in ("generate_local_image", "generate_imagen", "generate_companion_portrait", "generate_general_image"):
                        has_image_gen = True
                        break
                        
                if has_image_gen:
                    m = matches[0]
                    if legacy_portrait:
                        tool_name = "generate_local_image"
                        args_str = f"prompt={m.group(1)}"
                    else:
                        tool_name = m.group(1)
                        if tool_name == "generate_companion_portrait":
                            tool_name = "generate_local_image"
                        elif tool_name == "generate_general_image":
                            tool_name = "generate_imagen"
                        args_str = m.group(2)
                        
                    parsed_args = _parse_emulated_tool_call(tool_name, args_str)
                    import tools
                    func = getattr(tools, tool_name, None)
                    if func:
                        adapter.append_assistant_message(bot_response_text, [], invocation_id)
                        new_markdown = func(*parsed_args["args"], **parsed_args["kwargs"])
                        original_tag = m.group(0)
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
                        
                        adapter.append_image_tool_events(tool_name, t_calls[0]['args'], new_markdown, call_id, invocation_id)
                        
                        final_embedded_text = self._ensure_images_are_embedded(bot_response_text)
                        adapter.append_assistant_message(final_embedded_text, t_calls, invocation_id)
                        break
                else:
                    # Sequential execution for non-image tools
                    first_match_start = min(m.start() for m in matches)
                    text_before = bot_response_text[:first_match_start].strip()
                    
                    if text_before:
                        adapter.append_assistant_message(text_before, [], invocation_id)
                        
                    results = []
                    for m_tool in matches:
                        if session_id in cancelled_sessions:
                            raise asyncio.CancelledError("Session cancelled by user request.")
                        t_name = m_tool.group(1)
                        a_str = m_tool.group(2)
                        parsed_args = _parse_emulated_tool_call(t_name, a_str)
                        import tools
                        f = getattr(tools, t_name, None)
                        if not f:
                            output = f"Error: Tool '{t_name}' not found."
                        else:
                            try:
                                output = f(*parsed_args["args"], **parsed_args["kwargs"])
                            except Exception as ex:
                                output = f"Error executing tool: {ex}"
                        results.append((t_name, parsed_args["kwargs"], output))
                        
                    t_calls = []
                    for idx, (t_name, t_args, t_output) in enumerate(results):
                        call_id = f"call_{int(time.time())}_{idx}_{uuid.uuid4().hex[:4]}"
                        t_calls.extend([
                            {
                                'type': 'call',
                                'name': t_name,
                                'args': t_args,
                                'id': call_id
                            },
                            {
                                'type': 'response',
                                'name': t_name,
                                'response': str(t_output),
                                'id': call_id
                            }
                        ])
                        
                    tool_calls.extend(t_calls)
                    
                    adapter.append_assistant_message(text_before if text_before else "", t_calls, invocation_id)
                    adapter.append_tool_events(results, invocation_id)
                    continue
            else:
                if matches:
                    bot_response_text = re.sub(r'\[\w+\(.*?\)\]', '', bot_response_text).strip()
                adapter.append_assistant_message(bot_response_text, tool_calls, invocation_id)
                break
                
        adapter.post_process_thoughts(invocation_id)
        bot_response_text = self._ensure_images_are_embedded(bot_response_text)
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

    async def delete_message_at(self, session_id: str, role: str, index: int) -> bool:
        """Deletes a specific message inside the session history, merging surrounding messages of the same role if needed."""
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
            
            threshold = 5
            active_inversion = ""
            inversion_turns_remaining = 0
            
            # Scan history chronologically to simulate personality state machine
            for msg in history:
                if msg.get('role') == 'companion':
                    mood_details = msg.get('mood')
                    mood = mood_details.get('name') if isinstance(mood_details, dict) else None
                    if not mood:
                        text = msg.get('text', '')
                        if text:
                            state = analyze_emotional_state(text)
                            mood = state.get('name')
                    
                    if mood:
                        if active_inversion:
                            # Inversion is active, count down the turns
                            inversion_turns_remaining -= 1
                            if inversion_turns_remaining <= 0:
                                # Inversion has worn off, reset counts and clear active state
                                active_inversion = ""
                                for k in counts:
                                    counts[k] = 0
                        else:
                            # Count up mood frequency to check against threshold
                            if mood in counts:
                                counts[mood] += 1
                                if counts[mood] >= threshold:
                                    active_inversion = mood
                                    inversion_turns_remaining = 5
                                    
            return active_inversion
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
        """Links portrait and media images in the text prefixed with '!' so they render as images instead of links or plain text paths."""
        if not text:
            return text
        import re
        # Convert [Name](/images/portraits/...) or [Name](/images/media/...) to ![Name](...) if it is not already prefixed with !
        text = re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/portraits/[^)]+\))', r'!\1', text)
        text = re.sub(r'(?<!\!)(\[[^\]]*\]\(/images/media/[^)]+\))', r'!\1', text)
        
        # Convert raw paths /images/portraits/... or /images/media/... to markdown image format if they are not already in link syntax
        raw_path_pattern = r'(?<![\([/])(/images/(?:portraits|media)/[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|mp4))'
        text = re.sub(raw_path_pattern, r'![Portrait](\1)', text)
        return text

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
                
            # Intercept workspace/file/mod queries and direct the model to run exploration tools
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

        return instructions


class GoogleAdkRunner(BaseProgramRunner):
    def __init__(self, app_name="Sanctuary"):
        super().__init__(app_name)
        # Import dynamically to prevent crashes if ADK library is missing when toggle is switched off
        from google.adk.runners import InMemoryRunner
        from core import program_config
        
        try:
            import google.adk.flows.llm_flows.contents as adk_contents
            import copy
            from google.genai import types
            
            if not hasattr(adk_contents, '_original_get_contents'):
                adk_contents._original_get_contents = adk_contents._get_contents
                adk_contents._original_get_current_turn_contents = adk_contents._get_current_turn_contents
                
                def merge_consecutive_contents(contents):
                    if not contents:
                        return []
                    merged = []
                    for content in contents:
                        if not merged:
                            merged.append(copy.deepcopy(content))
                        else:
                            last = merged[-1]
                            last_role = 'user' if last.role == 'user' else 'model'
                            curr_role = 'user' if content.role == 'user' else 'model'
                            if last_role == curr_role:
                                if content.parts:
                                    for part in content.parts:
                                        if last.parts and last.parts[-1].text is not None and part.text is not None:
                                            last.parts[-1].text = f"{last.parts[-1].text}\n\n{part.text}".strip()
                                        else:
                                            last.parts.append(copy.deepcopy(part))
                            else:
                                merged.append(copy.deepcopy(content))
                    return merged
                    
                def my_get_contents(current_branch, events, agent_name=''):
                    res = adk_contents._original_get_contents(current_branch, events, agent_name)
                    return merge_consecutive_contents(res)
                    
                def my_get_current_turn_contents(current_branch, events, agent_name=''):
                    res = adk_contents._original_get_current_turn_contents(current_branch, events, agent_name)
                    return merge_consecutive_contents(res)
                    
                adk_contents._get_contents = my_get_contents
                adk_contents._get_current_turn_contents = my_get_current_turn_contents
                print("[MONKEYPATCH] Successfully patched google.adk.flows.llm_flows.contents to merge consecutive messages on-the-fly.", flush=True)
        except Exception as e:
            print(f"[MONKEYPATCH ERROR] Failed to patch ADK contents: {e}", flush=True)

        self.runner = InMemoryRunner(
            agent=program_config.root_program,
            app_name=self.app_name,
        )


    def _get_event_text_helper(self, ev) -> str:
        text = ""
        if ev.content and ev.content.parts:
            for part in ev.content.parts:
                if part.text:
                    text += part.text
                elif getattr(part, 'function_call', None):
                    fc = part.function_call
                    args_list = []
                    if fc.args:
                        args_dict = dict(fc.args) if not isinstance(fc.args, dict) else fc.args
                        for k, v in args_dict.items():
                            args_list.append(f'{k}={v}')
                    args_str = ", ".join(args_list)
                    text += f"\n[{fc.name}({args_str})]"
                elif getattr(part, 'function_response', None):
                    fr = part.function_response
                    resp = fr.response
                    text += f"\n[Tool Response from {fr.name}]:\n{resp}"
        return text

    async def _compact_and_vectorize_session_history(self, session_id: str, adk_session, active_model: str):
        # 1. Determine size
        history_text = ""
        for ev in adk_session.events:
            history_text += self._get_event_text_helper(ev)
            
        # Threshold: 24000 characters (~6,000 tokens)
        MAX_LOCAL_CONTEXT_CHARS = 24000
        if len(history_text) <= MAX_LOCAL_CONTEXT_CHARS:
            return
            
        print(f"[COMPACTION] Active context has breached threshold: {len(history_text)} characters. Running compaction...", flush=True)
        
        # 2. Find cutoff boundary (keep last 3 user turns)
        user_event_indices = []
        for idx, ev in enumerate(adk_session.events):
            if ev.author.lower() == 'user':
                is_tool_response = False
                if ev.content and ev.content.parts:
                    for part in ev.content.parts:
                        if getattr(part, 'function_response', None):
                            is_tool_response = True
                            break
                if not is_tool_response:
                    user_event_indices.append(idx)
                    
        if len(user_event_indices) <= 3:
            return
            
        cutoff_idx = user_event_indices[-3]
        
        # Extract historical events to summarize
        historical_turns = adk_session.events[:cutoff_idx]
        text_to_summarize = ""
        for ev in historical_turns:
            role = "User" if ev.author.lower() == "user" else "Companion"
            text = self._get_event_text_helper(ev).strip()
            if text:
                text_to_summarize += f"{role}: {text}\n\n"
                
        if not text_to_summarize.strip():
            return
            
        # 3. Fetch prior 2 chat history archives to reference in summary generation
        prior_texts = []
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            priors = db.get_prior_chat_histories(session_id, limit=2)
            for p in priors:
                prior_texts.append(f"--- PRIOR MEMORY ARCHIVE ({p['name']}) ---\n{p['text']}")
        except Exception as e:
            print(f"[COMPACTION] Error fetching prior chat histories: {e}", flush=True)

        # 4. Generate summary using local model, referencing prior memories if any exist
        summary = await self._generate_local_summary(text_to_summarize, active_model, prior_memories=prior_texts)
        if summary.startswith("Memory compaction summary generation failed"):
            summary = (
                "Older conversation turns were pruned to free up local memory. The full transcript of these turns "
                "has been archived in the vector database and remains searchable."
            )
        
        # 5. Ingest raw historical turns to SQLite vector databank and prune to keep at most 3
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            import time
            db = DataBankManager()
            db.ingest_text(
                text=text_to_summarize,
                name=f"chat_history_archive_{session_id}_{int(time.time())}",
                source_type="chat_history"
            )
            db.prune_chat_histories(session_id, keep_limit=3)
            print(f"[COMPACTION] Ingested history to vector database and pruned to limit.", flush=True)
        except Exception as e:
            print(f"[COMPACTION ERROR] Failed to ingest to vectorized database: {e}", flush=True)
            
        # 6. Replace historical turns with summary system-memory event
        from google.adk.events.event import Event
        from google.genai import types
        import time
        
        summary_content = types.Content(
            role="user",
            parts=[types.Part.from_text(text=f"[System Memory of older conversation turns]:\n{summary}")]
        )
        summary_event = Event(
            author="user",
            content=summary_content,
            invocation_id="system-memory",
            id=f"memory-{int(time.time())}",
            timestamp=time.time()
        )
        
        adk_session.events = [summary_event] + adk_session.events[cutoff_idx:]
        self._save_session_to_disk(session_id)
        print(f"[COMPACTION] Replaced {cutoff_idx} historical events with system memory summary.", flush=True)

    async def _generate_local_summary(self, text_to_summarize: str, active_model: str, prior_memories: list = None) -> str:
        import httpx
        import os
        from variables import LOCAL_SERVER_URL
        
        prompt = (
            "You are a memory compaction assistant. Summarize the following new chat history between the User and the Companion. "
            "Extract key facts, user preferences, agreed instructions, file changes, and project details. "
            "Keep the summary extremely dense, structured, and under 500 words. Do NOT include greetings or conversational filler.\n\n"
        )
        if prior_memories:
            prompt += "To maintain continuity, you are provided with excerpts of the prior conversation memory archives:\n"
            for pm in prior_memories:
                prompt += f"{pm}\n\n"
            prompt += "Reference and build upon these prior memories to ensure the new summary is coherent with previous context.\n\n"
            
        prompt += (
            f"NEW CHAT HISTORY TO SUMMARIZE:\n{text_to_summarize}\n\n"
            "SUMMARY:"
        )
        
        payload = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 1024
        }
        target_model = active_model if (active_model and active_model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
        if target_model:
            payload["model"] = target_model
            
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(LOCAL_SERVER_URL, json=payload, headers={"Content-Type": "application/json"}, timeout=60.0)
                if response.status_code == 200:
                    res_json = response.json()
                    return res_json['choices'][0]['message']['content'].strip()
                else:
                    print(f"Local server returned error for summary: {response.status_code} - {response.text}", flush=True)
        except Exception as e:
            print(f"Error generating local summary: {e}", flush=True)
        return "Memory compaction summary generation failed due to connection error."

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
                
        # Clean up database chat history archives for this session
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            db.delete_chat_history(session_id)
        except Exception as e:
            print(f"Error cleaning up databank history on session reset: {e}")
                
        from core import program_config
        program_config.set_inversion_directive("")

    def _reload_config(self, model=None, inversion_directive=None, rag_context=None, memory_context=None, user_message=None):
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
            if memory_context:
                instruction += f"\n\n# ARCHIVED CONVERSATION MEMORY\nThe following is a chronological sequence of messages from earlier in this conversation:\n{memory_context}\n"
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
                    'image_url': image_url,
                    'timestamp': ev.timestamp
                })
            elif role == 'companion' or role == self.runner.agent.name.lower():
                if not current_companion_msg:
                    current_companion_msg = {
                        'role': 'companion',
                        'text': '',
                        'tool_calls': [],
                        'timestamp': ev.timestamp
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
        
        first_iter = True
        async for event in self.runner.run_async(
            user_id="user",
            session_id=session_id,
            new_message=content,
        ):
            if first_iter:
                self._save_session_to_disk(session_id)
                first_iter = False
            if session_id in cancelled_sessions:
                cancelled_sessions.discard(session_id)
                raise asyncio.CancelledError("Session cancelled by user request.")
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
        memory_context = _get_memory_context(new_message_text)
        inversion_directive = await self._get_inversion_directive(session_id)
        self._reload_config(model, inversion_directive, rag_context, memory_context, user_message=new_message_text)
        
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
        
        # Determine if we should perform hybrid background offloading when a local model is chosen
        if _is_local_model(model):
            gemini_key = os.getenv("GEMINI_API_KEY")
            project_id = os.getenv("PROJECT_ID")
            is_gemini_configured = bool(
                gemini_key and gemini_key.strip() and gemini_key != "your_gemini_api_key_here" and
                project_id and project_id.strip() and project_id != "your_gcp_project_id_here"
            )
            
            if is_gemini_configured:
                # 1. Compact locally if chat history is too long
                await self._compact_and_vectorize_session_history(session_id, adk_session, model)
                
                # 2. Check routing offload criteria
                offload = False
                
                # Explicit commands: /offload or /cloud
                clean_msg = new_message_text.strip() if new_message_text else ""
                if clean_msg.startswith('/offload') or clean_msg.startswith('/cloud'):
                    offload = True
                    if clean_msg.startswith('/offload'):
                        new_message_text = clean_msg[len('/offload'):].strip()
                    else:
                        new_message_text = clean_msg[len('/cloud'):].strip()
                        
                # Unsupported media type
                if media_path:
                    import mimetypes
                    mime_type, _ = mimetypes.guess_type(media_path)
                    if mime_type and not mime_type.startswith('image/'):
                        offload = True
                        print(f"[OFFLOAD] Routing to remote model due to unsupported local media type: {mime_type}", flush=True)
                        
                # Context limit
                history_text = ""
                for ev in adk_session.events:
                    history_text += self._get_event_text_helper(ev)
                
                total_chars = len(history_text) + len(new_message_text or "") + len(rag_context or "")
                if total_chars > 24000:
                    offload = True
                    print(f"[OFFLOAD] Routing to remote model due to context size limit ({total_chars} chars)", flush=True)
                    
                if offload:
                    model = DEFAULT_GEMINI_MODEL
                    print(f"[OFFLOAD] Offloading query execution to remote model: {model}", flush=True)
                    self._reload_config(model, inversion_directive, rag_context, memory_context, user_message=new_message_text)

        # Run history compaction to keep contexts compact and prevent token blowout
        _compact_session_history(adk_session)

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
            
            user_content = types.Content(role="user", parts=parts)
            invocation_id = f"e-{int(time.time())}"
            user_event = Event(
                author="user",
                content=user_content,
                invocation_id=invocation_id,
                id=f"user-{int(time.time())}",
                timestamp=time.time()
            )
            adk_session.events.append(user_event)
            self._save_session_to_disk(session_id)
            
            adapter = AdkHistoryAdapter(self, session_id, adk_session, user_event)
            try:
                return await self._execute_local_llm_loop(
                    session_id=session_id,
                    adapter=adapter,
                    model=model,
                    inversion_directive=inversion_directive,
                    rag_context=rag_context,
                    memory_context=memory_context,
                    new_message_text=new_message_text,
                    invocation_id=invocation_id
                )
            except LocalOffloadTrigger as trigger_exc:
                print(f"[OFFLOAD] Caught LocalOffloadTrigger: {trigger_exc.reason}. Rolling back local turn and offloading to cloud.", flush=True)
                # Rollback current assistant events matching this invocation_id
                adk_session.events = [ev for ev in adk_session.events if ev.invocation_id != invocation_id]
                
                # Switch to DEFAULT_GEMINI_MODEL and recursively execute run_async
                model = DEFAULT_GEMINI_MODEL
                print(f"[OFFLOAD] Recursively calling run_async with remote model: {model}", flush=True)
                return await self.run_async(
                    session_id=session_id,
                    new_message_text=new_message_text,
                    image_data=image_data,
                    image_mime=image_mime,
                    model=model,
                    media_path=media_path
                )
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
                        
        if new_text is None:
            new_text = "/cloud " + query_text
            
        if new_text and (new_text.startswith('/cloud') or new_text.startswith('/offload')):
            if new_text.startswith('/cloud'):
                new_text = new_text[len('/cloud'):].strip()
            else:
                new_text = new_text[len('/offload'):].strip()
            model = DEFAULT_GEMINI_MODEL
            # Update query_text to be clean for configuration and RAG
            query_text = new_text
            
        rag_context = _get_rag_context(query_text)
        memory_context = _get_memory_context(query_text)
        inversion_directive = await self._get_inversion_directive(session_id)
        self._reload_config(model, inversion_directive, rag_context, memory_context, user_message=query_text)
            
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

    async def delete_message_at(self, session_id: str, role: str, index: int) -> bool:
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
        events = list(storage_session.events)
        from google.genai import types
        
        target_role = 'user' if role == 'user' else 'companion'
        
        if target_role == 'user':
            user_event_indices = [i for i, ev in enumerate(events) if ev.author.lower() == 'user']
            if index >= len(user_event_indices):
                return False
            target_idx = user_event_indices[index]
            del events[target_idx]
        else:
            companion_turns = []
            current_turn = []
            for i, ev in enumerate(events):
                if ev.author.lower() == 'user':
                    if current_turn:
                        companion_turns.append(current_turn)
                        current_turn = []
                else:
                    current_turn.append((i, ev))
            if current_turn:
                companion_turns.append(current_turn)
                
            if index >= len(companion_turns):
                return False
                
            turn_events = companion_turns[index]
            indices_to_delete = {item[0] for item in turn_events}
            events = [ev for i, ev in enumerate(events) if i not in indices_to_delete]
            
        storage_session.events = events
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
        raw_history = self.sessions_history.get(session_id, [])
        
        from utils.program_mood import extract_and_strip_mood
        updated_any = False
        for msg in raw_history:
            if msg.get('role') == 'companion' and 'mood' not in msg:
                m_text = msg.get('text', '')
                if m_text:
                    clean_text, mood_details = extract_and_strip_mood(m_text)
                    msg['text'] = clean_text
                    msg['mood'] = mood_details
                    updated_any = True
                    
        if updated_any:
            self._save_session_to_disk(session_id)
            
        chat_history = []
        for msg in raw_history:
            chat_history.append(msg.copy())
        return chat_history

    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None) -> tuple:
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
            'image_url': media_path if media_path else (f"data:{image_mime};base64,{image_data}" if image_data else None),
            'timestamp': time.time()
        }
        self.sessions_history[session_id].append(user_msg)
        self._save_session_to_disk(session_id)
        
        # Get RAG and memory contexts
        rag_context = _get_rag_context(new_message_text)
        memory_context = _get_memory_context(new_message_text)
        
        # Determine the personality inversion before getting system instructions
        inversion_directive = await self._get_inversion_directive(session_id)
        
        adapter = OsHistoryAdapter(self, session_id, file_path_resolved, image_data, image_mime)
        return await self._execute_local_llm_loop(
            session_id=session_id,
            adapter=adapter,
            model=model,
            inversion_directive=inversion_directive,
            rag_context=rag_context,
            memory_context=memory_context,
            new_message_text=new_message_text,
            invocation_id=""
        )
 
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
        self._save_session_to_disk(session_id)
        
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
                
        # Clean up database chat history archives for this session
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            db.delete_chat_history(session_id)
        except Exception as e:
            print(f"Error cleaning up databank history on session reset: {e}")
                
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

    async def delete_message_at(self, session_id: str, role: str, index: int) -> bool:
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        if session_id not in self.sessions_history:
            return False
            
        history = list(self.sessions_history[session_id])
        target_role = 'user' if role == 'user' else 'companion'
        
        target_abs_index = -1
        role_count = 0
        for i, msg in enumerate(history):
            msg_role = 'user' if msg.get('role') == 'user' else 'companion'
            if msg_role == target_role:
                if role_count == index:
                    target_abs_index = i
                    break
                role_count += 1
                
        if target_abs_index == -1:
            return False
            
        del history[target_abs_index]
        
        self.sessions_history[session_id] = history
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
            'tool_calls': [],
            'timestamp': time.time()
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

