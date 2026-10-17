"""Bill-scan validator (FR-E2). Mirrors shared/ai/validators/bill_scan.ts.

valid=False                 -> fall back to manual entry; nothing is written.
valid=True, accepted=False  -> numbers disagree; the owner must fix or confirm the flagged fields.
valid=True, accepted=True   -> the owner still confirms before saving.
"""

from __future__ import annotations

import datetime as dt

from validators.common import _MISSING, close, parse_model_json, schema_errors


def validate_bill_scan(raw) -> dict:
    x = parse_model_json(raw)
    if x is _MISSING:
        return {"valid": False, "fallback": "manual_entry", "errors": ["output is not valid JSON"]}
    errors = schema_errors("bill_scan", x)
    if not errors and x.get("invoice_date") is not None:
        try:
            dt.date.fromisoformat(x["invoice_date"])
        except ValueError:
            errors.append("invoice_date: not a real date")
    if errors:
        return {"valid": False, "fallback": "manual_entry", "errors": errors}

    flags, exclusive, inclusive, printed = [], 0.0, 0.0, 0.0
    for i, it in enumerate(x["items"]):
        base = it["qty"] * it["unit_price"]
        with_gst = base * (1 + (it["gst_rate"] or 0) / 100)
        exclusive += base
        inclusive += with_gst
        printed += it["line_total"]
        if not close(it["line_total"], base, 1, 0.01) and not close(it["line_total"], with_gst, 1, 0.01):
            flags.append({"field": f"items[{i}].line_total",
                          "message": f"line total {it['line_total']} does not match qty {it['qty']} x price "
                                     f"{it['unit_price']} (= {round(base, 2)})"})
    total = x["invoice_total"]
    if total is not None:
        if not any(close(total, c, 2, 0.005) for c in (printed, exclusive, inclusive)):
            flags.append({"field": "invoice_total",
                          "message": f"invoice total {total} does not match the line items "
                                     f"(sum {round(printed, 2)}, with GST {round(inclusive, 2)})"})
    else:
        flags.append({"field": "invoice_total", "message": "invoice total not read; check against the bill"})
    if x["invoice_date"] is None:
        flags.append({"field": "invoice_date", "message": "date not read"})
    return {"valid": True, "accepted": not flags, "bill": x, "flags": flags, "computed_total": round(printed, 2)}
