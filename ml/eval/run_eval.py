"""Runs the Gemini evaluations against hand-labelled sets and writes reports/<task>_metrics.json.

    python -m eval.run_eval bills      # eval/bills/labels.jsonl + images (Gemini)
    python -m eval.run_eval bills --engine easyocr   # same set through the local OCR pipeline
    python -m eval.run_eval voice      # eval/voice/labels.jsonl + audio
    python -m eval.run_eval matching --business <id>
    python -m eval.run_eval reviews    # eval/reviews/labels.jsonl

Label formats are documented in eval/README.md. Responses are cached, so a
re-run only calls Gemini for new files. Nothing runs without labelled data.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import sys
from pathlib import Path

from eval.scorers import aggregate_bills, score_bill, score_matching, score_reviews, score_voice
from settings import REPORTS_DIR, ml_path
from validators.bill_scan import validate_bill_scan
from validators.voice_intent import validate_voice_intent


def load_labels(task: str) -> tuple[Path, list[dict]]:
    d = ml_path("eval", task)
    path = d / "labels.jsonl"
    if not path.exists():
        raise SystemExit(f"no labelled set at {path}; see eval/README.md")
    return d, [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _media(d: Path, name: str) -> tuple[bytes, str]:
    p = d / name
    return p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream"


def run_bills(gem, engine: str = "gemini") -> dict:
    d, labels = load_labels("bills")
    results, invalid = [], 0
    ocr_engine = None
    if engine != "gemini":
        from ocr.engine import get_engine
        from ocr.pipeline import scan_bill
        from settings import load_config
        ocr_cfg = load_config()
        ocr_engine = get_engine(ocr_cfg, engine)
    for lab in labels:
        data, mime = _media(d, lab["file"])
        if ocr_engine is not None:
            v = scan_bill(data, ocr_cfg, ocr_engine)["validation"]
        else:
            v = validate_bill_scan(gem.generate_json("bill_scan", media=data, mime_type=mime))
        invalid += not v["valid"]
        results.append(score_bill(v["bill"] if v["valid"] else None, lab["expected"]))
    return {**aggregate_bills(results), "invalid_outputs_fell_back_to_manual": invalid}


def run_voice(gem) -> dict:
    d, labels = load_labels("voice")
    preds, invalid = [], 0
    for lab in labels:
        data, mime = _media(d, lab["file"])
        v = validate_voice_intent(gem.generate_json("voice_intent", media=data, mime_type=mime))
        invalid += not v["valid"]
        preds.append(v["intent"] if v["valid"] else None)
    return {"per_language": score_voice(preds, [l["expected"] for l in labels]),
            "invalid_outputs_fell_back_to_manual": invalid}


def run_matching(gem, business_id: str) -> dict:
    from db import get_store
    from embeddings.match import match

    products = get_store().read("products", business_id)
    d, labels = load_labels("matching")
    ranked, truth = [], []
    for lab in labels:
        if "file" in lab:  # photo query
            vec = gem.embed([_media(d, lab["file"])])[0]
            res = match("", products, query_vector=vec)
        else:
            vec = gem.embed([lab["text"]])[0] if gem.api_key else None
            res = match(lab["text"], products, query_vector=vec)
        ranked.append([c["product_id"] for c in res["candidates"]])
        truth.append(lab["product_id"])
    return score_matching(ranked, truth)


def run_reviews(gem) -> dict:
    from reviews.sentiment_batch import check_batch

    _, labels = load_labels("reviews")
    preds = {}
    for i in range(0, len(labels), 20):
        batch = labels[i:i + 20]
        raw = gem.generate_json("review_sentiment", text=json.dumps(
            [{"review_id": l["review_id"], "text": l["text"]} for l in batch], ensure_ascii=False))
        res = check_batch(raw, [l["review_id"] for l in batch])
        preds.update({r["review_id"]: r["sentiment"] for r in res["reviews"]})
    return score_reviews(preds, {l["review_id"]: l["sentiment"] for l in labels})


def main() -> None:
    from gemini_client import Gemini

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("task", choices=["bills", "voice", "matching", "reviews"])
    p.add_argument("--business", help="required for matching")
    p.add_argument("--engine", choices=["gemini", "easyocr", "tesseract"], default="gemini",
                   help="bills only: Gemini or the local OCR pipeline")
    a = p.parse_args()
    gem = Gemini()
    if a.task == "matching" and not a.business:
        raise SystemExit("--business is required for matching")
    metrics = {"bills": lambda: run_bills(gem, a.engine), "voice": lambda: run_voice(gem),
               "matching": lambda: run_matching(gem, a.business), "reviews": lambda: run_reviews(gem)}[a.task]()
    out = {"task": a.task, "command": "python -m eval.run_eval " + " ".join(sys.argv[1:]),
           "model": (a.engine if a.task == "bills" and a.engine != "gemini" else
                     gem.cfg["flash_model"] if a.task != "matching" else gem.cfg["embedding_model"]),
           "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "metrics": metrics}
    REPORTS_DIR.mkdir(exist_ok=True)
    suffix = f"_{a.engine}" if a.task == "bills" and a.engine != "gemini" else ""
    path = REPORTS_DIR / f"{a.task}{suffix}_metrics.json"
    path.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
