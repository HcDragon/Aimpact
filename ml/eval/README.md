# Labelled evaluation sets

Each folder holds a `labels.jsonl` (one JSON object per line) plus the media files it names.
Media and labels are git-ignored; keep them local. Run with `python -m eval.run_eval <task>`.

| Folder | Target size | Line format |
|---|---|---|
| `bills/` | 15–20 bill photos | `{"file": "bill01.jpg", "expected": {"items": [{"name", "qty", "unit_price", "gst_rate"}], "invoice_total": 803}}` |
| `voice/` | ~40 notes across hi / mr / en / Hinglish | `{"file": "note01.ogg", "expected": {"intent": "add_stock", "item": "Parle-G", "qty": 20, "language": "hinglish"}}` |
| `matching/` | ~30 photos + ~50 messy names | `{"text": "maggi"  OR  "file": "maggi.jpg", "product_id": "<catalog id>"}` |
| `reviews/` | ~50 reviews | `{"review_id": "r1", "text": "...", "sentiment": "positive"}` |

`expected` holds what is printed or said, not what the model returned.
