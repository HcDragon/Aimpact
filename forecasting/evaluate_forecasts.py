"""Holdout evaluation on Supabase data: model vs seasonal-naive, per tier.

    python forecasting/evaluate_forecasts.py                    # all shops / restaurants
    python forecasting/evaluate_forecasts.py --business-id <uuid>

Writes ml/reports/forecast_metrics.json and ml/reports/evaluation.md. model.py reads the
metrics file and uses the baseline for any tier where it won, so run this before the
nightly job whenever the data changes materially.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

from model import daily_frame  # also puts ml/ on sys.path
from run_forecasts import HISTORY_DAYS, IST, Supabase

from forecasting.evaluate import evaluate_daily, write_markdown  # noqa: E402  (ml/forecasting)
from settings import REPORTS_DIR, load_config  # noqa: E402


def load_series(db: Supabase, business: dict, today: date):
    bid = business["id"]
    since = (today - timedelta(days=HISTORY_DAYS)).isoformat()
    usage = db.select("daily_usage", {"select": "product_id,day,qty", "business_id": f"eq.{bid}", "day": f"gte.{since}", "order": "product_id,day"})
    products = {p["id"]: p for p in db.select("products", {
        "select": "id,name,category,unit,kind", "business_id": f"eq.{bid}", "is_active": "eq.true", "kind": "neq.dish", "order": "id"})}
    series: dict[str, dict[date, float]] = defaultdict(dict)
    for u in usage:
        if u["product_id"] in products:
            d = date.fromisoformat(u["day"])
            series[u["product_id"]][d] = series[u["product_id"]].get(d, 0.0) + float(u["qty"])
    return products, series


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--business-id")
    a = ap.parse_args()
    cfg = load_config()
    db = Supabase()
    today = datetime.now(IST).date()
    params = {"select": "id,name,business_type,lead_time_days", "business_type": "neq.wholesaler", "order": "id"}
    if a.business_id:
        params["id"] = f"eq.{a.business_id}"

    results = {}
    for b in db.select("businesses", params):
        products, series = load_series(db, b, today)
        daily, first = daily_frame(series, today)
        if daily.shape[0] < cfg["forecasting"]["holdout_days"] + cfg["forecasting"]["min_history_days"]:
            print(f"{b['name']}: skipped, only {daily.shape[0]} days of history")
            continue
        lead = {pid: b.get("lead_time_days") or cfg["inventory"]["default_lead_time_days"] for pid in daily.columns}
        r = evaluate_daily(daily, first, {pid: p.get("category") for pid, p in products.items()}, cfg, lead_times=lead)
        r["name"] = b["name"]
        results[b["id"]] = r
        print(f"{b['name']}: " + ", ".join(f"{t} -> {v['winner']}" for t, v in r["tiers"].items()))

    out = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "model_version": cfg["model_version"], "businesses": results}
    command = "python forecasting/evaluate_forecasts.py " + " ".join(sys.argv[1:])
    # Stored for the app's evidence panel (public.forecast_evaluations); one row per business per run.
    db.insert("forecast_evaluations", [{
        "business_id": bid, "model_version": cfg["model_version"], "holdout_start": r["holdout_start"],
        "holdout_days": r["holdout_days"], "tiers": r["tiers"], "command": command.strip(),
    } for bid, r in results.items()])
    REPORTS_DIR.mkdir(exist_ok=True)
    (REPORTS_DIR / "forecast_metrics.json").write_text(json.dumps(out, indent=2))
    (REPORTS_DIR / "evaluation.md").write_text(
        write_markdown(out, command))
    print(f"wrote {REPORTS_DIR / 'evaluation.md'}")


if __name__ == "__main__":
    main()
