// Restaurant kitchen: morning prep list, recipes, Zomato/Swiggy CSV import; wastage (both business types).
import { ChefHat, History, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button, Card, Field, Form, Kpi, Kpis, Loaded, Page, Pill, Row, Select, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, fn, from, loadProducts, mine, q, rpc, words } from "../lib/api.js";
import { fmtDateTime, inr, istToday, qty } from "../lib/format.js";
import { PerishableRisk } from "./Insights.jsx";

export function Prep() {
  const [day, setDay] = useState(istToday());
  const state = useLoad(() => rpc("prep_list", { p_day: day }), [day]);
  return (
    <Page title="Morning prep list">
      <Card icon={ChefHat} title="Prep for the day">
        <Field label="For"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <div className="mt-3">
          <Loaded state={state}>{(rows) => (
            <>
              <p className="mb-2">{rows.reduce((s, r) => s + Number(r.prep_qty), 0)} portions to prep across {rows.filter((r) => Number(r.prep_qty) > 0).length} dishes.</p>
              <Table rows={rows} rowKey={(r) => r.dish_id} empty="Add dishes (kind = Dish) in Pantry and record some sales first." columns={[
                { label: "Dish", key: "name" },
                { label: "Expected", num: true, render: (r) => qty(r.expected) },
                { label: "Avg wasted / day", num: true, render: (r) => qty(r.avg_daily_wastage) },
                { label: "Prep", num: true, render: (r) => <strong>{qty(r.prep_qty)}</strong> },
                { label: "Basis", render: (r) => <Pill tone={r.basis === "forecast" ? "info" : ""}>{r.basis}</Pill> },
              ]} />
            </>
          )}</Loaded>
        </div>
        <p className="mt-3 text-muted">Expected = the dish forecast from the nightly job (or the same weekday's average over 4 weeks). Prep is cut by recent average wastage of that dish, by at most 30%.</p>
      </Card>
      <PerishableRisk />
    </Page>
  );
}

export function Recipes() {
  const state = useLoad(() => loadProducts());
  const [dishId, setDishId] = useState(null);
  return (
    <Page title="Recipes" intro="Selling a dish deducts its ingredients (earliest expiry first). Ingredient forecasts come from dish sales through these recipes.">
      <Loaded state={state}>{(products) => {
        const dishes = products.filter((p) => p.kind === "dish");
        const ingredients = products.filter((p) => p.kind === "ingredient");
        const dish = dishes.find((d) => d.product_id === dishId) ?? dishes[0];
        if (!dish) return <Card><p className="text-muted">Add dishes (kind = Dish) in Pantry first.</p></Card>;
        return (
          <Card>
            <Field label="Dish"><Select value={dish.product_id} onChange={(e) => setDishId(e.target.value)} options={dishes.map((d) => [d.product_id, d.name])} /></Field>
            <RecipeEditor key={dish.product_id} dish={dish} ingredients={ingredients} />
          </Card>
        );
      }}</Loaded>
    </Page>
  );
}

function RecipeEditor({ dish, ingredients }) {
  const ing = (id) => ingredients.find((i) => i.product_id === id);
  const state = useLoad(() => q(from("recipes").select("*, recipe_ingredients(id, qty, ingredient_product_id)").eq("dish_product_id", dish.product_id).maybeSingle()));
  const ensure = async (recipe, yieldQty = 1) => recipe ?? q(from("recipes").insert({ business_id: current.business.id, dish_product_id: dish.product_id, yield_qty: yieldQty }).select().single());
  return (
    <Loaded state={state}>{(recipe) => {
      const cost = (recipe?.recipe_ingredients ?? []).reduce((s, ri) => s + (ing(ri.ingredient_product_id)?.cost_price_paise ?? 0) * Number(ri.qty), 0) / Number(recipe?.yield_qty ?? 1);
      const exGst = dish.sell_price_paise ? dish.sell_price_paise / (1 + dish.gst_rate / 100) : null;
      return (
        <div className="mt-3">
          <Kpis>
            <Kpi plain label="Menu price" value={inr(dish.sell_price_paise)} />
            <Kpi plain label="Ingredient cost / plate" value={inr(Math.round(cost))} />
            <Kpi plain label="Food cost" value={exGst ? Math.round((cost / exGst) * 100) + "%" : "-"} />
          </Kpis>
          <Field label="Plates per batch (yield)">
            <input type="number" step="0.001" defaultValue={recipe?.yield_qty ?? 1} onBlur={async (e) => {
              const y = Number(e.target.value);
              if (!recipe) await ensure(null, y);
              else await q(from("recipes").update({ yield_qty: y }).eq("id", recipe.id));
              state.reload();
            }} />
          </Field>
          <div className="my-3">
            <Table rows={recipe?.recipe_ingredients ?? []} rowKey={(ri) => ri.id} empty="No ingredients yet: selling this dish won't deduct pantry stock." columns={[
              { label: "Ingredient", render: (ri) => ing(ri.ingredient_product_id)?.name ?? "?" },
              { label: "Qty", num: true, render: (ri) => `${qty(ri.qty)} ${ing(ri.ingredient_product_id)?.unit ?? ""}` },
              { label: "", render: (ri) => <Button small variant="secondary" onClick={async () => { await q(from("recipe_ingredients").delete().eq("id", ri.id)); state.reload(); }}>Remove</Button> },
            ]} />
          </div>
          <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v) => {
            const r = await ensure(recipe);
            await q(from("recipe_ingredients").upsert({ business_id: current.business.id, recipe_id: r.id, ingredient_product_id: v.ingredient, qty: Number(v.qty) },
              { onConflict: "recipe_id,ingredient_product_id" }));
            state.reload();
          }}>
            <Field label="Ingredient"><Select name="ingredient" options={ingredients.map((i) => [i.product_id, `${i.name} (${i.unit})`])} /></Field>
            <Field label="Qty per batch"><input name="qty" type="number" step="0.001" required /></Field>
            <Submit>Add / update</Submit>
          </Form>
        </div>
      );
    }}</Loaded>
  );
}

export function Wastage() {
  const toast = useToast();
  const state = useLoad(async () => {
    const [products, rows] = await Promise.all([loadProducts(), q(mine("wastage_log", "*, products(name, unit)").order("logged_at", { ascending: false }).limit(100))]);
    return { products, rows };
  });
  return (
    <Page title="Wastage" intro="Wastage counts against profit. Dish wastage also trims the next prep list.">
      <Loaded state={state}>{({ products, rows }) => (
        <>
          <Card icon={Trash2} title="Log">
            <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v, form) => {
              const r = await rpc("log_wastage", { p_product_id: v.product, p_qty: Number(v.qty), p_reason: v.reason, p_note: v.note || null });
              toast(`Logged: ${inr(r.cost_paise)} lost`);
              form.reset();
              state.reload();
            }}>
              <Field label={`${words().product} or dish`}><Select name="product" options={products.filter((p) => p.is_active)
                .map((p) => [p.product_id, p.kind === "dish" ? `${p.name} (dish)` : `${p.name} (${qty(p.on_hand)} ${p.unit})`])} /></Field>
              <Field label="Qty"><input name="qty" type="number" step="0.001" required /></Field>
              <Field label="Reason"><Select name="reason" defaultValue="spoiled" options={[["spoiled", "Spoiled"], ["expired", "Expired"], ["overcooked", "Overcooked"], ["damaged", "Damaged"], ["returned", "Returned"], ["other", "Other"]]} /></Field>
              <Field label="Note"><input name="note" /></Field>
              <Submit>Log wastage</Submit>
            </Form>
          </Card>
          <Card icon={History} title="History">
            <p className="mb-2">Last {rows.length} entries: {inr(rows.reduce((s, r) => s + Number(r.cost_paise), 0))} lost</p>
            <Table rows={rows} rowKey={(r) => r.id} columns={[
              { label: "When", render: (r) => fmtDateTime(r.logged_at) },
              { label: "Item", render: (r) => r.products.name },
              { label: "Qty", num: true, render: (r) => `${qty(r.qty)} ${r.products.unit}` },
              { label: "Reason", key: "reason" },
              { label: "Cost", num: true, render: (r) => inr(r.cost_paise) },
              { label: "Note", key: "note" },
            ]} />
          </Card>
        </>
      )}</Loaded>
    </Page>
  );
}

export function Imports() {
  const state = useLoad(async () => (await loadProducts()).filter((p) => p.kind === "dish"));
  const [channel, setChannel] = useState("zomato");
  const [result, setResult] = useState(null);
  const [mapping, setMapping] = useState({});
  const csv = useRef("");
  const fileRef = useRef(null);

  const run = async (commit) => {
    if (!csv.current) {
      const f = fileRef.current?.files[0];
      if (!f) throw new Error("Choose the CSV export first");
      csv.current = await f.text();
    }
    const r = await fn("import-orders-csv", { channel, csv_text: csv.current, commit, mapping });
    const m = { ...mapping };
    for (const u of r.unmatched_items) m[u.name] ??= u.suggestion?.product_id ?? "";
    setMapping(m);
    setResult({ ...r, commit });
  };

  return (
    <Page title="Zomato / Swiggy import" intro="Upload the order-history CSV from the partner dashboard. Re-importing the same file is safe: orders are matched by order ID.">
      <Card>
        <Row>
          <Field label="Platform"><Select value={channel} onChange={(e) => setChannel(e.target.value)} options={[["zomato", "Zomato"], ["swiggy", "Swiggy"]]} /></Field>
          <Field label="CSV file"><input ref={fileRef} type="file" accept=".csv,text/csv" onChange={() => { csv.current = ""; }} /></Field>
          <Button onClick={() => run(false)}>Preview</Button>
        </Row>
      </Card>
      <Loaded state={state}>{(dishes) => result && (
        <Card title={result.commit ? "Imported" : "Preview"}>
          <p>{result.orders_found} orders found, {result.orders_ready} ready, {result.skipped_cancelled} cancelled skipped.</p>
          <p className="text-muted">Columns used: {Object.entries(result.columns).map(([k, v]) => `${k} → ${v ?? "—"}`).join(", ")}</p>
          {result.result && <p>✅ Imported {result.result.imported}, already imported {result.result.duplicates}, errors {result.result.errors.length}</p>}
          {result.unmatched_items.length > 0 && (
            <div className="mt-3">
              <h3>Match these items to your menu</h3>
              <Table rows={result.unmatched_items} rowKey={(u) => u.name} columns={[
                { label: "In CSV", key: "name" },
                { label: "Your dish", render: (u) => <Select value={mapping[u.name] ?? ""} onChange={(e) => setMapping({ ...mapping, [u.name]: e.target.value })}
                  options={[["", "— skip orders with this —"], ...dishes.map((d) => [d.product_id, d.name])]} /> },
              ]} />
            </div>
          )}
          {!result.commit && <Row className="mt-3"><Button variant="secondary" onClick={() => run(false)}>Re-check</Button><Button onClick={() => run(true)}>Import orders</Button></Row>}
        </Card>
      )}</Loaded>
    </Page>
  );
}
