"""Leakage guard and non-model forecasters. No Prophet model is fitted here."""

import numpy as np
import pandas as pd
import pytest

from forecasting.baseline import moving_average, rule_based, seasonal_naive
from forecasting.prophet_job import LeakageError, forecast_items
from forecasting.tiers import assign_tiers, daily_sales


def series(n=120, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2026-06-01", periods=n, freq="D")
    return pd.DataFrame({"a": rng.poisson(10, n).astype(float), "b": rng.poisson(2, n).astype(float)}, index=idx)


def test_features_never_use_data_after_forecast_date(cfg):
    daily = series()
    start = pd.Timestamp("2026-08-15")
    with pytest.raises(LeakageError):
        forecast_items(daily, {"a": "moving_avg"}, {}, cfg, 14, start=start)
    train = daily[daily.index < start]
    tampered = daily.copy()
    tampered.loc[tampered.index >= start] = 10_000  # future values must not matter
    a = forecast_items(train, {"a": "moving_avg", "b": "rule"}, {}, cfg, 14, start=start)
    b = forecast_items(tampered[tampered.index < start], {"a": "moving_avg", "b": "rule"}, {}, cfg, 14, start=start)
    pd.testing.assert_frame_equal(a, b)
    assert a["ds"].min() == start


def test_daily_sales_excludes_the_run_date():
    items = pd.DataFrame({"product_id": ["a", "a", "a"], "qty": [1, 2, 99],
                          "sold_at": ["2026-10-15T10:00:00", "2026-10-16T10:00:00", "2026-10-17T09:00:00"]})
    d = daily_sales(items, "product_id", end=pd.Timestamp("2026-10-17").date())
    assert d.index.max() == pd.Timestamp("2026-10-16")
    assert d["a"].sum() == 3


@pytest.mark.parametrize("fn", [seasonal_naive, moving_average, rule_based])
def test_forecasters_clip_at_zero(cfg, fn):
    s = pd.Series([0, 0, 5, 0, 0, 30, 0] * 10, index=pd.date_range("2026-01-01", periods=70), dtype=float)
    out = fn(s, 14, cfg)
    assert len(out) == 14
    assert (out[["yhat", "yhat_lower", "yhat_upper"]] >= 0).all().all()
    assert (out["yhat_upper"] >= out["yhat"]).all()


def test_seasonal_naive_repeats_last_week(cfg):
    s = pd.Series(range(21), index=pd.date_range("2026-01-01", periods=21), dtype=float)
    out = seasonal_naive(s, 14, cfg)
    assert list(out["yhat"]) == list(range(14, 21)) * 2


def test_tiers(cfg):
    idx = pd.date_range("2026-01-01", periods=100)
    daily = pd.DataFrame({f"i{k}": float(10 - k) for k in range(10)}, index=idx)
    first = pd.Series({f"i{k}": idx[0] for k in range(10)})
    first["i9"] = idx[-10]  # cold start
    cats = {f"i{k}": ("snacks" if k in (5, 6) else None) for k in range(10)}
    tiers = assign_tiers(daily, first, cats, cfg)
    assert tiers["i9"] == "rule"
    assert [k for k, v in tiers.items() if v == "prophet"] == ["i0", "i1"]  # top 20% of 9 -> 2
    assert tiers["i5"] == tiers["i6"] == "category"
    assert tiers["i3"] == "moving_avg"
