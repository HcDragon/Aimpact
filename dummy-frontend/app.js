// App shell: sign-in (phone OTP or email for dev), business selection/onboarding, navigation, realtime alerts.
import { busy, card, field, formValues, h, q, select, state, supabase, toast, words } from "./lib.js";
import * as views from "./views/index.js";

const ROUTES = [
  { group: "Daily" },
  { id: "dashboard", label: "Dashboard", view: views.dashboard },
  { id: "sell", label: "Sell / POS", view: views.sell, not: ["wholesaler"] },
  { id: "assistant", label: "Assistant & voice", view: views.assistant },
  { id: "alerts", label: "Alerts", view: views.alerts },
  { group: "Inventory" },
  { id: "stock", label: () => words().stock, view: views.stock, not: ["wholesaler"] },
  { id: "purchases", label: "Purchases & bill scan", view: views.purchases, not: ["wholesaler"] },
  { id: "reorder", label: "Reorder & POs", view: views.reorder, not: ["wholesaler"] },
  { id: "forecasts", label: "Forecasts", view: views.forecasts, not: ["wholesaler"] },
  { id: "suppliers", label: "Suppliers", view: views.suppliers, not: ["wholesaler"] },
  { id: "network", label: "Wholesaler network", view: views.network },
  { group: "Restaurant", only: ["restaurant"] },
  { id: "recipes", label: "Recipes", view: views.recipes, only: ["restaurant"] },
  { id: "wastage", label: "Wastage", view: views.wastage, only: ["restaurant", "shop"] },
  { id: "imports", label: "Zomato / Swiggy CSV", view: views.imports, only: ["restaurant"] },
  { group: "Money" },
  { id: "khata", label: "Khata (udhaar)", view: views.khata, not: ["wholesaler"] },
  { id: "reports", label: "Profit & GST", view: views.reports, not: ["wholesaler"] },
  { id: "reviews", label: "Reviews", view: views.reviews, not: ["wholesaler"] },
  { group: "Settings" },
  { id: "settings", label: "Business & Telegram", view: views.settings },
];

const visible = (r) => {
  const t = state.business?.business_type;
  return (!r.only || r.only.includes(t)) && (!r.not || !r.not.includes(t));
};

// ---------------------------------------------------------------- boot
supabase.auth.onAuthStateChange((event, session) => {
  const changed = (session?.user?.id ?? null) !== (state.session?.user?.id ?? null);
  state.session = session;
  // supabase-js warns against awaiting other calls inside this callback
  if (event === "INITIAL_SESSION" || changed) setTimeout(boot, 0);
});
window.addEventListener("hashchange", render);

async function boot() {
  if (!state.session) return renderLogin();
  document.getElementById("user-box").replaceChildren(
    h("span", { class: "muted" }, state.session.user.phone ? "+" + state.session.user.phone : state.session.user.email), " ",
    h("button", { class: "secondary", onclick: () => supabase.auth.signOut() }, "Sign out"),
  );
  const roles = await q(supabase.from("staff_roles").select("role, businesses(*)").eq("user_id", state.session.user.id));
  state.businesses = roles.map((r) => ({ ...r.businesses, role: r.role }));
  if (!state.businesses.length) return renderOnboarding();
  const saved = localStorageGet("business_id");
  state.business = state.businesses.find((b) => b.id === saved) ?? state.businesses[0];
  renderBusinessSwitch();
  subscribeRealtime();
  render();
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

function renderBusinessSwitch() {
  const sel = select(state.businesses.map((b) => [b.id, `${b.name} (${b.business_type})`]), state.business.id, {
    onchange: (e) => {
      state.business = state.businesses.find((b) => b.id === e.target.value);
      localStorageSet("business_id", state.business.id);
      subscribeRealtime();
      render();
    },
  });
  document.getElementById("business-switch").replaceChildren(sel,
    h("button", { class: "secondary", onclick: renderOnboarding }, "+ New business"));
}

let channel;
function subscribeRealtime() {
  if (channel) supabase.removeChannel(channel);
  channel = supabase.channel("alerts-" + state.business.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "alerts", filter: `business_id=eq.${state.business.id}` },
      (p) => toast("🔔 " + p.new.message, "info"))
    .subscribe();
}

async function render() {
  if (!state.business) return;
  const current = location.hash.slice(1) || "dashboard";
  const routes = ROUTES.filter(visible);
  document.getElementById("nav").replaceChildren(...routes.map((r) =>
    r.group ? h("div", { class: "group" }, r.group)
      : h("a", { href: "#" + r.id, class: r.id === current ? "active" : "" }, typeof r.label === "function" ? r.label() : r.label)));
  const route = routes.find((r) => r.id === current && r.view) ?? routes.find((r) => r.view);
  const view = document.getElementById("view");
  view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    const el = await route.view();
    view.replaceChildren(el);
  } catch (e) {
    console.error(e);
    view.replaceChildren(card("Error", h("pre", {}, e.message)));
  }
}

// ---------------------------------------------------------------- sign in
function renderLogin() {
  document.getElementById("nav").replaceChildren();
  document.getElementById("business-switch").replaceChildren();
  document.getElementById("user-box").replaceChildren();
  const phoneForm = h("form", { class: "row" },
    field("Phone (with country code)", h("input", { name: "phone", value: "919999900001", required: true })),
    h("button", {}, "Send OTP"));
  const otpForm = h("form", { class: "row", style: { display: "none" } },
    field("OTP", h("input", { name: "token", value: "123456", required: true, inputMode: "numeric" })),
    h("button", {}, "Verify"));
  let phone = "";
  phoneForm.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      phone = formValues(phoneForm).phone.replace(/\D/g, "");
      const { error } = await supabase.auth.signInWithOtp({ phone });
      if (error) throw error;
      otpForm.style.display = "";
      toast("OTP sent (test numbers use 123456)");
    });
  };
  otpForm.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await supabase.auth.verifyOtp({ phone, token: formValues(otpForm).token, type: "sms" });
      if (error) throw error;
    });
  };
  const emailForm = h("form", { class: "row" },
    field("Email", h("input", { name: "email", value: "shop@demo.test" })),
    field("Password", h("input", { name: "password", type: "password", value: "password123" })),
    h("button", {}, "Sign in"));
  emailForm.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await supabase.auth.signInWithPassword(formValues(emailForm));
      if (error) throw error;
    });
  };
  document.getElementById("view").replaceChildren(h("div", { class: "login" },
    card("Sign in with phone", phoneForm, otpForm,
      h("p", { class: "muted" }, "Demo numbers: 919999900001 (shop), 919999900002 (restaurant), 919999900003 (wholesaler). OTP 123456.")),
    card("Dev sign-in (email)", emailForm,
      h("p", { class: "muted" }, "shop@demo.test · restaurant@demo.test · wholesale@demo.test — password123"))));
}

// ---------------------------------------------------------------- onboarding
function renderOnboarding() {
  const form = h("form", {},
    h("div", { class: "row" },
      field("Business name", h("input", { name: "name", required: true })),
      field("Type", select([["shop", "Shop / kirana"], ["restaurant", "Restaurant"], ["wholesaler", "Wholesaler"]], "shop", { name: "type" })),
      field("Language", select([["hinglish", "Hinglish"], ["hi", "हिंदी"], ["mr", "मराठी"], ["en", "English"]], "hinglish", { name: "language" }))),
    h("div", { class: "row" },
      field("City", h("input", { name: "city" })),
      field("GSTIN (optional)", h("input", { name: "gstin" })),
      field("State code", h("input", { name: "state_code", placeholder: "27", size: 4 }))),
    h("p", {}, h("button", {}, "Create business")));
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const v = formValues(form);
      const { data, error } = await supabase.rpc("create_business", {
        p_name: v.name, p_business_type: v.type, p_language: v.language, p_city: v.city || null,
        p_gstin: v.gstin || null, p_state_code: v.state_code || null, p_phone: state.session.user.phone || null,
      });
      if (error) throw error;
      localStorageSet("business_id", data);
      toast("Business created");
      boot();
    });
  };
  document.getElementById("view").replaceChildren(h("div", { style: { maxWidth: "640px" } }, card("Set up your business", form)));
}
