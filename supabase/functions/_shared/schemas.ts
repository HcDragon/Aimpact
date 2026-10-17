import { z } from "npm:zod@3.23.8";

const num = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : typeof v === "string" ? Number(v.replace(/[₹,\s]/g, "")) : v),
  z.number().finite().nullable());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null);

// ---------------------------------------------------------------- bill scan (Gemini)
export const billJsonSchema = {
  type: "object",
  properties: {
    supplier_name: { type: ["string", "null"] },
    supplier_gstin: { type: ["string", "null"] },
    invoice_no: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Product name as printed, expanded if abbreviated" },
          qty: { type: "number" },
          unit: { type: ["string", "null"], description: "pcs, kg, g, l, ml, pack, box, carton" },
          unit_price: { type: ["number", "null"], description: "Rate per unit in rupees, before GST" },
          line_amount: { type: ["number", "null"], description: "Amount printed for the line in rupees" },
          gst_rate: { type: ["number", "null"], description: "GST percent printed for the line" },
          mrp: { type: ["number", "null"] },
          hsn: { type: ["string", "null"] },
          batch_no: { type: ["string", "null"] },
          expiry_date: { type: ["string", "null"], description: "YYYY-MM-DD; if only month/year, use last day of month" },
        },
        required: ["name", "qty"],
      },
    },
    printed_total: { type: ["number", "null"], description: "Grand total printed on the bill in rupees" },
    unreadable: { type: "boolean", description: "true if this is not a bill or cannot be read" },
  },
  required: ["items"],
};

export const billValidator = z.object({
  supplier_name: z.string().nullable().optional(),
  supplier_gstin: z.string().nullable().optional(),
  invoice_no: z.string().nullable().optional(),
  invoice_date: isoDate.optional(),
  items: z.array(z.object({
    name: z.string().min(1),
    qty: z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().positive()),
    unit: z.string().nullable().optional(),
    unit_price: num.optional(),
    line_amount: num.optional(),
    gst_rate: num.optional(),
    mrp: num.optional(),
    hsn: z.string().nullable().optional(),
    batch_no: z.string().nullable().optional(),
    expiry_date: isoDate.optional(),
  })).max(200),
  printed_total: num.optional(),
  unreadable: z.boolean().optional(),
});
export type Bill = z.infer<typeof billValidator>;

// ---------------------------------------------------------------- transcription (Gemini)
export const transcriptJsonSchema = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "What was said, in the original language and script" },
    language: { type: "string", enum: ["en", "hi", "mr", "hinglish", "other"] },
  },
  required: ["transcript", "language"],
};
export const transcriptValidator = z.object({
  transcript: z.string(),
  language: z.enum(["en", "hi", "mr", "hinglish", "other"]).catch("other"),
});

// ---------------------------------------------------------------- commands (chat model)
export const INTENTS = ["record_sale", "add_stock", "check_stock", "khata_credit", "khata_payment", "log_wastage", "question"] as const;

export const commandValidator = z.object({
  intent: z.enum(INTENTS),
  items: z.array(z.object({
    name: z.string().min(1),
    qty: z.preprocess((v) => (v === null || v === undefined ? 1 : typeof v === "string" ? Number(v) : v), z.number().positive()),
    unit: z.string().nullable().optional(),
    price: num.optional(),
    expiry_date: isoDate.optional(),
  })).default([]),
  customer: z.string().nullable().optional(),
  amount: num.optional(),
  payment_mode: z.enum(["cash", "upi", "card", "credit"]).nullable().optional().catch(null),
  supplier: z.string().nullable().optional(),
  wastage_reason: z.enum(["expired", "spoiled", "overcooked", "returned", "damaged", "other"]).nullable().optional().catch("other"),
  question: z.string().nullable().optional(),
});
export type Command = z.infer<typeof commandValidator>;

export const COMMAND_PROMPT = `You turn short messages from Indian shop/restaurant owners into a command.
Messages may be in English, Hindi, Marathi or Hinglish. Units/quantities can be words ("do", "teen", "aadha kilo").
Intents:
- record_sale: something was sold ("2 maggi becha", "sold 3 milk").
- add_stock: goods received/bought ("50 parle g aaya", "received 10kg onion at 30").
- check_stock: asking how much of an item is left.
- khata_credit: a customer took goods/money on credit (udhaar) - set customer and amount (rupees) or items.
- khata_payment: a customer paid back - set customer and amount.
- log_wastage: something was thrown away/spoiled.
- question: anything else (sales, profit, advice) - copy the question.
JSON shape: {"intent": string, "items": [{"name": string, "qty": number, "unit": string|null, "price": number|null (rupees per unit), "expiry_date": "YYYY-MM-DD"|null}],
"customer": string|null, "amount": number|null (rupees), "payment_mode": "cash"|"upi"|"card"|"credit"|null, "supplier": string|null,
"wastage_reason": "expired"|"spoiled"|"overcooked"|"returned"|"damaged"|"other"|null, "question": string|null}
Use item names in English as they would appear on a product label. Never invent items or numbers that were not said.`;

// ---------------------------------------------------------------- reviews (chat model)
export const sentimentValidator = z.object({
  results: z.array(z.object({
    id: z.string(),
    sentiment: z.enum(["positive", "neutral", "negative"]),
    score: z.number().min(-1).max(1),
    topics: z.array(z.string()).max(6).default([]),
  })),
});

// ---------------------------------------------------------------- CSV import (local)
export const importOrderValidator = z.object({
  external_order_id: z.string(),
  sold_at: z.string(),
  items: z.array(z.object({ name: z.string(), qty: z.number().positive() })),
  total_paise: z.number().nullable(),
});
