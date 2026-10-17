// Called by the Telegram bot (service key only).
//   POST { action: "link", code, chat_id }   -> links the chat to the business that generated the code
//   POST { action: "resolve", chat_id }      -> which business(es) this chat is linked to
//   POST { action: "unlink", chat_id }
// Owners generate the 6-digit code in the app: rpc('create_telegram_link_code', { p_business_id }).
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { adminClient, must, requireService } from "../_shared/supabase.ts";

serve(async (req) => {
  requireService(req);
  const body = await readJson<{ action?: string; code?: string; chat_id?: number | string }>(req);
  const chatId = Number(body.chat_id);
  if (!Number.isFinite(chatId)) throw new HttpError(400, "chat_id is required");
  const admin = adminClient();

  switch (body.action ?? "link") {
    case "link": {
      if (!body.code || !/^\d{6}$/.test(body.code.trim())) throw new HttpError(400, "6-digit code is required");
      return json(must(await admin.rpc("consume_telegram_link_code", { p_code: body.code.trim(), p_chat_id: chatId }), "link"));
    }
    case "resolve": {
      const rows = must(await admin.from("telegram_links")
        .select("business_id, user_id, linked_at, businesses(name, business_type, language)")
        .eq("telegram_chat_id", chatId).not("linked_at", "is", null).order("linked_at", { ascending: false }), "resolve");
      return json({ linked: (rows ?? []).length > 0, businesses: rows ?? [] });
    }
    case "unlink": {
      must(await admin.from("telegram_links").delete().eq("telegram_chat_id", chatId), "unlink");
      return json({ ok: true });
    }
    default:
      throw new HttpError(400, "Unknown action");
  }
});
