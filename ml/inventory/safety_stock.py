"""Dynamic safety stock and reorder point from forecast uncertainty (FR-B1, FR-B2).

  safety_stock  = sum(yhat_upper - yhat) over the supplier lead time
  reorder_point = sum(yhat) over the lead time + safety_stock
  reorder_qty   = max(0, reorder_point - (on_hand + on_order)), rounded up to pack size

Results are never negative and respect the item's unit granularity.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class Policy:
    safety_stock: float
    reorder_point: float
    reorder_qty: float
    lead_time_days: int
    pack_size: float
    position: float


def unit_step(unit: str | None, cfg: dict) -> float:
    return 1.0 if (unit or "").lower() in cfg["inventory"]["countable_units"] else 0.1


def round_up(x: float, step: float) -> float:
    if x <= 0:
        return 0.0
    # Small epsilon so 4.000000001 does not become 5.
    return round(math.ceil(x / step - 1e-9) * step, 6)


def compute_policy(forecast: pd.DataFrame, lead_time_days: int, pack_size: float,
                   on_hand: float, on_order: float, unit: str | None, cfg: dict) -> Policy:
    """`forecast` holds one item's rows sorted by date, starting today."""
    lead = max(1, int(lead_time_days or cfg["inventory"]["default_lead_time_days"]))
    pack = float(pack_size) if pack_size and pack_size > 0 else float(cfg["inventory"]["default_pack_size"])
    window = forecast.iloc[:lead]
    yhat = window["yhat"].clip(lower=0)
    upper = window["yhat_upper"].clip(lower=0)
    step = unit_step(unit, cfg)

    safety = round_up(float((upper - yhat).clip(lower=0).sum()), step)
    rop = round_up(float(yhat.sum()) + safety, step)
    position = max(0.0, float(on_hand or 0)) + max(0.0, float(on_order or 0))
    shortfall = max(0.0, rop - position)
    qty = round_up(shortfall, pack) if shortfall > 0 else 0.0
    return Policy(safety, rop, qty, lead, pack, position)
