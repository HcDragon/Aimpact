// Tiny rule-based command parser used when the chat model is unavailable,
// so simple stock updates keep working without AI.
import type { Command } from "./schemas.ts";

const NUMBER_WORDS: Record<string, number> = {
  ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, panch: 5, five: 5,
  chhe: 6, che: 6, six: 6, saat: 7, seven: 7, aath: 8, eight: 8, nau: 9, nine: 9, das: 10, ten: 10,
  aadha: 0.5, half: 0.5, dedh: 1.5, dhai: 2.5, bara: 12, barah: 12, dozen: 12, darjan: 12, bees: 20, pachas: 50, sau: 100,
};

const INTENT_WORDS: [Command["intent"], RegExp][] = [
  ["khata_payment", /\b(paid|jama|chukaya|wapas|returned money|payment)\b/i],
  ["khata_credit", /\b(udhaar|udhar|credit|khata)\b/i],
  ["log_wastage", /\b(waste|wastage|kharab|spoil|spoiled|fenk|phenk|expired|sad gaya)\b/i],
  ["check_stock", /\b(kitna|kitne|how much|how many|stock left|bacha|baki|shillak)\b/i],
  ["add_stock", /\b(aaya|aya|aayi|received|receive|kharida|bought|purchase|maal|stock add|add)\b/i],
  ["record_sale", /\b(becha|bech|bika|biki|sold|sale|vikla|vikle)\b/i],
];

const FILLER = /\b(becha|bech|bika|biki|sold|sale|aaya|aya|aayi|received|kharida|bought|add|stock|ka|ki|ke|of|and|aur|ne|ko|mein|me|rs|rupees|rupaye|kg|ml|pcs|packet|packets|pack|kilo|litre|liter|udhaar|udhar|credit|paid|jama|kiya|kiye|diya|hai|tha|gaya|kitna|kitne|bacha|bachi|baki|how|much|many|left|is|are|there|in|waste|wastage|kharab|spoiled|expired)\b/gi;

export function ruleParse(text: string): Command | null {
  const intent = INTENT_WORDS.find(([, re]) => re.test(text))?.[0];
  if (!intent) return null;
  const lower = text.toLowerCase().replace(/[,.;]/g, " ");

  if (intent === "khata_credit" || intent === "khata_payment") {
    const amount = Number(lower.match(/(\d+(?:\.\d+)?)/)?.[1]);
    const customer = text.replace(/\d+(\.\d+)?/g, "").replace(FILLER, "").replace(/₹/g, "").replace(/\s+/g, " ").trim();
    if (!amount || !customer) return null;
    return { intent, items: [], customer, amount };
  }

  // "<qty> <item words>" pairs, e.g. "2 maggi 3 parle g" or "do maggi"
  const tokens = lower.split(/\s+/).filter(Boolean);
  const items: Command["items"] = [];
  let qty: number | null = null;
  let words: string[] = [];
  const flush = () => {
    const name = words.join(" ").replace(FILLER, "").replace(/\s+/g, " ").trim();
    if (name) items.push({ name, qty: qty ?? 1 });
    words = [];
  };
  for (const tok of tokens) {
    const n = /^\d+(\.\d+)?$/.test(tok) ? Number(tok) : NUMBER_WORDS[tok];
    if (n !== undefined) {
      if (words.length) flush();
      qty = n;
    } else {
      words.push(tok);
    }
  }
  flush();
  if (!items.length) return null;
  return { intent, items, question: intent === "check_stock" ? text : null };
}
