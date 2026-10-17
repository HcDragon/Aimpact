"""HTTP wrapper around the OCR pipeline for the scan-bill Edge Function.

    python -m ocr.server [--host 0.0.0.0] [--port 8090]

POST /scan-bill  {"image_base64": "...", "mime_type": "image/jpeg"}
  -> {"ok": true, "engine": "easyocr", "bill": <scan-bill Bill shape>, "warnings": [...], "accepted": bool}
  -> {"ok": false, "reason": "..."}            (unreadable image, no line items)
GET  /health     -> {"ok": true}

Deno cannot run EasyOCR, so scan-bill calls this service when Gemini fails or is
rate-limited (OCR_SERVICE_URL). If OCR_SERVICE_TOKEN is set, requests must send
"Authorization: Bearer <token>". Nothing is saved here; the owner confirms the draft.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from settings import load_ai_config, load_config

_lock = threading.Lock()  # one EasyOCR model in memory; scans run one at a time
_engine = None


def to_edge_bill(result: dict) -> dict:
    """Pipeline result -> the Bill shape in supabase/functions/_shared/schemas.ts (rupees, not paise)."""
    bill, extra = result["bill"], result.get("extra", {})
    extra_items = extra.get("items") or [{} for _ in bill["items"]]
    return {
        "supplier_name": bill["supplier_name"],
        "supplier_gstin": bill["gstin"],
        "invoice_no": extra.get("invoice_no"),
        "invoice_date": bill["invoice_date"],
        "items": [{
            "name": it["name"], "qty": it["qty"], "unit": it["unit"], "unit_price": it["unit_price"],
            "line_amount": it["line_total"], "gst_rate": it["gst_rate"],
            "mrp": ex.get("mrp"), "hsn": ex.get("hsn"), "batch_no": None, "expiry_date": None,
        } for it, ex in zip(bill["items"], extra_items)],
        "printed_total": bill["invoice_total"],
        "unreadable": not bill["items"],
    }


def scan(image: bytes) -> dict:
    global _engine
    from ocr.engine import get_engine
    from ocr.pipeline import scan_bill

    cfg = load_config()
    with _lock:
        if _engine is None:
            _engine = get_engine(cfg)
        result = scan_bill(image, cfg, _engine)
    if not result["bill"]["items"]:
        return {"ok": False, "reason": "no line items found"}
    v = result["validation"]
    return {"ok": True, "engine": result["engine"], "bill": to_edge_bill(result),
            # scan-bill re-checks qty x rate and totals itself; send only OCR-specific warnings.
            "warnings": [w for w in result["bill"]["warnings"] if "does not match" not in w], "accepted": bool(v.get("valid") and v.get("accepted")),
            "flags": v.get("flags", [])}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        token = os.environ.get("OCR_SERVICE_TOKEN")
        return not token or self.headers.get("Authorization") == f"Bearer {token}"

    def do_GET(self) -> None:
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/scan-bill":
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(401, {"error": "unauthorised"})
        max_bytes = load_ai_config()["limits"]["max_image_bytes"]
        length = int(self.headers.get("Content-Length") or 0)
        if length > max_bytes * 4 // 3 + 4096:
            return self._send(413, {"error": "image too large"})
        try:
            body = json.loads(self.rfile.read(length))
            b64 = body["image_base64"].split(",", 1)[-1]  # tolerate data: URLs
            image = base64.b64decode(b64, validate=True)
        except (ValueError, KeyError, binascii.Error):
            return self._send(400, {"error": "image_base64 is required"})
        if (body.get("mime_type") or "image/jpeg") == "application/pdf":
            return self._send(200, {"ok": False, "reason": "PDF bills are not supported by OCR"})
        try:
            self._send(200, scan(image))
        except ValueError as e:  # undecodable image
            self._send(200, {"ok": False, "reason": str(e)})

    def log_message(self, fmt: str, *args) -> None:  # no request bodies in logs
        print(f"{self.address_string()} {fmt % args}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8090)
    a = p.parse_args()
    print(f"OCR service on http://{a.host}:{a.port} (auth {'on' if os.environ.get('OCR_SERVICE_TOKEN') else 'off'})")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
