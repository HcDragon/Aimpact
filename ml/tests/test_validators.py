"""Bill and voice validators agree with the shared contract fixtures (same cases as the TS tests)."""

import json

import pytest

from settings import SHARED_AI_DIR
from validators.bill_scan import validate_bill_scan
from validators.voice_intent import validate_voice_intent


def cases(name):
    return json.loads((SHARED_AI_DIR / "fixtures" / name).read_text())["cases"]


@pytest.mark.parametrize("case", cases("bill_cases.json"), ids=lambda c: c["name"])
def test_bill_cases(case):
    r = validate_bill_scan(case["input"])
    assert r["valid"] == case["expect"]["valid"], r
    if r["valid"]:
        assert r["accepted"] == case["expect"]["accepted"], r["flags"]
        assert sorted(f["field"] for f in r["flags"]) == sorted(case["expect"]["flag_fields"])
    else:
        assert r["fallback"] == "manual_entry"


@pytest.mark.parametrize("case", cases("voice_cases.json"), ids=lambda c: c["name"])
def test_voice_cases(case):
    r = validate_voice_intent(case["input"])
    assert r["valid"] == case["expect"]["valid"], r
    if r["valid"]:
        assert r["can_write"] == case["expect"]["can_write"]
        assert r["intent"]["needs_clarification"] == case["expect"]["needs_clarification"]


def test_bill_with_line_totals_not_adding_up_is_rejected():
    bill = {"supplier_name": "X", "invoice_date": "2026-10-10", "gstin": None,
            "items": [{"name": "A", "qty": 2, "unit": "pcs", "unit_price": 10, "gst_rate": 0, "line_total": 20},
                      {"name": "B", "qty": 1, "unit": "pcs", "unit_price": 30, "gst_rate": 0, "line_total": 30}],
            "invoice_total": 90, "warnings": []}
    r = validate_bill_scan(bill)
    assert r["valid"] and not r["accepted"]
    assert [f["field"] for f in r["flags"]] == ["invoice_total"]


def test_malformed_gemini_json_falls_back_without_writing(tmp_path):
    from db import LocalStore
    store = LocalStore(tmp_path)
    r = validate_bill_scan('{"items": [{"name": "Maggi", "qty": ')
    assert r == {"valid": False, "fallback": "manual_entry", "errors": ["output is not valid JSON"]}
    # The caller only writes on a valid result; nothing exists in the store.
    assert list(tmp_path.iterdir()) == []
    assert store.read("forecasts", "b1").empty
