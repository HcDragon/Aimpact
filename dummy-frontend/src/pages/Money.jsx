// Khata (udhaar), profit & GST reports, reviews with nightly sentiment.
import { BookUser, Landmark, LineChart as LineChartIcon, Package, Plus, Star, Store } from "lucide-react";
import { useState } from "react";
import { LineChart } from "../components/charts.jsx";
import { Button, Card, Field, Form, Grid, Kpi, Kpis, Loaded, Page, Pill, Row, Select, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, from, mine, q, rpc } from "../lib/api.js";
import { daysAgo, fmtDate, fmtDateTime, inr, istToday, toPaise } from "../lib/format.js";
import { downloadCSV } from "../lib/media.js";

export function Khata() {
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const state = useLoad(() => q(mine("khata_balances").order("balance_paise", { ascending: false })));
  const entries = useLoad(async () => (open ? q(from("khata_entries").select("*").eq("customer_id", open.customer_id).order("created_at", { ascending: false }).limit(100)) : null), [open?.customer_id]);
  return (
    <Page title="Khata" intro="Credit sales from the POS land here too.">
      <Card icon={Plus} title="New entry">
        <Form className="flex flex-wrap items-end gap-2" onSubmit={async (v, form) => {
          const r = await rpc("khata_add", { p_customer: v.customer, p_kind: v.kind, p_amount_paise: toPaise(v.amount), p_note: v.note || null, p_phone: v.phone || null });
          toast(`${v.customer}: balance ${inr(r.balance_paise)}`);
          form.reset();
          state.reload();
          entries.reload();
        }}>
          <Field label="Customer"><input name="customer" required /></Field>
          <Field label="Phone"><input name="phone" /></Field>
          <Field label="Type"><Select name="kind" options={[["credit", "Udhaar given"], ["payment", "Payment received"]]} /></Field>
          <Field label="Amount ₹"><input name="amount" type="number" step="0.01" required /></Field>
          <Field label="Note"><input name="note" /></Field>
          <Submit>Save</Submit>
        </Form>
      </Card>
      {open && entries.data && (
        <Card title={`${open.name}: balance ${inr(open.balance_paise)}`}>
          <Table rows={entries.data} rowKey={(e) => e.id} columns={[
            { label: "When", render: (e) => fmtDateTime(e.created_at) },
            { label: "Type", render: (e) => (e.kind === "credit" ? "Udhaar given" : "Payment received") },
            { label: "Amount", num: true, render: (e) => inr(e.amount_paise) },
            { label: "Note", key: "note" },
          ]} />
        </Card>
      )}
      <Card icon={BookUser} title="Customers">
        <Loaded state={state}>{(rows) => (
          <Table rows={rows} rowKey={(c) => c.customer_id} empty="No khata customers yet." columns={[
            { label: "Customer", render: (c) => <Button variant="link" onClick={() => setOpen(c)}>{c.name}</Button> },
            { label: "Phone", key: "phone" },
            { label: "Balance", num: true, render: (c) => <strong className={c.balance_paise > 0 ? "text-crit" : "text-ok"}>{inr(c.balance_paise)}</strong> },
            { label: "Last entry", render: (c) => fmtDateTime(c.last_entry_at) },
          ]} />
        )}</Loaded>
      </Card>
    </Page>
  );
}

export function Reports() {
  const [range, setRange] = useState({ from: daysAgo(30), to: istToday() });
  const state = useLoad(async () => {
    const [p, g] = await Promise.all([
      rpc("profit_report", { p_from: range.from, p_to: range.to }),
      rpc("gst_report", { p_from: range.from, p_to: range.to }),
    ]);
    return { p, g };
  }, [range.from, range.to]);
  const rateCols = [
    { label: "GST rate", render: (r) => r.gst_rate + "%" },
    { label: "Taxable value", num: true, render: (r) => inr(r.taxable_paise) },
    { label: "CGST", num: true, render: (r) => inr(r.cgst_paise) },
    { label: "SGST", num: true, render: (r) => inr(r.sgst_paise) },
    { label: "Total tax", num: true, render: (r) => inr(r.tax_paise) },
  ];
  return (
    <Page title="Profit & GST" intro="Profit uses actual batch costs (COGS) and includes wastage.">
      <Card>
        <Form className="flex flex-wrap items-end gap-2" onSubmit={(v) => setRange({ from: v.from, to: v.to })}>
          <Field label="From"><input name="from" type="date" defaultValue={range.from} /></Field>
          <Field label="To"><input name="to" type="date" defaultValue={range.to} /></Field>
          <Submit>Run</Submit>
        </Form>
      </Card>
      <Loaded state={state}>{({ p, g }) => (
        <>
          <Kpis>
            <Kpi plain label="Gross sales" value={inr(p.gross_sales_paise)} />
            <Kpi plain label="Revenue ex-GST" value={inr(p.revenue_paise)} />
            <Kpi plain label="Cost of goods" value={inr(p.cogs_paise)} />
            <Kpi plain label="Wastage" value={inr(p.wastage_paise)} />
            <Kpi plain label="Net profit" value={inr(p.net_profit_paise)} />
            <Kpi plain label="Margin" value={p.margin_pct + "%"} />
            <Kpi plain label="Bills" value={p.bills} />
          </Kpis>
          <Card icon={LineChartIcon} title="Daily revenue and profit (₹)">
            <LineChart series={[
              { label: "Revenue", color: "a", area: true, points: p.days.map((d) => ({ x: d.day, y: d.revenue_paise / 100 })) },
              { label: "Profit", color: "c", points: p.days.map((d) => ({ x: d.day, y: d.profit_paise / 100 })) },
            ]} />
          </Card>
          <Grid>
            <Card icon={Package} title="Profit by item">
              <Table rows={p.products} columns={[
                { label: "Item", key: "name" }, { label: "Qty", num: true, render: (r) => Number(r.qty) },
                { label: "Revenue", num: true, render: (r) => inr(r.revenue_paise) }, { label: "Profit", num: true, render: (r) => inr(r.profit_paise) },
                { label: "Margin", num: true, render: (r) => r.margin_pct + "%" },
              ]} />
            </Card>
            <Card icon={Store} title="Sales by channel">
              <Table rows={p.channels} columns={[
                { label: "Channel", key: "channel" }, { label: "Bills", num: true, key: "bills" }, { label: "Sales", num: true, render: (r) => inr(r.total_paise) },
              ]} />
            </Card>
          </Grid>
          <Card icon={Landmark} title={`GST summary ${fmtDate(g.from)} – ${fmtDate(g.to)} (GSTIN ${g.business.gstin ?? "not set"})`}>
            <Kpis>
              <Kpi plain label="Output tax" value={inr(g.output_tax_paise)} />
              <Kpi plain label="Input tax credit" value={inr(g.input_tax_credit_paise)} />
              <Kpi plain label="Net payable" value={inr(g.net_payable_paise)} />
              <Kpi plain label="ITC carried forward" value={inr(g.itc_carry_forward_paise)} />
            </Kpis>
            <h3>Sales (outward)</h3><Table rows={g.outward} columns={rateCols} />
            <h3 className="mt-4">Purchases (inward)</h3><Table rows={g.inward} columns={rateCols} />
            <h3 className="mt-4">HSN summary</h3>
            <Table rows={g.hsn_summary} columns={[
              { label: "HSN", key: "hsn" }, { label: "Unit", key: "unit" }, { label: "Rate", render: (r) => r.gst_rate + "%" },
              { label: "Qty", num: true, render: (r) => Number(r.qty) }, { label: "Taxable", num: true, render: (r) => inr(r.taxable_paise) },
              { label: "Tax", num: true, render: (r) => inr(r.tax_paise) },
            ]} />
            <Row className="mt-3 print:hidden">
              <Button variant="secondary" onClick={() => downloadCSV(`gst_${g.from}_${g.to}.csv`, [
                ["Section", "GST rate", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "Tax (₹)"],
                ...g.outward.map((r) => ["Outward", r.gst_rate, r.taxable_paise / 100, r.cgst_paise / 100, r.sgst_paise / 100, r.tax_paise / 100]),
                ...g.inward.map((r) => ["Inward", r.gst_rate, r.taxable_paise / 100, r.cgst_paise / 100, r.sgst_paise / 100, r.tax_paise / 100]),
              ])}>Download CSV</Button>
              <Button variant="secondary" onClick={() => window.print()}>Print</Button>
              <span className="text-muted">PDF: <code>python reports/gst_report.py --business-id … --month YYYY-MM</code></span>
            </Row>
          </Card>
        </>
      )}</Loaded>
    </Page>
  );
}

export function Reviews() {
  const toast = useToast();
  const state = useLoad(() => q(mine("reviews").order("reviewed_at", { ascending: false }).limit(100)));
  return (
    <Page title="Reviews" intro="The nightly AI batch tags sentiment and topics (taste, price, delivery, hygiene, quantity).">
      <Card icon={Plus} title="Add a review">
        <Form onSubmit={async (v, form) => {
          await q(from("reviews").insert({ business_id: current.business.id, source: v.source, rating: v.rating ? Number(v.rating) : null, review_text: v.text }));
          toast("Saved. Sentiment is analysed in tonight's batch.");
          form.reset();
          state.reload();
        }}>
          <Row>
            <Field label="Source"><Select name="source" options={[["manual", "Manual"], ["google", "Google"], ["zomato", "Zomato"], ["swiggy", "Swiggy"]]} /></Field>
            <Field label="Rating"><Select name="rating" options={[["", "-"], [5, "5"], [4, "4"], [3, "3"], [2, "2"], [1, "1"]]} /></Field>
          </Row>
          <div className="mt-2"><Field label="Review text"><textarea name="text" required className="min-h-16 w-full" /></Field></div>
          <div className="mt-3"><Submit>Add review</Submit></div>
        </Form>
      </Card>
      <Card icon={Star} title="Reviews">
        <Loaded state={state}>{(rows) => {
          const scored = rows.filter((r) => r.sentiment);
          const n = (s) => scored.filter((r) => r.sentiment === s).length;
          const topics = {};
          scored.forEach((r) => (r.topics ?? []).forEach((t) => {
            topics[t] ??= { pos: 0, neg: 0 };
            if (r.sentiment === "negative") topics[t].neg++;
            else if (r.sentiment === "positive") topics[t].pos++;
          }));
          return (
            <>
              <Kpis>
                <Kpi plain label="Positive" value={n("positive")} /><Kpi plain label="Neutral" value={n("neutral")} /><Kpi plain label="Negative" value={n("negative")} />
                <Kpi plain label="Waiting for tonight's analysis" value={rows.length - scored.length} />
              </Kpis>
              {Object.keys(topics).length > 0 && <p className="mb-2">Topics: {Object.entries(topics).map(([t, c]) => <Pill key={t} tone={c.neg > c.pos ? "critical" : "info"}>{t} +{c.pos} / −{c.neg}</Pill>)}</p>}
              <Table rows={rows} rowKey={(r) => r.id} columns={[
                { label: "When", render: (r) => fmtDate(r.reviewed_at) },
                { label: "Source", key: "source" },
                { label: "★", num: true, key: "rating" },
                { label: "Review", key: "review_text" },
                { label: "Sentiment", render: (r) => (r.sentiment ? <Pill tone={r.sentiment}>{r.sentiment}</Pill> : <span className="text-muted">pending</span>) },
                { label: "Topics", render: (r) => (r.topics ?? []).join(", ") },
              ]} />
            </>
          );
        }}</Loaded>
      </Card>
    </Page>
  );
}
