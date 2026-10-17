// Voice-intent validator (FR-E3). Mirrors ml/validators/voice_intent.py; both run
// against shared/ai/fixtures/voice_cases.json.

import { isNum, isObject, isStrOrNull, parseModelJson, unexpectedKeys } from "./common.ts";

export const INTENTS = ["add_stock", "record_sale", "query_stock", "query_sales", "unknown"];
export const LANGUAGES = ["hi", "mr", "en", "hinglish"];
const KEYS = ["intent", "item", "qty", "unit", "language", "needs_clarification"];
const NEEDS_ITEM_AND_QTY = ["add_stock", "record_sale"];

export type VoiceIntent = {
  intent: "add_stock" | "record_sale" | "query_stock" | "query_sales" | "unknown";
  item: string | null;
  qty: number | null;
  unit: string | null;
  language: "hi" | "mr" | "en" | "hinglish";
  needs_clarification: boolean;
};

export type VoiceResult =
  | { valid: false; fallback: "manual_entry"; errors: string[] }
  | { valid: true; intent: VoiceIntent; can_write: boolean };

export function validateVoiceIntent(raw: unknown): VoiceResult {
  const x = parseModelJson(raw);
  if (x === undefined) return { valid: false, fallback: "manual_entry", errors: ["output is not valid JSON"] };
  if (!isObject(x)) return { valid: false, fallback: "manual_entry", errors: ["output is not a JSON object"] };

  const errors = unexpectedKeys(x, KEYS, "");
  for (const k of KEYS) if (!(k in x)) errors.push(`${k}: missing`);
  if (!INTENTS.includes(x.intent as string)) errors.push("intent: not an allowed value");
  if (!LANGUAGES.includes(x.language as string)) errors.push("language: not an allowed value");
  if ("item" in x && !isStrOrNull(x.item)) errors.push("item: not a string");
  if ("unit" in x && !isStrOrNull(x.unit)) errors.push("unit: not a string");
  if ("qty" in x && x.qty !== null && !(isNum(x.qty) && x.qty > 0)) errors.push("qty: not a positive number");
  if ("needs_clarification" in x && typeof x.needs_clarification !== "boolean") {
    errors.push("needs_clarification: not a boolean");
  }
  if (errors.length) return { valid: false, fallback: "manual_entry", errors };

  const intent = { ...(x as VoiceIntent) };
  if (typeof intent.item === "string" && intent.item.trim() === "") intent.item = null;
  // A stock-changing intent without both item and quantity is never written as-is.
  if (NEEDS_ITEM_AND_QTY.includes(intent.intent) && (intent.item === null || intent.qty === null)) {
    intent.needs_clarification = true;
  }
  const can_write = NEEDS_ITEM_AND_QTY.includes(intent.intent) && !intent.needs_clarification;
  return { valid: true, intent, can_write };
}
