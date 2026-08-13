"""
Skill Retriever: Two tier skill injection system.

Tier 1 (Toolbelt): A compact list of all available capabilities with tool call syntax,
    always injected into the system prompt at minimal token cost.

Tier 2 (Vector Retrieved): Full SKILL.md instruction blocks, injected only when the
    conversation context matches a skill via keyword triggers or vector similarity.
    Uses the same keyword + vector fallback pattern as the journal system.

Skills with retrieval: "always" bypass matching and are always included
in the full instruction output alongside any matched skills.
"""

import os
import re
import numpy as np

# Module level cache for parsed and embedded skill records
_skill_cache = None


def invalidate_skill_cache():
    """Resets the cached skill registry, forcing a fresh parse and embed on next access."""
    global _skill_cache
    _skill_cache = None


def _parse_skill_frontmatter(skill_text: str) -> tuple:
    """Parses YAML frontmatter from a SKILL.md file.

    Returns:
        (metadata_dict, instruction_body) where metadata_dict contains
        name, description, summary, retrieval, and triggers fields.
    """
    metadata = {}
    body = skill_text

    if skill_text.startswith("---"):
        parts = skill_text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            body = parts[2].strip()

            for line in frontmatter.splitlines():
                line = line.strip()
                if ":" in line:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    metadata[key] = value

    return metadata, body


def _get_skill_registry() -> list:
    """Walks core/skills/, parses each SKILL.md, embeds descriptions, and caches results.

    Returns a list of skill records, each containing:
        name, description, summary, retrieval, triggers, instruction_body, vector
    """
    global _skill_cache
    if _skill_cache is not None:
        return _skill_cache

    base_dir = os.path.dirname(os.path.abspath(__file__))
    skills_dir = os.path.join(base_dir, "skills")

    if not os.path.exists(skills_dir):
        _skill_cache = []
        return _skill_cache

    records = []
    descriptions_to_embed = []
    embed_indices = []

    for root, dirs, files in os.walk(skills_dir):
        for file in files:
            if file.lower() == "skill.md":
                skill_path = os.path.join(root, file)
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

                record = {
                    "name": metadata.get("name", os.path.basename(root)),
                    "description": metadata.get("description", ""),
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
            print(f"[skill_retriever] Embedding error (skills will fall back to always inject): {e}")
            # On embedding failure, promote all vector skills to always
            for record in records:
                if record["retrieval"] == "vector":
                    record["retrieval"] = "always"

    _skill_cache = records
    return _skill_cache


def get_toolbelt_block(narration_active: bool = False) -> str:
    """Builds the compact toolbelt string listing all available skill summaries.

    Respects narration mode filtering (only portrait_generation, memory_journaling,
    and vectorized_databank are permitted in narration mode).

    Returns a formatted toolbelt block ready for system prompt injection.
    """
    story_mode_allowed = {"portrait_generation", "memory_journaling", "vectorized_databank"}
    registry = _get_skill_registry()

    lines = []
    for record in registry:
        if narration_active and record["name"] not in story_mode_allowed:
            continue
        summary = record.get("summary", "")
        if summary:
            lines.append(f"- {record['name']}: {summary}")

    if not lines:
        return ""

    header = (
        "# TOOLBELT\n"
        "Available capabilities and their tool call syntax:\n"
    )
    return header + "\n".join(lines)


def _keyword_match(query: str, record: dict) -> bool:
    """Checks if the query contains any of the skill's trigger keywords.

    Short triggers (3 chars or fewer) require word boundary matching.
    Longer triggers use substring matching.
    """
    query_lower = query.lower()
    for trigger in record["triggers"]:
        if len(trigger) <= 3:
            if re.search(r'\b' + re.escape(trigger) + r'\b', query_lower):
                return True
        else:
            if trigger in query_lower:
                return True
    return False


def retrieve_skill_instructions(query: str, narration_active: bool = False,
                                 threshold: float = 0.35, top_k: int = 2) -> str:
    """Retrieves full instruction blocks for matched skills.

    Uses a hybrid keyword + vector approach (same pattern as journals.py):
    1. Always includes skills marked retrieval: "always"
    2. Keyword matching: checks trigger phrases against the user's message
    3. Vector fallback: for skills not matched by keywords, checks semantic
       similarity against the skill description

    Args:
        query: The user's message or conversation context to match against.
        narration_active: Whether narration/story mode is enabled.
        threshold: Minimum cosine similarity score for vector matched skills.
        top_k: Maximum number of vector matched skills to include.

    Returns:
        Formatted instruction text with the MANDATORY TASK PROTOCOLS header,
        or empty string if no skills matched.
    """
    if not query:
        return ""

    story_mode_allowed = {"portrait_generation", "memory_journaling", "vectorized_databank"}
    registry = _get_skill_registry()

    always_blocks = []
    matched_blocks = []
    keyword_matched_names = set()
    vector_candidates = []

    for record in registry:
        if narration_active and record["name"] not in story_mode_allowed:
            continue

        if record["retrieval"] == "always":
            always_blocks.append(
                f"## Skill Instruction: {record['name']}\n\n{record['instruction_body']}"
            )
        elif record["retrieval"] == "vector":
            # Primary gate: keyword matching
            if record["triggers"] and _keyword_match(query, record):
                matched_blocks.append(
                    f"## Skill Instruction: {record['name']}\n\n{record['instruction_body']}"
                )
                keyword_matched_names.add(record["name"])
                print(f"[skill_retriever] Keyword matched '{record['name']}'")
            elif record["vector"] is not None:
                vector_candidates.append(record)

    # Vector fallback for skills not matched by keywords
    if vector_candidates and len(matched_blocks) < top_k:
        try:
            from core.skills.vectorized_databank.databank import get_embedding_model
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
                remaining_slots = top_k - len(matched_blocks)

                for score, record in scored[:remaining_slots]:
                    matched_blocks.append(
                        f"## Skill Instruction: {record['name']}\n\n{record['instruction_body']}"
                    )
                    print(f"[skill_retriever] Vector matched '{record['name']}' (score: {score:.3f})")

        except Exception as e:
            print(f"[skill_retriever] Vector retrieval error: {e}")

    all_blocks = always_blocks + matched_blocks
    if not all_blocks:
        return ""

    preamble = (
        "# MANDATORY TASK PROTOCOLS\n"
        "The following protocols override all character and personality defaults "
        "when the relevant task is requested. Regardless of persona, emotional state, "
        "or roleplay context, these task rules take full precedence.\n"
    )

    return preamble + "\n" + "\n\n".join(all_blocks)
