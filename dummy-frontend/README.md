# Dummy frontend (throwaway)

A React + Vite developer UI, styled with Tailwind CSS, that exercises every backend and ML feature
built so far. It exists to demo and test the APIs until the real frontend (Raj) replaces it.

**Safe to delete:** nothing in the repo imports from this folder. Remove it with
`git rm -r dummy-frontend` and drop the "dummy-frontend" lines from README.md, CLAUDE.md and
docs/OPERATIONS.md.

```bash
supabase start && supabase db reset
supabase functions serve --env-file supabase/functions/.env &
cd dummy-frontend && npm install && npm run dev            # http://127.0.0.1:5173
```

Point it at another project with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in `dummy-frontend/.env.local`.

Layout: `src/App.jsx` (shell, auth, routing), `src/pages/*.jsx` (one file per section),
`src/components/` (UI kit and SVG charts), `src/lib/` (Supabase API, formatting, camera/mic helpers),
`src/index.css` (Tailwind theme tokens, light and dark).

## Offline demo mode (current default)

`VITE_DEMO_MODE=offline` in `.env.local` runs the whole app in the browser with generated sample
data and no backend (`src/demo/`). Sales, purchases, stock counts and wastage update the numbers
live; reorder points, profit/GST, dead stock, perishable risk, prep list and bundles are computed
from the sample sales. Model-vs-baseline scores are labelled illustrative, and bill scan / voice /
assistant replies are rule-based stand-ins. Everything resets on page reload.

**Switch back to the real backend:** delete `src/demo/`, remove the three `OFFLINE DEMO` lines in
`src/lib/api.js` (the import, `OFFLINE_DEMO` and the ternary) and the `OFFLINE_DEMO` badge text in
`src/App.jsx`, drop `VITE_DEMO_MODE` from `.env.local`, then push the schema and seed to the
project (`supabase db push --include-seed`).

There is no login screen: the app signs in a demo account in the background (RLS needs a user) and
the top bar switches between the shop, restaurant and wholesaler accounts.

Demo accounts (real backend): `shop@demo.test`, `restaurant@demo.test`, `wholesale@demo.test`, password `password123`.

| Page | Backend it exercises |
|---|---|
| Home | `dashboard()`, latest insight alert, ML highlights (reorder, perishable risk, dead stock, top bundle) |
| Sell / POS | `record_sale()`, barcode scan, "often bought together" from `bundle_suggestions` |
| Assistant | `voice-command` (text, voice, confirm), `assistant` |
| Alerts | `alerts` + Realtime, `refresh_alerts()` |
| Stock / Pantry | `product_stock`, `products`, `stock_batches`, `adjust_stock()` |
| Purchases | `scan-bill` (Gemini, or the offline EasyOCR fallback: `engine: "ocr"`), `record_purchase()` |
| Reorder | `reorder_suggestions()` (forecast-driven), `create_draft_purchase_orders()`, `receive_purchase_order()` |
| Forecasts | `forecasts` (method per item) + `daily_usage`, model vs baseline from `forecast_evaluations` |
| Insights | `dead_stock()`, `perishable_risk()`, `bundle_suggestions` |
| Kitchen (restaurant) | `prep_list()`, recipes, `log_wastage()`, Zomato/Swiggy `import-orders-csv` |
| Suppliers / Network | `suppliers`, `supplier_prices`, `product-search` (text or photo), wholesaler listings |
| Money | `khata_add()`, `khata_balances`, `profit_report()`, `gst_report()`, reviews + sentiment |
| Settings | `businesses`, `add_staff()`, Telegram link codes |
