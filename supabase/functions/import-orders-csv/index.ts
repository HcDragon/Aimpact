// Zomato / Swiggy order CSV export -> sales (no API integration; restaurants upload the export).
// POST { business_id, channel: "zomato"|"swiggy", csv_text, commit?: boolean, mapping?: { "<item name in CSV>": "<product_id>" } }
// Preview (commit=false): parsed orders + unmatched item names with suggestions.
// Commit: imports orders whose items all map to products (idempotent by order id).
import { findColumn, parseCSV, parseIndianDateTime, parseItemsCell } from "../_shared/csv.ts";
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { toPaise } from "../_shared/money.ts";
import { getContext, must } from "../_shared/supabase.ts";

serve(async (req) => {
  const body = await readJson<{
    business_id?: string; channel?: string; csv_text?: string; commit?: boolean; mapping?: Record<string, string>;
  }>(req);
  const ctx = await getContext(req, body);
  const channel = body.channel ?? "zomato";
  if (!["zomato", "swiggy"].includes(channel)) throw new HttpError(400, "channel must be zomato or swiggy");
  if (!body.csv_text) throw new HttpError(400, "csv_text is required");
  if (body.csv_text.length > 5_000_000) throw new HttpError(413, "CSV too large (max 5 MB); split it by month");

  const rows = parseCSV(body.csv_text);
  if (rows.length < 2) throw new HttpError(400, "CSV has no data rows");
  const headers = rows[0];
  const col = {
    id: findColumn(headers, [/^order.?id$/i, /order.?(id|no|number)/i, /^id$/i]),
    date: findColumn(headers, [/order.?placed/i, /order.?(date|time)/i, /created/i, /date/i]),
    items: findColumn(headers, [/items.?in.?order/i, /^items?$/i, /order.?items/i, /dish/i, /item/i]),
    total: findColumn(headers, [/bill.?subtotal/i, /total.?bill/i, /order.?value/i, /net.?amount/i, /total/i, /amount/i]),
    status: findColumn(headers, [/order.?status/i, /status/i, /state/i]),
  };
  if (col.id < 0 || col.items < 0) {
    throw new HttpError(400, "Could not find the order id and items columns", { headers });
  }

  type Order = { external_order_id: string; sold_at: string | null; items: { name: string; qty: number }[]; total_paise: number | null };
  const orders: Order[] = [];
  let skippedCancelled = 0;
  for (const r of rows.slice(1)) {
    const status = col.status >= 0 ? (r[col.status] ?? "").toLowerCase() : "";
    if (/cancel|reject|fail|refund/.test(status)) { skippedCancelled++; continue; }
    const id = (r[col.id] ?? "").trim();
    if (!id) continue;
    orders.push({
      external_order_id: id,
      sold_at: col.date >= 0 ? parseIndianDateTime(r[col.date] ?? "") : null,
      items: parseItemsCell(r[col.items] ?? ""),
      total_paise: col.total >= 0 ? toPaise(r[col.total]) : null,
    });
  }

  // map item names -> products (explicit mapping wins, then fuzzy match)
  const names = [...new Set(orders.flatMap((o) => o.items.map((i) => i.name)))];
  const matches = names.length
    ? must(await ctx.db.rpc("match_product_names", { p_business_id: ctx.business.id, p_names: names, p_min_similarity: 0.3 }), "matching") as
      { input_name: string; product_id: string | null; product_name: string | null; similarity: number | null }[]
    : [];
  const map = new Map<string, string>();
  const suggestions: Record<string, { product_id: string | null; product_name: string | null; similarity: number | null }> = {};
  for (const m of matches) {
    suggestions[m.input_name] = { product_id: m.product_id, product_name: m.product_name, similarity: m.similarity };
    if (m.product_id && (m.similarity ?? 0) >= 0.6) map.set(m.input_name, m.product_id);
  }
  for (const [name, pid] of Object.entries(body.mapping ?? {})) if (pid) map.set(name, pid);
  const unmatched = names.filter((n) => !map.has(n));

  const ready = orders.filter((o) => o.items.length && o.items.every((i) => map.has(i.name)));
  const dates = orders.map((o) => o.sold_at).filter(Boolean).sort() as string[];
  const summary = {
    columns: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, i >= 0 ? headers[i] : null])),
    orders_found: orders.length,
    orders_ready: ready.length,
    skipped_cancelled: skippedCancelled,
    date_range: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    unmatched_items: unmatched.map((n) => ({ name: n, suggestion: suggestions[n] ?? null })),
  };

  if (!body.commit) return json({ preview: true, ...summary, sample: orders.slice(0, 5) });

  const payload = ready.map((o) => ({
    external_order_id: o.external_order_id,
    sold_at: o.sold_at,
    items: o.items.map((i) => ({ product_id: map.get(i.name), qty: i.qty })),
  }));
  const result = must(await ctx.db.rpc("import_sales", { p_business_id: ctx.business.id, p_channel: channel, p_orders: payload }), "import");
  return json({ preview: false, ...summary, result });
});
