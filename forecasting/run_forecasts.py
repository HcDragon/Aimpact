"""Nightly forecasting job: reads usage history from Supabase, writes public.forecasts.

The ML model (Prophet + Apriori) is plugged in from forecasting/model.py — see forecasting/README.md
for the contract. Until model.py exists, a weekday-aware moving average is used so reorder points
still work.

    python forecasting/run_forecasts.py                 # all businesses
    python forecasting/run_forecasts.py --business-id <uuid> --horizon 14
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
IST = ZoneInfo("Asia/Kolkata")
HISTORY_DAYS = 365


class Supabase:
    def __init__(self) -> None:
        self.url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def select(self, table: str, params: dict) -> list[dict]:
        rows, offset, page = [], 0, 1000
        while True:
            r = requests.get(f"{self.url}/{table}", params=params,
                             headers={**self.h, "Range-Unit": "items", "Range": f"{offset}-{offset + page - 1}"}, timeout=120)
            r.raise_for_status()
            batch = r.json()
            rows += batch
            if len(batch) < page:
                return rows
            offset += page

    def delete(self, table: str, params: dict) -> None:
        requests.delete(f"{self.url}/{table}", params=params, headers=self.h, timeout=120).raise_for_status()

    def insert(self, table: str, rows: list[dict]) -> None:
        for i in range(0, len(rows), 500):
            requests.post(f"{self.url}/{table}", json=rows[i:i + 500], headers={**self.h, "Prefer": "return=minimal"},
                          timeout=120).raise_for_status()


def load_model():
    """forecasting/model.py, if your teammate has added it."""
    path = HERE / "model.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("forecast_model", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def baseline(history: dict[date, float], today: date, horizon: int) -> list[dict]:
    """Same-weekday mean of the last 4 weeks; upper bound = mean + 1.28 sd (≈90%)."""
    out = []
    for h in range(1, horizon + 1):
        d = today + timedelta(days=h)
        latest = d - timedelta(weeks=(h - 1) // 7 + 1)  # most recent same weekday on or before today
        same = [history.get(latest - timedelta(weeks=w), 0.0) for w in range(4)]
        mean = statistics.fmean(same)
        sd = statistics.pstdev(same) if len(same) > 1 else 0.0
        out.append({"ds": d, "yhat": mean, "yhat_lower": max(mean - 1.28 * sd, 0), "yhat_upper": mean + 1.28 * sd})
    return out


def run(db: Supabase, business: dict, horizon: int, model) -> int:
    bid = business["id"]
    today = datetime.now(IST).date()
    since = (today - timedelta(days=HISTORY_DAYS)).isoformat()
    usage = db.select("daily_usage", {"select": "product_id,day,qty", "business_id": f"eq.{bid}", "day": f"gte.{since}"})
    products = {p["id"]: p for p in db.select("products", {
        "select": "id,name,category,unit,kind", "business_id": f"eq.{bid}", "is_active": "eq.true", "kind": "neq.dish"})}

    series: dict[str, dict[date, float]] = defaultdict(dict)
    for u in usage:
        if u["product_id"] in products:
            d = date.fromisoformat(u["day"])
            series[u["product_id"]][d] = series[u["product_id"]].get(d, 0.0) + float(u["qty"])

    rows: list[dict] = []
    if model is not None and hasattr(model, "forecast_business"):
        # Teammate's model: full control (Prophet for top 20%, category/moving average for the rest).
        for f in model.forecast_business(business=business, products=list(products.values()), series=series,
                                         today=today, horizon=horizon):
            rows.append(f)
    else:
        for pid, hist in series.items():
            if len([v for v in hist.values() if v > 0]) < 7:
                continue  # too little history: the app uses rule-based reorder levels
            for p in baseline(hist, today, horizon):
                rows.append({"product_id": pid, "forecast_date": p["ds"], "yhat": p["yhat"], "yhat_lower": p["yhat_lower"],
                             "yhat_upper": p["yhat_upper"], "method": "moving_average"})

    payload = [{
        "business_id": bid,
        "product_id": r["product_id"],
        "category": r.get("category"),
        "forecast_date": str(r["forecast_date"]),
        "yhat": round(max(float(r["yhat"]), 0), 3),
        "yhat_lower": None if r.get("yhat_lower") is None else round(max(float(r["yhat_lower"]), 0), 3),
        "yhat_upper": None if r.get("yhat_upper") is None else round(max(float(r["yhat_upper"]), 0), 3),
        "method": r.get("method", "prophet"),
    } for r in rows]

    db.delete("forecasts", {"business_id": f"eq.{bid}", "forecast_date": f"gt.{today.isoformat()}"})
    db.insert("forecasts", payload)

    if model is not None and hasattr(model, "bundles_for_business"):
        bundles = model.bundles_for_business(business=business, db=db, today=today)
        db.delete("bundle_suggestions", {"business_id": f"eq.{bid}"})
        db.insert("bundle_suggestions", [{"business_id": bid, **b} for b in bundles])
    return len(payload)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--business-id")
    ap.add_argument("--horizon", type=int, default=14)
    a = ap.parse_args()
    db = Supabase()
    model = load_model()
    print("model:", "forecasting/model.py" if model else "moving-average baseline")
    params = {"select": "id,name,business_type", "business_type": "neq.wholesaler"}
    if a.business_id:
        params["id"] = f"eq.{a.business_id}"
    for b in db.select("businesses", params):
        try:
            print(f"{b['name']}: {run(db, b, a.horizon, model)} forecast rows")
        except Exception as e:  # one bad business must not stop the batch
            print(f"{b['name']}: FAILED {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
