"""Plain-language insights (FR-F2): Gemini writes tips from numbers computed locally.

The guard rejects any response containing a number absent from the input JSON,
so Gemini can never introduce a figure the owner sees.

    python -m insights.generate --business <id>
"""

from __future__ import annotations

import argparse
import json
import re

from settings import REPORTS_DIR
from validators.common import _MISSING, parse_model_json, schema_errors

_NUM = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)*(?:\.\d+)?")


def _normalise(token: str) -> str:
    token = token.replace(",", "")  # Indian grouping: 1,20,000
    return str(float(token)).rstrip("0").rstrip(".") if "." in token or token.isdigit() else token


def numbers_in(value) -> set[str]:
    """All numbers in a JSON value, normalised (12 == 12.0, 1,200 == 1200)."""
    found: set[str] = set()
    if isinstance(value, bool) or value is None:
        return found
    if isinstance(value, (int, float)):
        found.add(_normalise(repr(float(value))))
    elif isinstance(value, str):
        found |= {_normalise(m) for m in _NUM.findall(value)}
    elif isinstance(value, dict):
        for k, v in value.items():
            found |= numbers_in(k) | numbers_in(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            found |= numbers_in(v)
    return found


def new_numbers(text: str, facts: dict) -> set[str]:
    """Numbers in `text` that do not appear anywhere in `facts`."""
    return numbers_in(text) - numbers_in(facts)


def check_insights(raw, facts: dict) -> dict:
    x = parse_model_json(raw)
    if x is _MISSING:
        return {"valid": False, "errors": ["output is not valid JSON"]}
    errors = schema_errors("insights", x)
    if errors:
        return {"valid": False, "errors": errors}
    invented = set()
    for tip in x["tips"]:
        invented |= new_numbers(tip["title"] + " " + tip["text"], facts)
    if invented:
        return {"valid": False, "errors": [f"introduced numbers not in input: {sorted(invented)}"]}
    return {"valid": True, "tips": x["tips"]}


def build_facts(business_id: str) -> dict:
    """Collect the locally computed numbers from the latest nightly reports."""
    facts: dict = {"language": "en"}
    d = REPORTS_DIR / business_id
    for name in ("dead_stock", "bundles", "prep_list", "perishables"):
        p = d / f"{name}.json"
        if p.exists():
            facts[name] = json.loads(p.read_text())["items"][:5]
    return facts


def main() -> None:
    from gemini_client import Gemini, GeminiUnavailable

    p = argparse.ArgumentParser()
    p.add_argument("--business", required=True)
    a = p.parse_args()
    facts = build_facts(a.business)
    try:
        raw = Gemini().generate_json("insights", text=json.dumps(facts))
    except GeminiUnavailable as e:
        print(f"skipped insights: {e}")
        return
    result = check_insights(raw, facts)
    out = REPORTS_DIR / a.business / "insights.json"
    if result["valid"]:
        out.write_text(json.dumps({"tips": result["tips"]}, indent=2, ensure_ascii=False))
        print(f"wrote {out}")
    else:
        print(f"rejected Gemini insights: {result['errors']}")


if __name__ == "__main__":
    main()
