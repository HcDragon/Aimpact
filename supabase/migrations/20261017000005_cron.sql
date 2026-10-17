-- Scheduled jobs (pg_cron runs in UTC; IST = UTC + 5:30).
-- Edge Function calls need two Vault secrets, set once per environment:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role or secret key>', 'service_role_key');
-- Until they exist the HTTP jobs log a notice and do nothing.

create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text; v_id bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise notice 'invoke_edge_function(%): vault secrets project_url / service_role_key not set', p_name;
    return null;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
    body := p_body,
    timeout_milliseconds := 60000
  ) into v_id;
  return v_id;
end;
$$;
revoke execute on function public.invoke_edge_function(text, jsonb) from public, anon, authenticated;

-- Queue one insight job per active business (processed by ai-worker in the nightly batch).
create or replace function public.queue_daily_insights() returns int language sql security definer set search_path = '' as $$
  with ins as (
    insert into public.ai_jobs (business_id, kind, payload)
    select b.id, 'daily_insight', jsonb_build_object('id', b.id::text || ':' || public.ist_today())
    from public.businesses b
    where b.business_type <> 'wholesaler'
      and exists (select 1 from public.sales s where s.business_id = b.id and s.sold_at > now() - interval '7 days')
    on conflict do nothing
    returning 1
  ) select count(*)::int from ins;
$$;
revoke execute on function public.queue_daily_insights() from public, anon, authenticated;

-- 06:00 IST: expiry and stock alerts for every business.
select cron.schedule('daily-alerts', '30 0 * * *', $$ select public.refresh_alerts(); $$);

-- 07:00 IST: push open, un-notified alerts to linked Telegram chats.
select cron.schedule('telegram-alerts', '30 1 * * *', $$ select public.invoke_edge_function('notify-telegram'); $$);

-- 01:00 IST: nightly AI batch (insights; review sentiment is already queued for this time).
select cron.schedule('nightly-insights', '30 19 * * *', $$ select public.queue_daily_insights(); $$);

-- Every 2 minutes: drain the AI queue (embeddings, sentiment, insights) with backoff.
select cron.schedule('ai-worker', '*/2 * * * *', $$
  select public.invoke_edge_function('ai-worker')
  where exists (select 1 from public.ai_jobs where status = 'pending' and run_after <= now());
$$);

-- 03:00 IST: housekeeping.
select cron.schedule('ai-housekeeping', '30 21 * * *', $$
  delete from public.ai_cache where expires_at < now();
  delete from public.ai_jobs where status = 'done' and updated_at < now() - interval '7 days';
  update public.ai_jobs set status = 'pending' where status = 'running' and updated_at < now() - interval '15 minutes';
$$);

-- ---------------------------------------------------------------- AI queue helpers (service role)
create or replace function public.claim_ai_jobs(p_limit int default 10, p_kinds text[] default null)
returns setof public.ai_jobs language sql security definer set search_path = '' as $$
  update public.ai_jobs j set status = 'running', attempts = j.attempts + 1, updated_at = now()
  where j.id in (
    select id from public.ai_jobs
    where status = 'pending' and run_after <= now() and (p_kinds is null or kind = any (p_kinds))
    order by run_after, id limit p_limit
    for update skip locked)
  returning j.*;
$$;

-- Success -> done. Failure -> back to pending with exponential backoff (1, 2, 4, 8 ... min), or failed.
create or replace function public.finish_ai_job(p_id bigint, p_error text default null, p_retry_after_seconds int default null)
returns void language sql security definer set search_path = '' as $$
  update public.ai_jobs set
    status = case when p_error is null then 'done'
                  when attempts >= max_attempts then 'failed' else 'pending' end,
    last_error = p_error,
    run_after = case when p_error is null then run_after
                     else now() + make_interval(secs => coalesce(p_retry_after_seconds, 60 * power(2, attempts - 1)::int)) end,
    updated_at = now()
  where id = p_id;
$$;
revoke execute on function public.claim_ai_jobs(int, text[]) from public, anon, authenticated;
revoke execute on function public.finish_ai_job(bigint, text, int) from public, anon, authenticated;
