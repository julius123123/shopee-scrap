#!/usr/bin/env python3
import json
import os
import re
import sys
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = "api_received"
_count = {"n": 0}


def safe(s):
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", str(s) or "x")


def page_from_url(url):
    try:
        return parse_qs(urlparse(url).query).get("page", ["0"])[0]
    except Exception:
        return "0"


def target_path(kind, meta, n):
    """Reconstruct the extension's local path from type + metadata."""
    if kind == "product":
        store = safe(meta.get("store", "store"))
        page = page_from_url(meta.get("url", ""))
        return os.path.join(OUT, "shopee", "product", store, f"shopee_{store}_page_{page}.json")
    if kind == "review":
        shop = safe(meta.get("shop_id", "x"))
        item = safe(meta.get("product_id", "x"))
        page = safe(meta.get("page", "1"))
        return os.path.join(OUT, "shopee", "review", shop, item, f"shopee_comment_{item}_page_{page}.json")
    return os.path.join(OUT, "other", f"{n:04d}_{safe(kind)}.json")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            data = None

        _count["n"] += 1
        n = _count["n"]
        kind = data.get("type") if isinstance(data, dict) else "?"
        meta = data.get("metadata", {}) if isinstance(data, dict) else {}
        raw = data.get("raw") if isinstance(data, dict) else None
        raw_info = (
            f"{len(raw)} items" if isinstance(raw, list)
            else f"{len(raw.get('ratings', []))} ratings" if isinstance(raw, dict) and "ratings" in raw
            else "-"
        )

        # Save the {raw, metadata} body (same shape as the local file), in the
        # reconstructed tree so payload maps 1:1 to the extension's output.
        path = target_path(kind, meta, n)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        to_save = {"raw": data.get("raw"), "metadata": meta} if isinstance(data, dict) else data
        with open(path, "w", encoding="utf-8") as f:
            json.dump(to_save, f, ensure_ascii=False, indent=2)

        print(f"[{n}] {kind:8} raw={raw_info:14} -> {path}")

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass  # silence default per-request logging


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(OUT, exist_ok=True)
    print(f"Listening on 0.0.0.0:{port}  (LAN + localhost) — path /ingest")
    print(f"Saving payloads under ./{OUT}/   (Ctrl+C to stop)\n")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
