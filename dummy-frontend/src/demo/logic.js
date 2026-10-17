// OFFLINE DEMO ONLY — JavaScript stand-ins for the Postgres views and functions in
// supabase/migrations/, computed live from the sample data. Delete src/demo/ to remove.
import { daysFrom } from "../lib/format.js";
import { TODAY, dishCost, newId } from "./data.js";

const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + Number(f(x) ?? 0), 0);
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const dayOf = (ts) => ts.slice(0, 10);
const exGst = (paise, rate) => paise / (1 + rate / 100);

// ---------------------------------------------------------------- views
export function productStock(db) {
  return db.products.map((p) => {
    const open = db.stock_batches.filter((b) => b.product_id === p.id && b.qty_remaining > 0);
    const exp = open.map((b) => b.expiry_date).filter(Boolean).sort();
    return {
      product_id: p.id, business_id: p.business_id, name: p.name, kind: p.kind, category: p.category, unit: p.unit, barcode: p.barcode,
      sell_price_paise: p.sell_price_paise, cost_price_paise: p.kind === "dish" ? Math.round(dishCost(db, p)) : p.cost_price_paise,
      gst_rate: p.gst_rate, reorder_level: p.reorder_level, is_active: p.is_active,
      on_hand: round(sum(open, (b) => b.qty_remaining)), next_expiry: exp[0] ?? null,
      stock_value_paise: Math.round(sum(open, (b) => b.qty_remaining * b.unit_cost_paise)), open_batches: open.length,
    };
  });
}

const saleDay = (db) => new Map(db.sales.map((s) => [s.id, dayOf(s.sold_at)]));

/** Units used per stocked product per day (dish sales exploded through recipes). */
export function dailyUsage(db) {
  const days = saleDay(db);
  const out = new Map();
  const add = (business_id, product_id, day, qty) => {
    const k = product_id + "|" + day;
    const row = out.get(k) ?? { business_id, product_id, day, qty: 0 };
    row.qty += qty;
    out.set(k, row);
  };
  const recipeOf = new Map(db.recipes.map((r) => [r.dish_product_id, r]));
  const kind = new Map(db.products.map((p) => [p.id, p.kind]));
  for (const si of db.sale_items) {
    const day = days.get(si.sale_id);
    if (kind.get(si.product_id) !== "dish") add(si.business_id, si.product_id, day, si.qty);
    const r = recipeOf.get(si.product_id);
    if (r) for (const ri of db.recipe_ingredients.filter((x) => x.recipe_id === r.id)) add(si.business_id, ri.ingredient_product_id, day, si.qty * ri.qty / r.yield_qty);
  }
  return [...out.values()].map((r) => ({ ...r, qty: round(r.qty) }));
}

export function dailyProductSales(db) {
  const days = saleDay(db);
  const prod = new Map(db.products.map((p) => [p.id, p]));
  const out = new Map();
  for (const si of db.sale_items) {
    const day = days.get(si.sale_id);
    const p = prod.get(si.product_id);
    const k = si.product_id + "|" + day;
    const row = out.get(k) ?? { business_id: si.business_id, product_id: si.product_id, name: p.name, category: p.category, kind: p.kind, day, qty: 0, revenue_paise: 0 };
    row.qty += si.qty;
    row.revenue_paise += si.line_total_paise;
    out.set(k, row);
  }
  return [...out.values()];
}

export function khataBalances(db) {
  return db.khata_customers.map((c) => {
    const es = db.khata_entries.filter((e) => e.customer_id === c.id);
    return {
      customer_id: c.id, business_id: c.business_id, name: c.name, phone: c.phone,
      balance_paise: sum(es, (e) => (e.kind === "credit" ? e.amount_paise : -e.amount_paise)),
      last_entry_at: es.map((e) => e.created_at).sort().at(-1) ?? null,
    };
  });
}

// ---------------------------------------------------------------- forecasts + bundles (what the nightly job writes)
const DIWALI = "2026-11-08";
function festivalLift(day, sens) {
  if (!sens) return 1;
  const k = (Date.parse(day) - Date.parse(DIWALI)) / 864e5;
  if (k < -10 || k > 2) return 1;
  return 1 + (sens - 1) * (k < 0 ? (k + 11) / 10 : k === 0 ? 0.6 : 0.25);
}

/** Same tiers as forecasting/model.py; values from a weekday-aware average with festival lift. */
export function buildForecasts(db) {
  db.forecasts = [];
  const usage = dailyUsage(db);
  const dishSales = dailyProductSales(db).filter((r) => r.kind === "dish");
  for (const b of db.businesses.filter((x) => x.business_type !== "wholesaler")) {
    for (const [rows, kindFilter] of [[usage, (p) => p.kind !== "dish"], [dishSales, (p) => p.kind === "dish"]]) {
      const items = db.products.filter((p) => p.business_id === b.id && p.is_active && kindFilter(p));
      const hist = new Map(items.map((p) => [p.id, new Map()]));
      for (const r of rows) if (hist.has(r.product_id) && r.day < TODAY) hist.get(r.product_id).set(r.day, (hist.get(r.product_id).get(r.day) ?? 0) + r.qty);
      const firstDay = (m) => [...m.entries()].filter(([, q]) => q > 0).map(([d]) => d).sort()[0];
      const eligible = items.filter((p) => { const f = firstDay(hist.get(p.id)); return f && (Date.parse(TODAY) - Date.parse(f)) / 864e5 >= 56; });
      const volume = (p) => sum([...hist.get(p.id).values()]);
      const ranked = eligible.slice().sort((x, y) => volume(y) - volume(x));
      const nTop = Math.max(1, Math.ceil(ranked.length * 0.2));
      const byCat = {};
      for (const p of ranked.slice(nTop)) (byCat[p.category] ??= []).push(p);
      ranked.forEach((p, i) => {
        const method = i < nTop ? "prophet" : (p.category && byCat[p.category]?.length >= 2 ? "category" : "moving_average");
        const m = hist.get(p.id);
        for (let h = 0; h <= 14; h++) { // h = 0: today's row, written by last night's run
          const d = daysFrom(TODAY, h);
          // Most recent 4 same-weekday days strictly before today (today is still in progress).
          const same = [1, 2, 3, 4].map((w) => m.get(daysFrom(d, -7 * (w + Math.floor(h / 7)))) ?? 0);
          const mean = sum(same) / 4;
          const sd = Math.sqrt(sum(same, (x) => (x - mean) ** 2) / 4);
          const yhat = mean * festivalLift(d, p._spec?.diwali);
          const spread = Math.max(sd, Math.sqrt(Math.max(mean, 0.1))) * (method === "prophet" ? 1.15 : 1.4);
          db.forecasts.push({
            id: newId("f"), business_id: b.id, product_id: p.id, category: method === "category" ? p.category : null, forecast_date: d,
            yhat: round(yhat), yhat_lower: round(Math.max(0, yhat - spread)), yhat_upper: round(yhat + spread), method,
            generated_at: TODAY + "T02:30:00+05:30",
          });
        }
      });
    }
  }
}

/** Pair rules over the last 90 days of bills, like ml/shop/bundles.py (support >= 1%, lift >= 1.2). */
export function buildBundles(db) {
  db.bundle_suggestions = [];
  for (const b of db.businesses.filter((x) => x.business_type === "shop")) {
    const baskets = new Map();
    for (const si of db.sale_items.filter((x) => x.business_id === b.id)) (baskets.get(si.sale_id) ?? baskets.set(si.sale_id, new Set()).get(si.sale_id)).add(si.product_id);
    const n = baskets.size;
    const one = new Map(), two = new Map();
    for (const items of baskets.values()) {
      const xs = [...items];
      for (const a of xs) one.set(a, (one.get(a) ?? 0) + 1);
      for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
        const k = [xs[i], xs[j]].sort().join("|");
        two.set(k, (two.get(k) ?? 0) + 1);
      }
    }
    const rules = [];
    for (const [k, c] of two) {
      const [x, y] = k.split("|");
      const support = c / n;
      if (support < 0.01) continue;
      for (const [a, cnext] of [[x, y], [y, x]]) {
        const confidence = c / one.get(a);
        const lift = confidence / (one.get(cnext) / n);
        if (lift >= 1.2) rules.push({ a, c: cnext, support, confidence, lift });
      }
    }
    const seen = new Set();
    for (const r of rules.sort((p, q) => q.lift - p.lift)) {
      const key = [r.a, r.c].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      db.bundle_suggestions.push({ id: newId("bs"), business_id: b.id, antecedent_ids: [r.a], consequent_ids: [r.c], support: round(r.support, 4), confidence: round(r.confidence, 4), lift: round(r.lift, 4), generated_at: TODAY });
      if (seen.size >= 12) break;
    }
  }
}

/** Placeholder evaluation rows, clearly flagged `illustrative`; real numbers come from forecasting/evaluate_forecasts.py. */
export function buildEvaluations(db) {
  db.forecast_evaluations = db.businesses.filter((b) => b.business_type !== "wholesaler").map((b) => ({
    id: newId("fe"), business_id: b.id, generated_at: TODAY + "T02:00:00+05:30", model_version: "ml-0.1.0", holdout_start: daysFrom(TODAY, -28), holdout_days: 28,
    command: "illustrative sample (offline demo): run python forecasting/evaluate_forecasts.py for measured numbers", illustrative: true,
    tiers: {
      prophet: { n_items: b.business_type === "shop" ? 4 : 3, model: { mape: 21.4, wape: 18.2, coverage: 86.0 }, baseline: { mape: 27.9, wape: 24.6, coverage: 71.0 }, winner: "model",
        policy_simulation: { dynamic: { stockout_days: 0.5, avg_on_hand: 41.2 }, fixed: { stockout_days: 2.8, avg_on_hand: 47.9 } } },
      category: { n_items: 6, model: { mape: 34.1, wape: 29.5, coverage: 82.0 }, baseline: { mape: 36.0, wape: 31.2, coverage: 68.0 }, winner: "model" },
      moving_avg: { n_items: 5, model: { mape: 41.7, wape: 37.9, coverage: 79.0 }, baseline: { mape: 39.2, wape: 35.1, coverage: 66.0 }, winner: "seasonal_naive" },
    },
  }));
}

export function buildAlerts(db) {
  for (const b of db.businesses.filter((x) => x.business_type !== "wholesaler")) refreshAlerts(db, b.id);
  db.alerts.push({ id: newId("al"), business_id: "b-shop", product_id: null, kind: "insight", severity: "info", status: "open", created_at: TODAY + "T07:00:00+05:30", data: {},
    message: "Diwali is three weeks away. Last year Kaju, Amul Ghee and Haldiram Bhujia sold 2–4× normal in the 10 days before; the forecast already includes this, so reorder points will rise from next week." });
  db.alerts.push({ id: newId("al"), business_id: "b-rest", product_id: null, kind: "insight", severity: "info", status: "open", created_at: TODAY + "T07:00:00+05:30", data: {},
    message: "12 kg of paneer expires tomorrow but today's forecast uses about 4.5 kg. Push Paneer Tikka and Paneer Butter Masala as today's specials." });
}

export function refreshAlerts(db, bid) {
  const biz = db.businesses.find((b) => b.id === bid);
  db.alerts = db.alerts.filter((a) => !(a.business_id === bid && a.status === "open" && ["low_stock", "out_of_stock", "expiry_soon", "expired"].includes(a.kind)));
  let n = 0;
  for (const r of reorderSuggestions(db, bid).filter((x) => x.suggested_qty > 0)) {
    db.alerts.push({ id: newId("al"), business_id: bid, product_id: r.product_id, kind: r.on_hand <= 0 ? "out_of_stock" : "low_stock", severity: r.on_hand <= 0 ? "critical" : "warning", status: "open",
      message: `${r.name}: ${round(r.on_hand, 1)} ${r.unit} left, below the reorder point of ${round(r.reorder_point, 1)}. Order ${round(r.suggested_qty, 1)} ${r.unit}.`, created_at: TODAY + "T06:00:00+05:30", data: {} });
    n++;
  }
  for (const bt of db.stock_batches.filter((x) => x.business_id === bid && x.qty_remaining > 0 && x.expiry_date && x.expiry_date <= daysFrom(TODAY, biz.expiry_alert_days))) {
    const p = db.products.find((x) => x.id === bt.product_id);
    const expired = bt.expiry_date < TODAY;
    db.alerts.push({ id: newId("al"), business_id: bid, product_id: p.id, kind: expired ? "expired" : "expiry_soon", severity: expired || bt.expiry_date <= daysFrom(TODAY, 1) ? "critical" : "warning", status: "open",
      message: `${p.name}: ${round(bt.qty_remaining, 1)} ${p.unit} ${expired ? "expired on" : "expires on"} ${bt.expiry_date.split("-").reverse().join("/")}.`, created_at: TODAY + "T06:00:00+05:30", data: {} });
  }
  return n;
}

// ---------------------------------------------------------------- read RPCs
export function reorderSuggestions(db, bid) {
  const biz = db.businesses.find((b) => b.id === bid);
  const lead = Math.max(1, biz.lead_time_days);
  const usage = dailyUsage(db).filter((u) => u.business_id === bid);
  return productStock(db).filter((s) => s.business_id === bid && s.kind !== "dish" && s.is_active).map((s) => {
    const p = db.products.find((x) => x.id === s.product_id);
    const fc = db.forecasts.filter((f) => f.product_id === s.product_id && f.forecast_date > TODAY && f.forecast_date <= daysFrom(TODAY, lead));
    const u = usage.filter((x) => x.product_id === s.product_id);
    const recent = u.filter((x) => x.day > daysFrom(TODAY, -28));
    const avg = sum(recent, (x) => x.qty) / 28;
    const first = u.map((x) => x.day).sort()[0];
    const old = first && first <= daysFrom(TODAY, -14);
    const daily = fc.length ? sum(fc, (f) => f.yhat) / lead : old ? avg : 0;
    const safety = fc.length ? sum(fc, (f) => Math.max(f.yhat_upper - f.yhat, 0)) : old ? avg * lead * 0.5 : 0;
    const method = fc.length ? fc[0].method : old ? "moving_average" : "rule";
    const rop = Math.max(daily * lead + safety, p.reorder_level ?? 0);
    const shelf = p._spec?.shelf ?? ING_SHELF(p);
    const cover = shelf ? Math.max(0, Math.min(7, shelf - 1 - lead)) : 7;
    const sup = db.suppliers.find((x) => x.id === p.preferred_supplier_id);
    const need = s.on_hand < rop ? Math.max(0, rop + daily * cover - s.on_hand) : 0;
    const step = ["kg", "l", "g", "ml"].includes(p.unit) ? 0.5 : 1;
    return {
      product_id: s.product_id, name: s.name, unit: s.unit, kind: s.kind, on_hand: s.on_hand, reorder_point: round(rop, 2),
      suggested_qty: need ? Math.ceil(need / step) * step : 0, avg_daily_demand: round(daily, 2), safety_stock: round(safety, 2), method,
      supplier_id: sup?.id ?? null, supplier_name: sup?.name ?? null, unit_cost_paise: s.cost_price_paise, next_expiry: s.next_expiry,
    };
  }).filter((r) => r.suggested_qty > 0).sort((a, b) => b.suggested_qty * (b.unit_cost_paise ?? 0) - a.suggested_qty * (a.unit_cost_paise ?? 0));
}
const ING_SHELF = (p) => (p.kind === "ingredient" ? p._spec?.shelf ?? null : null);

function salesBetween(db, bid, from, to) {
  return db.sales.filter((s) => s.business_id === bid && dayOf(s.sold_at) >= from && dayOf(s.sold_at) <= to);
}

export function dashboard(db, bid) {
  const today = salesBetween(db, bid, TODAY, TODAY);
  const month = salesBetween(db, bid, daysFrom(TODAY, -29), TODAY);
  const profit = (ss) => sum(ss, (s) => s.subtotal_paise - s.cogs_paise);
  const stock = productStock(db).filter((s) => s.business_id === bid);
  const ids = new Set(month.map((s) => s.id));
  const byProd = {};
  for (const si of db.sale_items.filter((x) => ids.has(x.sale_id))) {
    const r = (byProd[si.product_id] ??= { name: db.products.find((p) => p.id === si.product_id).name, sales_paise: 0, profit_paise: 0 });
    r.sales_paise += si.line_total_paise;
    r.profit_paise += si.line_total_paise - si.tax_paise - si.cogs_paise;
  }
  const exp = db.stock_batches.filter((b) => b.business_id === bid && b.qty_remaining > 0 && b.expiry_date && b.expiry_date <= daysFrom(TODAY, 7))
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))
    .map((b) => { const p = db.products.find((x) => x.id === b.product_id); return { name: p.name, qty: b.qty_remaining, unit: p.unit, expiry_date: b.expiry_date }; });
  return {
    today: { sales_paise: sum(today, (s) => s.total_paise), profit_paise: Math.round(profit(today)), bills: today.length },
    last_30_days: { sales_paise: sum(month, (s) => s.total_paise), profit_paise: Math.round(profit(month)) },
    stock_value_paise: sum(stock, (s) => s.stock_value_paise),
    khata_outstanding_paise: sum(khataBalances(db).filter((k) => k.business_id === bid && k.balance_paise > 0), (k) => k.balance_paise),
    wastage_30d_paise: sum(db.wastage_log.filter((w) => w.business_id === bid && dayOf(w.logged_at) >= daysFrom(TODAY, -29)), (w) => w.cost_paise),
    open_alerts: db.alerts.filter((a) => a.business_id === bid && a.status === "open").length,
    low_stock: reorderSuggestions(db, bid).slice(0, 6),
    expiring_soon: exp.slice(0, 6),
    top_products_30d: Object.values(byProd).sort((a, b) => b.sales_paise - a.sales_paise).slice(0, 6).map((r) => ({ ...r, profit_paise: Math.round(r.profit_paise) })),
  };
}

export function profitReport(db, bid, from, to) {
  const ss = salesBetween(db, bid, from, to);
  const ids = new Set(ss.map((s) => s.id));
  const items = db.sale_items.filter((x) => ids.has(x.sale_id));
  const revenue = sum(ss, (s) => s.subtotal_paise), cogs = sum(ss, (s) => s.cogs_paise);
  const wastage = sum(db.wastage_log.filter((w) => w.business_id === bid && dayOf(w.logged_at) >= from && dayOf(w.logged_at) <= to), (w) => w.cost_paise);
  const days = {};
  for (const s of ss) {
    const d = (days[dayOf(s.sold_at)] ??= { day: dayOf(s.sold_at), revenue_paise: 0, profit_paise: 0 });
    d.revenue_paise += s.subtotal_paise;
    d.profit_paise += s.subtotal_paise - s.cogs_paise;
  }
  const prods = {};
  for (const si of items) {
    const r = (prods[si.product_id] ??= { name: db.products.find((p) => p.id === si.product_id).name, qty: 0, revenue_paise: 0, profit_paise: 0 });
    r.qty += si.qty;
    r.revenue_paise += si.line_total_paise - si.tax_paise;
    r.profit_paise += si.line_total_paise - si.tax_paise - si.cogs_paise;
  }
  const channels = {};
  for (const s of ss) { const c = (channels[s.channel] ??= { channel: s.channel, bills: 0, total_paise: 0 }); c.bills++; c.total_paise += s.total_paise; }
  const net = revenue - cogs - wastage;
  return {
    gross_sales_paise: sum(ss, (s) => s.total_paise), revenue_paise: Math.round(revenue), cogs_paise: Math.round(cogs), wastage_paise: wastage,
    net_profit_paise: Math.round(net), margin_pct: revenue ? round((net / revenue) * 100, 1) : 0, bills: ss.length,
    days: Object.values(days).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, revenue_paise: Math.round(d.revenue_paise), profit_paise: Math.round(d.profit_paise) })),
    products: Object.values(prods).sort((a, b) => b.profit_paise - a.profit_paise)
      .map((r) => ({ ...r, revenue_paise: Math.round(r.revenue_paise), profit_paise: Math.round(r.profit_paise), margin_pct: r.revenue_paise ? round((r.profit_paise / r.revenue_paise) * 100, 1) : 0 })),
    channels: Object.values(channels),
  };
}

export function gstReport(db, bid, from, to) {
  const biz = db.businesses.find((b) => b.id === bid);
  const ids = new Set(salesBetween(db, bid, from, to).map((s) => s.id));
  const byRate = (rows, taxable, tax) => {
    const m = {};
    for (const r of rows) { const x = (m[r.gst_rate] ??= { gst_rate: r.gst_rate, taxable_paise: 0, tax_paise: 0 }); x.taxable_paise += taxable(r); x.tax_paise += tax(r); }
    return Object.values(m).sort((a, b) => a.gst_rate - b.gst_rate).map((x) => ({ ...x, taxable_paise: Math.round(x.taxable_paise), tax_paise: Math.round(x.tax_paise),
      cgst_paise: Math.round(x.tax_paise / 2), sgst_paise: Math.round(x.tax_paise / 2) }));
  };
  const out = db.sale_items.filter((x) => ids.has(x.sale_id));
  const purchases = new Set(db.purchases.filter((p) => p.business_id === bid && p.invoice_date >= from && p.invoice_date <= to).map((p) => p.id));
  const inn = db.purchase_items.filter((x) => purchases.has(x.purchase_id));
  const outward = byRate(out, (r) => r.line_total_paise - r.tax_paise, (r) => r.tax_paise);
  const inward = byRate(inn, (r) => r.unit_cost_paise * r.qty, (r) => r.tax_paise);
  const hsn = {};
  for (const si of out) {
    const p = db.products.find((x) => x.id === si.product_id);
    const k = `${p.hsn_code}|${si.gst_rate}|${p.unit}`;
    const x = (hsn[k] ??= { hsn: p.hsn_code ?? "-", unit: p.unit, gst_rate: si.gst_rate, qty: 0, taxable_paise: 0, tax_paise: 0 });
    x.qty += si.qty; x.taxable_paise += si.line_total_paise - si.tax_paise; x.tax_paise += si.tax_paise;
  }
  const outTax = sum(outward, (x) => x.tax_paise), itc = sum(inward, (x) => x.tax_paise);
  return {
    from, to, business: { name: biz.name, gstin: biz.gstin }, outward, inward,
    hsn_summary: Object.values(hsn).sort((a, b) => b.taxable_paise - a.taxable_paise).map((x) => ({ ...x, qty: round(x.qty), taxable_paise: Math.round(x.taxable_paise), tax_paise: Math.round(x.tax_paise) })),
    output_tax_paise: outTax, input_tax_credit_paise: itc, net_payable_paise: Math.max(0, outTax - itc), itc_carry_forward_paise: Math.max(0, itc - outTax),
  };
}

export function deadStock(db, bid, days = 30) {
  const usage = dailyUsage(db).filter((u) => u.business_id === bid);
  return productStock(db).filter((s) => s.business_id === bid && s.kind !== "dish" && s.is_active && s.on_hand > 0).map((s) => {
    const last = usage.filter((u) => u.product_id === s.product_id).map((u) => u.day).sort().at(-1) ?? null;
    const firstIn = db.stock_batches.filter((b) => b.product_id === s.product_id).map((b) => dayOf(b.received_at)).sort()[0];
    const idle = Math.round((Date.parse(TODAY) - Date.parse(last ?? firstIn ?? TODAY)) / 864e5);
    return { product_id: s.product_id, name: s.name, unit: s.unit, on_hand: s.on_hand, stock_value_paise: s.stock_value_paise, last_used: last, days_unsold: idle,
      suggested_discount: idle >= 90 ? "30-50% or return to supplier" : idle >= 60 ? "20-30%" : "10-15%" };
  }).filter((r) => r.days_unsold >= days).sort((a, b) => b.stock_value_paise - a.stock_value_paise);
}

export function perishableRisk(db, bid) {
  const usage = dailyUsage(db).filter((u) => u.business_id === bid);
  const out = [];
  for (const s of productStock(db).filter((x) => x.business_id === bid && x.kind !== "dish" && x.is_active && x.on_hand > 0)) {
    const batches = db.stock_batches.filter((b) => b.product_id === s.product_id && b.qty_remaining > 0 && b.expiry_date && b.expiry_date >= TODAY)
      .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.received_at.localeCompare(b.received_at));
    if (!batches.length) continue;
    const avg = sum(usage.filter((u) => u.product_id === s.product_id && u.day > daysFrom(TODAY, -28) && u.day <= TODAY), (u) => u.qty) / 28;
    const fc = db.forecasts.filter((f) => f.product_id === s.product_id && f.forecast_date > TODAY);
    let used = 0;
    for (const b of batches) {
      const inWindow = fc.filter((f) => f.forecast_date <= b.expiry_date);
      const days = Math.round((Date.parse(b.expiry_date) - Date.parse(TODAY)) / 864e5);
      const demand = avg + sum(inWindow, (f) => f.yhat) + avg * Math.max(days - inWindow.length, 0);
      const take = Math.min(b.qty_remaining, Math.max(demand - used, 0));
      used += take;
      if (b.qty_remaining - take > 0.001 || days <= 2) {
        out.push({ product_id: s.product_id, name: s.name, unit: s.unit, batch_id: b.id, batch_no: b.batch_no, qty_remaining: b.qty_remaining, expiry_date: b.expiry_date,
          days_left: days, use_before_expiry: round(take), at_risk_qty: round(b.qty_remaining - take), at_risk_value_paise: Math.round((b.qty_remaining - take) * b.unit_cost_paise),
          basis: fc.length ? "forecast" : "28-day average" });
      }
    }
  }
  return out.sort((a, b) => a.days_left - b.days_left || b.at_risk_value_paise - a.at_risk_value_paise);
}

export function prepList(db, bid, day = TODAY) {
  const sales = dailyProductSales(db).filter((r) => r.business_id === bid);
  const dow = (d) => new Date(d + "T00:00:00Z").getUTCDay();
  return db.products.filter((p) => p.business_id === bid && p.kind === "dish" && p.is_active).map((d) => {
    const f = db.forecasts.find((x) => x.product_id === d.id && x.forecast_date === day);
    const same = sales.filter((r) => r.product_id === d.id && r.day < day && r.day >= daysFrom(day, -28) && dow(r.day) === dow(day));
    const expected = f ? f.yhat : sum(same, (r) => r.qty) / 4;
    const waste = sum(db.wastage_log.filter((w) => w.product_id === d.id && dayOf(w.logged_at) >= daysFrom(day, -14) && dayOf(w.logged_at) < day), (w) => w.qty) / 14;
    return { dish_id: d.id, name: d.name, expected: round(expected, 1), avg_daily_wastage: round(waste, 2),
      prep_qty: Math.max(0, Math.ceil(expected - Math.min(waste, 0.3 * expected) - 1e-6)), basis: f ? "forecast" : "same weekday, last 4 weeks" };
  }).sort((a, b) => b.prep_qty - a.prep_qty || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- write RPCs
/** Take qty out of batches, earliest expiry first; returns { cogs_paise, short_qty }. */
function consume(db, product, qty) {
  let left = qty, cost = 0;
  const batches = db.stock_batches.filter((b) => b.product_id === product.id && b.qty_remaining > 0)
    .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999") || a.received_at.localeCompare(b.received_at));
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(b.qty_remaining, left);
    b.qty_remaining = round(b.qty_remaining - take);
    cost += take * b.unit_cost_paise;
    left -= take;
  }
  cost += left * (product.cost_price_paise ?? 0);
  return { cogs_paise: Math.round(cost), short_qty: round(left) };
}

export function recordSale(db, bid, { p_items, p_payment_mode = "cash", p_channel = "counter", p_khata_customer }) {
  const sale = { id: newId("sa"), business_id: bid, sold_at: new Date().toISOString(), channel: p_channel, payment_mode: p_payment_mode, subtotal_paise: 0, tax_paise: 0, total_paise: 0, cogs_paise: 0 };
  const shortages = [];
  for (const it of p_items) {
    const p = db.products.find((x) => x.id === it.product_id);
    const price = it.unit_price_paise ?? p.sell_price_paise ?? 0;
    const line = Math.round(price * it.qty);
    const tax = Math.round(line - exGst(line, p.gst_rate));
    let cogs = 0;
    const r = db.recipes.find((x) => x.dish_product_id === p.id);
    if (r) {
      for (const ri of db.recipe_ingredients.filter((x) => x.recipe_id === r.id)) {
        const c = consume(db, db.products.find((x) => x.id === ri.ingredient_product_id), (it.qty * ri.qty) / r.yield_qty);
        cogs += c.cogs_paise;
        if (c.short_qty > 0) shortages.push({ product_id: ri.ingredient_product_id, short_qty: c.short_qty });
      }
    } else if (p.kind !== "dish") {
      const c = consume(db, p, it.qty);
      cogs = c.cogs_paise;
      if (c.short_qty > 0) shortages.push({ product_id: p.id, short_qty: c.short_qty });
    }
    db.sale_items.push({ id: newId("si"), business_id: bid, sale_id: sale.id, product_id: p.id, qty: it.qty, unit_price_paise: price, gst_rate: p.gst_rate, line_total_paise: line, tax_paise: tax, cogs_paise: cogs, short_qty: 0 });
    sale.total_paise += line; sale.tax_paise += tax; sale.subtotal_paise += line - tax; sale.cogs_paise += cogs;
  }
  db.sales.push(sale);
  if (p_payment_mode === "credit" && p_khata_customer) khataAdd(db, bid, { p_customer: p_khata_customer, p_kind: "credit", p_amount_paise: sale.total_paise, p_note: "sale" });
  refreshAlerts(db, bid);
  return { sale_id: sale.id, total_paise: sale.total_paise, profit_paise: sale.subtotal_paise - sale.cogs_paise, shortages };
}

export function recordPurchase(db, bid, { p_purchase, p_items }) {
  let supplier = db.suppliers.find((s) => s.business_id === bid && (s.id === p_purchase.supplier_id || (p_purchase.supplier_name && s.name.toLowerCase() === p_purchase.supplier_name.trim().toLowerCase())));
  if (!supplier && p_purchase.supplier_name) {
    supplier = { id: newId("s"), business_id: bid, name: p_purchase.supplier_name.trim(), gstin: p_purchase.supplier_gstin ?? null, phone: null, lead_time_days: 2 };
    db.suppliers.push(supplier);
  }
  const isRest = db.businesses.find((b) => b.id === bid).business_type === "restaurant";
  const pur = { id: newId("pu"), business_id: bid, supplier_id: supplier?.id ?? null, invoice_no: p_purchase.invoice_no ?? null, invoice_date: p_purchase.invoice_date ?? TODAY,
    source: p_purchase.source ?? "manual", total_paise: 0, tax_paise: 0, created_at: new Date().toISOString() };
  let created = 0;
  for (const it of p_items) {
    let p = db.products.find((x) => x.id === it.product_id) ?? db.products.find((x) => x.business_id === bid && x.name.toLowerCase() === (it.name ?? "").trim().toLowerCase());
    if (!p) {
      p = { id: newId("p"), business_id: bid, kind: isRest ? "ingredient" : "product", name: it.name.trim(), category: null, unit: it.unit ?? "pcs", barcode: null, hsn_code: it.hsn_code ?? null,
        gst_rate: it.gst_rate ?? 0, sell_price_paise: null, mrp_paise: null, cost_price_paise: it.unit_cost_paise, reorder_level: null, reorder_qty: null, preferred_supplier_id: supplier?.id ?? null, is_active: true };
      db.products.push(p);
      created++;
    }
    p.cost_price_paise = it.unit_cost_paise || p.cost_price_paise;
    const rate = it.gst_rate ?? p.gst_rate;
    const tax = Math.round(it.unit_cost_paise * it.qty * rate / 100);
    const pi = { id: newId("pi"), business_id: bid, purchase_id: pur.id, product_id: p.id, qty: it.qty, unit_cost_paise: it.unit_cost_paise, gst_rate: rate, tax_paise: tax };
    db.purchase_items.push(pi);
    db.stock_batches.push({ id: newId("sb"), business_id: bid, product_id: p.id, purchase_item_id: pi.id, batch_no: it.batch_no ?? null, qty_received: it.qty, qty_remaining: it.qty,
      unit_cost_paise: it.unit_cost_paise, expiry_date: it.expiry_date ?? null, received_at: new Date().toISOString() });
    if (supplier) {
      const sp = db.supplier_prices.find((x) => x.supplier_id === supplier.id && x.product_id === p.id);
      if (sp) { sp.price_paise = it.unit_cost_paise; sp.updated_at = TODAY; } else db.supplier_prices.push({ supplier_id: supplier.id, business_id: bid, product_id: p.id, price_paise: it.unit_cost_paise, updated_at: TODAY });
    }
    pur.total_paise += it.unit_cost_paise * it.qty + tax;
    pur.tax_paise += tax;
  }
  db.purchases.push(pur);
  refreshAlerts(db, bid);
  return { purchase_id: pur.id, total_paise: pur.total_paise, products_created: created };
}

export function adjustStock(db, bid, { p_product_id, p_counted_qty, p_expiry_date }) {
  const p = db.products.find((x) => x.id === p_product_id);
  const prev = round(sum(db.stock_batches.filter((b) => b.product_id === p.id), (b) => b.qty_remaining));
  if (p_counted_qty < prev) consume(db, p, prev - p_counted_qty);
  else if (p_counted_qty > prev) db.stock_batches.push({ id: newId("sb"), business_id: bid, product_id: p.id, purchase_item_id: null, batch_no: "count", qty_received: p_counted_qty - prev,
    qty_remaining: p_counted_qty - prev, unit_cost_paise: p.cost_price_paise ?? 0, expiry_date: p_expiry_date ?? null, received_at: new Date().toISOString() });
  refreshAlerts(db, bid);
  return { previous_qty: prev, new_qty: p_counted_qty };
}

export function logWastage(db, bid, { p_product_id, p_qty, p_reason, p_note }) {
  const p = db.products.find((x) => x.id === p_product_id);
  const c = p.kind === "dish" ? { cogs_paise: Math.round(dishCost(db, p) * p_qty), short_qty: 0 } : consume(db, p, p_qty);
  const w = { id: newId("w"), business_id: bid, product_id: p.id, qty: p_qty, reason: p_reason, cost_paise: c.cogs_paise, note: p_note, logged_at: new Date().toISOString() };
  db.wastage_log.push(w);
  refreshAlerts(db, bid);
  return { wastage_id: w.id, cost_paise: c.cogs_paise, short_qty: c.short_qty };
}

export function khataAdd(db, bid, { p_customer, p_kind, p_amount_paise, p_note, p_phone }) {
  let c = db.khata_customers.find((x) => x.business_id === bid && x.name.toLowerCase() === p_customer.trim().toLowerCase());
  if (!c) { c = { id: newId("kc"), business_id: bid, name: p_customer.trim(), phone: p_phone ?? null }; db.khata_customers.push(c); }
  db.khata_entries.push({ id: newId("ke"), business_id: bid, customer_id: c.id, kind: p_kind, amount_paise: p_amount_paise, note: p_note ?? null, created_at: new Date().toISOString() });
  return { customer_id: c.id, balance_paise: khataBalances(db).find((k) => k.customer_id === c.id).balance_paise };
}

export function createDraftPOs(db, bid) {
  const bySupplier = {};
  for (const r of reorderSuggestions(db, bid)) (bySupplier[r.supplier_id ?? "none"] ??= []).push(r);
  let orders = 0, lines = 0;
  for (const [sid, rows] of Object.entries(bySupplier)) {
    const po = { id: newId("po"), business_id: bid, supplier_id: sid === "none" ? null : sid, status: "draft", total_paise: 0, created_at: new Date().toISOString() };
    for (const r of rows) {
      db.purchase_order_items.push({ id: newId("poi"), business_id: bid, po_id: po.id, product_id: r.product_id, qty: r.suggested_qty, unit_cost_paise: r.unit_cost_paise ?? 0 });
      po.total_paise += Math.round((r.unit_cost_paise ?? 0) * r.suggested_qty);
      lines++;
    }
    db.purchase_orders.push(po);
    orders++;
  }
  return { orders_created: orders, lines };
}

export function receivePO(db, { p_po_id }) {
  const po = db.purchase_orders.find((x) => x.id === p_po_id);
  const items = db.purchase_order_items.filter((x) => x.po_id === po.id);
  const res = recordPurchase(db, po.business_id, { p_purchase: { supplier_id: po.supplier_id, source: "purchase_order" },
    p_items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, unit_cost_paise: i.unit_cost_paise })) });
  po.status = "received";
  return res;
}
