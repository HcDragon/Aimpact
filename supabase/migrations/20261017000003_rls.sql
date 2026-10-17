-- Row Level Security. Every business-owned table is scoped to members of that business.

-- Membership helpers. SECURITY DEFINER so policies on staff_roles don't recurse.
create or replace function public.is_member(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_roles
    where business_id = p_business_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.has_role(p_business_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_roles
    where business_id = p_business_id and user_id = (select auth.uid()) and role = any (p_roles)
  );
$$;

-- Used inside RPCs: lets the service role (Edge Functions acting for the Telegram bot) through,
-- otherwise requires membership.
create or replace function public.assert_member(p_business_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  -- service-role API calls, or direct DB connections (jobs) that don't come through PostgREST
  if (select auth.role()) = 'service_role' or session_user <> 'authenticator' then
    return;
  end if;
  if not public.is_member(p_business_id) then
    raise exception 'not a member of business %', p_business_id using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- businesses, users, staff
alter table public.businesses enable row level security;
create policy "members read business"   on public.businesses for select to authenticated using (public.is_member(id));
-- Wholesalers advertise to the whole network, so their profile is visible to every signed-in business.
create policy "network reads wholesalers" on public.businesses for select to authenticated using (business_type = 'wholesaler');
create policy "owner creates business"  on public.businesses for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner/manager update"    on public.businesses for update to authenticated
  using (public.has_role(id, array['owner', 'manager'])) with check (public.has_role(id, array['owner', 'manager']));
create policy "owner deletes business"  on public.businesses for delete to authenticated using (owner_id = (select auth.uid()));

alter table public.users enable row level security;
create policy "self read"   on public.users for select to authenticated using (id = (select auth.uid()));
create policy "self insert" on public.users for insert to authenticated with check (id = (select auth.uid()));
create policy "self update" on public.users for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

alter table public.staff_roles enable row level security;
create policy "members read staff" on public.staff_roles for select to authenticated using (public.is_member(business_id));
create policy "owner manages staff" on public.staff_roles for all to authenticated
  using (public.has_role(business_id, array['owner'])) with check (public.has_role(business_id, array['owner']));

alter table public.telegram_links enable row level security;
create policy "members read links" on public.telegram_links for select to authenticated using (public.is_member(business_id));
create policy "members delete own links" on public.telegram_links for delete to authenticated
  using (public.is_member(business_id) and user_id = (select auth.uid()));

-- ---------------------------------------------------------------- standard member-scoped tables
do $$
declare t text;
begin
  foreach t in array array[
    'suppliers', 'products', 'supplier_prices', 'purchases', 'purchase_items', 'stock_batches',
    'khata_customers', 'khata_entries', 'sales', 'sale_items', 'purchase_orders', 'purchase_order_items',
    'alerts', 'reviews', 'recipes', 'recipe_ingredients', 'wastage_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members select" on public.%I for select to authenticated using (public.is_member(business_id))', t);
    execute format('create policy "members insert" on public.%I for insert to authenticated with check (public.is_member(business_id))', t);
    execute format('create policy "members update" on public.%I for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id))', t);
    execute format('create policy "managers delete" on public.%I for delete to authenticated using (public.has_role(business_id, array[''owner'', ''manager'']))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- read-only for users (written by jobs)
alter table public.forecasts enable row level security;
create policy "members read forecasts" on public.forecasts for select to authenticated using (public.is_member(business_id));

alter table public.bundle_suggestions enable row level security;
create policy "members read bundles" on public.bundle_suggestions for select to authenticated using (public.is_member(business_id));

-- ---------------------------------------------------------------- wholesaler network
alter table public.wholesaler_listings enable row level security;
create policy "network reads active listings" on public.wholesaler_listings for select to authenticated
  using (is_active or public.is_member(business_id));
create policy "wholesaler inserts" on public.wholesaler_listings for insert to authenticated with check (public.is_member(business_id));
create policy "wholesaler updates" on public.wholesaler_listings for update to authenticated
  using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy "wholesaler deletes" on public.wholesaler_listings for delete to authenticated using (public.is_member(business_id));

-- ---------------------------------------------------------------- AI plumbing: service role only
alter table public.ai_jobs enable row level security;
create policy "members read own jobs" on public.ai_jobs for select to authenticated using (public.is_member(business_id));

alter table public.ai_cache enable row level security;  -- no policies: service role only

-- ---------------------------------------------------------------- storage: first path segment is business_id
create policy "members read bills" on storage.objects for select to authenticated
  using (bucket_id = 'bills' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload bills" on storage.objects for insert to authenticated
  with check (bucket_id = 'bills' and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "network reads listing images" on storage.objects for select to authenticated
  using (bucket_id = 'listing-images');
create policy "wholesaler uploads listing images" on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-images' and public.is_member(((storage.foldername(name))[1])::uuid));
