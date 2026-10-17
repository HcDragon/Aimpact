"""Forecast and reorder values are never negative; quantities respect unit and pack size."""

import datetime as dt

import numpy as np
import pandas as pd
import pytest

from inventory.reorder import build_rows
from inventory.safety_stock import compute_policy, round_up
from tests.conftest import make_fc


def test_policy_formula(cfg):
    fc = make_fc("p", "2026-10-17", [10, 12, 14, 9], [14, 17, 20, 12])
    p = compute_policy(fc, lead_time_days=3, pack_size=12, on_hand=20, on_order=4, unit="packet", cfg=cfg)
    assert p.safety_stock == 15            # (4 + 5 + 6)
    assert p.reorder_point == 51           # 36 + 15
    assert p.reorder_qty == 36             # shortfall 27 rounded up to 3 packs of 12


def test_no_reorder_when_stock_covers(cfg):
    fc = make_fc("p", "2026-10-17", [1, 1, 1], [2, 2, 2])
    p = compute_policy(fc, 2, 6, on_hand=50, on_order=0, unit="pcs", cfg=cfg)
    assert p.reorder_qty == 0


def test_loose_units_round_to_tenths(cfg):
    fc = make_fc("p", "2026-10-17", [1.234, 1.0], [1.5, 1.2])
    p = compute_policy(fc, 2, 5, on_hand=0, on_order=0, unit="kg", cfg=cfg)
    assert p.safety_stock == pytest.approx(0.5)
    assert p.reorder_point == pytest.approx(2.8)
    assert p.reorder_qty == 5


@pytest.mark.parametrize("seed", range(25))
def test_never_negative_even_with_bad_inputs(cfg, seed):
    rng = np.random.default_rng(seed)
    yhat = rng.normal(0, 5, 14)                    # may be negative
    upper = yhat + rng.normal(0, 5, 14)            # may sit below yhat
    fc = make_fc("p", "2026-10-17", yhat, upper)
    p = compute_policy(fc, int(rng.integers(0, 6)), float(rng.choice([0, 1, 6, 24])),
                       on_hand=float(rng.normal(10, 30)), on_order=float(rng.normal(0, 5)),
                       unit=str(rng.choice(["pcs", "kg"])), cfg=cfg)
    assert min(p.safety_stock, p.reorder_point, p.reorder_qty) >= 0
    assert p.reorder_qty % p.pack_size == pytest.approx(0) or p.reorder_qty == 0


def test_round_up():
    assert round_up(4.0000000001, 1) == 4
    assert round_up(4.01, 1) == 5
    assert round_up(-3, 1) == 0
    assert round_up(25, 12) == 36


def test_rows_carry_reason_and_are_non_negative(cfg):
    fc = make_fc("p1", "2026-10-17", [5.0] * 14, [8.0] * 14)
    daily = pd.DataFrame({"p1": [5.0] * 28}, index=pd.date_range("2026-09-19", periods=28))
    meta = pd.DataFrame({"unit": ["packet"], "lead_time_days": [2], "pack_size": [12.0],
                         "on_hand": [3.0], "on_order": [0.0]}, index=["p1"])
    rows = build_rows("b1", fc, daily, meta, dt.date(2026, 10, 17), cfg, "product_id", True, "now")
    assert len(rows) == 14
    assert (rows[["yhat", "yhat_lower", "yhat_upper", "safety_stock", "reorder_point", "reorder_qty"]] >= 0).all().all()
    assert rows["reorder_qty"].iloc[0] == 24  # ROP 10 + 6 = 16, shortfall 13 -> 2 packs
    assert "below reorder point" in rows["reason"].iloc[0]
    assert set(rows["business_id"]) == {"b1"}
