# Dukaan Sahayak

An AI inventory and business assistant for small Indian shops, restaurants and their wholesalers.
It runs on Supabase (Postgres + Edge Functions). Groq/Grok answer questions, Gemini reads bills
and voice notes and powers photo search, and the database computes every number.

## Quick start (local)

Prerequisites: Docker, Node 18+, Python 3.10+.

```bash
npx supabase start && npx supabase db reset
cp supabase/functions/.env.example supabase/functions/.env     # optional: add GROQ_API_KEY, GEMINI_API_KEY
npx supabase functions serve --env-file supabase/functions/.env &
python3 -m http.server 5173 --directory dummy-frontend
```

Open http://127.0.0.1:5173 and sign in as `shop@demo.test`, `restaurant@demo.test` or
`wholesale@demo.test` (password `password123`), or use phone `919999900001` with OTP `123456`.
Everything works without AI keys. AI features fall back to manual or rule-based paths.

## What's here

| Path | What |
| --- | --- |
| `supabase/migrations/` | Schema, RLS, business logic (FIFO stock, recipes, reorder points, alerts, profit, GST), cron, AI queue |
| `supabase/functions/` | `scan-bill`, `voice-command`, `assistant`, `product-search`, `import-orders-csv`, `ai-worker`, `telegram-link`, `notify-telegram` |
| `supabase/seed.sql` | Three demo businesses with 90 days of sales, purchases, recipes and wholesaler listings |
| `config/ai.json` | The only place model names live |
| `dummy-frontend/` | Plain HTML/JS UI that exercises every feature. To be replaced by the real frontend. |
| `forecasting/` | Nightly job runner. The Prophet/Apriori model plugs in as `model.py`. |
| `reports/` | GST + profit PDF generator |
| `docs/INTEGRATION.md` | **For the frontend and Telegram bot teammates.** Every call they need. |
| `docs/OPERATIONS.md` | Deploying, secrets, cron jobs, AI fallbacks, re-embedding |
| `scripts/smoke_test.sh` | API smoke test |

## Features

- **Stock in without typing:** barcode scan, bill photo (Gemini extracts it, you confirm), voice or text ("50 parle g aaya").
- **Expiry and low-stock alerts:** per-batch expiry, FIFO by expiry. Alerts run daily and after every stock movement, show live in the app and go to Telegram.
- **Forecast-driven reordering:** reorder point = lead-time demand + safety stock (from `yhat_upper - yhat`). Perishables are capped at their shelf life. Draft POs go to the preferred or cheapest supplier.
- **Real profit:** COGS from actual batch costs, wastage included, margin per item and per channel.
- **GST-ready:** output tax and ITC by rate, CGST/SGST, HSN summary, CSV and PDF export.
- **Restaurants:** recipes deduct ingredients, food-cost %, wastage log, Zomato/Swiggy CSV import (idempotent).
- **Khata (udhaar):** credit sales and payments with running balances.
- **Wholesaler network:** wholesalers list products, and shops search by text or photo (Gemini embeddings, inside the network only).
- **Assistant:** Q&A in Hindi, Marathi, English or Hinglish over the business's own numbers, plus a nightly insight and review sentiment.
- **Multi-user:** owner, manager and staff roles. RLS on every table.
