"""
utils/lorebook.py — ST-compatible lorebook engine.

Loads World Info entries from:
  1. data.character_book in the active program's card JSON
  2. Standalone .json files in core/programs/<program>/lorebooks/

Normalizes both ST standalone dict-of-entries and chara_card_v3
list-of-entries formats into a single internal schema, then
keyword-scans recent chat messages to return triggered content.
"""

from __future__ import annotations

import json
import os
import random


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def _normalise_entry(raw: dict) -> dict | None:
    if raw.get("disable", False):
        return None
    if not raw.get("enabled", True):
        return None

    content = (raw.get("content") or "").strip()
    if not content:
        return None

    # Primary keys — standalone uses 'key', v3 uses 'keys'
    keys = raw.get("keys") or raw.get("key") or []
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split(",") if k.strip()]

    sec_keys = raw.get("secondary_keys") or raw.get("keysecondary") or []
    if isinstance(sec_keys, str):
        sec_keys = [k.strip() for k in sec_keys.split(",") if k.strip()]

    # Position: ST standalone 0=before, 1=after; v3 string
    pos_raw = raw.get("position", 0)
    if isinstance(pos_raw, str):
        position = "after" if "after" in pos_raw else "before"
    else:
        position = "after" if pos_raw == 1 else "before"

    order = raw.get("insertion_order") or raw.get("order") or 100
    scan_depth = raw.get("scan_depth")

    return {
        "keys":          [k.lower() for k in keys],
        "secondary_keys":[k.lower() for k in sec_keys],
        "content":       content,
        "constant":      bool(raw.get("constant", False)),
        "selective":     bool(raw.get("selective", False)),
        "position":      position,
        "order":         int(order),
        "scan_depth":    int(scan_depth) if scan_depth is not None else None,
        "probability":   int(raw.get("probability", 100)),
    }


def _parse_lorebook(book: dict) -> list[dict]:
    raw_entries = book.get("entries", [])
    if isinstance(raw_entries, dict):
        raw_entries = list(raw_entries.values())
    return [e for raw in raw_entries if (e := _normalise_entry(raw)) is not None]


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _matches_keys(keys: list[str], scan_text: str) -> bool:
    return any(k and k in scan_text for k in keys)


def _entry_triggers(entry: dict, scan_text: str) -> bool:
    if entry["constant"]:
        return True
    if not _matches_keys(entry["keys"], scan_text):
        return False
    if entry["selective"] and entry["secondary_keys"]:
        if not _matches_keys(entry["secondary_keys"], scan_text):
            return False
    if entry["probability"] < 100:
        if random.randint(1, 100) > entry["probability"]:
            return False
    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

DEFAULT_SCAN_DEPTH = 4  # messages (not turns)


def get_active_lore(
    program_id: str,
    recent_messages: list[dict],
    programs_dir: str | None = None,
) -> tuple[list[str], list[str]]:
    """
    Return (before_entries, after_entries) — triggered lore content strings.
    before: injected before character block; after: injected after.
    """
    if programs_dir is None:
        from variables.settings import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR

    program_dir = os.path.join(programs_dir, program_id)
    all_entries: list[dict] = []

    # 1. character_book from card
    card_path = os.path.join(program_dir, f"{program_id}.json")
    if os.path.exists(card_path):
        try:
            with open(card_path, encoding="utf-8") as f:
                card_raw = json.load(f)
            cb = card_raw.get("data", card_raw).get("character_book")
            if cb:
                all_entries.extend(_parse_lorebook(cb))
        except Exception as e:
            print(f"[lorebook] Error reading card: {e}")

    # 2. Standalone lorebook files
    lorebooks_dir = os.path.join(program_dir, "lorebooks")
    if os.path.isdir(lorebooks_dir):
        for fname in os.listdir(lorebooks_dir):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(lorebooks_dir, fname), encoding="utf-8") as f:
                    all_entries.extend(_parse_lorebook(json.load(f)))
            except Exception as e:
                print(f"[lorebook] Error reading {fname}: {e}")

    if not all_entries:
        return [], []

    # 3. Build scan window
    max_depth = max(
        (e["scan_depth"] for e in all_entries if e["scan_depth"] is not None),
        default=DEFAULT_SCAN_DEPTH,
    )
    scan_msgs = [
        m for m in recent_messages
        if m.get("role") in ("user", "program") and (m.get("text") or "").strip()
    ]
    scan_text = " ".join(
        (m.get("text") or "").lower() for m in scan_msgs[-max_depth:]
    )

    # 4. Evaluate and sort (Existing Keyword Triggers)
    triggered = sorted(
        [e for e in all_entries if _entry_triggers(e, scan_text)],
        key=lambda e: e["order"],
    )

    # 5. Hybrid Semantic Retrieval (If no keyword entries triggered, check vector similarity)
    if not triggered and scan_text:
        try:
            from core.skills.vectorized_databank.databank import DataBankManager
            db = DataBankManager()
            
            # Query the databank engine or use its internal similarity mechanism
            # (Assuming query_text or a similar method returns relevant chunks with scores)
            vector_results = db.query_text(scan_text, top_k=2) # Limit semantic search hits
            
            # Map search results back to lore entries if they match content
            matched_contents = {res.get("text") for res in vector_results if res.get("score", 0.0) >= 0.30}
            
            for e in all_entries:
                if e in triggered:
                    continue
                if e["content"] in matched_contents:
                    triggered.append(e)
                    
            # Re-sort to maintain order rules if new items were appended
            triggered.sort(key=lambda x: x["order"])
            
        except Exception as ex:
            print(f"[lorebook] Vector search notice: {ex}")

    before = [e["content"] for e in triggered if e["position"] == "before"]
    after  = [e["content"] for e in triggered if e["position"] == "after"]
    return before, after


# ---------------------------------------------------------------------------
# File management helpers
# ---------------------------------------------------------------------------

def list_lorebooks(program_id: str, programs_dir: str | None = None) -> list[dict]:
    if programs_dir is None:
        from variables.settings import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR

    results = []

    card_path = os.path.join(programs_dir, program_id, f"{program_id}.json")
    if os.path.exists(card_path):
        try:
            with open(card_path, encoding="utf-8") as f:
                card_raw = json.load(f)
            cb = card_raw.get("data", card_raw).get("character_book")
            if cb:
                results.append({
                    "id": "__card__",
                    "name": cb.get("name") or f"{program_id} (embedded)",
                    "source": "card",
                    "entry_count": len(_parse_lorebook(cb)),
                })
        except Exception:
            pass

    lorebooks_dir = os.path.join(programs_dir, program_id, "lorebooks")
    if os.path.isdir(lorebooks_dir):
        for fname in sorted(os.listdir(lorebooks_dir)):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(lorebooks_dir, fname), encoding="utf-8") as f:
                    book = json.load(f)
                results.append({
                    "id": fname,
                    "name": book.get("name") or fname.replace(".json", ""),
                    "source": "file",
                    "entry_count": len(_parse_lorebook(book)),
                    "filename": fname,
                })
            except Exception:
                pass

    return results


def import_lorebook(program_id: str, book_data: dict, filename: str, programs_dir: str | None = None) -> str:
    if programs_dir is None:
        from variables.settings import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR
    lorebooks_dir = os.path.join(programs_dir, program_id, "lorebooks")
    os.makedirs(lorebooks_dir, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in filename)
    if not safe.endswith(".json"):
        safe += ".json"
    dest = os.path.join(lorebooks_dir, safe)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(book_data, f, indent=2, ensure_ascii=False)
    return dest


def delete_lorebook(program_id: str, filename: str, programs_dir: str | None = None) -> bool:
    if programs_dir is None:
        from variables.settings import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR
    fpath = os.path.join(programs_dir, program_id, "lorebooks", filename)
    if os.path.exists(fpath):
        os.remove(fpath)
        return True
    return False
