"""Chronological holdout: model vs seasonal-naive, plus a reorder-policy simulation (FR-A6).

    python -m forecasting.evaluate --business <id> [--business <id> ...] [--backend local|supabase]

Writes reports/forecast_metrics.json and reports/evaluation.md. Nothing is
reported that did not come from this run; the command that produced the
numbers is written alongside them.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

import numpy as np
import pandas as pd

from db import get_store
from forecasting.baseline import seasonal_naive
from forecasting.prophet_job import forecast_items
from forecasting.tiers import assign_tiers, daily_sales, first_sale_dates
from settings import REPORTS_DIR, as_of_date, load_config


def mape(y: np.ndarray, yhat: np.ndarray) -> float | None:
    """MAPE over non-zero days only; it is undefined on zero-sales days."""
    mask = y > 0
    return float(np.mean(np.abs(y[mask] - yhat[mask]) / y[mask]) * 100) if mask.any() else None


def wape(y: np.ndarray, yhat: np.ndarray) -> float | None:
    total = np.abs(y).sum()
    return float(np.abs(y - yhat).sum() / total * 100) if total > 0 else None


def coverage(y, lower, upper) -> float:
    return float(np.mean((y >= lower) & (y <= upper)) * 100)


def simulate(demand: np.ndarray, rop: np.ndarray, lead: int, pack: float, start_stock: float,
             cycle: np.ndarray) -> dict:
    """Daily review: order up to rop + cycle demand when position < rop; arrives after lead days."""
    on_hand, pipeline, stockout_days, excess = start_stock, [], 0, []
    for t, d in enumerate(demand):
        on_hand += sum(q for due, q in pipeline if due == t)
        pipeline = [(due, q) for due, q in pipeline if due > t]
        if d > on_hand:
            stockout_days += 1
        on_hand = max(0.0, on_hand - d)
        position = on_hand + sum(q for _, q in pipeline)
        if position < rop[t]:
            q = np.ceil((rop[t] + cycle[t] - position) / pack) * pack
            pipeline.append((t + lead, q))
        excess.append(on_hand)
    return {"stockout_days": stockout_days, "avg_on_hand": float(np.mean(excess))}


def evaluate_daily(full: pd.DataFrame, first_sale: pd.Series, categories: dict, cfg: dict,
                   simulate_policy: bool = True, lead_times: dict | None = None) -> dict:
    """Holdout evaluation on a wide daily frame (days x items) that ends the day before the run date."""
    h = cfg["forecasting"]["holdout_days"]
    cutoff = full.index.max() - pd.Timedelta(days=h - 1)
    train, test = full[full.index < cutoff], full[full.index >= cutoff]
    first = first_sale[first_sale < cutoff]
    train = train[[c for c in train.columns if c in first.index]]
    tiers = {k: v for k, v in assign_tiers(train, first, categories, cfg).items() if v != "rule"}
    model_fc = forecast_items(train, tiers, categories, cfg, h, start=cutoff)

    per_item, sims = [], []
    lead_default = cfg["inventory"]["default_lead_time_days"]
    for item, tier in tiers.items():
        y = test[item].to_numpy()
        m = model_fc[model_fc["item"] == item].sort_values("ds")
        b = seasonal_naive(train[item], h, cfg)
        per_item.append({
            "item": item, "tier": tier,
            "actual": float(np.abs(y).sum()),
            "model": {"method": m["method"].iloc[0], "mape": mape(y, m["yhat"].to_numpy()),
                      "wape": wape(y, m["yhat"].to_numpy()), "abs_err": float(np.abs(y - m["yhat"].to_numpy()).sum()),
                      "coverage": coverage(y, m["yhat_lower"].to_numpy(), m["yhat_upper"].to_numpy())},
            "baseline": {"method": "seasonal_naive", "mape": mape(y, b["yhat"].to_numpy()),
                         "wape": wape(y, b["yhat"].to_numpy()), "abs_err": float(np.abs(y - b["yhat"].to_numpy()).sum()),
                         "coverage": coverage(y, b["yhat_lower"].to_numpy(), b["yhat_upper"].to_numpy())},
        })
        if simulate_policy:
            yhat, upper = m["yhat"].to_numpy(), m["yhat_upper"].to_numpy()
            lead = int((lead_times or {}).get(item, lead_default))
            dyn_rop = np.array([yhat[t:t + lead].sum() + (upper[t:t + lead] - yhat[t:t + lead]).sum()
                                for t in range(h)])
            mean = float(train[item].iloc[-28:].mean())
            fixed_rop = np.full(h, mean * lead * 1.5)
            cycle = np.full(h, mean * 7)
            sims.append({"tier": tier,
                         "dynamic": simulate(y, dyn_rop, lead, 1, dyn_rop[0], cycle),
                         "fixed": simulate(y, fixed_rop, lead, 1, fixed_rop[0], cycle)})

    tiers_out = {}
    for tier in sorted({r["tier"] for r in per_item}):
        rows = [r for r in per_item if r["tier"] == tier]
        agg = {}
        demand = sum(r["actual"] for r in rows)
        for side in ("model", "baseline"):
            agg[side] = {k: _mean([r[side][k] for r in rows]) for k in ("mape", "coverage")}
            # Pooled WAPE (total error / total demand): averaging per-item WAPE lets slow sellers dominate.
            agg[side]["wape"] = round(sum(r[side]["abs_err"] for r in rows) / demand * 100, 2) if demand else None
        winner = "model" if (agg["model"]["wape"] or 1e9) <= (agg["baseline"]["wape"] or 1e9) else "seasonal_naive"
        tiers_out[tier] = {"n_items": len(rows), **agg, "winner": winner}
        tier_sims = [s for s in sims if s["tier"] == tier]
        if tier_sims:
            tiers_out[tier]["policy_simulation"] = {
                p: {k: _mean([s[p][k] for s in tier_sims]) for k in ("stockout_days", "avg_on_hand")}
                for p in ("dynamic", "fixed")}
    return {"holdout_start": cutoff.date().isoformat(), "holdout_days": h, "tiers": tiers_out, "items": per_item}


def evaluate_business(store, business_id: str, as_of: dt.date, cfg: dict) -> dict:
    """Local CSV store (ml/data/). For Supabase use forecasting/evaluate_forecasts.py."""
    biz = store.read("businesses", business_id)
    restaurant = not biz.empty and biz.iloc[0]["type"] == "restaurant"
    id_col = "dish_id" if restaurant else "product_id"
    sale_items = store.read("sale_items", business_id)
    products = store.read("products", business_id)
    full = daily_sales(sale_items, id_col, end=as_of)
    categories = {} if restaurant else products.set_index("product_id")["category"].to_dict()
    out = evaluate_daily(full, first_sale_dates(sale_items, id_col), categories, cfg, simulate_policy=not restaurant)
    out["is_synthetic"] = bool(biz.iloc[0].get("is_synthetic", False)) if not biz.empty else None
    return out


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(float(np.mean(xs)), 2) if xs else None


def write_markdown(result: dict, command: str) -> str:
    lines = ["# Forecast evaluation", "", f"Command: `{command}`", f"Generated: {result['generated_at']}", ""]
    for biz, r in result["businesses"].items():
        label = " (SYNTHETIC data)" if r.get("is_synthetic") else ""
        lines += [f"## Business {biz}{label}", "",
                  f"Holdout: {r['holdout_days']} days from {r['holdout_start']}.", "",
                  "| Tier | Items | Model WAPE | Naive WAPE | Model MAPE | Naive MAPE | Model coverage | Winner |",
                  "|---|---|---|---|---|---|---|---|"]
        for tier, t in r["tiers"].items():
            lines.append(f"| {tier} | {t['n_items']} | {t['model']['wape']} | {t['baseline']['wape']} | "
                         f"{t['model']['mape']} | {t['baseline']['mape']} | {t['model']['coverage']} | {t['winner']} |")
        sims = {k: v["policy_simulation"] for k, v in r["tiers"].items() if "policy_simulation" in v}
        if sims:
            lines += ["", "| Tier | Dynamic stockout days | Fixed stockout days | Dynamic avg on hand | Fixed avg on hand |",
                      "|---|---|---|---|---|"]
            for tier, s in sims.items():
                lines.append(f"| {tier} | {s['dynamic']['stockout_days']} | {s['fixed']['stockout_days']} | "
                             f"{s['dynamic']['avg_on_hand']} | {s['fixed']['avg_on_hand']} |")
        lines.append("")
    lines += ["MAPE is computed on non-zero days only; WAPE is the primary metric because MAPE breaks on "
              "zero-sales days. Tiers where the seasonal-naive baseline wins are forecast with the baseline "
              "by run_nightly.py."]
    return "\n".join(lines) + "\n"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--business", action="append", required=True)
    p.add_argument("--backend", choices=["local", "supabase"])
    p.add_argument("--as-of")
    a = p.parse_args()
    cfg = load_config()
    as_of = dt.date.fromisoformat(a.as_of) if a.as_of else as_of_date(cfg)
    store = get_store(a.backend)
    result = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
              "model_version": cfg["model_version"],
              "businesses": {b: evaluate_business(store, b, as_of, cfg) for b in a.business}}
    REPORTS_DIR.mkdir(exist_ok=True)
    (REPORTS_DIR / "forecast_metrics.json").write_text(json.dumps(result, indent=2))
    (REPORTS_DIR / "evaluation.md").write_text(write_markdown(result, "python -m forecasting.evaluate " + " ".join(sys.argv[1:])))
    print(f"wrote {REPORTS_DIR / 'evaluation.md'}")


if __name__ == "__main__":
    main()
