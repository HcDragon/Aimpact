// Stock / pantry: catalog, batches (earliest expiry first) and physical counts.
import { useState } from "react";
import { BarcodeScanner, Button, Card, Field, Form, Loaded, Page, Row, Select, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, from, isRestaurant, loadProducts, mine, q, rpc, words } from "../lib/api.js";
import { GST_RATES, UNITS, fmtDate, inr, qty, rupees, toPaise } from "../lib/format.js";

export function Stock() {
  const w = words();
  const rest = isRestaurant();
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState(rest ? "ingredient" : "product");
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new, row = edit
  const state = useLoad(async () => {
    const [products, suppliers] = await Promise.all([loadProducts(), q(mine("suppliers").order("name"))]);
    return { products, suppliers };
  });

  return (
    <Page title={w.stock} intro="Stock is tracked per batch so expiry dates stay accurate. Add stock through Purchases (bill scan or manual).">
      <Loaded state={state}>{({ products, suppliers }) => {
        const s = filter.toLowerCase();
        const rows = products.filter((p) => (!kind || p.kind === kind) && (!s || p.name.toLowerCase().includes(s) || p.barcode?.includes(s)));
        return (
          <>
            {editing !== undefined && (
              <Editor key={editing?.product_id ?? "new"} product={editing} suppliers={suppliers}
                onClose={() => setEditing(undefined)} onSaved={async (keepOpen) => { await state.reload(); if (!keepOpen) setEditing(undefined); }} />
            )}
            <Card>
              <Row className="mb-3">
                <input aria-label="Filter" placeholder="Filter by name or barcode…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}
                  options={rest ? [["ingredient", "Ingredients"], ["dish", "Menu dishes"], ["", "All"]] : [["product", "Products"], ["", "All"]]} />
                <Button onClick={() => setEditing(null)}>+ Add {w.product}</Button>
              </Row>
              <Table rows={rows} rowKey={(p) => p.product_id} columns={[
                { label: "Name", render: (p) => <Button variant="link" onClick={() => setEditing(p)}>{p.name}</Button> },
                { label: "Category", key: "category" },
                { label: "On hand", num: true, render: (p) => (p.kind === "dish" ? "—" : `${qty(p.on_hand)} ${p.unit}`) },
                { label: "Next expiry", render: (p) => fmtDate(p.next_expiry) },
                { label: "Sell", num: true, render: (p) => inr(p.sell_price_paise) },
                { label: "Cost", num: true, render: (p) => inr(p.cost_price_paise) },
                { label: "GST", num: true, render: (p) => p.gst_rate + "%" },
                { label: "Value", num: true, render: (p) => inr(p.stock_value_paise) },
              ]} />
            </Card>
          </>
        );
      }}</Loaded>
    </Page>
  );
}

function Editor({ product: p, suppliers, onClose, onSaved }) {
  const toast = useToast();
  const rest = isRestaurant();
  const [scanning, setScanning] = useState(false);
  const [barcode, setBarcode] = useState("");
  const state = useLoad(async () => {
    if (!p) return { full: {}, batches: [] };
    const [full, batches] = await Promise.all([
      q(from("products").select("*").eq("id", p.product_id).single()),
      p.kind === "dish" ? [] : q(from("stock_batches").select("*").eq("product_id", p.product_id).gt("qty_remaining", 0).order("expiry_date")),
    ]);
    setBarcode(full.barcode ?? "");
    return { full, batches };
  });

  const save = async (v) => {
    const row = {
      business_id: current.business.id, name: v.name.trim(), kind: v.kind, category: v.category || null, unit: v.unit,
      barcode: barcode || null, hsn_code: v.hsn_code || null, gst_rate: Number(v.gst_rate),
      sell_price_paise: toPaise(v.sell), mrp_paise: toPaise(v.mrp), cost_price_paise: toPaise(v.cost),
      reorder_level: v.reorder_level === "" ? null : Number(v.reorder_level),
      reorder_qty: v.reorder_qty === "" ? null : Number(v.reorder_qty),
      preferred_supplier_id: v.preferred_supplier_id || null,
    };
    if (p) await q(from("products").update(row).eq("id", p.product_id));
    else await q(from("products").insert(row));
    toast(p ? "Saved" : "Added. Its search embedding is queued.");
    await onSaved(false);
  };

  return (
    <Loaded state={state}>{({ full, batches }) => (
      <Card title={p ? `Edit ${full.name}` : `New ${words().product}`}>
        {scanning && <BarcodeScanner onResult={(c) => { setScanning(false); if (c) setBarcode(c); }} />}
        <Form onSubmit={save}>
          <Row>
            <Field label="Name"><input name="name" defaultValue={full.name ?? ""} required /></Field>
            <Field label="Kind"><Select name="kind" defaultValue={full.kind ?? (rest ? "ingredient" : "product")}
              options={rest ? [["ingredient", "Ingredient"], ["dish", "Dish"]] : [["product", "Product"]]} /></Field>
            <Field label="Category"><input name="category" defaultValue={full.category ?? ""} /></Field>
            <Field label="Unit"><Select name="unit" defaultValue={full.unit ?? "pcs"} options={UNITS.map((u) => [u, u])} /></Field>
          </Row>
          <Row className="mt-2">
            <Field label="Barcode"><span className="flex gap-1"><input value={barcode} onChange={(e) => setBarcode(e.target.value)} />
              <Button variant="secondary" aria-label="Scan barcode" onClick={() => setScanning(true)}>📷</Button></span></Field>
            <Field label="HSN"><input name="hsn_code" defaultValue={full.hsn_code ?? ""} size={8} /></Field>
            <Field label="GST %"><Select name="gst_rate" defaultValue={full.gst_rate ?? 0} options={GST_RATES.map((r) => [r, r + "%"])} /></Field>
          </Row>
          <Row className="mt-2">
            <Field label="Selling price ₹ (incl. GST)"><input name="sell" type="number" step="0.01" defaultValue={rupees(full.sell_price_paise)} /></Field>
            <Field label="MRP ₹"><input name="mrp" type="number" step="0.01" defaultValue={rupees(full.mrp_paise)} /></Field>
            <Field label="Cost ₹ (excl. GST)"><input name="cost" type="number" step="0.01" defaultValue={rupees(full.cost_price_paise)} /></Field>
            <Field label="Manual reorder level"><input name="reorder_level" type="number" step="0.001" defaultValue={full.reorder_level ?? ""} /></Field>
            <Field label="Min order qty"><input name="reorder_qty" type="number" step="0.001" defaultValue={full.reorder_qty ?? ""} /></Field>
            <Field label="Preferred supplier"><Select name="preferred_supplier_id" defaultValue={full.preferred_supplier_id ?? ""}
              options={[["", "—"], ...suppliers.map((s) => [s.id, s.name])]} /></Field>
          </Row>
          <Row className="mt-3"><Submit>{p ? "Save" : "Add"}</Submit><Button variant="secondary" onClick={onClose}>Close</Button></Row>
        </Form>

        {p && p.kind !== "dish" && (
          <div className="mt-5">
            <h3>Batches (earliest expiry is used first)</h3>
            <Table rows={batches} rowKey={(b) => b.id} columns={[
              { label: "Batch", render: (b) => b.batch_no ?? "-" },
              { label: "Received", render: (b) => fmtDate(b.received_at) },
              { label: "Expiry", render: (b) => fmtDate(b.expiry_date) },
              { label: "Left", num: true, render: (b) => `${qty(b.qty_remaining)} / ${qty(b.qty_received)}` },
              { label: "Cost", num: true, render: (b) => inr(b.unit_cost_paise) },
            ]} />
            <h3 className="mt-4">Physical stock count</h3>
            <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v) => {
              const r = await rpc("adjust_stock", { p_product_id: p.product_id, p_counted_qty: Number(v.counted), p_expiry_date: v.expiry || null });
              toast(`Stock ${qty(r.previous_qty)} → ${qty(r.new_qty)}`);
              await onSaved(true);
              state.reload();
            }}>
              <Field label={`Counted qty (${full.unit})`}><input name="counted" type="number" step="0.001" required /></Field>
              <Field label="Expiry (if adding)"><input name="expiry" type="date" /></Field>
              <Submit>Set stock to count</Submit>
            </Form>
          </div>
        )}
      </Card>
    )}</Loaded>
  );
}
