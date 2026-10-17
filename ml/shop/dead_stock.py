"""Dead-stock flags (FR-D1): items with stock on hand and no sale in N days."""

from __future__ import annotations

import datetime as dt

import pandas as pd


def discount_band(days_unsold: int, cfg: dict) -> str | None:
    band = None
    for b in sorted(cfg["shop"]["discount_bands"], key=lambda b: b["min_days"]):
        if days_unsold >= b["min_days"]:
            band = b["band"]
    return band


def dead_stock(products: pd.DataFrame, sale_items: pd.DataFrame, stock_batches: pd.DataFrame,
               as_of: dt.date, cfg: dict) -> list[dict]:
    n_days = cfg["shop"]["dead_stock_days"]
    sold = sale_items.dropna(subset=["product_id"])
    last_sale = pd.to_datetime(sold["sold_at"], format="ISO8601").dt.date.groupby(sold["product_id"]).max()
    batches = stock_batches[stock_batches["quantity"] > 0].copy()
    batches["value"] = batches["quantity"] * batches["cost_price"].fillna(0)
    stock = batches.groupby("product_id").agg(on_hand=("quantity", "sum"), value=("value", "sum"))

    out = []
    for p in products.itertuples():
        if p.product_id not in stock.index:
            continue
        last = last_sale.get(p.product_id)
        days = (as_of - last).days if last is not None else None
        if days is not None and days < n_days:
            continue
        s = stock.loc[p.product_id]
        out.append({
            "product_id": p.product_id,
            "name": p.name,
            "days_unsold": days,  # None = never sold since records began
            "last_sold": last.isoformat() if last is not None else None,
            "on_hand": round(float(s["on_hand"]), 2),
            "on_hand_value": round(float(s["value"]), 2),
            "suggested_discount": discount_band(days if days is not None else 10**6, cfg),
        })
    return sorted(out, key=lambda x: -x["on_hand_value"])
