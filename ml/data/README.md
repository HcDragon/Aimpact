# Local data (git-ignored)

With `storage.backend: local`, the job reads one CSV per table from this folder.
The dataset is supplied separately; drop the files here using these columns
(extra columns are fine). Timestamps are ISO 8601.

| File | Columns the ML side uses |
|---|---|
| `businesses.csv` | business_id, name, type (`shop` or `restaurant`), is_synthetic |
| `products.csv` | product_id, business_id, name, unit, barcode, category, gst_rate, supplier_id |
| `sale_items.csv` | sale_id, business_id, product_id (shops) or dish_id (restaurants), qty, price, sold_at |
| `stock_batches.csv` | batch_id, business_id, product_id, quantity, cost_price, expiry_date |
| `suppliers.csv` | supplier_id, business_id, name, lead_time_days |
| `supplier_prices.csv` | supplier_id, business_id, product_id, price, pack_size, effective_from |
| `purchase_orders.csv` | po_id, business_id, product_id, qty, status (optional; counts as on-order when open) |
| `recipes.csv` | dish_id, business_id, name, price (restaurants) |
| `recipe_ingredients.csv` | dish_id, business_id, product_id, qty (per dish), unit |
| `wastage_log.csv` | business_id, dish_id, product_id, qty, reason, date |
| `reviews.csv` | review_id, business_id, text, source, date |

`forecasts.csv` is written here by the job. Prophet needs a few months of daily
history per item; items with under `forecasting.min_history_days` use the rule method.
If the data is synthetic, set `is_synthetic` true so every output is labelled.
