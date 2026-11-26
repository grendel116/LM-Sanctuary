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


_POST_INST_CACHE: dict[str, tuple[float, str]] = {}


def _extract_retrieval_query(user_msg: dict | None, raw_text: str) -> str:
    """Keep shared card header + user's own note so third-party post bodies don't pollute retrieval."""
    clean = (raw_text or "").strip()
    if not clean.startswith(("[Shared post by ", "[Shared webpage from ")):
        return clean
    header = clean.split("\n", 1)[0]
    if isinstance(user_msg, dict) and user_msg.get("user_note") is not None:
        note = str(user_msg.get("user_note") or "").strip()
        return f"{header}\n{note}".strip()
    if "\n\n" in clean:
        return f"{header}\n{clean.split('\n\n')[-1].strip()}".strip()
    return header


def _preview_tool_args(args: dict) -> dict:
    """Bounded copy of tool args for history display (long strings clipped to 320 chars)."""
    out = {}
    for k, v in (args or {}).items():
        out[k] = f"{v[:320]}..." if isinstance(v, str) and len(v) > 320 else v
    return out


class OsHistoryAdapter:
    def __init__(self, runner_obj, session_id: str, file_path_resolved, image_data, image_mime, query_vector=None):
        self.runner_obj = runner_obj
        self.session_id = session_id
        self.file_path_resolved = file_path_resolved
        self.image_data = image_data
        self.image_mime = image_mime
        self.query_vector = query_vector
        self._cached_post_injection = None
        self.matched_skill_records = []
        self.has_sensitive_context = False

    def get_latest_image_data_url(self) -> str:
        """Return a `data:image/...;base64,...` URL if the active turn attached an image."""
        import base64
        import mimetypes

        if self.image_data and self.image_mime:
            return f"data:{self.image_mime};base64,{self.image_data}"
        if self.file_path_resolved and os.path.isfile(self.file_path_resolved):
            ext = os.path.splitext(self.file_path_resolved)[1].lower()
            if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                mime = mimetypes.guess_type(self.file_path_resolved)[0] or "image/png"
                try:
                    with open(self.file_path_resolved, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode("ascii")
                    return f"data:{mime};base64,{b64}"
                except OSError:
                    return ""
        return ""

    def _get_chat_budget(self) -> int:
        chat_budget = os.getenv("LOCAL_CHAT_BUDGET", "4096")
        if chat_budget and chat_budget.isdigit():
            return max(2048, int(chat_budget))
        return 4096

    def _get_max_input_tokens(self, in_tool_loop: bool = False, cloud_gear: bool = False) -> int:
        # Conversational turns stay within LOCAL_CHAT_BUDGET so memory + vectors replace long-context prefill.
        # Active tool-loop iterations expand into the allocated KV context; Cloud Gears unlock 32K.
        if cloud_gear:
            return 32768
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

    def estimate_turn_tokens(self) -> int:
        """Estimate active turn + recent dialogue tokens without triggering context-drop logs."""
        history = self.runner_obj.sessions_history.get(self.session_id, [])
        total_chars = 0
        for msg in history[-24:]:
            if msg.get("role") in ("voice-call", "system-memory") or msg.get("compacted"):
                continue
            total_chars += len(str(msg.get("text") or ""))
        return int(total_chars / self.CHARS_PER_TOKEN)

    def _build_tiered_messages(
        self,
        system_content: str,
        raw_messages: list[dict],
        post_injection: str,
        max_input_tokens: int | None = None,
        in_tool_loop: bool = False,
        cloud_gear: bool = False,
    ) -> list[dict]:
        """
        Assembles the OpenAI payload in prefix-cache order:
          1. System prompt (static instructions, then the slow-changing memory chronicle).
          2. Chat history, trimmed from the oldest end in fixed blocks.
          3. Latest user turn with the per-turn post-injection appended.
        """
        if max_input_tokens is None:
            max_input_tokens = self._get_max_input_tokens(in_tool_loop=in_tool_loop, cloud_gear=cloud_gear)
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
                if hasattr(self.runner_obj, "_get_memory_meta"):
                    ledger = ((self.runner_obj._get_memory_meta(self.session_id).get("coding_state") or {}).get("ledger") or [])[-8:]
                    if ledger:
                        note = "[Earlier tool steps in this turn compacted; work ledger so far:\n" + "\n".join(f"- {x}" for x in ledger) + "]"
                        kept.insert(user_pos + 1, {"role": "user", "content": note})
                        kept_lengths.insert(user_pos + 1, len(note))
            if sum(kept_lengths) > available and len(kept) - user_pos - 1 >= 1:
                last = kept[-1]
                if isinstance(last.get("content"), str) and len(last["content"]) > 1500:
                    over = sum(kept_lengths) - available
                    keep_chars = max(1500, len(last["content"]) - over)
                    last["content"] = last["content"][:keep_chars] + "\n... [output truncated to fit context]"

        final_messages = [{"role": "system", "content": system_content.strip()}]
        final_messages.extend(kept)

        return _merge_consecutive_messages(final_messages)

    def get_openai_messages(
        self, sys_inst: str, rag_context: str, memory_context: str = "", turn_directive: str = "", cloud_gear: bool = False
    ) -> list[dict]:
        from core.program_config import is_story_mode, replace_placeholders
        from runners.program import get_active_program
        from runners.runner import _get_safe_local_path, prune_orphan_turn_artifacts

        _IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
        _MEDIA_SKIP_DOC_EXTS = _IMAGE_EXTS + (".mp4", ".webm")

        def _resolve_existing_media_source(raw_url: str | None, sender_id: str | None = None) -> str | None:
            if not raw_url or not isinstance(raw_url, str):
                return None
            if raw_url.startswith("data:"):
                return raw_url
            local_p = _get_safe_local_path(raw_url, program_id=sender_id)
            if local_p and os.path.isfile(local_p):
                return local_p
            if os.path.isfile(raw_url):
                return raw_url
            return None

        def _safe_image_scan(src: str | None) -> str:
            if not src:
                return ""
            is_img = src.startswith("data:image/") or src.lower().endswith(_IMAGE_EXTS)
            if not is_img:
                return ""
            from utils.utils import scan_and_tag_image
            info = scan_and_tag_image(src)
            if not info or info.startswith(("[Image Scan: Could not locate", "[Image Scan: No image", "[Image Scan: Error")):
                return ""
            return info

        history = self.runner_obj.sessions_history.get(self.session_id, [])
        filtered_history = [
            msg for msg in history
            if msg.get("role") not in ("voice-call", "system-memory")
            and not msg.get("compacted")
            and (msg.get("text") or "").strip() not in ("*(Generation cancelled)*", "*(Generation stopped)*", "(Generation cancelled)", "(Generation stopped)")
        ]

        is_gen = self.session_id in getattr(self.runner_obj, "generating_sessions", set())
        prune_orphan_turn_artifacts(filtered_history, is_generating=is_gen)

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
        loop_tool_cap = max(600, int(self._get_max_input_tokens(in_tool_loop=True, cloud_gear=cloud_gear) * (0.45 if cloud_gear else 0.12)))
        has_read_webpage_in_loop = in_tool_loop and any(
            (m.get("id", "").startswith("tool_") or str(m.get("text") or "").startswith("[Tool Response from read_webpage"))
            and "read_webpage" in str(m.get("text") or "")
            for m in filtered_history[latest_user_idx + 1:]
        )

        pending_call_labels: list[str] = []
        for idx, msg in enumerate(filtered_history):
            role = "assistant" if msg["role"] == "program" else "user"
            msg_id = msg.get("id", "")
            content_text = replace_placeholders(msg.get("text") or "")
            if (
                has_read_webpage_in_loop
                and role == "user"
                and not msg_id.startswith("tool_")
                and content_text.startswith("[Shared webpage from ")
            ):
                header = content_text.split("\n", 1)[0]
                user_note = (msg.get("user_note") or "").strip()
                content_text = f"{header}\n\n{user_note}" if user_note else header

            if is_group and role == "assistant" and msg.get("sender_name"):
                s_name = msg["sender_name"]
                if not content_text.startswith(f"[{s_name}]") and not content_text.startswith(f"{s_name}:"):
                    content_text = f"[{s_name}]: {content_text}"

            # Intermediate (itm_) tool-call turns: local models see their own [tool(...)] tags;
            # cloud models see no call syntax in assistant content (they use native tool_calls),
            # and each call's args ride on the matching tool response header instead.
            if msg.get("tool_calls") and msg_id.startswith("itm_"):
                calls = [tc for tc in msg["tool_calls"] if tc.get("type") == "call"]
                if cloud_gear:
                    pending_call_labels.extend(
                        f"{tc.get('name')} {json.dumps(_preview_tool_args(tc.get('args') or {}), ensure_ascii=False)}"
                        for tc in calls
                    )
                else:
                    for tc in calls:
                        args_list = [
                            f"{k}={json.dumps(v, ensure_ascii=False)}" if isinstance(v, str) else f"{k}={v}"
                            for k, v in _preview_tool_args(tc.get("args") or {}).items()
                        ]
                        content_text += f"\n[{tc.get('name')}({', '.join(args_list)})]"
            if cloud_gear and msg_id.startswith("tool_") and content_text.startswith("[Tool Response from ") and pending_call_labels:
                header, sep, body = content_text.partition("]:")
                if sep:
                    content_text = f"[Tool Response from {pending_call_labels.pop(0)}]:{body}"
            if cloud_gear and role == "assistant" and msg_id.startswith("itm_") and not content_text.strip():
                continue

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
                msg_media_local = _resolve_existing_media_source(
                    msg.get("image_url"),
                    msg.get("sender_id") if msg.get("role") == "program" else None,
                )
                img_src = (
                    f"data:{self.image_mime};base64,{self.image_data}"
                    if self.image_data and self.image_mime
                    else (
                        self.file_path_resolved
                        if (self.file_path_resolved and os.path.isfile(self.file_path_resolved))
                        else msg_media_local
                    )
                )
                from utils.utils import extract_uploaded_file_content
                scan_info = _safe_image_scan(img_src)
                doc_path = (
                    self.file_path_resolved
                    if (self.file_path_resolved and os.path.isfile(self.file_path_resolved))
                    else (
                        msg_media_local
                        if (msg_media_local and not msg_media_local.startswith("data:") and not msg_media_local.lower().endswith(_MEDIA_SKIP_DOC_EXTS))
                        else None
                    )
                )
                doc_info = extract_uploaded_file_content(doc_path) if doc_path else ""

                extra_parts = [p for p in (doc_info, scan_info) if p]
                if extra_parts:
                    content_text = f"{content_text}\n\n" + "\n\n".join(extra_parts)

                raw_messages.append({"role": role, "content": content_text.strip()})
                continue

            if msg.get("image_url"):
                hist_media_local = _resolve_existing_media_source(
                    msg.get("image_url"),
                    msg.get("sender_id") if msg.get("role") == "program" else None,
                )
                scan_info = _safe_image_scan(hist_media_local)
                if scan_info:
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
            cloud_gear=cloud_gear,
        )

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

        last_user_entry = next(
            (
                m for m in reversed(filtered_history)
                if m.get("role") == "user"
                and not m.get("id", "").startswith("tool_")
                and not m.get("text", "").startswith("[Tool Response from")
            ),
            None,
        )
        last_user_msg = (last_user_entry or {}).get("text", "")
        retrieval_query = _extract_retrieval_query(last_user_entry, last_user_msg)

        if retrieval_query:
            try:
                from tools.journals import match_journals
                matched = match_journals(retrieval_query, active_prog, query_vector=self.query_vector)
                if matched:
                    self.has_sensitive_context = True
                    journals_text = "\n".join(f"- {replace_placeholders(e['content'])}" for e in matched)
                    post_blocks.append(f"<recalled_journals>\n{journals_text}\n</recalled_journals>")
            except Exception as je:
                print(f"Error matching journals: {je}")

        if rag_context:
            post_blocks.append(f"<knowledge_base>\n{rag_context}\n</knowledge_base>")

        if retrieval_query:
            try:
                from core.skill_retriever import (
                    format_skill_records,
                    retrieve_matched_skill_records,
                )
                self.matched_skill_records = retrieve_matched_skill_records(
                    query=retrieval_query,
                    story_active=story_active,
                    threshold=0.38,
                    top_k=2,
                    query_vector=self.query_vector,
                )
                skills = format_skill_records(self.matched_skill_records)
                if skills:
                    post_blocks.append(skills)
            except Exception as se:
                print(f"[skills] Retrieval error: {se}")

        stripped_user = (last_user_msg or "").lstrip()
        if stripped_user.lower().startswith("/plan"):
            post_blocks.append(
                "# IMPLEMENTATION PLAN MODE\n"
                "The user invoked `/plan`. Do NOT mutate files or run destructive commands yet. "
                "Inspect files read-only (`list_dir`, `grep_search`, `read_file`) or research (`web_search`, `read_webpage`), then present a concise, "
                "concrete plan wrapped inside a fenced ```sanctuary-plan block with sections for Goal, "
                "Planned Changes, and Verification so the user can review and click Proceed."
            )

        has_web_tool_in_loop = any(
            (m.get("id", "").startswith("tool_") or "[Tool Response from " in str(m.get("text") or ""))
            and any(t in str(m.get("text") or "") for t in ("read_webpage", "web_search", "browser_action"))
            for m in filtered_history[latest_user_idx + 1:]
        )
        if (last_user_msg and ("http://" in last_user_msg or "https://" in last_user_msg)) or has_web_tool_in_loop:
            post_blocks.append(
                "# WEB & RESEARCH GROUNDING DIRECTIVE\n"
                "Ground your answer in concrete facts, commands, structure, and technical specifics from the retrieved webpage(s) or search results. "
                "Do not speculate before tools run or rely on vague card previews. "
                "If an overview/index page lacks the requested detail and lists relevant subpage links, call `[read_webpage(url=\"...\")]` to read them before answering."
            )

        try:
            json_path = Path(PROGRAMS_DIR) / active_prog / f"{active_prog}.json"
            if json_path.is_file():
                mtime = json_path.stat().st_mtime
                cache_key = str(json_path)
                cached = _POST_INST_CACHE.get(cache_key)
                if cached and cached[0] == mtime:
                    post_inst = cached[1]
                else:
                    raw = json.loads(json_path.read_text(encoding="utf-8"))
                    post_inst = raw.get("data", raw).get("post_history_instructions", "").strip()
                    _POST_INST_CACHE[cache_key] = (mtime, post_inst)
                if post_inst:
                    post_blocks.append(replace_placeholders(post_inst))
        except Exception as e:
            print(f"Error loading post-history instructions: {e}", flush=True)

        if not story_active and hasattr(self.runner_obj, "_get_memory_meta"):
            try:
                from core.plan_state import format_coding_state_block

                meta = self.runner_obj._get_memory_meta(self.session_id)
                coding_names = {
                    "list_dir",
                    "read_file",
                    "grep_search",
                    "http_probe",
                    "edit_file",
                    "write_file",
                    "run_command",
                    "update_plan_step",
                    "delegate_coding",
                }
                recent_coding = any(
                    tc.get("name") in coding_names
                    for m in filtered_history[-8:]
                    for tc in (m.get("tool_calls") or [])
                )
                coding_block = format_coding_state_block(meta, include_ledger_only=recent_coding)
                if coding_block:
                    post_blocks.append(coding_block)
            except Exception as ce:
                print(f"[plan_state] Post-injection error: {ce}", flush=True)

        if story_active:
            post_blocks.append(replace_placeholders(
                "# STORY MODE REMINDER\n"
                "Write this reply as a lengthy story passage: 3–6 full paragraphs with vivid scene detail and a plot development. "
                "Do not write {{user}}'s actions, words, or thoughts."
            ))

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
        with self.runner_obj._lock:
            history = self.runner_obj.sessions_history.setdefault(self.session_id, [])

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
            return self.runner_obj._upsert_history_message(self.session_id, bot_msg)

    def append_tool_events(self, results: list, invocation_id: str):
        for t_name, _, t_output in results:
            self.runner_obj._upsert_history_message(self.session_id, {
                "id": f"tool_{uuid.uuid4().hex}",
                "role": "user",
                "text": f"[Tool Response from {t_name}]:\n{t_output}",
                "tool_calls": [],
                "timestamp": time.time(),
            })
