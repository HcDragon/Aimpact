/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, newlines inside quotes). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Parse "2 x Paneer Tikka, 1 x Roti" / "Paneer Tikka x 2 | Roti x1" / "Paneer Tikka (2)" / "Paneer Tikka". */
export function parseItemsCell(cell: string): { name: string; qty: number }[] {
  return cell.split(/\s*[,;|\n]\s*/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
    let m = seg.match(/^(\d+(?:\.\d+)?)\s*[xX×*]\s*(.+)$/);
    if (m) return { name: m[2].trim(), qty: Number(m[1]) };
    m = seg.match(/^(.+?)\s*[xX×*]\s*(\d+(?:\.\d+)?)$/);
    if (m) return { name: m[1].trim(), qty: Number(m[2]) };
    m = seg.match(/^(.+?)\s*\((\d+(?:\.\d+)?)\)$/);
    if (m) return { name: m[1].trim(), qty: Number(m[2]) };
    return { name: seg, qty: 1 };
  }).filter((i) => i.name && i.qty > 0);
}

/** Dates from aggregator exports, interpreted as IST. Returns ISO string or null. */
export function parseIndianDateTime(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return toIso(+m[1], +m[2], +m[3], +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0));
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) {
    let h = +(m[4] ?? 12);
    if (m[7]) h = (h % 12) + (m[7].toLowerCase() === "pm" ? 12 : 0);
    return toIso(+m[3], +m[2], +m[1], h, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  const t = Date.parse(s + " GMT+0530");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function toIso(y: number, mo: number, d: number, h: number, mi: number, se: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}+05:30`).toISOString();
}

export function findColumn(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h.trim()));
    if (i >= 0) return i;
  }
  return -1;
}
