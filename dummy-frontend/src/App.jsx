// App shell: opens straight into the app (no login screen). A demo account is signed in silently
// because every table is protected by RLS; the top bar switches between the shop, restaurant and
// wholesaler demo accounts. Hash routing and realtime alert toasts.
import {
  Bell, BookOpen, BookUser, Bot, Brain, ChefHat, DatabaseZap, FileSpreadsheet, IndianRupee, LayoutDashboard, Network as NetworkIcon,
  Package, RefreshCw, Repeat, ScanLine, Settings as SettingsIcon, ShieldCheck, ShoppingCart, Sparkles, Star, Store, Trash2, TrendingUp,
  Truck, UtensilsCrossed, Warehouse,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Select, useToast } from "./components/ui.jsx";
import { SUPABASE_URL } from "./config.js";
import { OFFLINE_DEMO, current, q, supabase } from "./lib/api.js";
import { Alerts, Assistant } from "./pages/Assistant.jsx";
import { Forecasts } from "./pages/Forecasts.jsx";
import { Home } from "./pages/Home.jsx";
import { Insights } from "./pages/Insights.jsx";
import { Imports, Prep, Recipes, Wastage } from "./pages/Kitchen.jsx";
import { Khata, Reports, Reviews } from "./pages/Money.jsx";
import { Network } from "./pages/Network.jsx";
import { Purchases } from "./pages/Purchases.jsx";
import { Reorder, Suppliers } from "./pages/Reorder.jsx";
import { Sell } from "./pages/Sell.jsx";
import { Settings } from "./pages/Settings.jsx";
import { Stock } from "./pages/Stock.jsx";

// Demo accounts created by supabase/seed.sql. Override with VITE_DEMO_* in dummy-frontend/.env.local.
const env = import.meta.env;
const PASSWORD = env.VITE_DEMO_PASSWORD ?? "password123";
const PERSONAS = [
  { id: "shop", label: "Kirana shop", icon: Store, email: env.VITE_DEMO_SHOP_EMAIL ?? "shop@demo.test" },
  { id: "restaurant", label: "Restaurant", icon: UtensilsCrossed, email: env.VITE_DEMO_RESTAURANT_EMAIL ?? "restaurant@demo.test" },
  { id: "wholesaler", label: "Wholesaler", icon: Warehouse, email: env.VITE_DEMO_WHOLESALER_EMAIL ?? "wholesale@demo.test" },
];

const OPS = ["shop", "restaurant"];
const ROUTES = [
  { group: "Daily" },
  { icon: LayoutDashboard, id: "home", label: "Home", page: Home },
  { icon: ShoppingCart, id: "sell", label: (t) => (t === "restaurant" ? "Take order" : "Sell / POS"), page: Sell, only: OPS },
  { icon: Bot, id: "assistant", label: "Assistant & voice", page: Assistant },
  { icon: Bell, id: "alerts", label: "Alerts", page: Alerts },
  { group: "Inventory", only: OPS },
  { icon: Package, id: "stock", label: (t) => (t === "restaurant" ? "Pantry" : "Stock"), page: Stock, only: OPS },
  { icon: ScanLine, id: "purchases", label: "Purchases & bill scan", page: Purchases, only: OPS },
  { icon: Repeat, id: "reorder", label: "Reorder & POs", page: Reorder, only: OPS },
  { icon: Truck, id: "suppliers", label: "Suppliers", page: Suppliers, only: OPS },
  { group: "Forecasts & insights", only: OPS },
  { icon: TrendingUp, id: "forecasts", label: "Demand forecasts", page: Forecasts, only: OPS },
  { icon: Sparkles, id: "insights", label: "Insights", page: Insights, only: OPS },
  { group: "Kitchen", only: ["restaurant"] },
  { icon: ChefHat, id: "prep", label: "Morning prep list", page: Prep, only: ["restaurant"] },
  { icon: BookOpen, id: "recipes", label: "Recipes", page: Recipes, only: ["restaurant"] },
  { icon: FileSpreadsheet, id: "imports", label: "Zomato / Swiggy CSV", page: Imports, only: ["restaurant"] },
  { group: "Network" },
  { icon: NetworkIcon, id: "network", label: "Wholesaler network", page: Network },
  { group: "Money", only: OPS },
  { icon: BookUser, id: "khata", label: "Khata (udhaar)", page: Khata, only: OPS },
  { icon: IndianRupee, id: "reports", label: "Profit & GST", page: Reports, only: OPS },
  { icon: Trash2, id: "wastage", label: "Wastage", page: Wastage, only: OPS },
  { icon: Star, id: "reviews", label: "Reviews", page: Reviews, only: OPS },
  { group: "Settings" },
  { icon: SettingsIcon, id: "settings", label: "Business & Telegram", page: Settings },
];

const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; } };

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Signs the persona's demo account in (if needed) and loads its businesses. */
async function connect(persona) {
  let { data: { session } } = await supabase.auth.getSession();
  if (session?.user?.email !== persona.email) {
    if (session) await supabase.auth.signOut({ scope: "local" });
    const { data, error } = await supabase.auth.signInWithPassword({ email: persona.email, password: PASSWORD });
    if (error) throw new Error(`Demo sign-in for ${persona.email} failed: ${error.message}`);
    session = data.session;
  }
  const roles = await q(supabase.from("staff_roles").select("role, businesses(*)").eq("user_id", session.user.id));
  const businesses = roles.map((r) => ({ ...r.businesses, role: r.role }));
  if (!businesses.length) throw new Error(`${persona.email} has no business in the database.`);
  return { session, businesses };
}

export default function App() {
  const toast = useToast();
  const hash = useHash();
  const [personaId, setPersonaId] = useState(() => store("persona") ?? "shop");
  const persona = PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0];
  const [conn, setConn] = useState({ status: "connecting" });
  const [business, setBusiness] = useState(null);

  const start = useCallback(async () => {
    setConn({ status: "connecting" });
    try {
      const { session, businesses } = await connect(persona);
      current.session = session;
      setBusiness(businesses.find((b) => b.id === store("business_id")) ?? businesses[0]);
      setConn({ status: "ready", businesses });
    } catch (error) {
      console.error(error);
      setConn({ status: "error", error });
    }
  }, [persona.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { start(); }, [start]);

  current.business = business;

  // Live alert toasts for the selected business.
  useEffect(() => {
    if (!business) return;
    const channel = supabase.channel("alerts-" + business.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alerts", filter: `business_id=eq.${business.id}` },
        (p) => toast("🔔 " + p.new.message, "info"))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [business?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchPersona = (id) => { store("persona", id); setBusiness(null); setPersonaId(id); };
  const switcher = <PersonaSwitch value={persona.id} onChange={switchPersona} />;

  if (conn.status === "connecting") return <Splash />;
  if (conn.status === "error") return <NotConnected error={conn.error} retry={start} switcher={switcher} />;

  const type = business.business_type;
  const routes = ROUTES.filter((r) => !r.only || r.only.includes(type));
  const route = routes.find((r) => r.id === hash && r.page) ?? routes.find((r) => r.page);
  const PageComponent = route.page;
  const TypeIcon = TYPE_ICON[type];
  const pick = (id) => {
    const b = conn.businesses.find((x) => x.id === id);
    store("business_id", b.id);
    setBusiness(b);
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col bg-nav text-nav-ink md:sticky md:top-0 md:h-screen md:w-60">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <Logo />
          <div className="leading-tight">
            <div className="font-semibold text-white">Dukaan Sahayak</div>
            <div className="text-[11px] text-nav-muted">AI inventory assistant</div>
          </div>
        </div>
        <nav aria-label="Sections" className="flex gap-0.5 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-y-auto">
          {routes.map((r, i) => r.group
            ? <div key={"g" + i} className="mt-4 mb-1 hidden px-2.5 text-[10.5px] font-semibold tracking-wider text-nav-muted uppercase md:block">{r.group}</div>
            : (
              <a key={r.id} href={"#" + r.id} aria-current={r.id === route.id ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 whitespace-nowrap no-underline transition-colors ${r.id === route.id ? "bg-white/10 font-medium text-white" : "text-nav-ink hover:bg-nav-hover hover:text-white"}`}>
                <r.icon className={`size-4 ${r.id === route.id ? "text-indigo-300" : "text-nav-muted"}`} />
                {typeof r.label === "function" ? r.label(type) : r.label}
              </a>
            ))}
        </nav>
        <div className="hidden border-t border-white/5 px-5 py-3 text-[11px] text-nav-muted md:block">
          <ShieldCheck className="mr-1 inline size-3.5 align-[-2px]" />Every number computed by the database
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface/85 px-6 py-2.5 backdrop-blur">
          <span className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent"><TypeIcon className="size-4" /></span>
          {conn.businesses.length > 1
            ? <Select aria-label="Business" className="max-w-72 font-medium" value={business.id} onChange={(e) => pick(e.target.value)} options={conn.businesses.map((b) => [b.id, b.name])} />
            : <span className="font-semibold">{business.name}</span>}
          <span className="hidden text-xs text-muted capitalize sm:inline">{type}{business.city ? ` · ${business.city}` : ""}</span>
          <span className="flex-1" />
          {switcher}
          <span title={OFFLINE_DEMO ? "Runs entirely in the browser with generated sample data; no backend." : "Seeded demo data"}
            className="rounded-full bg-warn/10 px-2.5 py-0.5 text-[11px] font-medium text-warn ring-1 ring-warn/25 ring-inset">
            {OFFLINE_DEMO ? "Offline demo · sample data" : "Demo data"}
          </span>
        </header>
        <main className="min-w-0 flex-1 px-6 py-7">
          <PageComponent key={business.id + route.id} />
        </main>
      </div>
    </div>
  );
}

const TYPE_ICON = { shop: Store, restaurant: UtensilsCrossed, wholesaler: Warehouse };

function Logo({ big }) {
  return (
    <span className={`grid place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg shadow-indigo-500/30 ${big ? "size-11" : "size-9"}`}>
      <Brain className={big ? "size-6" : "size-5"} />
    </span>
  );
}

/** Segmented control for the three demo accounts. */
function PersonaSwitch({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Demo account" className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {PERSONAS.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={p.id === value} onClick={() => p.id !== value && onChange(p.id)}
          className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${p.id === value ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink"}`}>
          <p.icon className="size-3.5" /><span className="hidden sm:inline">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-3 text-muted"><Logo big /><span className="text-xs">Loading demo…</span></div>
    </div>
  );
}

/** Shown when the backend has no schema / demo accounts yet (instead of a login form). */
function NotConnected({ error, retry, switcher }) {
  const host = SUPABASE_URL.replace(/^https?:\/\//, "");
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3"><Logo big /><span className="text-lg font-semibold">Dukaan Sahayak</span></div>
          {switcher}
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warn/10 text-warn"><DatabaseZap className="size-5" /></span>
            <div>
              <h2 className="text-lg">The demo database isn't ready yet</h2>
              <p className="mt-1 text-muted">The app is pointed at <code>{host}</code>, but it could not load the demo business.</p>
            </div>
          </div>
          <pre className="mt-4 rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap text-muted">{error.message ?? String(error)}</pre>
          <p className="mt-4 font-medium">To fix it, apply the schema and demo seed to that project:</p>
          <pre className="mt-2 rounded-lg bg-nav p-3 font-mono text-xs leading-relaxed text-nav-ink">{`supabase link --project-ref ${host.split(".")[0]}
supabase db push --include-seed
supabase config push`}</pre>
          <p className="mt-3 text-xs text-muted">Or run the local stack (<code>supabase start</code>) and point <code>VITE_SUPABASE_URL</code> in <code>dummy-frontend/.env.local</code> at it.</p>
          <div className="mt-5"><Button icon={RefreshCw} onClick={retry}>Try again</Button></div>
        </div>
      </div>
    </div>
  );
}
