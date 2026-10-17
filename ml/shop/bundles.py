"""Bundle suggestions with Apriori (FR-D2) on sale_items baskets."""

from __future__ import annotations

import datetime as dt

import pandas as pd


def baskets(sale_items: pd.DataFrame, as_of: dt.date, lookback_days: int) -> pd.DataFrame:
    """One-hot basket matrix: rows are sale_id, columns product_id."""
    df = sale_items.dropna(subset=["product_id"]).copy()
    df["day"] = pd.to_datetime(df["sold_at"], format="ISO8601").dt.date
    df = df[(df["day"] < as_of) & (df["day"] >= as_of - dt.timedelta(days=lookback_days))]
    return pd.crosstab(df["sale_id"], df["product_id"]).gt(0)


def bundle_rules(sale_items: pd.DataFrame, products: pd.DataFrame, as_of: dt.date, cfg: dict) -> list[dict]:
    from mlxtend.frequent_patterns import apriori, association_rules

    bc = cfg["shop"]["bundles"]
    onehot = baskets(sale_items, as_of, bc["lookback_days"])
    if onehot.empty or onehot.shape[1] < 2:
        return []
    frequent = apriori(onehot, min_support=bc["min_support"], use_colnames=True, max_len=2)
    if frequent.empty or (frequent["itemsets"].map(len) > 1).sum() == 0:
        return []
    rules = association_rules(frequent, metric="lift", min_threshold=bc["min_lift"])
    rules = rules[(rules["lift"] >= bc["min_lift"]) & (rules["confidence"] >= bc["min_confidence"])]
    names = products.set_index("product_id")["name"]

    out, seen = [], set()
    for r in rules.sort_values(["lift", "support"], ascending=False).itertuples():
        a, b = sorted(r.antecedents)[0], sorted(r.consequents)[0]
        pair = frozenset((a, b))
        if pair in seen:  # keep the stronger direction of each pair
            continue
        seen.add(pair)
        out.append({
            "if_bought": names.get(a, a), "also_buy": names.get(b, b),
            "antecedent_id": a, "consequent_id": b,
            "support": round(float(r.support), 4),
            "confidence": round(float(r.confidence), 3),
            "lift": round(float(r.lift), 2),
            "baskets": int(len(onehot)),
        })
        if len(out) >= bc["max_rules"]:
            break
    return out
