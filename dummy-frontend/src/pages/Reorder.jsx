// Forecast-driven reorder suggestions, purchase orders and suppliers.
import { ClipboardList, Plus, Repeat, Truck } from "lucide-react";
import { Button, Card, Field, Form, Loaded, MethodPill, Page, Pill, Row, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, from, mine, q, rpc, rpcRaw } from "../lib/api.js";
import { fmtDate, fmtDateTime, inr, qty } from "../lib/format.js";

export function Reorder() {
  const toast = useToast();
  const state = useLoad(async () => {
    const [suggestions, orders] = await Promise.all([
      rpc("reorder_suggestions"),
      q(mine("purchase_orders", "*, suppliers(name, phone), purchase_order_items(qty, unit_cost_paise, products(name, unit))").order("created_at", { ascending: false }).limit(30)),
    ]);
    return { suggestions, orders };
  });
  const setStatus = async (id, status) => { await q(from("purchase_orders").update({ status }).eq("id", id)); state.reload(); };

  return (
    <Page title="Reorder">
      <Card icon={Repeat} title="Suggestions">
        <div className="grid gap-1 rounded-lg bg-surface-2 px-3 py-2.5">
          <div><strong>Reorder point</strong> = forecast demand over the supplier lead time + safety stock</div>
          <div><strong>Safety stock</strong> = Σ (forecast upper bound − forecast) over the lead time, so uncertain items keep more buffer</div>
          <div className="text-muted">Items without a forecast use the 28-day average, and new items a rule. Perishables are ordered for their shelf life only.</div>
        </div>
        <div className="my-3">
          <Button onClick={async () => { const r = await rpc("create_draft_purchase_orders"); toast(`${r.orders_created} draft order(s), ${r.lines} line(s)`); state.reload(); }}>
            Create draft purchase orders
          </Button>
        </div>
        <Loaded state={state}>{({ suggestions }) => (
          <Table rows={suggestions} rowKey={(r) => r.product_id} empty="Nothing needs reordering." columns={[
            { label: "Item", key: "name" },
            { label: "On hand", num: true, render: (r) => `${qty(r.on_hand)} ${r.unit}` },
            { label: "Daily use", num: true, render: (r) => qty(r.avg_daily_demand) },
            { label: "Safety stock", num: true, render: (r) => qty(r.safety_stock) },
            { label: "Reorder point", num: true, render: (r) => qty(r.reorder_point) },
            { label: "Order", num: true, render: (r) => <strong>{qty(r.suggested_qty)}</strong> },
            { label: "Supplier", render: (r) => r.supplier_name ?? "-" },
            { label: "Rate", num: true, render: (r) => inr(r.unit_cost_paise) },
            { label: "Next expiry", render: (r) => fmtDate(r.next_expiry) },
            { label: "Based on", render: (r) => <MethodPill method={r.method} /> },
          ]} />
        )}</Loaded>
      </Card>
      <Card icon={ClipboardList} title="Purchase orders">
        <Loaded state={state}>{({ orders }) => (
          <Table rows={orders} rowKey={(o) => o.id} empty="No purchase orders yet." columns={[
            { label: "Created", render: (o) => fmtDateTime(o.created_at) },
            { label: "Supplier", render: (o) => o.suppliers?.name ?? "No supplier" },
            { label: "Items", render: (o) => o.purchase_order_items.map((i) => `${qty(i.qty)} ${i.products.unit} ${i.products.name}`).join(", ") },
            { label: "Total", num: true, render: (o) => inr(o.total_paise) },
            { label: "Status", render: (o) => <Pill>{o.status}</Pill> },
            { label: "", render: (o) => (
              <Row>
                {o.status === "draft" && <Button small variant="secondary" onClick={async () => {
                  const text = `Order from ${current.business.name}:\n` + o.purchase_order_items.map((i) => `- ${qty(i.qty)} ${i.products.unit} ${i.products.name}`).join("\n");
                  await navigator.clipboard?.writeText(text).catch(() => {});
                  toast("Marked sent. Order text copied to share on Telegram.");
                  await setStatus(o.id, "sent");
                }}>Mark sent</Button>}
                {["draft", "sent"].includes(o.status) && <Button small onClick={async () => {
                  await rpcRaw("receive_purchase_order", { p_po_id: o.id });
                  toast("Goods received. Stock updated.");
                  state.reload();
                }}>Received</Button>}
                {["draft", "sent"].includes(o.status) && <Button small variant="secondary" onClick={() => setStatus(o.id, "cancelled")}>Cancel</Button>}
              </Row>) },
          ]} />
        )}</Loaded>
      </Card>
    </Page>
  );
}

export function Suppliers() {
  const state = useLoad(() => q(mine("suppliers", "*, supplier_prices(price_paise, updated_at, products(name, unit))").order("name")));
  return (
    <Page title="Suppliers" intro="Prices update from every purchase; reorder picks the preferred or cheapest supplier.">
      <Card icon={Plus} title="Add">
        <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v, form) => {
          await q(from("suppliers").insert({ business_id: current.business.id, name: v.name, phone: v.phone || null, gstin: v.gstin || null }));
          form.reset();
          state.reload();
        }}>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Phone"><input name="phone" /></Field>
          <Field label="GSTIN"><input name="gstin" /></Field>
          <Submit>Add supplier</Submit>
        </Form>
      </Card>
      <Card icon={Truck} title="Suppliers">
        <Loaded state={state}>{(rows) => (
          <Table rows={rows} rowKey={(s) => s.id} columns={[
            { label: "Name", key: "name" },
            { label: "Phone", key: "phone" },
            { label: "GSTIN", key: "gstin" },
            { label: "In network", render: (s) => (s.wholesaler_business_id ? "✓" : "") },
            { label: "Last prices", render: (s) => s.supplier_prices.slice(0, 6).map((p) => `${p.products.name} ${inr(p.price_paise)}/${p.products.unit}`).join(" · ") },
          ]} />
        )}</Loaded>
      </Card>
    </Page>
  );
}
