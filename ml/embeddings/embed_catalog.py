"""Embed catalog items with Gemini Embedding and write products.embedding (FR-G1, FR-G2).

    python -m embeddings.embed_catalog --business <id> [--backend local|supabase] [--all]

Only items without an embedding are embedded unless --all is given. In Supabase
the column is pgvector; locally it is stored as a JSON list.
"""

from __future__ import annotations

import argparse
import json

import pandas as pd

from db import get_store


def product_text(p) -> str:
    """What gets embedded for a catalog item: name plus category and unit for context."""
    return " | ".join(str(x) for x in (p.name, p.category, p.unit) if isinstance(x, str) and x)


def embed_business(business_id: str, backend: str | None, everything: bool) -> int:
    from gemini_client import Gemini

    store = get_store(backend)
    products = store.read("products", business_id)
    if not everything and "embedding" in products:
        products = products[products["embedding"].isna()]
    if products.empty:
        return 0
    vectors = Gemini().embed([product_text(p) for p in products.itertuples()])
    rows = pd.DataFrame({"product_id": products["product_id"], "business_id": business_id,
                         "embedding": [json.dumps(v) if backend != "supabase" else v for v in vectors]})
    return store.update_columns("products", business_id, "product_id", rows)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--business", required=True)
    p.add_argument("--backend", choices=["local", "supabase"])
    p.add_argument("--all", action="store_true", help="re-embed items that already have an embedding")
    a = p.parse_args()
    print(f"embedded {embed_business(a.business, a.backend, a.all)} products")


if __name__ == "__main__":
    main()
