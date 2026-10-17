"""Product matching (FR-E4, FR-G1, FR-G2).

Extracted names ("maggi", "parle g 20 pkt") are matched to catalog items before
anything is written. Embedding similarity is used when product embeddings exist;
otherwise a local fuzzy matcher keeps matching working with Gemini down.
Below matching.auto_match_threshold the owner is asked to pick.
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher

import numpy as np
import pandas as pd

from settings import load_config

_UNITS = r"\b(\d+(\.\d+)?\s*(g|gm|kg|ml|l|ltr|pcs|pkt|packet|pack|box|nos)?)\b"


def normalise(name: str) -> str:
    s = name.lower().replace("-", " ")
    s = re.sub(_UNITS, " ", s)
    s = re.sub(r"[^a-z0-9ऀ-ॿ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def fuzzy_score(query: str, name: str) -> float:
    q, n = normalise(query), normalise(name)
    if not q or not n:
        return 0.0
    whole = SequenceMatcher(None, q, n).ratio()
    q_tokens, n_tokens = q.split(), n.split()
    hits = [max(SequenceMatcher(None, t, u).ratio() for u in n_tokens) for t in q_tokens]
    # Every spoken token found in the catalog name ("maggi" in "maggi masala noodles").
    partial = 0.95 * float(np.mean([h >= 0.8 for h in hits])) * float(np.mean(hits))
    return round(max(whole, partial), 4)


def cosine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / (np.linalg.norm(a, axis=-1, keepdims=True) + 1e-12)
    b = b / (np.linalg.norm(b, axis=-1, keepdims=True) + 1e-12)
    return a @ b.T


def _embedding_matrix(products: pd.DataFrame) -> np.ndarray | None:
    if "embedding" not in products or products["embedding"].isna().any():
        return None
    return np.array([json.loads(e) if isinstance(e, str) else e for e in products["embedding"]], dtype=float)


def match(query: str, products: pd.DataFrame, query_vector: list[float] | None = None, k: int = 5) -> dict:
    """Top-k catalog candidates; `auto` is True only when the best is confidently above threshold."""
    thr = load_config()["matching"]["auto_match_threshold"]
    scores = np.array([fuzzy_score(query, n) for n in products["name"]])
    method = "fuzzy"
    emb = _embedding_matrix(products)
    if query_vector is not None and emb is not None:
        scores = np.maximum(scores, cosine(np.array([query_vector]), emb)[0])
        method = "embedding+fuzzy"
    order = np.argsort(-scores)[:k]
    cands = [{"product_id": products.iloc[i]["product_id"], "name": products.iloc[i]["name"],
              "score": round(float(scores[i]), 4)} for i in order]
    # Confident only when the best clears the threshold and is not tied with the runner-up.
    margin_ok = len(cands) < 2 or cands[0]["score"] - cands[1]["score"] >= 0.05
    auto = bool(cands) and cands[0]["score"] >= thr and margin_ok
    return {"query": query, "method": method, "auto": auto, "best": cands[0] if auto else None, "candidates": cands}


def merge_suggestions(products: pd.DataFrame) -> list[dict]:
    """Likely duplicate catalog items; suggested to the owner, never merged automatically."""
    thr = load_config()["matching"]["merge_suggest_threshold"]
    emb = _embedding_matrix(products)
    n = len(products)
    if emb is not None:
        sim = cosine(emb, emb)
    else:
        sim = np.array([[fuzzy_score(a, b) if i != j else 1.0 for j, b in enumerate(products["name"])]
                        for i, a in enumerate(products["name"])])
        sim = np.minimum(sim, sim.T)  # symmetric: both names must resemble each other
    out = []
    for i in range(n):
        for j in range(i + 1, n):
            if sim[i, j] >= thr:
                out.append({"a": products.iloc[i]["name"], "b": products.iloc[j]["name"],
                            "a_id": products.iloc[i]["product_id"], "b_id": products.iloc[j]["product_id"],
                            "similarity": round(float(sim[i, j]), 4)})
    return sorted(out, key=lambda x: -x["similarity"])
