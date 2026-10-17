"""Helpers shared by the Python validators (mirror of shared/ai/validators/common.ts)."""

from __future__ import annotations

import json
import re
from functools import lru_cache

from jsonschema import Draft202012Validator

from settings import SHARED_AI_DIR

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_MISSING = object()


def parse_model_json(raw):
    """Parse model text as JSON, tolerating a ```json fence. Returns _MISSING on failure."""
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(_FENCE.sub("", raw.strip()))
    except json.JSONDecodeError:
        return _MISSING


@lru_cache(maxsize=None)
def schema_validator(name: str) -> Draft202012Validator:
    with open(SHARED_AI_DIR / "schemas" / f"{name}.json") as f:
        return Draft202012Validator(json.load(f))


def schema_errors(name: str, obj) -> list[str]:
    def path(e):
        return ".".join(str(p) for p in e.absolute_path) or "(root)"
    return [f"{path(e)}: {e.message}" for e in schema_validator(name).iter_errors(obj)]


def close(a: float, b: float, abs_tol: float, rel: float) -> bool:
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))
