export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-business-id, x-telegram-chat-id",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

/** Wraps a handler with CORS preflight and uniform error responses. */
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e);
      return json({ error: msg }, 500);
    }
  });
}
