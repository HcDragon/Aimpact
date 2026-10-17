// Supabase client and API wrappers. `current` holds the signed-in session and selected business;
// App keeps it up to date so pages can call rpc()/fn() without passing the business around.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config.js";
import { createDemoClient } from "../demo/client.js"; // OFFLINE DEMO

// OFFLINE DEMO: VITE_DEMO_MODE=offline swaps in an in-browser stand-in backend with sample data
// (src/demo/). To remove it, delete src/demo/ and these demo lines; the real client below stays.
export const OFFLINE_DEMO = import.meta.env.VITE_DEMO_MODE === "offline";

export const supabase = OFFLINE_DEMO ? createDemoClient() : createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const current = { session: null, business: null, products: [] };

export const isRestaurant = () => current.business?.business_type === "restaurant";
export const isWholesaler = () => current.business?.business_type === "wholesaler";
export function words() {
  const r = isRestaurant();
  return { products: r ? "Ingredients" : "Products", product: r ? "ingredient" : "product", stock: r ? "Pantry" : "Stock" };
}

export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

/** RPC scoped to the current business. */
export const rpc = (name, args = {}) => q(supabase.rpc(name, { p_business_id: current.business.id, ...args }));
export const rpcRaw = (name, args = {}) => q(supabase.rpc(name, args));
export const from = (table) => supabase.from(table);
/** Select from a business-owned table, filtered to the current business. */
export const mine = (table, columns = "*") => from(table).select(columns).eq("business_id", current.business.id);

/** Edge Function call; the user's JWT is sent automatically. */
export async function fn(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body: { business_id: current.business.id, ...body } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return data;
}

export async function loadProducts() {
  current.products = await q(mine("product_stock").order("name"));
  return current.products;
}
export const productName = (id) => current.products.find((p) => p.product_id === id)?.name ?? "?";
