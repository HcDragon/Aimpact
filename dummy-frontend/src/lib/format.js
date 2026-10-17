// INR, DD/MM/YYYY and IST formatting; forecast method labels.
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
export const UNITS = ["pcs", "kg", "g", "l", "ml", "pack", "box", "plate", "dozen"];

export const inr = (paise) =>
  paise === null || paise === undefined ? "-" : "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const toPaise = (r) => (r === "" || r === null || r === undefined ? null : Math.round(Number(r) * 100));
export const rupees = (paise) => (paise === null || paise === undefined ? "" : (Number(paise) / 100).toString());
export const qty = (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
export const round1 = (n) => Math.round(Number(n) * 10) / 10;
export const pct = (n, digits = 1) => (n === null || n === undefined ? "-" : Number(n).toFixed(digits) + "%");
export const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00+05:30" : d).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }) : "-");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }) : "-");
export const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export function daysFrom(base, n) {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysAgo = (n) => daysFrom(istToday(), -n);

export const METHOD_LABEL = {
  prophet: "Prophet", category: "Category model", moving_average: "Moving average",
  seasonal_naive: "Last-week baseline", rule: "Rule (new item)",
};
