// Home: today's numbers, the morning insight, and ML highlights (reorder, waste risk, dead stock, bundles).
import { ArrowRight, Bell, BookUser, Boxes, Clock, Lightbulb, PackageX, PiggyBank, Receipt, Repeat, ShoppingBasket, Sparkles, Trash2, TrendingUp, TriangleAlert, Wallet } from "lucide-react";
import { Card, Grid, Kpi, Kpis, Loaded, Page, Pill, Table, useLoad } from "../components/ui.jsx";
import { current, isRestaurant, isWholesaler, loadProducts, mine, productName, q, rpc, words } from "../lib/api.js";
import { fmtDate, fmtDateTime, inr, istToday, qty, round1 } from "../lib/format.js";

const settle = async (p, fallback) => { try { return await p; } catch { return fallback; } };

export function Home() {
  const state = useLoad(async () => {
    const ops = !isWholesaler();
    if (ops) await loadProducts();
    const [dash, insight, reorder, risk, dead, bundles, fc] = await Promise.all([
      rpc("dashboard"),
      settle(q(mine("alerts", "message, created_at").eq("kind", "insight").order("created_at", { ascending: false }).limit(1)), []),
      ops ? settle(rpc("reorder_suggestions"), []) : [],
      ops ? settle(rpc("perishable_risk"), []) : [],
      ops ? settle(rpc("dead_stock", { p_days: 30 }), []) : [],
      ops ? settle(q(mine("bundle_suggestions").order("lift", { ascending: false }).limit(1)), []) : [],
      ops ? settle(q(mine("forecasts", "generated_at").order("generated_at", { ascending: false }).limit(1)), []) : [],
    ]);
    return { dash, tip: insight[0], reorder, risk, dead, top: bundles[0], lastFc: fc[0], ops };
  });
  const w = words();

  return (
    <Page title={current.business.name}
      intro={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) + (current.business.city ? ` · ${current.business.city}` : "")}>
      <Loaded state={state}>{({ dash, tip, reorder, risk, dead, top, lastFc, ops }) => {
        const toOrder = reorder.filter((r) => Number(r.suggested_qty) > 0);
        const atRisk = risk.filter((r) => Number(r.at_risk_qty) > 0);
        return (
          <>
            {tip && (
              <div className="mb-5 flex gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent"><Lightbulb className="size-4" /></span>
                <div><div className="text-xs font-semibold tracking-wide text-accent uppercase">Today's insight</div><p className="mt-0.5">{tip.message}</p>
                  <small className="text-muted">{fmtDateTime(tip.created_at)}</small></div>
              </div>
            )}
            <Kpis>
              <Kpi icon={Wallet} label="Sales today" value={inr(dash.today.sales_paise)} hint={`${dash.today.bills} bills`} />
              <Kpi icon={PiggyBank} tone="ok" label="Profit today" value={inr(dash.today.profit_paise)} />
              <Kpi icon={Receipt} label="Sales, 30 days" value={inr(dash.last_30_days.sales_paise)} />
              <Kpi icon={TrendingUp} tone="ok" label="Profit, 30 days" value={inr(dash.last_30_days.profit_paise)} />
              <Kpi icon={Boxes} tone="pink" label={`${w.stock} value`} value={inr(dash.stock_value_paise)} />
              <Kpi icon={BookUser} tone="warn" label="Udhaar outstanding" value={inr(dash.khata_outstanding_paise)} />
              <Kpi icon={Trash2} tone="crit" label="Wastage, 30 days" value={inr(dash.wastage_30d_paise)} />
              <Kpi icon={Bell} tone="warn" label="Open alerts" value={dash.open_alerts} hint={<a href="#alerts">View alerts →</a>} />
            </Kpis>
            {ops && (
              <Card icon={Sparkles} title="Forecasts & insights" subtitle={lastFc
                ? `Forecasts generated ${fmtDateTime(lastFc.generated_at)} by the nightly job`
                : "No forecasts yet: run python forecasting/run_forecasts.py. Until then reorder uses the 28-day average."}>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Highlight icon={Repeat} href="#reorder" label="Items to reorder" value={toOrder.length} hint="forecast-driven reorder points" />
                  <Highlight icon={TriangleAlert} tone="crit" href="#insights" label="May expire unused"
                    value={inr(atRisk.reduce((s, r) => s + Number(r.at_risk_value_paise), 0))} hint={`${atRisk.length} batch(es) at risk`} />
                  <Highlight icon={PackageX} tone="warn" href="#insights" label="Stuck in dead stock"
                    value={inr(dead.reduce((s, r) => s + Number(r.stock_value_paise), 0))} hint={`${dead.length} item(s) idle 30+ days`} />
                  <Highlight icon={ShoppingBasket} tone="ok" href="#insights" label="Top bundle"
                    value={top ? `${top.antecedent_ids.map(productName).join(" + ")} → ${top.consequent_ids.map(productName).join(" + ")}` : "—"}
                    hint={top ? `bought together ${Number(top.lift).toFixed(1)}× more than chance` : "appears after the nightly job"} small />
                </div>
              </Card>
            )}
            <Grid>
              <Card icon={Clock} title="Running low">
                <Table rows={dash.low_stock} empty="Nothing is running low 👍" columns={[
                  { label: "Item", key: "name" },
                  { label: "Left", num: true, render: (r) => `${qty(round1(r.on_hand))} ${r.unit}` },
                  { label: "Reorder", num: true, render: (r) => qty(round1(r.suggested_qty)) },
                ]} />
              </Card>
              <Card icon={TriangleAlert} title="Expiring / expired">
                <Table rows={dash.expiring_soon} empty="Nothing expiring this week" columns={[
                  { label: "Item", key: "name" },
                  { label: "Qty", num: true, render: (r) => `${qty(r.qty)} ${r.unit}` },
                  { label: "Expiry", render: (r) => <Pill tone={r.expiry_date < istToday() ? "critical" : "warning"}>{fmtDate(r.expiry_date)}</Pill> },
                ]} />
              </Card>
              <Card icon={TrendingUp} title={isRestaurant() ? "Top dishes (30 days)" : "Top sellers (30 days)"}>
                <Table rows={dash.top_products_30d} columns={[
                  { label: "Item", key: "name" },
                  { label: "Sales", num: true, render: (r) => inr(r.sales_paise) },
                  { label: "Profit", num: true, render: (r) => inr(r.profit_paise) },
                ]} />
              </Card>
            </Grid>
          </>
        );
      }}</Loaded>
    </Page>
  );
}

const TONE = { accent: "text-accent bg-accent/10", ok: "text-ok bg-ok/10", warn: "text-warn bg-warn/10", crit: "text-crit bg-crit/10" };
function Highlight({ icon: Icon, label, value, hint, href, tone = "accent", small }) {
  return (
    <a href={href} className="group block rounded-xl border border-line bg-surface-2/50 p-4 text-ink no-underline transition hover:border-accent/40 hover:bg-surface">
      <div className="flex items-center justify-between">
        <span className={`grid size-8 place-items-center rounded-lg ${TONE[tone]}`}><Icon className="size-4" /></span>
        <ArrowRight className="size-4 text-muted opacity-0 transition group-hover:opacity-100" />
      </div>
      <div className="mt-3 text-xs font-medium text-muted">{label}</div>
      <div className={`font-semibold tracking-tight tabular-nums ${small ? "text-[15px] leading-snug" : "text-[22px]"}`}>{value}</div>
      <div className="mt-1 text-xs text-muted">{hint}</div>
    </a>
  );
}
