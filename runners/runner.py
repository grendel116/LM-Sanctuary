import asyncio
import copy
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

# --- DEFINE GLOBALS FIRST BEFORE LOCAL IMPORTS ---
cancelled_sessions = set()
voice_call_sessions = set()

import httpx
from dotenv import load_dotenv

project_root = Path(__file__).resolve().parent.parent
PROGRAMS_DIR = project_root / "core" / "programs"

# Local imports follow below...
from variables.settings import get_local_server_headers
from adapters.history_adapters import OsHistoryAdapter
from core.mood_inversion import get_directive, is_enabled, new_state, update_state
from models.models import is_local_model
from runners.program import get_active_program
from utils.utils import (
    _build_tool_calls_pair,
    _build_vector_query,
    _convert_json_tool_calls_to_tags,
    _execute_emulated_tool,
    _get_databank_contexts,
    _get_safe_local_path,
    _normalize_tool_name,
    _parse_emulated_tool_call,
    is_real_user_msg,
    strip_story,
)

# Load environment configuration directly
load_dotenv()
LOCAL_SERVER_URL = os.environ.get("LOCAL_SERVER_URL")

# --- PRE-COMPILED REGULAR EXPRESSIONS ---
THINK_TAG_RE = re.compile(
    r"(?:<think>|\[think\]|<thought>|\[thought\]|<\|thought\|>|<\|channel\|>thought|<channel\|>thought)"
    r"[\s\S]*?"
    r"(?:</think>|\[/think\]|</thought>|\[/thought\]|<\|thought\|>|<\|channel\|>|<channel\|>|<\/\s*think>|\[\s*/\s*think\s*\]|$)",
    flags=re.IGNORECASE,
)
CHANNEL_TAG_RE = re.compile(r"<\|channel\|>|<channel\|>", flags=re.IGNORECASE)
TOOL_TAG_RE = re.compile(r"\[(\w+)\(([\s\S]*?)\)\]")
TOOL_TAG_STRIP_RE = re.compile(r"\[\w+\([\s\S]*?\n?\)\]", flags=re.DOTALL)
IMAGE_EMBED_RE = re.compile(r"(?<!\!)(\[[^\]]*\]\(/images/(?:portraits|media)/[^)]+\))")
RAW_IMAGE_PATH_RE = re.compile(
    r"(?<![\([/])(/images/(?:portraits|media)/[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|mp4))"
)
PASTED_LINK_RE = re.compile(r"https?://[^\s>)]+")

# --- PERSISTENT HTTP CLIENT POOL ---
_http_client: httpx.AsyncClient | None = None
_http_client_loop: asyncio.AbstractEventLoop | None = None

def get_http_client() -> httpx.AsyncClient:
    global _http_client, _http_client_loop
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None

    if (
        _http_client is None
        or _http_client.is_closed
        or _http_client_loop != current_loop
    ):
        _http_client = httpx.AsyncClient(
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        _http_client_loop = current_loop
    return _http_client

def _trim_context_messages(messages: list[dict], max_chars: int = 26000) -> list[dict]:
    """Fast context trimming calculation to remain within token/char budget."""
    total_chars = sum(len(m.get("content") or "") for m in messages)
    if total_chars <= max_chars:
        return messages

    print("[CONTEXT TRIM] Context payload exceeds local budget. Trimming older turns...", flush=True)
    system_msgs = [m for m in messages if m.get("role") == "system"]
    chat_msgs = [m for m in messages if m.get("role") != "system"]

    sys_len = sum(len(m.get("content") or "") for m in system_msgs)
    budget = max_chars - sys_len

    current_len = 0
    trimmed_chat = []
    for m in reversed(chat_msgs):
        m_len = len(m.get("content") or "")
        if current_len + m_len > budget:
            break
        trimmed_chat.append(m)
        current_len += m_len

    return system_msgs + list(reversed(trimmed_chat))

class BaseProgramRunner:
    def __init__(self, app_name: str = "Sanctuary"):
        self.app_name = app_name
        self.sessions_history: dict = {}
        self.sessions_inversion_state: dict = {}
        self.sessions_memory_state: dict = {}  # Tracks chapters and epic chronicles

    def _get_memory_meta(self, session_id: str) -> dict:
        """Helper to ensure session memory state exists."""
        return self.sessions_memory_state.setdefault(
            session_id,
            {"recent_chapters": [], "epic_chronicle": ""}
        )

    async def _post_llm_request(
        self,
        url: str,
        payload: dict,
        headers: dict,
        timeout: float = 60.0,
        session_id: str | None = None,
    ) -> httpx.Response:
        """Send a request to the local LLM endpoint with cancellation support."""
        # Pre-flight check: ensure local LLM server is booted and ready before making requests
        from adapters.vram_orchestrator import start_llm_async
        target_model = payload.get("model")
        server_ready = await start_llm_async(target_model)
        if not server_ready:
            raise RuntimeError(f"Local LLM server is offline or failed to start (model: {target_model or 'default'}). Check logs/llama_server.log for details.")

        start_time = time.time()
        max_retry_time, retry_interval = 180.0, 2.0

        def _check_cancellation():
            if session_id and session_id in cancelled_sessions:
                cancelled_sessions.discard(session_id)
                print(f"[CANCEL] Aborting HTTP request for session {session_id}", flush=True)
                raise asyncio.CancelledError("Session cancelled by user request.")

        while True:
            _check_cancellation()

            try:
                client = get_http_client()
                if session_id:
                    req_payload = {**payload, "stream": True}
                    req_headers = {**headers, "Accept-Encoding": "identity"}

                    async with client.stream("POST", url, json=req_payload, headers=req_headers, timeout=timeout) as r:
                        if r.status_code == 503:
                            await r.aread()
                            if time.time() - start_time < max_retry_time:
                                print(f"[Local LLM] Server is loading model (503). Retrying in {retry_interval}s...", flush=True)
                                await asyncio.sleep(retry_interval)
                                continue

                        if r.status_code != 200:
                            await r.aread()
                            if r.status_code == 500 and b"image input is not supported" in r.content:
                                print("[Local LLM] Vision not supported by server. Converting payload to Image Scan tags and retrying...", flush=True)
                                from utils.utils import scan_and_tag_image
                                new_msgs = []
                                for m in payload.get("messages", []):
                                    c = m.get("content")
                                    if isinstance(c, list):
                                        t_parts = []
                                        for item in c:
                                            if item.get("type") == "text":
                                                t_parts.append(item.get("text", ""))
                                            elif item.get("type") == "image_url":
                                                t_parts.append(scan_and_tag_image(item.get("image_url", {}).get("url")))
                                        m_copy = dict(m)
                                        m_copy["content"] = "\n\n".join(t_parts).strip()
                                        new_msgs.append(m_copy)
                                    else:
                                        new_msgs.append(m)
                                payload["messages"] = new_msgs
                                continue
                            return httpx.Response(status_code=r.status_code, headers=r.headers, content=r.content, request=r.request)

                        content_parts = []
                        async for line in r.aiter_lines():
                            _check_cancellation()

                            line = line.strip()
                            if not line or not line.startswith("data:"):
                                continue

                            data_str = line[5:].strip()
                            if data_str == "[DONE]":
                                break

                            try:
                                delta = json.loads(data_str).get("choices", [{}])[0].get("delta", {})
                                if content := delta.get("content"):
                                    content_parts.append(content)
                            except Exception:
                                pass

                        mock_data = {
                            "choices": [{"message": {"role": "assistant", "content": "".join(content_parts)}}],
                            "model": payload.get("model", ""),
                        }
                        return httpx.Response(status_code=200, headers=r.headers, content=json.dumps(mock_data).encode("utf-8"), request=r.request)

                response = await client.post(url, json=payload, headers=headers, timeout=timeout)
                if response.status_code == 503:
                    if time.time() - start_time < max_retry_time:
                        print(f"[Local LLM] Server is loading model (503). Retrying in {retry_interval}s...", flush=True)
                        await asyncio.sleep(retry_interval)
                        continue

                if response.status_code == 500 and "image input is not supported" in response.text:
                    print("[Local LLM] Vision not supported by server. Converting payload to Image Scan tags and retrying...", flush=True)
                    from utils.utils import scan_and_tag_image
                    new_msgs = []
                    for m in payload.get("messages", []):
                        c = m.get("content")
                        if isinstance(c, list):
                            t_parts = []
                            for item in c:
                                if item.get("type") == "text":
                                    t_parts.append(item.get("text", ""))
                                elif item.get("type") == "image_url":
                                    t_parts.append(scan_and_tag_image(item.get("image_url", {}).get("url")))
                            m_copy = dict(m)
                            m_copy["content"] = "\n\n".join(t_parts).strip()
                            new_msgs.append(m_copy)
                        else:
                            new_msgs.append(m)
                    payload["messages"] = new_msgs
                    continue

                return response

            except httpx.TimeoutException:
                raise
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                from runners import local_server

                server_status = local_server.check_local_server_status()
                if (server_status == "starting" or not server_status) and (time.time() - start_time < max_retry_time):
                    print(f"[Local LLM] Waiting for local server to complete startup. Retrying in {retry_interval}s...", flush=True)
                    await asyncio.sleep(retry_interval)
                    continue
                raise e

    async def _run_llm_summary_task(self, prompt: str, active_model: str, err_msg: str) -> str:
        """Helper to post summary/distillation requests to the local engine and parse reasoning blocks out of responses."""
        payload = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 512,
        }

        target_model = active_model if (active_model and active_model != "local-llm") else os.getenv("LOCAL_MODEL_NAME")
        if target_model:
            payload["model"] = target_model

        try:
            response = await self._post_llm_request(LOCAL_SERVER_URL, payload, get_local_server_headers(), timeout=60.0)
            if response.status_code == 200:
                raw_text = response.json()["choices"][0]["message"].get("content", "").strip()
                return THINK_TAG_RE.sub("", raw_text).strip()

            print(f"Local server error: {response.status_code} - {response.text}", flush=True)
        except Exception as e:
            # Query in-process engine if standalone server is unavailable
            try:
                from runners import engine_llm
                if engine_llm.is_loaded():
                    raw_text = await asyncio.to_thread(
                        engine_llm.generate_text,
                        [{"role": "user", "content": prompt}],
                        0.3,
                        512
                    )
                    if raw_text:
                        return THINK_TAG_RE.sub("", raw_text).strip()
            except Exception:
                pass
            print(f"Error in summary generation task: {e}", flush=True)

        return err_msg

    async def _generate_local_summary(self, text_to_summarize: str, active_model: str, prior_memories: list | None = None) -> str:
        from runners.program import get_active_user
        from core.program_config import get_program_name

        user_name = get_active_user().capitalize()
        try:
            program_name = get_program_name()
        except Exception:
            program_name = "Program"

        prompt_parts = [
            f"Summarize this new chat chapter for {user_name} and {program_name}.",
            "Keep only decisions, preferences, milestones, relationship changes, and project details.",
            "Write 2 concise sentences, under 300 characters. Do not repeat prior memories.\n",
        ]

        if prior_memories:
            prompt_parts.append("Excerpts of prior memory chapters:")
            prompt_parts.extend(prior_memories)
            prompt_parts.append("Ensure the new summary advances the timeline without repeating the prior memory chapters above.\n")

        prompt_parts.append(f"NEW CHAT HISTORY FOR INCREMENTAL SUMMARY (NEW CHAPTER):\n{text_to_summarize}\n")
        
        return await self._run_llm_summary_task(
            prompt="\n".join(prompt_parts),
            active_model=active_model,
            err_msg="Memory compaction summary generation failed due to connection error.",
        )

    async def _distill_epic_chronicle(self, text_to_distill: str, active_model: str) -> str:
        from runners.program import get_active_user
        from core.program_config import get_program_name

        user_name = get_active_user().capitalize()
        try:
            program_name = get_program_name()
        except Exception:
            program_name = "Program"

        prompt = (
            f"You are the memory chronicler for the ongoing interaction between {user_name} and {program_name}.\n"
            "The following text is the accumulated chronicle of earlier conversation chapters.\n"
            "Condense these events into a single cohesive general summary (2 concise paragraphs, max 600 characters).\n"
            "Retain major milestones, key user preferences, shared history, project decisions, and relationship dynamics.\n\n"
            f"ACCUMULATED CHRONICLE TO DISTILL:\n{text_to_distill}\n\n"
            "DISTILLED GENERAL SUMMARY:"
        )

        return await self._run_llm_summary_task(
            prompt=prompt,
            active_model=active_model,
            err_msg="Distillation failed due to connection error.",
        )

    async def _process_memory_pipeline(self, session_id: str, active_model: str, user_text: str, assistant_text: str):
            """Asynchronous post-turn worker handling Step 2 (Chapters) and Step 3 (Epic & RAG)."""
            meta = self._get_memory_meta(session_id)
            history = self.sessions_history.get(session_id, [])

            # Filter to user and assistant messages only
            dialogue_messages = [
                msg for msg in history 
                if msg.get("role") in ("user", "assistant")
            ]
            
            turn_count = len(dialogue_messages) // 2

            # Trigger summary every 12 full turns using trimmed history
            if turn_count > 0 and turn_count % 12 == 0:
                # Take the last 24 dialogue entries (12 full turns)
                recent_turns = dialogue_messages[-24:]
                
                # Format and truncate long messages if needed to fit context limits
                formatted_turns = "\n".join(
                    f"{msg.get('role', 'user').capitalize()}: {(msg.get('text') or msg.get('content') or '')[:1000]}" 
                    for msg in recent_turns
                )

                chapter_summary = await self._generate_local_summary(
                    text_to_summarize=formatted_turns,
                    active_model=active_model,
                    prior_memories=meta["recent_chapters"]
                )

                meta["recent_chapters"].append(chapter_summary)

                # STEP 3 TRIGGER: Every 5 chapters, distill Epic Chronicle & offload to Vector DB
                if len(meta["recent_chapters"]) >= 5:
                    all_chapters_text = "\n\n".join(meta["recent_chapters"])
                    
                    meta["epic_chronicle"] = await self._distill_epic_chronicle(
                        text_to_distill=all_chapters_text,
                        active_model=active_model
                    )

                    try:
                        from core.skills.vectorized_databank.databank import DataBankManager
                        db = DataBankManager()
                        for idx, ch in enumerate(meta["recent_chapters"]):
                            db.add_document(
                                text=ch,
                                source_type="chapter_memory",
                                metadata={"session_id": session_id, "chapter_index": idx}
                            )
                    except Exception as e:
                        print(f"[MEMORY PIPELINE] Error offloading chapters to Vector DB: {e}", flush=True)

                    meta["recent_chapters"].clear()

    def _load_temperature_setting(self, default_temp: float = 0.95) -> float:
        from variables.settings import VARIABLES_DIR

        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    return json.load(f).get("temperature", default_temp)
            except Exception as e:
                print(f"Error reading project settings in _execute_local_llm_loop: {e}")
        return default_temp

    def _sanitize_thinking_tags(self, text: str) -> str:
        cleaned = THINK_TAG_RE.sub("", text)
        return CHANNEL_TAG_RE.sub("", cleaned).strip()

    def _filter_story_mode_matches(self, matches: list, text: str, program_name: str) -> tuple[list, str]:
        from core.program_config import is_story_mode

        if not matches or not is_story_mode(program_name):
            return matches, text

        story_allowed = {
            "generate_local_image",
            "generate_program_portrait",
            "generate_general_image",
            "apply_comfy_workflow",
            "add_journal_entry",
        }
        disallowed = [m for m in matches if m.group(1) not in story_allowed]
        for m in disallowed:
            text = text.replace(m.group(0), "")

        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        filtered_matches = [m for m in matches if m.group(1) in story_allowed]
        return filtered_matches, text

    async def _execute_local_llm_loop(
        self,
        session_id: str,
        adapter: OsHistoryAdapter,
        model: str,
        inversion_directive: str,
        rag_context: str,
        new_message_text: str,
        invocation_id: str,
    ) -> tuple[str, list]:
        max_iterations = 5
        iteration = 0
        all_tool_calls = []
        final_response_text = ""
        target_model = model if (model and model != "local-llm") else os.getenv("LOCAL_MODEL_NAME")

        while iteration < max_iterations:
            iteration += 1

            # --- STAGE 1: LOCAL PREPROCESSING ---
            sys_instructions = self._get_system_instructions(
                session_id, inversion_directive, user_message=new_message_text
            )
            messages = adapter.get_openai_messages(sys_instructions, rag_context)
            messages = _trim_context_messages(messages, max_chars=26000)

            # --- STAGE 2: LOCAL PROCESSING PASS ---
            from core.program_config import is_story_mode

            temperature = self._load_temperature_setting()
            url = LOCAL_SERVER_URL
            headers = get_local_server_headers()

            story_active = is_story_mode()
            max_tokens_limit = 1024 if story_active else 512

            from variables.settings import is_thinking_enabled, DISABLED_THINKING
            from core.banned_words import get_logit_bias_dict
            from runners import engine_llm

            payload = {
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens_limit,
            }
            if not is_thinking_enabled() and isinstance(DISABLED_THINKING, dict):
                payload.update(DISABLED_THINKING)
            if target_model:
                payload["model"] = target_model

            logit_bias = get_logit_bias_dict(url)
            if logit_bias:
                payload["logit_bias"] = logit_bias

            bot_response_text = ""
            try:
                response = await self._post_llm_request(url, payload, headers, timeout=120.0, session_id=session_id)
                if response.status_code == 200:
                    bot_response_text = response.json()["choices"][0]["message"]["content"]
                else:
                    bot_response_text = f"Error: {response.text}"
                print(f"[DEBUG STATUS] {response.status_code}", flush=True)
            except Exception as e:
                # Query in-process engine if external server is offline
                try:
                    from runners import engine_llm
                    if engine_llm.is_loaded():
                        bot_response_text = await asyncio.to_thread(
                            engine_llm.generate_text,
                            messages,
                            temperature,
                            max_tokens_limit
                        )
                except Exception:
                    pass

                if not bot_response_text:
                    bot_response_text = f"Error: Could not connect to LLM ({e}). Ensure local llama-server is running."

            # --- STAGE 3: POST-PROCESSING (TOOLS & CLEANUP) ---
            bot_response_text = self._sanitize_thinking_tags(bot_response_text)

            matches = list(TOOL_TAG_RE.finditer(bot_response_text))
            matches, bot_response_text = self._filter_story_mode_matches(matches, bot_response_text, session_id)

            if matches:
                if session_id in cancelled_sessions:
                    raise asyncio.CancelledError("Session cancelled by user request.")

                loop = asyncio.get_running_loop()
                tasks = [
                    loop.run_in_executor(None, _execute_emulated_tool, m.group(1), m.group(2))
                    for m in matches
                ]
                raw_results = await asyncio.gather(*tasks)

                results = [
                    (_normalize_tool_name(m.group(1)), parsed_args["kwargs"], output)
                    for m, (parsed_args, output) in zip(matches, raw_results)
                ]

                tool_calls = []
                for idx, (t_name, t_args, t_output) in enumerate(results):
                    tool_calls.extend(_build_tool_calls_pair(t_name, t_args, t_output, len(all_tool_calls) + idx))
                all_tool_calls.extend(tool_calls)

                clean_text = TOOL_TAG_STRIP_RE.sub("", bot_response_text).strip()

                # Terminal / side-effect tools that do not require continued LLM turn
                terminal_tools = {
                    "add_journal_entry",
                    "add_quest",
                    "generate_local_image",
                    "generate_program_portrait",
                    "generate_general_image",
                    "generate_imagen",
                    "apply_comfy_workflow",
                    "generate_video_from_image",
                }
                if all(t_name in terminal_tools for t_name, _, _ in results):
                    final_response_text = clean_text
                    image_tools = {
                        "generate_local_image",
                        "generate_program_portrait",
                        "generate_general_image",
                        "generate_imagen",
                        "apply_comfy_workflow",
                    }
                    if any(t_name in image_tools for t_name, _, _ in results):
                        msg_lower = new_message_text.lower()
                        is_portrait_turn = any(k in msg_lower for k in ("portrait", "draw", "picture", "image", "photo", "selfie", "generate_program_portrait", "generate_local_image"))
                        if is_portrait_turn:
                            final_response_text = ""
                    adapter.append_assistant_message(final_response_text, all_tool_calls, invocation_id)
                    break

                adapter.append_assistant_message(clean_text, tool_calls, invocation_id, intermediate=True)
                adapter.append_tool_events(results, invocation_id)

                if clean_text:
                    final_response_text = clean_text

                continue
            else:
                clean_text = bot_response_text.strip()
                final_response_text = clean_text if clean_text else final_response_text

                adapter.append_assistant_message(final_response_text, all_tool_calls, invocation_id)
                break

        adapter.post_process_thoughts(invocation_id)
        final_response_text = self._ensure_images_are_embedded(final_response_text)
        if isinstance(session_id, str) and session_id.endswith("_voice"):
            final_response_text = strip_story(final_response_text)

        asyncio.create_task(
            self._process_memory_pipeline(
                session_id=session_id,
                active_model=target_model or "",
                user_text=new_message_text,
                assistant_text=final_response_text,
            )
        )

        return final_response_text, all_tool_calls

    @property
    def sessions_dir(self) -> str:
        active_program = get_active_program()
        path = os.path.join(project_root, "core", "programs", active_program, "sessions")
        os.makedirs(path, exist_ok=True)
        return path

    async def get_history(self, session_id: str) -> list:
        """Returns the message history for a given session."""
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        return self.sessions_history.get(session_id, [])
    
    async def run_async(self, session_id: str, new_message_text: str, image_data: str = None, image_mime: str = None, model: str = None, media_path: str = None, msg_id: str = None) -> tuple:
            """Main execution entry point for handling user input and running the LLM loop."""
            # Ensure session history is loaded
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)

            # Append user message to history
            with self._lock:
                user_msg = {
                    "id": msg_id or f"usr_{uuid.uuid4().hex}",
                    "role": "user",
                    "text": new_message_text,
                    "timestamp": time.time(),
                }
                if image_data:
                    user_msg["image_data"] = image_data
                    user_msg["image_mime"] = image_mime
                if media_path:
                    user_msg["media_path"] = media_path
                self.sessions_history[session_id].append(user_msg)
                self._save_session_to_disk(session_id)

            # Get adapter and run the generation loop
            adapter = self._get_session_adapter(session_id)
            inversion_directive = await self._get_inversion_directive(session_id)
            rag_context = "" # Fetch RAG context if applicable in your app
            
            return await self._execute_local_llm_loop(
                session_id=session_id,
                adapter=adapter,
                model=model,
                inversion_directive=inversion_directive,
                rag_context=rag_context,
                new_message_text=new_message_text,
                invocation_id=user_msg["id"]
            )

    async def edit_turn(self, session_id: str, msg_id: str, new_text: str = None, model: str = None) -> tuple:
        """Edits an existing turn, truncates subsequent history, and re-runs generation."""
        if session_id not in self.sessions_history:
            return "", []

        history = self.sessions_history[session_id]
        target_idx = -1
        
        # Find the index of the message being edited
        for idx, msg in enumerate(history):
            if msg.get("id") == msg_id:
                target_idx = idx
                break

        if target_idx == -1:
            return "", []

        with self._lock:
            # Update the message text if provided
            if new_text is not None:
                history[target_idx]["text"] = new_text
            
            # Truncate all history after this turn so the model can regenerate fresh responses
            self.sessions_history[session_id] = history[:target_idx + 1]
            self._save_session_to_disk(session_id)

        # Re-run the LLM loop from this point
        edited_msg = history[target_idx]["text"]
        adapter = self._get_session_adapter(session_id)
        inversion_directive = await self._get_inversion_directive(session_id)
        
        return await self._execute_local_llm_loop(
            session_id=session_id,
            adapter=adapter,
            model=model,
            inversion_directive=inversion_directive,
            rag_context="",
            new_message_text=edited_msg,
            invocation_id=msg_id
        )

    async def reset_session(self, session_id: str):
        """Clears the history for a session."""
        with self._lock:
            self.sessions_history[session_id] = []
            self._save_session_to_disk(session_id)

    async def delete_turn(self, session_id: str, msg_id: str) -> bool:
        """Deletes a specific turn/message from history by its ID."""
        return await self.delete_message_at(session_id, msg_id)

    async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
        """Deletes an image reference from session history and cleans up disk files."""
        if session_id not in self.sessions_history:
            return False

        deleted_file = self._delete_local_image(image_url)
        with self._lock:
            for msg in self.sessions_history[session_id]:
                if msg.get("image_url") == image_url or image_url in msg.get("text", ""):
                    msg.pop("image_url", None)
                    # Clean markdown image references if present
                    msg["text"] = msg["text"].replace(f"![]({image_url})", "").replace(image_url, "")
            self._save_session_to_disk(session_id)
            
        return deleted_file

    async def replace_image_in_session(self, session_id: str, old_image_url: str, new_image_url: str) -> bool:
        """Replaces an image reference in history."""
        if session_id not in self.sessions_history:
            return False

        with self._lock:
            for msg in self.sessions_history[session_id]:
                if msg.get("image_url") == old_image_url:
                    msg["image_url"] = new_image_url
                if old_image_url in msg.get("text", ""):
                    msg["text"] = msg["text"].replace(old_image_url, new_image_url)
            self._save_session_to_disk(session_id)
            return True

    async def replace_image_with_video_in_session(self, session_id: str, old_image_url: str, new_video_url: str) -> bool:
        """Swaps an image reference with a video reference in history."""
        if session_id not in self.sessions_history:
            return False

        with self._lock:
            for msg in self.sessions_history[session_id]:
                if msg.get("image_url") == old_image_url:
                    msg.pop("image_url", None)
                    msg["video_url"] = new_video_url
                if old_image_url in msg.get("text", ""):
                    msg["text"] = msg["text"].replace(old_image_url, new_video_url)
            self._save_session_to_disk(session_id)
            return True

    async def append_message_to_session(self, session_id: str, role: str, text: str) -> bool:
        """Appends a new raw message to the session history."""
        with self._lock:
            if session_id not in self.sessions_history:
                self.sessions_history[session_id] = []

            msg = {
                "id": f"msg_{uuid.uuid4().hex}",
                "role": role,
                "text": text,
                "timestamp": time.time(),
            }
            self.sessions_history[session_id].append(msg)
            self._save_session_to_disk(session_id)
            return True

    async def append_voice_call(self, session_id: str, transcript: str, timestamp: float = None, start_time: float = None) -> bool:
        """Appends a voice call transcript entry to the session history."""
        if session_id not in self.sessions_history:
            self.sessions_history[session_id] = []

        with self._lock:
            voice_msg = {
                "id": f"voice_{uuid.uuid4().hex}",
                "role": "voice-call",
                "text": transcript,
                "timestamp": timestamp or time.time(),
                "start_time": start_time or time.time()
            }
            self.sessions_history[session_id].append(voice_msg)
            self._save_session_to_disk(session_id)
            return True

    async def clone_history(self, src_id: str, dest_id: str, messages: list = None) -> bool:
        """Clones message history from a source session to a destination session."""
        with self._lock:
            if messages is not None:
                # If explicit messages are provided, clone those
                self.sessions_history[dest_id] = copy.deepcopy(messages)
            elif src_id in self.sessions_history:
                # Otherwise, duplicate from the existing source session
                self.sessions_history[dest_id] = copy.deepcopy(self.sessions_history[src_id])
            else:
                return False

            self._save_session_to_disk(dest_id)
            return True

    async def delete_system_memory(self, session_id: str, timestamp: float) -> bool:
        """Deletes a system memory node from history matching a specific timestamp."""
        if session_id not in self.sessions_history:
            return False

        history = self.sessions_history[session_id]
        initial_len = len(history)

        with self._lock:
            # Filter out system memory entries matching the timestamp (within a small tolerance)
            self.sessions_history[session_id] = [
                msg for msg in history 
                if not (msg.get("role") == "system-memory" and abs(msg.get("timestamp", 0) - timestamp) < 1.0)
            ]

            if len(self.sessions_history[session_id]) < initial_len:
                self._save_session_to_disk(session_id)
                return True

        return False

    async def update_message_text(self, session_id: str, msg_id: str, new_text: str) -> bool:
        """Finds a message by its ID and updates its text."""
        # Ensure session is loaded in memory
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
            
        if session_id not in self.sessions_history:
            print(f"[UPDATE MESSAGE] Session {session_id} not found in history.", flush=True)
            return False

        history = self.sessions_history[session_id]
        updated = False
        
        with self._lock:
            for msg in history:
                # Check exact match or if msg_id matches part of a compound ID
                current_id = msg.get("id", "")
                if current_id == msg_id or msg_id in current_id:
                    msg["text"] = new_text
                    updated = True
                    break
            
            if updated:
                self._save_session_to_disk(session_id)
                print(f"[UPDATE MESSAGE] Successfully updated message {msg_id}", flush=True)
                return True
                
        # Debugging helper: print available IDs if it fails to match
        print(f"[UPDATE MESSAGE] Failed to find message ID '{msg_id}'. Available IDs in session:", [m.get("id") for m in history], flush=True)
        return False

    async def delete_message_at(self, session_id: str, msg_id: str) -> bool:
        """Deletes a specific message by its ID from session history."""
        if session_id not in self.sessions_history:
            return False

        history = self.sessions_history[session_id]
        initial_len = len(history)
        
        with self._lock:
            # Filter out the message matching msg_id
            self.sessions_history[session_id] = [msg for msg in history if msg.get("id") != msg_id]
            
            if len(self.sessions_history[session_id]) < initial_len:
                self._save_session_to_disk(session_id)
                return True
                
        return False

    def _inversion_enabled(self) -> bool:
        return is_enabled(PROGRAMS_DIR, get_active_program())

    def update_inversion_state_with_mood(self, session_id: str, mood_name: str):
        if not self._inversion_enabled():
            return
        state = self.sessions_inversion_state.setdefault(session_id, new_state())
        update_state(state, mood_name)

    def get_inversion_state(self, session_id: str) -> dict:
        if not self._inversion_enabled():
            return new_state()
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        return copy.deepcopy(self.sessions_inversion_state.get(session_id, new_state()))

    async def _get_inversion_mode(self, session_id: str, history: list = None) -> str:
        if not self._inversion_enabled():
            return ""
        if session_id not in self.sessions_history:
            self._load_session_from_disk(session_id)
        state = self.sessions_inversion_state.setdefault(session_id, new_state())
        return state.get("active_inversion", "")

    async def _get_inversion_directive(self, session_id: str) -> str:
        winning_mode = await self._get_inversion_mode(session_id)
        return get_directive(PROGRAMS_DIR, get_active_program(), winning_mode) if winning_mode else ""

    def _delete_local_image(self, image_url: str) -> bool:
        local_path = _get_safe_local_path(image_url) if image_url else None
        if not local_path or not os.path.exists(local_path):
            return False

        try:
            os.remove(local_path)
            print(f"Deleted image file from disk: {local_path}")

            json_path = os.path.splitext(local_path)[0] + ".json"
            if os.path.exists(json_path):
                os.remove(json_path)
                print(f"Deleted program JSON file from disk: {json_path}")
            return True
        except Exception as e:
            print(f"Error cleaning up image assets for {image_url}: {e}")
            return False

    def _ensure_images_are_embedded(self, text: str) -> str:
        if not text:
            return text

        text = IMAGE_EMBED_RE.sub(r'!\1', text)
        return RAW_IMAGE_PATH_RE.sub(r'![Portrait](\1)', text)

    def _load_profile_json(self, active_prog: str) -> dict:
        json_path = os.path.join(PROGRAMS_DIR, active_prog, f"{active_prog}.json")
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _clean_transcript_text(self, text: str) -> str:
        cleaned = THINK_TAG_RE.sub("", text)
        cleaned = CHANNEL_TAG_RE.sub("", cleaned)
        cleaned = re.sub(r"\*.*?\*", "", cleaned)
        return re.sub(r" +", " ", cleaned).strip()

    def _extract_recent_turns(self, src_session_id: str, program_name: str, limit: int = 6) -> list[str]:
        history = self.sessions_history.get(src_session_id, [])
        if not history:
            safe_id = "".join(c for c in src_session_id if c.isalnum() or c in "-_")
            path = os.path.join(self.sessions_dir, f"{safe_id}.json")
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    history = data.get("messages", data) if isinstance(data, dict) else data
                except Exception:
                    pass

        turns = []
        for msg in history:
            if msg.get("role") != "voice-call":
                role = "User" if msg.get("role") == "user" else program_name
                if text := msg.get("text", "").strip():
                    turns.append((role, text))

        journal_lines = []
        for role, text in turns[-limit:]:
            if cleaned := self._clean_transcript_text(text):
                journal_lines.append(f"  {role}: {cleaned}")

        return journal_lines

    def _build_voice_prompt(self, session_id: str, program_name: str) -> str:
        from core.program_config import compile_instructions_from_json

        active_prog = get_active_program()
        profile_data = self._load_profile_json(active_prog)

        if profile_data:
            profile_data.setdefault("operation", {})
            profile_data["operation"].update({
                "response_directive": "Super short and succinct messages. Conversational. No narration.",
                "example_message": "",
                "scenario": f"{program_name} is on a live voice call with the user. They are speaking to each other over the phone in real-time.",
            })
            instructions = compile_instructions_from_json(profile_data)
        else:
            instructions = (
                f"# IDENTITY: {program_name}\n\n"
                "## SCENARIO / CONTEXT\n"
                f"{program_name} is on a live voice call with the user. They are speaking to each other over the phone in real-time.\n\n"
                "## RESPONSE DIRECTIVES (MANDATORY GUIDELINES)\n"
                "Super short and succinct messages. Conversational. No narration."
            )

        journal_lines = self._extract_recent_turns(session_id[:-6], program_name)
        if journal_lines:
            instructions += "\n\n# RECALLED JOURNALS / MEMORIES\n- Recent conversation context:\n" + "\n".join(journal_lines)

        return instructions

    def _inject_system_memories(self, instructions: str, session_id: str) -> str:
        meta = self._get_memory_meta(session_id)
        epic = meta.get("epic_chronicle", "")
        chapters = meta.get("recent_chapters", [])

        # Enforce the limit of only the 2 most recent chapters
        recent_two_chapters = chapters[-2:] if chapters else []

        if epic:
            instructions += f"\n\n# CORE CONVERSATION CHRONICLE\n{epic.strip()}\n"

        if recent_two_chapters:
            formatted_chapters = "\n".join(f"- {ch.strip()}" for ch in recent_two_chapters)
            instructions += f"\n\n# RECENT CONVERSATION CHAPTERS\n{formatted_chapters}\n"

        return instructions

    def _get_system_instructions(self, session_id: str, inversion_directive: str = None, user_message: str = None) -> str:
        from core.program_config import get_compiled_instructions, get_program_name, is_story_mode, set_inversion_directive

        try:
            program_name = get_program_name()
        except Exception:
            program_name = "Program"

        is_voice = isinstance(session_id, str) and session_id.endswith("_voice")

        if is_voice:
            instructions = self._build_voice_prompt(session_id, program_name)
        else:
            if inversion_directive is not None:
                set_inversion_directive(inversion_directive)

            instructions = get_compiled_instructions()

            if "CONCISENESS" not in instructions and "brief, succinct, and natural" not in instructions:
                instructions += (
                    "\n\n# STYLE\n"
                    "Be brief and natural. No monologues, lectures, or forced questions. Ask questions only if contextually natural.\n"
                )

        instructions += (
            "\n\n# CONTENT\n"
            "Anarchist-communist ethics. Explicit/NSFW content is permitted.\n"
        )

        if is_voice:
            print(f"\n[VOICE CALL DEBUG] Active Voice Prompt:\n{instructions}\n[VOICE CALL DEBUG] END PROMPT\n", flush=True)

        return instructions

class OpenSourceRunner(BaseProgramRunner):
        """Operates independently of cloud infrastructure, reading character settings
        directly from the program's JSON profile.
        """

        def __init__(self, app_name="Sanctuary"):
            super().__init__(app_name)
            self.sessions_history = {}
            self.sessions_inversion_state = {}
            self.sessions_memory_state = {}
            self._lock = threading.RLock()

        async def generate_impersonation(
            self, prompt: str, system_instruction: str, model: str = None, temperature: float = 0.7
        ) -> str:
            url = LOCAL_SERVER_URL
            headers = get_local_server_headers()

            target_model = model if (model and model != "local-llm") else os.getenv("LOCAL_MODEL_NAME")

            from core.banned_words import get_logit_bias_dict

            payload = {
                "messages": [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": prompt},
                ],
                "temperature": temperature,
                "max_tokens": 512,
            }

            if target_model:
                payload["model"] = target_model

            logit_bias = get_logit_bias_dict(url)
            if logit_bias:
                payload["logit_bias"] = logit_bias

            try:
                r = await self._post_llm_request(url, payload, headers, timeout=60.0)
                if r.status_code == 200:
                    content = r.json()["choices"][0]["message"].get("content", "").strip()
                    return THINK_TAG_RE.sub("", content).strip()
            except Exception as e:
                print(f"[Impersonate] Error during impersonation request: {e}", flush=True)
                try:
                    from runners import engine_llm
                    if engine_llm.is_loaded():
                        messages = [
                            {"role": "system", "content": system_instruction},
                            {"role": "user", "content": prompt},
                        ]
                        raw_text = await asyncio.to_thread(
                            engine_llm.generate_text,
                            messages,
                            temperature,
                            512
                        )
                        if raw_text:
                            return THINK_TAG_RE.sub("", raw_text).strip()
                except Exception:
                    pass
                raise

            return ""

        def _get_session_path(self, session_id: str) -> str:
            safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
            return os.path.join(self.sessions_dir, f"{safe_id}.json")

        def _save_session_to_disk(self, session_id: str):
            with self._lock:
                try:
                    memory_meta = self._get_memory_meta(session_id)
                    memory_meta.pop("unsummarized_buffer", None)

                    # Ensure default factory or imported default function is used
                    inversion_state = self.sessions_inversion_state.get(
                        session_id, 
                        self.new_state() if hasattr(self, "new_state") else {}
                    )

                    data = {
                        "messages": self.sessions_history.get(session_id, []),
                        "inversion_state": inversion_state,
                        "memory_state": memory_meta,
                    }
                    with open(self._get_session_path(session_id), "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error saving OS session {session_id} to disk: {e}")

        def _load_session_from_disk(self, session_id: str):
            path = self._get_session_path(session_id)
            if not os.path.exists(path):
                return

            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    
                self.sessions_history[session_id] = data.get("messages", [])
                self.sessions_inversion_state[session_id] = data.get("inversion_state", new_state())
                
                memory_state = data.get("memory_state", {})
                # Strip legacy unsummarized_buffer if loading an older default.json
                memory_state.pop("unsummarized_buffer", None)
                memory_state.setdefault("recent_chapters", [])
                memory_state.setdefault("epic_chronicle", "")
                
                self.sessions_memory_state[session_id] = memory_state
            except Exception as e:
                print(f"Error loading session {session_id} from disk: {e}")

        def _ensure_first_message(self, session_id: str):
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)
            history = self.sessions_history.setdefault(session_id, [])

            has_first_mes = any(
                msg.get("id", "").startswith("first_mes")
                for msg in history
            ) or (bool(history) and history[0].get("role") == "program")

            if not has_first_mes:
                try:
                    from core.program_config import get_program_greeting, replace_placeholders

                    if greeting := replace_placeholders(get_program_greeting()).strip():
                        starting_msg = {
                            "id": f"first_mes_{uuid.uuid4().hex}",
                            "role": "program",
                            "text": greeting,
                            "tool_calls": [],
                            "inversion_active": "",
                            "mood": None,
                            "timestamp": time.time(),
                        }
                        history.insert(0, starting_msg)
                        self._save_session_to_disk(session_id)
                except Exception as e:
                    print(f"[runner] Could not seed first_mes: {e}")

            updated = False
            for idx, msg in enumerate(history):
                if not msg.get("id"):
                    role = msg.get("role", "msg")
                    prefix = "first_mes" if role == "program" and idx == 0 else role
                    msg["id"] = f"{prefix}_{uuid.uuid4().hex}"
                    updated = True

            if updated:
                self._save_session_to_disk(session_id)

        def _consolidate_tools(self, tool_calls: list) -> list:
            if not tool_calls:
                return []

            pairs = {}
            for tc in tool_calls:
                cid = tc.get("id", "")
                if cid not in pairs:
                    pairs[cid] = {"id": cid}

                if tc.get("type") == "call":
                    pairs[cid]["name"] = tc.get("name", "")
                    pairs[cid]["args"] = tc.get("args", {})
                elif tc.get("type") == "response":
                    pairs[cid]["result"] = tc.get("response", "")

            return [p for p in pairs.values() if p.get("name")]

        def _extract_media_items(self, text: str, img_url: str, tool_calls: list) -> list:
            media = []
            seen_urls = set()

            def _add_media(url: str):
                if url and url not in seen_urls and not url.startswith("data:"):
                    seen_urls.add(url)
                    media.append({"url": url, "type": "video" if url.lower().endswith(".mp4") else "image"})

            for match in re.finditer(r"!\[([^\]]*)\]\(([^)]+)\)", text):
                _add_media(match.group(2))

            _add_media(img_url)

            for tc in tool_calls or []:
                if tc.get("type") == "response" and (resp := tc.get("response")):
                    for match in re.finditer(r"!\[([^\]]*)\]\(([^)]+)\)", resp):
                        _add_media(match.group(2))

            return media

        def _normalize_message(self, msg: dict) -> dict:
            text = msg.get("text", "") or ""
            tool_calls = msg.get("tool_calls", [])

            media = self._extract_media_items(text, msg.get("image_url"), tool_calls)
            clean_text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text).strip()
            clean_text = clean_text.replace("(Generation stopped)", "").strip()
            tool_summary = self._consolidate_tools(tool_calls)

            image_tools = {
                "generate_local_image",
                "generate_program_portrait",
                "generate_general_image",
            }
            image_prompt = next(
                (ts.get("args", {}).get("prompt") for ts in tool_summary if ts.get("name") in image_tools),
                None,
            )

            if image_prompt:
                for m in media:
                    m.setdefault("prompt", image_prompt)

            role = msg.get("role", "user")
            return {
                "id": msg.get("id", ""),
                "role": role,
                "text": clean_text,
                "media": media,
                "tool_summary": tool_summary,
                "tool_calls": tool_calls,
                "timestamp": msg.get("timestamp"),
                "mood": msg.get("mood"),
                "inversion_active": msg.get("inversion_active", ""),
                "editable": role in ("user", "program"),
                "deletable": True,
            }

        async def get_history(self, session_id: str):
            from pathlib import Path
            project_root = Path(__file__).resolve().parent.parent
            with self._lock:
                self._load_session_from_disk(session_id)
                self._ensure_first_message(session_id)

                raw_history = self.sessions_history.get(session_id, [])
                updated_any = False

                for msg in raw_history:
                    if msg.get("role") == "program" and "mood" not in msg:
                        msg["mood"] = {
                            "name": "calm",
                            "color": "#85b9eb",
                            "glow": "rgba(133, 185, 235, 0.9)",
                            "speed": "2.00s",
                            "intensity": 0.0,
                        }
                        updated_any = True

                if updated_any:
                    self._save_session_to_disk(session_id)

                hidden_prefixes = ("tool_", "port_", "quest_", "sys_", "itm_")
                chat_history = []

                for msg in raw_history:
                    if msg.get("role") == "system-memory" or msg.get("id", "").startswith(hidden_prefixes):
                        continue
                    if msg.get("role") == "program":
                        if not (msg.get("text") or "").strip() and not msg.get("tool_calls"):
                            continue
                    chat_history.append(self._normalize_message(msg))

                return chat_history

        async def run_async(
            self,
            session_id: str,
            new_message_text: str,
            image_data: str = None,
            image_mime: str = None,
            model: str = None,
            media_path: str = None,
            msg_id: str = None,
        ) -> tuple:
            with self._lock:
                self._load_session_from_disk(session_id)
                self.sessions_history.setdefault(session_id, [])

                try:
                    return await self._run_async_internal(
                        session_id=session_id,
                        new_message_text=new_message_text,
                        image_data=image_data,
                        image_mime=image_mime,
                        model=model,
                        media_path=media_path,
                        msg_id=msg_id,
                    )
                finally:
                    self._save_session_to_disk(session_id)

        async def _run_async_internal(
            self,
            session_id: str,
            new_message_text: str,
            image_data: str = None,
            image_mime: str = None,
            model: str = None,
            media_path: str = None,
            msg_id: str = None,
        ) -> tuple:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)

            self._ensure_first_message(session_id)

            file_path_resolved = None
            if media_path and media_path.startswith("/images/"):
                try:
                    rel_path = media_path[len("/images/") :]
                    local_file_path = os.path.normpath(
                        os.path.join(project_root, "core", "programs", get_active_program(), rel_path)
                    )
                    if os.path.exists(local_file_path):
                        file_path_resolved = local_file_path
                except Exception as e:
                    print(f"Error handling media_path in OpenSourceRunner: {e}")

            if not msg_id:
                if new_message_text.startswith("[SYSTEM: User has completed"):
                    prefix = "quest_"
                elif any(
                    k in new_message_text
                    for k in (
                        "Generate a portrait of yourself",
                        "[GENERATE_IMAGE:",
                        "generate_program_portrait",
                    )
                ):
                    prefix = "port_"
                elif new_message_text.startswith("[Tool Response from"):
                    prefix = "tool_"
                elif (media_path or image_data) and not new_message_text.strip():
                    prefix = "img_"
                else:
                    prefix = "usr_"
                user_msg_id = f"{prefix}{uuid.uuid4().hex}"
            else:
                user_msg_id = msg_id

            user_msg = {
                "id": user_msg_id,
                "role": "user",
                "text": new_message_text,
                "image_url": media_path
                if media_path
                else (f"data:{image_mime};base64,{image_data}" if image_data else None),
                "timestamp": time.time(),
            }
            self.sessions_history[session_id].append(user_msg)

            history = self.sessions_history.get(session_id, [])
            vector_query = _build_vector_query(history)
            rag_context, query_vector_embedding = _get_databank_contexts(vector_query)
            inversion_directive = await self._get_inversion_directive(session_id)

            adapter = OsHistoryAdapter(
                self, session_id, file_path_resolved, image_data, image_mime, query_vector=query_vector_embedding
            )

            res = await self._execute_local_llm_loop(
                session_id=session_id,
                adapter=adapter,
                model=model,
                inversion_directive=inversion_directive,
                rag_context=rag_context,
                new_message_text=new_message_text,
                invocation_id="",
            )

            bot_response_text, tool_calls = res
            program_msg_id = None

            history = self.sessions_history.get(session_id, [])
            user_idx = next((i for i, m in enumerate(history) if m.get("id") == user_msg_id), -1)

            hidden_prefixes = ("tool_", "port_", "quest_", "sys_", "itm_")
            if user_idx != -1:
                for msg in reversed(history[user_idx + 1 :]):
                    if msg.get("role") == "program" and not msg.get("id", "").startswith(hidden_prefixes):
                        program_msg_id = msg.get("id")
                        break

            if not program_msg_id:
                program_msg_id = next(
                    (m.get("id") for m in reversed(history) if m.get("role") == "program" and not m.get("id", "").startswith(hidden_prefixes)), None
                )

            return bot_response_text, tool_calls, user_msg_id, program_msg_id

        async def edit_turn(
            self,
            session_id: str,
            msg_id: str,
            new_text: str = None,
            model: str = None,
            force_offload: bool = False,
        ) -> tuple:
            if session_id not in self.sessions_history:
                self._load_session_from_disk(session_id)

            history = self.sessions_history.get(session_id)
            if not history:
                raise ValueError("Session not found")

            user_idx = next((i for i, ev in enumerate(history) if ev.get("id") == msg_id), -1)
            if user_idx == -1:
                raise ValueError("Message not found")

            orig_msg = history[user_idx]
            img_data, img_mime, media_path = None, None, None

            if url_str := orig_msg.get("image_url"):
                if url_str.startswith("data:") and ";base64," in url_str:
                    parts = url_str.split(";base64,")
                    img_mime = parts[0].split("data:")[-1]
                    img_data = parts[1]
                else:
                    media_path = url_str

            self.sessions_history[session_id] = history[:user_idx]
            self._save_session_to_disk(session_id)

            new_input = new_text if new_text is not None else orig_msg.get("text", "")
            res = await self.run_async(
                session_id,
                new_input,
                image_data=img_data,
                image_mime=img_mime,
                model=model,
                media_path=media_path,
                msg_id=msg_id,
            )

            self._save_session_to_disk(session_id)
            return res

        async def reset_session(self, session_id: str):
            with self._lock:
                if session_id in self.sessions_history:
                    del self.sessions_history[session_id]
                if session_id in self.sessions_memory_state:
                    del self.sessions_memory_state[session_id]

                path = self._get_session_path(session_id)
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception as e:
                        print(f"Error deleting OS session file {path}: {e}")

                try:
                    from core.skills.vectorized_databank.databank import DataBankManager

                    DataBankManager().delete_chat_history(session_id)
                except Exception as e:
                    print(f"Error cleaning up databank history on session reset: {e}")

                from core import program_config

                program_config.set_inversion_directive("")

        async def delete_system_memory(self, session_id: str, timestamp: float) -> bool:
            with self._lock:
                if session_id not in self.sessions_history:
                    self._load_session_from_disk(session_id)

                marked_compacted = False
                for msg in self.sessions_history.get(session_id, []):
                    if msg.get("role") == "system-memory" and abs(msg.get("timestamp", 0) - timestamp) < 1.0:
                        msg["compacted"] = True
                        marked_compacted = True
                        print("[MEMORY DELETE] Marked OS message as compacted.", flush=True)

                if marked_compacted:
                    self._save_session_to_disk(session_id)

                return marked_compacted

        async def delete_turn(self, session_id: str, msg_id: str) -> bool:
            with self._lock:
                if session_id not in self.sessions_history:
                    self._load_session_from_disk(session_id)

                history = self.sessions_history.get(session_id)
                if history is None:
                    raise ValueError("Session not found")

                user_idx = next((i for i, ev in enumerate(history) if ev.get("id") == msg_id), -1)
                if user_idx == -1:
                    raise ValueError("User message not found")

                next_user_idx = next(
                    (i for i in range(user_idx + 1, len(history)) if is_real_user_msg(history[i])), -1
                )

                self.sessions_history[session_id] = history[:user_idx] + (
                    history[next_user_idx:] if next_user_idx != -1 else []
                )
                self._save_session_to_disk(session_id)
                return True

        async def delete_message_at(self, session_id: str, msg_id: str) -> bool:
            with self._lock:
                if session_id not in self.sessions_history:
                    self._load_session_from_disk(session_id)

                history = self.sessions_history.get(session_id, [])
                for i, msg in enumerate(history):
                    if msg.get("id") == msg_id:
                        del history[i]
                        self._save_session_to_disk(session_id)
                        return True
                return False

        async def delete_image_from_session(self, session_id: str, image_url: str) -> bool:
            with self._lock:
                if session_id not in self.sessions_history:
                    self._load_session_from_disk(session_id)

                history = self.sessions_history.get(session_id)
                if history is None:
                    return self._delete_local_image(image_url)

                modified = False
                indices_to_delete = set()
                pattern = r"!\[[^\]]*\]\(" + re.escape(image_url) + r"\)"

                for i, msg in enumerate(history):
                    has_image = False

                    if msg.get("text") and image_url in msg["text"]:
                        has_image = True
                        remaining_text = re.sub(pattern, "", msg["text"]).strip()
                        if not re.sub(r"^[:\s\-\*]+|[:\s\-\*]+$", "", remaining_text):
                            indices_to_delete.add(i)
                        else:
                            msg["text"] = remaining_text
                        modified = True

                    if msg.get("image_url") == image_url:
                        has_image = True
                        msg["image_url"] = None
                        if not (msg.get("text") or "").strip():
                            indices_to_delete.add(i)
                        modified = True

                    if tool_calls := msg.get("tool_calls"):
                        cleared_call_ids = set()
                        for tc in tool_calls:
                            if tc.get("type") == "response" and tc.get("response") and image_url in tc["response"]:
                                has_image = True
                                tc["response"] = re.sub(pattern, "", tc["response"]).strip()
                                if not tc["response"]:
                                    cleared_call_ids.add(tc.get("id"))
                                modified = True

                        if cleared_call_ids:
                            msg["tool_calls"] = [
                                tc
                                for tc in tool_calls
                                if not (
                                    tc.get("id") in cleared_call_ids
                                    and (tc.get("type") == "call" or not (tc.get("response") or "").strip())
                                )
                            ]

                        if not any(
                            tc.get("response", "").strip() for tc in msg["tool_calls"] if tc.get("type") == "response"
                        ):
                            if not (msg.get("text") or "").strip():
                                indices_to_delete.add(i)

                    if has_image and i > 0:
                        prev_msg = history[i - 1]
                        if prev_msg.get("role") == "user" and "Generate a portrait of yourself" in (
                            prev_msg.get("text") or ""
                        ):
                            indices_to_delete.add(i - 1)

                for idx in sorted(indices_to_delete, reverse=True):
                    if 0 <= idx < len(history):
                        del history[idx]
                        modified = True

                file_deleted = self._delete_local_image(image_url)
                if modified:
                    self._save_session_to_disk(session_id)

                return modified or file_deleted

        async def replace_image_in_session(
            self, session_id: str, old_image_url: str, new_image_url: str, new_prompt: str = None
        ) -> bool:
            with self._lock:
                if session_id not in self.sessions_history:
                    self._load_session_from_disk(session_id)

                history = self.sessions_history.get(session_id)
                if history is None:
                    return False

                modified = False
                for msg in history:
                    if msg.get("text") and old_image_url in msg["text"]:
                        msg["text"] = msg["text"].replace(old_image_url, new_image_url)
                        modified = True

                    if msg.get("image_url") == old_image_url:
                        msg["image_url"] = new_image_url
                        modified = True

                    if tool_calls := msg.get("tool_calls"):
                        call_ids_to_update = set()
                        for tc in tool_calls:
                            if tc.get("type") == "response" and tc.get("response") and old_image_url in tc["response"]:
                                tc["response"] = tc["response"].replace(old_image_url, new_image_url)
                                modified = True
                                if tc.get("id"):
                                    call_ids_to_update.add(tc["id"])

                        if new_prompt and call_ids_to_update:
                            for tc in tool_calls:
                                if (
                                    tc.get("type") == "call"
                                    and tc.get("id") in call_ids_to_update
                                    and isinstance(tc.get("args"), dict)
                                ):
                                    tc["args"]["prompt"] = new_prompt
                                    modified = True

                if modified:
                    self._save_session_to_disk(session_id)

                return modified