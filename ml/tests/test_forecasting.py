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


def test_tier_wape_is_pooled_not_averaged(cfg):
    from forecasting.evaluate import evaluate_daily

    idx = pd.date_range("2026-01-01", periods=140, freq="D")
    rng = np.random.default_rng(1)
    # One busy item and one that sells almost nothing: a per-item average would be dominated by the slow one.
    daily = pd.DataFrame({"busy": rng.poisson(100, 140).astype(float), "slow": (rng.random(140) < 0.05).astype(float)}, index=idx)
    first = pd.Series({c: idx[0] for c in daily.columns})
    import forecasting.evaluate as ev
    real, real_tiers = ev.forecast_items, ev.assign_tiers
    ev.assign_tiers = lambda train, *a, **k: {c: "moving_avg" for c in train.columns}  # one shared tier
    ev.forecast_items = lambda train, tiers, *a, **k: pd.concat([
        moving_average(train[i], cfg["forecasting"]["holdout_days"], cfg).assign(item=i, method="moving_avg") for i in tiers])
    try:
        out = evaluate_daily(daily, first, {}, cfg, simulate_policy=False)
    finally:
        ev.forecast_items, ev.assign_tiers = real, real_tiers
    items = out["items"]
    pooled = sum(r["model"]["abs_err"] for r in items) / sum(r["actual"] for r in items) * 100
    tier = next(iter(out["tiers"].values()))
    assert tier["model"]["wape"] == pytest.approx(pooled, abs=0.01)
    assert tier["model"]["wape"] < 30  # the busy item dominates, as it should
