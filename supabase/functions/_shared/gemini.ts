// Gemini: search + multimodal only (bill photos, voice audio, embeddings).
import type { z } from "npm:zod@3.23.8";
import { config, geminiKey } from "./config.ts";
import { AIError, fetchJSON, withRetry } from "./retry.ts";

const g = config.gemini;

export type InlineFile = { mimeType: string; base64: string };

export function stripDataUrl(input: string): InlineFile {
  const m = input.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mimeType: m[1], base64: m[2] } : { mimeType: "", base64: input };
}

function requireKey() {
  const key = geminiKey();
  if (!key) throw new AIError("GEMINI_API_KEY is not set", 503);
  return key;
}

async function call(model: string, method: string, body: unknown) {
  const key = requireKey();
  return await withRetry(() =>
    fetchJSON(`${g.base_url}/models/${model}:${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    }, g.timeout_ms)
  );
}

/** Structured JSON extraction from text + files, validated with zod. */
export async function geminiJSON<T>(opts: {
  prompt: string;
  files?: InlineFile[];
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
}): Promise<T> {
  const parts: unknown[] = [{ text: opts.prompt }];
  for (const f of opts.files ?? []) parts.push({ inline_data: { mime_type: f.mimeType, data: f.base64 } });
  const res = await call(g.vision_model, "generateContent", {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: opts.jsonSchema, temperature: 0.1 },
  });
  const text = res?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  if (!text) throw new AIError(`Gemini returned no content (${res?.candidates?.[0]?.finishReason ?? res?.promptFeedback?.blockReason ?? "unknown"})`, 422);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIError("Gemini returned invalid JSON", 422);
  }
  const out = opts.validator.safeParse(parsed);
  if (!out.success) throw new AIError(`Gemini JSON failed validation: ${out.error.issues[0]?.message}`, 422);
  return out.data;
}

function normalize(v: number[]) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** One embedding for any mix of text and images (Gemini Embedding 2 is multimodal). */
export async function geminiEmbed(input: { text?: string; files?: InlineFile[] }): Promise<number[]> {
  const parts: unknown[] = [];
  if (input.text) parts.push({ text: input.text });
  for (const f of input.files ?? []) parts.push({ inline_data: { mime_type: f.mimeType, data: f.base64 } });
  if (!parts.length) throw new AIError("Nothing to embed", 400);
  const res = await call(g.embedding_model, "embedContent", {
    content: { parts },
    output_dimensionality: g.embedding_dimensions,
  });
  const values: number[] | undefined = res?.embedding?.values ?? res?.embeddings?.[0]?.values;
  if (!values || values.length !== g.embedding_dimensions) {
    throw new AIError(`Unexpected embedding size ${values?.length}`, 422);
  }
  return normalize(values);
}

export const toPgVector = (v: number[]) => `[${v.join(",")}]`;
export const embeddingModel = () => g.embedding_model;
export const visionModel = () => g.vision_model;
