// Business Q&A. POST { business_id | telegram_chat_id, question, history?: [{role, content}] }
// -> { answer, ai, facts }   (ai=false means the chat model was unavailable and a plain summary was returned)
import { answerQuestion } from "../_shared/assistant.ts";
import { HttpError, json, readJson, serve } from "../_shared/http.ts";
import { getContext } from "../_shared/supabase.ts";

serve(async (req) => {
  const body = await readJson<{
    business_id?: string;
    telegram_chat_id?: number;
    question?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  }>(req);
  const ctx = await getContext(req, body);
  const question = body.question?.trim();
  if (!question) throw new HttpError(400, "question is required");
  if (question.length > 1000) throw new HttpError(400, "question is too long");
  const history = (body.history ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
  return json(await answerQuestion(ctx, question, history));
});
