/** Rupees (possibly fractional, from AI or CSV) -> integer paise. */
export function toPaise(rupees: number | string | null | undefined): number | null {
  if (rupees === null || rupees === undefined || rupees === "") return null;
  const n = typeof rupees === "number" ? rupees : Number(String(rupees).replace(/[₹,\s]|Rs\.?/gi, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function inr(paise: number | null | undefined) {
  if (paise === null || paise === undefined) return "-";
  return "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** DD/MM/YYYY in IST */
export function indianDate(d: string | Date) {
  return new Date(d).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
}

export function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}
