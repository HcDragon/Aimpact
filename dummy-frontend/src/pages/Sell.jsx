// POS / order taking, with "often bought together" suggestions from the Apriori bundles.
import { Receipt, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { BarcodeScanner, Button, Callout, Card, Field, Grid, Loaded, Page, Row, Select, Table, useLoad, useToast } from "../components/ui.jsx";
import { isRestaurant, loadProducts, mine, q, rpc, words } from "../lib/api.js";
import { inr, qty } from "../lib/format.js";

export function Sell() {
  const rest = isRestaurant();
  const state = useLoad(async () => {
    const [products, bundles] = await Promise.all([loadProducts(), q(mine("bundle_suggestions").order("lift", { ascending: false })).catch(() => [])]);
    return { sellable: products.filter((p) => p.is_active && (rest ? p.kind === "dish" : p.kind === "product")), bundles };
  });
  return (
    <Page title={rest ? "Take order" : "Sell"}
      intro={"A sale never fails for lack of stock; the earliest-expiry batch is used first." + (rest ? " Dishes deduct their recipe ingredients." : "")}>
      <Loaded state={state}>{(d) => <Pos {...d} rest={rest} reload={state.reload} />}</Loaded>
    </Page>
  );
}

function Pos({ sellable, bundles, rest, reload }) {
  const toast = useToast();
  const [cart, setCart] = useState(new Map()); // product_id -> { product, qty, price }
  const [search, setSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState("cash");
  const [channel, setChannel] = useState(rest ? "dine_in" : "counter");
  const [customer, setCustomer] = useState("");
  const byId = useMemo(() => new Map(sellable.map((p) => [p.product_id, p])), [sellable]);

  const add = (p, n = 1) => setCart((c) => {
    const next = new Map(c);
    const line = next.get(p.product_id) ?? { product: p, qty: 0, price: p.sell_price_paise ?? 0 };
    const updated = { ...line, qty: line.qty + n };
    updated.qty <= 0 ? next.delete(p.product_id) : next.set(p.product_id, updated);
    return next;
  });
  const lines = [...cart.values()];
  const total = lines.reduce((s, l) => s + Math.round(l.price * l.qty), 0);

  // "Bought together" is symmetric (lift is the same both ways): if any item of a bundle is in the
  // cart, suggest the bundle's other items that are not in it yet.
  const hints = useMemo(() => {
    const seen = new Set();
    return bundles.filter((b) => [...b.antecedent_ids, ...b.consequent_ids].some((id) => cart.has(id)))
      .flatMap((b) => [...b.antecedent_ids, ...b.consequent_ids].filter((id) => !cart.has(id) && byId.has(id)).map((id) => ({ id, lift: Number(b.lift) })))
      .filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 3);
  }, [bundles, cart, byId]);

  const s = search.trim().toLowerCase();
  const results = sellable.filter((p) => !s || p.name.toLowerCase().includes(s) || p.barcode === s).slice(0, 24);
  const byBarcode = (code) => {
    const p = sellable.find((x) => x.barcode === code);
    p ? add(p) : toast(`No product with barcode ${code}. Add it under ${words().stock}.`, "err");
  };

  const checkout = async () => {
    if (!cart.size) throw new Error("Cart is empty");
    const res = await rpc("record_sale", {
      p_items: lines.map((l) => ({ product_id: l.product.product_id, qty: l.qty, unit_price_paise: l.price })),
      p_payment_mode: mode, p_channel: channel, p_khata_customer: customer || null,
    });
    toast(`Sale saved: ${inr(res.total_paise)} (profit ${inr(res.profit_paise)})`);
    if (res.shortages?.length) toast(`${res.shortages.length} item(s) sold beyond recorded stock. Check your counts.`, "info");
    setCart(new Map());
    setCustomer("");
    reload();
  };

  return (
    <Grid wideLeft>
      {scanning && <BarcodeScanner onResult={(code) => { setScanning(false); if (code) byBarcode(code); }} />}
      <Card icon={Search} title={rest ? "Menu" : "Items"}>
        <Row className="mb-3">
          <input aria-label="Search" className="min-w-[min(320px,100%)]" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={rest ? "Search menu" : "Search, or type/scan a barcode and press Enter"}
            onKeyDown={(e) => { if (e.key === "Enter" && search.trim()) { byBarcode(search.trim()); setSearch(""); } }} />
          {!rest && <Button variant="secondary" onClick={() => setScanning(true)}>📷 Scan</Button>}
        </Row>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {results.map((p) => (
            <button key={p.product_id} onClick={() => add(p)} className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1.5 text-left hover:bg-surface-2">
              {p.name}
              <small className="block text-muted">{inr(p.sell_price_paise)}{rest ? "" : ` · ${qty(p.on_hand)} left`}</small>
            </button>
          ))}
        </div>
      </Card>
      <Card icon={Receipt} title="Bill">
        <Table rows={lines} empty="Cart is empty" rowKey={(l) => l.product.product_id} columns={[
          { label: "Item", render: (l) => l.product.name },
          { label: "Qty", num: true, render: (l) => (
            <span className="whitespace-nowrap">
              <Button small variant="secondary" aria-label="Less" onClick={() => add(l.product, -1)}>−</Button>{` ${qty(l.qty)} `}
              <Button small variant="secondary" aria-label="More" onClick={() => add(l.product, 1)}>+</Button>
            </span>) },
          { label: "Price", num: true, render: (l) => inr(l.price) },
          { label: "Amount", num: true, render: (l) => inr(Math.round(l.price * l.qty)) },
          ...(rest ? [] : [{ label: "In stock", num: true, render: (l) => qty(l.product.on_hand) }]),
        ]} />
        {hints.length > 0 && (
          <Callout tone="ok">🧺 Often bought together:
            {hints.map((x) => (
              <Button key={x.id} small variant="secondary" onClick={() => add(byId.get(x.id))}>
                + {byId.get(x.id).name} <span className="text-muted">×{x.lift.toFixed(1)} likelier</span>
              </Button>
            ))}
          </Callout>
        )}
        <p className="my-3 font-semibold">Total {inr(total)}</p>
        <Row>
          <Field label="Payment"><Select value={mode} onChange={(e) => setMode(e.target.value)}
            options={[["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["credit", "Udhaar (khata)"]]} /></Field>
          <Field label="Channel"><Select value={channel} onChange={(e) => setChannel(e.target.value)}
            options={rest ? [["dine_in", "Dine-in"], ["takeaway", "Takeaway"], ["counter", "Counter"]] : [["counter", "Counter"]]} /></Field>
          <Field label="Customer"><input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Name (for udhaar)" /></Field>
        </Row>
        <div className="mt-3"><Button onClick={checkout}>Complete sale</Button></div>
      </Card>
    </Grid>
  );
}
