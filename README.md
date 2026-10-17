# Aimpact — SmartInventory AI/ML

The AI/ML workstream from the SmartInventory PRD: a nightly Python job that writes
forecasts and safety stock into Supabase, plus the Gemini prompts, JSON schemas and
validators the Edge Functions use for bill scanning, voice notes, reviews and insights.

Design rule: local code calculates every number. Gemini only reads messy input
(photos, audio, reviews) and writes explanations from numbers it is given. If Gemini
is down, inventory and forecasts keep working.

## Layout

```
ml/
  config.yaml          model names, horizons, thresholds, seeds
  db.py                LocalStore (CSV) / SupabaseStore, scoped to one business_id
  run_nightly.py       forecast -> safety stock -> write `forecasts` -> extras
  forecasting/         tiers.py, prophet_job.py, baseline.py, evaluate.py
  inventory/           safety_stock.py, reorder.py
  restaurant/          ingredient_demand.py, prep_list.py
  shop/                dead_stock.py, bundles.py
  embeddings/          match.py, embed_catalog.py, reembed.py
  validators/          Python mirrors of the TS validators
  insights/ reviews/   Gemini language tasks (P3)
  eval/                scorers + runner for labelled sets (see eval/README.md)
  sql/forecasts.sql    proposed ML-owned table and columns
  data/                local CSVs (supplied separately, git-ignored)
  reports/             metrics JSON + evaluation.md from real runs only
  tests/
shared/ai/
  prompts/             bill_scan.md, voice_intent.md, review_sentiment.md, insights.md
  schemas/             bill_scan.json, voice_intent.json, review.json, insights.json
  validators/          bill_scan.ts, voice_intent.ts (imported by Edge Functions)
  fixtures/            validator contract cases shared by TS and Python tests
```

## Setup

```bash
cd ml
uv venv --python 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -r requirements.txt
cp .env.example .env        # fill in Supabase and Gemini keys
```

Put the dataset CSVs in `ml/data/` (column formats in [ml/data/README.md](ml/data/README.md)),
or set `storage.backend: supabase` in `config.yaml`.

## Run

```bash
cd ml
python run_nightly.py --business <business_id>              # add --backend supabase, --as-of YYYY-MM-DD
python -m forecasting.evaluate --business <business_id>     # holdout vs seasonal-naive -> reports/evaluation.md
python -m embeddings.embed_catalog --business <business_id>
python -m reviews.sentiment_batch --business <business_id>
python -m insights.generate --business <business_id>
python -m eval.run_eval bills|voice|reviews|matching
```

Run `forecasting.evaluate` before the nightly job: any tier where the seasonal-naive
baseline wins is then forecast with the baseline.

## Test

```bash
cd ml && .venv/bin/python -m pytest -q          # Python: validators, inventory, leakage, scope, insights, ...
node --test shared/ai/validators/validators.test.ts   # TS validators (Node >= 22.18), from repo root
```

## How it works

- **Forecasting.** The top ~20% of items by volume get Prophet with `add_country_holidays('IN')`
  plus Diwali / Holi / Eid / Ganesh Chaturthi windows. Slow movers get a category-level Prophet
  split by item share, or a 28-day moving average. Items with under 56 days of history use
  `method: rule`. The horizon is 14 days, clipped at zero.
- **Safety stock.** Σ(yhat_upper − yhat) over supplier lead time. Reorder point = Σ yhat + safety
  stock. Reorder qty = shortfall vs on-hand + on-order, rounded up to pack size. All three values
  are repeated on every row of an item, and each row carries a one-line `reason`.
- **Restaurants.** Dishes are forecast from `sale_items.dish_id`. Ingredient demand = dish forecast
  × recipe qty (`method: recipe`), and ingredients get the reorder policy. The prep list is cut by
  recent wastage (by at most 30%). Perishable flags use recorded expiry dates only.
- **Gemini.** Every output goes through a validator. Malformed output → manual entry, nothing
  written. Arithmetic mismatches → `accepted: false` with the flagged fields, so the owner corrects
  them. The owner confirms every extraction. Insight text with a number not in its input is rejected.

## Bill OCR (EasyOCR)

A local alternative to the Gemini bill scan. It returns the same `bill_scan.json` shape and goes
through the same validator, so the owner-confirm flow is unchanged.

```bash
cd ml
python -m ocr.pipeline bill.jpg --debug out/          # out/ gets boxes overlay, binarised image, full JSON
python -m ocr.pipeline bill.jpg --business <id>       # also suggests catalog matches per line
python -m eval.run_eval bills --engine easyocr        # measure on the labelled bill set
RUN_OCR=1 .venv/bin/python -m pytest tests/test_ocr_e2e.py   # real OCR on generated, damaged bills
```

Stages ([ml/ocr/](ml/ocr/)): `preprocess` (paper crop, perspective flatten, resize, denoise,
projection-profile deskew, CLAHE, shadow-flattened binary copy) → `engine` (EasyOCR on grayscale and
binary, keeping the more confident box; low-confidence numbers re-read with a digit allowlist) →
`layout` (skew-tolerant line grouping, table-header column detection) → `parser` (arithmetic decoding
of qty × rate = amount, GST-column % repair, typo-tolerant totals, GSTIN check-digit repair plus a
label-anchored re-read) → validator. Uncertain fields become owner-facing warnings; nothing is saved
without confirmation. Pretrained EasyOCR weights download on first run into `ml/.cache/easyocr`.
Tesseract is supported as `--engine tesseract` once the `tesseract` binary is installed.

## Assumptions and limitations

- Gemini model ids in `config.yaml` (`gemini-flash-latest`, `gemini-embedding-2`) are placeholders
  to confirm against the key. Changing the embedding model requires `python -m embeddings.reembed`.
- Restaurant dish sales are assumed to be in `sale_items.dish_id` (open question in the PRD).
- Free-tier Gemini content may be used by Google: demo data only until the privacy policy says so.
- No metric goes in the pitch unless it came from a real run in `ml/reports/`.
