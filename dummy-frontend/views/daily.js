// Dashboard, POS, assistant + voice commands, alerts.
import {
  busy, card, field, fileToBase64, fmtDate, fmtDateTime, fn, formValues, h, inr, loadProducts, q, qty, recordAudio, rpc,
  scanBarcode, select, state, supabase, table, toast, words,
} from "../lib.js";

// ---------------------------------------------------------------- dashboard
export async function dashboard() {
  const d = await rpc("dashboard");
  const insights = await q(supabase.from("alerts").select("message, created_at").eq("business_id", state.business.id)
    .eq("kind", "insight").order("created_at", { ascending: false }).limit(1));
  const w = words();
  const kpi = (l, v) => h("div", { class: "kpi" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l));
  return h("div", {},
    h("h2", {}, state.business.name),
    insights[0] ? card("💡 Today's insight", h("p", {}, insights[0].message), h("small", { class: "muted" }, fmtDateTime(insights[0].created_at))) : null,
    h("div", { class: "kpis" },
      kpi("Sales today", inr(d.today.sales_paise)),
      kpi("Profit today", inr(d.today.profit_paise)),
      kpi("Bills today", d.today.bills),
      kpi("Sales, 30 days", inr(d.last_30_days.sales_paise)),
      kpi("Profit, 30 days", inr(d.last_30_days.profit_paise)),
      kpi(`${w.stock} value`, inr(d.stock_value_paise)),
      kpi("Udhaar outstanding", inr(d.khata_outstanding_paise)),
      kpi("Wastage, 30 days", inr(d.wastage_30d_paise)),
      kpi("Open alerts", d.open_alerts)),
    h("div", { class: "grid" },
      card("Running low", table([
        { label: "Item", key: "name" },
        { label: "Left", num: true, render: (r) => `${qty(r.on_hand)} ${r.unit}` },
        { label: "Reorder", num: true, render: (r) => qty(r.suggested_qty) },
      ], d.low_stock, { empty: "Nothing is running low 👍" })),
      card("Expiring / expired", table([
        { label: "Item", key: "name" },
        { label: "Qty", num: true, render: (r) => `${qty(r.qty)} ${r.unit}` },
        { label: "Expiry", render: (r) => h("span", { class: "pill " + (r.expiry_date < new Date().toISOString().slice(0, 10) ? "critical" : "warning") }, fmtDate(r.expiry_date)) },
      ], d.expiring_soon, { empty: "Nothing expiring this week" })),
      card("Top sellers (30 days)", table([
        { label: "Item", key: "name" },
        { label: "Sales", num: true, render: (r) => inr(r.sales_paise) },
        { label: "Profit", num: true, render: (r) => inr(r.profit_paise) },
      ], d.top_products_30d))));
}

// ---------------------------------------------------------------- POS
export async function sell() {
  const products = await loadProducts();
  const isRest = state.business.business_type === "restaurant";
  const sellable = products.filter((p) => p.is_active && (isRest ? p.kind === "dish" : p.kind === "product"));
  const cart = new Map(); // product_id -> {product, qty, price}
  const cartBox = h("div");
  const totalBox = h("strong");

  const add = (p, n = 1) => {
    const line = cart.get(p.product_id) ?? { product: p, qty: 0, price: p.sell_price_paise ?? 0 };
    line.qty += n;
    if (line.qty <= 0) cart.delete(p.product_id);
    else cart.set(p.product_id, line);
    draw();
  };
  const draw = () => {
    const lines = [...cart.values()];
    cartBox.replaceChildren(table([
      { label: "Item", render: (l) => l.product.name },
      { label: "Qty", num: true, render: (l) => h("span", {}, h("button", { class: "secondary", onclick: () => add(l.product, -1) }, "−"), ` ${qty(l.qty)} `, h("button", { class: "secondary", onclick: () => add(l.product, 1) }, "+")) },
      { label: "Price", num: true, render: (l) => inr(l.price) },
      { label: "Amount", num: true, render: (l) => inr(Math.round(l.price * l.qty)) },
      { label: isRest ? "" : "In stock", num: true, render: (l) => isRest ? "" : qty(l.product.on_hand) },
    ], lines, { empty: "Cart is empty" }));
    totalBox.textContent = "Total " + inr(lines.reduce((s, l) => s + Math.round(l.price * l.qty), 0));
  };

  const search = h("input", { placeholder: isRest ? "Search menu" : "Search or type/scan barcode, Enter", style: { minWidth: "260px" } });
  const results = h("div", { class: "menu-grid" });
  const showResults = () => {
    const s = search.value.trim().toLowerCase();
    results.replaceChildren(...sellable.filter((p) => !s || p.name.toLowerCase().includes(s) || p.barcode === s).slice(0, 24)
      .map((p) => h("button", { onclick: () => add(p) }, p.name, h("small", {}, inr(p.sell_price_paise) + (isRest ? "" : ` · ${qty(p.on_hand)} left`)))));
  };
  search.oninput = showResults;
  search.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const p = sellable.find((x) => x.barcode === search.value.trim());
    if (p) { add(p); search.value = ""; showResults(); }
  };
  const scanBtn = h("button", { class: "secondary", onclick: async () => {
    const code = await scanBarcode();
    if (!code) return;
    const p = sellable.find((x) => x.barcode === code);
    p ? add(p) : toast(`No product with barcode ${code}. Add it under ${words().stock}.`, "err");
  } }, "📷 Scan");

  const mode = select([["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["credit", "Udhaar (khata)"]], "cash");
  const channel = select(isRest ? [["dine_in", "Dine-in"], ["takeaway", "Takeaway"], ["counter", "Counter"]] : [["counter", "Counter"]], isRest ? "dine_in" : "counter");
  const customer = h("input", { placeholder: "Customer name (for udhaar)" });
  const checkout = h("button", { onclick: (e) => busy(e.target, async () => {
    if (!cart.size) throw new Error("Cart is empty");
    const res = await rpc("record_sale", {
      p_items: [...cart.values()].map((l) => ({ product_id: l.product.product_id, qty: l.qty, unit_price_paise: l.price })),
      p_payment_mode: mode.value, p_channel: channel.value, p_khata_customer: customer.value || null,
    });
    toast(`Sale saved: ${inr(res.total_paise)} (profit ${inr(res.profit_paise)})`);
    if (res.shortages?.length) toast(`${res.shortages.length} item(s) sold beyond recorded stock — check your counts`, "info");
    cart.clear();
    customer.value = "";
    await loadProducts();
    draw();
  }) }, "Complete sale");

  showResults();
  draw();
  return h("div", {},
    h("h2", {}, isRest ? "Take order" : "Sell"),
    h("div", { class: "grid" },
      card(isRest ? "Menu" : "Items", h("div", { class: "row" }, search, isRest ? null : scanBtn), h("p"), results),
      card("Bill", cartBox, h("p", {}, totalBox),
        h("div", { class: "row" }, field("Payment", mode), field("Channel", channel), field("Customer", customer)),
        h("p", {}, checkout))));
}

// ---------------------------------------------------------------- assistant + voice / text commands
export async function assistant() {
  const history = [];
  const log = h("div", { class: "chat" });
  const say = (role, text) => {
    log.append(h("div", { class: "msg " + role }, text));
    log.scrollTop = log.scrollHeight;
  };
  say("bot", "Ask about sales, profit, stock — or give a command like “2 maggi becha”, “50 parle g aaya”, “Mehta ji 200 udhaar”.");

  const input = h("input", { placeholder: "Type a question or command…", style: { flex: 1, minWidth: "200px" } });
  const mode = select([["auto", "Auto (command or question)"], ["question", "Question only"]], "auto");

  async function handleCommandResult(res) {
    if (res.transcript) say("user", "🎤 " + res.transcript);
    if (!res.ok) return say("bot", res.reply ?? res.reason ?? "Could not understand. Please use the forms.");
    say("bot", res.reply + (res.ai === false ? "\n(rule-based — AI unavailable)" : ""));
    if (res.warnings?.length) say("bot", "⚠️ " + res.warnings.join("\n"));
    if (res.needs_confirmation) {
      const box = h("div", { class: "msg bot" },
        h("button", { onclick: (e) => busy(e.target, async () => {
          const r = await fn("voice-command", { confirm: true, draft: res.draft });
          box.replaceWith(h("div", { class: "msg bot" }, r.reply));
          await loadProducts();
        }) }, "✅ Confirm"), " ",
        h("button", { class: "secondary", onclick: () => box.replaceWith(h("div", { class: "msg bot muted" }, "Cancelled")) }, "Cancel"));
      log.append(box);
      log.scrollTop = log.scrollHeight;
    }
  }

  const send = (e) => busy(e?.submitter ?? null, async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    if (mode.value === "question") {
      say("user", text);
      const r = await fn("assistant", { question: text, history });
      history.push({ role: "user", content: text }, { role: "assistant", content: r.answer });
      say("bot", r.answer + (r.ai ? "" : "\n(summary — AI unavailable)"));
    } else {
      say("user", text);
      const r = await fn("voice-command", { text });
      if (r.intent === "question") history.push({ role: "user", content: text }, { role: "assistant", content: r.reply });
      await handleCommandResult({ ...r, transcript: undefined });
    }
  });
  const form = h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); send(e); } }, mode, input, h("button", {}, "Send"));

  let rec = null;
  const mic = h("button", { class: "secondary", type: "button", onclick: async () => {
    if (rec) { rec.stop(); rec = null; mic.textContent = "🎤 Hold to talk"; return; }
    try {
      rec = await recordAudio(async (wav) => {
        say("bot", "⏳ Listening…");
        await busy(null, async () => handleCommandResult(await fn("voice-command", { audio_base64: await fileToBase64(wav), mime_type: "audio/wav" })));
      });
      mic.textContent = "⏹ Stop recording";
    } catch (e) {
      toast("Microphone: " + e.message, "err");
    }
  } }, "🎤 Record voice note");

  return h("div", {}, h("h2", {}, "Assistant"),
    card(null, log, h("p"), form, h("p"), mic,
      h("p", { class: "muted" }, "Voice is transcribed by Gemini; commands and answers come from the chat model (Groq/Grok). Every number is computed by the database. Commands always ask for confirmation.")));
}

// ---------------------------------------------------------------- alerts
export async function alerts() {
  const list = h("div");
  const status = select([["open", "Open"], ["resolved", "Resolved"], ["dismissed", "Dismissed"]], "open", { onchange: load });
  async function load() {
    const rows = await q(supabase.from("alerts").select("*").eq("business_id", state.business.id).eq("status", status.value)
      .order("created_at", { ascending: false }).limit(200));
    list.replaceChildren(table([
      { label: "", render: (a) => h("span", { class: "pill " + a.severity }, a.kind.replace("_", " ")) },
      { label: "Message", key: "message" },
      { label: "When", render: (a) => fmtDateTime(a.created_at) },
      { label: "", render: (a) => a.status === "open" ? h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
        await q(supabase.from("alerts").update({ status: "dismissed" }).eq("id", a.id));
        load();
      }) }, "Dismiss") : "" },
    ], rows, { empty: "No alerts" }));
  }
  await load();
  return h("div", {}, h("h2", {}, "Alerts"),
    card(null, h("div", { class: "row" }, field("Status", status),
      h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
        const n = await rpc("refresh_alerts");
        toast(`Checked stock and expiry (${n} stock alerts)`);
        load();
      }) }, "Re-check now")),
    h("p", { class: "muted" }, "Alerts are recomputed daily at 06:00 IST and after every stock movement. Linked Telegram chats get them at 07:00."),
    list));
}
