"""Turning noisy OCR tokens into numbers, dates and GSTINs.

OCR confuses O/0, l/1, S/5, B/8 and drops or swaps decimal separators. These
fixes apply only where the token is clearly meant to be a number or a code, so
product names like "OIL" or "SOAP" are never rewritten.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

TO_DIGIT = str.maketrans({"O": "0", "o": "0", "Q": "0", "D": "0", "I": "1", "l": "1", "L": "1", "|": "1", "i": "1",
                          "!": "1", "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "G": "6", "T": "7"})
TO_LETTER = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G", "7": "T", "4": "A"})
_CONFUSABLE = set("OoQDIl|i!SsBZzGT")
_CURRENCY = re.compile(r"^(₹|rs\.?|inr|r5\.?)\s*", re.IGNORECASE)


@dataclass(frozen=True)
class Num:
    value: float
    raw: str
    had_decimal: bool
    is_percent: bool = False


def looks_numeric(token: str) -> bool:
    core = _CURRENCY.sub("", token.strip()).rstrip("%").removesuffix("/-")
    if not core or not any(c.isdigit() for c in core):
        return False
    ok = sum(c.isdigit() or c in ".,-" or c in _CONFUSABLE for c in core)
    return ok / len(core) >= 0.75 and sum(c.isdigit() for c in core) >= max(1, len(core) // 3)


def parse_number(token: str) -> Num | None:
    raw = token
    t = _CURRENCY.sub("", token.strip()).removesuffix("/-").strip()
    pct = t.endswith("%")
    t = t.rstrip("%").strip()
    if not looks_numeric(t):
        return None
    t = t.translate(TO_DIGIT)
    t = re.sub(r"[^\d.,\-]", "", t).strip("-")
    if not t:
        return None
    if "," in t and "." in t:
        t = t.replace(",", "")
    elif "," in t:
        # "408,00" is a decimal comma; "1,200" and "1,20,000" are digit grouping.
        t = t.replace(",", ".") if re.fullmatch(r"\d+,\d{2}", t) else t.replace(",", "")
    if t.count(".") > 1:
        head, _, tail = t.rpartition(".")
        t = head.replace(".", "") + "." + tail
    try:
        return Num(float(t), raw, "." in t, pct)
    except ValueError:
        return None


# --- dates -----------------------------------------------------------------
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun",
                                           "jul", "aug", "sep", "oct", "nov", "dec"])}
_NUMERIC_DATE = re.compile(r"(?<!\d)(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4}|\d{2})(?!\d)")
_ISO_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)")
_TEXT_DATE = re.compile(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([a-z]{3})[a-z]*[\s\-/.,']*(\d{4}|\d{2})(?!\d)", re.I)


def _mk(y: int, m: int, d: int, today: dt.date) -> dt.date | None:
    y = 2000 + y if y < 100 else y
    try:
        out = dt.date(y, m, d)
    except ValueError:
        return None
    return out if dt.date(2000, 1, 1) <= out <= today + dt.timedelta(days=31) else None


def _digit_fix(text: str) -> str:
    """Fix confusables only inside digit/separator runs, e.g. '1O/O5/2O26'."""
    return re.sub(r"[\dOoIlSB/.\-]{6,}", lambda m: m.group(0).translate(TO_DIGIT) if
                  sum(c.isdigit() for c in m.group(0)) >= 3 else m.group(0), text)


def parse_date(text: str, today: dt.date | None = None) -> dt.date | None:
    today = today or dt.date.today()
    fixed = _digit_fix(text)
    if m := _ISO_DATE.search(fixed):
        if d := _mk(int(m[1]), int(m[2]), int(m[3]), today):
            return d
    if m := _NUMERIC_DATE.search(fixed):
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        # Indian bills are DD/MM; fall back to MM/DD only when DD/MM is impossible.
        return _mk(y, b, a, today) or _mk(y, a, b, today)
    if m := _TEXT_DATE.search(text):
        mon = _MONTHS.get(m[2].lower()[:3])
        if mon:
            return _mk(int(m[3]), mon, int(m[1]), today)
    return None


# --- GSTIN -----------------------------------------------------------------
_GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
GSTIN_FORMAT = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")
# Expected character class per position: d = digit, a = letter, x = either.
_GSTIN_SHAPE = "ddaaaaaddddaxax"


def gstin_checksum(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        p = _GST_CHARS.index(ch) * (1 if i % 2 == 0 else 2)
        total += p // 36 + p % 36
    return _GST_CHARS[(36 - total % 36) % 36]


def gstin_valid(g: str) -> bool:
    return bool(GSTIN_FORMAT.match(g)) and gstin_checksum(g[:14]) == g[14]


def repair_gstin(candidate: str, max_changes: int = 3) -> tuple[str, bool] | None:
    """Coerce each position to its expected class; returns (gstin, checksum_ok) or None.

    At most `max_changes` characters may be coerced; more means it is not a GSTIN.
    """
    c = re.sub(r"[^A-Za-z0-9]", "", candidate).upper()
    if len(c) != 15:
        return None
    out = []
    for ch, shape in zip(c, _GSTIN_SHAPE):
        if shape == "d":
            ch = ch.translate(TO_DIGIT)
        elif shape == "a":
            ch = ch.translate(TO_LETTER)
        out.append(ch)
    out[13] = "Z"  # always Z by definition
    g = "".join(out)
    if not GSTIN_FORMAT.match(g) or sum(a != b for a, b in zip(c, g)) > max_changes:
        return None
    if g[:2] not in _STATE_CODES:
        return None
    if gstin_valid(g):
        return g, True
    # One misread character: try confusable swaps at the free positions (12, 14) and,
    # for the check digit, the computed value. Accept only a unique checksum-valid fix.
    fixes = set()
    for pos in (12, 14):
        for alt in _CONFUSABLE_PAIRS.get(g[pos], ""):
            cand = g[:pos] + alt + g[pos + 1:]
            if gstin_valid(cand):
                fixes.add(cand)
    computed = g[:14] + gstin_checksum(g[:14])
    if computed[14] in _CONFUSABLE_PAIRS.get(g[14], ""):
        fixes.add(computed)
    return (fixes.pop(), True) if len(fixes) == 1 else (g, False)


_STATE_CODES = {f"{i:02d}" for i in range(1, 39)} | {"97", "99"}
_CONFUSABLE_PAIRS: dict[str, str] = {}
for _a, _b in ("0O", "0D", "0Q", "1I", "1L", "5S", "8B", "2Z", "6G", "7T", "4A"):
    _CONFUSABLE_PAIRS[_a] = _CONFUSABLE_PAIRS.get(_a, "") + _b
    _CONFUSABLE_PAIRS[_b] = _CONFUSABLE_PAIRS.get(_b, "") + _a


_GST_LABEL = re.compile(r"GSTIN|GST\s*(IN|NO|N0|1N|#)\b|GST\s*REG", re.I)


def find_gstins(lines: list[str]) -> list[tuple[str, bool]]:
    """GSTINs, checksum-valid first, then page order.

    A labelled line ("GSTIN:", "GST No") may need up to 3 OCR fixes. Unlabelled
    text must already be a well-formed, checksum-valid GSTIN, so ordinary lines
    (item codes, dates) cannot produce a false one by chance.
    """
    found: list[tuple[str, bool, int]] = []
    seen = set()
    for idx, line in enumerate(lines):
        labelled = bool(_GST_LABEL.search(line))
        s = re.sub(r"[^A-Za-z0-9]", "", line).upper()
        s = re.sub(r"GST(IN|NO|N0)?", " ", s).replace(" ", "")
        for i in range(0, max(0, len(s) - 14)):
            r = repair_gstin(s[i:i + 15], max_changes=3 if labelled else 0)
            if r and r[0] not in seen and (r[1] or labelled):
                seen.add(r[0])
                found.append((r[0], r[1], idx))
    return [(g, ok) for g, ok, _ in sorted(found, key=lambda x: (not x[1], x[2]))]
