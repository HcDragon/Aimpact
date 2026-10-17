// Bill-scan validator (FR-E1, FR-E2). Mirrors ml/validators/bill_scan.py; both run
// against shared/ai/fixtures/bill_cases.json.
//
// Outcomes:
//   valid=false            -> malformed output: fall back to manual entry, write nothing.
//   valid=true, accepted=false -> structurally fine but numbers disagree: show the
//                             flagged fields; the owner must correct or confirm them.
//   valid=true, accepted=true  -> owner still confirms before saving.

import { close, type Flag, isNum, isObject, isStrOrNull, parseModelJson, round2, unexpectedKeys } from "./common.ts";

export const ALLOWED_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
const TOP_KEYS = ["supplier_name", "invoice_date", "gstin", "items", "invoice_total", "warnings"];
const ITEM_KEYS = ["name", "qty", "unit", "unit_price", "gst_rate", "line_total"];
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type BillItem = {
  name: string;
  qty: number;
  unit: string | null;
  unit_price: number;
  gst_rate: number | null;
  line_total: number;
};

export type BillScan = {
  supplier_name: string | null;
  invoice_date: string | null;
  gstin: string | null;
  items: BillItem[];
  invoice_total: number | null;
  warnings: string[];
};

export type BillResult =
  | { valid: false; fallback: "manual_entry"; errors: string[] }
  | { valid: true; accepted: boolean; bill: BillScan; flags: Flag[]; computed_total: number };

function structuralErrors(x: unknown): string[] {
  if (!isObject(x)) return ["output is not a JSON object"];
  const errs = unexpectedKeys(x, TOP_KEYS, "");
  for (const k of TOP_KEYS) if (!(k in x)) errs.push(`${k}: missing`);
  if ("supplier_name" in x && !isStrOrNull(x.supplier_name)) errs.push("supplier_name: not a string");
  if ("invoice_date" in x && x.invoice_date !== null &&
      (typeof x.invoice_date !== "string" || !DATE.test(x.invoice_date) || isNaN(Date.parse(x.invoice_date)))) {
    errs.push("invoice_date: not YYYY-MM-DD");
  }
  if ("gstin" in x && x.gstin !== null && (typeof x.gstin !== "string" || !GSTIN.test(x.gstin))) {
    errs.push("gstin: invalid format");
  }
  if ("invoice_total" in x && x.invoice_total !== null && !(isNum(x.invoice_total) && x.invoice_total >= 0)) {
    errs.push("invoice_total: not a non-negative number");
  }
  if ("warnings" in x && !(Array.isArray(x.warnings) && x.warnings.every((w) => typeof w === "string"))) {
    errs.push("warnings: not a list of strings");
  }
  if (!Array.isArray(x.items) || x.items.length === 0) {
    errs.push("items: must be a non-empty list");
    return errs;
  }
  x.items.forEach((it, i) => {
    const p = `items[${i}].`;
    if (!isObject(it)) return errs.push(`${p.slice(0, -1)}: not an object`);
    errs.push(...unexpectedKeys(it, ITEM_KEYS, p));
    for (const k of ITEM_KEYS) if (!(k in it)) errs.push(`${p}${k}: missing`);
    if ("name" in it && !(typeof it.name === "string" && it.name.trim().length > 0)) errs.push(`${p}name: empty`);
    if ("qty" in it && !(isNum(it.qty) && it.qty > 0)) errs.push(`${p}qty: not a positive number`);
    if ("unit" in it && !isStrOrNull(it.unit)) errs.push(`${p}unit: not a string`);
    if ("unit_price" in it && !(isNum(it.unit_price) && it.unit_price >= 0)) errs.push(`${p}unit_price: not a non-negative number`);
    if ("line_total" in it && !(isNum(it.line_total) && it.line_total >= 0)) errs.push(`${p}line_total: not a non-negative number`);
    if ("gst_rate" in it && it.gst_rate !== null && !(isNum(it.gst_rate) && ALLOWED_GST_RATES.includes(it.gst_rate))) {
      errs.push(`${p}gst_rate: not an allowed GST rate`);
    }
  });
  return errs;
}

export function validateBillScan(raw: unknown): BillResult {
  const x = parseModelJson(raw);
  if (x === undefined) return { valid: false, fallback: "manual_entry", errors: ["output is not valid JSON"] };
  const errors = structuralErrors(x);
  if (errors.length) return { valid: false, fallback: "manual_entry", errors };

  const bill = x as BillScan;
  const flags: Flag[] = [];
  let exclusive = 0; // sum of qty x price
  let inclusive = 0; // with GST added
  let printed = 0;

  bill.items.forEach((it, i) => {
    const base = it.qty * it.unit_price;
    const withGst = base * (1 + (it.gst_rate ?? 0) / 100);
    exclusive += base;
    inclusive += withGst;
    printed += it.line_total;
    // Bills print line totals either before or after GST; accept either.
    if (!close(it.line_total, base, 1, 0.01) && !close(it.line_total, withGst, 1, 0.01)) {
      flags.push({
        field: `items[${i}].line_total`,
        message: `line total ${it.line_total} does not match qty ${it.qty} x price ${it.unit_price} (= ${round2(base)}` +
          (it.gst_rate ? `, or ${round2(withGst)} with ${it.gst_rate}% GST)` : ")"),
      });
    }
  });

  if (bill.invoice_total !== null) {
    const candidates = [printed, exclusive, inclusive];
    // Round-off of up to a couple of rupees is normal on Indian bills.
    if (!candidates.some((c) => close(bill.invoice_total as number, c, 2, 0.005))) {
      flags.push({
        field: "invoice_total",
        message: `invoice total ${bill.invoice_total} does not match the line items (sum ${round2(printed)}, ` +
          `with GST ${round2(inclusive)})`,
      });
    }
  } else {
    flags.push({ field: "invoice_total", message: "invoice total not read; check against the bill" });
  }
  if (bill.invoice_date === null) flags.push({ field: "invoice_date", message: "date not read" });

  return { valid: true, accepted: flags.length === 0, bill, flags, computed_total: round2(printed) };
}
