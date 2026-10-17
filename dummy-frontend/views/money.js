// Khata, profit & GST reports, reviews.
import {
  busy, card, daysAgo, downloadCSV, field, fmtDate, fmtDateTime, formValues, h, inr, istToday, lineChart, q, rpc, select,
  state, supabase, table, toast, toPaise,
} from "../lib.js";

// ---------------------------------------------------------------- khata (udhaar)
export async function khata() {
  const list = h("div");
  const detail = h("div");
  async function load() {
    const rows = await q(supabase.from("khata_balances").select("*").eq("business_id", state.business.id).order("balance_paise", { ascending: false }));
    list.replaceChildren(table([
      { label: "Customer", render: (c) => h("a", { href: "javascript:void 0", onclick: () => open(c) }, c.name) },
      { label: "Phone", key: "phone" },
      { label: "Balance", num: true, render: (c) => h("strong", { style: { color: c.balance_paise > 0 ? "var(--crit)" : "var(--ok)" } }, inr(c.balance_paise)) },
      { label: "Last entry", render: (c) => fmtDateTime(c.last_entry_at) },
    ], rows, { empty: "No khata customers yet." }));
  }
  async function open(c) {
    const entries = await q(supabase.from("khata_entries").select("*").eq("customer_id", c.customer_id).order("created_at", { ascending: false }).limit(100));
    detail.replaceChildren(card(`${c.name} — balance ${inr(c.balance_paise)}`, table([
      { label: "When", render: (e) => fmtDateTime(e.created_at) },
      { label: "Type", render: (e) => e.kind === "credit" ? "Udhaar given" : "Payment received" },
      { label: "Amount", num: true, render: (e) => inr(e.amount_paise) },
      { label: "Note", key: "note" },
    ], entries)));
  }
  const form = h("form", { class: "row" },
    field("Customer", h("input", { name: "customer", required: true })),
    field("Phone", h("input", { name: "phone" })),
    field("Type", select([["credit", "Udhaar given"], ["payment", "Payment received"]], "credit", { name: "kind" })),
    field("Amount ₹", h("input", { name: "amount", type: "number", step: "0.01", required: true })),
    field("Note", h("input", { name: "note" })),
    h("button", {}, "Save"));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      const r = await rpc("khata_add", { p_customer: v.customer, p_kind: v.kind, p_amount_paise: toPaise(v.amount), p_note: v.note || null, p_phone: v.phone || null });
      toast(`${v.customer}: balance ${inr(r.balance_paise)}`);
      form.reset();
      load();
    });
  };
  await load();
  return h("div", {}, h("h2", {}, "Khata"), card("New entry", form), detail, card("Customers", list));
}

// ---------------------------------------------------------------- profit + GST
export async function reports() {
  const from = h("input", { type: "date", value: daysAgo(30) });
  const to = h("input", { type: "date", value: istToday() });
  const out = h("div");
  async function run() {
    const [p, g] = await Promise.all([
      rpc("profit_report", { p_from: from.value, p_to: to.value }),
      rpc("gst_report", { p_from: from.value, p_to: to.value }),
    ]);
    const kpi = (l, v) => h("div", { class: "kpi" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l));
    const rateCols = [
      { label: "GST rate", render: (r) => r.gst_rate + "%" },
      { label: "Taxable value", num: true, render: (r) => inr(r.taxable_paise) },
      { label: "CGST", num: true, render: (r) => inr(r.cgst_paise) },
      { label: "SGST", num: true, render: (r) => inr(r.sgst_paise) },
      { label: "Total tax", num: true, render: (r) => inr(r.tax_paise) },
    ];
    out.replaceChildren(
      h("div", { class: "kpis" },
        kpi("Gross sales", inr(p.gross_sales_paise)), kpi("Revenue ex-GST", inr(p.revenue_paise)), kpi("Cost of goods", inr(p.cogs_paise)),
        kpi("Wastage", inr(p.wastage_paise)), kpi("Net profit", inr(p.net_profit_paise)), kpi("Margin", p.margin_pct + "%"), kpi("Bills", p.bills)),
      card("Daily revenue and profit", lineChart([
        { label: "Revenue", color: "#1f6feb", points: p.days.map((d) => ({ x: d.day, y: d.revenue_paise / 100 })) },
        { label: "Profit", color: "#1a7f37", points: p.days.map((d) => ({ x: d.day, y: d.profit_paise / 100 })) },
      ])),
      h("div", { class: "grid" },
        card("Profit by item", table([
          { label: "Item", key: "name" }, { label: "Qty", num: true, render: (r) => Number(r.qty) },
          { label: "Revenue", num: true, render: (r) => inr(r.revenue_paise) }, { label: "Profit", num: true, render: (r) => inr(r.profit_paise) },
          { label: "Margin", num: true, render: (r) => r.margin_pct + "%" },
        ], p.products)),
        card("Sales by channel", table([
          { label: "Channel", key: "channel" }, { label: "Bills", num: true, key: "bills" }, { label: "Sales", num: true, render: (r) => inr(r.total_paise) },
        ], p.channels))),
      card(`GST summary ${fmtDate(g.from)} – ${fmtDate(g.to)} (GSTIN ${g.business.gstin ?? "not set"})`,
        h("div", { class: "kpis" }, kpi("Output tax", inr(g.output_tax_paise)), kpi("Input tax credit", inr(g.input_tax_credit_paise)),
          kpi("Net payable", inr(g.net_payable_paise)), kpi("ITC carried forward", inr(g.itc_carry_forward_paise))),
        h("h3", {}, "Sales (outward)"), table(rateCols, g.outward),
        h("h3", {}, "Purchases (inward)"), table(rateCols, g.inward),
        h("h3", {}, "HSN summary"), table([
          { label: "HSN", key: "hsn" }, { label: "Unit", key: "unit" }, { label: "Rate", render: (r) => r.gst_rate + "%" },
          { label: "Qty", num: true, render: (r) => Number(r.qty) }, { label: "Taxable", num: true, render: (r) => inr(r.taxable_paise) },
          { label: "Tax", num: true, render: (r) => inr(r.tax_paise) },
        ], g.hsn_summary),
        h("p", { class: "row" },
          h("button", { class: "secondary", onclick: () => downloadCSV(`gst_${g.from}_${g.to}.csv`, [
            ["Section", "GST rate", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "Tax (₹)"],
            ...g.outward.map((r) => ["Outward", r.gst_rate, r.taxable_paise / 100, r.cgst_paise / 100, r.sgst_paise / 100, r.tax_paise / 100]),
            ...g.inward.map((r) => ["Inward", r.gst_rate, r.taxable_paise / 100, r.cgst_paise / 100, r.sgst_paise / 100, r.tax_paise / 100]),
          ]) }, "Download CSV"),
          h("button", { class: "secondary", onclick: () => window.print() }, "Print"),
          h("span", { class: "muted" }, "PDF: python reports/gst_report.py --business-id … --month YYYY-MM"))));
  }
  await run();
  return h("div", {}, h("h2", {}, "Profit & GST"),
    card(null, h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); busy(e.submitter, run); } },
      field("From", from), field("To", to), h("button", {}, "Run"))), out);
}

// ---------------------------------------------------------------- reviews
export async function reviews() {
  const list = h("div");
  async function load() {
    const rows = await q(supabase.from("reviews").select("*").eq("business_id", state.business.id).order("reviewed_at", { ascending: false }).limit(100));
    const scored = rows.filter((r) => r.sentiment);
    const counts = Object.fromEntries(["positive", "neutral", "negative"].map((s) => [s, scored.filter((r) => r.sentiment === s).length]));
    const topics = {};
    scored.forEach((r) => (r.topics ?? []).forEach((t) => {
      topics[t] ??= { pos: 0, neg: 0 };
      r.sentiment === "negative" ? topics[t].neg++ : r.sentiment === "positive" && topics[t].pos++;
    }));
    list.replaceChildren(
      h("p", {}, `😊 ${counts.positive}  😐 ${counts.neutral}  ☹️ ${counts.negative}  · ${rows.length - scored.length} waiting for the nightly analysis`),
      Object.keys(topics).length ? h("p", { class: "muted" }, "Topics: " + Object.entries(topics).map(([t, c]) => `${t} (+${c.pos}/−${c.neg})`).join(", ")) : null,
      table([
        { label: "When", render: (r) => fmtDate(r.reviewed_at) },
        { label: "Source", key: "source" },
        { label: "★", num: true, key: "rating" },
        { label: "Review", key: "review_text" },
        { label: "Sentiment", render: (r) => r.sentiment ? h("span", { class: "pill " + r.sentiment }, r.sentiment) : h("span", { class: "muted" }, "pending") },
        { label: "Topics", render: (r) => (r.topics ?? []).join(", ") },
      ], rows));
  }
  const form = h("form", {},
    h("div", { class: "row" },
      field("Source", select([["manual", "Manual"], ["google", "Google"], ["zomato", "Zomato"], ["swiggy", "Swiggy"]], "manual", { name: "source" })),
      field("Rating", select([["", "-"], [5, "5"], [4, "4"], [3, "3"], [2, "2"], [1, "1"]], "", { name: "rating" }))),
    field("Review text", h("textarea", { name: "text", required: true })),
    h("p", {}, h("button", {}, "Add review")));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      await q(supabase.from("reviews").insert({ business_id: state.business.id, source: v.source, rating: v.rating ? Number(v.rating) : null, review_text: v.text }));
      toast("Saved — sentiment is analysed in tonight's batch");
      form.reset();
      load();
    });
  };
  await load();
  return h("div", {}, h("h2", {}, "Reviews"), card("Add a review", form), card("Reviews", list));
}
