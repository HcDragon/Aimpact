"""Integration with the Supabase side: forecasting/model.py contract and the OCR -> scan-bill mapping."""

import importlib.util
from datetime import date, timedelta

import pandas as pd

from settings import REPO_DIR

TODAY = date(2026, 10, 17)


def load_model():
    spec = importlib.util.spec_from_file_location("forecast_model", REPO_DIR / "forecasting" / "model.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_model_contract_without_fitting_prophet(monkeypatch, cfg):
    m = load_model()
    orig = m.assign_tiers
    # Keep this test fast: route every Prophet tier to the moving average (no model fit).
    monkeypatch.setattr(m, "assign_tiers", lambda *a, **k: {
        i: ("moving_avg" if v in ("prophet", "category") else v) for i, v in orig(*a, **k).items()})
    monkeypatch.setattr(m, "baseline_overrides", lambda _bid: {})
    series = {
        "established": {TODAY - timedelta(days=i): 5.0 + i % 7 for i in range(1, 120)},
        "cold-start": {TODAY - timedelta(days=i): 2.0 for i in range(1, 10)},
        "sold-today-only": {TODAY: 4.0},
    }
    rows = list(m.forecast_business({"id": "b1", "name": "x", "business_type": "shop"},
                                    [{"id": k, "category": None} for k in series], series, TODAY, 14))
    assert {r["product_id"] for r in rows} == {"established"}  # cold start left to SQL rule fallback
    assert [r["forecast_date"] for r in rows] == [TODAY + timedelta(days=d) for d in range(1, 15)]
    assert {r["method"] for r in rows} <= {"prophet", "category", "moving_average", "seasonal_naive", "rule"}
    assert all(r["yhat"] >= 0 and r["yhat_lower"] <= r["yhat"] <= r["yhat_upper"] for r in rows)


def test_daily_frame_excludes_today_and_fills_gaps():
    m = load_model()
    daily, first = m.daily_frame({"a": {TODAY - timedelta(days=3): 2.0, TODAY - timedelta(days=1): 1.0, TODAY: 9.0}}, TODAY)
    assert list(daily["a"]) == [2.0, 0.0, 1.0]
    assert first["a"] == pd.Timestamp(TODAY - timedelta(days=3))


def test_bundles_shape(cfg):
    m = load_model()

    class FakeDB:
        def select(self, table, params):
            assert table == "sale_items" and params["business_id"] == "eq.b1"
            day = (TODAY - timedelta(days=1)).isoformat() + "T10:00:00+05:30"
            rows = []
            for i in range(60):
                basket = ["bread", "butter"] if i < 25 else (["bread"] if i < 40 else ["salt"])
                rows += [{"sale_id": f"s{i}", "product_id": p, "sales": {"sold_at": day}} for p in basket]
            return rows

    out = m.bundles_for_business({"id": "b1"}, FakeDB(), TODAY)
    assert out and set(out[0]) == {"antecedent_ids", "consequent_ids", "support", "confidence", "lift"}
    assert {out[0]["antecedent_ids"][0], out[0]["consequent_ids"][0]} == {"bread", "butter"}
    assert all(r["lift"] >= 1.2 for r in out)


def test_ocr_result_maps_to_scan_bill_shape():
    from ocr.server import to_edge_bill

    result = {
        "bill": {"supplier_name": "Gupta", "invoice_date": "2026-10-15", "gstin": "27AAPFU0939F1ZV",
                 "items": [{"name": "Parle-G 80g", "qty": 48.0, "unit": "packet", "unit_price": 8.5,
                            "gst_rate": 18.0, "line_total": 408.0}],
                 "invoice_total": 481.44, "warnings": []},
        "extra": {"invoice_no": "118", "items": [{"hsn": "19053100", "mrp": 10.0}]},
    }
    bill = to_edge_bill(result)
    assert bill["supplier_gstin"] == "27AAPFU0939F1ZV" and bill["invoice_no"] == "118"
    assert bill["printed_total"] == 481.44 and bill["unreadable"] is False
    assert bill["items"][0] == {"name": "Parle-G 80g", "qty": 48.0, "unit": "packet", "unit_price": 8.5,
                                "line_amount": 408.0, "gst_rate": 18.0, "mrp": 10.0, "hsn": "19053100",
                                "batch_no": None, "expiry_date": None}
