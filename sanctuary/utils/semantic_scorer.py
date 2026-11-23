"""Optional local CPU sentence-transformer semantic scorer for social feed concept anchors."""

from __future__ import annotations

import hashlib
import os
import threading
from collections import OrderedDict
from typing import Any, Callable

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "8")
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

_CACHE_LOCK = threading.RLock()
_LOCK = _CACHE_LOCK
_ENCODE_LOCK = threading.Lock()
_MODEL: Any = None
_ADAPTER: Any = None
_MODEL_UNAVAILABLE = False
_VEC_CACHE: OrderedDict[str, Any] = OrderedDict()
_MAX_CACHE_ENTRIES = 1024

POLE_EXEMPLARS: dict[str, tuple[str, ...]] = {
    "everydayChatter": (
        "I baked fresh bread this afternoon and went for a quiet walk around the neighborhood.",
        "Funny little thing happened with my cat at home while I was making coffee today.",
        "Silly joke and casual banter with friends on a lazy afternoon.",
        "Tinkering on a small weekend hobby project in the garage and enjoying the rain.",
    ),
    "scienceTheory": (
        "Here is a detailed scientific and engineering breakdown of how we measured and calibrated the system.",
        "Historical and materialist analysis of worker cooperatives, mode of production, and mutual aid.",
        "Research paper notes comparing experimental methodology, physics, mathematics, and software architecture.",
    ),
    "newsPolitics": (
        "Breaking news: Senate Democrats and Republicans clash over midterm polling and White House strategy.",
        "Cable news pundits debate presidential election horse-race numbers, parliament votes, and foreign policy spin.",
        "Partisan campaign talking points, government press briefing, and geopolitical media coverage.",
    ),
    "commercial": (
        "Limited time flash sale! Use promo code SAVE20 at checkout to buy our new merch drop now.",
        "Sponsored product launch: upgrade to a paid newsletter subscription or click our affiliate storefront link.",
        "Pre-order our SaaS plan today, discount giveaway, crypto token drop, and brand partnership.",
    ),
    "matureContent": (
        "Explicit 18+ NSFW adult sexual content, sensual erotica, nudity, and pornography.",
        "Adult boudoir photography, fetish kink media, and mature explicit art.",
    ),
}

_OUTRAGE_COUNTER_EXEMPLARS: tuple[str, ...] = (
    "Unpopular opinion: everyone who disagrees with me is a delusional idiot ruining society!",
    "Why is nobody talking about this outrageous hot take, ratio these clowns!",
)


class _ThreadSafeEmbeddingAdapter:
    """Serializes all SentenceTransformer.encode() calls across HTTP worker threads."""

    def __init__(self, model: Any) -> None:
        self._model = model

    def encode(self, sentences: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("show_progress_bar", False)
        with _ENCODE_LOCK:
            try:
                import torch
                with torch.inference_mode():
                    return self._model.encode(sentences, **kwargs)
            except ImportError:
                return self._model.encode(sentences, **kwargs)


def reset_semantic_scorer_cache() -> None:
    with _CACHE_LOCK:
        _VEC_CACHE.clear()


def get_shared_embedding_model(*, local_files_only: bool = True) -> _ThreadSafeEmbeddingAdapter | None:
    """Return the single process-wide thread-safe SentenceTransformer adapter."""
    global _MODEL, _ADAPTER, _MODEL_UNAVAILABLE
    if _ADAPTER is not None:
        return _ADAPTER
    if _MODEL_UNAVAILABLE and local_files_only:
        return None
    with _ENCODE_LOCK:
        if _ADAPTER is not None:
            return _ADAPTER
        if _MODEL_UNAVAILABLE and local_files_only:
            return None
        try:
            os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
            os.environ.setdefault("OPENBLAS_NUM_THREADS", "8")
            os.environ.setdefault("OMP_NUM_THREADS", "4")
            os.environ.setdefault("MKL_NUM_THREADS", "4")
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
            try:
                import torch
                torch.set_num_threads(min(4, os.cpu_count() or 4))
            except Exception:
                pass
            from sentence_transformers import SentenceTransformer

            try:
                _MODEL = SentenceTransformer("all-MiniLM-L6-v2", device="cpu", local_files_only=True)
            except Exception:
                if local_files_only:
                    raise
                _MODEL = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
            _MODEL_UNAVAILABLE = False
            _ADAPTER = _ThreadSafeEmbeddingAdapter(_MODEL)
            return _ADAPTER
        except Exception:
            if local_files_only:
                _MODEL_UNAVAILABLE = True
            return None


def _get_local_embedding_model():
    return get_shared_embedding_model(local_files_only=True)


def encode_texts_threadsafe(texts: list[str], *, normalize_embeddings: bool = True):
    adapter = get_shared_embedding_model(local_files_only=True)
    if adapter is None:
        return None
    return adapter.encode(texts, normalize_embeddings=normalize_embeddings, show_progress_bar=False)


def _encode_texts(texts: list[str], encode_fn: Callable[[list[str]], Any] | None = None):
    if not texts:
        return []
    import numpy as np

    missing_indices: list[int] = []
    missing_texts: list[str] = []
    results: list[Any] = [None] * len(texts)

    with _LOCK:
        for i, raw_txt in enumerate(texts):
            txt = str(raw_txt or "").encode("utf-8", errors="replace").decode("utf-8")
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
            vecs = encode_texts_threadsafe(missing_texts, normalize_embeddings=True)
            if vecs is None:
                return None

        with _CACHE_LOCK:
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
    include_axes: bool = False,
    encode_fn: Callable[[list[str]], Any] | None = None,
) -> dict[str, Any]:
    """
    Score post snippets against concept anchors, multi-axis slider prototypes, and personal taste
    exemplars using cached CPU embeddings.
    Returns { "available": bool, "scores": { id: float }, "axisScores": { id: dict }, "tasteScores": { id: float } }.
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
    if not valid_items or (not include_axes and not boost and not dampen and not pos_ex and not neg_ex):
        return {"available": bool(encode_fn or _MODEL), "scores": {}, "axisScores": {}, "tasteScores": {}}

    pole_names = list(POLE_EXEMPLARS.keys()) if include_axes else []
    pole_texts: list[str] = []
    pole_counts: list[int] = []
    for p_name in pole_names:
        ex_list = POLE_EXEMPLARS[p_name]
        pole_counts.append(len(ex_list))
        pole_texts.extend(ex_list)
    counter_texts = list(_OUTRAGE_COUNTER_EXEMPLARS) if include_axes else []

    all_texts = [
        *boost,
        *dampen,
        *(txt for txt, _ in pos_ex),
        *(txt for txt, _ in neg_ex),
        *pole_texts,
        *counter_texts,
        *(txt for _, txt in valid_items),
    ]
    vectors = _encode_texts(all_texts, encode_fn=encode_fn)
    if vectors is None:
        return {"available": False, "scores": {}, "axisScores": {}, "tasteScores": {}}

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

    pole_centroids: dict[str, Any] = {}
    for p_name, cnt in zip(pole_names, pole_counts):
        c_vec = _weighted_centroid(vectors[offset : offset + cnt], [1.0] * cnt, np)
        pole_centroids[p_name] = c_vec
        offset += cnt

    rage_centroid = None
    if include_axes and counter_texts:
        rage_centroid = _weighted_centroid(vectors[offset : offset + len(counter_texts)], [1.0] * len(counter_texts), np)
        offset += len(counter_texts)

    item_vecs = np.stack(vectors[offset:])

    mean_center = None
    pole_dirs: dict[str, Any] = {}
    if include_axes and pole_centroids:
        mean_center = np.mean(np.stack(list(pole_centroids.values())), axis=0)

        def _norm_vec(v: Any) -> Any:
            n = float(np.linalg.norm(v))
            return (v / n) if n > 1e-8 else v

        u_sci = _norm_vec(pole_centroids["scienceTheory"] - mean_center)
        pole_dirs["scienceTheory"] = u_sci

        chatter_raw = pole_centroids["everydayChatter"] - mean_center
        if rage_centroid is not None:
            chatter_raw = chatter_raw - 0.40 * (rage_centroid - mean_center)
        pole_dirs["everydayChatter"] = _norm_vec(chatter_raw)

        news_raw = pole_centroids["newsPolitics"] - mean_center
        news_sci_proj = max(0.0, float(np.dot(news_raw, u_sci)))
        pole_dirs["newsPolitics"] = _norm_vec(news_raw - 0.40 * news_sci_proj * u_sci)

        pole_dirs["commercial"] = _norm_vec(pole_centroids["commercial"] - mean_center)
        pole_dirs["matureContent"] = _norm_vec(pole_centroids["matureContent"] - mean_center)

    pos_mat = np.stack(pos_list) if pos_list else None
    pos_centroid = _weighted_centroid(pos_list, [w for _, w in pos_ex], np) if pos_list else None
    neg_mat = np.stack(neg_list) if neg_list else None
    neg_centroid = _weighted_centroid(neg_list, [w for _, w in neg_ex], np) if neg_list else None

    scores: dict[str, float] = {}
    axis_scores: dict[str, dict[str, float]] = {}
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

        if include_axes and mean_center is not None:
            v_centered = vec - mean_center
            axis_scores[item_id] = {
                p_name: round(max(-1.0, min(1.0, float(np.dot(u_dir, v_centered)) / 0.28)), 4)
                for p_name, u_dir in pole_dirs.items()
            }

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
            taste_scores[item_id] = round(max(-1.0, min(1.0, pos_part - neg_part * 0.9)), 4)

    return {"available": True, "scores": scores, "axisScores": axis_scores, "tasteScores": taste_scores}
