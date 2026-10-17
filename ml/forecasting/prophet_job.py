"""Prophet forecasting with Indian holidays and festival windows (FR-A1..A5).

forecast_items() is the entry point: given a daily sales frame that ends the
day before the forecast starts, it returns one row per item per future day.
Nothing after the end of `daily` is ever visible to a model.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from forecasting.baseline import _frame, future_index, moving_average, rule_based, seasonal_naive

logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
logging.getLogger("prophet").setLevel(logging.WARNING)


class LeakageError(AssertionError):
    pass


def festival_holidays(cfg: dict) -> pd.DataFrame:
    rows = []
    for name, spec in cfg["forecasting"]["festivals"].items():
        for d in spec["dates"]:
            rows.append({"holiday": name, "ds": pd.Timestamp(d),
                         "lower_window": spec["lower_window"], "upper_window": spec["upper_window"]})
    return pd.DataFrame(rows)


def prophet_forecast(train: pd.Series, horizon: int, cfg: dict) -> pd.DataFrame:
    from prophet import Prophet

    fc = cfg["forecasting"]
    np.random.seed(cfg["seed"]["random_seed"])  # stable uncertainty samples
    m = Prophet(
        holidays=festival_holidays(cfg),
        weekly_seasonality=True,
        yearly_seasonality=len(train) >= 365,
        daily_seasonality=False,
        seasonality_mode="multiplicative",
        interval_width=fc["interval_width"],
        uncertainty_samples=fc["uncertainty_samples"],
    )
    m.add_country_holidays(country_name="IN")
    m.fit(pd.DataFrame({"ds": train.index, "y": train.to_numpy()}))
    future = pd.DataFrame({"ds": future_index(train, horizon)})
    pred = m.predict(future)
    return _frame(pred["ds"], pred["yhat"], pred["yhat_lower"], pred["yhat_upper"])


FORECASTERS = {
    "prophet": prophet_forecast,
    "moving_avg": moving_average,
    "rule": rule_based,
    "seasonal_naive": seasonal_naive,
}


def _check_no_leakage(daily: pd.DataFrame, start: pd.Timestamp) -> None:
    if len(daily) and daily.index.max() >= start:
        raise LeakageError(f"training data reaches {daily.index.max().date()}, forecast starts {start.date()}")


def forecast_items(daily: pd.DataFrame, tiers: dict[str, str], categories: dict[str, str | None],
                   cfg: dict, horizon: int, start: pd.Timestamp | None = None,
                   overrides: dict[str, str] | None = None) -> pd.DataFrame:
    """Forecast every item in `tiers`.

    overrides maps a tier to a replacement method (e.g. {"prophet": "seasonal_naive"})
    when the evaluation showed the baseline wins for that tier.
    """
    start = start or daily.index.max() + pd.Timedelta(days=1)
    _check_no_leakage(daily, start)
    overrides = overrides or {}
    out = []

    def emit(item, frame, method):
        frame = frame.copy()
        frame["item"], frame["method"] = item, method
        out.append(frame)

    category_items: dict[str, list[str]] = {}
    for item, tier in tiers.items():
        method = overrides.get(tier, tier)
        if tier == "category" and method == "category":
            category_items.setdefault(categories[item], []).append(item)
            continue
        emit(item, FORECASTERS[method](daily[item], horizon, cfg), method)

    # Category-level Prophet, split by each item's share of the last 90 days (FR-A3).
    for cat, items in category_items.items():
        total = daily[items].sum(axis=1)
        cat_fc = prophet_forecast(total, horizon, cfg)
        recent = daily[items].iloc[-90:].sum()
        shares = recent / recent.sum() if recent.sum() > 0 else pd.Series(1 / len(items), index=items)
        for item in items:
            f = cat_fc.copy()
            f[["yhat", "yhat_lower", "yhat_upper"]] *= float(shares[item])
            emit(item, f, "category")

    if not out:
        return pd.DataFrame(columns=["item", "ds", "yhat", "yhat_lower", "yhat_upper", "method"])
    return pd.concat(out, ignore_index=True)[["item", "ds", "yhat", "yhat_lower", "yhat_upper", "method"]]
