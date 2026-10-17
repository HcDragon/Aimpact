// Q&A over the business's own numbers. SQL computes every figure; the chat model only phrases the answer.
import { cacheTtlHours } from "./config.ts";
import { cached, sha256 } from "./cache.ts";
import { chatModelName, chatText, LANGUAGE_NAMES } from "./chat.ts";
import { inr, istToday } from "./money.ts";
import { AIError } from "./retry.ts";
import { type Ctx, must } from "./supabase.ts";

const daysAgo = (n: number) => {
  const d = new Date(istToday());
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Compact, rupee-formatted facts for the prompt (and for the no-AI fallback). */
export async function buildFacts(ctx: Ctx) {
  const id = ctx.business.id;
  const [dash, week, prevWeek, alerts, bundles] = await Promise.all([
    ctx.db.rpc("dashboard", { p_business_id: id }),
    ctx.db.rpc("profit_report", { p_business_id: id, p_from: daysAgo(7), p_to: daysAgo(1) }),
    ctx.db.rpc("profit_report", { p_business_id: id, p_from: daysAgo(14), p_to: daysAgo(8) }),
    ctx.db.from("alerts").select("kind, message").eq("business_id", id).eq("status", "open")
      .order("created_at", { ascending: false }).limit(8),
    ctx.db.from("bundle_suggestions").select("antecedent_ids, consequent_ids, confidence").eq("business_id", id)
      .order("lift", { ascending: false }).limit(3),
  ]);
  const d = must(dash, "dashboard") as Record<string, any>;
  const w = must(week, "profit report") as Record<string, any>;
  const pw = must(prevWeek, "profit report") as Record<string, any>;

  const isRestaurant = ctx.business.business_type === "restaurant";
  const facts = {
    business: `${ctx.business.name} (${isRestaurant ? "restaurant" : "shop"})`,
    today: istToday(),
    today_sales: `${inr(d.today.sales_paise)} from ${d.today.bills} bills, profit ${inr(d.today.profit_paise)}`,
    last_7_days: `sales ${inr(w.gross_sales_paise)}, net profit ${inr(w.net_profit_paise)} (${w.margin_pct}% margin), wastage ${inr(w.wastage_paise)}, ${w.bills} bills`,
    previous_7_days: `sales ${inr(pw.gross_sales_paise)}, net profit ${inr(pw.net_profit_paise)}`,
    last_30_days: `sales ${inr(d.last_30_days.sales_paise)}, profit ${inr(d.last_30_days.profit_paise)}`,
    stock_value: inr(d.stock_value_paise),
    udhaar_outstanding: inr(d.khata_outstanding_paise),
    top_items_30d: (d.top_products_30d ?? []).map((p: any) => `${p.name}: ${inr(p.sales_paise)} sales, ${inr(p.profit_paise)} profit`),
    best_margin_items_7d: (w.products ?? []).slice(0, 5).map((p: any) => `${p.name}: ${p.margin_pct}% margin`),
    worst_margin_items_7d: (w.products ?? []).slice(-3).map((p: any) => `${p.name}: ${p.margin_pct}% margin`),
    low_stock: (d.low_stock ?? []).map((p: any) => `${p.name}: ${Number(p.on_hand)} ${p.unit} left, reorder ${p.suggested_qty}`),
    expiring_soon: (d.expiring_soon ?? []).map((b: any) => `${b.name}: ${Number(b.qty)} ${b.unit} expires ${b.expiry_date}`),
    open_alerts: (alerts.data ?? []).map((a) => a.message),
    channels_7d: (w.channels ?? []).map((c: any) => `${c.channel}: ${inr(c.total_paise)}`),
    has_bundles: (bundles.data ?? []).length > 0,
  };
  return { facts, raw: { dashboard: d, week: w } };
}

function fallbackAnswer(facts: Awaited<ReturnType<typeof buildFacts>>["facts"]) {
  return [
    `Today: ${facts.today_sales}.`,
    `Last 7 days: ${facts.last_7_days}.`,
    facts.low_stock.length ? `Low stock: ${facts.low_stock.slice(0, 3).join("; ")}.` : "",
    facts.expiring_soon.length ? `Expiring: ${facts.expiring_soon.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean).join("\n");
}

export async function answerQuestion(ctx: Ctx, question: string, history: { role: "user" | "assistant"; content: string }[] = []) {
  const { facts } = await buildFacts(ctx);
  const lang = LANGUAGE_NAMES[ctx.business.language] ?? LANGUAGE_NAMES.en;
  const word = ctx.business.business_type === "restaurant" ? "ingredients/pantry" : "products/stock";
  const system = `You are a helpful business assistant for a small Indian ${ctx.business.business_type} owner.
Answer in ${lang} unless the user writes in another language - then reply in theirs.
Keep it short (max 5 lines), friendly and practical; this is read on a phone.
Use ONLY the numbers in FACTS. Never calculate new totals, percentages or forecasts yourself - if a number is not in FACTS, say you don't have it.
Use ₹ for money and refer to items as ${word}. Give one concrete suggestion when useful.
FACTS:
${JSON.stringify(facts, null, 1)}`;

  try {
    const key = "assistant:" + chatModelName() + ":" + await sha256(system, JSON.stringify(history.slice(-6)), question);
    const r = await cached(ctx.admin, key, cacheTtlHours("assistant"), chatModelName(), () =>
      chatText(system, question, { history: history.slice(-6) }).then((x) => x.text));
    return { answer: r.value, ai: true, facts };
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError(String(e));
    console.warn("assistant fallback:", err.message);
    return { answer: fallbackAnswer(facts), ai: false, facts };
  }
}
