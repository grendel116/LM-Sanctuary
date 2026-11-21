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


def _normalize_examples(raw: list[Any] | None, limit: int) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    for entry in raw or []:
        if isinstance(entry, dict):
            txt = " ".join(str(entry.get("text") or "").split())[:420]
            try:
                w = float(entry.get("weight", 1.0))
            except (TypeError, ValueError):
                w = 1.0
        else:
            txt = " ".join(str(entry or "").split())[:420]
            w = 1.0
        if not txt:
            continue
        out.append((txt, max(0.1, min(5.0, w))))
        if len(out) >= limit:
            break
    return out


def _weighted_centroid(vecs: list[Any], weights: list[float], np_mod: Any) -> Any:
    if not vecs:
        return None
    mat = np_mod.stack(vecs)
    w_arr = np_mod.asarray(weights, dtype=np_mod.float32)
    centroid = np_mod.sum(mat * w_arr[:, None], axis=0)
    norm = float(np_mod.linalg.norm(centroid))
    return (centroid / norm) if norm > 0.0 else None


def score_items_for_concepts(
    items: list[dict[str, Any]],
    boost_concepts: list[str] | None = None,
    dampen_concepts: list[str] | None = None,
    positive_examples: list[Any] | None = None,
    negative_examples: list[Any] | None = None,
    *,
    encode_fn: Callable[[list[str]], Any] | None = None,
) -> dict[str, Any]:
    """
    Score post snippets against concept anchors and personal taste exemplars using cached CPU embeddings.
    Returns { "available": bool, "scores": { id: float }, "tasteScores": { id: float } }.
    """
    boost = [" ".join(str(c).split())[:80] for c in (boost_concepts or []) if str(c or "").strip()]
    dampen = [" ".join(str(c).split())[:80] for c in (dampen_concepts or []) if str(c or "").strip()]
    pos_ex = _normalize_examples(positive_examples, 40)
    neg_ex = _normalize_examples(negative_examples, 25)
    valid_items = [
        (str(it.get("id") or ""), " ".join(str(it.get("text") or "").split())[:600])
        for it in (items or [])
        if isinstance(it, dict) and it.get("id") and str(it.get("text") or "").strip()
    ]
    if not valid_items or (not boost and not dampen and not pos_ex and not neg_ex):
        return {"available": bool(encode_fn or _MODEL), "scores": {}, "tasteScores": {}}

    all_texts = [
        *boost,
        *dampen,
        *(txt for txt, _ in pos_ex),
        *(txt for txt, _ in neg_ex),
        *(txt for _, txt in valid_items),
    ]
    vectors = _encode_texts(all_texts, encode_fn=encode_fn)
    if vectors is None:
        return {"available": False, "scores": {}, "tasteScores": {}}

    import numpy as np

    b_count = len(boost)
    d_count = len(dampen)
    p_count = len(pos_ex)
    n_count = len(neg_ex)

    offset = 0
    boost_vecs = np.stack(vectors[offset : offset + b_count]) if b_count else None
    offset += b_count
    dampen_vecs = np.stack(vectors[offset : offset + d_count]) if d_count else None
    offset += d_count
    pos_list = vectors[offset : offset + p_count]
    offset += p_count
    neg_list = vectors[offset : offset + n_count]
    offset += n_count
    item_vecs = np.stack(vectors[offset:])

    pos_mat = np.stack(pos_list) if pos_list else None
    pos_centroid = _weighted_centroid(pos_list, [w for _, w in pos_ex], np) if pos_list else None
    neg_mat = np.stack(neg_list) if neg_list else None
    neg_centroid = _weighted_centroid(neg_list, [w for _, w in neg_ex], np) if neg_list else None

    scores: dict[str, float] = {}
    taste_scores: dict[str, float] = {}
    want_concepts = boost_vecs is not None or dampen_vecs is not None
    want_taste = pos_mat is not None or neg_mat is not None

    for row_idx, (item_id, _) in enumerate(valid_items):
        vec = item_vecs[row_idx]
        if want_concepts:
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

        if want_taste:
            pos_part = 0.0
            neg_part = 0.0
            if pos_mat is not None:
                sims_pos = np.dot(pos_mat, vec)
                k_pos = min(3, len(pos_list))
                top_pos = float(np.mean(np.sort(sims_pos)[-k_pos:]))
                cent_sim = float(np.dot(pos_centroid, vec)) if pos_centroid is not None else top_pos
                raw_pos = 0.60 * top_pos + 0.40 * cent_sim
                pos_part = max(0.0, min(1.0, (raw_pos - 0.18) / 0.42))
            if neg_mat is not None:
                sims_neg = np.dot(neg_mat, vec)
                k_neg = min(2, len(neg_list))
                top_neg = float(np.mean(np.sort(sims_neg)[-k_neg:]))
                cent_neg = float(np.dot(neg_centroid, vec)) if neg_centroid is not None else top_neg
                raw_neg = 0.65 * top_neg + 0.35 * cent_neg
                neg_part = max(0.0, min(1.0, (raw_neg - 0.22) / 0.42))
            taste_scores[item_id] = round(max(-1.0, min(1.0, pos_part - neg_part * 0.85)), 4)

    return {"available": True, "scores": scores, "tasteScores": taste_scores}
