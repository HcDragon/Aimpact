// Local OCR fallback for bill scans (ml/ocr/server.py, EasyOCR). Used when Gemini fails,
// is rate-limited or cannot read the bill. Returns null when the service is not configured
// or fails, so the caller falls back to manual entry as before.
import { config } from "./config.ts";
import { type Bill, billValidator } from "./schemas.ts";

export type OcrResult = { bill: Bill; warnings: string[]; accepted: boolean };

export async function ocrBill(base64: string, mimeType: string): Promise<OcrResult | null> {
  const url = Deno.env.get(config.ocr.service_url_env);
  if (!url || mimeType === "application/pdf") return null;
  const token = Deno.env.get(config.ocr.token_env);
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/scan-bill", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ image_base64: base64, mime_type: mimeType }),
      signal: AbortSignal.timeout(config.ocr.timeout_ms),
    });
    if (!res.ok) return null;
    const out = await res.json();
    if (!out.ok) return null;
    return { bill: billValidator.parse(out.bill), warnings: out.warnings ?? [], accepted: !!out.accepted };
  } catch {
    return null;
  }
}
