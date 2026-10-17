# CLAUDE.md

Guidance for Claude when working in this repository.

## Project

AI-powered inventory and business assistant for small Indian shops (kirana, retail) and restaurants, with a wholesaler network on the supply side. Owners use a mobile app and a **Telegram bot** (no WhatsApp). One platform serves both business types; `business_type` (`shop` | `restaurant` | `wholesaler`) switches modules, wording and dashboards. Wholesalers only list products for the network.

Core jobs: get stock in without typing (barcode, bill photo, voice note), alert before items expire or run out, forecast demand, automate reordering, show real profit, and produce GST-ready reports.

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Supabase: Postgres, Auth (phone OTP), Storage, Edge Functions (TypeScript/Deno), pg_cron, Realtime |
| Vector search | pgvector in Supabase |
| AI (basic answers) | Chat model via OpenAI-compatible API: Groq by default, xAI Grok optional (assistant Q&A, command parsing, review sentiment, insight text) |
| AI (search + multimodal) | Gemini Flash (bill photos, voice transcription), Gemini Embedding 2 (photo and product search) |
| Forecasting | Separate Python job: Prophet + mlxtend (Apriori), runs nightly |
| Chat | Telegram Bot API + Telegram Mini App |
| Mobile app | TBD; barcode scanning on-device (ML Kit / ZXing) |
| Reports | Python PDF generation for GST and sales reports |

## Repository layout

```
supabase/
  migrations/        # schema, RLS, business logic (stock/GST/profit/reorder), pg_cron, AI queue
  functions/         # Edge Functions; shared code in functions/_shared/
  seed.sql           # demo data (3 businesses, 90 days of sales)
config/ai.json       # model names + AI limits (the only place model names live)
dummy-frontend/      # plain HTML/JS dev UI exercising every feature (real frontend is a teammate's)
forecasting/         # nightly job runner; model.py adapts ml/ (Prophet/Apriori); evaluate_forecasts.py
ml/                  # ML package: forecast tiers + evaluation, bundles, EasyOCR bill-scan service (ml/ocr/server.py)
shared/ai/           # prompts, JSON schemas, validator fixtures for the Python ML tools
reports/             # GST/profit PDF generator
docs/                # INTEGRATION.md (frontend + bot contracts), OPERATIONS.md
scripts/             # smoke_test.sh
```

Team split: the real frontend/Mini App, the forecasting model (`forecasting/model.py`) and the Telegram bot
are built by teammates against the contracts in `docs/INTEGRATION.md` and `forecasting/README.md`.

## Architecture rules

1. **Local code calculates every number. AI only understands messy input and writes explanations.**
   - Never use any AI model for GST math, stock counts, margins, forecasts or safety stock.
   - Chat model (Groq/Grok) for basic answers: assistant Q&A, parsing text/voice commands into JSON, review sentiment, insight text.
   - Gemini only for search and multimodal: bill photo extraction, voice transcription, embeddings for photo/product search.
2. **Prophet runs only in the Python job**, never in Edge Functions (Deno cannot run it). The job reads sales from Supabase and writes to the `forecasts` table; the rest of the app only reads that table.
3. **The core app must work without AI.** If a Gemini or chat call fails or is rate-limited, fall back (manual entry, rule-based parser, text search, plain summary). Never block stock updates on an AI call.
4. **Users confirm AI extractions** (scanned bills, voice commands) before they are saved.
5. **Telegram only** for chat. Do not add WhatsApp integrations.
6. **Photo price search stays inside our wholesaler network.** No web scraping or external price search.

## Database conventions

- Every business-owned table has a `business_id` column and **Row Level Security enabled**, with policies scoped to the user's business. Never create a table without RLS.
- Restaurant-only tables: `recipes`, `recipe_ingredients`, `wastage_log`. Shop code must not depend on them.
- Stock is tracked per batch (`stock_batches`) so expiry dates are accurate.
- Selling a dish in a restaurant deducts ingredients via `recipe_ingredients`.
- Product embeddings live in a pgvector column on `products`. Embed once when a product is created or renamed, never on every search.
- Store money as integer paise or `numeric`, never floating point. Store GST rate per product.
- All schema changes go through files in `supabase/migrations/`. Do not edit the database by hand.

Key tables: `businesses`, `users`, `staff_roles`, `products`, `stock_batches`, `sales`, `sale_items`, `purchases`, `purchase_items`, `suppliers`, `supplier_prices`, `purchase_orders`, `forecasts`, `alerts`, `khata_entries`, `reviews`, `recipes`, `recipe_ingredients`, `wastage_log`, `wholesaler_listings`.

## AI usage

- Model names live in **one config file** (`config/ai.json`); never hard-code them elsewhere. Chat provider is switched with `CHAT_PROVIDER=groq|xai`.
- Edge Functions use `_shared/chat.ts` (chat model) and `_shared/gemini.ts` (Gemini); both retry with backoff and go through `_shared/cache.ts`.
- Changing the embedding model requires re-embedding the whole catalog; vectors from different models are not comparable.
- We use the **free tier**: route calls through a queue with retries, exponential backoff and caching. Batch non-urgent work (sentiment, insights) into nightly jobs.
- Ask models for **structured JSON** with a defined schema, and validate the response (zod, `_shared/schemas.ts`) before using it.
- Free-tier content may be used by Google/Groq; do not send data beyond what a task needs.

## Forecasting job

- Use `add_country_holidays('IN')` so festivals are accounted for.
- Forecast the top ~20% of items individually; use category-level forecasts or moving averages for slow movers.
- Businesses with too little history get rule-based reorder levels until enough data exists.
- Safety stock is derived from the gap between Prophet's `yhat_upper` and `yhat`.
- Runs nightly as a batch job; never in a request path.

## Product conventions

- Users are small business owners with limited time and tech comfort: minimal typing, short messages, regional-language support (Hindi, Marathi, English, Hinglish).
- Use business-type wording: "products" and "stock" for shops, "ingredients" and "pantry" for restaurants.
- Currency is INR (₹); dates in Indian format (DD/MM/YYYY) in the UI; times in IST.
- Zomato and Swiggy data comes from CSV exports uploaded by restaurants; there is no API integration.

## Secrets

- Never commit API keys, the Telegram bot token or Supabase service-role keys. Use environment variables and Supabase secrets.
- The service-role key is used only in Edge Functions and the forecasting job, never in client apps.

## Commands

```
# Supabase local dev (CLI via npx)
npx supabase start
npx supabase db reset                                   # migrations + seed
npx supabase functions serve --env-file supabase/functions/.env
python3 -m http.server 5173 --directory dummy-frontend  # dev UI; shop@demo.test / password123

# Forecasting job (model in ml/; evaluate first so losing tiers use the baseline)
pip install -r forecasting/requirements.txt
python forecasting/evaluate_forecasts.py
python forecasting/run_forecasts.py

# Bill OCR fallback for scan-bill (set OCR_SERVICE_URL for the functions)
cd ml && .venv/bin/python -m ocr.server --port 8090
cd ml && .venv/bin/python -m pytest -q          # ML tests (RUN_OCR=1 adds real-OCR tests)

# GST PDF
python reports/gst_report.py --business-id <uuid> --month YYYY-MM

# Tests
bash scripts/smoke_test.sh                              # needs the local stack + functions serve
```

## Implementation notes

- Writes that touch stock go through SQL functions (`record_sale`, `record_purchase`, `log_wastage`, `adjust_stock`, `receive_purchase_order`), never direct table inserts. They keep batches, COGS and alerts consistent.
- SQL functions call `assert_member(business_id)`. The service role (bot, cron) passes, and so do direct DB connections.
- Edge Functions resolve the caller with `getContext()`: a user JWT (RLS applies), or the service key plus `business_id`/`telegram_chat_id` (bot).
- Bulk loads set `app.skip_alerts = 'on'` and run one `refresh_stock_alerts` at the end.
