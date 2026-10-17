// Voice note or text message -> confirmable command. Used by the app and the Telegram bot.
//
// 1) Parse:   POST { business_id | telegram_chat_id, audio_base64? , mime_type?, text? }
//    -> { transcript, intent, draft, reply, needs_confirmation }
//    Read-only intents (check_stock, question) are answered straight away.
// 2) Execute: POST { business_id | telegram_chat_id, confirm: true, draft }
//    -> { ok, result, reply }
import { decodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
import { z } from "npm:zod@3.23.8";
import { answerQuestion } from "../_shared/assistant.ts";
import { cached, sha256 } from "../_shared/cache.ts";
import { chatJSON, chatModelName } from "../_shared/chat.ts";
import { cacheTtlHours, config } from "../_shared/config.ts";
import { geminiJSON, stripDataUrl, visionModel } from "../_shared/gemini.ts";
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { t } from "../_shared/i18n.ts";
import { inr, toPaise } from "../_shared/money.ts";
import { ruleParse } from "../_shared/rule_parser.ts";
import { type Command, COMMAND_PROMPT, commandValidator, transcriptJsonSchema, transcriptValidator } from "../_shared/schemas.ts";
import { type Ctx, getContext, must } from "../_shared/supabase.ts";

type Body = {
  business_id?: string;
  telegram_chat_id?: number;
  audio_base64?: string;
  mime_type?: string;
  text?: string;
  confirm?: boolean;
  draft?: unknown;
};

const draftValidator = z.object({
  intent: z.enum(["record_sale", "add_stock", "khata_credit", "khata_payment", "log_wastage"]),
  items: z.array(z.object({
    product_id: z.string().uuid().nullable(),
    name: z.string(),
    qty: z.number().positive(),
    unit: z.string().nullable().optional(),
    unit_price_paise: z.number().int().nonnegative().nullable().optional(),
    expiry_date: z.string().nullable().optional(),
  })).default([]),
  customer: z.string().nullable().optional(),
  amount_paise: z.number().int().positive().nullable().optional(),
  payment_mode: z.enum(["cash", "upi", "card", "credit"]).nullable().optional(),
  supplier: z.string().nullable().optional(),
  wastage_reason: z.string().nullable().optional(),
});
type Draft = z.infer<typeof draftValidator>;

serve(async (req) => {
  const body = await readJson<Body>(req);
  const ctx = await getContext(req, body);
  return body.confirm ? json(await execute(ctx, body.draft)) : json(await parse(ctx, body));
});

// ---------------------------------------------------------------- parse
async function parse(ctx: Ctx, body: Body) {
  const lang = ctx.business.language;
  let transcript = body.text?.trim() ?? "";

  if (!transcript && body.audio_base64) {
    const file = stripDataUrl(body.audio_base64);
    file.mimeType ||= body.mime_type || "audio/ogg";
    const bytes = decodeBase64(file.base64);
    if (bytes.length > config.limits.max_audio_bytes) throw new HttpError(413, "Voice note too long");
    try {
      const key = "voice:" + visionModel() + ":" + await sha256(bytes);
      const r = await cached(ctx.admin, key, cacheTtlHours("voice"), visionModel(), () =>
        geminiJSON({
          prompt: "Transcribe this voice note from an Indian shop or restaurant owner exactly as spoken (Hindi, Marathi, English or Hinglish). Keep numbers as digits.",
          files: [file],
          jsonSchema: transcriptJsonSchema,
          validator: transcriptValidator,
        }));
      transcript = r.value.transcript.trim();
    } catch (e) {
      return { ok: false, fallback: "manual", reply: t(lang, "ai_down"), reason: (e as Error).message };
    }
  }
  if (!transcript) throw new HttpError(400, "text or audio_base64 is required");

  // understand the command: chat model first, rules if it is unavailable
  let cmd: Command | null = null;
  let ai = true;
  try {
    const key = "cmd:" + chatModelName(true) + ":" + await sha256(transcript.toLowerCase());
    const raw = (await cached<unknown>(ctx.admin, key, cacheTtlHours("voice"), chatModelName(true), () =>
      chatJSON(COMMAND_PROMPT, transcript, commandValidator, { fast: true }).then((r) => r.data))).value;
    cmd = commandValidator.parse(raw); // re-validate (cache entries outlive code changes)
  } catch (e) {
    console.warn("command parse fallback:", (e as Error).message);
    ai = false;
    cmd = ruleParse(transcript);
  }
  if (!cmd) return { ok: false, fallback: "manual", transcript, reply: t(lang, "ai_down") };

  if (cmd.intent === "question") {
    const a = await answerQuestion(ctx, cmd.question || transcript);
    return { ok: true, transcript, intent: "question", needs_confirmation: false, reply: a.answer, ai: a.ai };
  }

  // resolve item names to products locally (trigram match, no AI)
  const names = cmd.items.map((i) => i.name);
  const matches = names.length
    ? must(await ctx.db.rpc("match_product_names", { p_business_id: ctx.business.id, p_names: names, p_min_similarity: 0.25 }), "matching") as
      { input_name: string; product_id: string | null; product_name: string | null }[]
    : [];
  const ids = matches.map((m) => m.product_id).filter(Boolean) as string[];
  const { data: products } = ids.length
    ? await ctx.db.from("product_stock").select("product_id, name, unit, sell_price_paise, cost_price_paise, on_hand").in("product_id", ids)
    : { data: [] as any[] };
  const byId = new Map((products ?? []).map((p: any) => [p.product_id, p]));

  if (cmd.intent === "check_stock") {
    const lines = cmd.items.map((it, i) => {
      const p = byId.get(matches[i]?.product_id ?? "");
      return p ? t(lang, "stock_level", { name: p.name, qty: Number(p.on_hand), unit: p.unit }) : t(lang, "stock_unknown", { name: it.name });
    });
    return { ok: true, transcript, intent: "check_stock", needs_confirmation: false, reply: lines.join("\n"), ai };
  }

  const items = cmd.items.map((it, i) => {
    const p = byId.get(matches[i]?.product_id ?? "");
    const spoken = toPaise(it.price);
    const price = cmd!.intent === "record_sale" ? spoken ?? p?.sell_price_paise ?? null : spoken ?? p?.cost_price_paise ?? null;
    return {
      product_id: p?.product_id ?? null,
      name: p?.name ?? it.name,
      qty: it.qty,
      unit: p?.unit ?? it.unit ?? null,
      unit_price_paise: price,
      expiry_date: it.expiry_date ?? null,
    };
  });
  const total = items.reduce((s, i) => s + Math.round((i.unit_price_paise ?? 0) * i.qty), 0);
  const draft: Draft = {
    intent: cmd.intent,
    items,
    customer: cmd.customer ?? null,
    amount_paise: toPaise(cmd.amount) ?? (cmd.intent.startsWith("khata") && total > 0 ? total : null),
    payment_mode: cmd.payment_mode ?? (cmd.intent === "record_sale" && cmd.customer ? "credit" : null),
    supplier: cmd.supplier ?? null,
    wastage_reason: cmd.wastage_reason ?? null,
  };

  const itemText = items.map((i) => `${i.qty} ${i.unit ?? ""} ${i.name}`.replace(/\s+/g, " ")).join(", ");
  const unknown = items.filter((i) => !i.product_id).map((i) => i.name);
  let reply = {
    record_sale: () => t(lang, "confirm_sale", { items: itemText, total: inr(total) }),
    add_stock: () => t(lang, "confirm_stock", { items: itemText }),
    khata_credit: () => t(lang, "confirm_khata_credit", { customer: draft.customer ?? "?", amount: inr(draft.amount_paise) }),
    khata_payment: () => t(lang, "confirm_khata_payment", { customer: draft.customer ?? "?", amount: inr(draft.amount_paise) }),
    log_wastage: () => t(lang, "confirm_wastage", { items: itemText }),
  }[cmd.intent]();
  if (unknown.length && cmd.intent === "add_stock") reply += "\n" + t(lang, "not_found", { names: unknown.join(", ") });

  const warnings: string[] = [];
  if (cmd.intent !== "add_stock" && unknown.length) warnings.push(`Not in your catalog: ${unknown.join(", ")}`);
  if (cmd.intent.startsWith("khata") && (!draft.customer || !draft.amount_paise)) warnings.push("Customer name and amount are needed.");

  return { ok: true, transcript, intent: cmd.intent, draft, reply, warnings, needs_confirmation: true, ai };
}

// ---------------------------------------------------------------- execute (after the user confirms)
async function execute(ctx: Ctx, raw: unknown) {
  const parsed = draftValidator.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid draft", parsed.error.issues);
  const d = parsed.data;
  const bid = ctx.business.id;
  const lang = ctx.business.language;
  let result: unknown;

  switch (d.intent) {
    case "record_sale": {
      const missing = d.items.filter((i) => !i.product_id);
      if (missing.length) throw new HttpError(400, `Unknown items: ${missing.map((i) => i.name).join(", ")}`);
      result = must(await ctx.db.rpc("record_sale", {
        p_business_id: bid,
        p_items: d.items.map((i) => ({ product_id: i.product_id, qty: i.qty, unit_price_paise: i.unit_price_paise ?? undefined })),
        p_payment_mode: d.payment_mode ?? "cash",
        p_channel: ctx.viaService ? "telegram" : "counter",
        p_khata_customer: d.customer ?? null,
      }), "record_sale");
      break;
    }
    case "add_stock":
      result = must(await ctx.db.rpc("record_purchase", {
        p_business_id: bid,
        p_purchase: { supplier_name: d.supplier ?? null, source: ctx.viaService ? "telegram" : "voice" },
        p_items: d.items.map((i) => ({
          product_id: i.product_id, name: i.name, unit: i.unit ?? "pcs", qty: i.qty,
          unit_cost_paise: i.unit_price_paise ?? 0, expiry_date: i.expiry_date ?? null,
        })),
      }), "record_purchase");
      break;
    case "khata_credit":
    case "khata_payment":
      if (!d.customer || !d.amount_paise) throw new HttpError(400, "Customer and amount are required");
      result = must(await ctx.db.rpc("khata_add", {
        p_business_id: bid, p_customer: d.customer, p_kind: d.intent === "khata_credit" ? "credit" : "payment",
        p_amount_paise: d.amount_paise, p_note: ctx.viaService ? "Telegram" : "Voice",
      }), "khata_add");
      break;
    case "log_wastage": {
      const out = [];
      for (const i of d.items) {
        if (!i.product_id) throw new HttpError(400, `Unknown item: ${i.name}`);
        out.push(must(await ctx.db.rpc("log_wastage", {
          p_business_id: bid, p_product_id: i.product_id, p_qty: i.qty,
          p_reason: ["expired", "spoiled", "overcooked", "returned", "damaged"].includes(d.wastage_reason ?? "") ? d.wastage_reason : "other",
        }), "log_wastage"));
      }
      result = out;
      break;
    }
  }
  return { ok: true, result, reply: t(lang, "done") };
}
