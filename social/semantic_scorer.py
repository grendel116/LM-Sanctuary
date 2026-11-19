"""Optional local CPU sentence-transformer semantic scorer for social feed concept anchors."""

from __future__ import annotations

import hashlib
import os
import threading
from collections import OrderedDict
from typing import Any, Callable

_LOCK = threading.Lock()
_MODEL: Any = None
_MODEL_UNAVAILABLE = False
_VEC_CACHE: OrderedDict[str, Any] = OrderedDict()
_MAX_CACHE_ENTRIES = 1024


def reset_semantic_scorer_cache() -> None:
    with _LOCK:
        _VEC_CACHE.clear()


def _get_local_embedding_model():
    global _MODEL, _MODEL_UNAVAILABLE
    if _MODEL is not None:
        return _MODEL
    if _MODEL_UNAVAILABLE:
        return None
    with _LOCK:
        if _MODEL is not None:
            return _MODEL
        if _MODEL_UNAVAILABLE:
            return None
        try:
            os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
            from sentence_transformers import SentenceTransformer

            _MODEL = SentenceTransformer("all-MiniLM-L6-v2", device="cpu", local_files_only=True)
            return _MODEL
        except Exception:
            _MODEL_UNAVAILABLE = True
            return None


def _encode_texts(texts: list[str], encode_fn: Callable[[list[str]], Any] | None = None):
    if not texts:
        return []
    import numpy as np

    missing_indices: list[int] = []
    missing_texts: list[str] = []
    results: list[Any] = [None] * len(texts)

    with _LOCK:
        for i, txt in enumerate(texts):
            key = hashlib.sha1(txt.encode("utf-8")).hexdigest()
            cached = _VEC_CACHE.get(key)
            if cached is not None:
                _VEC_CACHE.move_to_end(key)
                results[i] = cached
            else:
                missing_indices.append(i)
                missing_texts.append(txt)

    if missing_texts:
        if encode_fn is not None:
            vecs = encode_fn(missing_texts)
        else:
            model = _get_local_embedding_model()
            if model is None:
                return None
            vecs = model.encode(missing_texts, normalize_embeddings=True, show_progress_bar=False)

        with _LOCK:
            for idx, txt, raw_vec in zip(missing_indices, missing_texts, vecs):
                arr = np.asarray(raw_vec, dtype=np.float32)
                norm = float(np.linalg.norm(arr))
                if norm > 0.0:
                    arr = arr / norm
                key = hashlib.sha1(txt.encode("utf-8")).hexdigest()
                _VEC_CACHE[key] = arr
                if len(_VEC_CACHE) > _MAX_CACHE_ENTRIES:
                    _VEC_CACHE.popitem(last=False)
                results[idx] = arr

    return results


def score_items_for_concepts(
    items: list[dict[str, Any]],
    boost_concepts: list[str] | None = None,
    dampen_concepts: list[str] | None = None,
    *,
    encode_fn: Callable[[list[str]], Any] | None = None,
) -> dict[str, Any]:
    """
    Score post snippets against boostConcepts and dampenConcepts using cached CPU embeddings.
    Returns { "available": bool, "scores": { id: float (-1.0..1.0) } }.
    """
    boost = [" ".join(str(c).split())[:80] for c in (boost_concepts or []) if str(c or "").strip()]
    dampen = [" ".join(str(c).split())[:80] for c in (dampen_concepts or []) if str(c or "").strip()]
    valid_items = [
        (str(it.get("id") or ""), " ".join(str(it.get("text") or "").split())[:600])
        for it in (items or [])
        if isinstance(it, dict) and it.get("id") and str(it.get("text") or "").strip()
    ]
    if not valid_items or (not boost and not dampen):
        return {"available": True if (encode_fn or _MODEL) else False, "scores": {}}

    all_texts = [*boost, *dampen, *(txt for _, txt in valid_items)]
    vectors = _encode_texts(all_texts, encode_fn=encode_fn)
    if vectors is None:
        return {"available": False, "scores": {}}

    import numpy as np

    b_count = len(boost)
    d_count = len(dampen)
    boost_vecs = np.stack(vectors[:b_count]) if b_count else None
    dampen_vecs = np.stack(vectors[b_count : b_count + d_count]) if d_count else None
    item_vecs = np.stack(vectors[b_count + d_count :])

    scores: dict[str, float] = {}
    for row_idx, (item_id, _) in enumerate(valid_items):
        vec = item_vecs[row_idx]
        b_score = 0.0
        d_score = 0.0
        if boost_vecs is not None:
            sims = np.dot(boost_vecs, vec)
            raw_b = 0.65 * float(np.max(sims)) + 0.35 * float(np.mean(sims))
            b_score = max(0.0, min(1.0, (raw_b - 0.16) / 0.45))
        if dampen_vecs is not None:
            sims = np.dot(dampen_vecs, vec)
            raw_d = 0.65 * float(np.max(sims)) + 0.35 * float(np.mean(sims))
            d_score = max(0.0, min(1.0, (raw_d - 0.16) / 0.45))
        scores[item_id] = round(max(-1.0, min(1.0, b_score - d_score)), 4)

    return {"available": True, "scores": scores}
