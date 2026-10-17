// Model names live only in config/ai.json. Keys come from env / Supabase secrets.
import aiConfig from "../../../config/ai.json" with { type: "json" };

export const config = aiConfig;

export type ChatProvider = keyof typeof aiConfig.chat.providers;

export function chatProvider() {
  const name = (Deno.env.get("CHAT_PROVIDER") ?? aiConfig.chat.default_provider) as ChatProvider;
  const p = aiConfig.chat.providers[name];
  if (!p) throw new Error(`Unknown CHAT_PROVIDER '${name}'`);
  return { name, ...p, apiKey: Deno.env.get(p.api_key_env) ?? "" };
}

export function geminiKey() {
  return Deno.env.get(aiConfig.gemini.api_key_env) ?? "";
}

export function cacheTtlHours(kind: keyof typeof aiConfig.limits.cache_ttl_hours) {
  return aiConfig.limits.cache_ttl_hours[kind];
}
