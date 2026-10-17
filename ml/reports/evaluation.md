# Forecast evaluation

Command: `python forecasting/evaluate_forecasts.py `
Generated: 2026-10-17T09:01:26+00:00

## Business aaaaaaaa-0000-0000-0000-000000000001

Holdout: 28 days from 2026-09-19.

| Tier | Items | Model WAPE | Naive WAPE | Model MAPE | Naive MAPE | Model coverage | Winner |
|---|---|---|---|---|---|---|---|
| category | 12 | 59.47 | 68.34 | 79.01 | 88.26 | 42.86 | model |
| moving_avg | 2 | 43.96 | 56.4 | 51.96 | 53.3 | 96.43 | model |
| prophet | 4 | 40.34 | 32.61 | 58.83 | 40.07 | 49.11 | seasonal_naive |

| Tier | Dynamic stockout days | Fixed stockout days | Dynamic avg on hand | Fixed avg on hand |
|---|---|---|---|---|
| category | 0.33 | 0.5 | 22.08 | 19.88 |
| moving_avg | 0.0 | 0.0 | 38.87 | 34.59 |
| prophet | 0.0 | 0.0 | 105.83 | 103.76 |

## Business aaaaaaaa-0000-0000-0000-000000000002

Holdout: 28 days from 2026-09-19.

| Tier | Items | Model WAPE | Naive WAPE | Model MAPE | Naive MAPE | Model coverage | Winner |
|---|---|---|---|---|---|---|---|
| category | 9 | 30.51 | 26.58 | 37.71 | 26.94 | 34.52 | seasonal_naive |
| prophet | 3 | 38.92 | 21.54 | 41.26 | 19.53 | 21.43 | seasonal_naive |

| Tier | Dynamic stockout days | Fixed stockout days | Dynamic avg on hand | Fixed avg on hand |
|---|---|---|---|---|
| category | 0.0 | 0.0 | 8.32 | 8.83 |
| prophet | 0.0 | 0.0 | 19.53 | 20.17 |

MAPE is computed on non-zero days only; WAPE is the primary metric because MAPE breaks on zero-sales days. Tiers where the seasonal-naive baseline wins are forecast with the baseline by run_nightly.py.
