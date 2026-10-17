// Shared helpers for validating Gemini output in Edge Functions (Deno) and Node tests.
// Only erasable TypeScript syntax is used so Node can run these files directly.

export type Flag = { field: string; message: string };

/** Parse model text as JSON, tolerating a ```json fence. Returns undefined on failure. */
export function parseModelJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function isStrOrNull(x: unknown): boolean {
  return x === null || typeof x === "string";
}

export function unexpectedKeys(obj: Record<string, unknown>, allowed: string[], path: string): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `${path}${k}: unexpected field`);
}

/** Money tolerance: the larger of an absolute amount and a relative share. */
export function close(a: number, b: number, abs: number, rel: number): boolean {
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
