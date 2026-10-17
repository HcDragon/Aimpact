// Bill photo -> draft purchase for the user to confirm. Never saves anything.
// POST { business_id, image_base64 | storage_path, mime_type? }
// -> { ok: true, engine: "gemini"|"ocr", draft: { purchase, items[] }, warnings[] }  or  { ok: false, fallback: "manual", reason }
// If Gemini fails or cannot read the photo and OCR_SERVICE_URL is set, the local EasyOCR service is tried first.
// The confirmed draft is saved with rpc('record_purchase', { p_business_id, p_purchase, p_items }).
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
import { cacheTtlHours, config } from "../_shared/config.ts";
import { cached, sha256 } from "../_shared/cache.ts";
import { geminiJSON, stripDataUrl, visionModel } from "../_shared/gemini.ts";
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { toPaise } from "../_shared/money.ts";
import { AIError } from "../_shared/retry.ts";
import { type Bill, billJsonSchema, billValidator } from "../_shared/schemas.ts";
import { ocrBill } from "../_shared/ocr.ts";
import { getContext, must } from "../_shared/supabase.ts";

const PROMPT = `You read Indian purchase bills / invoices (printed or handwritten, English/Hindi/Marathi).
Extract the supplier, invoice number, invoice date and every line item exactly as printed.
Rules: amounts are in rupees; do not calculate anything that is not printed; use null when a field is missing;
expand obvious abbreviations in product names (e.g. "PRL G 250" -> "Parle-G 250g"); dates as YYYY-MM-DD.
If the image is not a bill, return {"items": [], "unreadable": true}.`;

serve(async (req) => {
  const body = await readJson<{ business_id?: string; telegram_chat_id?: number; image_base64?: string; storage_path?: string; mime_type?: string }>(req);
  const ctx = await getContext(req, body);

  // ---- load the image
  let file: { mimeType: string; base64: string };
  if (body.storage_path) {
    if (!body.storage_path.startsWith(ctx.business.id + "/")) throw new HttpError(403, "storage_path must be inside your business folder");
    const { data, error } = await ctx.db.storage.from("bills").download(body.storage_path);
    if (error || !data) throw new HttpError(404, "Bill image not found");
    file = { mimeType: data.type || body.mime_type || "image/jpeg", base64: encodeBase64(new Uint8Array(await data.arrayBuffer())) };
  } else if (body.image_base64) {
    file = stripDataUrl(body.image_base64);
    file.mimeType ||= body.mime_type || "image/jpeg";
  } else {
    throw new HttpError(400, "image_base64 or storage_path is required");
  }
  if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.mimeType)) throw new HttpError(415, `Unsupported file type ${file.mimeType}`);
  const bytes = decodeBase64(file.base64);
  if (bytes.length > config.limits.max_image_bytes) throw new HttpError(413, "Image too large; please send a smaller photo");

  // ---- AI extraction (cached by image hash); on failure try local OCR, then manual entry
  let bill: Bill | null = null;
  let fromCache = false;
  let engine: "gemini" | "ocr" = "gemini";
  let ocrWarnings: string[] = [];
  let failure = "This does not look like a readable bill";
  try {
    const key = "bill:" + visionModel() + ":" + await sha256(bytes);
    const r = await cached(ctx.admin, key, cacheTtlHours("bill_scan"), visionModel(), () =>
      geminiJSON({ prompt: PROMPT, files: [file], jsonSchema: billJsonSchema, validator: billValidator }));
    bill = billValidator.parse(r.value);
    fromCache = r.cached;
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError(String(e));
    failure = err.rateLimited ? "AI is busy, please enter the bill manually" : `Could not read the bill (${err.message})`;
  }
  if (!bill || bill.unreadable || bill.items.length === 0) {
    const ocr = await ocrBill(file.base64, file.mimeType);
    if (ocr) {
      bill = ocr.bill;
      engine = "ocr";
      fromCache = false;
      ocrWarnings = ["Read by offline OCR. Please check every line.", ...ocr.warnings];
    }
  }
  if (!bill || bill.unreadable || bill.items.length === 0) {
    return json({ ok: false, fallback: "manual", reason: failure });
  }

  // ---- local post-processing: money in paise, product matching, arithmetic checks
  const matches = must(await ctx.db.rpc("match_product_names", {
    p_business_id: ctx.business.id,
    p_names: bill.items.map((i) => i.name),
  }), "product matching") as { input_name: string; product_id: string | null; product_name: string | null; similarity: number | null }[];

  const warnings: string[] = [...ocrWarnings];
  const items = bill.items.map((it, idx) => {
    const m = matches[idx];
    let unitCost = toPaise(it.unit_price);
    const line = toPaise(it.line_amount);
    if (unitCost === null && line !== null) {
      // only a line amount printed: derive the rate locally (ex-GST if a rate is printed)
      const rate = it.gst_rate ?? 0;
      unitCost = Math.round(line / it.qty / (1 + rate / 100));
      warnings.push(`Line ${idx + 1} (${it.name}): rate worked out from the line amount, please check.`);
    }
    if (unitCost !== null && line !== null) {
      const expectEx = unitCost * it.qty;
      const expectInc = Math.round(expectEx * (1 + (it.gst_rate ?? 0) / 100));
      if (Math.abs(line - expectEx) > 100 + expectEx * 0.02 && Math.abs(line - expectInc) > 100 + expectInc * 0.02) {
        warnings.push(`Line ${idx + 1} (${it.name}): qty × rate does not match the printed amount.`);
      }
    }
    const good = m?.product_id && (m.similarity ?? 0) >= 0.45;
    return {
      name: it.name,
      product_id: good ? m.product_id : null,
      matched_name: m?.product_name ?? null,
      match_similarity: m?.similarity ?? null,
      qty: it.qty,
      unit: it.unit ?? null,
      unit_cost_paise: unitCost,
      gst_rate: it.gst_rate ?? null,
      mrp_paise: toPaise(it.mrp),
      hsn_code: it.hsn ?? null,
      batch_no: it.batch_no ?? null,
      expiry_date: it.expiry_date ?? null,
    };
  });

  const computedTotal = items.reduce((s, i) => s + Math.round((i.unit_cost_paise ?? 0) * i.qty * (1 + (i.gst_rate ?? 0) / 100)), 0);
  const printed = toPaise(bill.printed_total);
  if (printed !== null && Math.abs(printed - computedTotal) > Math.max(500, printed * 0.02)) {
    warnings.push(`Items add up to ₹${(computedTotal / 100).toFixed(2)} but the bill total is ₹${(printed / 100).toFixed(2)}. Some lines may be missing.`);
  }
  if (items.some((i) => i.unit_cost_paise === null)) warnings.push("Some lines have no price. Please fill them in.");

  return json({
    ok: true,
    engine,
    cached: fromCache,
    draft: {
      purchase: {
        supplier_name: bill.supplier_name ?? null,
        supplier_gstin: bill.supplier_gstin ?? null,
        invoice_no: bill.invoice_no ?? null,
        invoice_date: bill.invoice_date ?? null,
        source: "bill_scan",
        bill_image_path: body.storage_path ?? null,
      },
      items,
      computed_total_paise: computedTotal,
      printed_total_paise: printed,
    },
    warnings,
  });
});
