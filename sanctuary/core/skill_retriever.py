"""
Skill Retriever: Two tier skill injection system.

Tier 1 (Toolbelt): A compact list of all available capabilities with tool call syntax,
    always injected into the system prompt at minimal token cost.

Tier 2 (Vector Retrieved): Full SKILL.md instruction blocks, injected only when the
    conversation context matches a skill via keyword triggers or vector similarity.
    Uses the same keyword + vector pattern as the journal system.

Skills with retrieval: "always" bypass matching and are always included
in the full instruction output alongside any matched skills.
"""

import os
import re
import threading
import numpy as np

# Module level cache for parsed and embedded skill records
_skill_cache = None
_skill_mtime: float = 0.0
_REGISTRY_LOCK = threading.Lock()


def _parse_skill_frontmatter(skill_text: str) -> tuple:
    """Parses AgentSkills / GreenPT-compatible YAML frontmatter from a SKILL.md file.

    Returns:
        (metadata_dict, instruction_body) where metadata_dict contains
        name, title, description, summary, retrieval, and triggers fields.
    """
    metadata = {}
    body = skill_text

    if skill_text.startswith("---"):
        parts = skill_text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            body = parts[2].strip()

            current_key = None
            block_lines = []
            for raw_line in frontmatter.splitlines():
                if current_key and (raw_line.startswith("  ") or raw_line.startswith("\t")):
                    block_lines.append(raw_line.strip())
                    continue
                if current_key:
                    metadata[current_key] = " ".join(block_lines).strip()
                    current_key = None
                    block_lines = []

                line = raw_line.strip()
                if ":" in line:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    value = value.strip()
                    if value in ("|", ">", "|-", ">-"):
                        current_key = key
                        block_lines = []
                    else:
                        metadata[key] = value.strip('"').strip("'")

            if current_key:
                metadata[current_key] = " ".join(block_lines).strip()

    return metadata, body


def _get_skill_registry() -> list:
    """Walks core/skills/, parses each SKILL.md, embeds descriptions, and caches results.

    Returns a list of skill records, each containing:
        name, description, summary, retrieval, triggers, instruction_body, vector
    """
    global _skill_cache, _skill_mtime
    base_dir = os.path.dirname(os.path.abspath(__file__))
    skills_dir = os.path.join(base_dir, "skills")

    if not os.path.exists(skills_dir):
        _skill_cache = []
        return _skill_cache

    skill_files = []
    latest_mtime = 0.0
    for root, dirs, files in os.walk(skills_dir):
        for file in files:
            if file.lower() == "skill.md":
                sp = os.path.join(root, file)
                skill_files.append((root, sp))
                try:
                    mtime = os.path.getmtime(sp)
                    if mtime > latest_mtime:
                        latest_mtime = mtime
                except OSError:
                    pass

    if _skill_cache is not None and latest_mtime == _skill_mtime:
        return _skill_cache

    with _REGISTRY_LOCK:
        if _skill_cache is not None and latest_mtime == _skill_mtime:
            return _skill_cache

        records = []
        descriptions_to_embed = []
        embed_indices = []

        for root, skill_path in skill_files:
            try:
                with open(skill_path, "r", encoding="utf-8") as sf:
                    skill_text = sf.read()
            except Exception as e:
                print(f"[skill_retriever] Error reading {skill_path}: {e}")
                continue

            metadata, body = _parse_skill_frontmatter(skill_text)

            # Parse triggers as comma separated lowercase list
            triggers_raw = metadata.get("triggers", "")
            triggers = [t.strip().lower() for t in triggers_raw.split(",") if t.strip()]

            raw_name = metadata.get("name", os.path.basename(root))
            record = {
                "name": raw_name,
                "title": metadata.get("title") or raw_name.replace("_", " ").replace("-", " ").title(),
                "description": metadata.get("description", "")[:500],
                "summary": metadata.get("summary", ""),
                "retrieval": metadata.get("retrieval", "always"),
                "triggers": triggers,
                "instruction_body": body,
                "vector": None,
            }

            idx = len(records)
            records.append(record)

            # Queue vector retrieval skills for embedding
            if record["retrieval"] == "vector" and record["description"]:
                descriptions_to_embed.append(record["description"])
                embed_indices.append(idx)

        # Batch embed all vector retrieval skill descriptions
        if descriptions_to_embed:
            try:
                from core.skills.vectorized_databank.databank import get_embedding_model
                model = get_embedding_model()
                vectors = model.encode(descriptions_to_embed)
                for i, vec in enumerate(vectors):
                    records[embed_indices[i]]["vector"] = vec
                print(f"[skill_retriever] Embedded {len(descriptions_to_embed)} skill descriptions for vector retrieval.")
            except Exception as e:
                print(f"[skill_retriever] Embedding unavailable (relying on keyword triggers): {e}")

        _skill_cache = records
        _skill_mtime = latest_mtime
        return _skill_cache


def get_toolbelt_block(story_active: bool = False) -> str:
    """Builds the compact core toolbelt string for system prompt injection.

    Domain-specific skills attach dynamically per turn or via `[list_tools(topic="...")]`
    to avoid bloating the static system prompt with unused tool schemas.
    """
    if story_active:
        return (
            "# TOOLBELT\n"
            "- Portrait Generation: `[generate_program_portrait(prompt=\"...\")]`\n"
            "- Log Journaling: `[add_journal_entry(keyphrases=\"...\", content=\"...\")]`"
        )

    return (
        "# TOOLBELT\n"
        "Active core tags (matched domain skill protocols attach automatically when relevant):\n"
        "- Cloud Upscale Baton: `[consult_cloud(prompt=\"...\", tier=\"fast|deep\", context=\"...\")]` for complex/high-stakes topics, urgency/corrections, or verified accuracy.\n"
        "- Memory Journal: `[add_journal_entry(keyphrases=\"...\", content=\"...\")]` only for permanent biographical facts.\n"
        "- Tool Discovery: `[list_tools(topic=\"...\")]` to load exact `[tool_name(...)]` tags for in-process coding (`read_file`, `edit_file`, `grep_search`, `run_command`), web/browser, quests/cron, feed tuning, portraits, music, or widgets."
    )


def _keyword_match(query: str, record: dict) -> bool:
    """Checks if the query contains any of the skill's trigger keywords on word boundaries."""
    query_lower = query.lower()
    q_len = len(query_lower)
    for trigger in record["triggers"]:
        if not trigger:
            continue
        t_len = len(trigger)
        need_start = trigger[0].isalnum() or trigger[0] == "_"
        need_end = trigger[-1].isalnum() or trigger[-1] == "_"
        idx = query_lower.find(trigger)
        while idx != -1:
            ok_start = (not need_start) or idx == 0 or not (query_lower[idx - 1].isalnum() or query_lower[idx - 1] == "_")
            end_idx = idx + t_len
            ok_end = (not need_end) or end_idx == q_len or not (query_lower[end_idx].isalnum() or query_lower[end_idx] == "_")
            if ok_start and ok_end:
                return True
            idx = query_lower.find(trigger, idx + 1)
    return False


def retrieve_matched_skill_records(
    query: str,
    story_active: bool = False,
    threshold: float = 0.35,
    top_k: int = 2,
    query_vector=None,
) -> list:
    """Return ordered list of matched skill record dicts (`always` + matched `vector` skills)."""
    if not query:
        return []

    story_mode_allowed = {"portrait_generation", "log_journaling", "vectorized_databank"}
    registry = _get_skill_registry()

    always_records = []
    matched_records = []
    keyword_matched_names = set()
    vector_candidates = []

    for record in registry:
        if story_active and record["name"] not in story_mode_allowed:
            continue

        if record["retrieval"] == "always":
            always_records.append(record)
        elif record["retrieval"] == "vector":
            if record["triggers"] and _keyword_match(query, record):
                matched_records.append(record)
                keyword_matched_names.add(record["name"])
                print(f"[skill_retriever] Keyword matched '{record['name']}'")
            elif record["vector"] is not None:
                vector_candidates.append(record)

    if vector_candidates and len(matched_records) < top_k:
        try:
            from core.skills.vectorized_databank.databank import get_embedding_model
            if query_vector is None:
                model = get_embedding_model()
                query_vector = model.encode(query)
            query_norm = np.linalg.norm(query_vector)

            if query_norm > 0:
                scored = []
                for record in vector_candidates:
                    if record["name"] in keyword_matched_names:
                        continue
                    skill_vector = np.array(record["vector"])
                    skill_norm = np.linalg.norm(skill_vector)
                    if skill_norm == 0:
                        continue
                    similarity = float(np.dot(query_vector, skill_vector) / (query_norm * skill_norm))
                    if similarity >= threshold:
                        scored.append((similarity, record))

                scored.sort(key=lambda x: x[0], reverse=True)
                remaining_slots = top_k - len(matched_records)

                for score, record in scored[:remaining_slots]:
                    matched_records.append(record)
                    print(f"[skill_retriever] Vector matched '{record['name']}' (score: {score:.3f})")

        except Exception as e:
            print(f"[skill_retriever] Vector retrieval error: {e}")

    return always_records + matched_records


def format_skill_records(records: list) -> str:
    """Format matched skill records into a single compact instruction block."""
    if not records:
        return ""

    all_blocks = []
    for rec in records:
        summary = rec.get("summary", "").strip()
        header = f"## Skill Instruction: {rec['name']}"
        if summary:
            header += f"\nTag: {summary}"
        all_blocks.append(f"{header}\n\n{rec['instruction_body']}")

    preamble = (
        "# MANDATORY TASK PROTOCOLS\n"
        "Apply the exact `[tool_name(key=\"value\")]` signatures below when relevant:\n\n"
    )
    return preamble + "\n\n".join(all_blocks)


def retrieve_skill_instructions(query: str, story_active: bool = False,
                                 threshold: float = 0.35, top_k: int = 2,
                                 query_vector=None) -> str:
    """Retrieves full instruction blocks for matched skills."""
    records = retrieve_matched_skill_records(
        query=query,
        story_active=story_active,
        threshold=threshold,
        top_k=top_k,
        query_vector=query_vector,
    )
    return format_skill_records(records)
