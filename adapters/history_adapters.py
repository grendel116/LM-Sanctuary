import asyncio
import base64
import json
import mimetypes
import os
import time
import uuid
from abc import ABC, abstractmethod
from pathlib import Path

import tools.tools as tools
from utils.utils import (
    _MAIN_DIRECTIVE_PROMPT,
    _STORY_MODE_DIRECTIVE_PROMPT,
    _merge_consecutive_messages,
)


def _get_base64_image_url(image_source: str | None) -> str | None:
    """Resolves an image file path or URL into a base64 data URL."""
    if not image_source:
        return None

    src_str = str(image_source)
    if src_str.startswith("data:"):
        return src_str

    project_root = Path(__file__).resolve().parent.parent

    if src_str.startswith("/images/"):
        rel_path = src_str.removeprefix("/images/")
        from runners.program import get_active_program
        active_program = get_active_program()
        local_path = project_root / "core" / "programs" / active_program / rel_path
    else:
        local_path = Path(src_str)
        if not local_path.is_absolute():
            local_path = project_root / local_path

    local_path = local_path.resolve()

    if not local_path.is_file():
        print(f"[IMAGE RESOLVE] File not found: {local_path}")
        return None

    try:
        mime_type, _ = mimetypes.guess_type(local_path)
        mime_type = mime_type or "image/png"
        b64_data = base64.b64encode(local_path.read_bytes()).decode("utf-8")
        return f"data:{mime_type};base64,{b64_data}"
    except Exception as e:
        print(f"[IMAGE RESOLVE ERROR] Failed to encode {local_path}: {e}")
        return None


class LocalHistoryAdapter(ABC):
    def __init__(self, runner_obj, session_id: str):
        self.runner_obj = runner_obj
        self.session_id = session_id

    @abstractmethod
    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str | None = None) -> list[dict]:
        pass

    @abstractmethod
    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str):
        pass

    @abstractmethod
    def append_tool_events(self, results: list, invocation_id: str):
        pass

    @abstractmethod
    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        pass

    @abstractmethod
    def post_process_thoughts(self, invocation_id: str):
        pass

    @abstractmethod
    def save(self):
        pass

    async def compact_history(self, active_model: str, force: bool = False):
        """Optional hook for history compaction."""
        pass


class OsHistoryAdapter(LocalHistoryAdapter):
    def __init__(self, runner_obj, session_id: str, file_path_resolved, image_data, image_mime, query_vector=None):
        super().__init__(runner_obj, session_id)
        self.file_path_resolved = file_path_resolved
        self.image_data = image_data
        self.image_mime = image_mime
        self.query_vector = query_vector
        self.initial_history_len = len(runner_obj.sessions_history.get(session_id, []))
        self._calculate_context_threshold()

    def _calculate_context_threshold(self):
        """Derives local character threshold limit from environment configuration."""
        local_context = os.getenv("LOCAL_CONTEXT")
        if local_context and local_context.isdigit():
            self.max_context_chars = int(int(local_context) * 0.30 * 4)
        else:
            self.max_context_chars = int(os.getenv("LOCAL_CONTEXT_THRESHOLD_CHARS", "6000"))

    async def compact_history(self, active_model: str, force: bool = False):
        """Compacts older history turns into vectorized memory chunks."""
        history = self.runner_obj.sessions_history.get(self.session_id, [])
        uncompacted_length = sum(len(msg.get("text") or "") for msg in history if not msg.get("compacted"))

        if not force and uncompacted_length <= self.max_context_chars:
            return

        user_msg_indices = [idx for idx, msg in enumerate(history) if msg.get("role") == "user" and not msg.get("compacted")]
        keep_turns = 2 if force else 4

        if len(user_msg_indices) <= keep_turns:
            return

        cutoff_idx = user_msg_indices[-keep_turns]
        historical_turns = history[:cutoff_idx]
        uncompacted_turns = [msg for msg in historical_turns if not msg.get("compacted")]

        summary_lines = [
            f"{'User' if msg.get('role') == 'user' else 'Program'}: {msg.get('text', '').strip()}"
            for msg in uncompacted_turns
            if msg.get("role") in ("user", "program") and msg.get("text", "").strip()
        ]

        text_to_summarize = "\n".join(summary_lines)
        if not text_to_summarize:
            return

        from core.skills.vectorized_databank.databank import DataBankManager
        prior_texts = []
        try:
            db = DataBankManager()
            priors = db.get_prior_chat_histories(self.session_id, limit=2)
            prior_texts = [f"--- PRIOR MEMORY ARCHIVE ({p['name']}) ---\n{p['text']}" for p in priors]
        except Exception as e:
            print(f"[COMPACTION OS] Error fetching prior chat histories: {e}", flush=True)

        summary = await self.runner_obj._generate_local_summary(text_to_summarize, active_model, prior_memories=prior_texts)
        if summary.startswith("Memory compaction summary generation failed"):
            summary = (
                "Older conversation turns were pruned to free up local memory. "
                "The full transcript of these turns has been archived in the vector database."
            )

        try:
            db = DataBankManager()
            db.ingest_text(
                text=summary,
                name=f"chat_history_archive_{self.session_id}_{int(time.time())}",
                source_type="chat_history",
            )
            db.prune_chat_histories(self.session_id, keep_limit=3)

            priors = db.get_prior_chat_histories(self.session_id, limit=3)
            if len(priors) == 3 and len(priors[-1].get("text", "")) > 1200:
                asyncio.create_task(self._background_distill(priors[-1], active_model, db))
        except Exception as e:
            print(f"[COMPACTION OS ERROR] Failed to ingest: {e}", flush=True)

        summary_msg = {
            "id": f"sys_{uuid.uuid4().hex}",
            "role": "system-memory",
            "text": f"[System Memory of older conversation turns]:\n{summary}",
            "timestamp": time.time(),
        }

        with self.runner_obj._lock:
            live_history = self.runner_obj.sessions_history.get(self.session_id, [])
            last_id = historical_turns[-1].get("id") if historical_turns else None

            if last_id:
                idx = next((i for i, msg in enumerate(live_history) if msg.get("id") == last_id), -1)
                if idx != -1:
                    for msg in live_history[: idx + 1]:
                        msg["compacted"] = True
                    live_history.insert(idx + 1, summary_msg)

            self.runner_obj._save_session_to_disk(self.session_id)

    async def _background_distill(self, oldest_doc: dict, active_model: str, db):
        try:
            chronicle = await self.runner_obj._distill_epic_chronicle(oldest_doc["text"], active_model)
            if chronicle and not chronicle.startswith("Distillation failed"):
                db.update_memory_document(oldest_doc["name"], chronicle)
        except Exception as e:
            print(f"[COMPACTION OS ERROR] Background distillation failed: {e}", flush=True)

    def get_openai_messages(self, sys_inst: str, rag_context: str, memory_context: str | None = None) -> list[dict]:
        from core.program_config import is_story_mode, replace_placeholders
        from core.lorebook import get_active_lore
        from runners.program import get_active_program
        from variables.settings import PROGRAMS_DIR

        history = self.runner_obj.sessions_history.get(self.session_id, [])
        filtered_history = [
            msg for msg in history
            if msg.get("role") not in ("voice-call", "system-memory") and not msg.get("compacted")
        ]

        if not filtered_history:
            return [{"role": "system", "content": sys_inst}]

        latest_img_idx = -1
        has_new_image = bool((self.image_data and self.image_mime) or self.file_path_resolved)

        for idx in range(len(filtered_history) - 1, -1, -1):
            msg = filtered_history[idx]
            if msg.get("role") == "user":
                if msg.get("id", "").startswith("tool_") or msg.get("text", "").startswith("[Tool Response from"):
                    continue
                if has_new_image or msg.get("image_url"):
                    latest_img_idx = idx
                break

        raw_messages = []
        for idx, msg in enumerate(filtered_history):
            role = "assistant" if msg["role"] == "program" else "user"
            content_text = replace_placeholders(msg.get("text") or "")

            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    if tc.get("type") == "call":
                        args_list = [
                            f'{k}="{v.replace('"', '\\"')}"' if isinstance(v, str) else f"{k}={v}"
                            for k, v in tc.get("args", {}).items()
                        ]
                        content_text += f"\n[{tc.get('name')}({', '.join(args_list)})]"

            if idx == latest_img_idx:
                img_src = (
                    f"data:{self.image_mime};base64,{self.image_data}"
                    if self.image_data and self.image_mime
                    else self.file_path_resolved or msg.get("image_url")
                )
                from utils.utils import scan_and_tag_image, extract_uploaded_file_content
                scan_info = scan_and_tag_image(img_src)
                doc_info = extract_uploaded_file_content(self.file_path_resolved) if self.file_path_resolved else ""

                extra_parts = [p for p in (doc_info, scan_info) if p]
                if extra_parts:
                    content_text = f"{content_text}\n\n" + "\n\n".join(extra_parts)

                raw_messages.append({"role": role, "content": content_text.strip()})
                continue

            if msg.get("image_url"):
                from utils.utils import scan_and_tag_image
                scan_info = scan_and_tag_image(msg.get("image_url"))
                content_text = f"{content_text}\n\n{scan_info}".strip()
            raw_messages.append({"role": role, "content": content_text})

        directive = _STORY_MODE_DIRECTIVE_PROMPT if is_story_mode() else _MAIN_DIRECTIVE_PROMPT
        if not tools.current_use_imagen.get():
            directive = "\n".join(line for line in directive.split("\n") if "generate_imagen" not in line)

        system_content = f"{sys_inst}{directive}"
        active_prog = get_active_program()

        try:
            lore_before, lore_after = get_active_lore(active_prog, filtered_history)
            if lore_before:
                system_content = f"[WORLD INFO]\n{'\n\n'.join(lore_before)}\n[END WORLD INFO]\n\n" + system_content
            if lore_after:
                system_content += f"\n\n[WORLD INFO]\n{'\n\n'.join(lore_after)}\n[END WORLD INFO]"
        except Exception as le:
            print(f"[lorebook] Injection error: {le}")

        context_parts = []
        for msg in history:
            if msg.get("role") == "system-memory" and msg.get("text", "").strip():
                clean_mem = msg["text"].replace("[System Memory of older conversation turns]:", "").strip()
                context_parts.append(f"<conversation_memory>\n{clean_mem}\n</conversation_memory>")

        last_user_msg = next(
            (
                m.get("text", "") for m in reversed(filtered_history)
                if m.get("role") == "user"
                and not m.get("id", "").startswith("tool_")
                and not m.get("text", "").startswith("[Tool Response from")
            ),
            "",
        )

        if last_user_msg:
            try:
                from core.journals import match_journals
                matched = match_journals(last_user_msg, active_prog)
                if matched:
                    journals_text = "\n".join(f"- {replace_placeholders(e['content'])}" for e in matched)
                    context_parts.append(f"<recalled_journals>\n{journals_text}\n</recalled_journals>")
            except Exception as je:
                print(f"Error matching journals: {je}")

        if rag_context:
            context_parts.append(f"<knowledge_base>\n{rag_context}\n</knowledge_base>")
        if memory_context:
            context_parts.append(f"<archived_memory>\n{memory_context}\n</archived_memory>")

        if last_user_msg:
            try:
                from core.skill_retriever import retrieve_skill_instructions
                skills = retrieve_skill_instructions(
                    query=last_user_msg,
                    story_active=is_story_mode(),
                    threshold=0.35,
                    top_k=2,
                    query_vector=self.query_vector,
                )
                if skills:
                    context_parts.append(skills)
            except Exception as se:
                print(f"[skills] Retrieval error: {se}")

        if context_parts:
            system_content += "\n\n" + "\n\n".join(context_parts)

        openai_messages = _merge_consecutive_messages([{"role": "system", "content": system_content}] + raw_messages)

        try:
            json_path = Path(PROGRAMS_DIR) / active_prog / f"{active_prog}.json"
            if json_path.is_file():
                raw = json.loads(json_path.read_text(encoding="utf-8"))
                post_inst = raw.get("data", raw).get("post_history_instructions", "").strip()
                if post_inst:
                    if openai_messages and openai_messages[-1]["role"] == "user":
                        prev = openai_messages[-1]["content"]
                        if isinstance(prev, str):
                            openai_messages[-1]["content"] += f"\n\n{post_inst}"
                        else:
                            openai_messages[-1]["content"].append({"type": "text", "text": f"\n\n{post_inst}"})
                    else:
                        openai_messages.append({"role": "user", "content": post_inst})
        except Exception as e:
            print(f"Error loading post-history instructions: {e}", flush=True)

        return openai_messages

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str, intermediate: bool = False):
        from core.mood_inversion import extract_and_strip_mood

        _, mood_details = extract_and_strip_mood(text)
        if mood_details:
            self.runner_obj.update_inversion_state_with_mood(self.session_id, mood_details.get("name"))

        winning_mode = self.runner_obj.sessions_inversion_state.get(self.session_id, {}).get("active_inversion", "")
        history = self.runner_obj.sessions_history[self.session_id]

        if history and history[-1]["role"] == "program":
            history[-1].update({
                "text": text,
                "tool_calls": tool_calls_data,
                "inversion_active": winning_mode,
                "mood": mood_details,
            })
            return history[-1]

        prefix = "itm_" if intermediate else "img_" if text and text.strip().startswith("![") and text.strip().endswith(")") else "prgm_"
        bot_msg = {
            "id": f"{prefix}{uuid.uuid4().hex}",
            "role": "program",
            "text": text,
            "tool_calls": tool_calls_data,
            "timestamp": time.time(),
            "inversion_active": winning_mode,
            "mood": mood_details,
        }
        history.append(bot_msg)
        return bot_msg

    def append_tool_events(self, results: list, invocation_id: str):
        for t_name, _, t_output in results:
            self.runner_obj.sessions_history[self.session_id].append({
                "id": f"tool_{uuid.uuid4().hex}",
                "role": "user",
                "text": f"[Tool Response from {t_name}]:\n{t_output}",
                "tool_calls": [],
                "timestamp": time.time(),
            })

    def append_image_tool_events(self, tool_name: str, tool_args: dict, new_markdown: str, call_id: str, invocation_id: str):
        pass

    def post_process_thoughts(self, invocation_id: str):
        pass

    def save(self):
        self.runner_obj._save_session_to_disk(self.session_id)