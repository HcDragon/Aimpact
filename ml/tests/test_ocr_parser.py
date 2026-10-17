"""OCR text fixes and bill parsing on hand-built OCR lines (no OCR engine needed)."""

import datetime as dt

import pytest

from ocr.engine import Word, merge_passes
from ocr.layout import group_lines
from ocr.parser import parse_bill
from ocr.text_fix import find_gstins, parse_date, parse_number, repair_gstin
from validators.bill_scan import validate_bill_scan

TODAY = dt.date(2026, 10, 17)
VALID_GSTIN = "27AAPFU0939F1ZV"  # published example with a correct check digit


@pytest.mark.parametrize("raw,value", [
    ("408.00", 408.0), ("₹1,250.50", 1250.5), ("Rs.803", 803.0), ("1,20,000", 120000.0),
    ("408,00", 408.0), ("4O8.OO", 408.0), ("l2", 12.0), ("85/-", 85.0), ("18%", 18.0), ("1.200.50", 1200.5),
])
def test_parse_number(raw, value):
    assert parse_number(raw).value == value


@pytest.mark.parametrize("raw", ["Oil", "SOAP", "Maggi", "Sl", "", "-"])
def test_words_are_not_numbers(raw):
    assert parse_number(raw) is None


@pytest.mark.parametrize("text,expected", [
    ("Date: 15/10/2026", dt.date(2026, 10, 15)),
    ("Dt. 05-10-26", dt.date(2026, 10, 5)),
    ("Invoice date 1O/O9/2O26", dt.date(2026, 9, 10)),
    ("12 Oct 2026", dt.date(2026, 10, 12)),
    ("2026-10-01", dt.date(2026, 10, 1)),
    ("10/25/2026", dt.date(2026, 10, 25)),  # DD/MM impossible -> MM/DD
])
def test_parse_date(text, expected):
    assert parse_date(text, TODAY) == expected


def test_dates_in_future_or_nonsense_rejected():
    assert parse_date("31/02/2026", TODAY) is None
    assert parse_date("01/01/2031", TODAY) is None
    assert parse_date("Ph 9876543210", TODAY) is None


def test_gstin_repair_fixes_confusables_and_check_digit():
    assert repair_gstin("27AAPFUO939F1ZV") == (VALID_GSTIN, True)   # O read for 0
    assert repair_gstin("2TAAPFU0939F1ZV") == (VALID_GSTIN, True)   # T read for 7
    assert repair_gstin("27AAPFU0939F12V") == (VALID_GSTIN, True)   # 2 read for Z
    assert find_gstins(["GSTIN: 27 AAPFU 0939 F1Z V"])[0] == (VALID_GSTIN, True)
    g, ok = repair_gstin("27AAPFU0939F1ZQ")
    assert not ok  # unfixable check digit stays flagged


def W(text, x0, y, conf=0.95, h=30, cw=16):
    return Word(text, conf, x0, y, x0 + cw * len(text), y + h)


def bill_words(lines, header=True):
    """lines: list of rows, each a list of (text, x) at that row."""
    words = []
    for r, row in enumerate(lines):
        y = 100 + r * 50
        for text, x in row:
            words.append(W(text, x, y + (3 if x > 600 else 0)))  # slight skew across the row
    return words


SHOP_BILL = [
    [("GUPTA", 60), ("DISTRIBUTORS", 180)],
    [("GSTIN:", 60), ("27AAPFUO939F1ZV", 170)],
    [("Invoice", 60), ("No", 180), ("118", 230), ("Date:", 700), ("15/10/2026", 790)],
    [("Item", 60), ("HSN", 420), ("Qty", 560), ("Rate", 680), ("GST%", 800), ("Amount", 920)],
    [("1", 20), ("Parle-G", 60), ("80g", 190), ("19053100", 400), ("48", 560), ("8.50", 680), ("18%", 800), ("408.00", 920)],
    [("2", 20), ("Maggi", 60), ("Masala", 160), ("70g", 280), ("19023010", 400), ("24", 560), ("12.00", 680), ("12%", 800), ("288.00", 920)],
    [("3", 20), ("Tata", 60), ("Salt", 140), ("1kg", 220), ("25010020", 400), ("10", 560), ("2200", 680), ("5%", 800), ("220.00", 920)],
    [("Sub", 600), ("Total", 660), ("916.00", 920)],
    [("CGST", 600), ("SGST", 700), ("..", 800), ("119.00", 920)],
    [("Grand", 600), ("Total", 690), ("1035.00", 920)],
]


def parse(rows, cfg):
    lines = group_lines(bill_words(rows), cfg["ocr"]["line_merge_ratio"])
    return parse_bill(lines, 1100, cfg, TODAY)


def test_full_bill_with_header(cfg):
    out = parse(SHOP_BILL, cfg)
    b = out["bill"]
    assert b["supplier_name"] == "GUPTA DISTRIBUTORS"
    assert b["gstin"] == VALID_GSTIN
    assert b["invoice_date"] == "2026-10-15"
    assert b["invoice_total"] == 1035.0
    assert [(i["qty"], i["unit_price"], i["gst_rate"], i["line_total"]) for i in b["items"]] == [
        (48, 8.5, 18, 408.0), (24, 12.0, 12, 288.0), (10, 22.0, 5, 220.0)]  # "2200" -> 22.00 by arithmetic
    assert b["items"][0]["name"] == "Parle-G 80g"
    assert any("decimal point restored" in w for w in b["warnings"])
    v = validate_bill_scan(b)
    assert v["valid"] and v["accepted"], v


def test_bill_without_header_uses_arithmetic(cfg):
    rows = [
        [("SHREE", 60), ("DAIRY", 170)],
        [("Paneer", 60), ("5", 500), ("kg", 530), ("380.00", 650), ("1900.00", 900)],
        [("Fresh", 60), ("Cream", 150), ("380.00", 500), ("2", 650), ("760.00", 900)],  # rate before qty
        [("Total", 600), ("2660.00", 900)],
    ]
    b = parse(rows, cfg)["bill"]
    assert [(i["name"], i["qty"], i["unit"], i["unit_price"], i["line_total"]) for i in b["items"]] == [
        ("Paneer", 5, "kg", 380.0, 1900.0), ("Fresh Cream", 2, None, 380.0, 760.0)]
    assert b["invoice_total"] == 2660.0
    assert [f["field"] for f in validate_bill_scan(b)["flags"]] == ["invoice_date"]  # no date printed


def test_mismatched_line_is_kept_and_flagged(cfg):
    rows = [
        [("Metro", 60), ("Cash", 170), ("Carry", 260)],
        [("Item", 60), ("Qty", 560), ("Rate", 680), ("Amount", 920)],
        [("Toor", 60), ("Dal", 150), ("10", 560), ("140.00", 680), ("1700.00", 920)],
        [("Total", 600), ("1700.00", 920)],
    ]
    b = parse(rows, cfg)["bill"]
    assert b["items"][0]["line_total"] == 1700.0 and b["items"][0]["qty"] == 10
    assert any("does not match" in w for w in b["warnings"])
    v = validate_bill_scan(b)
    assert v["valid"] and not v["accepted"]
    assert sorted(f["field"] for f in v["flags"]) == ["invoice_date", "items[0].line_total"]  # no date printed


def test_gst_inclusive_line_totals_and_bill_level_rate(cfg):
    rows = [
        [("Annapurna", 60), ("Traders", 220)],
        [("Item", 60), ("Qty", 560), ("Rate", 680), ("Amount", 920)],
        [("Ghee", 60), ("1L", 140), ("6", 560), ("600.00", 680), ("4032.00", 920)],
        [("CGST", 500), ("6%", 600), ("216.00", 920)],
        [("SGST", 500), ("6%", 600), ("216.00", 920)],
        [("Net", 600), ("Amount", 680), ("4032.00", 920)],
    ]
    b = parse(rows, cfg)["bill"]
    assert b["items"][0]["gst_rate"] == 12
    assert b["invoice_total"] == 4032.0


def test_low_confidence_numbers_warned(cfg):
    rows = [[("Shop", 60), ("Name", 160)],
            [("Bread", 60), ("6", 560), ("40.00", 680), ("240.00", 920)],
            [("Total", 600), ("240.00", 920)]]
    words = bill_words(rows)
    for w in words:
        if w.text == "40.00":
            w.conf = 0.3
    b = parse_bill(group_lines(words, cfg["ocr"]["line_merge_ratio"]), 1100, cfg, TODAY)["bill"]
    assert any("hard to read" in w for w in b["warnings"])


def test_merge_passes_keeps_more_confident_read():
    a = [Word("4O8.00", 0.4, 0, 0, 100, 30), Word("Maggi", 0.9, 200, 0, 300, 30)]
    b = [Word("408.00", 0.92, 2, 1, 101, 31)]
    merged = merge_passes(a, b)
    assert [w.text for w in merged] == ["408.00", "Maggi"]


def test_group_lines_tolerates_skew():
    words = [W("A", 0, 100), W("B", 300, 108), W("C", 600, 114), W("D", 0, 160)]
    lines = group_lines(words, 0.55)
    assert [ln.text for ln in lines] == ["A B C", "D"]


@pytest.mark.parametrize("line,expected", [
    ("GSTIN: 27AAPFUO939FIZV", [(VALID_GSTIN, True)]),   # O for 0 and I for 1
    ("GSTIN: 2TAAPFU0939FlZV", [(VALID_GSTIN, True)]),
    ("GSTIN 27AAPFU0939F1Z7", [("27AAPFU0939F1Z7", False)]),  # wrong check digit stays flagged
    ("Invoice No: 118 Date: 15/10/2026 BDATE", []),            # unlabelled junk never matches
])
def test_find_gstins(line, expected):
    assert find_gstins([line]) == expected


def test_unlabelled_text_needs_exact_gstin():
    # Coercible junk with a lucky checksum must not be accepted without a label.
    assert find_gstins(["Item HSN Qty Rate GST% Amount", "O1LILIS1211IQZ1 9 4"]) == []
    assert find_gstins([f"Bill from {VALID_GSTIN}"]) == [(VALID_GSTIN, True)]


def test_merge_drops_fragments_inside_kept_box():
    a = [Word("1949.00", 0.9, 100, 0, 220, 30)]
    b = [Word("1949.00", 0.6, 300, 0, 420, 30), Word("00", 0.7, 180, 2, 219, 29)]
    assert [w.text for w in merge_passes(a, b)] == ["1949.00", "1949.00"]
