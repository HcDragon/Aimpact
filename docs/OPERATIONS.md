# Operations

## Local development

```bash
npx supabase start            # Postgres, Auth, Storage, Realtime, Edge runtime (Docker)
npx supabase db reset         # migrations + seed (3 demo businesses, 90 days of sales)
cp supabase/functions/.env.example supabase/functions/.env   # add GROQ_API_KEY / GEMINI_API_KEY
npx supabase functions serve --env-file supabase/functions/.env
python3 -m http.server 5173 --directory dummy-frontend       # http://127.0.0.1:5173
bash scripts/smoke_test.sh    # API smoke test (passes without AI keys too)
```

Studio is at http://127.0.0.1:54323. Locally, pg_cron calls functions through `http://kong:8000`
(set up in `seed.sql`).

## Deploying to a hosted Supabase project

```bash
npx supabase link --project-ref <ref>
npx supabase db push                                   # migrations only; never run seed.sql in prod
npx supabase functions deploy                          # all functions (each verifies its caller itself)
npx supabase secrets set --env-file supabase/functions/.env
```

Then, once, in the SQL editor (this lets pg_cron call the Edge Functions):

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service role key>', 'service_role_key');
```

Auth: enable the Phone provider and connect an SMS provider (Twilio, MSG91 via a send-SMS hook, ...).
Set `site_url` to the app's URL.

## Scheduled jobs (pg_cron, UTC)

| Job | When (IST) | What |
| --- | --- | --- |
| `daily-alerts` | 06:00 | `refresh_alerts()`: expiry, expired and low-stock alerts for every business |
| `telegram-alerts` | 07:00 | `notify-telegram` pushes new alerts to linked chats |
| `nightly-insights` | 01:00 | queues one `daily_insight` job per active business |
| `ai-worker` | every 2 min, only when work is pending | embeddings, review sentiment (batched), insights |
| `ai-housekeeping` | 03:00 | clears the expired cache, old jobs and stuck jobs |
| forecasting job | nightly, **outside Supabase** | `python forecasting/run_forecasts.py` (cron, GitHub Actions, any VM) |

## AI usage

| Task | Provider | Where |
| --- | --- | --- |
| Assistant answers, command parsing, review sentiment, morning insight | Chat model (Groq by default, xAI Grok optional) | `_shared/chat.ts` |
| Bill photo extraction, voice transcription, photo/text embeddings | Gemini | `_shared/gemini.ts` |
| Every number (stock, GST, profit, reorder) | Postgres | `supabase/migrations/*_business_logic.sql` |

- Model names live only in `config/ai.json`. Switch the chat provider with the secret `CHAT_PROVIDER=xai`.
- All calls go through retry with exponential backoff (honouring `Retry-After`) and the `ai_cache` table.
- Non-urgent work goes through the `ai_jobs` queue. Failed jobs back off 1, 2, 4, 8... minutes, up to 5 attempts.
  Rate limits pause the batch, and a missing key retries after 6 hours.
- Without keys, every AI path falls back: rule-based command parsing, manual bill entry,
  text search instead of photo search, and a plain numeric summary instead of an assistant answer.

### Changing the embedding model or size
Vectors from different models are not comparable. After changing `gemini.embedding_model` (or
`embedding_dimensions`, which also needs a migration changing `vector(768)`), re-embed everything:

```sql
update public.products set embedding = null, embedded_name = null;
update public.wholesaler_listings set embedding = null;
insert into public.ai_jobs (business_id, kind, payload)
  select business_id, 'embed_product', jsonb_build_object('id', id) from public.products
  union all
  select business_id, 'embed_listing', jsonb_build_object('id', id) from public.wholesaler_listings
on conflict do nothing;
```

## Reports

```bash
pip install -r reports/requirements.txt
python reports/gst_report.py --business-id <uuid> --month 2026-09     # -> reports/out/*.pdf
```

The CGST/SGST split assumes intra-state supply.
