"""Pure scoring functions for the Gemini evaluations (no API calls here)."""

from __future__ import annotations

from collections import defaultdict

from embeddings.match import fuzzy_score


def _num_eq(a, b, tol=0.01) -> bool:
    if a is None or b is None:
        return a is b
    return abs(float(a) - float(b)) <= max(tol, tol * abs(float(b)))


def score_bill(pred: dict | None, label: dict) -> dict:
    """Field-level accuracy for one bill. Items are aligned by best name match."""
    counts = defaultdict(lambda: [0, 0])  # field -> [correct, total]
    pred_items = list((pred or {}).get("items", []))
    for li in label["items"]:
        best = max(pred_items, key=lambda p: fuzzy_score(p["name"], li["name"]), default=None)
        matched = best is not None and fuzzy_score(best["name"], li["name"]) >= 0.8
        if matched:
            pred_items.remove(best)
        for field in ("item", "qty", "price", "gst"):
            counts[field][1] += 1
        if matched:
            counts["item"][0] += 1
            counts["qty"][0] += _num_eq(best["qty"], li["qty"])
            counts["price"][0] += _num_eq(best["unit_price"], li["unit_price"])
            counts["gst"][0] += _num_eq(best["gst_rate"], li["gst_rate"])
    counts["invoice_total"] = [int(_num_eq((pred or {}).get("invoice_total"), label["invoice_total"])), 1]
    extra = len(pred_items)  # predicted lines that are not on the bill
    perfect = all(c == t for c, t in counts.values()) and extra == 0
    return {"fields": dict(counts), "extra_items": extra, "no_correction_needed": perfect}


def aggregate_bills(results: list[dict]) -> dict:
    tot = defaultdict(lambda: [0, 0])
    for r in results:
        for f, (c, t) in r["fields"].items():
            tot[f][0] += c
            tot[f][1] += t
    return {
        "n_bills": len(results),
        "field_accuracy": {f: round(c / t * 100, 1) for f, (c, t) in tot.items() if t},
        "saved_without_correction_pct": round(sum(r["no_correction_needed"] for r in results) / len(results) * 100, 1)
        if results else None,
    }


def score_voice(preds: list[dict | None], labels: list[dict]) -> dict:
    """Intent, item and qty accuracy, per language and overall."""
    by_lang = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for p, l in zip(preds, labels):
        for key in (l["language"], "all"):
            s = by_lang[key]
            s["intent"][1] += 1
            s["intent"][0] += bool(p) and p["intent"] == l["intent"]
            if l.get("item") is not None:
                s["item"][1] += 1
                s["item"][0] += bool(p) and p.get("item") is not None and fuzzy_score(p["item"], l["item"]) >= 0.8
            if l.get("qty") is not None:
                s["qty"][1] += 1
                s["qty"][0] += bool(p) and _num_eq(p.get("qty"), l["qty"])
            s["unknown_instead_of_wrong"][1] += bool(p) and p["intent"] != l["intent"]
            s["unknown_instead_of_wrong"][0] += bool(p) and p["intent"] == "unknown" and l["intent"] != "unknown"
    return {lang: {k: {"accuracy": round(c / t * 100, 1) if t else None, "n": t} for k, (c, t) in s.items()}
            for lang, s in by_lang.items()}


def score_matching(ranked: list[list[str]], truth: list[str]) -> dict:
    n = len(truth)
    top1 = sum(r[:1] == [t] for r, t in zip(ranked, truth))
    top5 = sum(t in r[:5] for r, t in zip(ranked, truth))
    return {"n": n, "top1_pct": round(top1 / n * 100, 1) if n else None, "top5_pct": round(top5 / n * 100, 1) if n else None}


def score_reviews(preds: dict[str, str], labels: dict[str, str]) -> dict:
    ids = [i for i in labels if i in preds]
    agree = sum(preds[i] == labels[i] for i in ids)
    return {"n": len(labels), "answered": len(ids), "agreement_pct": round(agree / len(labels) * 100, 1) if labels else None}
