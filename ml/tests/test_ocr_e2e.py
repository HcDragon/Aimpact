"""End-to-end OCR on a bill drawn at test time (no image files stored).

Opt-in because the first run downloads EasyOCR's pretrained weights:
    RUN_OCR=1 .venv/bin/python -m pytest tests/test_ocr_e2e.py -s
"""

import datetime as dt
import os
from pathlib import Path

import numpy as np
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("RUN_OCR") != "1", reason="set RUN_OCR=1 to run EasyOCR")

FONT_CANDIDATES = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
                   "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]

ROWS = [  # name, hsn, qty, rate, gst, amount
    ("Parle-G Biscuit 80g", "19053100", "48", "8.50", "18%", "408.00"),
    ("Maggi Masala 70g", "19023010", "24", "12.00", "12%", "288.00"),
    ("Tata Salt 1kg", "25010020", "10", "22.00", "5%", "220.00"),
    ("Fortune Oil 1L", "15121110", "6", "145.00", "5%", "870.00"),
]


def draw_bill(skew_deg=2.5, noise=8, seed=0):
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    font_path = next((f for f in FONT_CANDIDATES if Path(f).exists()), None)
    font = lambda s: ImageFont.truetype(font_path, s) if font_path else ImageFont.load_default()
    img = Image.new("L", (1400, 1050), 255)
    d = ImageDraw.Draw(img)
    d.text((60, 40), "GUPTA DISTRIBUTORS", font=font(48), fill=0)
    d.text((60, 110), "Shop 4, APMC Market, Pune", font=font(26), fill=40)
    d.text((60, 150), "GSTIN: 27AAPFU0939F1ZV", font=font(28), fill=0)
    d.text((60, 200), "Invoice No: 118", font=font(28), fill=0)
    d.text((900, 200), "Date: 15/10/2026", font=font(28), fill=0)
    cols = [60, 560, 760, 900, 1060, 1200]
    y = 280
    for x, h in zip(cols, ["Item", "HSN", "Qty", "Rate", "GST%", "Amount"]):
        d.text((x, y), h, font=font(30), fill=0)
    d.line((50, y + 45, 1350, y + 45), fill=0, width=2)
    y += 70
    for row in ROWS:
        for x, v in zip(cols, row):
            d.text((x, y), v, font=font(30), fill=0)
        y += 60
    d.line((50, y, 1350, y), fill=0, width=2)
    d.text((900, y + 20), "Sub Total", font=font(30), fill=0)
    d.text((1200, y + 20), "1786.00", font=font(30), fill=0)
    d.text((900, y + 70), "GST", font=font(30), fill=0)
    d.text((1200, y + 70), "163.00", font=font(30), fill=0)
    d.text((900, y + 130), "Grand Total", font=font(34), fill=0)
    d.text((1200, y + 130), "1949.00", font=font(34), fill=0)
    # Phone-photo damage: tilt, blur, sensor noise.
    img = img.rotate(skew_deg, resample=Image.BICUBIC, expand=True, fillcolor=255).filter(ImageFilter.GaussianBlur(0.8))
    arr = np.array(img).astype(np.int16)
    arr += np.random.default_rng(seed).normal(0, noise, arr.shape).astype(np.int16)
    return np.clip(arr, 0, 255).astype(np.uint8)


DAMAGE = {  # name: (skew degrees, noise sigma, scale)
    "mild": (2.5, 8, 1.0),
    "tilt 6deg": (6, 8, 1.0),
    "noisy": (2, 25, 1.0),
    "low-res 0.5x": (2, 8, 0.5),
    "low-res 0.35x": (2, 8, 0.35),
    "tilt -8deg noisy": (-8, 18, 0.7),
}


@pytest.fixture(scope="module")
def engine():
    from ocr.engine import EasyOCREngine
    from settings import load_config
    return EasyOCREngine(load_config())


@pytest.fixture(scope="module", params=list(DAMAGE), ids=list(DAMAGE))
def result(request, engine):
    import cv2
    from ocr.pipeline import scan_bill
    from settings import load_config

    skew, noise, scale = DAMAGE[request.param]
    g = draw_bill(skew, noise, seed=1)
    if scale != 1.0:
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return scan_bill(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR), load_config(), engine, today=dt.date(2026, 10, 17))


def test_header_fields(result):
    b = result["bill"]
    assert b["gstin"] == "27AAPFU0939F1ZV"
    assert b["invoice_date"] == "2026-10-15"
    assert b["invoice_total"] == 1949.0
    assert "GUPTA" in (b["supplier_name"] or "")


def test_line_items(result):
    got = [(i["qty"], i["unit_price"], i["gst_rate"], i["line_total"]) for i in result["bill"]["items"]]
    expected = [(float(q), float(r), float(g.rstrip("%")), float(a)) for _, _, q, r, g, a in ROWS]
    assert got == expected


def test_validates_and_accepted(result):
    v = result["validation"]
    assert v["valid"] and v["accepted"], v.get("flags") or v.get("errors")
