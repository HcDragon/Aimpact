// Basic answers via an OpenAI-compatible chat API (Groq by default, xAI Grok optional).
import type { z } from "npm:zod@3.23.8";
import { chatProvider, config } from "./config.ts";
import { AIError, fetchJSON, withRetry } from "./retry.ts";

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function complete(messages: Msg[], opts: { json?: boolean; fast?: boolean; maxTokens?: number }) {
  const p = chatProvider();
  if (!p.apiKey) throw new AIError(`${p.api_key_env} is not set`, 503);
  const model = opts.fast ? p.fast_model : p.model;
  const res = await withRetry(() =>
    fetchJSON(`${p.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: config.chat.temperature,
        max_tokens: opts.maxTokens ?? config.chat.max_tokens,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    }, config.chat.timeout_ms)
  );
  const content: string = res?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new AIError("Chat model returned no content", 422);
  return { content, model };
}

export async function chatText(system: string, user: string, opts: { fast?: boolean; history?: Msg[]; maxTokens?: number } = {}) {
  const r = await complete([{ role: "system", content: system }, ...(opts.history ?? []), { role: "user", content: user }], opts);
  return { text: r.content.trim(), model: r.model };
}

/** JSON-mode completion validated with zod. The schema description goes in the system prompt. */
export async function chatJSON<T>(system: string, user: string, validator: z.ZodType<T>, opts: { fast?: boolean } = {}) {
  const r = await complete(
    [{ role: "system", content: system + "\nRespond with a single JSON object only." }, { role: "user", content: user }],
    { ...opts, json: true },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new AIError("Chat model returned invalid JSON", 422);
  }
  const out = validator.safeParse(parsed);
  if (!out.success) throw new AIError(`Chat JSON failed validation: ${out.error.issues[0]?.path.join(".")} ${out.error.issues[0]?.message}`, 422);
  return { data: out.data, model: r.model };
}

export const chatModelName = (fast = false) => {
  const p = chatProvider();
  return fast ? p.fast_model : p.model;
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "simple English",
  hi: "Hindi (Devanagari script)",
  mr: "Marathi (Devanagari script)",
  hinglish: "Hinglish (Hindi in Latin script mixed with English)",
};
