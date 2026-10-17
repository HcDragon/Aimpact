"""Reading order: group OCR boxes into lines, split boxes into tokens, find table columns."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from ocr.engine import Word


@dataclass
class Token:
    text: str
    conf: float
    x0: float
    x1: float

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2


@dataclass
class Line:
    index: int
    y: float
    height: float
    tokens: list[Token] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(t.text for t in self.tokens)

    @property
    def min_conf(self) -> float:
        return min((t.conf for t in self.tokens), default=0.0)


def split_word(w: Word) -> list[Token]:
    """EasyOCR boxes may hold several words; split on spaces, spreading x by character count."""
    parts = w.text.split()
    if len(parts) <= 1:
        return [Token(w.text, w.conf, w.x0, w.x1)]
    total = sum(len(p) for p in parts) + len(parts) - 1
    width = (w.x1 - w.x0) / max(1, total)
    out, pos = [], 0
    for p in parts:
        out.append(Token(p, w.conf, w.x0 + pos * width, w.x0 + (pos + len(p)) * width))
        pos += len(p) + 1
    return out


def group_lines(words: list[Word], merge_ratio: float) -> list[Line]:
    """A word joins a line when its vertical centre is within merge_ratio x median height."""
    if not words:
        return []
    med_h = float(np.median([w.h for w in words])) or 1.0
    lines: list[dict] = []
    for w in sorted(words, key=lambda w: w.cy):
        best = None
        for ln in lines[-4:]:  # only recent lines can be on the same row
            if abs(ln["y"] - w.cy) < merge_ratio * med_h and (best is None or abs(ln["y"] - w.cy) < abs(best["y"] - w.cy)):
                best = ln
        if best is None:
            lines.append({"y": w.cy, "words": [w]})
        else:
            best["words"].append(w)
            best["y"] = float(np.mean([x.cy for x in best["words"]]))
    out = []
    for i, ln in enumerate(sorted(lines, key=lambda l: l["y"])):
        ws = sorted(ln["words"], key=lambda w: w.x0)
        toks = [t for w in ws for t in split_word(w)]
        out.append(Line(i, ln["y"], float(np.median([w.h for w in ws])), toks))
    return out


# Header words -> column role.
HEADER_ROLES = {
    "qty": "qty", "qnty": "qty", "quantity": "qty", "qty.": "qty", "nos": "qty", "pcs": "qty",
    "rate": "rate", "price": "rate", "rate/unit": "rate", "unit price": "rate", "u.price": "rate",
    "amount": "amount", "amt": "amount", "amt.": "amount", "value": "amount", "total": "amount", "net": "amount",
    "gst": "gst", "gst%": "gst", "tax%": "gst", "gst rate": "gst", "tax": "gst",
    "mrp": "mrp", "hsn": "hsn", "hsn/sac": "hsn", "hsn code": "hsn", "sac": "hsn",
    "item": "name", "items": "name", "description": "name", "particulars": "name", "product": "name",
    "unit": "unit", "uom": "unit", "disc": "discount", "disc%": "discount", "discount": "discount",
    "s.no": "serial", "sno": "serial", "sr": "serial", "sr.no": "serial", "#": "serial",
}


def _norm(t: str) -> str:
    return re.sub(r"[^a-z%#./]", "", t.lower())


def detect_header(lines: list[Line]) -> tuple[int, dict[str, float]] | None:
    """The first line naming at least two numeric columns; returns (line index, role -> x centre)."""
    for ln in lines:
        roles: dict[str, float] = {}
        toks = ln.tokens
        for i, t in enumerate(toks):
            two = _norm(t.text) + (" " + _norm(toks[i + 1].text) if i + 1 < len(toks) else "")
            role = HEADER_ROLES.get(two) or HEADER_ROLES.get(_norm(t.text))
            if role and role not in roles:
                roles[role] = t.cx
        if len({"qty", "rate", "amount"} & set(roles)) >= 2:
            return ln.index, roles
    return None


def nearest_role(x: float, roles: dict[str, float], max_dist: float) -> str | None:
    best = min(roles.items(), key=lambda kv: abs(kv[1] - x), default=None)
    return best[0] if best and abs(best[1] - x) <= max_dist else None
