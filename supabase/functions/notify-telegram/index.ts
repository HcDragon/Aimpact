// Pushes new open alerts to every linked Telegram chat (pg_cron, 07:00 IST). Service key only.
// POST {} or { business_id } to limit to one business. Needs TELEGRAM_BOT_TOKEN.
import { json, readJson, serve } from "../_shared/http.ts";
import { adminClient, requireService } from "../_shared/supabase.ts";

const ICON: Record<string, string> = {
  out_of_stock: "🔴", low_stock: "🟠", expired: "⛔", expiry_soon: "⏳", reorder: "🛒", insight: "💡", review: "💬",
};

serve(async (req) => {
  requireService(req);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return json({ skipped: true, reason: "TELEGRAM_BOT_TOKEN not set" });
  const body = await readJson<{ business_id?: string }>(req).catch(() => ({} as { business_id?: string }));
  const admin = adminClient();

  let q = admin.from("telegram_links").select("business_id, telegram_chat_id, businesses(name, business_type)")
    .not("telegram_chat_id", "is", null);
  if (body.business_id) q = q.eq("business_id", body.business_id);
  const { data: links, error } = await q;
  if (error) throw new Error(error.message);

  const byBusiness = new Map<string, { chats: number[]; name: string }>();
  for (const l of links ?? []) {
    const e: { chats: number[]; name: string } = byBusiness.get(l.business_id) ?? { chats: [], name: (l.businesses as any)?.name ?? "" };
    e.chats.push(l.telegram_chat_id);
    byBusiness.set(l.business_id, e);
  }

  let sent = 0;
  const failures: string[] = [];
  for (const [businessId, { chats, name }] of byBusiness) {
    const { data: alerts } = await admin.from("alerts").select("id, kind, severity, message")
      .eq("business_id", businessId).eq("status", "open").is("notified_at", null)
      .order("severity", { ascending: true }).order("created_at", { ascending: false }).limit(15);
    if (!alerts?.length) continue;
    const text = `*${escape(name)}*\n` + alerts.map((a) => `${ICON[a.kind] ?? "•"} ${escape(a.message)}`).join("\n");
    let ok = true;
    for (const chat of chats) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
      });
      if (res.ok) sent++;
      else {
        ok = false;
        failures.push(`${chat}: ${res.status} ${(await res.text()).slice(0, 120)}`);
      }
    }
    if (ok) await admin.from("alerts").update({ notified_at: new Date().toISOString() }).in("id", alerts.map((a) => a.id));
  }
  return json({ businesses: byBusiness.size, messages_sent: sent, failures });
});

// Telegram MarkdownV2 escaping
function escape(s: string) {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (c) => "\\" + c);
}
