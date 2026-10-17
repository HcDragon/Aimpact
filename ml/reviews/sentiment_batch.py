"""Nightly review sentiment batch (FR-F1). Writes reviews.sentiment and reviews.aspects only.

    python -m reviews.sentiment_batch --business <id> [--backend local|supabase]
"""

from __future__ import annotations

import argparse
import json

import pandas as pd

from db import get_store
from settings import load_config
from validators.common import _MISSING, parse_model_json, schema_errors


def check_batch(raw, expected_ids: list[str]) -> dict:
    x = parse_model_json(raw)
    if x is _MISSING:
        return {"valid": False, "errors": ["output is not valid JSON"]}
    errors = schema_errors("review", x)
    got = [r["review_id"] for r in x.get("reviews", [])] if not errors else []
    if not errors and sorted(got) != sorted(expected_ids):
        errors.append("review_ids do not match the batch")
    return {"valid": not errors, "errors": errors, "reviews": x.get("reviews", []) if not errors else []}


def main() -> None:
    from gemini_client import Gemini, GeminiUnavailable

    p = argparse.ArgumentParser()
    p.add_argument("--business", required=True)
    p.add_argument("--backend", choices=["local", "supabase"])
    a = p.parse_args()
    cfg = load_config()
    store = get_store(a.backend)
    reviews = store.read("reviews", a.business)
    todo = reviews[reviews["sentiment"].isna()] if "sentiment" in reviews else reviews
    gem, done = Gemini(), []
    size = cfg["reviews"]["batch_size"]
    for i in range(0, len(todo), size):
        batch = todo.iloc[i:i + size]
        payload = json.dumps([{"review_id": r.review_id, "text": r.text} for r in batch.itertuples()],
                             ensure_ascii=False)
        try:
            result = check_batch(gem.generate_json("review_sentiment", text=payload), list(batch["review_id"]))
        except GeminiUnavailable as e:
            print(f"stopping: {e}")
            break
        if not result["valid"]:
            print(f"skipped batch {i // size}: {result['errors']}")
            continue
        done += [{"review_id": r["review_id"], "business_id": a.business, "sentiment": r["sentiment"],
                  "aspects": json.dumps(r["aspects"])} for r in result["reviews"]]
    if done:
        store.update_columns("reviews", a.business, "review_id", pd.DataFrame(done))
    print(f"labelled {len(done)} of {len(todo)} reviews")


if __name__ == "__main__":
    main()
