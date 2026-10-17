-- Proposed ML-owned table (agree with the Supabase owner by hour 1).
-- dish_id and the methods 'recipe' / 'seasonal_naive' extend the PRD's proposed row.
create table if not exists forecasts (
  id             bigint generated always as identity primary key,
  business_id    uuid not null references businesses(business_id),
  product_id     uuid references products(product_id),
  dish_id        uuid,                                   -- restaurant dish forecasts
  forecast_date  date not null,
  yhat           numeric not null check (yhat >= 0),
  yhat_lower     numeric not null check (yhat_lower >= 0),
  yhat_upper     numeric not null check (yhat_upper >= 0),
  safety_stock   numeric not null default 0 check (safety_stock >= 0),
  reorder_point  numeric not null default 0 check (reorder_point >= 0),
  reorder_qty    numeric not null default 0 check (reorder_qty >= 0),
  method         text not null check (method in ('prophet','category','moving_avg','rule','recipe','seasonal_naive')),
  reason         text,
  model_version  text not null,
  generated_at   timestamptz not null default now(),
  is_synthetic   boolean not null default false,
  check ((product_id is null) <> (dish_id is null))
);
create index if not exists forecasts_business_date on forecasts (business_id, forecast_date);

-- ML-owned columns on teammate tables.
create extension if not exists vector;
alter table products add column if not exists embedding vector(768);
alter table reviews  add column if not exists sentiment text;
alter table reviews  add column if not exists aspects   jsonb;
