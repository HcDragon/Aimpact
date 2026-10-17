// Wholesaler network: search by text or photo (Gemini embeddings, inside the network only); wholesalers manage listings.
import { Plus, Search as SearchIcon, Warehouse } from "lucide-react";
import { useRef, useState } from "react";
import { Button, Card, Field, Form, Loaded, Page, Pill, Row, Select, Submit, Table, useLoad, useToast } from "../components/ui.jsx";
import { current, fn, from, isWholesaler, mine, q, supabase } from "../lib/api.js";
import { GST_RATES, UNITS, inr, qty, toPaise } from "../lib/format.js";
import { compressImage, fileToBase64 } from "../lib/media.js";

export function Network() {
  return (
    <Page title="Wholesaler network" intro={isWholesaler() ? "Your listings are visible to every shop and restaurant on the platform." : null}>
      {isWholesaler() && <Listings />}
      <Search />
    </Page>
  );
}

function Search() {
  const [res, setRes] = useState(null);
  const [text, setText] = useState("");
  const photo = useRef(null);
  return (
    <Card icon={SearchIcon} title="Find the best wholesale price">
      <Form className="flex flex-wrap items-end gap-2" onSubmit={async () => setRes(await fn("product-search", { text }))}>
        <input aria-label="Search text" className="min-w-[min(320px,100%)]" placeholder="e.g. sunflower oil 15L" value={text} onChange={(e) => setText(e.target.value)} />
        <Submit>Search</Submit>
      </Form>
      <Row className="mt-3">
        <input ref={photo} type="file" accept="image/*" capture="environment" aria-label="Product photo" />
        <Button variant="secondary" onClick={async () => {
          const f = photo.current.files[0];
          if (!f) throw new Error("Choose a photo");
          setRes(await fn("product-search", { image_base64: await fileToBase64(await compressImage(f, 1024)), text: text || undefined }));
        }}>📷 Search by photo</Button>
      </Row>
      <p className="mt-2 text-muted">Searches only our wholesaler network (no web scraping). Falls back to text search without AI.</p>
      {res && (
        <div className="mt-3">
          <p className="mb-2"><Pill>matched by {res.method}</Pill>{res.error && <span className="text-muted">{res.error}</span>}</p>
          <Table rows={res.results} empty="No matches in the network." columns={[
            { label: "Item", key: "name" },
            { label: "Wholesaler", render: (r) => `${r.wholesaler_name}${r.city ? ", " + r.city : ""}` },
            { label: "Price", num: true, render: (r) => `${inr(r.price_paise)} / ${r.unit}` },
            { label: "Min qty", num: true, render: (r) => qty(r.min_qty) },
            { label: "GST", num: true, render: (r) => r.gst_rate + "%" },
            { label: "Match", num: true, render: (r) => (r.similarity * 100).toFixed(0) + "%" },
          ]} />
        </div>
      )}
    </Card>
  );
}

function Listings() {
  const toast = useToast();
  const state = useLoad(() => q(mine("wholesaler_listings").order("name")));
  const img = useRef(null);
  return (
    <>
      <Card icon={Plus} title="New listing">
        <Form onSubmit={async (v, form) => {
          let image_path = null;
          const f = img.current.files[0];
          if (f) {
            image_path = `${current.business.id}/${crypto.randomUUID()}.jpg`;
            const up = await supabase.storage.from("listing-images").upload(image_path, await compressImage(f, 1024), { contentType: "image/jpeg" });
            if (up.error) throw up.error;
          }
          await q(from("wholesaler_listings").insert({
            business_id: current.business.id, name: v.name, category: v.category || null, unit: v.unit, price_paise: toPaise(v.price),
            min_qty: Number(v.min_qty || 1), gst_rate: Number(v.gst_rate), description: v.description || null, image_path,
          }));
          toast("Listed. It becomes photo-searchable once embedded.");
          form.reset();
          state.reload();
        }}>
          <Row>
            <Field label="Item"><input name="name" required /></Field>
            <Field label="Category"><input name="category" /></Field>
            <Field label="Unit"><Select name="unit" options={[...UNITS, "bag", "carton", "tin", "crate"].map((u) => [u, u])} /></Field>
            <Field label="Price ₹"><input name="price" type="number" step="0.01" required /></Field>
            <Field label="Min qty"><input name="min_qty" type="number" defaultValue={1} /></Field>
            <Field label="GST %"><Select name="gst_rate" defaultValue={5} options={GST_RATES.map((r) => [r, r + "%"])} /></Field>
          </Row>
          <Row className="mt-2">
            <Field label="Description"><input name="description" className="min-w-[min(320px,100%)]" /></Field>
            <Field label="Photo"><input ref={img} type="file" accept="image/*" /></Field>
          </Row>
          <div className="mt-3"><Submit>Add listing</Submit></div>
        </Form>
      </Card>
      <Card icon={Warehouse} title="Your listings">
        <Loaded state={state}>{(rows) => (
          <Table rows={rows} rowKey={(r) => r.id} columns={[
            { label: "Item", key: "name" },
            { label: "Category", key: "category" },
            { label: "Price", num: true, render: (r) => `${inr(r.price_paise)} / ${r.unit}` },
            { label: "Min qty", num: true, render: (r) => qty(r.min_qty) },
            { label: "Search-ready", render: (r) => (r.embedding ? "✓" : "queued") },
            { label: "", render: (r) => <Button small variant="secondary" onClick={async () => { await q(from("wholesaler_listings").update({ is_active: !r.is_active }).eq("id", r.id)); state.reload(); }}>{r.is_active ? "Hide" : "Show"}</Button> },
          ]} />
        )}</Loaded>
      </Card>
    </>
  );
}
