"""Builds `forecasts` rows with reorder fields and a one-line reason (FR-B3, FR-B4).

pg_cron (teammate-owned) reads these rows to raise alerts and create
purchase_orders. safety_stock / reorder_point / reorder_qty are today's
recommendation and are repeated on every row of the item's horizon.
"""

from __future__ import annotations

import datetime as dt

import pandas as pd

from inventory.safety_stock import Policy, compute_policy


def _fmt(x: float) -> str:
    return f"{x:.0f}" if abs(x - round(x)) < 1e-6 or x >= 10 else f"{x:.1f}"


def upcoming_festival(start: dt.date, horizon: int, cfg: dict) -> tuple[str, dt.date] | None:
    """The nearest festival whose demand window overlaps the forecast horizon."""
    end = start + dt.timedelta(days=horizon)
    best = None
    for name, spec in cfg["forecasting"]["festivals"].items():
        for d in spec["dates"]:
            day = dt.date.fromisoformat(d)
            window_start = day + dt.timedelta(days=spec["lower_window"])
            if window_start < end and day + dt.timedelta(days=spec["upper_window"]) >= start:
                if best is None or day < best[1]:
                    best = (name.replace("_", " ").title(), day)
    return best


def reason_line(forecast: pd.DataFrame, history: pd.Series, policy: Policy, unit: str,
                method: str, start: dt.date, cfg: dict) -> str:
    parts = []
    fest = upcoming_festival(start, len(forecast), cfg)
    recent = history.iloc[-28:]
    normal = float(recent.mean()) if len(recent) else 0.0
    next7 = float(forecast["yhat"].iloc[:7].mean())
    if fest:
        days = (fest[1] - start).days
        when = "today" if days == 0 else (f"in {days} days" if days > 0 else f"{-days} days ago")
        parts.append(f"{fest[0]} {when}")
    if normal > 0 and (next7 / normal >= 1.15 or next7 / normal <= 0.85):
        parts.append(f"next 7 days ~{next7 / normal:.1f}x normal ({_fmt(next7)} {unit}/day)")
    else:
        parts.append(f"steady ~{_fmt(next7)} {unit}/day")
    if policy.reorder_qty > 0:
        parts.append(f"stock {_fmt(policy.position)} below reorder point {_fmt(policy.reorder_point)}, "
                     f"order {_fmt(policy.reorder_qty)} (lead time {policy.lead_time_days}d)")
    if method == "rule":
        parts.append("new item, rule-based until more history")
    return "; ".join(parts)


def build_rows(business_id: str, fc: pd.DataFrame, daily: pd.DataFrame, items: pd.DataFrame,
               start: dt.date, cfg: dict, id_col: str, is_synthetic: bool, generated_at: str) -> pd.DataFrame:
    """`items` is indexed by item id with columns: unit, lead_time_days, pack_size, on_hand, on_order."""
    rows = []
    for item, f in fc.groupby("item", sort=False):
        f = f.sort_values("ds")
        meta = items.loc[item]
        if id_col == "product_id":
            policy = compute_policy(f, meta["lead_time_days"], meta["pack_size"],
                                    meta["on_hand"], meta["on_order"], meta["unit"], cfg)
        else:  # dishes are cooked, not stocked; their ingredients carry the policy
            policy = Policy(0.0, 0.0, 0.0, 0, 1.0, 0.0)
        history = daily[item] if item in daily.columns else pd.Series(dtype=float)
        method = f["method"].iloc[0]
        reason = reason_line(f, history, policy, meta["unit"], method, start, cfg)
        for r in f.itertuples():
            rows.append({
                "business_id": business_id,
                "product_id": item if id_col == "product_id" else None,
                "dish_id": item if id_col == "dish_id" else None,
                "forecast_date": r.ds.date().isoformat(),
                "yhat": round(float(r.yhat), 3),
                "yhat_lower": round(float(r.yhat_lower), 3),
                "yhat_upper": round(float(r.yhat_upper), 3),
                "safety_stock": policy.safety_stock,
                "reorder_point": policy.reorder_point,
                "reorder_qty": policy.reorder_qty,
                "method": method,
                "reason": reason,
                "model_version": cfg["model_version"],
                "generated_at": generated_at,
                "is_synthetic": bool(is_synthetic),
            })
    return pd.DataFrame(rows)
