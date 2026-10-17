// OFFLINE DEMO ONLY — sample data for the in-browser stand-in backend (see ./client.js).
// Delete the whole src/demo/ folder to go back to the real Supabase backend.
//
// Generates ~90 days of sales history for a kirana shop, a restaurant and a wholesaler,
// deterministically (fixed seed) and relative to today, so the demo always looks current.

import { daysFrom, istToday } from "../lib/format.js";

export const TODAY = istToday();

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261017);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
/** Noisy count around mu (gamma-ish), never negative. */
const draw = (mu) => (mu <= 0 ? 0 : Math.max(0, Math.round(mu + (rand() + rand() + rand() - 1.5) * Math.sqrt(mu) * 1.3)));
const uid = (() => { let n = 0; return (p) => `${p}-${(++n).toString(36).padStart(5, "0")}`; })();
const paise = (rupees) => Math.round(rupees * 100);

// Diwali 2026 is 8 Nov: shopping ramps up over the 10 days before.
const DIWALI = "2026-11-08";
function festival(day, sens) {
  if (!sens) return 1;
  const k = (Date.parse(day) - Date.parse(DIWALI)) / 864e5;
  if (k < -10 || k > 2) return 1;
  const shape = k < 0 ? (k + 11) / 10 : k === 0 ? 0.6 : 0.25;
  return 1 + (sens - 1) * shape;
}
const WEEKLY_SHOP = [1.12, 0.95, 0.92, 0.95, 0.97, 1.05, 1.18]; // Sun..Sat
const WEEKLY_REST = [1.3, 0.85, 0.82, 0.88, 0.92, 1.15, 1.35];
const dow = (day) => new Date(day + "T00:00:00Z").getUTCDay();

export const USERS = {
  "shop@demo.test": { id: "u-shop", email: "shop@demo.test" },
  "restaurant@demo.test": { id: "u-rest", email: "restaurant@demo.test" },
  "wholesale@demo.test": { id: "u-whole", email: "wholesale@demo.test" },
};

export function buildDb() {
  const db = {
    businesses: [
      { id: "b-shop", name: "Sharma Kirana Store", business_type: "shop", city: "Pune", gstin: "27ABCDE1234F1Z5", state_code: "27", language: "hinglish", lead_time_days: 2, expiry_alert_days: 7, phone: "919999900001" },
      { id: "b-rest", name: "Annapurna Bhojanalay", business_type: "restaurant", city: "Pune", gstin: "27PQRSX5678K1Z2", state_code: "27", language: "mr", lead_time_days: 2, expiry_alert_days: 3, phone: "919999900002" },
      { id: "b-whole", name: "Pune Wholesale Mart", business_type: "wholesaler", city: "Pune", gstin: "27WHOLE9012M1Z8", state_code: "27", language: "en", lead_time_days: 1, expiry_alert_days: 7, phone: "919999900003" },
    ],
    staff_roles: [
      { business_id: "b-shop", user_id: "u-shop", role: "owner", created_at: daysFrom(TODAY, -200) + "T10:00:00+05:30" },
      { business_id: "b-rest", user_id: "u-rest", role: "owner", created_at: daysFrom(TODAY, -200) + "T10:00:00+05:30" },
      { business_id: "b-whole", user_id: "u-whole", role: "owner", created_at: daysFrom(TODAY, -200) + "T10:00:00+05:30" },
    ],
    suppliers: [], supplier_prices: [], products: [], stock_batches: [], sales: [], sale_items: [],
    purchases: [], purchase_items: [], purchase_orders: [], purchase_order_items: [],
    recipes: [], recipe_ingredients: [], wastage_log: [], khata_customers: [], khata_entries: [],
    reviews: [], alerts: [], telegram_links: [], wholesaler_listings: [], forecasts: [], bundle_suggestions: [],
    forecast_evaluations: [],
  };
  const sup = (business_id, name, lead_time_days, phone) => {
    const s = { id: uid("s"), business_id, name, phone, gstin: null, lead_time_days, wholesaler_business_id: name.includes("Wholesale") ? "b-whole" : null };
    db.suppliers.push(s);
    return s;
  };
  const product = (business_id, kind, spec, supplier) => {
    const p = {
      id: uid("p"), business_id, kind, name: spec.name, category: spec.cat ?? null, unit: spec.unit, barcode: spec.barcode ?? null,
      hsn_code: spec.hsn ?? null, gst_rate: spec.gst ?? 0, sell_price_paise: spec.sell ? paise(spec.sell) : null,
      mrp_paise: spec.sell ? paise(spec.sell) : null, cost_price_paise: spec.cost ? paise(spec.cost) : null,
      reorder_level: null, reorder_qty: null, preferred_supplier_id: supplier?.id ?? null, is_active: true, embedding: null,
      _spec: spec,
    };
    db.products.push(p);
    if (supplier && spec.cost) db.supplier_prices.push({ supplier_id: supplier.id, business_id, product_id: p.id, price_paise: paise(spec.cost), updated_at: daysFrom(TODAY, -6) });
    return p;
  };
  const batch = (p, qty, expiryInDays, receivedDaysAgo = 3, batch_no = null) => db.stock_batches.push({
    id: uid("sb"), business_id: p.business_id, product_id: p.id, purchase_item_id: null, batch_no,
    qty_received: qty, qty_remaining: qty, unit_cost_paise: p.cost_price_paise ?? 0,
    expiry_date: expiryInDays == null ? null : daysFrom(TODAY, expiryInDays), received_at: daysFrom(TODAY, -receivedDaysAgo) + "T09:30:00+05:30",
  });

  // ------------------------------------------------------------ kirana shop
  const gupta = sup("b-shop", "Gupta Distributors", 2, "919822000111");
  const metro = sup("b-shop", "Metro Cash & Carry", 4, "919822000222");
  const dairy = sup("b-shop", "Amul Dairy Agent", 1, "919822000333");
  const pwm = sup("b-shop", "Pune Wholesale Mart", 1, "919999900003");
  const SHOP = [
    { name: "Parle-G Biscuit 80g", cat: "Biscuits", unit: "pack", gst: 18, sell: 10, cost: 8.2, base: 34, hsn: "1905", barcode: "8901719110016", shelf: 120, diwali: 1.4, sup: gupta, cover: 0.6 },
    { name: "Maggi Masala Noodles 70g", cat: "Instant food", unit: "pack", gst: 12, sell: 14, cost: 11.5, base: 26, hsn: "1902", barcode: "8901058000290", shelf: 240, diwali: 1.3, sup: gupta, cover: 0.7 },
    { name: "Amul Taaza Milk 500ml", cat: "Dairy", unit: "pack", gst: 0, sell: 27, cost: 24.5, base: 40, hsn: "0401", shelf: 2, sup: dairy, cover: 1.6 },
    { name: "Tata Salt 1kg", cat: "Staples", unit: "pack", gst: 0, sell: 28, cost: 23, base: 7, hsn: "2501", sup: metro, cover: 3 },
    { name: "Aashirvaad Atta 5kg", cat: "Staples", unit: "pcs", gst: 0, sell: 260, cost: 228, base: 4, hsn: "1101", sup: metro, cover: 2.5 },
    { name: "Fortune Sunflower Oil 1L", cat: "Edible oil", unit: "pcs", gst: 5, sell: 150, cost: 128, base: 7, hsn: "1512", diwali: 1.8, sup: metro, cover: 2 },
    { name: "Tata Tea Gold 250g", cat: "Beverages", unit: "pack", gst: 5, sell: 145, cost: 122, base: 6, hsn: "0902", diwali: 1.5, sup: gupta, cover: 2.5 },
    { name: "Sugar (loose)", cat: "Staples", unit: "kg", gst: 5, sell: 46, cost: 40, base: 10, hsn: "1701", diwali: 1.6, sup: metro, cover: 2.2 },
    { name: "Amul Butter 100g", cat: "Dairy", unit: "pcs", gst: 12, sell: 58, cost: 50, base: 7, hsn: "0405", shelf: 25, sup: dairy, cover: 2 },
    { name: "Britannia Bread 400g", cat: "Bakery", unit: "pcs", gst: 0, sell: 45, cost: 38, base: 12, hsn: "1905", shelf: 4, sup: gupta, cover: 3.2, expiry: 2 },
    { name: "Surf Excel Easy Wash 1kg", cat: "Household", unit: "pack", gst: 18, sell: 140, cost: 118, base: 3, hsn: "3402", sup: gupta, cover: 3 },
    { name: "Colgate Strong Teeth 100g", cat: "Personal care", unit: "pcs", gst: 18, sell: 60, cost: 49, base: 3, hsn: "3306", sup: gupta, cover: 3 },
    { name: "Haldiram Aloo Bhujia 200g", cat: "Snacks", unit: "pack", gst: 12, sell: 55, cost: 45, base: 5, hsn: "2106", shelf: 150, diwali: 2.4, sup: gupta, cover: 1.4 },
    { name: "Kissan Tomato Ketchup 500g", cat: "Condiments", unit: "pcs", gst: 12, sell: 120, cost: 98, base: 3, hsn: "2103", shelf: 300, sup: gupta, cover: 3 },
    { name: "Amul Ghee 1L", cat: "Dairy", unit: "pcs", gst: 12, sell: 650, cost: 545, base: 1.5, hsn: "0405", shelf: 180, diwali: 2.8, sup: pwm, cover: 2 },
    { name: "Kaju 250g", cat: "Dry fruits", unit: "pack", gst: 5, sell: 280, cost: 235, base: 1, hsn: "0801", diwali: 4.5, sup: pwm, cover: 3 },
    { name: "Cadbury Dairy Milk 50g", cat: "Chocolates", unit: "pcs", gst: 18, sell: 50, cost: 41, base: 5, hsn: "1806", shelf: 200, diwali: 2.3, sup: gupta, cover: 2.5 },
    { name: "Horlicks Kesar 500g", cat: "Beverages", unit: "pcs", gst: 18, sell: 290, cost: 250, base: 0.5, hsn: "1901", sup: gupta, stopDaysAgo: 75, stock: 9 },
    { name: "Sugar Free Gold 100 pellets", cat: "Health", unit: "box", gst: 18, sell: 180, cost: 150, base: 0.3, hsn: "2106", sup: gupta, stopDaysAgo: 40, stock: 6 },
    { name: "Mother Dairy Lassi 200ml", cat: "Dairy", unit: "pcs", gst: 12, sell: 25, cost: 20, base: 6, hsn: "0403", shelf: 10, sup: dairy, startDaysAgo: 10, cover: 2 },
  ];
  const shopProducts = SHOP.map((s) => product("b-shop", "product", s, s.sup));
  for (const p of shopProducts) {
    const s = p._spec;
    const qty = s.stock ?? Math.max(1, Math.round(s.base * s.sup.lead_time_days * s.cover * (s.unit === "kg" ? 1 : 1)));
    batch(p, qty, s.expiry ?? (s.shelf ? Math.min(s.shelf - 1, 3 + Math.floor(rand() * Math.max(1, s.shelf - 3))) : null), 2, s.shelf ? "B" + (100 + Math.floor(rand() * 900)) : null);
  }
  // A dairy batch expiring tomorrow (more than one day's sales): perishable-risk demo.
  batch(shopProducts[2], 30, 1, 1, "M-1017");

  const pairs = [["Britannia Bread 400g", "Amul Butter 100g", 0.65], ["Tata Tea Gold 250g", "Parle-G Biscuit 80g", 0.45],
    ["Maggi Masala Noodles 70g", "Kissan Tomato Ketchup 500g", 0.55], ["Kaju 250g", "Amul Ghee 1L", 0.5]];
  generateShopSales(db, shopProducts, pairs);

  // ------------------------------------------------------------ restaurant
  const shreeDairy = sup("b-rest", "Shree Dairy", 1, "919822000444");
  const mandi = sup("b-rest", "APMC Sabzi Mandi", 1, "919822000555");
  const metroR = sup("b-rest", "Metro Cash & Carry", 3, "919822000222");
  const ING = {
    Paneer: { unit: "kg", cost: 380, shelf: 3, sup: shreeDairy, cat: "Dairy" },
    Butter: { unit: "kg", cost: 520, shelf: 30, sup: shreeDairy, cat: "Dairy" },
    "Fresh Cream": { unit: "l", cost: 240, shelf: 5, sup: shreeDairy, cat: "Dairy" },
    Curd: { unit: "kg", cost: 80, shelf: 3, sup: shreeDairy, cat: "Dairy" },
    Khoya: { unit: "kg", cost: 400, shelf: 4, sup: shreeDairy, cat: "Dairy" },
    Tomato: { unit: "kg", cost: 40, shelf: 5, sup: mandi, cat: "Vegetables" },
    Potato: { unit: "kg", cost: 30, shelf: 20, sup: mandi, cat: "Vegetables" },
    "Mixed Vegetables": { unit: "kg", cost: 60, shelf: 3, sup: mandi, cat: "Vegetables" },
    "Urad Dal": { unit: "kg", cost: 140, sup: metroR, cat: "Pulses" },
    "Basmati Rice": { unit: "kg", cost: 110, sup: metroR, cat: "Grains" },
    Maida: { unit: "kg", cost: 40, sup: metroR, cat: "Grains" },
    Atta: { unit: "kg", cost: 45, sup: metroR, cat: "Grains" },
    "Dosa Batter": { unit: "kg", cost: 70, shelf: 2, sup: shreeDairy, cat: "Prepared" },
    Ghee: { unit: "l", cost: 650, shelf: 180, sup: metroR, cat: "Dairy" },
    Sugar: { unit: "kg", cost: 46, sup: metroR, cat: "Grains" },
  };
  const ingP = Object.fromEntries(Object.entries(ING).map(([name, s]) => [name, product("b-rest", "ingredient", { name, ...s, gst: 5 }, s.sup)]));
  const DISHES = [
    ["Paneer Butter Masala", 280, 18, { Paneer: 0.15, Butter: 0.02, Tomato: 0.1, "Fresh Cream": 0.03 }],
    ["Dal Makhani", 240, 20, { "Urad Dal": 0.08, Butter: 0.02, "Fresh Cream": 0.02, Tomato: 0.04 }],
    ["Butter Naan", 60, 55, { Maida: 0.08, Butter: 0.01 }],
    ["Tandoori Roti", 30, 45, { Atta: 0.07 }],
    ["Veg Biryani", 260, 14, { "Basmati Rice": 0.12, "Mixed Vegetables": 0.1, Ghee: 0.01 }],
    ["Masala Dosa", 140, 18, { "Dosa Batter": 0.15, Potato: 0.1 }],
    ["Paneer Tikka", 300, 9, { Paneer: 0.2, Curd: 0.05 }],
    ["Gulab Jamun", 90, 14, { Khoya: 0.04, Sugar: 0.03, Ghee: 0.01 }],
  ];
  const dishP = DISHES.map(([name, price, base, recipe]) => {
    const d = product("b-rest", "dish", { name, cat: "Menu", unit: "plate", gst: 5, sell: price, base, hsn: "9963", diwali: name === "Gulab Jamun" ? 2.2 : 1.1 }, null);
    const r = { id: uid("r"), business_id: "b-rest", dish_product_id: d.id, yield_qty: 1, notes: null };
    db.recipes.push(r);
    for (const [ing, q] of Object.entries(recipe)) db.recipe_ingredients.push({ id: uid("ri"), business_id: "b-rest", recipe_id: r.id, ingredient_product_id: ingP[ing].id, qty: q });
    return d;
  });
  generateRestaurantSales(db, dishP);
  const usagePerDay = (pid) => db.recipe_ingredients.filter((ri) => ri.ingredient_product_id === pid)
    .reduce((s, ri) => s + ri.qty * dishP.find((d) => db.recipes.find((r) => r.id === ri.recipe_id).dish_product_id === d.id)._spec.base, 0);
  for (const [name, p] of Object.entries(ingP)) {
    const daily = usagePerDay(p.id);
    const s = ING[name];
    const qty = Math.round(daily * s.sup.lead_time_days * (1.3 + rand() * 1.2) * 100) / 100;
    batch(p, Math.max(0.5, qty), s.shelf ? Math.min(s.shelf, 1 + Math.floor(rand() * s.shelf)) : null, 1, s.shelf ? "R" + (10 + Math.floor(rand() * 90)) : null);
  }
  batch(ingP.Paneer, 12, 1, 1, "PN-1016"); // more paneer than tomorrow's dishes will use
  // Dal Makhani and Biryani are habitually over-prepared.
  for (let i = 1; i <= 14; i++) {
    for (const [dish, p] of [[dishP[1], 0.7], [dishP[4], 0.45], [dishP[0], 0.15]]) {
      if (rand() < p) db.wastage_log.push({ id: uid("w"), business_id: "b-rest", product_id: dish.id, qty: 1 + Math.floor(rand() * 4), reason: "other", cost_paise: 0, note: "unsold at close", logged_at: daysFrom(TODAY, -i) + "T23:00:00+05:30" });
    }
  }
  db.wastage_log.push({ id: uid("w"), business_id: "b-rest", product_id: ingP.Tomato.id, qty: 1.5, reason: "spoiled", cost_paise: paise(60), note: null, logged_at: daysFrom(TODAY, -3) + "T20:00:00+05:30" });
  db.wastage_log.push({ id: uid("w"), business_id: "b-shop", product_id: shopProducts[9].id, qty: 3, reason: "expired", cost_paise: paise(114), note: "past date", logged_at: daysFrom(TODAY, -5) + "T21:00:00+05:30" });

  // ------------------------------------------------------------ wholesaler listings (the network)
  const LIST = [["Fortune Sunflower Oil 15L tin", "Edible oil", "tin", 1890, 1, 5], ["Parle-G 80g (carton of 96)", "Biscuits", "carton", 760, 2, 18],
    ["Maggi Masala 70g (carton of 96)", "Instant food", "carton", 1080, 2, 12], ["Tata Salt 1kg (bag of 25)", "Staples", "bag", 560, 1, 0],
    ["Sugar 50kg bag", "Staples", "bag", 1960, 1, 5], ["Amul Ghee 1L (case of 12)", "Dairy", "case", 6900, 1, 12],
    ["Kaju W320 10kg", "Dry fruits", "box", 8600, 1, 5], ["Basmati Rice 25kg", "Grains", "bag", 2650, 1, 5],
    ["Urad Dal 30kg", "Pulses", "bag", 3950, 1, 0], ["Haldiram Bhujia 200g (carton of 40)", "Snacks", "carton", 1720, 1, 12]];
  for (const [name, category, unit, price, min_qty, gst_rate] of LIST) {
    db.wholesaler_listings.push({ id: uid("wl"), business_id: "b-whole", name, category, unit, price_paise: paise(price), min_qty, gst_rate, description: null, image_path: null, is_active: true, embedding: [1] });
  }

  // ------------------------------------------------------------ purchases, POs, khata, reviews
  for (const [biz, s, daysAgo, inv, items] of [
    ["b-shop", gupta, 6, "GD-2231", [[shopProducts[0], 96], [shopProducts[1], 48], [shopProducts[12], 20]]],
    ["b-shop", metro, 9, "MC-88120", [[shopProducts[4], 10], [shopProducts[5], 24], [shopProducts[7], 50]]],
    ["b-shop", dairy, 1, "AD-517", [[shopProducts[2], 80], [shopProducts[8], 20]]],
    ["b-rest", shreeDairy, 1, "SD-904", [[ingP.Paneer, 8], [ingP["Fresh Cream"], 3]]],
    ["b-rest", metroR, 5, "MC-88301", [[ingP["Basmati Rice"], 25], [ingP["Urad Dal"], 10]]],
  ]) {
    const pur = { id: uid("pu"), business_id: biz, supplier_id: s.id, invoice_no: inv, invoice_date: daysFrom(TODAY, -daysAgo), source: daysAgo === 1 ? "bill_scan" : "manual", total_paise: 0, tax_paise: 0, created_at: daysFrom(TODAY, -daysAgo) + "T11:00:00+05:30" };
    for (const [p, q] of items) {
      const tax = Math.round(p.cost_price_paise * q * p.gst_rate / 100);
      db.purchase_items.push({ id: uid("pi"), business_id: biz, purchase_id: pur.id, product_id: p.id, qty: q, unit_cost_paise: p.cost_price_paise, gst_rate: p.gst_rate, tax_paise: tax });
      pur.total_paise += p.cost_price_paise * q + tax;
      pur.tax_paise += tax;
    }
    db.purchases.push(pur);
  }
  const po = { id: uid("po"), business_id: "b-shop", supplier_id: gupta.id, status: "sent", total_paise: 0, created_at: daysFrom(TODAY, -1) + "T18:00:00+05:30" };
  for (const [p, q] of [[shopProducts[10], 6], [shopProducts[11], 12]]) {
    db.purchase_order_items.push({ id: uid("poi"), business_id: "b-shop", po_id: po.id, product_id: p.id, qty: q, unit_cost_paise: p.cost_price_paise });
    po.total_paise += p.cost_price_paise * q;
  }
  db.purchase_orders.push(po);

  for (const [name, phone, entries] of [["Mehta ji", "919811100001", [["credit", 850, 12], ["credit", 600, 5], ["payment", 200, 2]]],
    ["Rekha aunty", "919811100002", [["credit", 430, 3]]], ["Sunil (tea stall)", null, [["credit", 300, 20], ["payment", 300, 8]]]]) {
    const c = { id: uid("kc"), business_id: "b-shop", name, phone };
    db.khata_customers.push(c);
    for (const [kind, amt, ago] of entries) db.khata_entries.push({ id: uid("ke"), business_id: "b-shop", customer_id: c.id, kind, amount_paise: paise(amt), note: null, created_at: daysFrom(TODAY, -ago) + "T19:00:00+05:30" });
  }

  const REVIEWS = [
    ["Paneer butter masala was rich and tasty, will come again", 5, "positive", ["taste"]],
    ["Food was good but delivery took more than an hour", 3, "neutral", ["taste", "delivery"]],
    ["Too expensive for the quantity they give", 2, "negative", ["price", "quantity"]],
    ["Dal makhani is the best in the area!", 5, "positive", ["taste"]],
    ["Naan was cold and chewy, very disappointed", 2, "negative", ["taste"]],
    ["Khana bahut accha tha, paisa vasool", 5, "positive", ["taste", "price"]],
    ["Clean place, polite staff, biryani was okay", 4, "neutral", ["hygiene", "taste"]],
    ["Gulab jamun was soft and fresh", 5, null, []],
  ];
  REVIEWS.forEach(([review_text, rating, sentiment, topics], i) => db.reviews.push({
    id: uid("rv"), business_id: "b-rest", source: pick(["google", "zomato", "swiggy"]), rating, review_text, sentiment, topics,
    reviewed_at: daysFrom(TODAY, -(i * 3 + 1)),
  }));
  return db;
}

function generateShopSales(db, products, pairs) {
  const byName = Object.fromEntries(products.map((p) => [p.name, p]));
  for (let ago = 89; ago >= 0; ago--) {
    const day = daysFrom(TODAY, -ago);
    const lines = [];
    for (const p of products) {
      const s = p._spec;
      if (s.stopDaysAgo && ago < s.stopDaysAgo) continue;
      if (s.startDaysAgo && ago > s.startDaysAgo) continue;
      let q = draw(s.base * WEEKLY_SHOP[dow(day)] * festival(day, s.diwali) * (ago === 0 ? 0.55 : 1));
      while (q > 0) { const n = Math.min(q, 1 + Math.floor(rand() * 3)); lines.push({ p, qty: n }); q -= n; }
    }
    const bills = Array.from({ length: Math.max(1, Math.round(lines.length / 2.4)) }, () => []);
    for (const l of lines) bills[Math.floor(rand() * bills.length)].push(l);
    for (const [a, b, prob] of pairs) {
      const withA = bills.filter((bl) => bl.some((l) => l.p === byName[a]));
      for (const bl of bills) {
        const i = bl.findIndex((l) => l.p === byName[b]);
        if (i >= 0 && !bl.some((l) => l.p === byName[a]) && withA.length && rand() < prob) pick(withA).push(...bl.splice(i, 1));
      }
    }
    bills.filter((bl) => bl.length).forEach((bl, k) => addSale(db, "b-shop", day, k, bl, pick(["cash", "cash", "upi", "upi", "card", "credit"]), "counter"));
  }
}

function generateRestaurantSales(db, dishes) {
  for (let ago = 89; ago >= 0; ago--) {
    const day = daysFrom(TODAY, -ago);
    dishes.forEach((d, k) => {
      const q = draw(d._spec.base * WEEKLY_REST[dow(day)] * festival(day, d._spec.diwali) * (ago === 0 ? 0.5 : 1));
      if (q > 0) addSale(db, "b-rest", day, k, [{ p: d, qty: q }], pick(["cash", "upi", "card"]), pick(["dine_in", "dine_in", "takeaway", "zomato", "swiggy"]));
    });
  }
}

function addSale(db, business_id, day, k, lines, payment_mode, channel) {
  const hour = 8 + ((k * 7) % 13);
  const sold_at = `${day}T${String(hour).padStart(2, "0")}:${String((k * 13) % 60).padStart(2, "0")}:00+05:30`;
  const sale = { id: uid("sa"), business_id, sold_at, channel, payment_mode, subtotal_paise: 0, tax_paise: 0, total_paise: 0, cogs_paise: 0 };
  for (const { p, qty } of lines) {
    const line = p.sell_price_paise * qty;
    const tax = Math.round(line - line / (1 + p.gst_rate / 100));
    const cogs = (p.kind === "dish" ? dishCost(db, p) : p.cost_price_paise) * qty;
    db.sale_items.push({ id: uid("si"), business_id, sale_id: sale.id, product_id: p.id, qty, unit_price_paise: p.sell_price_paise, gst_rate: p.gst_rate, line_total_paise: line, tax_paise: tax, cogs_paise: Math.round(cogs), short_qty: 0, _day: day });
    sale.total_paise += line; sale.tax_paise += tax; sale.subtotal_paise += line - tax; sale.cogs_paise += Math.round(cogs);
  }
  db.sales.push(sale);
}

export function dishCost(db, dish) {
  const r = db.recipes.find((x) => x.dish_product_id === dish.id);
  if (!r) return 0;
  return db.recipe_ingredients.filter((ri) => ri.recipe_id === r.id)
    .reduce((s, ri) => s + (db.products.find((p) => p.id === ri.ingredient_product_id)?.cost_price_paise ?? 0) * ri.qty, 0) / r.yield_qty;
}

export const newId = uid;
