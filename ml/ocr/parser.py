"""Bill parser: OCR lines -> the bill_scan.json shape.

Accuracy comes mostly from structure, not from the OCR engine:
  * table header columns (Qty / Rate / Amount / GST / HSN / MRP) assign numbers by x position;
  * arithmetic decoding picks the (qty, rate, amount) triple that satisfies
    qty x rate = amount (with or without GST), which also recovers dropped
    decimal points and ignores HSN / MRP / pack-size numbers;
  * totals, dates and GSTINs use keyword anchors and format/checksum repair.
Every number in the output is one that was printed on the bill; anything
uncertain becomes a warning for the owner, who confirms before saving.
"""

from __future__ import annotations

import datetime as dt
import itertools
import re
from dataclasses import dataclass, field

from ocr.layout import Line, Token, detect_header, nearest_role
from ocr.text_fix import Num, find_gstins, parse_date, parse_number

ALLOWED_GST = [0, 0.25, 3, 5, 12, 18, 28, 40]

UNITS = {
    "pcs": "pcs", "pc": "pcs", "nos": "pcs", "no": "pcs", "unit": "pcs", "units": "pcs", "ea": "pcs",
    "kg": "kg", "kgs": "kg", "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g",
    "l": "l", "ltr": "l", "ltrs": "l", "lt": "l", "litre": "l", "liter": "l", "ml": "ml",
    "box": "box", "boxes": "box", "pkt": "packet", "pkts": "packet", "packet": "packet", "packets": "packet",
    "pack": "packet", "doz": "dozen", "dozen": "dozen", "bag": "bag", "bags": "bag", "btl": "bottle",
    "bottle": "bottle", "bottles": "bottle", "case": "case", "cs": "case", "ctn": "carton", "carton": "carton",
    "strip": "strip", "tin": "tin", "jar": "jar", "roll": "roll", "set": "set", "pair": "pair",
}
SIZE_UNITS = {"g", "kg", "ml", "l"}
_ATTACHED = re.compile(r"^(\d+(?:[.,]\d+)?)([a-zA-Z]{1,7})\.?$")
_SERIAL = re.compile(r"^\(?\d{1,3}[.)]?$")
_HSN = re.compile(r"^\d{4}(\d{2}){0,2}$")

SUMMARY = re.compile(
    r"\b(sub\s*-?\s*total|grand\s*total|total|net\s*(amount|amt|payable|value)|amount\s*payable|"
    r"round(ed)?\s*-?\s*off|cgst|sgst|igst|utgst|cess|discount|taxable|amount\s*in\s*words|rupees|"
    r"balance|paid|received|tendered|change|thank|e\.?\s*&\s*o\.?\s*e|gst|vat|tax)\b", re.I)
# Fuzzy-matched only for words unlikely to be product names ("grand"/"brand" would collide).
_SUMMARY_WORDS = ["total", "subtotal", "cgst", "sgst", "igst", "discount", "taxable", "payable"]


def is_summary(text: str) -> bool:
    """Summary rows, tolerating one OCR error per keyword ("Tolal", "CGSI")."""
    if SUMMARY.search(text):
        return True
    from difflib import SequenceMatcher
    for tok in re.findall(r"[A-Za-z]{4,}", text):
        t = tok.lower()
        if any(len(t) == len(k) and SequenceMatcher(None, t, k).ratio() >= 0.8 for k in _SUMMARY_WORDS):
            return True
    return False
META = re.compile(
    r"\b(invoice|inv|bill\s*no|bill\s*#|date|dt|gstin|gst\s*no|phone|ph|mob|mobile|tel|email|e-mail|"
    r"address|state|pin|customer|buyer|m/s|place\s*of\s*supply|cash\s*memo|tax\s*invoice|estimate|"
    r"original|duplicate|receipt|fssai|pan|time|counter|cashier)\b", re.I)
TITLE = re.compile(r"\b(tax\s*invoice|invoice|bill|cash\s*memo|estimate|receipt|quotation|original|duplicate|"
                   r"triplicate|for\s*recipient)\b", re.I)
TOTAL_KEYS = [
    (re.compile(r"grand\s*total|net\s*(payable|amount|amt|value)|amount\s*payable|invoice\s*total|"
                r"total\s*payable|bill\s*amount|total\s*amount", re.I), 5),
    (re.compile(r"\btotal\b", re.I), 2),
]
NOT_TOTAL = re.compile(r"sub\s*-?\s*total|total\s*(qty|quantity|items?|nos|pcs|tax|gst|discount)|taxable", re.I)


@dataclass
class ParsedItem:
    line_index: int
    name: str
    qty: float
    unit: str | None
    unit_price: float
    gst_rate: float | None
    line_total: float
    arithmetic_ok: bool
    min_conf: float
    notes: list[str] = field(default_factory=list)
    hsn: str | None = None
    mrp: float | None = None

    def as_schema(self) -> dict:
        return {"name": self.name, "qty": self.qty, "unit": self.unit, "unit_price": self.unit_price,
                "gst_rate": self.gst_rate, "line_total": self.line_total}


@dataclass
class TailNum:
    num: Num
    token: Token
    unit: str | None = None       # unit attached to the number, e.g. "48pcs"
    attached_size: bool = False   # "80g", "500ml": usually part of the product name


def _close(a: float, b: float, rel: float) -> bool:
    return abs(a - b) <= max(0.51, rel * max(abs(a), abs(b)))


def _split_tail(tokens: list[Token]) -> tuple[list[Token], list[TailNum], list[str]]:
    """Walk from the right collecting numbers, percents and units; the rest is the name."""
    nums: list[TailNum] = []
    units: list[str] = []
    i = len(tokens)
    while i > 0:
        t = tokens[i - 1]
        txt = t.text.strip(":;|")
        low = txt.lower().rstrip(".")
        if low in UNITS:
            units.append(UNITS[low])
        elif low in {"x", "@", "*", "-", "/-"}:
            pass
        elif (m := _ATTACHED.match(txt)) and m[2].lower() in UNITS:
            n = parse_number(m[1])
            if n is None:
                break
            u = UNITS[m[2].lower()]
            nums.append(TailNum(n, t, u, u in SIZE_UNITS))
        elif (n := parse_number(txt)) is not None:
            nums.append(TailNum(n, t))
        else:
            break
        i -= 1
    return tokens[:i], list(reversed(nums)), list(reversed(units))


def _variants(tn: TailNum) -> list[tuple[float, float]]:
    """(value, penalty). A long integer may be a price whose decimal point was lost."""
    v = tn.num.value
    out = [(v, 0.0)]
    if not tn.num.had_decimal and v >= 100 and not tn.num.is_percent:
        out.append((round(v / 100, 2), 1.5))
    return out


_PCT_GHOSTS = set("%96805o3")  # what a misread % sign turns into


def gst_from_column(raw: str) -> float | None:
    """A GST-column cell like '189' or '596' is usually '18%' / '5%' with the % misread."""
    digits = re.sub(r"[^0-9o%]", "", raw.lower())
    for cut in (2, 1):
        head, tail = digits[:cut], digits[cut:]
        if head.isdigit() and 1 <= len(tail) <= 2 and set(tail) <= _PCT_GHOSTS and float(head) in ALLOWED_GST:
            return float(head)
    return None


def _gst_options(nums: list[TailNum], roles_of: list[str | None]) -> list[float | None]:
    opts: list[float | None] = [None]
    for tn, role in zip(nums, roles_of):
        if (tn.num.is_percent or role == "gst") and tn.num.value in ALLOWED_GST:
            opts.append(tn.num.value)
        elif role == "gst" and (g := gst_from_column(tn.num.raw)) is not None:
            opts.append(g)
    return opts


def decode_numbers(nums: list[TailNum], roles_of: list[str | None], tol: float) -> dict | None:
    """Best (qty, rate, amount) assignment that is arithmetically consistent."""
    gst_opts = _gst_options(nums, roles_of)
    printed_gst = next((g for g in gst_opts if g is not None), None)
    idx = [i for i, tn in enumerate(nums) if not tn.num.is_percent and roles_of[i] not in ("gst", "hsn", "mrp", "discount")]
    best = None
    for i, j, k in itertools.permutations(idx, 3):
        if k < max(i, j):
            continue  # the amount comes after qty and rate
        for (q, pq), (p, pp), (t, pt) in itertools.product(_variants(nums[i]), _variants(nums[j]), _variants(nums[k])):
            if q <= 0 or p <= 0 or t <= 0:
                continue
            for g in gst_opts:
                base = q * p
                if _close(t, base, tol):
                    gst_included = False
                elif g and _close(t, base * (1 + g / 100), tol):
                    gst_included = True
                else:
                    continue
                score = 10.0 - pq - pp - pt
                score += 1.0 if k == idx[-1] else 0.0                # amount is usually the last number
                score += 1.0 if float(q).is_integer() else -0.5       # quantities are usually whole
                score -= 0.75 if nums[i].num.had_decimal else 0.0      # "380.00" is a price, not a qty
                score += 0.5 if nums[j].num.had_decimal else 0.0
                score += 0.5 if i < j else 0.0                         # qty column usually before rate
                score -= 2.0 if nums[i].attached_size else 0.0         # "80g" is pack size, not qty
                score += sum(0.75 for pos, want in ((i, "qty"), (j, "rate"), (k, "amount")) if roles_of[pos] == want)
                if best is None or score > best["score"]:
                    best = {"score": score, "qi": i, "pi": j, "ti": k, "qty": q, "price": p, "total": t,
                            "gst": printed_gst if g is None else g, "corrected": [n for n, pen in ((i, pq), (j, pp), (k, pt)) if pen]}
    return best


def parse_item(line: Line, roles: dict[str, float] | None, page_w: float, tol: float) -> ParsedItem | None:
    name_toks, nums, units = _split_tail(line.tokens)
    while name_toks and _SERIAL.match(name_toks[0].text):
        name_toks = name_toks[1:]
    name = " ".join(t.text for t in name_toks).strip(" .:-|")
    if sum(c.isalpha() for c in name) < 2 or not nums:
        return None
    roles_of = [nearest_role(tn.token.cx, roles, 0.08 * page_w) if roles else None for tn in nums]
    # HSN codes: header-labelled, or a 4/6/8-digit integer right after the name.
    for pos, tn in enumerate(nums):
        if roles_of[pos] is None and pos == 0 and len(nums) >= 4 and _HSN.match(tn.num.raw.strip()):
            roles_of[pos] = "hsn"

    notes: list[str] = []
    best = decode_numbers(nums, roles_of, tol)
    if best:
        qi, pi, ti = best["qi"], best["pi"], best["ti"]
        qty, price, total, gst = best["qty"], best["price"], best["total"], best["gst"]
        ok = True
        if best["corrected"]:
            notes.append("decimal point restored from qty x price")
        # Numbers left of qty (pack sizes like "80g") belong to the name.
        lead = [tn for pos, tn in enumerate(nums[:min(qi, pi)]) if roles_of[pos] not in ("hsn", "mrp")]
        if lead and lead[0].attached_size:
            name = (name + " " + " ".join(tn.token.text for tn in lead)).strip()
        used = [nums[qi], nums[pi], nums[ti]]
    else:
        # No consistent triple: fall back to columns or positions and let the validator flag it.
        ok = False
        by_role = {r: tn for tn, r in zip(nums, roles_of) if r}
        plain = [tn for tn, r in zip(nums, roles_of) if not tn.num.is_percent and r not in ("gst", "hsn", "mrp", "discount")]
        if not plain:
            return None
        t_tn = by_role.get("amount") or plain[-1]
        p_tn = by_role.get("rate") or (plain[-2] if len(plain) >= 2 else t_tn)
        q_tn = by_role.get("qty") or next((tn for tn in plain[:-2] if not tn.attached_size), None)
        total, price = t_tn.num.value, p_tn.num.value
        qty = q_tn.num.value if q_tn else 1.0
        if q_tn is None:
            notes.append("quantity not printed; assumed 1")
        gst = next((o for o in _gst_options(nums, roles_of) if o is not None), None)
        used = [tn for tn in (q_tn, p_tn, t_tn) if tn]
        notes.append("qty x price does not match line total")
    unit = (nums[best["qi"]].unit if best else None) or (units[0] if units else None)
    hsn = next((re.sub(r"\D", "", tn.num.raw) for tn, r in zip(nums, roles_of) if r == "hsn"), None)
    mrp = next((tn.num.value for tn, r in zip(nums, roles_of) if r == "mrp"), None)
    return ParsedItem(line.index, name, qty, unit, price, gst, total, ok,
                      min(tn.token.conf for tn in used), notes, hsn or None, mrp)


_INVOICE_NO = re.compile(r"\b(?:invoice|inv|bill|memo)\s*(?:no|number|num|#)\.?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9/\-]{0,19})", re.I)


def find_invoice_no(lines: list[Line]) -> str | None:
    for ln in lines:
        if m := _INVOICE_NO.search(ln.text):
            return m.group(1).strip("-/")
    return None


def find_supplier(lines: list[Line], stop_index: int) -> tuple[str | None, float]:
    best, best_h, conf = None, 0.0, 0.0
    for ln in lines[:max(1, min(stop_index, 8))]:
        text = ln.text.strip(" .:-|*")
        letters = sum(c.isalpha() for c in text)
        if letters < 3 or letters / max(1, len(text.replace(" ", ""))) < 0.6:
            continue
        if META.search(text) or (TITLE.search(text) and len(text.split()) <= 3):
            continue
        if ln.height > best_h * 1.05:  # shop names are printed largest
            best, best_h, conf = text, ln.height, ln.min_conf
    return best, conf


def find_total(lines: list[Line], start: int) -> tuple[float | None, int | None, float]:
    cands = []
    for ln in lines[start:]:
        if NOT_TOTAL.search(ln.text):
            continue
        prio = next((p for rx, p in TOTAL_KEYS if rx.search(ln.text)), 0)
        if not prio:
            continue
        nums = [(n, t) for t in ln.tokens if (n := parse_number(t.text)) and not n.is_percent]
        if not nums and ln.index + 1 < len(lines):
            nxt = lines[ln.index + 1]
            nums = [(n, t) for t in nxt.tokens if (n := parse_number(t.text)) and not n.is_percent]
        if nums:
            # Rightmost proper amount; stray fragments like "00" are ignored.
            real = [(n, t) for n, t in nums if n.had_decimal or n.value >= 10]
            n, t = (real or nums)[-1]
            cands.append((prio, ln.index, n.value, t.conf))
    if not cands:
        return None, None, 0.0
    prio, idx, value, conf = max(cands, key=lambda c: (c[0], c[1]))
    return value, idx, conf


def bill_level_gst(lines: list[Line]) -> float | None:
    rates = set()
    for ln in lines:
        low = ln.text.lower()
        pcts = [n.value for t in ln.tokens if (n := parse_number(t.text)) and n.is_percent]
        if not pcts:
            continue
        if "igst" in low:
            rates.add(pcts[0])
        elif "cgst" in low or "sgst" in low or "utgst" in low:
            rates.add(pcts[0] * 2)
    rates = {r for r in rates if r in ALLOWED_GST}
    return rates.pop() if len(rates) == 1 else None


def parse_bill(lines: list[Line], page_w: float, cfg: dict, today: dt.date | None = None) -> dict:
    oc = cfg["ocr"]
    tol = oc["arithmetic_tolerance"]
    warnings: list[str] = []
    header = detect_header(lines)
    roles = header[1] if header else None
    start = header[0] + 1 if header else 0

    items: list[ParsedItem] = []
    end = len(lines)
    for ln in lines[start:]:
        if is_summary(ln.text):
            if items:  # summary block reached
                end = ln.index
                break
            continue
        if META.search(ln.text) and not header:
            continue
        it = parse_item(ln, roles, page_w, tol)
        if it:
            items.append(it)

    total, total_idx, total_conf = find_total(lines, end if items else 0)
    gst_bill = bill_level_gst(lines[end:] if items else lines)
    if gst_bill is not None:
        for it in items:
            if it.gst_rate is None:
                it.gst_rate = gst_bill
                it.notes.append(f"GST {gst_bill:g}% taken from the bill's tax summary")

    gstins = find_gstins([ln.text for ln in lines])
    gstin = None
    if gstins:
        gstin, ok = gstins[0]
        if not ok:
            warnings.append(f"GSTIN {gstin} fails its checksum; check it")
    date_val = None
    for ln in sorted(lines, key=lambda l: not re.search(r"\b(date|dt|dated)\b", l.text, re.I)):
        if d := parse_date(ln.text, today):
            date_val = d
            break
    supplier, sup_conf = find_supplier(lines, header[0] if header else len(lines))

    low = oc["low_confidence"]
    for n, it in enumerate(items, 1):
        for note in it.notes:
            warnings.append(f"line {n} ({it.name}): {note}")
        if it.min_conf < low:
            warnings.append(f"line {n} ({it.name}): numbers hard to read, check qty and price")
    if total is not None and total_conf < low:
        warnings.append("invoice total hard to read; check it")
    if supplier and sup_conf < low:
        warnings.append("supplier name hard to read")
    if not items:
        warnings.append("no line items found")

    return {
        "bill": {
            "supplier_name": supplier,
            "invoice_date": date_val.isoformat() if date_val else None,
            "gstin": gstin,
            "items": [it.as_schema() for it in items],
            "invoice_total": total,
            "warnings": warnings,
        },
        # Fields outside bill_scan.json, used by the Edge Function adapter (ocr/server.py).
        "extra": {
            "invoice_no": find_invoice_no(lines),
            "items": [{"hsn": it.hsn, "mrp": it.mrp} for it in items],
        },
        "debug": {
            "header_line": header[0] if header else None,
            "header_roles": roles,
            "item_lines": [it.line_index for it in items],
            "arithmetic_ok": [it.arithmetic_ok for it in items],
            "total_line": total_idx,
        },
    }
