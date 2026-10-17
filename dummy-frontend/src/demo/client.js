// OFFLINE DEMO ONLY — an in-browser stand-in for the supabase-js client, so every page works
// with sample data and no backend. Enabled by VITE_DEMO_MODE=offline (see src/lib/api.js).
// To go back to the real backend: delete src/demo/ and the demo lines in src/lib/api.js.
import { daysFrom } from "../lib/format.js";
import { TODAY, USERS, buildDb, newId } from "./data.js";
import * as L from "./logic.js";

const db = buildDb();
L.buildForecasts(db);
L.buildBundles(db);
L.buildEvaluations(db);
L.buildAlerts(db);

const prod = (id) => db.products.find((p) => p.id === id);
const pick = (o, keys) => (o ? Object.fromEntries(keys.map((k) => [k, o[k]])) : null);

// ---------------------------------------------------------------- tables, views and embedded relations
const VIEWS = {
  product_stock: () => L.productStock(db),
  daily_usage: () => L.dailyUsage(db),
  daily_product_sales: () => L.dailyProductSales(db),
  khata_balances: () => L.khataBalances(db),
};
const ID_KEY = { product_stock: "product_id", khata_balances: "customer_id" };
// Joins the pages request in select(); attached only when the select string names them.
const EMBEDS = {
  staff_roles: { businesses: (r) => db.businesses.find((b) => b.id === r.business_id) },
  purchases: {
    suppliers: (r) => pick(db.suppliers.find((s) => s.id === r.supplier_id), ["name", "phone"]),
    purchase_items: (r) => [{ count: db.purchase_items.filter((i) => i.purchase_id === r.id).length }],
  },
  purchase_orders: {
    suppliers: (r) => pick(db.suppliers.find((s) => s.id === r.supplier_id), ["name", "phone"]),
    purchase_order_items: (r) => db.purchase_order_items.filter((i) => i.po_id === r.id).map((i) => ({ ...i, products: pick(prod(i.product_id), ["name", "unit"]) })),
  },
  suppliers: { supplier_prices: (r) => db.supplier_prices.filter((x) => x.supplier_id === r.id).map((x) => ({ ...x, products: pick(prod(x.product_id), ["name", "unit"]) })) },
  wastage_log: { products: (r) => pick(prod(r.product_id), ["name", "unit"]) },
  recipes: { recipe_ingredients: (r) => db.recipe_ingredients.filter((x) => x.recipe_id === r.id) },
};
const rowsOf = (table) => (VIEWS[table] ? VIEWS[table]() : (db[table] ??= []));

function shape(table, row, select) {
  const out = { ...row };
  delete out._spec;
  delete out._day;
  for (const [name, fn] of Object.entries(EMBEDS[table] ?? {})) if (select.includes(name + "(")) out[name] = fn(row);
  return out;
}

/** Chainable, awaitable query builder covering the PostgREST features the pages use. */
class Query {
  constructor(table) { Object.assign(this, { table, filters: [], select_: "*", op: "select", orders: [], limit_: null, single_: null, payload: null, returning: false }); }
  select(cols = "*") { if (this.op === "select") this.select_ = cols; else this.returning = true; return this; }
  eq(c, v) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.filters.push((r) => String(r[c]) !== String(v)); return this; }
  gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  in(c, vs) { this.filters.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  not(c, op, v) { this.filters.push((r) => (op === "is" && v === null ? r[c] != null : String(r[c]) !== String(v))); return this; }
  order(c, { ascending = true } = {}) { this.orders.push([c, ascending]); return this; }
  limit(n) { this.limit_ = n; return this; }
  range(a, b) { this.range_ = [a, b]; return this; }
  single() { this.single_ = "single"; return this; }
  maybeSingle() { this.single_ = "maybe"; return this; }
  insert(rows) { this.op = "insert"; this.payload = rows; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  upsert(rows, { onConflict } = {}) { this.op = "upsert"; this.payload = rows; this.conflict = onConflict?.split(","); return this; }
  delete() { this.op = "delete"; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  run() {
    const t = this.table;
    const match = (r) => this.filters.every((f) => f(r));
    let rows;
    if (this.op === "insert" || this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({ ...r }));
      rows = [];
      for (const r of list) {
        const existing = this.op === "upsert" && this.conflict && db[t].find((x) => this.conflict.every((k) => String(x[k]) === String(r[k])));
        if (existing) { Object.assign(existing, r); rows.push(existing); continue; }
        const row = { id: newId(t.slice(0, 3)), created_at: new Date().toISOString(), ...defaults(t), ...r };
        db[t].push(row);
        rows.push(row);
      }
      return this.finish(rows, !this.returning && !this.single_);
    }
    if (this.op === "update") {
      rows = db[t].filter(match);
      rows.forEach((r) => Object.assign(r, this.payload));
      return this.finish(rows, !this.returning && !this.single_);
    }
    if (this.op === "delete") {
      db[t] = db[t].filter((r) => !match(r));
      return { data: null, error: null };
    }
    rows = rowsOf(t).filter(match);
    for (const [c, asc] of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => (a[c] == null) - (b[c] == null) || (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.range_) rows = rows.slice(this.range_[0], this.range_[1] + 1);
    if (this.limit_ != null) rows = rows.slice(0, this.limit_);
    return this.finish(rows);
  }

  finish(rows, minimal = false) {
    if (minimal) return { data: null, error: null };
    const data = rows.map((r) => shape(this.table, r, this.select_));
    if (this.single_ === "single") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "Row not found" } };
    if (this.single_ === "maybe") return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }
}

function defaults(table) {
  if (table === "products") return { is_active: true, kind: "product", gst_rate: 0, unit: "pcs" };
  if (table === "reviews") return { sentiment: null, topics: [], reviewed_at: TODAY };
  if (table === "wholesaler_listings") return { is_active: true, embedding: null };
  if (table === "recipes") return { yield_qty: 1 };
  return {};
}

// ---------------------------------------------------------------- RPCs
const RPC = {
  dashboard: (a) => L.dashboard(db, a.p_business_id),
  reorder_suggestions: (a) => L.reorderSuggestions(db, a.p_business_id),
  profit_report: (a) => L.profitReport(db, a.p_business_id, a.p_from, a.p_to),
  gst_report: (a) => L.gstReport(db, a.p_business_id, a.p_from, a.p_to),
  dead_stock: (a) => L.deadStock(db, a.p_business_id, a.p_days ?? 30),
  perishable_risk: (a) => L.perishableRisk(db, a.p_business_id),
  prep_list: (a) => L.prepList(db, a.p_business_id, a.p_day ?? TODAY),
  record_sale: (a) => L.recordSale(db, a.p_business_id, a),
  record_purchase: (a) => L.recordPurchase(db, a.p_business_id, a),
  adjust_stock: (a) => L.adjustStock(db, a.p_business_id, a),
  log_wastage: (a) => L.logWastage(db, a.p_business_id, a),
  khata_add: (a) => L.khataAdd(db, a.p_business_id, a),
  create_draft_purchase_orders: (a) => L.createDraftPOs(db, a.p_business_id),
  receive_purchase_order: (a) => L.receivePO(db, a),
  refresh_alerts: (a) => L.refreshAlerts(db, a.p_business_id),
  create_telegram_link_code: () => String(100000 + Math.floor(Math.random() * 900000)),
  add_staff: () => { throw new Error("Adding staff needs the real backend (offline demo)."); },
  create_business: () => { throw new Error("Creating businesses needs the real backend (offline demo)."); },
};

// ---------------------------------------------------------------- Edge Functions (simplified, rule-based)
let scans = 0;
const words = (s) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, " ").split(/\s+/).filter(Boolean);
function matchProduct(bid, text) {
  const ws = words(text);
  let best = null, score = 0;
  for (const p of db.products.filter((x) => x.business_id === bid && x.is_active)) {
    const pw = words(p.name.replace("-", ""));
    const hit = ws.filter((w) => w.length > 1 && pw.some((x) => x.startsWith(w) || w.startsWith(x))).length;
    if (hit > score) { best = p; score = hit; }
  }
  return best;
}

const FUNCTIONS = {
  "scan-bill": ({ business_id }) => {
    // Alternate engines so both badges can be shown: Gemini first, then the offline OCR fallback.
    const engine = scans++ % 2 === 0 ? "gemini" : "ocr";
    const lines = [["Parle-G Biscuit 80g", "PARLE G 80G", 96, 8.2, 18], ["Maggi Masala Noodles 70g", "MAGGI MASALA 70G", 48, 11.5, 12],
      ["Haldiram Aloo Bhujia 200g", "HALDIRAM BHUJIA 200G", 20, 45, 12], [null, "PARLE MONACO 63G", 24, 9, 18]];
    const items = lines.map(([catalog, name, qty, rate, gst]) => {
      const p = catalog && db.products.find((x) => x.business_id === business_id && x.name === catalog);
      return { name, product_id: p?.id ?? null, matched_name: p?.name ?? "Parle-G Biscuit 80g", match_similarity: p ? 0.82 : 0.38, qty, unit: "pack",
        unit_cost_paise: Math.round(rate * 100), gst_rate: gst, mrp_paise: null, hsn_code: "1905", batch_no: null, expiry_date: daysFrom(TODAY, 180) };
    });
    const computed = items.reduce((s, i) => s + Math.round(i.unit_cost_paise * i.qty * (1 + i.gst_rate / 100)), 0);
    const warnings = ["Line 4 (PARLE MONACO 63G): not in your catalog yet; it will be added as a new item.",
      `Items add up to ₹${(computed / 100).toFixed(2)} but the bill total is ₹${((computed + 21000) / 100).toFixed(2)}. Some lines may be missing.`];
    if (engine === "ocr") warnings.unshift("Read by offline OCR. Please check every line.");
    return { ok: true, engine, cached: false, warnings, draft: {
      purchase: { supplier_name: "Gupta Distributors", supplier_gstin: "27AAPFU0939F1ZV", invoice_no: "GD-" + (2240 + scans), invoice_date: TODAY, source: "bill_scan", bill_image_path: null },
      items, computed_total_paise: computed, printed_total_paise: computed + 21000 } };
  },

  "voice-command": (body) => {
    const bid = body.business_id;
    if (body.confirm) {
      const d = body.draft;
      if (d.kind === "sale") L.recordSale(db, bid, { p_items: [{ product_id: d.product_id, qty: d.qty }], p_payment_mode: "cash", p_channel: "telegram" });
      if (d.kind === "stock") L.recordPurchase(db, bid, { p_purchase: { source: "voice" }, p_items: [{ product_id: d.product_id, qty: d.qty, unit_cost_paise: prod(d.product_id).cost_price_paise ?? 0 }] });
      if (d.kind === "khata") L.khataAdd(db, bid, { p_customer: d.customer, p_kind: "credit", p_amount_paise: d.amount_paise });
      return { ok: true, reply: "Ho gaya ✅" };
    }
    const transcript = body.text ?? "20 packet Parle-G add karo";
    const t = transcript.toLowerCase();
    const num = Number((t.match(/\d+(\.\d+)?/) ?? [])[0]);
    const base = { ok: true, transcript: body.text ? undefined : transcript + " (sample voice note)", ai: false };
    if (/udhaar|udhar|credit/.test(t) && num) {
      const customer = transcript.replace(/\d+.*$/, "").trim() || "Customer";
      return { ...base, intent: "khata", needs_confirmation: true, draft: { kind: "khata", customer, amount_paise: num * 100 }, reply: `${customer} ke khate mein ₹${num} udhaar likhun?` };
    }
    const p = matchProduct(bid, t);
    if (p && num && /(aaya|aayi|add|stock|mila|received)/.test(t)) {
      return { ...base, intent: "add_stock", needs_confirmation: true, draft: { kind: "stock", product_id: p.id, qty: num }, reply: `${num} ${p.unit} ${p.name} stock mein add karun?` };
    }
    if (p && num && /(becha|bechi|bik|sold|sale)/.test(t)) {
      return { ...base, intent: "record_sale", needs_confirmation: true, draft: { kind: "sale", product_id: p.id, qty: num }, reply: `${num} ${p.unit} ${p.name} ki sale likhun?` };
    }
    if (p) {
      const s = L.productStock(db).find((x) => x.product_id === p.id);
      return { ...base, intent: "question", needs_confirmation: false, reply: `${p.name}: ${s.on_hand} ${p.unit} stock mein hai.` };
    }
    const d = L.dashboard(db, bid);
    return { ...base, intent: "question", needs_confirmation: false, reply: `Aaj ki sale ₹${(d.today.sales_paise / 100).toLocaleString("en-IN")} (${d.today.bills} bills), profit ₹${(d.today.profit_paise / 100).toLocaleString("en-IN")}.` };
  },

  assistant: ({ business_id }) => {
    const d = L.dashboard(db, business_id);
    const r = L.reorderSuggestions(db, business_id).slice(0, 3).map((x) => x.name).join(", ");
    return { ai: false, answer: `Today: ₹${(d.today.sales_paise / 100).toLocaleString("en-IN")} sales from ${d.today.bills} bills, profit ₹${(d.today.profit_paise / 100).toLocaleString("en-IN")}. ` +
      `Last 30 days: ₹${(d.last_30_days.sales_paise / 100).toLocaleString("en-IN")}.${r ? ` Reorder soon: ${r}.` : ""}` };
  },

  "product-search": ({ text = "" }) => {
    const ws = words(text);
    const results = db.wholesaler_listings.filter((l) => l.is_active).map((l) => {
      const lw = words(l.name);
      const sim = ws.length ? ws.filter((w) => lw.some((x) => x.startsWith(w))).length / ws.length : 0.5;
      return { ...l, similarity: sim, wholesaler_name: "Pune Wholesale Mart", city: "Pune" };
    }).filter((r) => r.similarity > 0).sort((a, b) => b.similarity - a.similarity).slice(0, 8);
    return { method: text ? "text" : "photo (sample)", results };
  },

  "import-orders-csv": ({ csv_text = "", commit }) => {
    const n = Math.max(0, csv_text.trim().split("\n").length - 1);
    return { orders_found: n, orders_ready: n, skipped_cancelled: 0, columns: { order_id: "Order ID", items: "Items", total: "Total" },
      unmatched_items: [], result: commit ? { imported: n, duplicates: 0, errors: [] } : null };
  },
};

// ---------------------------------------------------------------- client
let session = null;
const authListeners = new Set();

export function createDemoClient() {
  return {
    from: (table) => new Query(table),
    rpc: async (name, args = {}) => {
      try {
        if (!RPC[name]) throw new Error(`${name} is not available in the offline demo`);
        return { data: structuredClone(RPC[name](args)), error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
    functions: {
      invoke: async (name, { body } = {}) => {
        await new Promise((r) => setTimeout(r, 450)); // feel like a network call
        try {
          if (!FUNCTIONS[name]) throw new Error(`${name} is not available in the offline demo`);
          return { data: FUNCTIONS[name](body ?? {}), error: null };
        } catch (e) {
          return { data: null, error: { message: e.message, context: { json: async () => ({ error: e.message }) } } };
        }
      },
    },
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithPassword: async ({ email }) => {
        const user = USERS[email];
        if (!user) return { data: {}, error: { message: "Unknown demo account" } };
        session = { user, access_token: "demo" };
        authListeners.forEach((f) => f("SIGNED_IN", session));
        return { data: { session }, error: null };
      },
      signOut: async () => { session = null; return { error: null }; },
      onAuthStateChange: (f) => { authListeners.add(f); return { data: { subscription: { unsubscribe: () => authListeners.delete(f) } } }; },
    },
    storage: { from: () => ({ upload: async (path) => ({ data: { path }, error: null }) }) },
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel: () => {},
  };
}
