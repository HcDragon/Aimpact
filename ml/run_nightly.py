"""Nightly ML job for one business.

    python run_nightly.py --business <business_id> [--backend local|supabase] [--as-of YYYY-MM-DD]

Reads sales, forecasts the next horizon_days, computes safety stock and
reorder fields, writes `forecasts`, and writes the restaurant / shop extras
(prep list, perishables, dead stock, bundles) to reports/<business_id>/.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time

import pandas as pd

from db import get_store
from forecasting.prophet_job import forecast_items
from forecasting.tiers import assign_tiers, daily_sales, first_sale_dates
from inventory.reorder import build_rows
from restaurant.ingredient_demand import ingredient_forecast, ingredient_history, perishable_flags
from restaurant.prep_list import prep_list
from settings import REPORTS_DIR, as_of_date, load_config
from shop.bundles import bundle_rules
from shop.dead_stock import dead_stock


def tier_overrides(business_id: str) -> dict[str, str]:
    """Use the baseline for any tier where the last evaluation showed it winning."""
    path = REPORTS_DIR / "forecast_metrics.json"
    if not path.exists():
        return {}
    metrics = json.loads(path.read_text()).get("businesses", {}).get(business_id, {})
    return {tier: "seasonal_naive" for tier, m in metrics.get("tiers", {}).items() if m.get("winner") == "seasonal_naive"}


def product_meta(products, suppliers, supplier_prices, stock_batches, purchase_orders, as_of, cfg) -> pd.DataFrame:
    inv = cfg["inventory"]
    meta = products.set_index("product_id")[["name", "unit", "supplier_id"]].copy()
    lead = suppliers.set_index("supplier_id")["lead_time_days"] if len(suppliers) else pd.Series(dtype=float)
    meta["lead_time_days"] = meta["supplier_id"].map(lead).fillna(inv["default_lead_time_days"]).astype(int)

    sp = supplier_prices.sort_values("effective_from").drop_duplicates("product_id", keep="last")
    meta["pack_size"] = meta.index.map(sp.set_index("product_id")["pack_size"]) if len(sp) else None
    meta["pack_size"] = meta["pack_size"].fillna(inv["default_pack_size"]).astype(float)

    sb = stock_batches.copy()
    if len(sb):
        expiry = pd.to_datetime(sb["expiry_date"], errors="coerce").dt.date
        sb = sb[expiry.isna() | (expiry >= as_of)]  # expired stock does not count
    meta["on_hand"] = meta.index.map(sb.groupby("product_id")["quantity"].sum()).fillna(0.0) if len(sb) else 0.0

    po = purchase_orders
    if len(po):
        po = po[po["status"].isin(["open", "sent", "pending", "confirmed"])]
    meta["on_order"] = meta.index.map(po.groupby("product_id")["qty"].sum()).fillna(0.0) if len(po) else 0.0
    return meta


def run(business_id: str, backend: str | None = None, as_of: dt.date | None = None, extras: bool = True) -> dict:
    t0 = time.time()
    cfg = load_config()
    store = get_store(backend)
    as_of = as_of or as_of_date(cfg)
    horizon = cfg["forecasting"]["horizon_days"]
    generated_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    t = {name: store.read(name, business_id) for name in (
        "businesses", "products", "sale_items", "stock_batches", "suppliers", "supplier_prices",
        "purchase_orders", "recipes", "recipe_ingredients", "wastage_log")}
    biz = t["businesses"]
    if biz.empty:
        raise SystemExit(f"business {business_id} not found")
    biz_type = biz.iloc[0]["type"]
    is_synthetic = bool(biz.iloc[0].get("is_synthetic", False))
    restaurant = biz_type == "restaurant"
    id_col = "dish_id" if restaurant else "product_id"

    daily = daily_sales(t["sale_items"], id_col, end=as_of)
    if daily.empty or daily.shape[1] == 0:
        raise SystemExit(f"no sales history for business {business_id} before {as_of}")
    if restaurant:
        categories = {}  # dishes have no category; slow movers use the moving average
    else:
        categories = t["products"].set_index("product_id")["category"].to_dict()
    tiers = assign_tiers(daily, first_sale_dates(t["sale_items"], id_col), categories, cfg)
    fc = forecast_items(daily, tiers, categories, cfg, horizon, start=pd.Timestamp(as_of),
                        overrides=tier_overrides(business_id))

    meta = product_meta(t["products"], t["suppliers"], t["supplier_prices"], t["stock_batches"],
                        t["purchase_orders"], as_of, cfg)
    if restaurant:
        dish_meta = pd.DataFrame({"unit": "plate"}, index=daily.columns)
        dish_rows = build_rows(business_id, fc, daily, dish_meta, as_of, cfg, "dish_id", is_synthetic, generated_at)
        ing_fc = ingredient_forecast(fc, t["recipe_ingredients"])
        ing_hist = ingredient_history(daily, t["recipe_ingredients"])
        ing_rows = build_rows(business_id, ing_fc, ing_hist, meta, as_of, cfg, "product_id", is_synthetic, generated_at)
        rows = pd.concat([dish_rows, ing_rows], ignore_index=True)
    else:
        rows = build_rows(business_id, fc, daily, meta, as_of, cfg, "product_id", is_synthetic, generated_at)

    written = store.write_forecasts(business_id, rows)
    summary = {
        "business_id": business_id, "type": biz_type, "as_of": as_of.isoformat(), "rows_written": written,
        "methods": pd.Series(tiers).value_counts().to_dict(),
        "reorder_items": int(rows.drop_duplicates(["product_id"]).query("reorder_qty > 0").shape[0]),
    }

    if extras:
        out_dir = REPORTS_DIR / business_id
        out_dir.mkdir(parents=True, exist_ok=True)
        if restaurant:
            extras_out = {
                "prep_list": prep_list(fc, t["recipes"], t["wastage_log"], as_of, cfg),
                "perishables": perishable_flags(ing_fc, t["stock_batches"], t["products"], as_of),
            }
        else:
            extras_out = {
                "dead_stock": dead_stock(t["products"], t["sale_items"], t["stock_batches"], as_of, cfg),
                "bundles": bundle_rules(t["sale_items"], t["products"], as_of, cfg),
            }
        for name, payload in extras_out.items():
            (out_dir / f"{name}.json").write_text(json.dumps(
                {"as_of": as_of.isoformat(), "is_synthetic": is_synthetic, "items": payload}, indent=2))
            summary[name] = len(payload)

    summary["seconds"] = round(time.time() - t0, 1)
    return summary


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--business", required=True, help="business_id to run for")
    p.add_argument("--backend", choices=["local", "supabase"], help="overrides storage.backend in config.yaml")
    p.add_argument("--as-of", help="forecast start date (default: config seed.as_of, else today)")
    p.add_argument("--no-extras", action="store_true", help="skip prep list / dead stock / bundles")
    a = p.parse_args()
    as_of = dt.date.fromisoformat(a.as_of) if a.as_of else None
    print(json.dumps(run(a.business, a.backend, as_of, extras=not a.no_extras), indent=2))


if __name__ == "__main__":
    main()
