-- Business logic. All numbers (stock, GST, COGS, profit, reorder points) are computed here,
-- never by an AI model. Functions are SECURITY INVOKER (RLS applies) and call assert_member().

create or replace function public.ist_today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- ---------------------------------------------------------------- onboarding
create or replace function public.create_business(
  p_name text, p_business_type text, p_phone text default null, p_gstin text default null,
  p_state_code text default null, p_city text default null, p_language text default 'en'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  insert into public.businesses (name, business_type, owner_id, phone, gstin, state_code, city, language)
  values (p_name, p_business_type, v_uid, p_phone, p_gstin, p_state_code, p_city, coalesce(p_language, 'en'))
  returning id into v_id;
  insert into public.staff_roles (business_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.users (id, phone, preferred_language) values (v_uid, p_phone, coalesce(p_language, 'en'))
  on conflict (id) do nothing;
  return v_id;
end;
$$;

-- Add a staff member by the phone/email they signed up with.
create or replace function public.add_staff(p_business_id uuid, p_login text, p_role text default 'staff')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not public.has_role(p_business_id, array['owner']) then
    raise exception 'only the owner can add staff' using errcode = '42501';
  end if;
  select id into v_user from auth.users
  where phone = regexp_replace(p_login, '\D', '', 'g') or lower(email) = lower(p_login) limit 1;
  if v_user is null then raise exception 'no user has signed up with %', p_login; end if;
  insert into public.staff_roles (business_id, user_id, role) values (p_business_id, v_user, p_role)
  on conflict (business_id, user_id) do update set role = excluded.role;
  return v_user;
end;
$$;

-- ---------------------------------------------------------------- triggers
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();
create trigger listings_touch before update on public.wholesaler_listings for each row execute function public.touch_updated_at();
create trigger po_touch before update on public.purchase_orders for each row execute function public.touch_updated_at();

-- Embed once on create or rename (never on search). Clears a stale vector and queues a job.
create or replace function public.queue_product_embedding() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' or new.name is distinct from old.name) and new.embedded_name is distinct from new.name then
    new.embedding := null;
    insert into public.ai_jobs (business_id, kind, payload)
    values (new.business_id, 'embed_product', jsonb_build_object('id', new.id))
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create or replace function public.queue_listing_embedding() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.name is distinct from old.name or new.description is distinct from old.description
     or new.image_path is distinct from old.image_path then
    new.embedding := null;
    insert into public.ai_jobs (business_id, kind, payload)
    values (new.business_id, 'embed_listing', jsonb_build_object('id', new.id))
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger products_embed before insert or update on public.products
  for each row execute function public.queue_product_embedding();
create trigger listings_embed before insert or update on public.wholesaler_listings
  for each row execute function public.queue_listing_embedding();

-- Reviews get sentiment in the nightly batch.
create or replace function public.queue_review_sentiment() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.review_text is not null and new.sentiment is null then
    insert into public.ai_jobs (business_id, kind, payload, run_after)
    values (new.business_id, 'review_sentiment', jsonb_build_object('id', new.id),
            -- batch into the nightly run (01:00 IST next day)
            ((public.ist_today() + 1)::timestamp + interval '1 hour') at time zone 'Asia/Kolkata')
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger reviews_sentiment after insert on public.reviews
  for each row execute function public.queue_review_sentiment();

-- ---------------------------------------------------------------- stock views
create or replace view public.product_stock with (security_invoker = true) as
select
  p.id as product_id, p.business_id, p.name, p.kind, p.category, p.unit, p.barcode,
  p.sell_price_paise, p.cost_price_paise, p.gst_rate, p.reorder_level, p.is_active,
  coalesce(sum(b.qty_remaining), 0)::numeric(12,3)                         as on_hand,
  min(b.expiry_date) filter (where b.qty_remaining > 0)                     as next_expiry,
  coalesce(sum(b.qty_remaining * b.unit_cost_paise), 0)::bigint             as stock_value_paise,
  count(b.id) filter (where b.qty_remaining > 0)                            as open_batches
from public.products p
left join public.stock_batches b on b.product_id = p.id and b.qty_remaining > 0
group by p.id;

create or replace view public.khata_balances with (security_invoker = true) as
select c.id as customer_id, c.business_id, c.name, c.phone,
  coalesce(sum(case when e.kind = 'credit' then e.amount_paise else -e.amount_paise end), 0)::bigint as balance_paise,
  max(e.created_at) as last_entry_at
from public.khata_customers c
left join public.khata_entries e on e.customer_id = c.id
group by c.id;

-- Daily quantity consumed per stocked item (direct sales + dish ingredients), in IST.
-- This is the input for the forecasting job and for moving-average reorder points.
create or replace view public.daily_usage with (security_invoker = true) as
select si.business_id, si.product_id, (s.sold_at at time zone 'Asia/Kolkata')::date as day, sum(si.qty) as qty
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.products p on p.id = si.product_id and p.kind <> 'dish'
group by 1, 2, 3
union all
select si.business_id, ri.ingredient_product_id, (s.sold_at at time zone 'Asia/Kolkata')::date, sum(si.qty * ri.qty / r.yield_qty)
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.recipes r on r.dish_product_id = si.product_id
join public.recipe_ingredients ri on ri.recipe_id = r.id
group by 1, 2, 3;

-- Units sold per product per day (dishes included) - what the forecasting job reads for menu items.
create or replace view public.daily_product_sales with (security_invoker = true) as
select si.business_id, si.product_id, p.name, p.category, p.kind,
  (s.sold_at at time zone 'Asia/Kolkata')::date as day,
  sum(si.qty) as qty, sum(si.line_total_paise)::bigint as revenue_paise
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.products p on p.id = si.product_id
group by 1, 2, 3, 4, 5, 6;

-- ---------------------------------------------------------------- stock movements
-- Take qty out of batches, earliest expiry first. Never fails for lack of stock:
-- the uncovered part is returned as short_qty and costed at the product's last cost.
create or replace function public._consume_stock(p_business_id uuid, p_product_id uuid, p_qty numeric,
  out cogs_paise bigint, out short_qty numeric)
language plpgsql as $$
declare b record; v_left numeric := p_qty; v_take numeric; v_cost numeric := 0; v_fallback bigint;
begin
  for b in
    select id, qty_remaining, unit_cost_paise from public.stock_batches
    where business_id = p_business_id and product_id = p_product_id and qty_remaining > 0
    order by expiry_date nulls last, received_at
    for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, b.qty_remaining);
    update public.stock_batches set qty_remaining = qty_remaining - v_take where id = b.id;
    v_cost := v_cost + v_take * b.unit_cost_paise;
    v_left := v_left - v_take;
  end loop;
  select coalesce(p.cost_price_paise, 0) into v_fallback from public.products p where p.id = p_product_id;
  short_qty := greatest(v_left, 0);
  cogs_paise := round(v_cost + short_qty * v_fallback);
end;
$$;

-- items: [{product_id, qty, unit_price_paise?}]  (unit price is GST inclusive; defaults to sell price)
create or replace function public.record_sale(
  p_business_id uuid, p_items jsonb, p_payment_mode text default 'cash', p_channel text default 'counter',
  p_khata_customer text default null, p_sold_at timestamptz default now(), p_external_order_id text default null
) returns jsonb language plpgsql as $$
declare
  v_sale uuid; v_item jsonb; v_p record; v_qty numeric; v_price bigint; v_line bigint; v_tax bigint;
  v_cogs bigint; v_short numeric; v_c record; v_ri record; v_recipe record; v_customer uuid;
  v_sub bigint := 0; v_taxsum bigint := 0; v_total bigint := 0; v_cogssum bigint := 0;
  v_touched uuid[] := '{}'; v_shortages jsonb := '[]'::jsonb;
begin
  perform public.assert_member(p_business_id);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'sale needs at least one item';
  end if;

  if p_external_order_id is not null then
    select id into v_sale from public.sales
    where business_id = p_business_id and channel = p_channel and external_order_id = p_external_order_id;
    if found then return jsonb_build_object('sale_id', v_sale, 'duplicate', true); end if;
  end if;

  if p_khata_customer is not null and length(trim(p_khata_customer)) > 0 then
    insert into public.khata_customers (business_id, name) values (p_business_id, trim(p_khata_customer))
    on conflict (business_id, name) do update set name = excluded.name
    returning id into v_customer;
  end if;

  insert into public.sales (business_id, sold_at, channel, payment_mode, khata_customer_id, external_order_id, created_by)
  values (p_business_id, coalesce(p_sold_at, now()), p_channel, p_payment_mode, v_customer, p_external_order_id, auth.uid())
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_p from public.products where id = (v_item ->> 'product_id')::uuid and business_id = p_business_id;
    if not found then raise exception 'unknown product %', v_item ->> 'product_id'; end if;
    v_qty   := (v_item ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'qty must be positive for %', v_p.name; end if;
    v_price := coalesce((v_item ->> 'unit_price_paise')::bigint, v_p.sell_price_paise, 0);
    v_line  := round(v_price * v_qty);
    v_tax   := round(v_line * v_p.gst_rate / (100 + v_p.gst_rate));
    v_cogs  := 0; v_short := 0;

    select * into v_recipe from public.recipes where dish_product_id = v_p.id;
    if v_p.kind = 'dish' and found then
      -- restaurant: deduct each ingredient pro rata
      for v_ri in select * from public.recipe_ingredients where recipe_id = v_recipe.id loop
        select * into v_c from public._consume_stock(p_business_id, v_ri.ingredient_product_id, v_qty * v_ri.qty / v_recipe.yield_qty);
        v_cogs := v_cogs + v_c.cogs_paise;
        if v_c.short_qty > 0 then
          v_shortages := v_shortages || jsonb_build_object('product_id', v_ri.ingredient_product_id, 'short_qty', v_c.short_qty);
        end if;
        v_touched := v_touched || v_ri.ingredient_product_id;
      end loop;
    elsif v_p.kind = 'dish' then
      v_cogs := round(coalesce(v_p.cost_price_paise, 0) * v_qty);  -- no recipe yet
    else
      select * into v_c from public._consume_stock(p_business_id, v_p.id, v_qty);
      v_cogs := v_c.cogs_paise; v_short := v_c.short_qty;
      if v_short > 0 then
        v_shortages := v_shortages || jsonb_build_object('product_id', v_p.id, 'short_qty', v_short);
      end if;
      v_touched := v_touched || v_p.id;
    end if;

    insert into public.sale_items (business_id, sale_id, product_id, qty, unit_price_paise, gst_rate, line_total_paise, tax_paise, cogs_paise, short_qty)
    values (p_business_id, v_sale, v_p.id, v_qty, v_price, v_p.gst_rate, v_line, v_tax, v_cogs, v_short);

    v_total := v_total + v_line; v_taxsum := v_taxsum + v_tax; v_cogssum := v_cogssum + v_cogs;
  end loop;
  v_sub := v_total - v_taxsum;

  update public.sales set subtotal_paise = v_sub, tax_paise = v_taxsum, total_paise = v_total, cogs_paise = v_cogssum
  where id = v_sale;

  if p_payment_mode = 'credit' then
    if v_customer is null then raise exception 'credit (udhaar) sale needs a customer name'; end if;
    insert into public.khata_entries (business_id, customer_id, kind, amount_paise, note, sale_id)
    values (p_business_id, v_customer, 'credit', v_total, 'Sale', v_sale);
  end if;

  perform public.refresh_stock_alerts(p_business_id, v_touched);

  return jsonb_build_object('sale_id', v_sale, 'total_paise', v_total, 'tax_paise', v_taxsum,
    'cogs_paise', v_cogssum, 'profit_paise', v_sub - v_cogssum, 'shortages', v_shortages, 'duplicate', false);
end;
$$;

-- purchase: {supplier_id?, supplier_name?, invoice_no?, invoice_date?, source?, bill_image_path?}
-- items:    [{product_id? | name + unit? + category? + sell_price_paise? + barcode?, qty, unit_cost_paise, gst_rate?, expiry_date?, batch_no?}]
-- Called only after the user confirms (manual entry, confirmed bill scan, confirmed voice command).
create or replace function public.record_purchase(p_business_id uuid, p_purchase jsonb, p_items jsonb)
returns jsonb language plpgsql as $$
declare
  v_purchase uuid; v_supplier uuid; v_item jsonb; v_pid uuid; v_qty numeric; v_cost bigint; v_rate numeric;
  v_tax bigint; v_pi uuid; v_sub bigint := 0; v_taxsum bigint := 0; v_type text; v_touched uuid[] := '{}';
  v_created int := 0;
begin
  perform public.assert_member(p_business_id);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'purchase needs at least one item';
  end if;
  select business_type into v_type from public.businesses where id = p_business_id;

  v_supplier := nullif(p_purchase ->> 'supplier_id', '')::uuid;
  if v_supplier is null and nullif(trim(p_purchase ->> 'supplier_name'), '') is not null then
    select id into v_supplier from public.suppliers
    where business_id = p_business_id and lower(name) = lower(trim(p_purchase ->> 'supplier_name')) limit 1;
    if v_supplier is null then
      insert into public.suppliers (business_id, name, gstin, phone)
      values (p_business_id, trim(p_purchase ->> 'supplier_name'), p_purchase ->> 'supplier_gstin', p_purchase ->> 'supplier_phone')
      returning id into v_supplier;
    end if;
  end if;

  insert into public.purchases (business_id, supplier_id, invoice_no, invoice_date, source, bill_image_path, created_by)
  values (p_business_id, v_supplier, p_purchase ->> 'invoice_no',
          coalesce(nullif(p_purchase ->> 'invoice_date', '')::date, public.ist_today()),
          coalesce(p_purchase ->> 'source', 'manual'), p_purchase ->> 'bill_image_path', auth.uid())
  returning id into v_purchase;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := nullif(v_item ->> 'product_id', '')::uuid;
    if v_pid is null then
      if nullif(trim(v_item ->> 'name'), '') is null then raise exception 'item needs product_id or name'; end if;
      select id into v_pid from public.products
      where business_id = p_business_id and lower(name) = lower(trim(v_item ->> 'name')) limit 1;
      if v_pid is null then
        insert into public.products (business_id, name, kind, unit, category, gst_rate, sell_price_paise, barcode, hsn_code)
        values (p_business_id, trim(v_item ->> 'name'),
                case when v_type = 'restaurant' then 'ingredient' else 'product' end,
                coalesce(v_item ->> 'unit', 'pcs'), v_item ->> 'category',
                coalesce((v_item ->> 'gst_rate')::numeric, 0), (v_item ->> 'sell_price_paise')::bigint,
                nullif(v_item ->> 'barcode', ''), v_item ->> 'hsn_code')
        returning id into v_pid;
        v_created := v_created + 1;
      end if;
    elsif not exists (select 1 from public.products where id = v_pid and business_id = p_business_id) then
      raise exception 'unknown product %', v_pid;
    end if;

    v_qty  := (v_item ->> 'qty')::numeric;
    v_cost := coalesce((v_item ->> 'unit_cost_paise')::bigint, 0);
    v_rate := coalesce((v_item ->> 'gst_rate')::numeric, (select gst_rate from public.products where id = v_pid));
    v_tax  := round(v_cost * v_qty * v_rate / 100);

    insert into public.purchase_items (business_id, purchase_id, product_id, qty, unit_cost_paise, gst_rate, tax_paise, batch_no, expiry_date)
    values (p_business_id, v_purchase, v_pid, v_qty, v_cost, v_rate, v_tax, v_item ->> 'batch_no', nullif(v_item ->> 'expiry_date', '')::date)
    returning id into v_pi;

    -- backdated bills are received on their invoice date (keeps FIFO and shelf-life estimates right)
    insert into public.stock_batches (business_id, product_id, purchase_item_id, batch_no, qty_received, qty_remaining, unit_cost_paise, expiry_date, received_at)
    values (p_business_id, v_pid, v_pi, v_item ->> 'batch_no', v_qty, v_qty, v_cost, nullif(v_item ->> 'expiry_date', '')::date,
            (select case when invoice_date < public.ist_today() then (invoice_date + time '09:00') at time zone 'Asia/Kolkata' else now() end
             from public.purchases where id = v_purchase));

    update public.products set cost_price_paise = v_cost where id = v_pid and v_cost > 0;
    if v_supplier is not null and v_cost > 0 then
      insert into public.supplier_prices (business_id, supplier_id, product_id, price_paise)
      values (p_business_id, v_supplier, v_pid, v_cost)
      on conflict (supplier_id, product_id) do update set price_paise = excluded.price_paise, updated_at = now();
    end if;

    v_sub := v_sub + round(v_cost * v_qty); v_taxsum := v_taxsum + v_tax;
    v_touched := v_touched || v_pid;
  end loop;

  update public.purchases set subtotal_paise = v_sub, tax_paise = v_taxsum, total_paise = v_sub + v_taxsum where id = v_purchase;
  perform public.refresh_stock_alerts(p_business_id, v_touched);

  return jsonb_build_object('purchase_id', v_purchase, 'supplier_id', v_supplier, 'subtotal_paise', v_sub,
    'tax_paise', v_taxsum, 'total_paise', v_sub + v_taxsum, 'products_created', v_created);
end;
$$;

create or replace function public.log_wastage(p_business_id uuid, p_product_id uuid, p_qty numeric,
  p_reason text default 'other', p_note text default null)
returns jsonb language plpgsql as $$
declare v_c record; v_id uuid;
begin
  perform public.assert_member(p_business_id);
  select * into v_c from public._consume_stock(p_business_id, p_product_id, p_qty);
  insert into public.wastage_log (business_id, product_id, qty, reason, cost_paise, note, created_by)
  values (p_business_id, p_product_id, p_qty, p_reason, v_c.cogs_paise, p_note, auth.uid())
  returning id into v_id;
  perform public.refresh_stock_alerts(p_business_id, array[p_product_id]);
  return jsonb_build_object('wastage_id', v_id, 'cost_paise', v_c.cogs_paise, 'short_qty', v_c.short_qty);
end;
$$;

-- Physical stock count: bring on-hand to p_counted_qty.
create or replace function public.adjust_stock(p_business_id uuid, p_product_id uuid, p_counted_qty numeric,
  p_expiry_date date default null)
returns jsonb language plpgsql as $$
declare v_on_hand numeric; v_diff numeric; v_cost bigint;
begin
  perform public.assert_member(p_business_id);
  select coalesce(sum(qty_remaining), 0) into v_on_hand from public.stock_batches
  where business_id = p_business_id and product_id = p_product_id and qty_remaining > 0;
  v_diff := p_counted_qty - v_on_hand;
  if v_diff < 0 then
    perform public._consume_stock(p_business_id, p_product_id, -v_diff);
  elsif v_diff > 0 then
    select coalesce(cost_price_paise, 0) into v_cost from public.products where id = p_product_id and business_id = p_business_id;
    insert into public.stock_batches (business_id, product_id, batch_no, qty_received, qty_remaining, unit_cost_paise, expiry_date)
    values (p_business_id, p_product_id, 'count-adjust', v_diff, v_diff, v_cost, p_expiry_date);
  end if;
  perform public.refresh_stock_alerts(p_business_id, array[p_product_id]);
  return jsonb_build_object('previous_qty', v_on_hand, 'new_qty', p_counted_qty, 'difference', v_diff);
end;
$$;

-- ---------------------------------------------------------------- khata
create or replace function public.khata_add(p_business_id uuid, p_customer text, p_kind text, p_amount_paise bigint,
  p_note text default null, p_phone text default null)
returns jsonb language plpgsql as $$
declare v_customer uuid; v_balance bigint;
begin
  perform public.assert_member(p_business_id);
  insert into public.khata_customers (business_id, name, phone) values (p_business_id, trim(p_customer), p_phone)
  on conflict (business_id, name) do update set phone = coalesce(excluded.phone, public.khata_customers.phone)
  returning id into v_customer;
  insert into public.khata_entries (business_id, customer_id, kind, amount_paise, note)
  values (p_business_id, v_customer, p_kind, p_amount_paise, p_note);
  select balance_paise into v_balance from public.khata_balances where customer_id = v_customer;
  return jsonb_build_object('customer_id', v_customer, 'balance_paise', v_balance);
end;
$$;

-- ---------------------------------------------------------------- reorder points
-- Demand per item over the lead time comes from, in order of preference:
--   1. forecasts written by the Python job (safety stock = sum(yhat_upper - yhat) over lead time)
--   2. 28-day moving average of usage (needs >= 14 days of history), 50% safety buffer
--   3. the manual reorder_level only (new businesses with little history)
-- A manual reorder_level is always a floor.
create or replace function public.reorder_suggestions(p_business_id uuid)
returns table (
  product_id uuid, name text, unit text, kind text, on_hand numeric, reorder_point numeric,
  suggested_qty numeric, avg_daily_demand numeric, safety_stock numeric, method text,
  supplier_id uuid, supplier_name text, unit_cost_paise bigint, next_expiry date
) language plpgsql stable as $$
declare v_lead int; v_today date := public.ist_today();
begin
  perform public.assert_member(p_business_id);
  select greatest(lead_time_days, 1) into v_lead from public.businesses where id = p_business_id;

  return query
  with stock as (
    select * from public.product_stock ps
    where ps.business_id = p_business_id and ps.kind <> 'dish' and ps.is_active
  ),
  fc as (
    select f.product_id, sum(f.yhat) as lead_demand,
           sum(greatest(coalesce(f.yhat_upper, f.yhat) - f.yhat, 0)) as safety,
           max(f.method) as method
    from public.forecasts f
    where f.business_id = p_business_id and f.product_id is not null
      and f.forecast_date > v_today and f.forecast_date <= v_today + v_lead
    group by f.product_id
  ),
  hist as (
    select u.product_id, sum(u.qty) / 28.0 as avg_daily, count(distinct u.day) as days_with_sales,
           (select min(day) from public.daily_usage d where d.business_id = p_business_id and d.product_id = u.product_id) as first_day
    from public.daily_usage u
    where u.business_id = p_business_id and u.day > v_today - 28 and u.day <= v_today
    group by u.product_id
  ),
  calc as (
    select s.*,
      case
        when fc.product_id is not null then fc.lead_demand / v_lead
        when h.first_day <= v_today - 14 then h.avg_daily
        else null
      end as daily,
      case
        when fc.product_id is not null then fc.safety
        when h.first_day <= v_today - 14 then h.avg_daily * v_lead * 0.5
        else 0
      end as safety_qty,
      case
        when fc.product_id is not null then fc.method
        when h.first_day <= v_today - 14 then 'moving_average'
        else 'rule'
      end as how
    from stock s
    left join fc on fc.product_id = s.product_id
    left join hist h on h.product_id = s.product_id
  ),
  points as (
    select c.*,
      greatest(coalesce(c.daily * v_lead + c.safety_qty, 0), coalesce(c.reorder_level, 0)) as rop
    from calc c
  ),
  -- typical shelf life from recent batches; perishables are ordered for at most (shelf life - 1) days
  shelf as (
    select b.product_id, percentile_cont(0.5) within group (order by b.expiry_date - (b.received_at at time zone 'Asia/Kolkata')::date) as days
    from public.stock_batches b
    where b.business_id = p_business_id and b.expiry_date is not null and b.received_at > now() - interval '90 days'
    group by b.product_id
  ),
  best_supplier as (
    select distinct on (sp.product_id) sp.product_id, sp.supplier_id, sp.price_paise
    from public.supplier_prices sp
    where sp.business_id = p_business_id
    order by sp.product_id, sp.price_paise
  )
  select p.product_id, p.name, p.unit, p.kind, p.on_hand,
    round(p.rop, 3),
    greatest(
      -- cover lead time + safety + up to one week (less for perishables)
      ceil(p.rop + coalesce(p.daily, 0) * greatest(least(7, coalesce(sh.days, 7) - 1 - v_lead), 0) - p.on_hand),
      coalesce(pr.reorder_qty, 0)
    )::numeric,
    round(coalesce(p.daily, 0), 3), round(p.safety_qty, 3), p.how,
    coalesce(pr.preferred_supplier_id, bs.supplier_id), sup.name,
    coalesce(psp.price_paise, bs.price_paise, pr.cost_price_paise),
    p.next_expiry
  from points p
  join public.products pr on pr.id = p.product_id
  left join shelf sh on sh.product_id = p.product_id
  left join best_supplier bs on bs.product_id = p.product_id
  left join public.supplier_prices psp on psp.product_id = p.product_id and psp.supplier_id = pr.preferred_supplier_id
  left join public.suppliers sup on sup.id = coalesce(pr.preferred_supplier_id, bs.supplier_id)
  where p.rop > 0 and p.on_hand <= p.rop
  order by (p.on_hand / nullif(p.rop, 0)) nulls first, p.name;
end;
$$;

-- Turn suggestions into one draft PO per supplier (skips items already on an open PO).
create or replace function public.create_draft_purchase_orders(p_business_id uuid)
returns jsonb language plpgsql as $$
declare v_s record; v_po uuid; v_count int := 0; v_lines int := 0;
begin
  perform public.assert_member(p_business_id);
  for v_s in
    select * from public.reorder_suggestions(p_business_id) r
    where r.suggested_qty > 0 and not exists (
      select 1 from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where po.business_id = p_business_id and po.status in ('draft', 'sent') and poi.product_id = r.product_id)
    order by r.supplier_id nulls last
  loop
    select id into v_po from public.purchase_orders
    where business_id = p_business_id and status = 'draft' and supplier_id is not distinct from v_s.supplier_id
      and created_at > now() - interval '1 minute'
    order by created_at desc limit 1;
    if v_po is null then
      insert into public.purchase_orders (business_id, supplier_id, note)
      values (p_business_id, v_s.supplier_id, 'Auto-created from reorder suggestions')
      returning id into v_po;
      v_count := v_count + 1;
    end if;
    insert into public.purchase_order_items (business_id, purchase_order_id, product_id, qty, unit_cost_paise)
    values (p_business_id, v_po, v_s.product_id, v_s.suggested_qty, coalesce(v_s.unit_cost_paise, 0));
    v_lines := v_lines + 1;
    v_po := null;
  end loop;
  update public.purchase_orders po set total_paise = (
    select coalesce(sum(round(qty * unit_cost_paise)), 0) from public.purchase_order_items where purchase_order_id = po.id)
  where po.business_id = p_business_id and po.status = 'draft';
  return jsonb_build_object('orders_created', v_count, 'lines', v_lines);
end;
$$;

-- p_expiry: optional {"<product_id>": "YYYY-MM-DD"} for the received goods.
create or replace function public.receive_purchase_order(p_po_id uuid, p_expiry jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare v_po record; v_items jsonb; v_res jsonb;
begin
  select * into v_po from public.purchase_orders where id = p_po_id;
  if not found then raise exception 'purchase order not found'; end if;
  perform public.assert_member(v_po.business_id);
  if v_po.status not in ('draft', 'sent') then raise exception 'purchase order is already %', v_po.status; end if;
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty, 'unit_cost_paise', unit_cost_paise,
                                      'expiry_date', p_expiry ->> product_id::text))
  into v_items from public.purchase_order_items where purchase_order_id = p_po_id;
  v_res := public.record_purchase(v_po.business_id,
    jsonb_build_object('supplier_id', v_po.supplier_id, 'source', 'purchase_order', 'invoice_no', 'PO-' || left(p_po_id::text, 8)),
    v_items);
  update public.purchase_orders set status = 'received', purchase_id = (v_res ->> 'purchase_id')::uuid where id = p_po_id;
  return v_res;
end;
$$;

-- ---------------------------------------------------------------- alerts
-- Stock alerts for specific products (called after every stock movement) or all products.
create or replace function public.refresh_stock_alerts(p_business_id uuid, p_product_ids uuid[] default null)
returns int language plpgsql as $$
declare v_s record; v_new int := 0; v_type text; v_word text; v_flagged uuid[] := '{}';
begin
  -- bulk loads (seed, CSV import) set this and run one refresh at the end
  if current_setting('app.skip_alerts', true) = 'on' then return 0; end if;
  select business_type into v_type from public.businesses where id = p_business_id;
  v_word := case when v_type = 'restaurant' then 'ingredient' else 'item' end;

  for v_s in
    select * from public.reorder_suggestions(p_business_id) r
    where p_product_ids is null or r.product_id = any (p_product_ids)
  loop
    v_flagged := v_flagged || v_s.product_id;
    insert into public.alerts (business_id, product_id, kind, severity, message, data, dedupe_key)
    values (p_business_id, v_s.product_id,
      case when v_s.on_hand <= 0 then 'out_of_stock' else 'low_stock' end,
      case when v_s.on_hand <= 0 then 'critical' else 'warning' end,
      case when v_s.on_hand <= 0 then format('%s is out of stock. Reorder %s %s.', v_s.name, v_s.suggested_qty, v_s.unit)
           else format('%s is running low: %s %s left. Reorder %s %s.', v_s.name, trim_scale(v_s.on_hand), v_s.unit, v_s.suggested_qty, v_s.unit) end,
      jsonb_build_object('on_hand', v_s.on_hand, 'reorder_point', v_s.reorder_point, 'suggested_qty', v_s.suggested_qty,
                         'method', v_s.method, 'supplier_name', v_s.supplier_name, 'word', v_word),
      'stock:' || v_s.product_id)
    on conflict (business_id, dedupe_key) where status = 'open' and dedupe_key is not null do update
      set message = excluded.message, data = excluded.data, kind = excluded.kind, severity = excluded.severity;
    v_new := v_new + 1;
  end loop;

  -- restocked items: close their stock alerts
  update public.alerts a set status = 'resolved'
  where a.business_id = p_business_id and a.status = 'open' and a.kind in ('low_stock', 'out_of_stock')
    and (p_product_ids is null or a.product_id = any (p_product_ids))
    and not (a.product_id = any (v_flagged));
  return v_new;
end;
$$;

-- Daily sweep: expiry + stock alerts for one business or all. Run by pg_cron.
create or replace function public.refresh_alerts(p_business_id uuid default null)
returns int language plpgsql as $$
declare v_b record; v_total int := 0; v_n int; v_today date := public.ist_today();
begin
  for v_b in select * from public.businesses where p_business_id is null or id = p_business_id loop
    perform public.assert_member(v_b.id);

    -- expired batches still on the shelf
    insert into public.alerts (business_id, product_id, kind, severity, message, data, dedupe_key)
    select v_b.id, b.product_id, 'expired', 'critical',
      format('%s (%s %s) expired on %s. Remove it from the shelf.', p.name, trim_scale(b.qty_remaining), p.unit, to_char(b.expiry_date, 'DD/MM/YYYY')),
      jsonb_build_object('batch_id', b.id, 'expiry_date', b.expiry_date, 'qty', b.qty_remaining,
                         'value_paise', round(b.qty_remaining * b.unit_cost_paise)),
      'expired:' || b.id
    from public.stock_batches b join public.products p on p.id = b.product_id
    where b.business_id = v_b.id and b.qty_remaining > 0 and b.expiry_date < v_today
    on conflict do nothing;

    -- expiring within the business's window
    insert into public.alerts (business_id, product_id, kind, severity, message, data, dedupe_key)
    select v_b.id, b.product_id, 'expiry_soon', case when b.expiry_date - v_today <= 2 then 'critical' else 'warning' end,
      format('%s %s of %s expire on %s (%s days). Sell or use first.', trim_scale(b.qty_remaining), p.unit, p.name,
             to_char(b.expiry_date, 'DD/MM/YYYY'), b.expiry_date - v_today),
      jsonb_build_object('batch_id', b.id, 'expiry_date', b.expiry_date, 'qty', b.qty_remaining, 'days_left', b.expiry_date - v_today,
                         'value_paise', round(b.qty_remaining * b.unit_cost_paise)),
      'expiry_soon:' || b.id
    from public.stock_batches b join public.products p on p.id = b.product_id
    where b.business_id = v_b.id and b.qty_remaining > 0
      and b.expiry_date between v_today and v_today + v_b.expiry_alert_days
    on conflict do nothing;

    -- close expiry alerts whose batch is used up, and "soon" alerts that have become "expired"
    update public.alerts a set status = 'resolved'
    from public.stock_batches b
    where a.business_id = v_b.id and a.status = 'open' and a.kind in ('expiry_soon', 'expired')
      and b.id = (a.data ->> 'batch_id')::uuid
      and (b.qty_remaining <= 0 or (a.kind = 'expiry_soon' and b.expiry_date < v_today));

    v_n := public.refresh_stock_alerts(v_b.id, null);
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------- reports
create or replace function public.profit_report(p_business_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable as $$
declare v jsonb;
begin
  perform public.assert_member(p_business_id);
  with s as (
    select * from public.sales where business_id = p_business_id
      and (sold_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  totals as (
    select coalesce(sum(total_paise), 0) as gross_sales, coalesce(sum(tax_paise), 0) as gst,
           coalesce(sum(subtotal_paise), 0) as revenue, coalesce(sum(cogs_paise), 0) as cogs, count(*) as bills
    from s
  ),
  waste as (
    select coalesce(sum(cost_paise), 0) as wastage from public.wastage_log
    where business_id = p_business_id and (logged_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ),
  by_product as (
    select si.product_id, p.name, sum(si.qty) as qty, sum(si.line_total_paise - si.tax_paise) as revenue,
           sum(si.cogs_paise) as cogs, sum(si.line_total_paise - si.tax_paise - si.cogs_paise) as profit
    from public.sale_items si join s on s.id = si.sale_id join public.products p on p.id = si.product_id
    group by 1, 2
  ),
  by_day as (
    select (sold_at at time zone 'Asia/Kolkata')::date as day, sum(subtotal_paise) as revenue,
           sum(subtotal_paise - cogs_paise) as profit, count(*) as bills
    from s group by 1
  ),
  by_channel as (
    select channel, sum(total_paise) as total, count(*) as bills from s group by 1
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'gross_sales_paise', t.gross_sales, 'gst_paise', t.gst, 'revenue_paise', t.revenue,
    'cogs_paise', t.cogs, 'gross_profit_paise', t.revenue - t.cogs, 'wastage_paise', w.wastage,
    'net_profit_paise', t.revenue - t.cogs - w.wastage, 'bills', t.bills,
    'margin_pct', case when t.revenue > 0 then round(100.0 * (t.revenue - t.cogs - w.wastage) / t.revenue, 2) else 0 end,
    'products', coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'qty', qty,
        'revenue_paise', revenue, 'cogs_paise', cogs, 'profit_paise', profit,
        'margin_pct', case when revenue > 0 then round(100.0 * profit / revenue, 2) else 0 end) order by profit desc) from by_product), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'revenue_paise', revenue, 'profit_paise', profit, 'bills', bills) order by day) from by_day), '[]'),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('channel', channel, 'total_paise', total, 'bills', bills)) from by_channel), '[]')
  ) into v from totals t, waste w;
  return v;
end;
$$;

-- GSTR-style summary. Assumes intra-state supply (CGST = SGST = half the tax).
create or replace function public.gst_report(p_business_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable as $$
declare v jsonb;
begin
  perform public.assert_member(p_business_id);
  with outward as (
    select si.gst_rate, sum(si.line_total_paise - si.tax_paise) as taxable, sum(si.tax_paise) as tax
    from public.sale_items si join public.sales s on s.id = si.sale_id
    where s.business_id = p_business_id and (s.sold_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    group by 1
  ),
  inward as (
    select pi.gst_rate, sum(round(pi.qty * pi.unit_cost_paise)) as taxable, sum(pi.tax_paise) as tax
    from public.purchase_items pi join public.purchases pu on pu.id = pi.purchase_id
    where pu.business_id = p_business_id and pu.invoice_date between p_from and p_to
    group by 1
  ),
  hsn as (
    select coalesce(p.hsn_code, '-') as hsn, p.unit, si.gst_rate, sum(si.qty) as qty,
           sum(si.line_total_paise - si.tax_paise) as taxable, sum(si.tax_paise) as tax
    from public.sale_items si join public.sales s on s.id = si.sale_id join public.products p on p.id = si.product_id
    where s.business_id = p_business_id and (s.sold_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    group by 1, 2, 3
  ),
  tot as (
    select (select coalesce(sum(tax), 0) from outward) as out_tax, (select coalesce(sum(tax), 0) from inward) as in_tax
  )
  select jsonb_build_object(
    'business', (select jsonb_build_object('name', name, 'gstin', gstin, 'state_code', state_code) from public.businesses where id = p_business_id),
    'from', p_from, 'to', p_to,
    'outward', coalesce((select jsonb_agg(jsonb_build_object('gst_rate', gst_rate, 'taxable_paise', taxable, 'tax_paise', tax,
        'cgst_paise', floor(tax / 2), 'sgst_paise', tax - floor(tax / 2)) order by gst_rate) from outward), '[]'),
    'inward', coalesce((select jsonb_agg(jsonb_build_object('gst_rate', gst_rate, 'taxable_paise', taxable, 'tax_paise', tax,
        'cgst_paise', floor(tax / 2), 'sgst_paise', tax - floor(tax / 2)) order by gst_rate) from inward), '[]'),
    'hsn_summary', coalesce((select jsonb_agg(jsonb_build_object('hsn', hsn, 'unit', unit, 'gst_rate', gst_rate, 'qty', qty,
        'taxable_paise', taxable, 'tax_paise', tax) order by hsn) from hsn), '[]'),
    'output_tax_paise', t.out_tax, 'input_tax_credit_paise', t.in_tax,
    'net_payable_paise', greatest(t.out_tax - t.in_tax, 0), 'itc_carry_forward_paise', greatest(t.in_tax - t.out_tax, 0)
  ) into v from tot t;
  return v;
end;
$$;

-- One call for the home screen (also the factual context the assistant answers from).
create or replace function public.dashboard(p_business_id uuid)
returns jsonb language plpgsql stable as $$
declare v_today date := public.ist_today(); v jsonb; v_type text;
begin
  perform public.assert_member(p_business_id);
  select business_type into v_type from public.businesses where id = p_business_id;
  with s as (
    select * from public.sales where business_id = p_business_id and sold_at >= (v_today - 30)::timestamp at time zone 'Asia/Kolkata'
  )
  select jsonb_build_object(
    'business_type', v_type,
    'today', (select jsonb_build_object('sales_paise', coalesce(sum(total_paise), 0), 'bills', count(*),
                'profit_paise', coalesce(sum(subtotal_paise - cogs_paise), 0))
              from s where (sold_at at time zone 'Asia/Kolkata')::date = v_today),
    'last_30_days', (select jsonb_build_object('sales_paise', coalesce(sum(total_paise), 0), 'bills', count(*),
                'profit_paise', coalesce(sum(subtotal_paise - cogs_paise), 0)) from s),
    'stock_value_paise', (select coalesce(sum(stock_value_paise), 0) from public.product_stock where business_id = p_business_id),
    'open_alerts', (select count(*) from public.alerts where business_id = p_business_id and status = 'open'),
    'expiring_soon', (select coalesce(jsonb_agg(x), '[]') from (
        select p.name, b.qty_remaining as qty, p.unit, b.expiry_date from public.stock_batches b join public.products p on p.id = b.product_id
        where b.business_id = p_business_id and b.qty_remaining > 0 and b.expiry_date <= v_today + 7
        order by b.expiry_date limit 10) x),
    'low_stock', (select coalesce(jsonb_agg(x), '[]') from (
        select name, on_hand, unit, reorder_point, suggested_qty from public.reorder_suggestions(p_business_id) limit 10) x),
    'top_products_30d', (select coalesce(jsonb_agg(x), '[]') from (
        select p.name, sum(si.qty) as qty, sum(si.line_total_paise)::bigint as sales_paise,
               sum(si.line_total_paise - si.tax_paise - si.cogs_paise)::bigint as profit_paise
        from public.sale_items si join s on s.id = si.sale_id join public.products p on p.id = si.product_id
        group by p.name order by 3 desc limit 5) x),
    'khata_outstanding_paise', (select coalesce(sum(balance_paise), 0) from public.khata_balances where business_id = p_business_id and balance_paise > 0),
    'wastage_30d_paise', (select coalesce(sum(cost_paise), 0) from public.wastage_log where business_id = p_business_id and logged_at >= now() - interval '30 days')
  ) into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------- matching (local first, vectors second)
-- Fuzzy name match for bill lines / CSV rows. No AI involved.
create or replace function public.match_product_names(p_business_id uuid, p_names text[], p_min_similarity real default 0.3)
returns table (input_name text, product_id uuid, product_name text, similarity real)
language plpgsql stable set search_path = public, extensions as $$
begin
  perform public.assert_member(p_business_id);
  return query
  -- word_similarity handles short spoken names ("maggi") against long labels ("Maggi Noodles 70g")
  select n.name, m.id, m.name, m.sim
  from unnest(p_names) with ordinality as n(name, ord)
  -- always exactly one row per input name, in input order (callers zip by index)
  left join lateral (
    select x.id, x.name, x.sim from (
      select p.id, p.name,
        greatest(similarity(lower(p.name), lower(n.name)), word_similarity(lower(n.name), lower(p.name)) * 0.9)::real as sim
      from public.products p
      where p.business_id = p_business_id and p.is_active
    ) x
    where x.sim >= p_min_similarity
    order by x.sim desc, length(x.name) limit 1
  ) m on true
  order by n.ord;
end;
$$;

create or replace function public.match_products(p_business_id uuid, p_embedding extensions.vector(768), p_limit int default 5)
returns table (product_id uuid, name text, similarity double precision)
language plpgsql stable set search_path = public, extensions as $$
begin
  perform public.assert_member(p_business_id);
  return query
  select p.id, p.name, 1 - (p.embedding <=> p_embedding)
  from public.products p
  where p.business_id = p_business_id and p.embedding is not null
  order by p.embedding <=> p_embedding limit p_limit;
end;
$$;

-- Photo / text price search inside the wholesaler network only.
create or replace function public.match_wholesaler_listings(p_embedding extensions.vector(768), p_limit int default 10)
returns table (listing_id uuid, wholesaler_id uuid, wholesaler_name text, city text, name text, unit text,
               price_paise bigint, min_qty numeric, gst_rate numeric, image_path text, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select l.id, b.id, b.name, b.city, l.name, l.unit, l.price_paise, l.min_qty, l.gst_rate, l.image_path,
         1 - (l.embedding <=> p_embedding)
  from public.wholesaler_listings l join public.businesses b on b.id = l.business_id
  where l.is_active and l.embedding is not null
  order by l.embedding <=> p_embedding limit p_limit;
$$;

-- Plain-text fallback when embeddings are unavailable.
create or replace function public.search_wholesaler_listings_text(p_query text, p_limit int default 10)
returns table (listing_id uuid, wholesaler_id uuid, wholesaler_name text, city text, name text, unit text,
               price_paise bigint, min_qty numeric, gst_rate numeric, image_path text, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select l.id, b.id, b.name, b.city, l.name, l.unit, l.price_paise, l.min_qty, l.gst_rate, l.image_path,
         greatest(similarity(lower(l.name), lower(p_query)), word_similarity(lower(p_query), lower(l.name)))::double precision as sim
  from public.wholesaler_listings l join public.businesses b on b.id = l.business_id
  where l.is_active and (l.name ilike '%' || p_query || '%' or word_similarity(lower(p_query), lower(l.name)) > 0.3)
  order by sim desc, l.price_paise limit p_limit;
$$;

-- ---------------------------------------------------------------- Telegram linking
create or replace function public.create_telegram_link_code(p_business_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not public.is_member(p_business_id) then raise exception 'not a member' using errcode = '42501'; end if;
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  delete from public.telegram_links where user_id = auth.uid() and business_id = p_business_id and telegram_chat_id is null;
  insert into public.telegram_links (business_id, user_id, link_code, code_expires_at)
  values (p_business_id, auth.uid(), v_code, now() + interval '15 minutes');
  return v_code;
end;
$$;

-- Service role only (the telegram-link Edge Function, called by the bot).
create or replace function public.consume_telegram_link_code(p_code text, p_chat_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_link record;
begin
  update public.telegram_links set telegram_chat_id = p_chat_id, linked_at = now(), link_code = null
  where link_code = p_code and code_expires_at > now() and telegram_chat_id is null
  returning * into v_link;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid or expired code'); end if;
  return jsonb_build_object('ok', true, 'business_id', v_link.business_id, 'user_id', v_link.user_id,
    'business', (select jsonb_build_object('name', name, 'business_type', business_type, 'language', language)
                 from public.businesses where id = v_link.business_id));
end;
$$;
revoke execute on function public.consume_telegram_link_code(text, bigint) from public, anon, authenticated;
