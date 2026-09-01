import ast
import asyncio
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import tools.tools as tools
from runners.program import get_active_program

# Constants
VECTOR_QUERY_MESSAGES = 3
VECTOR_TOP_K = 4
VECTOR_SCORE_THRESHOLD = 0.25
VECTOR_TOKEN_BUDGET = 2048

def atomic_save_json(path: str | Path, data: object, indent: int = 2):
    """Atomically writes JSON to disk using a unique temporary file and replacement."""
    target_path = str(path)
    os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
    temp_path = f"{target_path}.tmp_{uuid.uuid4().hex[:6]}"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)
    os.replace(temp_path, target_path)

TOOL_ALIASES = {
    "generate_program_portrait": "generate_local_image",
    "dalle.text2im": "generate_local_image",
    "dalle:text2im": "generate_local_image",
    "text2im": "generate_local_image",
    "generate_general_image": "generate_imagen",
}

_MAIN_DIRECTIVE_PROMPT = (
    "\n\n# TOOL PROTOCOL\n"
    'Tools are emulated by exact `[tool_name(key="value")]` tags. Use a tool only when it materially advances the current task; otherwise answer directly.\n'
    "The TOOLBELT above is the capability index. When a capability is relevant, use the matching retrieved skill instructions as the detailed procedure.\n"
    "Available tools: google_search, web_search, read_webpage, read_file, write_file, replace_in_file, replace_file_content, multi_replace_file_content, "
    "run_shell_command, run_command_async, manage_task, wait_task, get_workspace_structure, search_codebase, generate_local_image, generate_imagen, "
    "apply_comfy_workflow, add_quest, add_journal_entry, search_music.\n"
    "Use argument names shown by a retrieved skill or the tool's established signature. Do not invent tool results. After a tool result, continue the task concisely; do not repeat the tag.\n"
    "For research, search first and read the most relevant pages; use distinct queries or URLs when continuing. Ground claims in retrieved facts.\n"
    "Use image tools sparingly. Image prompts are short comma-separated tags, and image generation must be the only content in that model response.\n"
    "Treat retrieved knowledge-base context as authoritative for the user's uploaded material.\n"
)

_STORY_MODE_DIRECTIVE_PROMPT = (
    "\n\n# STORY TOOL PROTOCOL\n"
    'Use exact `[tool_name(key="value")]` tags only when needed. The TOOLBELT and retrieved skill block define the available procedure.\n'
    "Story tools: generate_local_image, generate_imagen, apply_comfy_workflow. Use exactly one tool tag per turn, then respond naturally after its result.\n"
    "Image prompts must be short comma-separated tags; image generation must be the only content in that model response.\n"
    "Treat retrieved knowledge-base context as authoritative for the user's uploaded material.\n"
)

THINK_TAG_PATTERN = re.compile(
    r'(?:<think>|\[think\]|<thought>|\[thought\]|<\|thought\|>|<\|channel\|>thought|<channel\|>thought)'
    r'([\s\S]*?)'
    r'(?:</think>|\[/think\]|</thought>|\[/thought\]|<\|/thought\|>|<\|channel\|>|<channel\|>|<\/\s*think>|\[\s*/\s*think\s*\]|$)',
    re.IGNORECASE
)
CHANNEL_TAG_RE = re.compile(r'<\|channel\|>|<channel\|>', re.IGNORECASE)
SINGLE_ASTERISK_RE = re.compile(r'(?<!\*)\*(?!\*)([\s\S]*?)(?<!\*)\*(?!\*)')
STANDALONE_ASTERISK_RE = re.compile(r'(?<!\*)\*(?!\*)')
MULTI_NEWLINE_RE = re.compile(r'\n\s*\n+')
MULTI_SPACE_RE = re.compile(r' +')
JSON_BLOCK_RE = re.compile(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```|(\{[\s\S]*?\})', re.IGNORECASE)
TOOL_ARG_RE = re.compile(r'(\w+)\s*=\s*(?:("""|\'\'\'|["\']))([\s\S]*?)\2', re.DOTALL)


def _run_async_in_background_thread(coro):
    def target():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro)
        except Exception as e:
            print(f"[BACKGROUND TASK ERROR] {e}", flush=True)
        finally:
            loop.close()

    threading.Thread(target=target, daemon=True).start()


def _merge_consecutive_messages(messages: list[dict]) -> list[dict]:
    """Combines consecutive messages with the same role into a single message."""
    if not messages:
        return []

    merged = []
    for msg in messages:
        if merged and merged[-1]["role"] == msg["role"]:
            prev, curr = merged[-1]["content"], msg["content"]
            if isinstance(prev, str) and isinstance(curr, str):
                merged[-1]["content"] = f"{prev}\n\n{curr}"
            else:
                p_list = prev if isinstance(prev, list) else [{"type": "text", "text": prev}]
                c_list = curr if isinstance(curr, list) else [{"type": "text", "text": curr}]
                merged[-1]["content"] = p_list + c_list
        else:
            merged.append(msg)
    return merged


def _build_vector_query(history: list[dict], max_messages: int = VECTOR_QUERY_MESSAGES) -> str:
    """Constructs a vector search query from the last N non-system conversation messages."""
    valid_roles = {"user", "program", "assistant"}
    messages = []

    for msg in reversed(history):
        if msg.get("role") not in valid_roles:
            continue
        text = msg.get("text", "").strip()
        if not text or text.startswith(("[Tool Response", "[SYSTEM:")):
            continue
        messages.append(text)
        if len(messages) >= max_messages:
            break

    return " ".join(reversed(messages))


def _get_databank_contexts(query_text: str) -> tuple[str, object]:
    """Retrieve knowledge and databank files using vector embeddings."""
    if not query_text:
        return "", None

    try:
        from core.skills.vectorized_databank.databank import DataBankManager, get_embedding_model
        db = DataBankManager()
        if not db._load_data(db.db_path).get("chunks"):
            return "", None

        query_vector = get_embedding_model().encode(query_text)
        rag_context = db.query(
            query_text,
            top_k=VECTOR_TOP_K,
            score_threshold=VECTOR_SCORE_THRESHOLD,
            exclude_source_type="chat_history",
            token_budget=VECTOR_TOKEN_BUDGET,
            query_vector=query_vector,
        )
        return rag_context, query_vector
    except Exception as e:
        print(f"Error querying data bank contexts: {e}")
        return "", None


def _build_tool_calls_pair(tool_name: str, args: dict, output: str, idx: int | None = None) -> list[dict]:
    """Builds a pair of execution call/response dictionaries for tool logging."""
    suffix = f"_{idx}_{uuid.uuid4().hex[:4]}" if idx is not None else ""
    call_id = f"call_{int(time.time())}{suffix}"

    return [
        {"type": "call", "name": tool_name, "args": args, "id": call_id},
        {"type": "response", "name": tool_name, "response": str(output), "id": call_id},
    ]


def _normalize_tool_name(tool_name: str) -> str:
    """Normalizes tool name aliases to standard internal forms."""
    return TOOL_ALIASES.get(tool_name, tool_name)


def _parse_emulated_tool_call(tool_name: str, args_str: str) -> dict:
    """Parses tool call argument strings safely into dictionary structures, 
    handling multi-line code blocks and parameter aliases.
    """
    kwargs = {}
    args = []

    try:
        # Try standard AST parse first
        parsed = ast.parse(f"dummy({args_str})")
        call_node = parsed.body[0].value
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call_node.keywords}
        args = [ast.literal_eval(arg) for arg in call_node.args]
    except Exception:
        # Backup for multi-line / complex arguments (like code blocks)
        matches = TOOL_ARG_RE.findall(args_str)
        
        if matches:
            for key, quote, val in matches:
                kwargs[key] = val
        else:
            # Backup for single raw string argument
            val = args_str.strip().strip("'\"")
            if val:
                args = [val]

    # --- Parameter Alias Normalization ---
    if tool_name == "write_file":
        if "filename" in kwargs and "path" not in kwargs:
            kwargs["path"] = kwargs.pop("filename")

    return {"args": args, "kwargs": kwargs}


def _execute_emulated_tool(tool_name: str, args_str: str) -> tuple[dict, str]:
    """Parses and executes an emulated tool call."""
    normalized_name = _normalize_tool_name(tool_name)
    parsed_args = _parse_emulated_tool_call(normalized_name, args_str)

    if normalized_name == "generate_imagen" and not tools.current_use_imagen.get():
        return parsed_args, "Error: Imagen rendering is disabled in settings."

    func = getattr(tools, normalized_name, None)
    if not func:
        return parsed_args, f"Error: Tool '{normalized_name}' not found."

    try:
        output = func(*parsed_args["args"], **parsed_args["kwargs"])
    except Exception as e:
        output = f"Error executing tool: {e}"

    return parsed_args, str(output)


def _get_safe_local_path(image_url: str) -> str | None:
    """Converts an image URL into a safe relative local path for active workspace."""
    if "/images/" not in image_url:
        return None

    raw_path = image_url.split("/images/")[-1].replace("\\", "/")
    safe_parts = [
        "".join(c for c in part if c.isalnum() or c in "._-")
        for part in raw_path.split("/")
        if part
    ]
    
    cleaned_parts = [p for p in safe_parts if p]
    if not cleaned_parts:
        return None

    active_program = get_active_program()
    return str(Path("core", "programs", active_program, *cleaned_parts))


def _format_thinking_and_text(thoughts_list: list[str], texts_list: list[str]) -> str:
    """Combines thoughts and texts, normalizing <think> blocks."""
    thoughts_str = "".join(thoughts_list).strip()
    text_str = "".join(texts_list).strip()

    extracted_thoughts = [m.group(1).strip() for m in THINK_TAG_PATTERN.finditer(text_str) if m.group(1).strip()]
    cleaned_text = THINK_TAG_PATTERN.sub("", text_str).strip()

    all_thoughts = [t for t in [thoughts_str] + extracted_thoughts if t]
    combined_thoughts = "\n".join(all_thoughts).strip()

    if combined_thoughts:
        return f"<think>{combined_thoughts}</think>\n{cleaned_text}"
    return cleaned_text


def strip_story(text: str) -> str:
    """Strips action narration inside asterisks and internal thinking tags."""
    if not text:
        return ""

    text = THINK_TAG_PATTERN.sub('', text)
    text = CHANNEL_TAG_RE.sub('', text)

    text = SINGLE_ASTERISK_RE.sub('', text)
    text = STANDALONE_ASTERISK_RE.sub('', text)

    text = MULTI_NEWLINE_RE.sub('\n\n', text)
    text = MULTI_SPACE_RE.sub(' ', text)
    return text.strip()


def is_real_user_msg(msg: dict) -> bool:
    """Determine if a message originates from a human user."""
    if msg.get('role') != 'user':
        return False

    msg_id = msg.get('id', '')
    if msg_id:
        if any(msg_id.startswith(p) for p in ('tool_', 'port_', 'quest_', 'sys_')):
            return False
        if any(msg_id.startswith(p) for p in ('usr_', 'img_')):
            return True

    text = msg.get('text', '')
    invalid_triggers = ('[Tool Response', '[SYSTEM:', 'Generate a portrait of yourself')
    return not any(text.startswith(t) or t in text for t in invalid_triggers)


def _convert_json_tool_calls_to_tags(text: str) -> str:
    """Converts standard JSON tool call structures into internal [tool_name(args)] tag formats."""
    if not text or "action" not in text or "action_input" not in text:
        return text

    def replace_match(match: re.Match) -> str:
        block = match.group(1) or match.group(2)
        try:
            d = json.loads(block)
            act, inp = d.get("action"), d.get("action_input")
            if not act or inp is None:
                return match.group(0)

            norm_act = _normalize_tool_name(act)
            if not hasattr(tools, norm_act) and norm_act not in ("generate_local_image", "generate_imagen"):
                return match.group(0)

            if isinstance(inp, str) and inp.strip().startswith("{"):
                try:
                    inp = json.loads(inp)
                except Exception:
                    pass

            args_list = []
            if isinstance(inp, dict):
                for k, v in inp.items():
                    val_str = f'"{v.replace("\\", "\\\\").replace('"', '\\"')}"' if isinstance(v, str) else str(v)
                    args_list.append(f'{k}={val_str}')
            elif isinstance(inp, str):
                escaped = inp.replace('\\', '\\\\').replace('"', '\\"')
                args_list.append(f'prompt="{escaped}"')

        except Exception:
            return match.group(0)

    return JSON_BLOCK_RE.sub(replace_match, text)


def scan_and_tag_image(image_source: str | bytes | Path) -> str:
    """Scans an image via Pillow to extract format, dimensions, color profile, and embedded metadata/tags."""
    if not image_source:
        return "[Image Scan: No image provided]"

    import io
    import base64
    from pathlib import Path
    from PIL import Image, ImageStat

    filename = "Attached Image"
    raw_bytes = None

    try:
        if isinstance(image_source, bytes):
            raw_bytes = image_source
        elif isinstance(image_source, (str, Path)):
            src_str = str(image_source).strip()
            if src_str.startswith("data:"):
                # Handle base64 data URL
                header, _, b64_data = src_str.partition(",")
                raw_bytes = base64.b64decode(b64_data)
                if "image/" in header:
                    ext_part = header.split(";")[0].replace("data:image/", "")
                    filename = f"uploaded_image.{ext_part}"
            else:
                p = Path(src_str)
                if p.is_file():
                    filename = p.name
                    raw_bytes = p.read_bytes()
                elif os.path.exists(src_str):
                    p = Path(src_str)
                    filename = p.name
                    raw_bytes = p.read_bytes()

        if not raw_bytes:
            return f"[Image Scan: Could not locate image source '{image_source}']"

        size_kb = round(len(raw_bytes) / 1024, 1)

        with Image.open(io.BytesIO(raw_bytes)) as img:
            img_format = img.format or "Unknown Format"
            width, height = img.size
            mode = img.mode

            # Aspect ratio description
            ratio = width / height if height > 0 else 1.0
            if abs(ratio - 1.0) < 0.05:
                aspect_desc = "1:1 Square"
            elif ratio > 1.4:
                aspect_desc = f"{width}:{height} Landscape"
            elif ratio < 0.7:
                aspect_desc = f"{width}:{height} Portrait"
            else:
                aspect_desc = f"{width}:{height}"

            # Color profile & Brightness analysis
            rgb_img = img.convert("RGB")
            stat = ImageStat.Stat(rgb_img)
            avg_r, avg_g, avg_b = stat.mean[:3]
            brightness = round((avg_r * 0.299 + avg_g * 0.587 + avg_b * 0.114) / 2.55, 1)

            # Color tone classification
            color_tones = []
            if brightness < 20:
                color_tones.append("Very Dark / Shadows")
            elif brightness > 80:
                color_tones.append("Bright / High Key")

            if avg_r > avg_g + 20 and avg_r > avg_b + 20:
                color_tones.append("Warm Red / Orange")
            elif avg_g > avg_r + 15 and avg_g > avg_b + 15:
                color_tones.append("Green")
            elif avg_b > avg_r + 15 and avg_b > avg_g + 15:
                color_tones.append("Cool Blue / Cyan")
            elif max(avg_r, avg_g, avg_b) - min(avg_r, avg_g, avg_b) < 15:
                color_tones.append("Monochrome / Neutral Gray")
            else:
                color_tones.append("Balanced Color Palette")

            tones_str = ", ".join(color_tones)

            # Embedded PNG / EXIF metadata scanning
            meta_info = []
            if hasattr(img, "info") and isinstance(img.info, dict):
                for key in ("parameters", "description", "title", "Software", "Comment", "prompt"):
                    if val := img.info.get(key):
                        if isinstance(val, str) and val.strip():
                            clean_val = val.strip()[:300]
                            meta_info.append(f"{key}: {clean_val}")

            meta_str = ("\n- Embedded Metadata/Tags: " + " | ".join(meta_info)) if meta_info else ""

            return (
                f"[Image Scan & Tag Analysis]\n"
                f"- File: {filename}\n"
                f"- Format & Resolution: {img_format} ({mode}, {width}x{height} px, {aspect_desc}, {size_kb} KB)\n"
                f"- Color Profile & Lighting: Dominant Tones ({tones_str}), Avg Brightness ({brightness}%){meta_str}"
            )
    except Exception as e:
        return f"[Image Scan & Tag Analysis]\n- File: {filename}\n- Scan Status: Basic image file ({size_kb if 'size_kb' in locals() else 'N/A'} KB, parsing note: {e})"


def extract_uploaded_file_content(file_path: str | Path, max_chars: int = 8000) -> str:
    """Extracts text content or document summary from uploaded files (PDFs, text, code, CSVs)."""
    if not file_path:
        return ""

    p = Path(file_path)
    if not p.is_file():
        return ""

    filename = p.name
    ext = p.suffix.lower()
    file_size_kb = round(p.stat().st_size / 1024, 1)

    # PDF Parsing
    if ext == ".pdf":
        try:
            import pypdf
            reader = pypdf.PdfReader(str(p))
            num_pages = len(reader.pages)
            extracted_pages = []
            total_chars = 0
            for idx, page in enumerate(reader.pages):
                txt = page.extract_text() or ""
                if txt.strip():
                    extracted_pages.append(f"--- Page {idx + 1} ---\n{txt.strip()}")
                    total_chars += len(txt)
                if total_chars >= max_chars:
                    break
            content = "\n\n".join(extracted_pages)[:max_chars]
            return (
                f"[Attached Document: {filename} (PDF, {num_pages} pages, {file_size_kb} KB)]\n"
                f"--- DOCUMENT CONTENT START ---\n{content}\n--- DOCUMENT CONTENT END ---"
            )
        except Exception as e:
            return f"[Attached Document: {filename} (PDF, {file_size_kb} KB - PDF extraction note: {e})]"

    # Text / Code / CSV / JSON / Markdown
    text_extensions = {".txt", ".md", ".py", ".json", ".csv", ".log", ".html", ".css", ".js", ".ts", ".xml", ".yaml", ".yml", ".c", ".cpp", ".h", ".sh", ".bat", ".ini", ".cfg"}
    if ext in text_extensions or ext.strip() == "":
        try:
            text_content = p.read_text(encoding="utf-8", errors="replace").strip()
            if text_content:
                snippet = text_content[:max_chars]
                truncated_note = f"\n[... Truncated after {max_chars} chars ...]" if len(text_content) > max_chars else ""
                return (
                    f"[Attached File: {filename} ({ext.upper().lstrip('.')} File, {file_size_kb} KB)]\n"
                    f"--- FILE CONTENT START ---\n{snippet}{truncated_note}\n--- FILE CONTENT END ---"
                )
        except Exception as e:
            return f"[Attached File: {filename} ({file_size_kb} KB - Read note: {e})]"

    return f"[Attached File: {filename} ({ext.upper().lstrip('.')} Binary File, {file_size_kb} KB)]"