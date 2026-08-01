#!/usr/bin/env python3
"""A persistent Chromium the agent (and you) share.

The Node server spawns this on demand and proxies /api/browser/* to it. It is
deliberately dumb: it exposes browser primitives only. The see-think-act loop
lives in the /browser page, so this process never blocks on a model call.

The profile is persistent (BROWSER_PROFILE, default .data/browser-profile), so
when you log into Shopify once, the session survives restarts.

    python3 agent/browser_service.py [--port 8788] [--headless]
"""
import argparse
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is not installed:  python3 -m pip install playwright")

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILE = pathlib.Path(os.environ.get("BROWSER_PROFILE", ROOT / ".data" / "browser-profile"))
# Blank by default: admin.shopify.com lands on a Cloudflare bot check, which
# has no readable controls, so the agent would start out blind.
START_URL = os.environ.get("BROWSER_START_URL", "about:blank")

lock = threading.Lock()
state = {"ctx": None, "page": None, "pw": None}

# Runs in the page. Returns the visible interactive controls with their centre
# coordinates, plus the readable text — enough for a text-only model to decide
# what to do without ever seeing a picture.
ELEMENTS_JS = r"""
() => {
  const SEL = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [onclick]';
  const seen = new Set();
  const items = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;

    let label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                 el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
    label = label.replace(/\s+/g, ' ').slice(0, 90);
    const kind = el.tagName.toLowerCase() +
                 (el.type ? ':' + el.type : '') +
                 (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '');
    if (!label && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;

    const key = kind + '|' + label + '|' + Math.round(r.x) + ',' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      i: items.length,
      kind,
      label,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      editable: ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()),
    });
    if (items.length >= 120) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 6000);
  return {
    url: location.href, title: document.title,
    scrollY: Math.round(scrollY), scrollHeight: Math.round(document.body.scrollHeight),
    viewport: {w: innerWidth, h: innerHeight},
    elements: items, text,
  };
}
"""


def teardown():
    """Release Chromium AND the Playwright driver. Nulling the handles without
    calling stop() leaves the driver's event loop registered in this thread, and
    the next sync_playwright().start() dies with 'Sync API inside the asyncio
    loop'."""
    for key, close in (("ctx", "close"), ("pw", "stop")):
        obj = state.get(key)
        if obj is not None:
            try:
                getattr(obj, close)()
            except Exception:
                pass
    state.update(ctx=None, page=None, pw=None)


def ensure(headless: bool):
    """Start Chromium once; reuse it afterwards."""
    if state["page"] is not None:
        return state["page"]
    PROFILE.mkdir(parents=True, exist_ok=True)
    # A hard-killed Chromium leaves Singleton* behind and the next launch hangs
    # or refuses. Nothing else is using this profile — we are the only user.
    for lockname in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            (PROFILE / lockname).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
    try:
        state["pw"] = sync_playwright().start()
    except Exception as e:
        # The driver is wedged beyond repair in this process. Exiting is clean:
        # the Node server notices and spawns a fresh sidecar.
        print("fatal: playwright would not start (%s) — exiting for a respawn" % e, flush=True)
        os._exit(3)
    try:
        state["ctx"] = _launch(headless)
    except Exception as e:
        msg = str(e)
        if "Executable doesn't exist" in msg or "playwright install" in msg:
            # Without this, the retry path trips Playwright's asyncio guard and
            # reports "Sync API inside the asyncio loop", which is nonsense here.
            teardown()
            raise RuntimeError(
                "Chromium is not installed for Playwright. Run:  "
                "python3 -m playwright install chromium") from None
        teardown()
        raise
    state["page"] = state["ctx"].pages[0] if state["ctx"].pages else state["ctx"].new_page()
    try:
        state["page"].goto(START_URL, wait_until="domcontentloaded", timeout=30000)
    except Exception:
        pass
    return state["page"]


def _launch(headless: bool):
    return state["pw"].chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=headless,
        viewport={"width": 1280, "height": 800},
        args=["--disable-blink-features=AutomationControlled"],
    )


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 on purpose: this server is single-threaded because sync
    # Playwright objects are bound to the thread that made them. Keep-alive
    # would let one idle connection block every other request.
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass  # the Node server already logs

    # -------------------------------------------------------------- helpers

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _png(self, data: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # ----------------------------------------------------------- endpoints

    def do_GET(self):
        try:
            if self.path.startswith("/screenshot"):
                with lock:
                    page = ensure(self.server.headless)
                    shot = page.screenshot(type="png")
                return self._png(shot)
            if self.path.startswith("/elements"):
                # A text description of what's on the page. This is how a
                # text-only model (DeepSeek) "sees" — no screenshot needed.
                with lock:
                    page = ensure(self.server.headless)
                    data = page.evaluate(ELEMENTS_JS)
                return self._json(200, data)
            if self.path.startswith("/state"):
                with lock:
                    page = state["page"]
                    if page is None:
                        return self._json(200, {"running": False, "healthy": False})
                    try:
                        # Touch the page: if Chromium died under us, this raises
                        # and we report unhealthy so the parent can restart us.
                        url, title = page.url, page.title()
                    except Exception as e:
                        teardown()
                        return self._json(200, {"running": False, "healthy": False,
                                                "error": str(e)[:160]})
                    return self._json(200, {
                        "running": True, "healthy": True, "url": url,
                        "title": title, "profile": str(PROFILE),
                    })
            return self._json(404, {"error": "unknown endpoint"})
        except Exception as e:
            return self._json(500, {"error": str(e)[:300]})

    def do_POST(self):
        body = self._body()
        try:
            with lock:
                page = ensure(self.server.headless)
                path = self.path.split("?")[0]

                if path == "/goto":
                    url = str(body.get("url") or "").strip()
                    if not url:
                        return self._json(400, {"error": "url required"})
                    if not url.startswith(("http://", "https://")):
                        url = "https://" + url
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)

                elif path == "/click":
                    page.mouse.click(float(body.get("x", 0)), float(body.get("y", 0)))

                elif path == "/type":
                    page.keyboard.type(str(body.get("text", "")), delay=18)

                elif path == "/key":
                    page.keyboard.press(str(body.get("key", "Enter")))

                elif path == "/scroll":
                    page.mouse.wheel(0, float(body.get("dy", 400)))

                elif path == "/back":
                    page.go_back(wait_until="domcontentloaded", timeout=30000)

                elif path == "/shutdown":
                    teardown()
                    return self._json(200, {"ok": True, "running": False})

                else:
                    return self._json(404, {"error": "unknown endpoint"})

                page.wait_for_timeout(int(body.get("settle", 700)))
                return self._json(200, {"ok": True, "url": page.url, "title": page.title()})
        except Exception as e:
            return self._json(500, {"error": str(e)[:300]})


def watch_parent(ppid: int):
    """Exit if the Node server that spawned us goes away, so we never orphan
    a Chromium holding the profile lock and the port."""
    import time
    while True:
        time.sleep(2)
        if os.getppid() != ppid:
            os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("BROWSER_PORT", 8788)))
    ap.add_argument("--headless", action="store_true",
                    help="run Chromium hidden (the live view still works)")
    args = ap.parse_args()

    if os.getppid() != 1:
        threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()

    HTTPServer.allow_reuse_address = True
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    srv.headless = args.headless          # single-threaded on purpose: sync Playwright
    print(f"browser service on 127.0.0.1:{args.port}  profile={PROFILE}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
