// Insights computed in Postgres: perishable risk (expiry vs forecast use), dead stock, bundles (Apriori).
import { PackageX, ShoppingBasket, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Card, Field, Loaded, Page, Pill, Select, Table, useLoad } from "../components/ui.jsx";
import { isRestaurant, loadProducts, mine, productName, q, rpc, words } from "../lib/api.js";
import { fmtDate, inr, qty, round1 } from "../lib/format.js";

export function Insights() {
  const ready = useLoad(() => loadProducts());
  return (
    <Page title="Insights" intro="Every number here is computed by the database from your own sales, stock and forecasts.">
      <Loaded state={ready}>{() => (
        <>
          <PerishableRisk />
          <DeadStock />
          {!isRestaurant() && <Bundles />}
        </>
      )}</Loaded>
    </Page>
  );
}

export function PerishableRisk() {
  const state = useLoad(() => rpc("perishable_risk"));
  return (
    <Card icon={TriangleAlert} title="Use first: stock that may expire before it is used">
      <Loaded state={state}>{(rows) => {
        const risky = rows.filter((r) => Number(r.at_risk_qty) > 0);
        return (
          <>
            <p className="mb-2 text-muted">Batches are used earliest-expiry first. Demand until each batch's recorded expiry comes from the nightly forecast (or the 28-day average).{" "}
              {risky.length ? <strong className="text-ink">{inr(risky.reduce((s, r) => s + Number(r.at_risk_value_paise), 0))} at risk.</strong> : "Nothing is at risk."}</p>
            <Table rows={rows} rowKey={(r) => r.batch_id} empty="No batches with a recorded expiry date." columns={[
              { label: "Item", key: "name" },
              { label: "Batch", render: (r) => <span className="whitespace-nowrap">{r.batch_no ?? "-"}</span> },
              { label: "Qty", num: true, render: (r) => `${qty(round1(r.qty_remaining))} ${r.unit}` },
              { label: "Expires", render: (r) => <Pill tone={r.days_left <= 1 ? "critical" : "warning"}>{r.days_left <= 0 ? "today" : `${fmtDate(r.expiry_date)} (${r.days_left}d)`}</Pill> },
              { label: "Will be used", num: true, render: (r) => `${qty(round1(r.use_before_expiry))} ${r.unit}` },
              { label: "At risk", num: true, render: (r) => (Number(r.at_risk_qty) > 0 ? <strong className="whitespace-nowrap">{qty(round1(r.at_risk_qty))} {r.unit} · {inr(r.at_risk_value_paise)}</strong> : "—") },
              { label: "Suggestion", render: (r) => (Number(r.at_risk_qty) > 0 ? (isRestaurant() ? "Push dishes that use it, or a special" : "Discount or bundle it now") : "Use / sell first") },
              { label: "Basis", render: (r) => <Pill>{r.basis}</Pill> },
            ]} />
          </>
        );
      }}</Loaded>
    </Card>
  );
}

function DeadStock() {
  const [days, setDays] = useState(30);
  const state = useLoad(() => rpc("dead_stock", { p_days: days }), [days]);
  return (
    <Card icon={PackageX} title={`Dead ${words().stock.toLowerCase()}`}>
      <Field label="Unsold for"><Select value={days} onChange={(e) => setDays(Number(e.target.value))} options={[[30, "30+ days"], [60, "60+ days"], [90, "90+ days"]]} /></Field>
      <div className="mt-3">
        <Loaded state={state}>{(rows) => (
          <>
            <p className="mb-2">{rows.length ? `${rows.length} item(s), ${inr(rows.reduce((s, r) => s + Number(r.stock_value_paise), 0))} of stock not moving.` : "Everything is moving 👍"}</p>
            <Table rows={rows} rowKey={(r) => r.product_id} empty="" columns={[
              { label: "Item", key: "name" },
              { label: "On hand", num: true, render: (r) => `${qty(r.on_hand)} ${r.unit}` },
              { label: "Value", num: true, render: (r) => inr(r.stock_value_paise) },
              { label: "Last sold / used", render: (r) => (r.last_used ? fmtDate(r.last_used) : "never") },
              { label: "Days idle", num: true, key: "days_unsold" },
              { label: "Suggested discount", render: (r) => <Pill tone="warning">{r.suggested_discount}</Pill> },
            ]} />
          </>
        )}</Loaded>
      </div>
    </Card>
  );
}

function Bundles() {
  const state = useLoad(() => q(mine("bundle_suggestions").order("lift", { ascending: false }).limit(20)));
  return (
    <Card icon={ShoppingBasket} title="Frequently bought together">
      <p className="mb-2 text-muted">Apriori over the last 90 days of bills, written by the nightly job. Lift 2.0 means customers who buy the first item are twice as likely as average to buy the second. Only lift ≥ 1.2 is kept. The POS suggests these at checkout.</p>
      <Loaded state={state}>{(rows) => (
        <Table rows={rows} rowKey={(r) => r.id} empty="No bundles yet. They appear after python forecasting/run_forecasts.py." columns={[
          { label: "If they buy", render: (r) => r.antecedent_ids.map(productName).join(" + ") },
          { label: "Suggest", render: (r) => <strong>{r.consequent_ids.map(productName).join(" + ")}</strong> },
          { label: "Lift", num: true, render: (r) => Number(r.lift).toFixed(2) },
          { label: "Confidence", num: true, render: (r) => Math.round(Number(r.confidence) * 100) + "%" },
          { label: "Share of bills", num: true, render: (r) => (Number(r.support) * 100).toFixed(1) + "%" },
        ]} />
      )}</Loaded>
    </Card>
  );
}
