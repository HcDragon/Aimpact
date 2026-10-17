# Integration guide

How the real frontend and the Telegram bot talk to the backend. Every feature here is wired up
in `dummy-frontend/`, so copy from there when in doubt (look for `rpc(` and `fn(` calls).

- Money is **integer paise** everywhere (`₹12.50` → `1250`). Show it as ₹ with Indian grouping.
- Dates are `YYYY-MM-DD` in the API. Show them as DD/MM/YYYY in IST.
- Quantities are decimals in the product's `unit`.
- Use business-type wording: "Products/Stock" for shops, "Ingredients/Pantry" for restaurants.

---

## 1. Frontend (mobile app / Mini App)

### Auth
Phone OTP through Supabase Auth: `supabase.auth.signInWithOtp({ phone })`, then `verifyOtp({ phone, token, type: "sms" })`.
Locally, the numbers `919999900001-3` and `919999900009` use OTP `123456` (see `supabase/config.toml`).

After sign-in, load the user's businesses:
```js
supabase.from("staff_roles").select("role, businesses(*)").eq("user_id", user.id)
```
If there are none, onboard with `rpc("create_business", { p_name, p_business_type: "shop"|"restaurant"|"wholesaler", p_language, p_city, p_gstin, p_state_code, p_phone })`.

### Reading data (RLS scopes everything to the user's businesses)

| What | Call |
| --- | --- |
| Home screen numbers | `rpc("dashboard", { p_business_id })` |
| Stock list with on-hand, next expiry, value | `from("product_stock").select("*").eq("business_id", id)` |
| Batches of one item | `from("stock_batches").select("*").eq("product_id", pid).gt("qty_remaining", 0)` |
| Alerts | `from("alerts").select("*").eq("business_id", id).eq("status", "open")`. Realtime is enabled on `alerts`. |
| Reorder suggestions | `rpc("reorder_suggestions", { p_business_id })` |
| Forecast chart | `from("forecasts")` + `from("daily_usage")` |
| Profit report | `rpc("profit_report", { p_business_id, p_from, p_to })` |
| GST summary | `rpc("gst_report", { p_business_id, p_from, p_to })` |
| Khata balances | `from("khata_balances").select("*").eq("business_id", id)` |
| Morning insight | latest `alerts` row with `kind = 'insight'` |

### Writing data (always through these functions; they keep stock, batches and alerts consistent)

| Action | Call |
| --- | --- |
| Sell | `rpc("record_sale", { p_business_id, p_items: [{product_id, qty, unit_price_paise?}], p_payment_mode: "cash"\|"upi"\|"card"\|"credit", p_channel, p_khata_customer? })` |
| Stock in / purchase | `rpc("record_purchase", { p_business_id, p_purchase: {supplier_id? \| supplier_name?, invoice_no?, invoice_date?, source?}, p_items: [{product_id? \| name, qty, unit_cost_paise, gst_rate?, expiry_date?, batch_no?, unit?}] })`. Unknown names become new products. |
| Stock count | `rpc("adjust_stock", { p_business_id, p_product_id, p_counted_qty, p_expiry_date? })` |
| Wastage | `rpc("log_wastage", { p_business_id, p_product_id, p_qty, p_reason, p_note? })` |
| Khata entry | `rpc("khata_add", { p_business_id, p_customer, p_kind: "credit"\|"payment", p_amount_paise, p_note?, p_phone? })` |
| Draft POs from suggestions | `rpc("create_draft_purchase_orders", { p_business_id })` |
| Goods received for a PO | `rpc("receive_purchase_order", { p_po_id, p_expiry?: {product_id: "YYYY-MM-DD"} })` |
| Re-check alerts now | `rpc("refresh_alerts", { p_business_id })` |
| Add staff | `rpc("add_staff", { p_business_id, p_login, p_role })` |
| Products, suppliers, recipes, reviews, listings | Plain `insert` / `update` on the table (RLS enforced) |

Sale semantics: `unit_price_paise` includes GST. Stock is taken from the earliest-expiry batch first.
Selling a restaurant dish deducts its recipe ingredients. A sale **never fails for lack of stock**:
the shortfall comes back in `shortages`.

### AI endpoints (Edge Functions)
Call them with `supabase.functions.invoke(name, { body: { business_id, ... } })`. The user's JWT is sent automatically.

| Function | Body | Returns |
| --- | --- | --- |
| `scan-bill` | `{ storage_path }` (upload to bucket `bills` at `<business_id>/<uuid>.jpg` first) or `{ image_base64 }` | `{ ok, draft: {purchase, items[]}, warnings[] }` or `{ ok:false, fallback:"manual", reason }`. Show the draft for editing, then call `record_purchase`. |
| `voice-command` | `{ audio_base64, mime_type }` or `{ text }` | `{ transcript, intent, draft, reply, needs_confirmation }`. On confirm, send `{ confirm: true, draft }`. |
| `assistant` | `{ question, history? }` | `{ answer, ai }` (`ai:false` = plain summary, chat model unavailable) |
| `product-search` | `{ text }` or `{ image_base64 }`, `scope: "network"\|"catalog"` | wholesaler listings or own products, by similarity |
| `import-orders-csv` | `{ channel: "zomato"\|"swiggy", csv_text, commit?, mapping? }` | preview, then import (safe to re-run) |

**The app must keep working when AI fails.** Every AI endpoint returns a `fallback`/`ai:false`
response instead of an error, so show the manual form in that case.

Audio: Gemini accepts WAV, MP3, AAC, OGG and FLAC. Browser `MediaRecorder` produces WebM, so the
dummy frontend converts to 16 kHz WAV (`recordAudio` in `dummy-frontend/lib.js`). Telegram
voice notes are OGG/Opus and can be sent as is.

---

## 2. Telegram bot

The bot is a separate service that holds `TELEGRAM_BOT_TOKEN` and the **Supabase service key**.
Never ship either to a client.

Every call is `POST {SUPABASE_URL}/functions/v1/<name>` with these headers:
```
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
Content-Type: application/json
```
Pass `telegram_chat_id` instead of `business_id`. The backend resolves the linked business.

### Linking a chat
1. The owner taps **Settings → Get Telegram link code** in the app and gets a 6-digit code (valid 15 minutes).
2. The user sends `/start 123456` to the bot.
3. The bot calls `telegram-link` with `{ "action": "link", "code": "123456", "chat_id": <chat.id> }`
   and gets back `{ ok, business_id, business: { name, business_type, language } }`.

Also available: `{ action: "resolve", chat_id }` (is this chat linked?) and `{ action: "unlink", chat_id }`.

### Messages
| User sends | Bot calls | Then |
| --- | --- | --- |
| Text | `voice-command` `{ telegram_chat_id, text }` | Send `reply`. If `needs_confirmation`, show ✅/❌ inline buttons and keep `draft` (e.g. keyed by message id). |
| Voice note | download the file, then `voice-command` `{ telegram_chat_id, audio_base64, mime_type: "audio/ogg" }` | same |
| ✅ pressed | `voice-command` `{ telegram_chat_id, confirm: true, draft }` | send `reply` ("Ho gaya ✅") |
| Photo of a bill | `scan-bill` `{ telegram_chat_id, image_base64 }` | Summarise `draft.items` and ask to confirm or open the Mini App to edit. Save with `voice-command` confirm or the Mini App. |
| Photo of a product, "best price?" | `product-search` `{ telegram_chat_id, image_base64 }` | list the top 3 network prices |
| Question | `assistant` `{ telegram_chat_id, question }` | send `answer` |

Replies come back in the business's language (`en`, `hi`, `mr`, `hinglish`). Questions sent to
`voice-command` are answered directly (`intent: "question"`, no confirmation needed).

### Alerts
`notify-telegram` runs at 07:00 IST via pg_cron and sends open alerts to every linked chat. It
only needs `TELEGRAM_BOT_TOKEN` set as a Supabase secret. The bot does not have to do anything.

### Errors
`404` means the chat is not linked: ask the user to link it. Other non-2xx responses carry
`{ error }`. AI failures return `200` with `ok:false` and a `reply` telling the user to use the app form.

---

## 3. Forecasting models
See [forecasting/README.md](../forecasting/README.md). In short, write `forecasting/model.py`
with `forecast_business(...)` (and optionally `bundles_for_business(...)`). The runner, data
loading and DB writes are already done.
