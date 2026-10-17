-- The forecasting model (forecasting/model.py) uses the seasonal-naive baseline for any item tier
-- where it beat Prophet on the holdout evaluation, and labels those rows honestly.
alter table public.forecasts drop constraint if exists forecasts_method_check;
alter table public.forecasts add constraint forecasts_method_check
  check (method in ('prophet', 'category', 'moving_average', 'seasonal_naive', 'rule'));
