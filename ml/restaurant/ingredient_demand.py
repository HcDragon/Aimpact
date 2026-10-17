"""Ingredient demand from dish forecasts x recipes (FR-C1) and perishable-first flags (FR-C3)."""

from __future__ import annotations

import datetime as dt

import pandas as pd


def ingredient_forecast(dish_fc: pd.DataFrame, recipe_ingredients: pd.DataFrame) -> pd.DataFrame:
    """Sum dish forecast x qty-per-dish per ingredient per day.

    Bounds are summed too, which treats dishes as moving together: a deliberately
    conservative band for safety stock.
    """
    merged = dish_fc.merge(recipe_ingredients[["dish_id", "product_id", "qty"]],
                           left_on="item", right_on="dish_id")
    for col in ("yhat", "yhat_lower", "yhat_upper"):
        merged[col] = merged[col] * merged["qty"]
    out = (merged.groupby(["product_id", "ds"], as_index=False)[["yhat", "yhat_lower", "yhat_upper"]].sum()
           .rename(columns={"product_id": "item"}))
    out["method"] = "recipe"
    return out[["item", "ds", "yhat", "yhat_lower", "yhat_upper", "method"]]


def ingredient_history(dish_daily: pd.DataFrame, recipe_ingredients: pd.DataFrame) -> pd.DataFrame:
    """Implied daily ingredient usage from past dish sales (for 'x normal' reason lines)."""
    cols = {}
    for pid, grp in recipe_ingredients.groupby("product_id"):
        usage = sum(dish_daily[d] * q for d, q in zip(grp["dish_id"], grp["qty"]) if d in dish_daily.columns)
        cols[pid] = usage
    return pd.DataFrame(cols, index=dish_daily.index)


def perishable_flags(ing_fc: pd.DataFrame, stock_batches: pd.DataFrame, products: pd.DataFrame,
                     as_of: dt.date, soon_days: int = 2) -> list[dict]:
    """Batches that forecast usage will not consume before their recorded expiry date.

    Uses recorded expiry dates only (never a guess). Batches are consumed
    first-expiry-first; expiry_date is the last usable day.
    """
    flags = []
    names = products.set_index("product_id")
    batches = stock_batches.dropna(subset=["expiry_date"]).copy()
    batches["expiry"] = pd.to_datetime(batches["expiry_date"]).dt.date
    batches = batches[(batches["expiry"] >= as_of) & (batches["quantity"] > 0)]
    for pid, grp in batches.sort_values("expiry").groupby("product_id"):
        f = ing_fc[ing_fc["item"] == pid]
        used = 0.0
        for b in grp.itertuples():
            usable = float(f[f["ds"].dt.date <= b.expiry]["yhat"].sum()) - used
            take = max(0.0, min(float(b.quantity), usable))
            used += take
            at_risk = float(b.quantity) - take
            days_left = (b.expiry - as_of).days
            if at_risk > 0.01 or days_left <= soon_days:
                p = names.loc[pid] if pid in names.index else None
                flags.append({
                    "product_id": pid,
                    "name": None if p is None else p["name"],
                    "unit": None if p is None else p["unit"],
                    "batch_id": b.batch_id,
                    "quantity": round(float(b.quantity), 2),
                    "expiry_date": b.expiry.isoformat(),
                    "days_left": days_left,
                    "forecast_use_before_expiry": round(take, 2),
                    "at_risk_qty": round(max(0.0, at_risk), 2),
                    "at_risk_value": round(max(0.0, at_risk) * float(b.cost_price or 0), 2),
                    "action": "use first" if at_risk <= 0.01 else "use first; push dishes that use it or discount",
                })
    return sorted(flags, key=lambda x: (x["days_left"], -x["at_risk_value"]))
