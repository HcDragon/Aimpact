"""Morning prep list per dish (FR-C2): today's forecast reduced by recent wastage."""

from __future__ import annotations

import datetime as dt
import math

import pandas as pd


def prep_list(dish_fc: pd.DataFrame, recipes: pd.DataFrame, wastage_log: pd.DataFrame,
              day: dt.date, cfg: dict) -> list[dict]:
    rc = cfg["restaurant"]
    since = day - dt.timedelta(days=rc["wastage_lookback_days"])
    waste = wastage_log.dropna(subset=["dish_id"]).copy()
    waste["date"] = pd.to_datetime(waste["date"]).dt.date
    waste = waste[(waste["date"] >= since) & (waste["date"] < day)]
    avg_waste = waste.groupby("dish_id")["qty"].sum() / rc["wastage_lookback_days"]

    names = recipes.set_index("dish_id")["name"]
    today = dish_fc[dish_fc["ds"].dt.date == day]
    out = []
    for r in today.itertuples():
        w = float(avg_waste.get(r.item, 0.0))
        cut = min(w, rc["max_wastage_reduction"] * float(r.yhat))
        prep = max(0, math.ceil(float(r.yhat) - cut - 1e-9))
        out.append({
            "dish_id": r.item,
            "dish": names.get(r.item, r.item),
            "forecast": round(float(r.yhat), 1),
            "forecast_upper": round(float(r.yhat_upper), 1),
            "avg_daily_wastage": round(w, 2),
            "prep_portions": prep,
            "note": (f"reduced by {cut:.1f} for recent wastage" if cut >= 0.5 else ""),
        })
    return sorted(out, key=lambda x: -x["prep_portions"])
