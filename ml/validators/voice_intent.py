"""Voice-intent validator (FR-E3). Mirrors shared/ai/validators/voice_intent.ts."""

from __future__ import annotations

from validators.common import _MISSING, parse_model_json, schema_errors

NEEDS_ITEM_AND_QTY = {"add_stock", "record_sale"}


def validate_voice_intent(raw) -> dict:
    x = parse_model_json(raw)
    if x is _MISSING:
        return {"valid": False, "fallback": "manual_entry", "errors": ["output is not valid JSON"]}
    errors = schema_errors("voice_intent", x)
    if errors:
        return {"valid": False, "fallback": "manual_entry", "errors": errors}
    intent = dict(x)
    if isinstance(intent["item"], str) and not intent["item"].strip():
        intent["item"] = None
    if intent["intent"] in NEEDS_ITEM_AND_QTY and (intent["item"] is None or intent["qty"] is None):
        intent["needs_clarification"] = True
    can_write = intent["intent"] in NEEDS_ITEM_AND_QTY and not intent["needs_clarification"]
    return {"valid": True, "intent": intent, "can_write": can_write}
