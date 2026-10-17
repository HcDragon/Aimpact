import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

export async function sha256(...parts: (string | Uint8Array)[]) {
  const enc = new TextEncoder();
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length + 1; // separator byte
  }
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read-through cache in public.ai_cache (service role). Cache failures never break the call. */
export async function cached<T>(admin: SupabaseClient, key: string, ttlHours: number, model: string, fn: () => Promise<T>) {
  try {
    const { data } = await admin.from("ai_cache").select("response, expires_at").eq("cache_key", key).maybeSingle();
    if (data && new Date(data.expires_at) > new Date()) return { value: data.response as T, cached: true };
  } catch { /* ignore */ }
  const value = await fn();
  try {
    await admin.from("ai_cache").upsert({
      cache_key: key,
      response: value as unknown as Record<string, unknown>,
      model,
      expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
    });
  } catch { /* ignore */ }
  return { value, cached: false };
}
