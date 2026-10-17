# ml/ — forecasting, analytics and bill OCR

The Python ML package behind Dukaan Sahayak. Design rule: local code calculates every number.
Models only read messy input (photos) or forecast from history. The Supabase backend
(`supabase/`) owns the data, stock, GST and reorder maths.

## What is wired into the backend

| Piece | Entry point | Used by |
|---|---|---|
| Demand forecasts | [`forecasting/model.py`](../forecasting/model.py) → `forecasting/prophet_job.py`, `tiers.py`, `baseline.py` | `python forecasting/run_forecasts.py` writes `public.forecasts`; `reorder_suggestions()` turns them into safety stock and reorder points |
| Model vs baseline evaluation | [`forecasting/evaluate_forecasts.py`](../forecasting/evaluate_forecasts.py) → `forecasting/evaluate.py` | writes `reports/forecast_metrics.json` + `evaluation.md`; `model.py` uses the baseline for tiers where it won |
| Frequently-bought-together | `shop/bundles.py` (Apriori, lift ≥ 1.2) | `model.bundles_for_business` → `public.bundle_suggestions` |
| Bill OCR fallback | `ocr/server.py` → `ocr/pipeline.py` | `scan-bill` Edge Function via `_shared/ocr.ts` when Gemini fails |

Forecasting tiers: the top ~20% of items by volume get Prophet with `add_country_holidays('IN')`
plus Diwali/Holi/Eid/Ganesh Chaturthi windows from `config.yaml`. Slow movers get a category-level
Prophet split by item share, or a 28-day moving average. Items with under 56 days of history are
skipped, so the SQL rule-based reorder level applies.

## Offline tools (local CSVs only)

These read `ml/data/*.csv` ([format](data/README.md)) and never write to Supabase. Several overlap
with backend features and are kept for experiments and evaluation:

- `run_nightly.py`: forecasts plus Python safety stock, prep list, perishables, dead stock and bundles,
  written to `data/forecasts.csv` and `reports/<business_id>/`. The backend equivalents are `reorder_suggestions()` and alerts.
  **Prep list, perishable-first flags and dead-stock discounts have no backend equivalent yet.**
- `reviews/`, `insights/`, `embeddings/`: superseded by the `ai-worker` Edge Function (sentiment, insights,
  embeddings). To re-embed, follow docs/OPERATIONS.md.
- `eval/`: scorers for labelled bill, voice, review and matching sets ([label format](eval/README.md)).
  `python -m eval.run_eval bills --engine easyocr` measures the OCR pipeline.

## Setup

```bash
cd ml
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt        # forecasting + evaluation
VIRTUAL_ENV=.venv uv pip install -r requirements-ocr.txt    # + EasyOCR / PyTorch for the bill OCR service
```

Model names come from `config/ai.json` (the repo's single source); everything else tunable is in
`config.yaml`. Keys are read from `ml/.env` or the repo-root `.env`.

## Bill OCR

```bash
python -m ocr.pipeline bill.jpg --debug out/      # one bill; out/ gets box overlay, binary image, JSON
python -m ocr.server --port 8090                  # service for scan-bill (see docs/OPERATIONS.md)
```

Stages ([ocr/](ocr/)):
1. `preprocess`: paper crop, perspective flatten, resize, denoise, projection-profile deskew, CLAHE,
   and a shadow-flattened binary copy.
2. `engine`: EasyOCR on the grayscale and binary images, keeping the more confident box.
   Low-confidence numbers are re-read with a digit allowlist.
3. `layout`: skew-tolerant line grouping and table-header column detection.
4. `parser`: decodes qty × rate = amount, repairs misread % signs in the GST column, tolerates typos
   in total keywords, and repairs GSTINs by check digit (with a re-read anchored on the label).
5. `validator`: the same arithmetic checks as scan-bill.

Uncertain fields become warnings, and nothing is saved without the owner's confirmation. Only
generated printed bills have been tested so far. Handwritten, thermal-receipt and Hindi bills
are not verified yet. Add `hi` to `ocr.languages` for Devanagari.

## Tests

```bash
.venv/bin/python -m pytest -q                       # unit + integration (no model fits, no OCR)
RUN_OCR=1 .venv/bin/python -m pytest -q             # adds real EasyOCR on six damaged, generated bills
node --test ../shared/ai/validators/validators.test.ts
```
