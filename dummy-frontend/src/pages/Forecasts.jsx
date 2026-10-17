// Demand forecasts written nightly by forecasting/run_forecasts.py (model: forecasting/model.py -> ml/),
// and the honest model-vs-baseline evaluation from forecasting/evaluate_forecasts.py.
import { FlaskConical, Gauge, LineChart as LineChartIcon } from "lucide-react";
import { useState } from "react";
import { BarPairs, LineChart } from "../components/charts.jsx";
import { Card, Field, Kpi, Kpis, Loaded, MethodPill, Page, Pill, Select, Table, useLoad } from "../components/ui.jsx";
import { from, loadProducts, mine, q } from "../lib/api.js";
import { METHOD_LABEL, daysAgo, fmtDate, fmtDateTime, istToday, pct, qty, round1 } from "../lib/format.js";

const TIER_LABEL = { prophet: "Top sellers (Prophet)", category: "Slow movers (category model)", moving_avg: "Slow movers (moving average)" };

export function Forecasts() {
  const state = useLoad(async () => {
    const [products, fc, evals] = await Promise.all([
      loadProducts(),
      q(mine("forecasts", "product_id, forecast_date, yhat, yhat_lower, yhat_upper, method, generated_at").gt("forecast_date", daysAgo(1)).order("forecast_date")),
      q(mine("forecast_evaluations").order("generated_at", { ascending: false }).limit(1)).catch(() => []),
    ]);
    const methodOf = new Map(fc.map((f) => [f.product_id, f.method]));
    const items = products.filter((p) => p.is_active && (methodOf.has(p.product_id) || p.kind !== "dish"));
    return { fc, methodOf, items, evaluation: evals[0] };
  });

  return (
    <Page title="Demand forecasts" intro="Written nightly by the Python job; this page only reads them. Indian holidays and festival windows (Diwali, Holi, Eid, Ganesh Chaturthi) are built in.">
      <Loaded state={state}>{({ fc, methodOf, items, evaluation }) => {
        const counts = {};
        for (const m of methodOf.values()) counts[m] = (counts[m] ?? 0) + 1;
        return (
          <>
            <Card icon={Gauge} title="Coverage">
              <Kpis cols="sm:grid-cols-3 lg:grid-cols-5">
                {["prophet", "category", "moving_average", "seasonal_naive"].map((m) => <Kpi plain key={m} label={METHOD_LABEL[m]} value={counts[m] ?? 0} hint="items" />)}
                <Kpi plain label="No forecast" value={items.filter((p) => p.kind !== "dish" && !methodOf.has(p.product_id)).length} hint="new or rare: rule-based reorder" />
              </Kpis>
              <p className="text-muted">The top ~20% of items by volume get their own Prophet model; slow movers share a category model or a 28-day average. Where the last evaluation showed the simple baseline winning, it is used instead.</p>
            </Card>
            <ItemForecast fc={fc} methodOf={methodOf} items={items} />
            <Evaluation ev={evaluation} />
          </>
        );
      }}</Loaded>
    </Page>
  );
}

function ItemForecast({ fc, methodOf, items }) {
  const first = items.find((p) => methodOf.get(p.product_id) === "prophet") ?? items.find((p) => methodOf.has(p.product_id)) ?? items[0];
  const [pid, setPid] = useState(first?.product_id);
  const p = items.find((x) => x.product_id === pid);
  const hist = useLoad(async () => {
    if (!p) return [];
    // Dishes: plates sold; stocked items: daily use (restaurant ingredients are exploded through recipes).
    const view = p.kind === "dish" ? "daily_product_sales" : "daily_usage";
    return q(from(view).select("day, qty").eq("product_id", p.product_id).gte("day", daysAgo(42)).order("day"));
  }, [pid]);
  if (!p) return <Card icon={LineChartIcon} title="Item forecast"><p className="text-muted">No items yet.</p></Card>;
  const f = fc.filter((x) => x.product_id === p.product_id);

  return (
    <Card title="Item forecast">
      <Field label="Item (★ has a forecast)">
        <Select value={pid} onChange={(e) => setPid(e.target.value)}
          options={items.map((x) => [x.product_id, `${methodOf.has(x.product_id) ? "★ " : ""}${x.name}${x.kind === "dish" ? " (dish)" : ""}`])} />
      </Field>
      <div className="mt-3">
        <Loaded state={hist}>{(rows) => {
          const byDay = new Map();
          for (const u of rows) byDay.set(u.day, (byDay.get(u.day) ?? 0) + Number(u.qty));
          // Up to yesterday: today's partial sales would read as a dip.
          const actual = Array.from({ length: 42 }, (_, i) => { const d = daysAgo(42 - i); return { x: d, y: byDay.get(d) ?? 0 }; });
          return (
            <LineChart marker={istToday()} series={[
              { label: p.kind === "dish" ? "Plates sold" : "Actual daily use", points: actual, color: "a", area: true },
              { label: "Forecast", color: "b", dashed: true, points: f.map((x) => ({ x: x.forecast_date, y: Number(x.yhat) })),
                band: f.map((x) => ({ x: x.forecast_date, lo: Number(x.yhat_lower ?? x.yhat), hi: Number(x.yhat_upper ?? x.yhat) })) },
            ]} />
          );
        }}</Loaded>
      </div>
      {f.length ? (
        <div className="mt-3">
          <p className="mb-2"><MethodPill method={f[0].method} /><span className="text-muted">generated {fmtDateTime(f[0].generated_at)}</span></p>
          <Table rows={f.slice(0, 7)} rowKey={(x) => x.forecast_date} columns={[
            { label: "Day", render: (x) => fmtDate(x.forecast_date) },
            { label: "Forecast", num: true, render: (x) => `${qty(round1(x.yhat))} ${p.unit}` },
            { label: "Likely range", num: true, render: (x) => `${qty(round1(x.yhat_lower ?? x.yhat))} – ${qty(round1(x.yhat_upper ?? x.yhat))}` },
          ]} />
        </div>
      ) : <p className="mt-3 text-muted">No forecast for this item: it is new or sells rarely, so reorder uses the 28-day average or your manual level.</p>}
    </Card>
  );
}

function Evaluation({ ev }) {
  const title = "Does the model beat a simple baseline?";
  if (!ev) {
    return (
      <Card icon={FlaskConical} title={title}>
        <p className="text-muted">No evaluation yet. Run <code>python forecasting/evaluate_forecasts.py</code> to score the model against
          “same as last week” on the most recent 28 days. Results show here and pick the method per tier.</p>
      </Card>
    );
  }
  const tiers = Object.entries(ev.tiers ?? {});
  const sims = tiers.filter(([, t]) => t.policy_simulation);
  const label = ([k]) => TIER_LABEL[k] ?? k;
  return (
    <Card title={title}>
      <p className="text-muted">Holdout: {ev.holdout_days} days from {fmtDate(ev.holdout_start)} · run {fmtDateTime(ev.generated_at)} · <code>{ev.command}</code></p>
      <BarPairs a="Model error" b="Baseline error" format={(v) => pct(v)}
        rows={tiers.map((t) => ({ label: label(t), a: t[1].model?.wape, b: t[1].baseline?.wape }))} />
      <Table rows={tiers} rowKey={([k]) => k} columns={[
        { label: "Tier", render: label },
        { label: "Items", num: true, render: ([, t]) => t.n_items },
        { label: "Model WAPE", num: true, render: ([, t]) => pct(t.model?.wape) },
        { label: "Baseline WAPE", num: true, render: ([, t]) => pct(t.baseline?.wape) },
        { label: "Model MAPE", num: true, render: ([, t]) => pct(t.model?.mape) },
        { label: "Range coverage", num: true, render: ([, t]) => pct(t.model?.coverage) },
        { label: "Used", render: ([, t]) => <Pill tone={t.winner === "model" ? "info" : "warning"}>{t.winner === "model" ? "model" : "baseline"}</Pill> },
      ]} />
      {sims.length > 0 && (
        <div className="mt-4">
          <h3>Simulated stockouts over the holdout</h3>
          <Table rows={sims} rowKey={([k]) => k} columns={[
            { label: "Tier", render: label },
            { label: "Forecast-based safety stock", num: true, render: ([, t]) => `${t.policy_simulation.dynamic.stockout_days} days out · avg ${qty(t.policy_simulation.dynamic.avg_on_hand)} on hand` },
            { label: "Fixed reorder level", num: true, render: ([, t]) => `${t.policy_simulation.fixed.stockout_days} days out · avg ${qty(t.policy_simulation.fixed.avg_on_hand)} on hand` },
          ]} />
        </div>
      )}
      <p className="mt-3 text-muted">WAPE = total absolute error ÷ total demand (works on zero-sales days, unlike MAPE). Range coverage = share of days the actual fell inside the forecast's likely range.</p>
    </Card>
  );
}
