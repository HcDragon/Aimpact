# Forecasting job

Runs nightly, outside any request path. It reads usage history from Supabase and writes
`public.forecasts` (and optionally `public.bundle_suggestions`). The rest of the app only reads
those tables.

```bash
pip install -r forecasting/requirements.txt
python forecasting/run_forecasts.py                  # all businesses
python forecasting/run_forecasts.py --business-id <uuid> --horizon 14
```

Env (from the repo-root `.env`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## The model

`forecasting/model.py` is implemented: it adapts the ML package in [`ml/`](../ml/README.md)
(Prophet with `add_country_holidays('IN')` plus Diwali/Holi/Eid/Ganesh Chaturthi windows for the top
~20% of items, category-level Prophet or a 28-day moving average for slow movers, Apriori bundles).
Items with too little history are skipped so `reorder_suggestions()` uses its rule-based level.
Tunables are in `ml/config.yaml`.

```bash
python forecasting/evaluate_forecasts.py   # holdout: model vs seasonal-naive -> ml/reports/evaluation.md
python forecasting/run_forecasts.py        # uses the baseline for any tier where it won
```

`method` can also be `seasonal_naive` (migration `20261017000008_forecast_methods.sql`).

## Plugging in the model (contract)

`run_forecasts.py` already handles reading data, writing results and the per-business loop.
Put the model in **`forecasting/model.py`**. If that file exists, it is used; otherwise a
weekday moving-average baseline runs, so reorder points work from day one.

```python
# forecasting/model.py
from datetime import date

def forecast_business(business: dict, products: list[dict], series: dict[str, dict[date, float]],
                      today: date, horizon: int):
    """
    business: {"id", "name", "business_type"}
    products: [{"id", "name", "category", "unit", "kind"}]   # stock-tracked items only (no dishes)
    series:   {product_id: {date: qty_used}}                  # days with zero use are absent
    Yield one dict per product per future day (today+1 .. today+horizon):
      {"product_id": str, "forecast_date": date, "yhat": float,
       "yhat_lower": float | None, "yhat_upper": float | None,
       "method": "prophet" | "category" | "moving_average" | "rule"}
    """

def bundles_for_business(business: dict, db, today: date) -> list[dict]:   # optional (Apriori)
    """
    db.select("sale_items", {"select": "sale_id,product_id", "business_id": f"eq.{business['id']}"})
    Return [{"antecedent_ids": [uuid], "consequent_ids": [uuid], "support": float,
             "confidence": float, "lift": float}]
    """
```

Rules from CLAUDE.md that the model should follow:

- `add_country_holidays('IN')` so festivals are accounted for.
- Prophet for roughly the top 20% of items by volume. Use category-level forecasts or moving averages for slow movers.
- Items with too little history (fewer than 7 days with sales) can be skipped. The app then falls back to rule-based reorder levels.
- **Safety stock comes from `yhat_upper - yhat`.** The database sums it over the supplier lead time, so `yhat_upper` must be a real upper bound (Prophet's `interval_width`, default 0.8).

## What the data means

- `series` comes from the `daily_usage` view. For shops this is units sold per day. For restaurants
  it is ingredient consumption per day, already exploded through recipes. Forecast what is
  **stocked**, because that is what gets reordered.
- Dish-level sales (for menu planning) are in the `daily_product_sales` view if needed.
- Days are IST calendar days. Quantities are in each product's own `unit` (kg, l, pcs, ...).

## How forecasts are used

`reorder_suggestions()` in `supabase/migrations/*_business_logic.sql` works like this:

```
lead_demand   = Σ yhat              over the next lead_time_days
safety_stock  = Σ (yhat_upper-yhat) over the same days
reorder_point = max(lead_demand + safety_stock, manual reorder_level)
order_qty     = reorder_point + daily × min(7, shelf_life-1-lead_time) - on_hand
```

The job replaces all future rows for a business on every run, so re-running is safe.
