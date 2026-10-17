"""Daily sales series and forecast-tier assignment (FR-A1, FR-A3, FR-A4).

Tiers:
  prophet    - top ~20% of items by sales volume with enough history
  category   - slow movers forecast at category level, split by item share
  moving_avg - slow movers with no usable category group
  rule       - cold start: too little history for any model
"""

from __future__ import annotations

import datetime as dt
import json
import math

import pandas as pd

from settings import REPORTS_DIR


def daily_sales(sale_items: pd.DataFrame, item_col: str, end: dt.date, start: dt.date | None = None) -> pd.DataFrame:
    """Wide frame: one row per calendar day strictly before `end`, one column per item, zeros filled."""
    df = sale_items.dropna(subset=[item_col]).copy()
    df["day"] = pd.to_datetime(df["sold_at"], format="ISO8601").dt.normalize()
    df = df[df["day"] < pd.Timestamp(end)]
    wide = df.pivot_table(index="day", columns=item_col, values="qty", aggfunc="sum")
    first = pd.Timestamp(start) if start else (wide.index.min() if len(wide) else pd.Timestamp(end))
    idx = pd.date_range(first, pd.Timestamp(end) - pd.Timedelta(days=1), freq="D")
    return wide.reindex(idx).fillna(0.0)


def first_sale_dates(sale_items: pd.DataFrame, item_col: str) -> pd.Series:
    df = sale_items.dropna(subset=[item_col])
    return pd.to_datetime(df["sold_at"], format="ISO8601").dt.normalize().groupby(df[item_col]).min()


def assign_tiers(daily: pd.DataFrame, first_sale: pd.Series, categories: dict[str, str | None], cfg: dict) -> dict[str, str]:
    fc = cfg["forecasting"]
    end = daily.index.max() + pd.Timedelta(days=1)
    tiers: dict[str, str] = {}
    eligible = []
    for item in daily.columns:
        history = (end - first_sale.get(item, end)).days
        if history < fc["min_history_days"]:
            tiers[item] = "rule"
        else:
            eligible.append(item)

    volume = daily[eligible].sum().sort_values(ascending=False)
    n_top = max(1, math.ceil(fc["top_share"] * len(volume))) if len(volume) else 0
    top = set(volume.index[:n_top])

    slow = [i for i in eligible if i not in top]
    by_cat: dict[str, list[str]] = {}
    for item in slow:
        by_cat.setdefault(categories.get(item) or "", []).append(item)
    for item in eligible:
        if item in top:
            tiers[item] = "prophet"
        elif (fc["slow_mover_method"] == "category" and categories.get(item)
              and len(by_cat[categories[item]]) >= fc["min_category_items"]):
            tiers[item] = "category"
        else:
            tiers[item] = "moving_avg"
    return tiers


def baseline_overrides(business_id: str) -> dict[str, str]:
    """Tiers where the last evaluation showed the seasonal-naive baseline winning."""
    path = REPORTS_DIR / "forecast_metrics.json"
    if not path.exists():
        return {}
    metrics = json.loads(path.read_text()).get("businesses", {}).get(business_id, {})
    return {tier: "seasonal_naive" for tier, m in metrics.get("tiers", {}).items() if m.get("winner") == "seasonal_naive"}
