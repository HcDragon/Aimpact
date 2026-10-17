"""Seasonal-naive and moving-average forecasters (FR-A3, FR-A6).

All forecasters share one signature: (train: pd.Series indexed by day, horizon, cfg)
-> DataFrame[ds, yhat, yhat_lower, yhat_upper], clipped at zero.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm


def future_index(train: pd.Series, horizon: int) -> pd.DatetimeIndex:
    return pd.date_range(train.index.max() + pd.Timedelta(days=1), periods=horizon, freq="D")


def _frame(idx, yhat, lower, upper) -> pd.DataFrame:
    out = pd.DataFrame({"ds": idx, "yhat": yhat, "yhat_lower": lower, "yhat_upper": upper})
    for c in ("yhat", "yhat_lower", "yhat_upper"):
        out[c] = out[c].clip(lower=0.0)
    return out


def _z(cfg: dict) -> float:
    return float(norm.ppf(0.5 + cfg["forecasting"]["interval_width"] / 2))


def seasonal_naive(train: pd.Series, horizon: int, cfg: dict, season: int = 7) -> pd.DataFrame:
    """Repeat the last `season` days; band from historical season-over-season errors."""
    idx = future_index(train, horizon)
    last = train.iloc[-season:].to_numpy()
    yhat = np.resize(last, horizon)
    resid = (train - train.shift(season)).dropna().iloc[-90:]
    sd = float(resid.std()) if len(resid) > 1 else float(train.std() or 0.0)
    return _frame(idx, yhat, yhat - _z(cfg) * sd, yhat + _z(cfg) * sd)


def moving_average(train: pd.Series, horizon: int, cfg: dict) -> pd.DataFrame:
    window = train.iloc[-cfg["forecasting"]["moving_average_days"]:]
    mu, sd = float(window.mean()), float(window.std() or 0.0)
    idx = future_index(train, horizon)
    yhat = np.full(horizon, mu)
    return _frame(idx, yhat, yhat - _z(cfg) * sd, yhat + _z(cfg) * sd)


def rule_based(train: pd.Series, horizon: int, cfg: dict) -> pd.DataFrame:
    """Cold start: average of whatever history exists, with a fixed proportional buffer."""
    sold = train[train.index >= train[train > 0].index.min()] if (train > 0).any() else train
    mu = float(sold.mean()) if len(sold) else 0.0
    factor = cfg["inventory"]["rule_safety_factor"]
    idx = future_index(train, horizon)
    yhat = np.full(horizon, mu)
    return _frame(idx, yhat, yhat * (1 - factor), yhat * (1 + factor))
