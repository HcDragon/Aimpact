-- Local demo data. Logins (password: password123):
--   shop@demo.test        Sharma Kirana Store (shop)
--   restaurant@demo.test  Annapurna Bhojanalay (restaurant)
--   wholesale@demo.test   Pune Wholesale Mart (wholesaler network)
-- Phone OTP test numbers are in supabase/config.toml ([auth.sms.test_otp], code 123456).

-- ---------------------------------------------------------------- auth users
do $$
declare u record;
begin
  for u in select * from (values
    ('11111111-1111-1111-1111-111111111111'::uuid, 'shop@demo.test',       '919999900001'),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'restaurant@demo.test', '919999900002'),
    ('33333333-3333-3333-3333-333333333333'::uuid, 'wholesale@demo.test',  '919999900003')
  ) as t(id, email, phone) loop
    insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at, phone_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, phone_change, phone_change_token,
      email_change_token_current, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, u.phone,
      extensions.crypt('password123', extensions.gen_salt('bf')), now(), now(),
      '{"provider":"email","providers":["email","phone"]}', '{}', now(), now(), '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id, u.id::text, 'email',
      jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now(), now());
  end loop;
end $$;

-- ---------------------------------------------------------------- businesses
insert into public.businesses (id, name, business_type, owner_id, phone, gstin, state_code, city, language, lead_time_days) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Sharma Kirana Store',  'shop',       '11111111-1111-1111-1111-111111111111', '919999900001', '27ABCDE1234F1Z5', '27', 'Pune', 'hinglish', 2),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Annapurna Bhojanalay', 'restaurant', '22222222-2222-2222-2222-222222222222', '919999900002', '27PQRSX5678K1Z2', '27', 'Pune', 'mr', 2),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Pune Wholesale Mart',  'wholesaler', '33333333-3333-3333-3333-333333333333', '919999900003', '27WHOLE9012M1Z8', '27', 'Pune', 'en', 1);

insert into public.staff_roles (business_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'owner');

insert into public.users (id, full_name, phone, preferred_language) values
  ('11111111-1111-1111-1111-111111111111', 'Ramesh Sharma', '919999900001', 'hinglish'),
  ('22222222-2222-2222-2222-222222222222', 'Sunita Patil',  '919999900002', 'mr'),
  ('33333333-3333-3333-3333-333333333333', 'Imran Shaikh',  '919999900003', 'en');

-- ---------------------------------------------------------------- suppliers
insert into public.suppliers (id, business_id, name, phone, wholesaler_business_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Pune Wholesale Mart', '919999900003', 'aaaaaaaa-0000-0000-0000-000000000003'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Gokul Dairy Distributors', '919811100002', null),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'Pune Wholesale Mart', '919999900003', 'aaaaaaaa-0000-0000-0000-000000000003'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000002', 'Market Yard Sabzi Wala', '919822200004', null);

-- ---------------------------------------------------------------- shop catalog
-- (name, category, barcode, unit, sell ₹, cost ₹, gst%, shelf life days, avg daily units, hsn, supplier)
create temporary table seed_shop (name text, category text, barcode text, unit text, sell numeric, cost numeric,
  gst numeric, shelf int, daily numeric, hsn text, supplier uuid);
insert into seed_shop values
  ('Amul Taaza Milk 500ml',      'Dairy',     '8901262010016', 'pcs', 28,  25,   0,  3, 30, '0401', 'bbbbbbbb-0000-0000-0000-000000000002'),
  ('Amul Butter 100g',           'Dairy',     '8901262150019', 'pcs', 62,  55,   5, 120, 3, '0405', 'bbbbbbbb-0000-0000-0000-000000000002'),
  ('Amul Masti Dahi 400g',       'Dairy',     '8901262030014', 'pcs', 35,  30,   0,  7,  8, '0403', 'bbbbbbbb-0000-0000-0000-000000000002'),
  ('Britannia Bread 400g',       'Bakery',    '8901063092013', 'pcs', 50,  42,   0,  5, 10, '1905', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Parle-G Biscuits 250g',      'Snacks',    '8901719110016', 'pcs', 25,  21,   5, 180, 12, '1905', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Maggi Noodles 70g',          'Snacks',    '8901058851335', 'pcs', 15,  12.5, 5, 270, 20, '1902', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Lays Classic Salted 52g',    'Snacks',    '8901491101837', 'pcs', 20,  16,   5, 120, 9, '2005', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Tata Salt 1kg',              'Staples',   '8904043901015', 'pcs', 28,  24,   0, 720, 4, '2501', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Aashirvaad Atta 5kg',        'Staples',   '8901725181222', 'pcs', 285, 255,  5, 120, 2, '1101', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Fortune Sunflower Oil 1L',   'Staples',   '8906007280015', 'pcs', 165, 148,  5, 270, 3, '1512', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Toor Dal 1kg',               'Staples',   '8901000000101', 'kg',  160, 138,  5, 240, 2.5, '0713', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Sugar 1kg',                  'Staples',   '8901000000118', 'kg',  48,  42,   5, 365, 4, '1701', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Tata Tea Premium 250g',      'Beverages', '8901052080014', 'pcs', 145, 128,  5, 365, 2, '0902', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Coca-Cola 750ml',            'Beverages', '8901764012273', 'pcs', 40,  32,  40, 150, 6, '2202', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Colgate Strong Teeth 200g',  'Personal',  '8901314010322', 'pcs', 110, 95,   5, 730, 1.2, '3306', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Dettol Soap 125g',           'Personal',  '8901396393504', 'pcs', 65,  56,   5, 900, 2, '3401', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Surf Excel Easy Wash 1kg',   'Household', '8901030704505', 'pcs', 140, 118, 18, 900, 1.5, '3402', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('Eggs (tray of 6)',           'Dairy',     '8901000000125', 'pcs', 48,  40,   0, 12, 7, '0407', 'bbbbbbbb-0000-0000-0000-000000000002');

insert into public.products (business_id, name, kind, category, barcode, unit, sell_price_paise, mrp_paise, cost_price_paise,
  gst_rate, hsn_code, preferred_supplier_id, reorder_level)
select 'aaaaaaaa-0000-0000-0000-000000000001', name, 'product', category, barcode, unit, (sell * 100)::bigint, (sell * 100)::bigint,
  (cost * 100)::bigint, gst, hsn, supplier, ceil(daily * 2)
from seed_shop;

-- ---------------------------------------------------------------- restaurant pantry + menu
create temporary table seed_ing (name text, unit text, cost numeric, gst numeric, shelf int, supplier uuid);
insert into seed_ing values
  ('Basmati Rice',   'kg', 95,  5, 365, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Toor Dal',       'kg', 138, 5, 240, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Atta',           'kg', 42,  5, 120, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Paneer',         'kg', 380, 0, 4,   'bbbbbbbb-0000-0000-0000-000000000004'),
  ('Chicken',        'kg', 240, 0, 2,   'bbbbbbbb-0000-0000-0000-000000000004'),
  ('Onion',          'kg', 32,  0, 20,  'bbbbbbbb-0000-0000-0000-000000000004'),
  ('Tomato',         'kg', 28,  0, 7,   'bbbbbbbb-0000-0000-0000-000000000004'),
  ('Cooking Oil',    'l',  148, 5, 270, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Butter',         'kg', 520, 5, 120, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Milk',           'l',  56,  0, 2,   'bbbbbbbb-0000-0000-0000-000000000004'),
  ('Tea Leaves',     'kg', 480, 5, 365, 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('Garam Masala',   'kg', 900, 5, 365, 'bbbbbbbb-0000-0000-0000-000000000003');

insert into public.products (business_id, name, kind, category, unit, cost_price_paise, gst_rate, preferred_supplier_id)
select 'aaaaaaaa-0000-0000-0000-000000000002', name, 'ingredient', 'Pantry', unit, (cost * 100)::bigint, gst, supplier from seed_ing;

create temporary table seed_dish (name text, price numeric, daily numeric, recipe jsonb);
insert into seed_dish values
  ('Paneer Butter Masala', 240, 14, '{"Paneer":0.15,"Butter":0.03,"Tomato":0.12,"Onion":0.08,"Cooking Oil":0.02,"Garam Masala":0.005}'),
  ('Dal Tadka',            160, 18, '{"Toor Dal":0.1,"Onion":0.05,"Tomato":0.05,"Cooking Oil":0.02,"Butter":0.01}'),
  ('Jeera Rice',           140, 16, '{"Basmati Rice":0.15,"Cooking Oil":0.01,"Butter":0.01}'),
  ('Butter Roti',           30, 60, '{"Atta":0.05,"Butter":0.005}'),
  ('Chicken Biryani',      280, 12, '{"Chicken":0.2,"Basmati Rice":0.18,"Onion":0.1,"Cooking Oil":0.03,"Garam Masala":0.008}'),
  ('Masala Chai',           25, 35, '{"Milk":0.1,"Tea Leaves":0.004}');

insert into public.products (business_id, name, kind, category, unit, sell_price_paise, gst_rate, hsn_code)
select 'aaaaaaaa-0000-0000-0000-000000000002', name, 'dish', 'Menu', 'plate', (price * 100)::bigint, 5, '9963' from seed_dish;

insert into public.recipes (business_id, dish_product_id, yield_qty)
select p.business_id, p.id, 1 from public.products p
where p.business_id = 'aaaaaaaa-0000-0000-0000-000000000002' and p.kind = 'dish';

insert into public.recipe_ingredients (business_id, recipe_id, ingredient_product_id, qty)
select r.business_id, r.id, i.id, (e.value)::numeric
from seed_dish d
join public.products dp on dp.name = d.name and dp.business_id = 'aaaaaaaa-0000-0000-0000-000000000002'
join public.recipes r on r.dish_product_id = dp.id
cross join lateral jsonb_each_text(d.recipe) e
join public.products i on i.name = e.key and i.business_id = 'aaaaaaaa-0000-0000-0000-000000000002' and i.kind = 'ingredient';

-- ---------------------------------------------------------------- wholesaler network listings
insert into public.wholesaler_listings (business_id, name, description, category, unit, price_paise, min_qty, gst_rate) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Parle-G Biscuits 250g (carton of 48)', 'Glucose biscuits, family pack', 'Snacks', 'carton', 96000, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Maggi 2-Minute Noodles 70g (box of 96)', 'Masala instant noodles', 'Snacks', 'box', 115200, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Aashirvaad Whole Wheat Atta 5kg', 'Shudh chakki atta', 'Staples', 'bag', 24800, 5, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Fortune Sunflower Oil 1L pouch', 'Refined sunflower oil', 'Staples', 'pcs', 14200, 12, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Fortune Sunflower Oil 15L tin', 'Refined sunflower oil, bulk', 'Staples', 'tin', 198000, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Tata Salt 1kg', 'Iodised salt', 'Staples', 'pcs', 2250, 25, 0),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'India Gate Basmati Rice 25kg', 'Long grain basmati', 'Staples', 'bag', 225000, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Toor Dal (Arhar) 30kg bag', 'Unpolished toor dal', 'Staples', 'bag', 396000, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Sugar M-30 50kg bag', 'Crystal sugar', 'Staples', 'bag', 202500, 1, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Tata Tea Premium 1kg', 'Black tea', 'Beverages', 'pcs', 49000, 5, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Coca-Cola 750ml (crate of 24)', 'Aerated soft drink', 'Beverages', 'crate', 74000, 1, 40),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Surf Excel Easy Wash 1kg', 'Detergent powder', 'Household', 'pcs', 11400, 10, 18),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Dettol Original Soap 125g (pack of 4)', 'Antiseptic soap', 'Personal', 'pack', 21500, 6, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Amul Butter 500g', 'Pasteurised table butter', 'Dairy', 'pcs', 26000, 4, 5),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Everest Garam Masala 500g', 'Blended spice', 'Spices', 'pcs', 42000, 2, 5);

-- ---------------------------------------------------------------- 90 days of trading history
-- Purchases every 7 days, sales every day with weekly seasonality and a Diwali bump.
-- record_sale / record_purchase run as postgres here, so assert_member passes.
set app.skip_alerts = 'on';
do $$
declare
  v_shop uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_rest uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  v_day date; v_today date := public.ist_today(); v_mult numeric; v_n int; v_items jsonb; v_p record;
  v_ts timestamptz; i int; v_modes text[] := array['cash', 'cash', 'upi', 'upi', 'upi', 'card'];
  v_channels text[] := array['dine_in', 'dine_in', 'takeaway', 'zomato', 'swiggy'];
begin
  perform setseed(0.42);
  for v_day in select generate_series(v_today - 90, v_today - 1, interval '1 day')::date loop
    v_mult := case extract(isodow from v_day) when 6 then 1.3 when 7 then 1.4 else 1 end
              * (1 + 0.15 * sin(extract(doy from v_day) / 9.0))
              * case when v_day between date '2026-10-15' and date '2026-10-25' then 1.35 else 1 end;

    -- weekly restock (shop)
    if (v_today - v_day) % 7 = 6 then
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'qty', ceil(s.daily * 8.5),
               'unit_cost_paise', p.cost_price_paise, 'gst_rate', p.gst_rate,
               'expiry_date', v_day + s.shelf, 'batch_no', 'B' || to_char(v_day, 'MMDD')))
      into v_items
      from public.products p join seed_shop s on s.name = p.name where p.business_id = v_shop
        and s.shelf > 7;
      perform public.record_purchase(v_shop, jsonb_build_object('supplier_id', 'bbbbbbbb-0000-0000-0000-000000000001',
        'invoice_no', 'PWM-' || to_char(v_day, 'YYMMDD'), 'invoice_date', v_day), v_items);
    end if;
    -- perishables every 2 days (shop dairy) and restaurant fresh produce
    if (v_today - v_day) % 2 = 0 then
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'qty', ceil(s.daily * 1.9),
               'unit_cost_paise', p.cost_price_paise, 'gst_rate', p.gst_rate, 'expiry_date', v_day + s.shelf))
      into v_items
      from public.products p join seed_shop s on s.name = p.name where p.business_id = v_shop and s.shelf <= 7;
      perform public.record_purchase(v_shop, jsonb_build_object('supplier_id', 'bbbbbbbb-0000-0000-0000-000000000002',
        'invoice_no', 'GKD-' || to_char(v_day, 'YYMMDD'), 'invoice_date', v_day), v_items);

      select jsonb_agg(jsonb_build_object('product_id', p.id,
               'qty', case p.name when 'Paneer' then 5 when 'Chicken' then 6 when 'Milk' then 8 when 'Tomato' then 7 else 6 end,
               'unit_cost_paise', p.cost_price_paise, 'gst_rate', p.gst_rate, 'expiry_date', v_day + i2.shelf))
      into v_items
      from public.products p join seed_ing i2 on i2.name = p.name
      where p.business_id = v_rest and i2.shelf <= 20;
      perform public.record_purchase(v_rest, jsonb_build_object('supplier_id', 'bbbbbbbb-0000-0000-0000-000000000004',
        'invoice_no', 'MYS-' || to_char(v_day, 'YYMMDD'), 'invoice_date', v_day), v_items);
    end if;
    if (v_today - v_day) % 10 = 9 then
      select jsonb_agg(jsonb_build_object('product_id', p.id,
               'qty', case p.unit when 'kg' then case p.name when 'Garam Masala' then 1 when 'Tea Leaves' then 2 else 35 end else 12 end,
               'unit_cost_paise', p.cost_price_paise, 'gst_rate', p.gst_rate, 'expiry_date', v_day + i2.shelf))
      into v_items
      from public.products p join seed_ing i2 on i2.name = p.name
      where p.business_id = v_rest and i2.shelf > 20;
      perform public.record_purchase(v_rest, jsonb_build_object('supplier_id', 'bbbbbbbb-0000-0000-0000-000000000003',
        'invoice_no', 'PWM-R-' || to_char(v_day, 'YYMMDD'), 'invoice_date', v_day), v_items);
    end if;

    -- shop sales: ~45 bills/day, 1-4 items each
    v_n := round(45 * v_mult);
    for i in 1 .. v_n loop
      v_ts := (v_day + time '08:00' + (random() * interval '13 hours')) at time zone 'Asia/Kolkata';
      select jsonb_agg(jsonb_build_object('product_id', id, 'qty', 1 + floor(random() * 2)))
      into v_items from (
        select p.id from public.products p join seed_shop s on s.name = p.name
        where p.business_id = v_shop and random() < s.daily * v_mult / v_n / 1.5
        limit 4) x;
      continue when v_items is null;
      perform public.record_sale(v_shop, v_items, v_modes[1 + floor(random() * 6)::int], 'counter', null, v_ts);
    end loop;
    -- a few credit (udhaar) sales
    if random() < 0.4 then
      select jsonb_agg(jsonb_build_object('product_id', id, 'qty', 1)) into v_items
      from (select id from public.products where business_id = v_shop order by random() limit 3) x;
      perform public.record_sale(v_shop, v_items, 'credit', 'counter',
        (array['Mehta ji', 'Kulkarni Kaku', 'Raju (Building 4)'])[1 + floor(random() * 3)::int], v_ts);
    end if;

    -- restaurant: orders with 1-3 dishes
    v_n := round(38 * v_mult);
    for i in 1 .. v_n loop
      v_ts := (v_day + time '11:00' + (random() * interval '11 hours')) at time zone 'Asia/Kolkata';
      select jsonb_agg(jsonb_build_object('product_id', id, 'qty', 1 + floor(random() * 2))) into v_items from (
        select p.id from public.products p join seed_dish d on d.name = p.name
        where p.business_id = v_rest and random() < d.daily * v_mult / v_n / 1.4
        limit 3) x;
      continue when v_items is null;
      perform public.record_sale(v_rest, v_items, v_modes[1 + floor(random() * 6)::int],
        v_channels[1 + floor(random() * 5)::int], null, v_ts);
    end loop;
  end loop;
end $$;

-- Shopkeepers bin expired stock: write off everything that expired before yesterday.
insert into public.wastage_log (business_id, product_id, qty, reason, cost_paise, logged_at)
select business_id, product_id, qty_remaining, 'expired', round(qty_remaining * unit_cost_paise), (expiry_date + 1)::timestamp at time zone 'Asia/Kolkata'
from public.stock_batches where qty_remaining > 0 and expiry_date < public.ist_today() - 1;
update public.stock_batches set qty_remaining = 0 where qty_remaining > 0 and expiry_date < public.ist_today() - 1;

-- Khata repayments
select public.khata_add('aaaaaaaa-0000-0000-0000-000000000001', 'Mehta ji', 'payment', 50000, 'UPI');
select public.khata_add('aaaaaaaa-0000-0000-0000-000000000001', 'Kulkarni Kaku', 'payment', 20000, 'Cash');

-- Stock that is about to expire / already expired, for the alert demo
select public.record_purchase('aaaaaaaa-0000-0000-0000-000000000001',
  '{"supplier_id":"bbbbbbbb-0000-0000-0000-000000000002","invoice_no":"GKD-EXP"}',
  (select jsonb_build_array(
     jsonb_build_object('product_id', (select id from public.products where name = 'Amul Masti Dahi 400g'), 'qty', 6, 'unit_cost_paise', 3000, 'expiry_date', public.ist_today() + 2),
     jsonb_build_object('product_id', (select id from public.products where name = 'Britannia Bread 400g'), 'qty', 3, 'unit_cost_paise', 4200, 'expiry_date', public.ist_today() - 1))));

-- Wastage (restaurant)
select public.log_wastage('aaaaaaaa-0000-0000-0000-000000000002',
  (select id from public.products where business_id = 'aaaaaaaa-0000-0000-0000-000000000002' and name = 'Milk'), 1.5, 'spoiled', 'Fridge left open');
select public.log_wastage('aaaaaaaa-0000-0000-0000-000000000002',
  (select id from public.products where business_id = 'aaaaaaaa-0000-0000-0000-000000000002' and name = 'Paneer'), 0.4, 'expired');

-- Reviews (sentiment is filled by the nightly AI batch)
insert into public.reviews (business_id, source, rating, review_text, reviewed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'zomato', 5, 'Paneer butter masala was amazing, very creamy. Fast delivery too!', now() - interval '3 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'swiggy', 2, 'Biryani was cold and the chicken was dry. Packaging leaked.', now() - interval '2 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'google', 4, 'Dal tadka ekdum ghar jaisa. Roti thodi hard thi.', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'zomato', 3, 'Chai was good but waited 40 minutes for food on a Sunday.', now() - interval '5 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'google', 5, 'Sharma uncle always has fresh milk and gives udhaar to regulars. Best kirana in the lane.', now() - interval '4 days');

reset app.skip_alerts;
select public.refresh_alerts();

-- Local cron -> Edge Function wiring (kong is the API gateway inside the Docker network).
-- These are the public local-dev defaults, not real secrets.
select vault.create_secret('http://kong:8000', 'project_url');
select vault.create_secret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU', 'service_role_key');
