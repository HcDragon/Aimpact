-- Core schema. Money is integer paise (bigint). Quantities are numeric(12,3).
-- Every business-owned table carries business_id; RLS is enabled in the next migration.

-- ---------------------------------------------------------------- businesses & people
create table public.businesses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  business_type   text not null check (business_type in ('shop', 'restaurant', 'wholesaler')),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  phone           text,
  gstin           text,
  state_code      text,                       -- 2-digit GST state code, e.g. '27' (Maharashtra)
  city            text,
  language        text not null default 'en' check (language in ('en', 'hi', 'mr', 'hinglish')),
  lead_time_days  int  not null default 3 check (lead_time_days between 0 and 60),
  expiry_alert_days int not null default 7 check (expiry_alert_days between 1 and 90),
  created_at      timestamptz not null default now()
);

-- Profile for each auth user (not business-owned; RLS limits it to the user).
create table public.users (
  id                 uuid primary key references auth.users (id) on delete cascade,
  full_name          text,
  phone              text,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi', 'mr', 'hinglish')),
  created_at         timestamptz not null default now()
);

create table public.staff_roles (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'manager', 'staff')),
  created_at  timestamptz not null default now(),
  unique (business_id, user_id)
);
create index on public.staff_roles (user_id);

-- Telegram chats linked to a business (the bot writes here via the telegram-link function).
create table public.telegram_links (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  link_code        text unique,                 -- one-time code shown in the app
  code_expires_at  timestamptz,
  telegram_chat_id bigint,
  linked_at        timestamptz,
  created_at       timestamptz not null default now()
);
create unique index on public.telegram_links (business_id, telegram_chat_id) where telegram_chat_id is not null;

-- ---------------------------------------------------------------- catalog
create table public.suppliers (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  name                   text not null,
  phone                  text,
  gstin                  text,
  wholesaler_business_id uuid references public.businesses (id) on delete set null, -- supplier is in our network
  created_at             timestamptz not null default now()
);
create index on public.suppliers (business_id);

create table public.products (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  name                  text not null,
  -- 'product' = shop item, 'ingredient' = restaurant pantry item, 'dish' = restaurant menu item
  kind                  text not null default 'product' check (kind in ('product', 'ingredient', 'dish')),
  category              text,
  barcode               text,
  sku                   text,
  hsn_code              text,
  unit                  text not null default 'pcs',  -- pcs, kg, g, l, ml, pack ...
  mrp_paise             bigint check (mrp_paise >= 0),
  sell_price_paise      bigint check (sell_price_paise >= 0), -- GST inclusive
  cost_price_paise      bigint check (cost_price_paise >= 0), -- last purchase cost, GST exclusive
  gst_rate              numeric(5,2) not null default 0 check (gst_rate in (0, 0.25, 3, 5, 12, 18, 28, 40)),
  reorder_level         numeric(12,3),  -- manual / rule-based reorder point
  reorder_qty           numeric(12,3),
  preferred_supplier_id uuid references public.suppliers (id) on delete set null,
  is_active             boolean not null default true,
  embedding             extensions.vector(768),
  embedding_model       text,
  embedded_name         text,           -- name the embedding was made from (re-embed only on rename)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on public.products (business_id);
create unique index on public.products (business_id, barcode) where barcode is not null;
create index products_name_trgm on public.products using gin (name extensions.gin_trgm_ops);
create index products_embedding_hnsw on public.products using hnsw (embedding extensions.vector_cosine_ops);

create table public.supplier_prices (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  price_paise bigint not null check (price_paise >= 0),
  min_qty     numeric(12,3) not null default 1,
  updated_at  timestamptz not null default now(),
  unique (supplier_id, product_id)
);
create index on public.supplier_prices (business_id, product_id);

-- ---------------------------------------------------------------- purchases & stock
create table public.purchases (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  supplier_id     uuid references public.suppliers (id) on delete set null,
  invoice_no      text,
  invoice_date    date not null default (now() at time zone 'Asia/Kolkata')::date,
  source          text not null default 'manual' check (source in ('manual', 'bill_scan', 'voice', 'barcode', 'purchase_order', 'telegram')),
  subtotal_paise  bigint not null default 0,
  tax_paise       bigint not null default 0,
  total_paise     bigint not null default 0,
  bill_image_path text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now()
);
create index on public.purchases (business_id, invoice_date);

create table public.purchase_items (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  purchase_id     uuid not null references public.purchases (id) on delete cascade,
  product_id      uuid not null references public.products (id),
  qty             numeric(12,3) not null check (qty > 0),
  unit_cost_paise bigint not null check (unit_cost_paise >= 0), -- GST exclusive
  gst_rate        numeric(5,2) not null default 0,
  tax_paise       bigint not null default 0,
  batch_no        text,
  expiry_date     date
);
create index on public.purchase_items (purchase_id);

create table public.stock_batches (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete cascade,
  purchase_item_id uuid references public.purchase_items (id) on delete set null,
  batch_no         text,
  qty_received     numeric(12,3) not null check (qty_received >= 0),
  qty_remaining    numeric(12,3) not null check (qty_remaining >= 0),
  unit_cost_paise  bigint not null default 0,
  expiry_date      date,
  received_at      timestamptz not null default now()
);
create index on public.stock_batches (business_id, product_id) where qty_remaining > 0;
create index on public.stock_batches (business_id, expiry_date) where qty_remaining > 0;

-- ---------------------------------------------------------------- khata (credit book)
create table public.khata_customers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null,
  phone       text,
  created_at  timestamptz not null default now(),
  unique (business_id, name)
);

create table public.khata_entries (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  customer_id  uuid not null references public.khata_customers (id) on delete cascade,
  kind         text not null check (kind in ('credit', 'payment')),  -- credit = customer owes more
  amount_paise bigint not null check (amount_paise > 0),
  note         text,
  sale_id      uuid,
  created_at   timestamptz not null default now()
);
create index on public.khata_entries (business_id, customer_id);

-- ---------------------------------------------------------------- sales
create table public.sales (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  sold_at           timestamptz not null default now(),
  channel           text not null default 'counter' check (channel in ('counter', 'telegram', 'zomato', 'swiggy', 'dine_in', 'takeaway', 'other')),
  payment_mode      text not null default 'cash' check (payment_mode in ('cash', 'upi', 'card', 'credit', 'online')),
  khata_customer_id uuid references public.khata_customers (id) on delete set null,
  external_order_id text,  -- Zomato / Swiggy order id from CSV import
  subtotal_paise    bigint not null default 0,  -- ex-GST
  tax_paise         bigint not null default 0,
  total_paise       bigint not null default 0,  -- GST inclusive
  cogs_paise        bigint not null default 0,
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now()
);
create index on public.sales (business_id, sold_at);
create unique index on public.sales (business_id, channel, external_order_id) where external_order_id is not null;
alter table public.khata_entries add foreign key (sale_id) references public.sales (id) on delete set null;

create table public.sale_items (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  sale_id          uuid not null references public.sales (id) on delete cascade,
  product_id       uuid not null references public.products (id),
  qty              numeric(12,3) not null check (qty > 0),
  unit_price_paise bigint not null check (unit_price_paise >= 0), -- GST inclusive
  gst_rate         numeric(5,2) not null default 0,
  line_total_paise bigint not null,
  tax_paise        bigint not null,
  cogs_paise       bigint not null default 0,
  short_qty        numeric(12,3) not null default 0  -- sold beyond tracked stock (never blocks a sale)
);
create index on public.sale_items (business_id, product_id);
create index on public.sale_items (sale_id);

-- ---------------------------------------------------------------- reordering
create table public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  supplier_id  uuid references public.suppliers (id) on delete set null,
  status       text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note         text,
  total_paise  bigint not null default 0,
  purchase_id  uuid references public.purchases (id) on delete set null,  -- set when received
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.purchase_orders (business_id, status);

create table public.purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders (id) on delete cascade,
  product_id        uuid not null references public.products (id),
  qty               numeric(12,3) not null check (qty > 0),
  unit_cost_paise   bigint not null default 0
);

-- Written ONLY by the Python forecasting job (service role). The app only reads it.
create table public.forecasts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  product_id    uuid references public.products (id) on delete cascade,  -- null when category-level
  category      text,
  forecast_date date not null,
  yhat          numeric(12,3) not null,
  yhat_lower    numeric(12,3),
  yhat_upper    numeric(12,3),
  method        text not null check (method in ('prophet', 'category', 'moving_average', 'rule')),
  generated_at  timestamptz not null default now()
);
create unique index on public.forecasts (business_id, product_id, forecast_date) where product_id is not null;
create index on public.forecasts (business_id, forecast_date);

-- Frequently-bought-together bundles (Apriori, written by the Python job).
create table public.bundle_suggestions (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  antecedent_ids    uuid[] not null,
  consequent_ids    uuid[] not null,
  support           numeric(6,4),
  confidence        numeric(6,4),
  lift              numeric(8,4),
  generated_at      timestamptz not null default now()
);
create index on public.bundle_suggestions (business_id);

create table public.alerts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id  uuid references public.products (id) on delete cascade,
  kind        text not null check (kind in ('low_stock', 'out_of_stock', 'expiry_soon', 'expired', 'reorder', 'insight', 'review')),
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  message     text not null,
  data        jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  dedupe_key  text,           -- one open alert per key
  notified_at timestamptz,    -- sent to Telegram
  created_at  timestamptz not null default now()
);
create unique index alerts_open_dedupe on public.alerts (business_id, dedupe_key) where status = 'open' and dedupe_key is not null;
create index on public.alerts (business_id, status, created_at desc);

-- ---------------------------------------------------------------- reviews
create table public.reviews (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  source          text not null default 'manual' check (source in ('manual', 'google', 'zomato', 'swiggy', 'telegram')),
  rating          int check (rating between 1 and 5),
  review_text     text,
  reviewed_at     timestamptz not null default now(),
  sentiment       text check (sentiment in ('positive', 'neutral', 'negative')),
  sentiment_score numeric(4,3),
  topics          text[],
  analyzed_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on public.reviews (business_id, reviewed_at desc);

-- ---------------------------------------------------------------- restaurant-only
create table public.recipes (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  dish_product_id uuid not null unique references public.products (id) on delete cascade,
  yield_qty       numeric(12,3) not null default 1 check (yield_qty > 0),  -- portions per recipe
  notes           text,
  created_at      timestamptz not null default now()
);

create table public.recipe_ingredients (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  recipe_id             uuid not null references public.recipes (id) on delete cascade,
  ingredient_product_id uuid not null references public.products (id) on delete cascade,
  qty                   numeric(12,3) not null check (qty > 0),  -- per recipe yield, in ingredient's unit
  unique (recipe_id, ingredient_product_id)
);

create table public.wastage_log (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  qty         numeric(12,3) not null check (qty > 0),
  reason      text not null default 'other' check (reason in ('expired', 'spoiled', 'overcooked', 'returned', 'damaged', 'other')),
  cost_paise  bigint not null default 0,
  note        text,
  logged_at   timestamptz not null default now(),
  created_by  uuid references auth.users (id)
);
create index on public.wastage_log (business_id, logged_at);

-- ---------------------------------------------------------------- wholesaler network
-- Listings are posted by wholesaler businesses and visible to every signed-in business.
create table public.wholesaler_listings (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,  -- the wholesaler
  name            text not null,
  description     text,
  category        text,
  unit            text not null default 'pcs',
  price_paise     bigint not null check (price_paise >= 0),
  min_qty         numeric(12,3) not null default 1,
  gst_rate        numeric(5,2) not null default 0,
  image_path      text,
  is_active       boolean not null default true,
  embedding       extensions.vector(768),
  embedding_model text,
  embedded_name   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on public.wholesaler_listings (business_id);
create index listings_name_trgm on public.wholesaler_listings using gin (name extensions.gin_trgm_ops);
create index listings_embedding_hnsw on public.wholesaler_listings using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------- AI plumbing (service role only)
-- Queue for non-urgent AI work: embeddings, sentiment, insights. Retries with exponential backoff.
create table public.ai_jobs (
  id          bigint generated always as identity primary key,
  business_id uuid references public.businesses (id) on delete cascade,
  kind        text not null check (kind in ('embed_product', 'embed_listing', 'review_sentiment', 'daily_insight')),
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts    int not null default 0,
  max_attempts int not null default 5,
  run_after   timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.ai_jobs (status, run_after);
create unique index ai_jobs_pending_dedupe on public.ai_jobs (kind, (payload ->> 'id')) where status in ('pending', 'running');

-- Response cache keyed by a hash of (model, prompt, input).
create table public.ai_cache (
  cache_key  text primary key,
  response   jsonb not null,
  model      text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Storage buckets for bill photos and listing images (private; paths start with business_id/).
insert into storage.buckets (id, name, public) values
  ('bills', 'bills', false),
  ('listing-images', 'listing-images', false)
on conflict (id) do nothing;
