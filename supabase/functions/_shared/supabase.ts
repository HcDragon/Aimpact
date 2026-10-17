import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";
import { HttpError } from "./http.ts";

const url = () => Deno.env.get("SUPABASE_URL")!;

// Accept the legacy service-role JWT and the newer sb_secret_ keys.
function serviceKeys(): string[] {
  const keys = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")];
  try {
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    keys.push(...Object.values(secretKeys as Record<string, string>));
  } catch { /* not set */ }
  return keys.filter((k): k is string => !!k);
}

export function adminClient(): SupabaseClient {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? serviceKeys()[0];
  return createClient(url(), key, { auth: { persistSession: false } });
}

export type Business = {
  id: string;
  name: string;
  business_type: "shop" | "restaurant" | "wholesaler";
  language: "en" | "hi" | "mr" | "hinglish";
  lead_time_days: number;
  expiry_alert_days: number;
};

export type Ctx = {
  /** Client for business data: user-scoped (RLS) or admin when called by a trusted service. */
  db: SupabaseClient;
  admin: SupabaseClient;
  userId: string | null;
  viaService: boolean;
  business: Business;
};

function bearer(req: Request) {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
}

export function isServiceCall(req: Request) {
  const token = bearer(req);
  return !!token && serviceKeys().includes(token);
}

/**
 * Resolve who is calling and for which business.
 * - App users: Authorization = their JWT; business_id must be one they belong to (checked via RLS).
 * - Telegram bot / cron: Authorization = service key; business via business_id or telegram chat id.
 */
export async function getContext(
  req: Request,
  body: { business_id?: string; telegram_chat_id?: number | string } = {},
): Promise<Ctx> {
  const admin = adminClient();
  const businessId = body.business_id ?? req.headers.get("x-business-id") ?? undefined;
  const chatId = body.telegram_chat_id ?? req.headers.get("x-telegram-chat-id") ?? undefined;

  if (isServiceCall(req)) {
    let id = businessId;
    if (!id && chatId) {
      const { data } = await admin.from("telegram_links").select("business_id")
        .eq("telegram_chat_id", chatId).not("linked_at", "is", null).order("linked_at", { ascending: false }).limit(1);
      id = data?.[0]?.business_id;
      if (!id) throw new HttpError(404, "This Telegram chat is not linked to a business yet");
    }
    if (!id) throw new HttpError(400, "business_id or telegram_chat_id is required");
    const { data: business } = await admin.from("businesses").select("*").eq("id", id).single();
    if (!business) throw new HttpError(404, "Business not found");
    return { db: admin, admin, userId: null, viaService: true, business };
  }

  const token = bearer(req);
  if (!token) throw new HttpError(401, "Missing Authorization header");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const db = createClient(url(), anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) throw new HttpError(401, "Invalid or expired session");
  if (!businessId) throw new HttpError(400, "business_id is required");
  // RLS only returns businesses the user is a member of.
  const { data: business } = await db.from("businesses").select("*").eq("id", businessId).maybeSingle();
  if (!business) throw new HttpError(403, "You are not a member of this business");
  return { db, admin, userId: user.id, viaService: false, business };
}

export function requireService(req: Request) {
  if (!isServiceCall(req)) throw new HttpError(403, "Service key required");
}

/** Throws on a Supabase error, returns data otherwise. */
export function must<T>(res: { data: T; error: { message: string } | null }, what = "query"): T {
  if (res.error) throw new HttpError(400, `${what} failed: ${res.error.message}`);
  return res.data;
}
