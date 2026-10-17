"""Forecasting model plugged into run_forecasts.py (contract in forecasting/README.md).

Thin adapter over the ML code in ml/:
  * top ~20% of items by volume -> Prophet with add_country_holidays('IN') + festival windows
  * slow movers -> category-level Prophet split by item share, else a 28-day moving average
  * a tier where the last holdout evaluation showed the seasonal-naive baseline winning
    uses that baseline instead (ml/reports/forecast_metrics.json, see evaluate_forecasts.py)
  * cold-start items (under forecasting.min_history_days of history) are skipped, so
    reorder_suggestions() falls back to its rule-based reorder level
Tunables live in ml/config.yaml. Safety stock and reorder points stay in SQL.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ML_DIR = Path(__file__).resolve().parents[1] / "ml"
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from forecasting.prophet_job import forecast_items  # noqa: E402  (ml/forecasting)
from forecasting.tiers import assign_tiers, baseline_overrides  # noqa: E402
from settings import load_config  # noqa: E402

# ml method names -> public.forecasts.method
METHODS = {"prophet": "prophet", "category": "category", "moving_avg": "moving_average",
           "seasonal_naive": "seasonal_naive", "rule": "rule"}


def daily_frame(series: dict[str, dict[date, float]], today: date) -> tuple[pd.DataFrame, pd.Series]:
    """Wide days x products frame ending yesterday (today is still in progress), plus first-sale dates."""
    days = [d for hist in series.values() for d, q in hist.items() if q > 0 and d < today]
    if not days:
        return pd.DataFrame(), pd.Series(dtype="datetime64[ns]")
    idx = pd.date_range(min(days), today - timedelta(days=1), freq="D")
    cols, first = {}, {}
    for pid, hist in series.items():
        s = pd.Series({pd.Timestamp(d): float(q) for d, q in hist.items() if d < today}, dtype=float)
        if (s > 0).any():
            cols[pid] = s.reindex(idx, fill_value=0.0)
            first[pid] = s[s > 0].index.min()
    return pd.DataFrame(cols, index=idx), pd.Series(first)


def forecast_business(business: dict, products: list[dict], series: dict[str, dict[date, float]],
                      today: date, horizon: int):
    cfg = load_config()
    daily, first = daily_frame(series, today)
    if daily.empty:
        return
    categories = {p["id"]: p.get("category") for p in products}
    tiers = {k: v for k, v in assign_tiers(daily, first, categories, cfg).items() if v != "rule"}
    if not tiers:
        return
    # Forecast from today so the first written row (today + 1) has the model's full context.
    fc = forecast_items(daily, tiers, categories, cfg, horizon + 1, start=pd.Timestamp(today),
                        overrides=baseline_overrides(business["id"]))
    for r in fc.itertuples(index=False):
        d = r.ds.date()
        if d <= today:
            continue
        yield {"product_id": r.item, "forecast_date": d, "yhat": float(r.yhat),
               "yhat_lower": float(r.yhat_lower), "yhat_upper": float(r.yhat_upper),
               "method": METHODS[r.method],
               "category": categories.get(r.item) if r.method == "category" else None}


def bundles_for_business(business: dict, db, today: date) -> list[dict]:
    """Apriori pairs over recent baskets (ml/shop/bundles.py); rules below min_lift are dropped."""
    from shop.bundles import bundle_rules

    cfg = load_config()
    since = (today - timedelta(days=cfg["shop"]["bundles"]["lookback_days"])).isoformat()
    rows = db.select("sale_items", {"select": "sale_id,product_id,sales!inner(sold_at)",
                                    "business_id": f"eq.{business['id']}", "sales.sold_at": f"gte.{since}"})
    if not rows:
        return []
    items = pd.DataFrame([{"sale_id": r["sale_id"], "product_id": r["product_id"],
                           "sold_at": r["sales"]["sold_at"], "qty": 1} for r in rows])
    products = pd.DataFrame({"product_id": items["product_id"].unique(), "name": items["product_id"].unique()})
    return [{"antecedent_ids": [r["antecedent_id"]], "consequent_ids": [r["consequent_id"]],
             "support": r["support"], "confidence": r["confidence"], "lift": r["lift"]}
            for r in bundle_rules(items, products, today + timedelta(days=1), cfg)]
