// Drains public.ai_jobs (service key only; pg_cron calls it every 2 minutes when work is pending).
// Kinds: embed_product, embed_listing (Gemini), review_sentiment, daily_insight (chat model).
// Failures go back to the queue with exponential backoff (finish_ai_job); rate limits pause the batch.
import { encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
import { buildFacts } from "../_shared/assistant.ts";
import { chatJSON, chatText, LANGUAGE_NAMES } from "../_shared/chat.ts";
import { config } from "../_shared/config.ts";
import { embeddingModel, geminiEmbed, toPgVector } from "../_shared/gemini.ts";
import { json, readJson, serve } from "../_shared/http.ts";
import { AIError } from "../_shared/retry.ts";
import { sentimentValidator } from "../_shared/schemas.ts";
import { adminClient, type Business, type Ctx, requireService } from "../_shared/supabase.ts";

type Job = { id: number; business_id: string | null; kind: string; payload: { id: string }; attempts: number };
const admin = adminClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serve(async (req) => {
  requireService(req);
  const body = await readJson<{ limit?: number; kinds?: string[] }>(req).catch(() => ({} as { limit?: number; kinds?: string[] }));
  const limit = Math.min(body.limit ?? config.limits.worker_batch_size, 50);
  const { data: jobs, error } = await admin.rpc("claim_ai_jobs", { p_limit: limit, p_kinds: body.kinds ?? null });
  if (error) throw new Error(error.message);

  const summary = { claimed: jobs.length, done: 0, failed: 0, deferred: 0 };
  let pausedFor: number | null = null;

  // Sentiment jobs are batched into one chat call.
  const reviews = (jobs as Job[]).filter((j) => j.kind === "review_sentiment");
  const others = (jobs as Job[]).filter((j) => j.kind !== "review_sentiment");

  if (reviews.length) {
    try {
      await runSentiment(reviews);
      for (const j of reviews) await finish(j.id);
      summary.done += reviews.length;
    } catch (e) {
      const err = asAIError(e);
      for (const j of reviews) await finish(j.id, err.message, retryAfter(err));
      summary.failed += reviews.length;
      if (err.rateLimited) pausedFor = retryAfter(err);
    }
  }

  for (const job of others) {
    if (pausedFor !== null) {
      await finish(job.id, "deferred: rate limited", pausedFor);
      summary.deferred++;
      continue;
    }
    try {
      if (job.kind === "embed_product") await embedProduct(job.payload.id);
      else if (job.kind === "embed_listing") await embedListing(job.payload.id);
      else if (job.kind === "daily_insight") await dailyInsight(job.business_id!, job.payload.id);
      await finish(job.id);
      summary.done++;
      await sleep(150); // stay friendly with free-tier rate limits
    } catch (e) {
      const err = asAIError(e);
      await finish(job.id, err.message, retryAfter(err));
      summary.failed++;
      if (err.rateLimited) pausedFor = retryAfter(err);
    }
  }
  return json(summary);
});

function asAIError(e: unknown) {
  return e instanceof AIError ? e : new AIError(e instanceof Error ? e.message : String(e));
}
function retryAfter(err: AIError): number | null {
  if (err.status === 503) return 6 * 3600; // key not configured: try again later, don't hammer
  if (err.rateLimited) return Math.max(err.retryAfterSeconds ?? 60, 60);
  return null; // default exponential backoff in finish_ai_job
}
async function finish(id: number, error: string | null = null, retrySeconds: number | null = null) {
  await admin.rpc("finish_ai_job", { p_id: id, p_error: error, p_retry_after_seconds: retrySeconds });
}

// ---------------------------------------------------------------- embeddings (Gemini)
async function embedProduct(id: string) {
  const { data: p } = await admin.from("products").select("id, name, category, unit, kind, embedded_name").eq("id", id).maybeSingle();
  if (!p) return; // deleted meanwhile
  if (p.embedded_name === p.name) return;
  const text = [p.name, p.category && `category: ${p.category}`, `unit: ${p.unit}`].filter(Boolean).join(". ");
  const v = await geminiEmbed({ text });
  const { error } = await admin.from("products")
    .update({ embedding: toPgVector(v), embedding_model: embeddingModel(), embedded_name: p.name }).eq("id", id);
  if (error) throw new Error(error.message);
}

async function embedListing(id: string) {
  const { data: l } = await admin.from("wholesaler_listings").select("id, name, description, category, unit, image_path").eq("id", id).maybeSingle();
  if (!l) return;
  const text = [l.name, l.description, l.category && `category: ${l.category}`, `unit: ${l.unit}`].filter(Boolean).join(". ");
  const files = [];
  if (l.image_path) {
    const { data } = await admin.storage.from("listing-images").download(l.image_path);
    if (data) files.push({ mimeType: data.type || "image/jpeg", base64: encodeBase64(new Uint8Array(await data.arrayBuffer())) });
  }
  const v = await geminiEmbed({ text, files });
  const { error } = await admin.from("wholesaler_listings")
    .update({ embedding: toPgVector(v), embedding_model: embeddingModel(), embedded_name: l.name }).eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- review sentiment (chat model, batched)
async function runSentiment(jobs: Job[]) {
  const ids = jobs.map((j) => j.payload.id);
  const { data: reviews } = await admin.from("reviews").select("id, business_id, rating, review_text, source").in("id", ids);
  const todo = (reviews ?? []).filter((r) => r.review_text);
  if (!todo.length) return;
  const { data } = await chatJSON(
    `Classify customer reviews of Indian shops/restaurants (any language). For each review return its id, sentiment
(positive|neutral|negative), score from -1 to 1, and up to 4 short English topic tags (e.g. "taste", "delivery time", "packaging", "price", "staff", "freshness").
JSON: {"results": [{"id": string, "sentiment": string, "score": number, "topics": [string]}]}`,
    JSON.stringify(todo.map((r) => ({ id: r.id, rating: r.rating, text: r.review_text!.slice(0, 1500) }))),
    sentimentValidator,
    { fast: true },
  );
  const now = new Date().toISOString();
  for (const res of data.results) {
    const r = todo.find((x) => x.id === res.id);
    if (!r) continue;
    await admin.from("reviews").update({
      sentiment: res.sentiment, sentiment_score: Math.round(res.score * 1000) / 1000, topics: res.topics, analyzed_at: now,
    }).eq("id", r.id);
    if (res.sentiment === "negative") {
      await admin.from("alerts").insert({
        business_id: r.business_id, kind: "review", severity: "warning",
        message: `Negative ${r.source} review${r.rating ? ` (${r.rating}★)` : ""}: "${r.review_text!.slice(0, 140)}"`,
        data: { review_id: r.id, topics: res.topics }, dedupe_key: `review:${r.id}`,
      });
    }
  }
}

// ---------------------------------------------------------------- nightly insight (chat model writes, SQL computes)
async function dailyInsight(businessId: string, jobKey: string) {
  const { data: business } = await admin.from("businesses").select("*").eq("id", businessId).single<Business>();
  if (!business) return;
  const ctx: Ctx = { db: admin, admin, userId: null, viaService: true, business };
  const { facts } = await buildFacts(ctx);
  const { text } = await chatText(
    `You write a short morning note (max 3 lines) for the owner of a small Indian ${business.business_type}, in ${LANGUAGE_NAMES[business.language]}.
Use ONLY the numbers in FACTS; never compute new numbers. Mention one thing that went well, one risk (low stock, expiry, wastage or margin) and one action for today.`,
    "FACTS:\n" + JSON.stringify(facts),
    { maxTokens: 250 },
  );
  await admin.from("alerts").insert({
    business_id: businessId, kind: "insight", severity: "info", message: text.slice(0, 1000),
    data: { generated_for: jobKey.split(":")[1] }, dedupe_key: `insight:${jobKey}`,
  });
}
