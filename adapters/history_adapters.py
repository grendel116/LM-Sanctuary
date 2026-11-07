import json
import os
import time
import uuid
from pathlib import Path

from utils.utils import (
    _MAIN_DIRECTIVE_PROMPT,
    _STORY_MODE_DIRECTIVE_PROMPT,
    _merge_consecutive_messages,
)


class OsHistoryAdapter:
    def __init__(self, runner_obj, session_id: str, file_path_resolved, image_data, image_mime, query_vector=None):
        self.runner_obj = runner_obj
        self.session_id = session_id
        self.file_path_resolved = file_path_resolved
        self.image_data = image_data
        self.image_mime = image_mime
        self.query_vector = query_vector
        self._cached_post_injection = None

    def _get_chat_budget(self) -> int:
        chat_budget = os.getenv("LOCAL_CHAT_BUDGET", "4096")
        if chat_budget and chat_budget.isdigit():
            return max(2048, int(chat_budget))
        return 4096

    def _get_max_input_tokens(self, in_tool_loop: bool = False) -> int:
        # Conversational turns stay within LOCAL_CHAT_BUDGET so memory + vectors replace long-context prefill.
        # Active tool-loop iterations expand into the allocated KV context so file/web reads fit in full.
        chat_budget = self._get_chat_budget()
        if not in_tool_loop:
            return chat_budget
        ctx_raw = os.getenv("LOCAL_CONTEXT", "8192")
        active_ctx = int(ctx_raw) if (ctx_raw and ctx_raw.isdigit()) else 8192
        return max(chat_budget, min(active_ctx - 2048, int(active_ctx * 0.75)))

    def _get_bridge_turns(self) -> int:
        # Scales the verbatim bridge window (4 to 10 user+program turn pairs) to the active chat budget.
        return max(4, min(10, round(self._get_chat_budget() / 680)))

    def _get_history_cut_step(self) -> int:
        return (self._get_bridge_turns() // 2 + 2) * 2

    CHARS_PER_TOKEN = 3.5

    @staticmethod
    def _content_len(content) -> int:
        if isinstance(content, list):
            return sum(len(item.get("text", "")) if isinstance(item, dict) else len(item) for item in content)
        return len(content or "")

    def _build_tiered_messages(
        self,
        system_content: str,
        raw_messages: list[dict],
        post_injection: str,
        max_input_tokens: int | None = None,
        in_tool_loop: bool = False,
    ) -> list[dict]:
        """
        Assembles the OpenAI payload in prefix-cache order:
          1. System prompt (static instructions, then the slow-changing memory chronicle).
          2. Chat history, trimmed from the oldest end in fixed blocks.
          3. Latest user turn with the per-turn post-injection appended.
        """
        if max_input_tokens is None:
            max_input_tokens = self._get_max_input_tokens(in_tool_loop=in_tool_loop)
        char_budget = int(max_input_tokens * self.CHARS_PER_TOKEN)

        chat_turns = [m for m in raw_messages if m.get("role") != "system"]

        latest_user_idx = None
        for i in range(len(chat_turns) - 1, -1, -1):
            if chat_turns[i].get("role") == "user" and not str(chat_turns[i].get("content", "")).startswith("[Tool Response from"):
                latest_user_idx = i
                break
        if latest_user_idx is None:
            for i in range(len(chat_turns) - 1, -1, -1):
                if chat_turns[i].get("role") == "user":
                    latest_user_idx = i
                    break

        if post_injection:
            if latest_user_idx is not None:
                user_turn = chat_turns[latest_user_idx]
                if isinstance(user_turn.get("content"), str):
                    user_turn["content"] = f"{user_turn['content']}\n\n{post_injection}"
                elif isinstance(user_turn.get("content"), list):
                    user_turn["content"].append({"type": "text", "text": f"\n\n{post_injection}"})
            else:
                chat_turns.append({"role": "user", "content": post_injection})
                latest_user_idx = len(chat_turns) - 1

        # Find the earliest block-aligned cut that fits the budget. The latest user turn and
        # everything after it (tool loop steps of the current turn) are always kept.
        lengths = [self._content_len(t.get("content")) for t in chat_turns]
        available = char_budget - len(system_content)
        protected_from = latest_user_idx if latest_user_idx is not None else len(chat_turns)
        cut_step = self._get_history_cut_step()

        cut = 0
        while cut < protected_from and sum(lengths[cut:]) > available:
            cut = min(cut + cut_step, protected_from)
        if cut:
            print(f"[CONTEXT] Dropped {cut} oldest messages to fit the context budget.", flush=True)

        kept = list(chat_turns[cut:])
        kept_lengths = lengths[cut:]
        user_pos = (latest_user_idx - cut) if latest_user_idx is not None else -1
        # Hard cap: if the current turn's own tool-loop steps still overflow, drop the oldest ones
        # (the task ledger already carries their results), keeping the latest exchange.
        if user_pos >= 0:
            dropped = 0
            while sum(kept_lengths) > available and len(kept) - user_pos - 1 > 2:
                del kept[user_pos + 1:user_pos + 3]
                del kept_lengths[user_pos + 1:user_pos + 3]
                dropped += 2
            if dropped:
                print(f"[CONTEXT] Dropped {dropped} old tool-loop messages from the current turn.", flush=True)
            if sum(kept_lengths) > available and len(kept) - user_pos - 1 >= 1:
                last = kept[-1]
                if isinstance(last.get("content"), str) and len(last["content"]) > 1500:
                    over = sum(kept_lengths) - available
                    keep_chars = max(1500, len(last["content"]) - over)
                    last["content"] = last["content"][:keep_chars] + "\n... [output truncated to fit context; use read_symbol or a narrower range]"

        final_messages = [{"role": "system", "content": system_content.strip()}]
        final_messages.extend(kept)

        return _merge_consecutive_messages(final_messages)

    def get_openai_messages(
        self, sys_inst: str, rag_context: str, memory_context: str = "", turn_directive: str = ""
    ) -> list[dict]:
        from core.program_config import is_story_mode, replace_placeholders
        from runners.program import get_active_program

        history = self.runner_obj.sessions_history.get(self.session_id, [])
        filtered_history = [
            msg for msg in history
            if msg.get("role") not in ("voice-call", "system-memory")
            and not msg.get("compacted")
            and (msg.get("text") or "").strip() not in ("*(Generation cancelled)*", "*(Generation stopped)*", "(Generation cancelled)", "(Generation stopped)")
        ]

        if not filtered_history:
            return [{"role": "system", "content": sys_inst}]

        # Anchor the verbatim dialogue window to the 12-turn memory compaction cycle:
        # turns older than (last_summarized_turn - bridge_turns) are already distilled
        # in `epic_chronicle` and `recent_chapters`, so dropping them keeps the prompt compact
        # and shifts the history prefix only when a new 12-turn chapter is summarized.
        meta = self.runner_obj._get_memory_meta(self.session_id)
        last_summarized_turn = meta.get("last_summarized_turn", 0)
        bridge_turns = self._get_bridge_turns()
        if last_summarized_turn > 0:
            hidden_prefixes = ("tool_", "port_", "quest_", "sys_", "itm_")
            dialogue_indices = [
                i for i, m in enumerate(filtered_history)
                if m.get("role") in ("user", "assistant", "program")
                and not m.get("id", "").startswith(hidden_prefixes)
                and not (m.get("text") or "").startswith("[Tool Response from")
                and not (m.get("text") or "").lower().startswith("[system:")
            ]
            start_offset = 1 if (dialogue_indices and filtered_history[dialogue_indices[0]].get("role") == "program") else 0
            total_paired_turns = (len(dialogue_indices) - start_offset) // 2
            if last_summarized_turn <= total_paired_turns:
                cutoff_turn = max(0, last_summarized_turn - bridge_turns)
                if cutoff_turn > 0:
                    cutoff_diag_pos = start_offset + (cutoff_turn * 2)
                    if cutoff_diag_pos < len(dialogue_indices):
                        first_kept_idx = dialogue_indices[cutoff_diag_pos]
                        filtered_history = filtered_history[first_kept_idx:]

        latest_user_idx = -1
        has_new_image = bool((self.image_data and self.image_mime) or self.file_path_resolved)

        for idx in range(len(filtered_history) - 1, -1, -1):
            msg = filtered_history[idx]
            if msg.get("role") == "user":
                if msg.get("id", "").startswith("tool_") or msg.get("text", "").startswith("[Tool Response from"):
                    continue
                latest_user_idx = idx
                break

        group_meta = getattr(self.runner_obj, "sessions_group_meta", {}).get(self.session_id)
        is_group = bool(group_meta and group_meta.get("is_group"))

        raw_messages = []
        last_tool_idx = max(
            (i for i, m in enumerate(filtered_history)
             if m.get("id", "").startswith("tool_") or m.get("text", "").startswith("[Tool Response from")),
            default=-1,
        )
        in_tool_loop = latest_user_idx >= 0 and last_tool_idx > latest_user_idx
        prior_tool_cap = max(800, int(self._get_chat_budget() * 0.20))
        loop_tool_cap = max(600, int(self._get_max_input_tokens(in_tool_loop=True) * 0.12))

        for idx, msg in enumerate(filtered_history):
            role = "assistant" if msg["role"] == "program" else "user"
            msg_id = msg.get("id", "")
            content_text = replace_placeholders(msg.get("text") or "")

            if is_group and role == "assistant" and msg.get("sender_name"):
                s_name = msg["sender_name"]
                if not content_text.startswith(f"[{s_name}]") and not content_text.startswith(f"{s_name}:"):
                    content_text = f"[{s_name}]: {content_text}"

            # Only re-serialize tool call tags on intermediate (itm_) turns that directly preceded a tool response.
            # Never append tool tags onto completed prgm_ turns, as that teaches models to emit tags after final replies.
            if msg.get("tool_calls") and msg_id.startswith("itm_"):
                for tc in msg["tool_calls"]:
                    if tc.get("type") == "call":
                        args_list = [
                            f'{k}="{v.replace('"', '\\"')}"' if isinstance(v, str) else f"{k}={v}"
                            for k, v in tc.get("args", {}).items()
                        ]
                        content_text += f"\n[{tc.get('name')}({', '.join(args_list)})]"

            # Compact large tool outputs from completed prior turns so they do not crowd out dialogue history
            if (
                idx < latest_user_idx
                and (msg_id.startswith("tool_") or content_text.startswith("[Tool Response from"))
                and len(content_text) > prior_tool_cap
            ):
                head_len = int(prior_tool_cap * 0.55)
                tail_len = int(prior_tool_cap * 0.25)
                content_text = (
                    f"{content_text[:head_len]}\n"
                    f"... [Earlier tool output compacted ({len(content_text)} chars)] ...\n"
                    f"{content_text[-tail_len:]}"
                )

            # Within the current turn only the newest tool result stays in full; earlier ones were already
            # distilled into the task ledger, and keeping them would overflow the window during long jobs.
            if (
                idx > latest_user_idx
                and idx != last_tool_idx
                and (msg_id.startswith("tool_") or content_text.startswith("[Tool Response from"))
                and len(content_text) > loop_tool_cap
            ):
                content_text = f"{content_text[:int(loop_tool_cap * 0.6)]}\n... [Earlier tool output compacted ({len(content_text)} chars); re-read if needed]"

            if idx == latest_user_idx:
                img_src = (
                    f"data:{self.image_mime};base64,{self.image_data}"
                    if self.image_data and self.image_mime
                    else self.file_path_resolved or msg.get("image_url")
                )
                from utils.utils import scan_and_tag_image, extract_uploaded_file_content
                scan_info = scan_and_tag_image(img_src) if (has_new_image or msg.get("image_url")) else ""
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

        group_meta = getattr(self.runner_obj, "sessions_group_meta", {}).get(self.session_id)
        if group_meta and group_meta.get("is_group"):
            active_prog = group_meta.get("host_id") or get_active_program()
        else:
            active_prog = get_active_program()
        story_active = is_story_mode(active_prog)

        directive = _STORY_MODE_DIRECTIVE_PROMPT if story_active else _MAIN_DIRECTIVE_PROMPT

        # Static instructions first, then the memory chronicle (refreshed once every 12 turns).
        system_content = f"{sys_inst}{directive}"
        if memory_context:
            system_content = f"{system_content.rstrip()}\n\n{memory_context}"

        # Per-turn blocks ride on the latest user turn so the system prompt and history stay cached.
        # They are computed once per turn so every tool-loop pass shares the same prefix.
        if self._cached_post_injection is None:
            self._cached_post_injection = self._build_post_injection(
                history, filtered_history, latest_user_idx, active_prog, story_active, rag_context, turn_directive
            )

        msgs = self._build_tiered_messages(
            system_content=system_content,
            raw_messages=raw_messages,
            post_injection=self._cached_post_injection,
            in_tool_loop=in_tool_loop,
        )

        # A one-line note while a review job is unfinished lets a new turn resume it; it rides at the very end so only the tail misses the cache.
        try:
            from tools.codejob import get_job_block
            plan_block = get_job_block(self.session_id)
            if plan_block and msgs:
                last = msgs[-1]
                if last.get("role") == "user" and isinstance(last.get("content"), str):
                    last["content"] = f"{last['content']}\n\n{plan_block}"
                elif last.get("role") == "user" and isinstance(last.get("content"), list):
                    last["content"].append({"type": "text", "text": f"\n\n{plan_block}"})
                else:
                    msgs.append({"role": "user", "content": plan_block})
        except Exception as pe:
            print(f"[review job] Injection error: {pe}")
        return msgs

    def _build_post_injection(
        self, history, filtered_history, latest_user_idx, active_prog, story_active, rag_context, turn_directive
    ) -> str:
        from core.program_config import replace_placeholders
        from tools.lorebook import get_active_lore
        from variables.settings import PROGRAMS_DIR

        post_blocks = []

        # World Info / Lore (placed in post_blocks so dynamic keyword triggers do not invalidate system prompt KV cache)
        try:
            lore_before, lore_after = get_active_lore(active_prog, filtered_history)
            all_lore = (lore_before or []) + (lore_after or [])
            if all_lore:
                post_blocks.append(f"[WORLD INFO]\n{'\n\n'.join(all_lore)}\n[END WORLD INFO]")
        except Exception as le:
            print(f"[lorebook] Injection error: {le}")

        try:
            from core.program_config import load_dynamic_runtime_context
            previous_ts = next(
                (m["timestamp"] for m in reversed(filtered_history[:latest_user_idx]) if m.get("timestamp")),
                None,
            ) if latest_user_idx > 0 else None
            dyn_ctx = load_dynamic_runtime_context(previous_ts).strip()
            if dyn_ctx:
                post_blocks.append(dyn_ctx)
        except Exception as e:
            print(f"[runtime context] Injection error: {e}")

        for msg in history:
            if msg.get("role") == "system-memory" and msg.get("text", "").strip():
                clean_mem = msg["text"].replace("[System Memory of older conversation turns]:", "").strip()
                post_blocks.append(f"<conversation_memory>\n{clean_mem}\n</conversation_memory>")

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
                from tools.journals import match_journals
                matched = match_journals(last_user_msg, active_prog, query_vector=self.query_vector)
                if matched:
                    journals_text = "\n".join(f"- {replace_placeholders(e['content'])}" for e in matched)
                    post_blocks.append(f"<recalled_journals>\n{journals_text}\n</recalled_journals>")
            except Exception as je:
                print(f"Error matching journals: {je}")

        if rag_context:
            post_blocks.append(f"<knowledge_base>\n{rag_context}\n</knowledge_base>")

        if last_user_msg:
            try:
                from core.skill_retriever import retrieve_skill_instructions
                skills = retrieve_skill_instructions(
                    query=last_user_msg,
                    story_active=story_active,
                    threshold=0.38,
                    top_k=2,
                )
                if skills:
                    post_blocks.append(skills)
            except Exception as se:
                print(f"[skills] Retrieval error: {se}")

        if last_user_msg and ("http://" in last_user_msg or "https://" in last_user_msg):
            post_blocks.append(
                "# PASTED LINK DIRECTIVE\n"
                "When a URL is present in the message, execute `[read_webpage(url=\"...\")]` to fetch the webpage. "
                "After the webpage content is retrieved, analyze its core concepts and discuss the article's ideas directly in character."
            )

        try:
            json_path = Path(PROGRAMS_DIR) / active_prog / f"{active_prog}.json"
            if json_path.is_file():
                raw = json.loads(json_path.read_text(encoding="utf-8"))
                post_inst = raw.get("data", raw).get("post_history_instructions", "").strip()
                if post_inst:
                    post_blocks.append(replace_placeholders(post_inst))
        except Exception as e:
            print(f"Error loading post-history instructions: {e}", flush=True)

        if turn_directive:
            post_blocks.append(turn_directive)

        return "\n\n".join(post_blocks)

    def append_assistant_message(self, text: str, tool_calls_data: list, invocation_id: str, intermediate: bool = False, speaker_id: str = None):
        from core.mood_inversion import extract_and_strip_mood
        from runners.program import get_active_program
        from core.program_config import _load_card_data

        sender_id = speaker_id or get_active_program()
        speaker_card = _load_card_data(sender_id)
        sender_name = speaker_card.get("name") if speaker_card else sender_id.title()

        group_meta = getattr(self.runner_obj, "sessions_group_meta", {}).get(self.session_id)
        is_host = True
        if group_meta and group_meta.get("is_group"):
            is_host = (sender_id == group_meta.get("host_id"))

        clean_text = text.strip() if text else ""
        is_image_turn = bool(clean_text and clean_text.startswith("![") and clean_text.endswith(")"))

        clean_text, mood_details = extract_and_strip_mood(text, program_id=sender_id)
        if is_image_turn:
            mood_details = None

        if is_host and mood_details:
            self.runner_obj.update_inversion_state_with_mood(self.session_id, mood_details.get("name"))

        winning_mode = self.runner_obj.sessions_inversion_state.get(self.session_id, {}).get("active_inversion", "")
        history = self.runner_obj.sessions_history[self.session_id]

        is_same_intermediate_turn = (
            history
            and history[-1]["role"] == "program"
            and history[-1].get("id", "").startswith("itm_")
            and history[-1].get("sender_id") == sender_id
        )
        if is_same_intermediate_turn:
            history[-1].update({
                "text": clean_text,
                "tool_calls": tool_calls_data,
                "inversion_active": winning_mode if is_host else "",
                "mood": mood_details,
                "sender_id": sender_id,
                "sender_name": sender_name,
            })
            if not intermediate:
                prefix = "img_" if clean_text and clean_text.strip().startswith("![") and clean_text.strip().endswith(")") else "prgm_"
                history[-1]["id"] = f"{prefix}{uuid.uuid4().hex}"
            return history[-1]

        prefix = "itm_" if intermediate else "img_" if clean_text and clean_text.strip().startswith("![") and clean_text.strip().endswith(")") else "prgm_"
        bot_msg = {
            "id": f"{prefix}{uuid.uuid4().hex}",
            "role": "program",
            "text": clean_text,
            "tool_calls": tool_calls_data,
            "timestamp": time.time(),
            "inversion_active": winning_mode if is_host else "",
            "mood": mood_details,
            "sender_id": sender_id,
            "sender_name": sender_name,
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
