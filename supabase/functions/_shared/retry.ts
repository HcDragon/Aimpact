import { config } from "./config.ts";

export class AIError extends Error {
  constructor(message: string, public status = 0, public retryAfterSeconds?: number) {
    super(message);
  }
  get rateLimited() {
    return this.status === 429;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries 429 / 5xx / network errors with exponential backoff + jitter (honours Retry-After). */
export async function withRetry<T>(fn: () => Promise<T>, retries = config.limits.max_retries): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError(e instanceof Error ? e.message : String(e));
      const retryable = err.status === 0 || err.status === 429 || err.status >= 500;
      if (!retryable || attempt >= retries) throw err;
      const backoff = config.limits.backoff_base_ms * 2 ** attempt + Math.random() * 250;
      const wait = err.retryAfterSeconds ? Math.min(err.retryAfterSeconds * 1000, 20000) : backoff;
      attempt++;
      await sleep(wait);
    }
  }
}

export async function fetchJSON(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new AIError(`${res.status}: ${text.slice(0, 300)}`, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError(e instanceof Error ? e.message : String(e), 0);
  } finally {
    clearTimeout(timer);
  }
}
