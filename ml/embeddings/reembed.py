"""Re-embed every catalog item after changing gemini.embedding_model or embedding_dim (FR-G3).

    python -m embeddings.reembed --business <id> [--business <id> ...] [--backend local|supabase]

Vectors from different models are not comparable, so this always re-embeds
everything. If the dimension changed, migrate the pgvector column first.
"""

from __future__ import annotations

import argparse

from embeddings.embed_catalog import embed_business
from settings import load_config


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--business", action="append", required=True)
    p.add_argument("--backend", choices=["local", "supabase"])
    a = p.parse_args()
    g = load_config()["gemini"]
    print(f"re-embedding with {g['embedding_model']} ({g['embedding_dim']} dims)")
    for b in a.business:
        print(f"  {b}: {embed_business(b, a.backend, everything=True)} products")


if __name__ == "__main__":
    main()
