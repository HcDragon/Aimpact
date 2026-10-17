// Shared helpers for the dummy frontend: Supabase client, DOM builder, formatting, API wrappers.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import cfg from "./config.js";

export const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

export const state = {
  session: null,
  businesses: [],
  business: null, // current business row
  products: [], // cached catalog for pickers
};

// ---------------------------------------------------------------- DOM
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function table(columns, rows, { empty = "Nothing here yet." } = {}) {
  if (!rows?.length) return h("p", { class: "muted" }, empty);
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
      h("tbody", {}, rows.map((r) =>
        h("tr", {}, columns.map((c) => h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : r[c.key] ?? "")))))));
}

export function card(title, ...body) {
  return h("section", { class: "card" }, title ? h("h3", {}, title) : null, ...body);
}

export function field(label, input) {
  return h("label", { class: "field" }, h("span", {}, label), input);
}

export function select(options, value, attrs = {}) {
  return h("select", attrs, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value ?? "") }, l)));
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------------------------------------------------------------- feedback
export function toast(msg, type = "ok") {
  const el = h("div", { class: `toast ${type}` }, msg);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), type === "err" ? 7000 : 3500);
}

/** Run an async action with button spinner + error toast. */
export async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message ?? String(e), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------------------------------------------------------------- formatting (INR, DD/MM/YYYY, IST)
export const inr = (paise) =>
  paise === null || paise === undefined ? "-" : "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const toPaise = (rupees) => (rupees === "" || rupees === null || rupees === undefined ? null : Math.round(Number(rupees) * 100));
export const rupees = (paise) => (paise === null || paise === undefined ? "" : (Number(paise) / 100).toString());
export const qty = (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
export const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00+05:30" : d).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }) : "-");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }) : "-");
export const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export const daysAgo = (n) => {
  const d = new Date(istToday());
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- business-type wording
export function words() {
  const r = state.business?.business_type === "restaurant";
  return {
    products: r ? "Ingredients" : "Products",
    product: r ? "ingredient" : "product",
    stock: r ? "Pantry" : "Stock",
    stockKind: r ? "ingredient" : "product",
  };
}

// ---------------------------------------------------------------- API
export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, { p_business_id: state.business.id, ...args });
  if (error) throw new Error(error.message);
  return data;
}

export async function rpcRaw(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function fn(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body: { business_id: state.business.id, ...body } });
  if (error) {
    let msg = error.message;
    try {
      msg = (await error.context.json()).error ?? msg;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return data;
}

export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

export async function loadProducts() {
  state.products = await q(supabase.from("product_stock").select("*").eq("business_id", state.business.id).order("name"));
  return state.products;
}

// ---------------------------------------------------------------- files
export function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); // data URL
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Downscale photos before upload (bills are readable at 1600px). */
export async function compressImage(file, maxSide = 1600, quality = 0.85) {
  if (!file.type.startsWith("image/")) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = h("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

/** Record audio and return a 16 kHz mono WAV blob (a format Gemini accepts everywhere). */
export async function recordAudio(onStop) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const raw = new Blob(chunks, { type: rec.mimeType });
    onStop(await toWav(raw));
  };
  rec.start();
  return rec;
}

async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  ctx.close();
  return new Blob([buf], { type: "audio/wav" });
}

/** Camera barcode scan: native BarcodeDetector, ZXing fallback. Resolves with the code or null. */
export async function scanBarcode() {
  const dialog = h("dialog", { class: "scanner" });
  const video = h("video", { autoplay: true, playsInline: true, muted: true });
  const cancel = h("button", { type: "button" }, "Cancel");
  dialog.append(h("p", {}, "Point the camera at the barcode"), video, cancel);
  document.body.append(dialog);
  dialog.showModal();
  let stream;
  let stop = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    const result = await new Promise(async (resolve) => {
      cancel.onclick = () => resolve(null);
      if ("BarcodeDetector" in window) {
        const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
        while (!stop) {
          const codes = await det.detect(video).catch(() => []);
          if (codes.length) return resolve(codes[0].rawValue);
          await new Promise((r) => setTimeout(r, 200));
        }
      } else {
        const { BrowserMultiFormatReader } = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoElement(video, (res) => {
          if (res) { controls.stop(); resolve(res.getText()); }
        });
        cancel.onclick = () => { controls.stop(); resolve(null); };
      }
    });
    return result;
  } catch (e) {
    toast("Camera not available: " + e.message, "err");
    return null;
  } finally {
    stop = true;
    stream?.getTracks().forEach((t) => t.stop());
    dialog.close();
    dialog.remove();
  }
}

export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Tiny inline SVG line chart: series = [{label, points:[{x: 'YYYY-MM-DD', y}], dashed?, color}] */
export function lineChart(series, { height = 180 } = {}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return h("p", { class: "muted" }, "No data");
  const xs = [...new Set(all.map((p) => p.x))].sort();
  const maxY = Math.max(1, ...all.map((p) => p.y));
  const W = 640, H = height, pad = 28;
  const X = (x) => pad + (xs.indexOf(x) / Math.max(1, xs.length - 1)) * (W - pad * 2);
  const Y = (y) => H - pad - (y / maxY) * (H - pad * 2);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  const add = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };
  add("line", { x1: pad, x2: W - pad, y1: H - pad, y2: H - pad, class: "axis" });
  add("text", { x: 2, y: pad, class: "tick" }).textContent = qty(maxY);
  add("text", { x: pad, y: H - 8, class: "tick" }).textContent = fmtDate(xs[0]);
  add("text", { x: W - pad - 60, y: H - 8, class: "tick" }).textContent = fmtDate(xs[xs.length - 1]);
  for (const s of series) {
    if (s.band) {
      const up = s.band.map((p) => `${X(p.x)},${Y(p.hi)}`);
      const lo = s.band.slice().reverse().map((p) => `${X(p.x)},${Y(p.lo)}`);
      add("polygon", { points: [...up, ...lo].join(" "), class: "band" });
    }
    add("polyline", {
      points: s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" "),
      class: "line" + (s.dashed ? " dashed" : ""),
      style: `stroke:${s.color}`,
    });
  }
  return h("div", {}, svg, h("div", { class: "legend" }, series.map((s) => h("span", {}, h("i", { style: { background: s.color } }), s.label))));
}
