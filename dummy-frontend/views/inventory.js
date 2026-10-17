// Stock / pantry, purchases + bill scan, reorder + purchase orders, forecasts, suppliers, wholesaler network.
import {
  busy, card, compressImage, daysAgo, field, fileToBase64, fmtDate, fmtDateTime, fn, formValues, h, inr, istToday, lineChart,
  loadProducts, q, qty, rupees, rpc, scanBarcode, select, state, supabase, table, toast, toPaise, words,
} from "../lib.js";

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
const UNITS = ["pcs", "kg", "g", "l", "ml", "pack", "box", "plate", "dozen"];

async function suppliersList() {
  return await q(supabase.from("suppliers").select("*").eq("business_id", state.business.id).order("name"));
}

// ---------------------------------------------------------------- stock / pantry
export async function stock() {
  const w = words();
  const isRest = state.business.business_type === "restaurant";
  const [products, suppliers] = await Promise.all([loadProducts(), suppliersList()]);
  const filter = h("input", { placeholder: "Filter…" });
  const kindSel = select(isRest ? [["ingredient", "Ingredients"], ["dish", "Menu dishes"], ["", "All"]] : [["product", "Products"], ["", "All"]], isRest ? "ingredient" : "product");
  const list = h("div");
  const editor = h("div");

  const draw = () => {
    const s = filter.value.toLowerCase();
    const rows = products.filter((p) => (!kindSel.value || p.kind === kindSel.value) && (!s || p.name.toLowerCase().includes(s) || p.barcode?.includes(s)));
    list.replaceChildren(table([
      { label: "Name", render: (p) => h("a", { href: "javascript:void 0", onclick: () => edit(p) }, p.name) },
      { label: "Category", key: "category" },
      { label: "On hand", num: true, render: (p) => p.kind === "dish" ? "—" : `${qty(p.on_hand)} ${p.unit}` },
      { label: "Next expiry", render: (p) => fmtDate(p.next_expiry) },
      { label: "Sell", num: true, render: (p) => inr(p.sell_price_paise) },
      { label: "Cost", num: true, render: (p) => inr(p.cost_price_paise) },
      { label: "GST", num: true, render: (p) => p.gst_rate + "%" },
      { label: "Value", num: true, render: (p) => inr(p.stock_value_paise) },
    ], rows));
  };
  filter.oninput = draw;
  kindSel.onchange = draw;

  async function edit(p) {
    const full = p ? await q(supabase.from("products").select("*").eq("id", p.product_id).single()) : {};
    const barcode = h("input", { name: "barcode", value: full.barcode ?? "" });
    const form = h("form", {},
      h("div", { class: "row" },
        field("Name", h("input", { name: "name", value: full.name ?? "", required: true })),
        field("Kind", select(isRest ? [["ingredient", "Ingredient"], ["dish", "Dish"]] : [["product", "Product"]], full.kind ?? (isRest ? "ingredient" : "product"), { name: "kind" })),
        field("Category", h("input", { name: "category", value: full.category ?? "" })),
        field("Unit", select(UNITS.map((u) => [u, u]), full.unit ?? "pcs", { name: "unit" }))),
      h("div", { class: "row" },
        field("Barcode", h("span", { class: "row" }, barcode, h("button", { type: "button", class: "secondary", onclick: async () => {
          const c = await scanBarcode();
          if (c) barcode.value = c;
        } }, "📷"))),
        field("HSN", h("input", { name: "hsn_code", value: full.hsn_code ?? "", size: 8 })),
        field("GST %", select(GST_RATES.map((r) => [r, r + "%"]), full.gst_rate ?? 0, { name: "gst_rate" }))),
      h("div", { class: "row" },
        field("Selling price ₹ (incl. GST)", h("input", { name: "sell", type: "number", step: "0.01", value: rupees(full.sell_price_paise) })),
        field("MRP ₹", h("input", { name: "mrp", type: "number", step: "0.01", value: rupees(full.mrp_paise) })),
        field("Cost ₹ (excl. GST)", h("input", { name: "cost", type: "number", step: "0.01", value: rupees(full.cost_price_paise) })),
        field("Reorder at (min qty)", h("input", { name: "reorder_level", type: "number", step: "0.001", value: full.reorder_level ?? "" })),
        field("Min order qty", h("input", { name: "reorder_qty", type: "number", step: "0.001", value: full.reorder_qty ?? "" })),
        field("Preferred supplier", select([["", "—"], ...suppliers.map((s) => [s.id, s.name])], full.preferred_supplier_id, { name: "preferred_supplier_id" }))),
      h("p", { class: "row" }, h("button", {}, p ? "Save" : "Add"), h("button", { type: "button", class: "secondary", onclick: () => editor.replaceChildren() }, "Close")));
    form.onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        const v = formValues(form);
        const row = {
          business_id: state.business.id, name: v.name.trim(), kind: v.kind, category: v.category || null, unit: v.unit,
          barcode: v.barcode || null, hsn_code: v.hsn_code || null, gst_rate: Number(v.gst_rate),
          sell_price_paise: toPaise(v.sell), mrp_paise: toPaise(v.mrp), cost_price_paise: toPaise(v.cost),
          reorder_level: v.reorder_level === "" ? null : Number(v.reorder_level),
          reorder_qty: v.reorder_qty === "" ? null : Number(v.reorder_qty),
          preferred_supplier_id: v.preferred_supplier_id || null,
        };
        if (p) await q(supabase.from("products").update(row).eq("id", p.product_id));
        else await q(supabase.from("products").insert(row));
        toast(p ? "Saved" : "Added — its search embedding is queued");
        products.splice(0, products.length, ...(await loadProducts()));
        draw();
        editor.replaceChildren();
      });
    };

    let extra = null;
    if (p && p.kind !== "dish") {
      const batches = await q(supabase.from("stock_batches").select("*").eq("product_id", p.product_id).gt("qty_remaining", 0).order("expiry_date"));
      const countForm = h("form", { class: "row" },
        field(`Counted qty (${full.unit})`, h("input", { name: "counted", type: "number", step: "0.001", required: true })),
        field("Expiry (if adding)", h("input", { name: "expiry", type: "date" })),
        h("button", {}, "Set stock to count"));
      countForm.onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          const v = formValues(countForm);
          const r = await rpc("adjust_stock", { p_product_id: p.product_id, p_counted_qty: Number(v.counted), p_expiry_date: v.expiry || null });
          toast(`Stock ${qty(r.previous_qty)} → ${qty(r.new_qty)}`);
          products.splice(0, products.length, ...(await loadProducts()));
          draw();
          edit(products.find((x) => x.product_id === p.product_id));
        });
      };
      extra = h("div", {},
        h("h3", {}, "Batches (earliest expiry is sold first)"),
        table([
          { label: "Batch", render: (b) => b.batch_no ?? "-" },
          { label: "Received", render: (b) => fmtDate(b.received_at) },
          { label: "Expiry", render: (b) => fmtDate(b.expiry_date) },
          { label: "Left", num: true, render: (b) => `${qty(b.qty_remaining)} / ${qty(b.qty_received)}` },
          { label: "Cost", num: true, render: (b) => inr(b.unit_cost_paise) },
        ], batches),
        h("h3", {}, "Physical stock count"), countForm);
    }
    editor.replaceChildren(card(p ? `Edit ${full.name}` : `New ${w.product}`, form, extra));
    editor.scrollIntoView({ behavior: "smooth" });
  }

  draw();
  return h("div", {}, h("h2", {}, w.stock),
    editor,
    card(null, h("div", { class: "row" }, filter, kindSel, h("button", { onclick: () => edit(null) }, `+ Add ${w.product}`)), h("p"), list));
}

// ---------------------------------------------------------------- purchases (manual + bill scan)
export async function purchases() {
  const [products, suppliers] = await Promise.all([loadProducts(), suppliersList()]);
  const stockable = products.filter((p) => p.kind !== "dish");
  const editorBox = h("div");
  const history = h("div");

  /** Editable draft (from bill scan or empty) -> record_purchase on confirm. */
  function editor(draft = { purchase: {}, items: [{}] }, warnings = []) {
    const head = h("div", { class: "row" },
      field("Supplier", h("input", { name: "supplier_name", list: "supplier-list", value: draft.purchase.supplier_name ?? "" })),
      h("datalist", { id: "supplier-list" }, suppliers.map((s) => h("option", { value: s.name }))),
      field("Invoice no", h("input", { name: "invoice_no", value: draft.purchase.invoice_no ?? "" })),
      field("Invoice date", h("input", { name: "invoice_date", type: "date", value: draft.purchase.invoice_date ?? istToday() })));
    const body = h("tbody");
    const addRow = (it = {}) => {
      const productSel = select([["", "➕ New item: use name"], ...stockable.map((p) => [p.product_id, p.name])], it.product_id ?? "");
      const tr = h("tr", {},
        h("td", {}, productSel, h("br"), h("input", { class: "name", value: it.name ?? "", placeholder: "Name as on bill" }),
          it.matched_name && !it.product_id ? h("div", { class: "muted" }, `closest: ${it.matched_name}`) : null),
        h("td", {}, h("input", { class: "qty", type: "number", step: "0.001", value: it.qty ?? 1 })),
        h("td", {}, select(UNITS.map((u) => [u, u]), it.unit ?? "pcs", { class: "unit" })),
        h("td", {}, h("input", { class: "cost", type: "number", step: "0.01", value: rupees(it.unit_cost_paise) })),
        h("td", {}, select(GST_RATES.map((r) => [r, r + "%"]), it.gst_rate ?? 0, { class: "gst" })),
        h("td", {}, h("input", { class: "expiry", type: "date", value: it.expiry_date ?? "" })),
        h("td", {}, h("input", { class: "batch", value: it.batch_no ?? "", size: 6 })),
        h("td", {}, h("button", { type: "button", class: "secondary", onclick: () => tr.remove() }, "✕")));
      body.append(tr);
    };
    (draft.items.length ? draft.items : [{}]).forEach(addRow);

    const save = h("button", { onclick: (e) => busy(e.target, async () => {
      const hv = Object.fromEntries([...head.querySelectorAll("input")].map((i) => [i.name, i.value]));
      const items = [...body.querySelectorAll("tr")].map((tr) => ({
        product_id: tr.querySelector("select").value || null,
        name: tr.querySelector(".name").value.trim() || null,
        qty: Number(tr.querySelector(".qty").value),
        unit: tr.querySelector(".unit").value,
        unit_cost_paise: toPaise(tr.querySelector(".cost").value) ?? 0,
        gst_rate: Number(tr.querySelector(".gst").value),
        expiry_date: tr.querySelector(".expiry").value || null,
        batch_no: tr.querySelector(".batch").value || null,
      })).filter((i) => i.qty > 0 && (i.product_id || i.name));
      if (!items.length) throw new Error("Add at least one item");
      const res = await rpc("record_purchase", {
        p_purchase: { ...draft.purchase, ...hv, source: draft.purchase.source ?? "manual" },
        p_items: items,
      });
      toast(`Purchase saved: ${inr(res.total_paise)}${res.products_created ? `, ${res.products_created} new item(s)` : ""}`);
      editorBox.replaceChildren();
      loadHistory();
    }) }, "✅ Confirm & save");

    editorBox.replaceChildren(card(draft.purchase.source === "bill_scan" ? "Check the scanned bill" : "New purchase",
      warnings.map((w) => h("div", { class: "warn-box" }, "⚠️ " + w)),
      draft.printed_total_paise ? h("p", { class: "muted" }, `Bill total ${inr(draft.printed_total_paise)} · items add up to ${inr(draft.computed_total_paise)}`) : null,
      head, h("p"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Item", "Qty", "Unit", "Rate ₹ (ex-GST)", "GST", "Expiry", "Batch", ""].map((x) => h("th", {}, x)))), body)),
      h("p", { class: "row" }, h("button", { type: "button", class: "secondary", onclick: () => addRow() }, "+ Line"), save,
        h("button", { type: "button", class: "secondary", onclick: () => editorBox.replaceChildren() }, "Cancel"))));
  }

  const fileInput = h("input", { type: "file", accept: "image/*,application/pdf", capture: "environment" });
  const scanBtn = h("button", { onclick: (e) => busy(e.target, async () => {
    const file = fileInput.files[0];
    if (!file) throw new Error("Choose a bill photo first");
    const img = await compressImage(file);
    const path = `${state.business.id}/${crypto.randomUUID()}.${img.type === "application/pdf" ? "pdf" : "jpg"}`;
    const up = await supabase.storage.from("bills").upload(path, img, { contentType: img.type });
    if (up.error) throw up.error;
    const res = await fn("scan-bill", { storage_path: path });
    if (!res.ok) {
      toast(res.reason + " — enter it manually below.", "info");
      editor({ purchase: { source: "manual", bill_image_path: path }, items: [{}] });
      return;
    }
    editor(res.draft, res.warnings);
  }) }, "📄 Scan bill");

  async function loadHistory() {
    const rows = await q(supabase.from("purchases").select("*, suppliers(name), purchase_items(count)")
      .eq("business_id", state.business.id).order("invoice_date", { ascending: false }).order("created_at", { ascending: false }).limit(50));
    history.replaceChildren(table([
      { label: "Date", render: (r) => fmtDate(r.invoice_date) },
      { label: "Supplier", render: (r) => r.suppliers?.name ?? "-" },
      { label: "Invoice", key: "invoice_no" },
      { label: "Source", key: "source" },
      { label: "Lines", num: true, render: (r) => r.purchase_items?.[0]?.count ?? 0 },
      { label: "Tax", num: true, render: (r) => inr(r.tax_paise) },
      { label: "Total", num: true, render: (r) => inr(r.total_paise) },
    ], rows));
  }
  await loadHistory();

  return h("div", {}, h("h2", {}, "Purchases"),
    card("Add stock", h("div", { class: "row" }, fileInput, scanBtn, h("span", { class: "muted" }, "or"),
      h("button", { class: "secondary", onclick: () => editor() }, "✍️ Enter manually")),
      h("p", { class: "muted" }, "Gemini reads the bill; nothing is saved until you confirm. If AI is unavailable, you get the manual form.")),
    editorBox,
    card("Recent purchases", history));
}

// ---------------------------------------------------------------- reorder + purchase orders
export async function reorder() {
  const sugg = h("div");
  const pos = h("div");
  async function load() {
    const rows = await rpc("reorder_suggestions");
    sugg.replaceChildren(table([
      { label: "Item", key: "name" },
      { label: "On hand", num: true, render: (r) => `${qty(r.on_hand)} ${r.unit}` },
      { label: "Reorder point", num: true, render: (r) => qty(r.reorder_point) },
      { label: "Daily use", num: true, render: (r) => qty(r.avg_daily_demand) },
      { label: "Safety", num: true, render: (r) => qty(r.safety_stock) },
      { label: "Order", num: true, render: (r) => h("strong", {}, qty(r.suggested_qty)) },
      { label: "Supplier", render: (r) => r.supplier_name ?? "-" },
      { label: "Rate", num: true, render: (r) => inr(r.unit_cost_paise) },
      { label: "Basis", render: (r) => h("span", { class: "pill" }, r.method) },
    ], rows, { empty: "Nothing needs reordering." }));

    const orders = await q(supabase.from("purchase_orders").select("*, suppliers(name, phone), purchase_order_items(qty, unit_cost_paise, products(name, unit))")
      .eq("business_id", state.business.id).order("created_at", { ascending: false }).limit(30));
    pos.replaceChildren(table([
      { label: "Created", render: (o) => fmtDateTime(o.created_at) },
      { label: "Supplier", render: (o) => o.suppliers?.name ?? "No supplier" },
      { label: "Items", render: (o) => o.purchase_order_items.map((i) => `${qty(i.qty)} ${i.products.unit} ${i.products.name}`).join(", ") },
      { label: "Total", num: true, render: (o) => inr(o.total_paise) },
      { label: "Status", render: (o) => h("span", { class: "pill" }, o.status) },
      { label: "", render: (o) => h("span", { class: "row" },
        o.status === "draft" ? h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
          await q(supabase.from("purchase_orders").update({ status: "sent" }).eq("id", o.id));
          const text = `Order from ${state.business.name}:\n` + o.purchase_order_items.map((i) => `- ${qty(i.qty)} ${i.products.unit} ${i.products.name}`).join("\n");
          await navigator.clipboard?.writeText(text).catch(() => {});
          toast("Marked sent — order text copied to share on Telegram");
          load();
        }) }, "Mark sent") : null,
        ["draft", "sent"].includes(o.status) ? h("button", { onclick: (e) => busy(e.target, async () => {
          await rpcRawReceive(o.id);
          toast("Goods received — stock updated");
          load();
        }) }, "Received") : null,
        ["draft", "sent"].includes(o.status) ? h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
          await q(supabase.from("purchase_orders").update({ status: "cancelled" }).eq("id", o.id));
          load();
        }) }, "Cancel") : null) },
    ], orders, { empty: "No purchase orders yet." }));
  }
  async function rpcRawReceive(id) {
    const { error } = await supabase.rpc("receive_purchase_order", { p_po_id: id });
    if (error) throw new Error(error.message);
  }
  await load();
  return h("div", {}, h("h2", {}, "Reorder"),
    card("Suggestions", h("p", { class: "muted" },
      "Reorder point = demand over lead time (from forecasts, else 28-day average) + safety stock. Perishables are ordered for their shelf life only."),
    h("p", {}, h("button", { onclick: (e) => busy(e.target, async () => {
      const r = await rpc("create_draft_purchase_orders");
      toast(`${r.orders_created} draft order(s), ${r.lines} line(s)`);
      load();
    }) }, "Create draft purchase orders")), sugg),
    card("Purchase orders", pos));
}

// ---------------------------------------------------------------- forecasts
export async function forecasts() {
  const products = (await loadProducts()).filter((p) => p.kind !== "dish");
  const fc = await q(supabase.from("forecasts").select("product_id, forecast_date, yhat, yhat_lower, yhat_upper, method, generated_at")
    .eq("business_id", state.business.id).gte("forecast_date", istToday()).order("forecast_date"));
  const withFc = new Set(fc.map((f) => f.product_id));
  const sel = select(products.map((p) => [p.product_id, (withFc.has(p.product_id) ? "★ " : "") + p.name]),
    products.find((p) => withFc.has(p.product_id))?.product_id ?? products[0]?.product_id);
  const chartBox = h("div");
  async function draw() {
    const pid = sel.value;
    const usage = await q(supabase.from("daily_usage").select("day, qty").eq("product_id", pid).gte("day", daysAgo(42)).order("day"));
    const byDay = new Map();
    for (const u of usage) byDay.set(u.day, (byDay.get(u.day) ?? 0) + Number(u.qty));
    const hist = [...byDay].map(([x, y]) => ({ x, y }));
    const f = fc.filter((x) => x.product_id === pid);
    chartBox.replaceChildren(
      lineChart([
        { label: "Actual daily use", points: hist, color: "#1f6feb" },
        { label: "Forecast", points: f.map((x) => ({ x: x.forecast_date, y: Number(x.yhat) })), dashed: true, color: "#bf3989",
          band: f.map((x) => ({ x: x.forecast_date, lo: Number(x.yhat_lower ?? x.yhat), hi: Number(x.yhat_upper ?? x.yhat) })) },
      ]),
      f.length ? h("p", { class: "muted" }, `Method: ${f[0].method} · generated ${fmtDateTime(f[0].generated_at)}`)
        : h("p", { class: "muted" }, "No forecast for this item yet — reorder uses the moving average or your manual level."));
  }
  sel.onchange = draw;
  if (products.length) await draw();
  return h("div", {}, h("h2", {}, "Demand forecasts"),
    card(null, field("Item (★ has forecast)", sel), h("p"), chartBox,
      h("p", { class: "muted" }, "Forecasts are written nightly by the Python job (forecasting/). This page only reads them.")));
}

// ---------------------------------------------------------------- suppliers + prices
export async function suppliers() {
  const list = h("div");
  async function load() {
    const rows = await q(supabase.from("suppliers").select("*, supplier_prices(price_paise, updated_at, products(name, unit))")
      .eq("business_id", state.business.id).order("name"));
    list.replaceChildren(table([
      { label: "Name", key: "name" },
      { label: "Phone", key: "phone" },
      { label: "GSTIN", key: "gstin" },
      { label: "In network", render: (s) => s.wholesaler_business_id ? "✓" : "" },
      { label: "Last prices", render: (s) => s.supplier_prices.slice(0, 6).map((p) => `${p.products.name} ${inr(p.price_paise)}/${p.products.unit}`).join(" · ") },
    ], rows));
  }
  const form = h("form", { class: "row" },
    field("Name", h("input", { name: "name", required: true })), field("Phone", h("input", { name: "phone" })),
    field("GSTIN", h("input", { name: "gstin" })), h("button", {}, "Add supplier"));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      await q(supabase.from("suppliers").insert({ business_id: state.business.id, name: v.name, phone: v.phone || null, gstin: v.gstin || null }));
      form.reset();
      load();
    });
  };
  await load();
  return h("div", {}, h("h2", {}, "Suppliers"), card("Add", form),
    card("Suppliers", h("p", { class: "muted" }, "Prices update automatically from every purchase; reorder picks the preferred or cheapest supplier."), list));
}

// ---------------------------------------------------------------- wholesaler network (Gemini search)
export async function network() {
  const isWholesaler = state.business.business_type === "wholesaler";
  const results = h("div");
  const text = h("input", { placeholder: "e.g. sunflower oil 15L", style: { minWidth: "240px" } });
  const photo = h("input", { type: "file", accept: "image/*", capture: "environment" });
  const show = (res) => results.replaceChildren(
    h("p", { class: "muted" }, `Matched by ${res.method}${res.error ? " — " + res.error : ""}`),
    table([
      { label: "Item", key: "name" },
      { label: "Wholesaler", render: (r) => `${r.wholesaler_name}${r.city ? ", " + r.city : ""}` },
      { label: "Price", num: true, render: (r) => `${inr(r.price_paise)} / ${r.unit}` },
      { label: "Min qty", num: true, render: (r) => qty(r.min_qty) },
      { label: "GST", num: true, render: (r) => r.gst_rate + "%" },
      { label: "Match", num: true, render: (r) => (r.similarity * 100).toFixed(0) + "%" },
    ], res.results, { empty: "No matches in the network." }));

  const searchCard = card("Find the best wholesale price (inside our network only)",
    h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); busy(e.submitter, async () => show(await fn("product-search", { text: text.value }))); } },
      text, h("button", {}, "Search")),
    h("p", { class: "row" }, photo, h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
      if (!photo.files[0]) throw new Error("Choose a photo");
      const img = await compressImage(photo.files[0], 1024);
      show(await fn("product-search", { image_base64: await fileToBase64(img), text: text.value || undefined }));
    }) }, "📷 Search by photo")),
    results);

  if (!isWholesaler) return h("div", {}, h("h2", {}, "Wholesaler network"), searchCard);

  // wholesaler: manage own listings
  const list = h("div");
  async function load() {
    const rows = await q(supabase.from("wholesaler_listings").select("*").eq("business_id", state.business.id).order("name"));
    list.replaceChildren(table([
      { label: "Item", key: "name" },
      { label: "Category", key: "category" },
      { label: "Price", num: true, render: (r) => `${inr(r.price_paise)} / ${r.unit}` },
      { label: "Min qty", num: true, render: (r) => qty(r.min_qty) },
      { label: "Search-ready", render: (r) => (r.embedding ? "✓" : "queued") },
      { label: "", render: (r) => h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
        await q(supabase.from("wholesaler_listings").update({ is_active: !r.is_active }).eq("id", r.id));
        load();
      }) }, r.is_active ? "Hide" : "Show") },
    ], rows));
  }
  const img = h("input", { type: "file", accept: "image/*", name: "image" });
  const form = h("form", {},
    h("div", { class: "row" },
      field("Item", h("input", { name: "name", required: true })), field("Category", h("input", { name: "category" })),
      field("Unit", select(UNITS.map((u) => [u, u]).concat([["bag", "bag"], ["carton", "carton"], ["tin", "tin"], ["crate", "crate"]]), "pcs", { name: "unit" })),
      field("Price ₹", h("input", { name: "price", type: "number", step: "0.01", required: true })),
      field("Min qty", h("input", { name: "min_qty", type: "number", value: 1 })),
      field("GST %", select(GST_RATES.map((r) => [r, r + "%"]), 5, { name: "gst_rate" }))),
    h("div", { class: "row" }, field("Description", h("input", { name: "description", style: { minWidth: "300px" } })), field("Photo", img)),
    h("p", {}, h("button", {}, "Add listing")));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      let image_path = null;
      if (img.files[0]) {
        const blob = await compressImage(img.files[0], 1024);
        image_path = `${state.business.id}/${crypto.randomUUID()}.jpg`;
        const up = await supabase.storage.from("listing-images").upload(image_path, blob, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
      }
      await q(supabase.from("wholesaler_listings").insert({
        business_id: state.business.id, name: v.name, category: v.category || null, unit: v.unit, price_paise: toPaise(v.price),
        min_qty: Number(v.min_qty || 1), gst_rate: Number(v.gst_rate), description: v.description || null, image_path,
      }));
      toast("Listed — it becomes photo-searchable once embedded");
      form.reset();
      load();
    });
  };
  await load();
  return h("div", {}, h("h2", {}, "Wholesaler network"), card("New listing", form), card("Your listings", list), searchCard);
}
