// Purchases: bill scan (Gemini, falling back to the offline EasyOCR service) or manual entry, then record_purchase.
import { ClipboardCheck, History, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Callout, Card, Field, Loaded, Page, Pill, Row, Select, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, fn, loadProducts, mine, q, rpc, supabase } from "../lib/api.js";
import { GST_RATES, UNITS, fmtDate, inr, istToday, rupees, toPaise } from "../lib/format.js";
import { compressImage } from "../lib/media.js";

const ENGINE = {
  gemini: ["Read by Gemini", "info"],
  ocr: ["Read by offline OCR (EasyOCR): Gemini was unavailable", "warning"],
};

export function Purchases() {
  const toast = useToast();
  const [draft, setDraft] = useState(null); // { draft, warnings, meta }
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!file?.type.startsWith("image/")) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const state = useLoad(async () => {
    const [products, suppliers, history] = await Promise.all([
      loadProducts(),
      q(mine("suppliers").order("name")),
      q(mine("purchases", "*, suppliers(name), purchase_items(count)").order("invoice_date", { ascending: false }).order("created_at", { ascending: false }).limit(50)),
    ]);
    return { stockable: products.filter((p) => p.kind !== "dish"), suppliers, history };
  });

  const scan = async () => {
    if (!file) throw new Error("Choose a bill photo first");
    const img = await compressImage(file);
    const path = `${current.business.id}/${crypto.randomUUID()}.${img.type === "application/pdf" ? "pdf" : "jpg"}`;
    const up = await supabase.storage.from("bills").upload(path, img, { contentType: img.type });
    if (up.error) throw up.error;
    const res = await fn("scan-bill", { storage_path: path });
    if (!res.ok) {
      toast(res.reason + ". Enter it manually below.", "info");
      return setDraft({ draft: { purchase: { source: "manual", bill_image_path: path }, items: [{}] }, warnings: [], meta: {} });
    }
    setDraft({ draft: res.draft, warnings: res.warnings ?? [], meta: { engine: res.engine ?? "gemini", cached: res.cached } });
  };

  return (
    <Page title="Purchases">
      <Card icon={ScanLine} title="Add stock">
        <Row>
          <input type="file" aria-label="Bill photo" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files[0] ?? null)} />
          <Button onClick={scan}>📄 Scan bill</Button>
          <span className="text-muted">or</span>
          <Button variant="secondary" onClick={() => setDraft({ draft: { purchase: {}, items: [{}] }, warnings: [], meta: {} })}>✍️ Enter manually</Button>
        </Row>
        {preview && <img src={preview} alt="Bill photo preview" className="mt-3 max-h-64 max-w-64 rounded-md border border-line" />}
        <ol className="mt-3 list-decimal pl-5 text-muted">
          <li>Gemini reads the photo.</li>
          <li>If Gemini fails, is rate-limited or cannot read it, the offline EasyOCR service tries (when OCR_SERVICE_URL is set).</li>
          <li>If both fail you get the manual form. Qty × rate and the bill total are re-checked locally; nothing is saved until you confirm.</li>
        </ol>
      </Card>
      <Loaded state={state}>{({ stockable, suppliers, history }) => (
        <>
          {draft && <DraftEditor key={JSON.stringify(draft.draft.purchase)} {...draft} stockable={stockable} suppliers={suppliers}
            onClose={() => setDraft(null)} onSaved={() => { setDraft(null); state.reload(); }} />}
          <Card icon={History} title="Recent purchases">
            <Table rows={history} rowKey={(r) => r.id} columns={[
              { label: "Date", render: (r) => fmtDate(r.invoice_date) },
              { label: "Supplier", render: (r) => r.suppliers?.name ?? "-" },
              { label: "Invoice", key: "invoice_no" },
              { label: "Source", render: (r) => <Pill>{r.source === "bill_scan" ? "bill scan" : r.source}</Pill> },
              { label: "Lines", num: true, render: (r) => r.purchase_items?.[0]?.count ?? 0 },
              { label: "Tax", num: true, render: (r) => inr(r.tax_paise) },
              { label: "Total", num: true, render: (r) => inr(r.total_paise) },
            ]} />
          </Card>
        </>
      )}</Loaded>
    </Page>
  );
}

let nextKey = 0;
const toRow = (it = {}) => ({
  key: nextKey++, product_id: it.product_id ?? "", name: it.name ?? "", qty: it.qty ?? 1, unit: it.unit ?? "pcs",
  cost: rupees(it.unit_cost_paise), gst_rate: it.gst_rate ?? 0, hsn_code: it.hsn_code ?? "", expiry_date: it.expiry_date ?? "",
  batch_no: it.batch_no ?? "", matched_name: it.matched_name, match_similarity: it.match_similarity, matched: !!it.product_id,
});

/** Editable draft (from a scan or empty). Nothing is saved until "Confirm & save". */
function DraftEditor({ draft, warnings, meta, stockable, suppliers, onClose, onSaved }) {
  const toast = useToast();
  const [head, setHead] = useState({
    supplier_name: draft.purchase.supplier_name ?? "", supplier_gstin: draft.purchase.supplier_gstin ?? "",
    invoice_no: draft.purchase.invoice_no ?? "", invoice_date: draft.purchase.invoice_date ?? istToday(),
  });
  const [rows, setRows] = useState((draft.items.length ? draft.items : [{}]).map(toRow));
  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const engine = meta.engine && ENGINE[meta.engine];

  const save = async () => {
    const items = rows.map((r) => ({
      product_id: r.product_id || null, name: r.name.trim() || null, qty: Number(r.qty), unit: r.unit,
      unit_cost_paise: toPaise(r.cost) ?? 0, gst_rate: Number(r.gst_rate), hsn_code: r.hsn_code || null,
      expiry_date: r.expiry_date || null, batch_no: r.batch_no || null,
    })).filter((i) => i.qty > 0 && (i.product_id || i.name));
    if (!items.length) throw new Error("Add at least one item");
    const purchase = { ...draft.purchase, ...Object.fromEntries(Object.entries(head).map(([k, v]) => [k, v || null])), source: draft.purchase.source ?? "manual" };
    const res = await rpc("record_purchase", { p_purchase: purchase, p_items: items });
    toast(`Purchase saved: ${inr(res.total_paise)}${res.products_created ? `, ${res.products_created} new item(s)` : ""}`);
    onSaved();
  };

  const input = (k, props = {}) => <input value={head[k]} onChange={(e) => setHead({ ...head, [k]: e.target.value })} {...props} />;
  return (
    <Card icon={ClipboardCheck} title={draft.purchase.source === "bill_scan" ? "Check the scanned bill" : "New purchase"}>
      {engine && <p className="mb-2"><Pill tone={engine[1]}>{engine[0]}</Pill>{meta.cached && <span className="text-muted"> (cached result)</span>}</p>}
      {warnings.map((w, i) => <Callout key={i}>⚠️ {w}</Callout>)}
      {draft.printed_total_paise != null && <p className="text-muted">Bill total {inr(draft.printed_total_paise)} · items add up to {inr(draft.computed_total_paise)}</p>}
      <Row className="my-3">
        <Field label="Supplier">{input("supplier_name", { list: "supplier-list" })}</Field>
        <datalist id="supplier-list">{suppliers.map((s) => <option key={s.id} value={s.name} />)}</datalist>
        <Field label="Supplier GSTIN">{input("supplier_gstin", { size: 16 })}</Field>
        <Field label="Invoice no">{input("invoice_no")}</Field>
        <Field label="Invoice date">{input("invoice_date", { type: "date" })}</Field>
      </Row>
      <Table rows={rows} rowKey={(r) => r.key} columns={[
        { label: "Item", render: (r) => (
          <div className="flex flex-col gap-1">
            <Select aria-label="Catalog item" value={r.product_id} onChange={(e) => set(r.key, { product_id: e.target.value })}
              options={[["", "➕ New item: use the name"], ...stockable.map((p) => [p.product_id, p.name])]} />
            <input aria-label="Name on bill" placeholder="Name as on bill" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} />
            {r.matched_name && <span className="text-xs text-muted">{r.matched ? `matched ${Math.round((r.match_similarity ?? 0) * 100)}%` : `closest: ${r.matched_name}?`}</span>}
          </div>) },
        { label: "Qty", render: (r) => <input aria-label="Qty" type="number" step="0.001" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} /> },
        { label: "Unit", render: (r) => <Select aria-label="Unit" value={r.unit} onChange={(e) => set(r.key, { unit: e.target.value })} options={UNITS.map((u) => [u, u])} /> },
        { label: "Rate ₹ (ex-GST)", render: (r) => <input aria-label="Rate" type="number" step="0.01" value={r.cost} onChange={(e) => set(r.key, { cost: e.target.value })} /> },
        { label: "GST", render: (r) => <Select aria-label="GST" value={r.gst_rate} onChange={(e) => set(r.key, { gst_rate: e.target.value })} options={GST_RATES.map((g) => [g, g + "%"])} /> },
        { label: "HSN", render: (r) => <input aria-label="HSN" size={8} value={r.hsn_code} onChange={(e) => set(r.key, { hsn_code: e.target.value })} /> },
        { label: "Expiry", render: (r) => <input aria-label="Expiry" type="date" value={r.expiry_date} onChange={(e) => set(r.key, { expiry_date: e.target.value })} /> },
        { label: "Batch", render: (r) => <input aria-label="Batch" size={6} value={r.batch_no} onChange={(e) => set(r.key, { batch_no: e.target.value })} /> },
        { label: "", render: (r) => <Button small variant="secondary" aria-label="Remove line" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>✕</Button> },
      ]} />
      <Row className="mt-3">
        <Button variant="secondary" onClick={() => setRows([...rows, toRow()])}>+ Line</Button>
        <Button onClick={save}>✅ Confirm & save</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </Row>
    </Card>
  );
}
