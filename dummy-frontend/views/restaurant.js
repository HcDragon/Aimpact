// Restaurant-only (recipes, CSV import) and wastage (both types).
import { busy, card, field, fmtDateTime, fn, formValues, h, inr, loadProducts, q, qty, rpc, select, state, supabase, table, toast, words } from "../lib.js";

// ---------------------------------------------------------------- recipes
export async function recipes() {
  const products = await loadProducts();
  const dishes = products.filter((p) => p.kind === "dish");
  const ingredients = products.filter((p) => p.kind === "ingredient");
  const box = h("div");
  const dishSel = select(dishes.map((d) => [d.product_id, d.name]), dishes[0]?.product_id);

  async function draw() {
    const dish = dishes.find((d) => d.product_id === dishSel.value);
    if (!dish) return box.replaceChildren(h("p", { class: "muted" }, "Add dishes (kind = Dish) in Pantry first."));
    let recipe = await q(supabase.from("recipes").select("*, recipe_ingredients(id, qty, ingredient_product_id)").eq("dish_product_id", dish.product_id).maybeSingle());
    const cost = (recipe?.recipe_ingredients ?? []).reduce((s, ri) => {
      const ing = ingredients.find((i) => i.product_id === ri.ingredient_product_id);
      return s + (ing?.cost_price_paise ?? 0) * Number(ri.qty);
    }, 0) / Number(recipe?.yield_qty ?? 1);
    const addForm = h("form", { class: "row" },
      field("Ingredient", select(ingredients.map((i) => [i.product_id, `${i.name} (${i.unit})`]), null, { name: "ingredient" })),
      field("Qty per batch", h("input", { name: "qty", type: "number", step: "0.001", required: true })),
      h("button", {}, "Add / update"));
    addForm.onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        const v = formValues(addForm);
        if (!recipe) recipe = await q(supabase.from("recipes").insert({ business_id: state.business.id, dish_product_id: dish.product_id, yield_qty: 1 }).select().single());
        await q(supabase.from("recipe_ingredients").upsert({ business_id: state.business.id, recipe_id: recipe.id, ingredient_product_id: v.ingredient, qty: Number(v.qty) }, { onConflict: "recipe_id,ingredient_product_id" }));
        draw();
      });
    };
    const yieldInput = h("input", { type: "number", step: "0.001", value: recipe?.yield_qty ?? 1, onchange: (e) => busy(null, async () => {
      if (!recipe) recipe = await q(supabase.from("recipes").insert({ business_id: state.business.id, dish_product_id: dish.product_id, yield_qty: Number(e.target.value) }).select().single());
      else await q(supabase.from("recipes").update({ yield_qty: Number(e.target.value) }).eq("id", recipe.id));
      draw();
    }) });
    box.replaceChildren(
      h("p", {}, `Menu price ${inr(dish.sell_price_paise)} · ingredient cost per plate ≈ ${inr(Math.round(cost))} · food cost ${dish.sell_price_paise ? Math.round((cost / (dish.sell_price_paise / (1 + dish.gst_rate / 100))) * 100) : "-"}%`),
      field("Plates per batch (yield)", yieldInput), h("p"),
      table([
        { label: "Ingredient", render: (ri) => ingredients.find((i) => i.product_id === ri.ingredient_product_id)?.name ?? "?" },
        { label: "Qty", num: true, render: (ri) => `${qty(ri.qty)} ${ingredients.find((i) => i.product_id === ri.ingredient_product_id)?.unit ?? ""}` },
        { label: "", render: (ri) => h("button", { class: "secondary", onclick: (e) => busy(e.target, async () => {
          await q(supabase.from("recipe_ingredients").delete().eq("id", ri.id));
          draw();
        }) }, "Remove") },
      ], recipe?.recipe_ingredients ?? [], { empty: "No ingredients yet — selling this dish won't deduct pantry stock." }),
      h("p"), addForm);
  }
  dishSel.onchange = draw;
  await draw();
  return h("div", {}, h("h2", {}, "Recipes"),
    card(null, h("p", { class: "muted" }, "Selling a dish deducts its ingredients from the pantry (earliest expiry first)."), field("Dish", dishSel), h("p"), box));
}

// ---------------------------------------------------------------- wastage
export async function wastage() {
  const products = (await loadProducts()).filter((p) => p.kind !== "dish");
  const list = h("div");
  async function load() {
    const rows = await q(supabase.from("wastage_log").select("*, products(name, unit)").eq("business_id", state.business.id).order("logged_at", { ascending: false }).limit(100));
    const total = rows.reduce((s, r) => s + Number(r.cost_paise), 0);
    list.replaceChildren(h("p", {}, `Last ${rows.length} entries: ${inr(total)} lost`), table([
      { label: "When", render: (r) => fmtDateTime(r.logged_at) },
      { label: "Item", render: (r) => r.products.name },
      { label: "Qty", num: true, render: (r) => `${qty(r.qty)} ${r.products.unit}` },
      { label: "Reason", key: "reason" },
      { label: "Cost", num: true, render: (r) => inr(r.cost_paise) },
      { label: "Note", key: "note" },
    ], rows));
  }
  const form = h("form", { class: "row" },
    field(words().product, select(products.map((p) => [p.product_id, `${p.name} (${qty(p.on_hand)} ${p.unit})`]), null, { name: "product" })),
    field("Qty", h("input", { name: "qty", type: "number", step: "0.001", required: true })),
    field("Reason", select([["spoiled", "Spoiled"], ["expired", "Expired"], ["overcooked", "Overcooked"], ["damaged", "Damaged"], ["returned", "Returned"], ["other", "Other"]], "spoiled", { name: "reason" })),
    field("Note", h("input", { name: "note" })),
    h("button", {}, "Log wastage"));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      const r = await rpc("log_wastage", { p_product_id: v.product, p_qty: Number(v.qty), p_reason: v.reason, p_note: v.note || null });
      toast(`Logged — ${inr(r.cost_paise)} lost`);
      form.reset();
      load();
    });
  };
  await load();
  return h("div", {}, h("h2", {}, "Wastage"), card("Log", form), card("History", list));
}

// ---------------------------------------------------------------- Zomato / Swiggy CSV import
export async function imports() {
  const dishes = (await loadProducts()).filter((p) => p.kind === "dish");
  const channel = select([["zomato", "Zomato"], ["swiggy", "Swiggy"]], "zomato");
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const out = h("div");
  let csvText = "";
  const mapping = {};

  async function run(commit, btn) {
    await busy(btn, async () => {
      if (!csvText) {
        if (!file.files[0]) throw new Error("Choose the CSV export first");
        csvText = await file.files[0].text();
      }
      const r = await fn("import-orders-csv", { channel: channel.value, csv_text: csvText, commit, mapping });
      out.replaceChildren(card(commit ? "Imported" : "Preview",
        h("p", {}, `${r.orders_found} orders found, ${r.orders_ready} ready, ${r.skipped_cancelled} cancelled skipped.`),
        h("p", { class: "muted" }, "Columns used: " + Object.entries(r.columns).map(([k, v]) => `${k} → ${v ?? "—"}`).join(", ")),
        r.result ? h("p", {}, `✅ Imported ${r.result.imported}, already imported ${r.result.duplicates}, errors ${r.result.errors.length}`) : null,
        r.unmatched_items.length ? h("div", {}, h("h3", {}, "Match these items to your menu"),
          table([
            { label: "In CSV", key: "name" },
            { label: "Your dish", render: (u) => select([["", "— skip orders with this —"], ...dishes.map((d) => [d.product_id, d.name])],
              mapping[u.name] ?? u.suggestion?.product_id ?? "", { onchange: (e) => (mapping[u.name] = e.target.value) }) },
          ], r.unmatched_items.map((u) => { mapping[u.name] ??= u.suggestion?.product_id ?? ""; return u; }))) : null,
        !commit ? h("p", { class: "row" }, h("button", { class: "secondary", onclick: (e) => run(false, e.target) }, "Re-check"),
          h("button", { onclick: (e) => run(true, e.target) }, "Import orders")) : null));
    });
  }
  file.onchange = () => { csvText = ""; };
  return h("div", {}, h("h2", {}, "Zomato / Swiggy import"),
    card(null, h("p", { class: "muted" }, "Upload the order history CSV from the partner dashboard. Re-importing the same file is safe — orders are matched by order ID."),
      h("div", { class: "row" }, field("Platform", channel), field("CSV file", file), h("button", { onclick: (e) => run(false, e.target) }, "Preview"))),
    out);
}
