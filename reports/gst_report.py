"""GST + sales PDF report for one business and period.

All figures come from the database functions gst_report() and profit_report();
this script only lays them out.

    python reports/gst_report.py --business-id <uuid> --from 2026-09-01 --to 2026-09-30
    python reports/gst_report.py --business-id <uuid> --month 2026-09

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (env or .env in the repo root).
"""

from __future__ import annotations

import argparse
import calendar
import os
import sys
from datetime import date, datetime
from pathlib import Path

import requests
from dotenv import load_dotenv
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def rpc(name: str, params: dict) -> dict:
    url = os.environ["SUPABASE_URL"].rstrip("/") + f"/rest/v1/rpc/{name}"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    res = requests.post(url, json=params, headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=60)
    if not res.ok:
        sys.exit(f"{name} failed: {res.status_code} {res.text[:300]}")
    return res.json()


def inr(paise: float | int | None) -> str:
    """Indian digit grouping, e.g. 12,34,567.89"""
    if paise is None:
        return "-"
    rupees = int(paise) / 100
    neg = rupees < 0
    whole, frac = f"{abs(rupees):.2f}".split(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    out = ",".join(groups + [tail]) if groups else tail
    return ("-" if neg else "") + "Rs " + out + "." + frac


def ddmmyyyy(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%d/%m/%Y")


def table(rows: list[list[str]], widths: list[float]) -> Table:
    t = Table(rows, colWidths=[w * mm for w in widths], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f4e79")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#b0b7c3")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f5f9")]),
    ]))
    return t


def build(business_id: str, start: date, end: date, out: Path) -> Path:
    gst = rpc("gst_report", {"p_business_id": business_id, "p_from": start.isoformat(), "p_to": end.isoformat()})
    pnl = rpc("profit_report", {"p_business_id": business_id, "p_from": start.isoformat(), "p_to": end.isoformat()})
    biz = gst["business"]

    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm,
                            title=f"GST report {biz['name']}")
    el = [
        Paragraph(f"<b>{biz['name']}</b>", styles["Title"]),
        Paragraph(f"GSTIN: {biz.get('gstin') or '-'} &nbsp;&nbsp; State code: {biz.get('state_code') or '-'}", styles["Normal"]),
        Paragraph(f"Period: {ddmmyyyy(gst['from'])} to {ddmmyyyy(gst['to'])} &nbsp;&nbsp; Generated: {date.today().strftime('%d/%m/%Y')}", styles["Normal"]),
        Spacer(1, 6 * mm),
        Paragraph("Summary", styles["Heading2"]),
        table([
            ["Item", "Amount"],
            ["Output tax (on sales)", inr(gst["output_tax_paise"])],
            ["Input tax credit (on purchases)", inr(gst["input_tax_credit_paise"])],
            ["Net GST payable", inr(gst["net_payable_paise"])],
            ["ITC carried forward", inr(gst["itc_carry_forward_paise"])],
        ], [110, 60]),
        Spacer(1, 5 * mm),
    ]

    def rate_rows(rows):
        body = [[f"{r['gst_rate']:g}%", inr(r["taxable_paise"]), inr(r["cgst_paise"]), inr(r["sgst_paise"]), inr(r["tax_paise"])] for r in rows]
        return [["GST rate", "Taxable value", "CGST", "SGST", "Total tax"]] + (body or [["-", "-", "-", "-", "-"]])

    el += [Paragraph("Outward supplies (sales) by rate", styles["Heading2"]), table(rate_rows(gst["outward"]), [25, 40, 35, 35, 35]), Spacer(1, 5 * mm)]
    el += [Paragraph("Inward supplies (purchases) by rate", styles["Heading2"]), table(rate_rows(gst["inward"]), [25, 40, 35, 35, 35]), Spacer(1, 5 * mm)]

    hsn = [["HSN", "Unit", "Rate", "Qty", "Taxable value", "Tax"]] + [
        [h["hsn"], h["unit"], f"{h['gst_rate']:g}%", f"{float(h['qty']):g}", inr(h["taxable_paise"]), inr(h["tax_paise"])] for h in gst["hsn_summary"]
    ]
    el += [Paragraph("HSN summary", styles["Heading2"]), table(hsn, [25, 20, 20, 25, 45, 35]), Spacer(1, 5 * mm)]

    el += [
        Paragraph("Sales and profit", styles["Heading2"]),
        table([
            ["Item", "Amount"],
            ["Gross sales (incl. GST)", inr(pnl["gross_sales_paise"])],
            ["Revenue (excl. GST)", inr(pnl["revenue_paise"])],
            ["Cost of goods sold", inr(pnl["cogs_paise"])],
            ["Wastage", inr(pnl["wastage_paise"])],
            ["Net profit", inr(pnl["net_profit_paise"])],
            ["Margin", f"{pnl['margin_pct']}%"],
            ["Bills", str(pnl["bills"])],
        ], [110, 60]),
        Spacer(1, 4 * mm),
        Paragraph("CGST/SGST split assumes intra-state supply. Verify with your CA before filing.", styles["Italic"]),
    ]
    doc.build(el)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--business-id", required=True)
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--month", help="YYYY-MM (instead of --from/--to)")
    ap.add_argument("--out", help="output PDF path (default reports/out/gst_<business>_<from>_<to>.pdf)")
    a = ap.parse_args()

    if a.month:
        y, m = map(int, a.month.split("-"))
        start, end = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    elif a.start and a.end:
        start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    else:
        ap.error("give --month or both --from and --to")

    out = Path(a.out) if a.out else ROOT / "reports" / "out" / f"gst_{a.business_id[:8]}_{start}_{end}.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    print(build(a.business_id, start, end, out))


if __name__ == "__main__":
    main()
