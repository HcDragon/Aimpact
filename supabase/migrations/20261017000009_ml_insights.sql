-- ML insights computed in Postgres so every client (app, Mini App, bot) gets the same numbers:
--   forecast_evaluations  holdout results written by forecasting/evaluate_forecasts.py
--   dead_stock()          stocked items with nothing sold/used for N days, with a discount band
--   perishable_risk()     batches that forecast demand will not use up before their recorded expiry
--   prep_list()           restaurant morning prep per dish: forecast minus recent wastage

-- ---------------------------------------------------------------- forecast evaluations
create table public.forecast_evaluations (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  generated_at  timestamptz not null default now(),
  model_version text,
  holdout_start date,
  holdout_days  int,
  -- {tier: {n_items, model: {mape, wape, coverage}, baseline: {...}, winner, policy_simulation?}}
  tiers         jsonb not null,
  command       text
);
create index on public.forecast_evaluations (business_id, generated_at desc);
alter table public.forecast_evaluations enable row level security;
create policy "members read evaluations" on public.forecast_evaluations for select to authenticated
  using (public.is_member(business_id));

-- ---------------------------------------------------------------- dead stock
create or replace function public.dead_stock(p_business_id uuid, p_days int default 30)
returns table (
  product_id uuid, name text, unit text, on_hand numeric, stock_value_paise bigint,
  last_used date, days_unsold int, suggested_discount text
) language plpgsql stable as $$
#variable_conflict use_column
declare v_today date := public.ist_today();
begin
  perform public.assert_member(p_business_id);
  return query
  with last_use as (
    select u.product_id, max(u.day) as last_day
    from public.daily_usage u where u.business_id = p_business_id
    group by u.product_id
  ),
  first_in as (
    select b.product_id, min((b.received_at at time zone 'Asia/Kolkata')::date) as first_day
    from public.stock_batches b where b.business_id = p_business_id
    group by b.product_id
  ),
  idle as (
    select ps.product_id, ps.name, ps.unit, ps.on_hand, ps.stock_value_paise, l.last_day,
           (v_today - coalesce(l.last_day, f.first_day, v_today))::int as days
    from public.product_stock ps
    left join last_use l on l.product_id = ps.product_id
    left join first_in f on f.product_id = ps.product_id
    where ps.business_id = p_business_id and ps.kind <> 'dish' and ps.is_active and ps.on_hand > 0
  )
  select i.product_id, i.name, i.unit, i.on_hand, i.stock_value_paise, i.last_day, i.days,
         case when i.days >= 90 then '30-50% or return to supplier'
              when i.days >= 60 then '20-30%'
              else '10-15%' end
  from idle i
  where i.days >= p_days
  order by i.stock_value_paise desc;
end;
$$;

-- ---------------------------------------------------------------- perishable risk
-- Batches are used earliest-expiry first. Daily demand is the nightly forecast where one exists,
-- otherwise the last 28 days' average. Only recorded expiry dates are used, never a guess.
create or replace function public.perishable_risk(p_business_id uuid)
returns table (
  product_id uuid, name text, unit text, batch_id uuid, batch_no text, qty_remaining numeric,
  expiry_date date, days_left int, use_before_expiry numeric, at_risk_qty numeric,
  at_risk_value_paise bigint, basis text
) language plpgsql stable as $$
#variable_conflict use_column
declare
  v_today date := public.ist_today();
  p record; b record;
  v_avg numeric; v_has_fc boolean; v_demand numeric; v_used numeric; v_take numeric; v_fc_sum numeric; v_fc_days int;
begin
  perform public.assert_member(p_business_id);
  for p in
    select ps.product_id, ps.name, ps.unit from public.product_stock ps
    where ps.business_id = p_business_id and ps.kind <> 'dish' and ps.is_active and ps.on_hand > 0
      and exists (select 1 from public.stock_batches sb where sb.product_id = ps.product_id
                  and sb.qty_remaining > 0 and sb.expiry_date >= v_today)
  loop
    select coalesce(sum(u.qty), 0) / 28.0 into v_avg from public.daily_usage u
    where u.business_id = p_business_id and u.product_id = p.product_id and u.day > v_today - 28 and u.day <= v_today;
    select exists (select 1 from public.forecasts f where f.business_id = p_business_id
                   and f.product_id = p.product_id and f.forecast_date > v_today) into v_has_fc;
    v_used := 0;
    for b in
      select sb.id, sb.batch_no, sb.qty_remaining, sb.expiry_date, sb.unit_cost_paise from public.stock_batches sb
      where sb.product_id = p.product_id and sb.qty_remaining > 0 and sb.expiry_date >= v_today
      order by sb.expiry_date, sb.received_at
    loop
      -- demand from today up to and including the expiry date
      select coalesce(sum(f.yhat), 0), count(*) into v_fc_sum, v_fc_days from public.forecasts f
      where f.business_id = p_business_id and f.product_id = p.product_id
        and f.forecast_date > v_today and f.forecast_date <= b.expiry_date;
      v_demand := v_avg + v_fc_sum + v_avg * greatest((b.expiry_date - v_today) - v_fc_days, 0);
      v_take := least(b.qty_remaining, greatest(v_demand - v_used, 0));
      v_used := v_used + v_take;
      if b.qty_remaining - v_take > 0.001 or b.expiry_date - v_today <= 2 then
        product_id := p.product_id; name := p.name; unit := p.unit; batch_id := b.id; batch_no := b.batch_no;
        qty_remaining := b.qty_remaining; expiry_date := b.expiry_date; days_left := b.expiry_date - v_today;
        use_before_expiry := round(v_take, 3); at_risk_qty := round(b.qty_remaining - v_take, 3);
        at_risk_value_paise := round((b.qty_remaining - v_take) * b.unit_cost_paise)::bigint;
        basis := case when v_has_fc then 'forecast' else '28-day average' end;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- restaurant prep list
-- Expected portions = the dish forecast for that day (nightly job), else the same weekday's average
-- over the last 4 weeks. Prep is cut by recent average wastage of the dish, by at most 30%.
create or replace function public.prep_list(p_business_id uuid, p_day date default null)
returns table (
  dish_id uuid, name text, expected numeric, avg_daily_wastage numeric, prep_qty numeric, basis text
) language plpgsql stable as $$
#variable_conflict use_column
declare v_day date := coalesce(p_day, public.ist_today());
begin
  perform public.assert_member(p_business_id);
  return query
  with dishes as (
    select pr.id, pr.name from public.products pr
    where pr.business_id = p_business_id and pr.kind = 'dish' and pr.is_active
  ),
  fc as (
    select f.product_id, f.yhat from public.forecasts f
    where f.business_id = p_business_id and f.forecast_date = v_day
  ),
  weekday as (
    select s.product_id, sum(s.qty) / 4.0 as avg_qty from public.daily_product_sales s
    where s.business_id = p_business_id and s.day < v_day and s.day >= v_day - 28
      and extract(isodow from s.day) = extract(isodow from v_day)
    group by s.product_id
  ),
  waste as (
    select w.product_id, sum(w.qty) / 14.0 as per_day from public.wastage_log w
    where w.business_id = p_business_id
      and (w.logged_at at time zone 'Asia/Kolkata')::date >= v_day - 14
      and (w.logged_at at time zone 'Asia/Kolkata')::date < v_day
    group by w.product_id
  ),
  calc as (
    select d.id, d.name, coalesce(fc.yhat, wd.avg_qty, 0) as exp_qty, coalesce(wa.per_day, 0) as w,
           case when fc.product_id is not null then 'forecast' else 'same weekday, last 4 weeks' end as how
    from dishes d
    left join fc on fc.product_id = d.id
    left join weekday wd on wd.product_id = d.id
    left join waste wa on wa.product_id = d.id
  )
  select c.id, c.name, round(c.exp_qty, 1), round(c.w, 2),
         greatest(ceil(c.exp_qty - least(c.w, 0.3 * c.exp_qty) - 0.000001), 0), c.how
  from calc c
  order by 5 desc, c.name;
end;
$$;
