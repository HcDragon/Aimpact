// Gemini-powered search. Photo or text -> wholesaler listings (prices inside our network only)
// or the business's own catalog.
// POST { business_id | telegram_chat_id, image_base64? , mime_type?, text?, scope?: "network" | "catalog", limit? }
// -> { results[], method: "embedding" | "text" }
import { decodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
import { cached, sha256 } from "../_shared/cache.ts";
import { cacheTtlHours, config } from "../_shared/config.ts";
import { embeddingModel, geminiEmbed, stripDataUrl, toPgVector } from "../_shared/gemini.ts";
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { getContext, must } from "../_shared/supabase.ts";

serve(async (req) => {
  const body = await readJson<{
    business_id?: string; telegram_chat_id?: number; image_base64?: string; mime_type?: string;
    text?: string; scope?: "network" | "catalog"; limit?: number;
  }>(req);
  const ctx = await getContext(req, body);
  const scope = body.scope ?? "network";
  const limit = Math.min(Math.max(body.limit ?? 8, 1), 30);
  const text = body.text?.trim();
  if (!text && !body.image_base64) throw new HttpError(400, "text or image_base64 is required");

  // ---- embed the query (images are never cached by content beyond the hash)
  let embedding: number[] | null = null;
  let embedError: string | null = null;
  try {
    if (body.image_base64) {
      const file = stripDataUrl(body.image_base64);
      file.mimeType ||= body.mime_type || "image/jpeg";
      if (decodeBase64(file.base64).length > config.limits.max_image_bytes) throw new HttpError(413, "Image too large");
      embedding = await geminiEmbed({ text: text || undefined, files: [file] });
    } else {
      const key = "embq:" + embeddingModel() + ":" + await sha256(text!.toLowerCase());
      embedding = (await cached(ctx.admin, key, cacheTtlHours("embedding_query"), embeddingModel(), () => geminiEmbed({ text }))).value;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    embedError = (e as Error).message;
  }

  if (embedding) {
    const vec = toPgVector(embedding);
    const results = scope === "catalog"
      ? must(await ctx.db.rpc("match_products", { p_business_id: ctx.business.id, p_embedding: vec, p_limit: limit }), "match_products")
      : must(await ctx.db.rpc("match_wholesaler_listings", { p_embedding: vec, p_limit: limit }), "match_wholesaler_listings");
    return json({ method: "embedding", results });
  }

  // ---- fallback without AI: trigram text search (needs text)
  if (!text) return json({ method: "none", results: [], error: "Photo search is unavailable right now. Try typing the item name.", detail: embedError });
  const results = scope === "catalog"
    ? (must(await ctx.db.rpc("match_product_names", { p_business_id: ctx.business.id, p_names: [text], p_min_similarity: 0.15 }), "match") as any[])
      .filter((r) => r.product_id).map((r) => ({ product_id: r.product_id, name: r.product_name, similarity: r.similarity }))
    : must(await ctx.db.rpc("search_wholesaler_listings_text", { p_query: text, p_limit: limit }), "search");
  return json({ method: "text", results, detail: embedError });
});
