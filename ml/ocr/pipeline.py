"""Bill-scan pipeline: photo -> preprocess -> OCR -> lines -> parse -> validate.

    python -m ocr.pipeline path/to/bill.jpg [--engine easyocr] [--debug out_dir] [--business <id>]

The output `bill` has the same shape as the Gemini bill scan (shared/ai/schemas/
bill_scan.json) and goes through the same validator, so the Edge Function and
the bot treat both identically. Nothing is saved here: the owner confirms first.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import string
import time
from pathlib import Path

import cv2

from ocr.engine import get_engine
from ocr.layout import group_lines
from ocr.parser import parse_bill
from ocr.preprocess import load_image, prepare
from ocr.text_fix import find_gstins
from settings import load_config
from validators.bill_scan import validate_bill_scan


def match_items(bill: dict, products) -> list[dict]:
    """Suggest a catalog product per extracted line (FR-E4); names stay as printed."""
    from embeddings.match import match

    return [match(it["name"], products) for it in bill["items"]]


_GSTIN_LINE = re.compile(r"GSTIN|GST\s*(NO|N0|IN)\b", re.I)


def reread_gstin(engine, prepared, lines) -> tuple[str, bool] | None:
    """Detector boxes often stop short of long codes; re-read labelled lines to the page edge."""
    if not hasattr(engine, "read_region"):
        return None
    for ln in lines:
        if not _GSTIN_LINE.search(ln.text):
            continue
        y0, y1 = ln.y - 0.9 * ln.height, ln.y + 0.9 * ln.height
        x0 = min(t.x0 for t in ln.tokens) - ln.height
        hits = engine.read_region(prepared.gray, x0, y0, prepared.gray.shape[1], y1,
                                  allowlist=string.ascii_uppercase + string.digits + ": -")
        text = " ".join(h.text for h in sorted(hits, key=lambda h: h.x0))
        found = find_gstins(["GSTIN " + text])
        if found and found[0][1]:
            return found[0]
    return None


def _gemini_fallback(source, result: dict) -> dict | None:
    from gemini_client import Gemini, GeminiUnavailable

    data = source if isinstance(source, (bytes, bytearray)) else Path(source).read_bytes()
    try:
        raw = Gemini().generate_json("bill_scan", media=data, mime_type="image/jpeg")
    except GeminiUnavailable:
        return None
    v = validate_bill_scan(raw)
    if not v["valid"]:
        return None
    ocr_flags = len(result["validation"].get("flags", [])) if result["validation"]["valid"] else 99
    return v if len(v["flags"]) < ocr_flags else None


def scan_bill(source, cfg: dict | None = None, engine=None, products=None,
              today: dt.date | None = None) -> dict:
    cfg = cfg or load_config()
    t0 = time.perf_counter()
    prepared = prepare(source, cfg)
    t1 = time.perf_counter()
    engine = engine or get_engine(cfg)
    words = engine.read(prepared)
    t2 = time.perf_counter()
    lines = group_lines(words, cfg["ocr"]["line_merge_ratio"])
    parsed = parse_bill(lines, prepared.gray.shape[1], cfg, today)

    bill = parsed["bill"]
    if bill["gstin"] is None or any("fails its checksum" in w for w in bill["warnings"]):
        if (g := reread_gstin(engine, prepared, lines)) is not None:
            bill["gstin"] = g[0]
            bill["warnings"] = [w for w in bill["warnings"] if "fails its checksum" not in w]
    t3 = time.perf_counter()
    validation = validate_bill_scan(bill) if bill["items"] else {
        "valid": False, "fallback": "manual_entry", "errors": ["no line items found"]}
    result = {
        "source": "ocr",
        "engine": engine.name,
        "bill": bill,
        "validation": validation,
        "preprocess_steps": prepared.steps,
        "lines": [{"i": ln.index, "text": ln.text, "min_conf": round(ln.min_conf, 3)} for ln in lines],
        "extra": parsed["extra"],
        "debug": parsed["debug"],
        "timings_s": {"preprocess": round(t1 - t0, 2), "ocr": round(t2 - t1, 2), "parse": round(t3 - t2, 2)},
        "_words": words,
        "_prepared": prepared,
    }
    if products is not None and bill["items"]:
        result["catalog_matches"] = match_items(bill, products)
    if cfg["ocr"]["fallback"] == "gemini" and not (validation["valid"] and validation["accepted"]):
        if (g := _gemini_fallback(source, result)) is not None:
            result.update(source="gemini_fallback", bill=g["bill"], validation=g)
    return result


def public(result: dict) -> dict:
    """Result without the in-memory image and word objects."""
    out = {k: v for k, v in result.items() if not k.startswith("_")}
    out["words"] = [w.as_dict() for w in result.get("_words", [])]
    return out


def save_debug(result: dict, out_dir: Path, stem: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    img = cv2.cvtColor(result["_prepared"].gray, cv2.COLOR_GRAY2BGR)
    for w in result["_words"]:
        colour = (0, 160, 0) if w.conf >= 0.8 else (0, 165, 255) if w.conf >= 0.5 else (0, 0, 255)
        cv2.rectangle(img, (int(w.x0), int(w.y0)), (int(w.x1), int(w.y1)), colour, 2)
    cv2.imwrite(str(out_dir / f"{stem}_boxes.png"), img)
    cv2.imwrite(str(out_dir / f"{stem}_binary.png"), result["_prepared"].binary)
    (out_dir / f"{stem}.json").write_text(json.dumps(public(result), indent=2, ensure_ascii=False))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--engine", choices=["easyocr", "tesseract"])
    p.add_argument("--debug", help="directory for annotated boxes, binarised image and full JSON")
    p.add_argument("--business", help="match extracted names against this business's catalog")
    a = p.parse_args()
    cfg = load_config()
    products = None
    if a.business:
        from db import get_store
        products = get_store().read("products", a.business)
    load_image(a.image)  # fail fast on unreadable files
    result = scan_bill(a.image, cfg, get_engine(cfg, a.engine), products)
    if a.debug:
        save_debug(result, Path(a.debug), Path(a.image).stem)
    out = public(result)
    out.pop("words")
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
