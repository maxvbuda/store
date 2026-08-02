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

# Driver choice matters for bot detection. Patchright is a drop-in Playwright
# replacement that removes the tells plain Playwright leaves behind (CDP
# artefacts, Runtime.enable, navigator.webdriver), which is what trips
# Cloudflare / reCAPTCHA on sites like the Shopify admin. Fall back to stock
# Playwright + playwright_stealth if patchright is unavailable.
# patchright is the stronger anti-detection driver in principle, but its
# Chromium exits on its own within seconds on this machine, so stock
# Playwright + playwright_stealth (what Crawl4AI's StealthAdapter uses) is
# the default. Set BROWSER_DRIVER=patchright to try it again.
DRIVER = os.environ.get("BROWSER_DRIVER", "playwright").lower()
_stealth = None

if DRIVER == "patchright":
    try:
        from patchright.sync_api import sync_playwright
    except ImportError:
        DRIVER = "playwright"

if DRIVER != "patchright":
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("no browser driver:  python3 -m pip install patchright playwright")
    try:
        from playwright_stealth import Stealth
        _stealth = Stealth()
    except ImportError:
        pass

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILE = pathlib.Path(os.environ.get("BROWSER_PROFILE", ROOT / ".data" / "browser-profile"))
# Our own start page: renders instantly, has no bot check, and tells the user
# what to do. about:blank was worse than the Cloudflare wall — a blank white
# rectangle just reads as "the browser is broken".
START_URL = os.environ.get("BROWSER_START_URL",
                           "http://127.0.0.1:8787/agent-start.html")

lock = threading.Lock()
# last_launch_error survives teardown() (which nulls page/ctx/pw) so /state
# can tell "never tried yet, that's fine" apart from "tried and it's broken"
# — otherwise both look identical (page is None) and the parent never learns
# a restart won't help until the underlying problem (e.g. Chromium missing)
# is actually fixed.
state = {"ctx": None, "page": None, "pw": None, "last_launch_error": None}

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


def reap_orphans():
    """Kill any Chromium still holding our profile.

    A sidecar that is SIGKILLed cannot close its browser, so the Chromium
    survives as an orphan. The next sidecar then launches a second one while
    the stale window lingers and /state disagrees with what is on screen.
    Only one sidecar ever owns a profile, so anything using it now is dead wood.
    """
    import subprocess
    try:
        out = subprocess.run(["pgrep", "-f", str(PROFILE)],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return 0
    me = os.getpid()
    killed = 0
    for line in out.split():
        try:
            pid = int(line)
        except ValueError:
            continue
        if pid == me:
            continue
        try:
            os.kill(pid, 9)
            killed += 1
        except OSError:
            pass
    if killed:
        print("reaped %d orphaned browser process(es) holding the profile" % killed, flush=True)
    return killed


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
    reap_orphans()
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
            state["last_launch_error"] = (
                "Chromium is not installed for Playwright. Run:  "
                "python3 -m playwright install chromium")
            raise RuntimeError(state["last_launch_error"]) from None
        teardown()
        state["last_launch_error"] = msg[:200]
        raise
<<<<<<< HEAD
    # Close anything the profile restored, then work from one known tab.
    pages = list(state["ctx"].pages)
    state["page"] = pages[0] if pages else state["ctx"].new_page()
    for extra in pages[1:]:
        try:
            extra.close()
        except Exception:
            pass
=======
    state["last_launch_error"] = None
    state["page"] = state["ctx"].pages[0] if state["ctx"].pages else state["ctx"].new_page()
>>>>>>> 121e0b062f78eaf865421bf7fdf7d0b2f3dcf2c2
    if _stealth is not None:
        try:
            _stealth.apply_stealth_sync(state["page"])
        except Exception:
            pass
    # Always land on the start page. This used to swallow every failure, so a
    # restored tab from a previous session stayed on screen and looked like the
    # browser had a mind of its own.
    try:
        state["page"].goto(START_URL, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        print("could not open the start page (%s) — retrying once" % str(e)[:90], flush=True)
        try:
            state["page"].goto(START_URL, wait_until="commit", timeout=20000)
        except Exception as e2:
            print("start page still unreachable: %s" % str(e2)[:90], flush=True)
    return state["page"]


def _launch(headless: bool):
    # channel="chrome" uses the real Google Chrome you have installed, which is
    # far less detectable than the bundled Chromium build. Falls back if absent.
    kwargs = dict(
        user_data_dir=str(PROFILE),
        headless=headless,
        viewport={"width": 1280, "height": 800},
        no_viewport=False,
        # Without these the profile restores whatever was open last — which is
        # why a page from an earlier test kept coming back on every launch.
        # Cookies and logins still persist; only tab restore is suppressed.
        args=["--hide-crash-restore-bubble", "--no-first-run", "--no-default-browser-check"],
        ignore_default_args=["--restore-last-session"],
    )
    # NOT "chrome" by default: if the user already has Google Chrome open,
    # a second Chrome with a different profile delegates to the running
    # instance and exits, leaving a dead page and blank screenshots.
    # Patchright's stealth comes from its patches, not from the channel.
    channel = os.environ.get("BROWSER_CHANNEL", "")
    if channel and channel != "chromium":
        try:
            return state["pw"].chromium.launch_persistent_context(channel=channel, **kwargs)
        except Exception as e:
            print("channel %r unavailable (%s) — using bundled chromium"
                  % (channel, str(e)[:80]), flush=True)
    return state["pw"].chromium.launch_persistent_context(**kwargs)


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
                        resp = {"running": False, "healthy": False}
                        if state["last_launch_error"]:
                            resp["error"] = state["last_launch_error"]
                        return self._json(200, resp)
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


def _on_signal(signum, frame):
    """SIGTERM should close Chromium, not orphan it."""
    try:
        teardown()
    finally:
        os._exit(0)


def watch_parent(ppid: int):
    """Exit if the Node server that spawned us goes away, so we never orphan
    a Chromium holding the profile lock and the port."""
    import time
    while True:
        time.sleep(2)
        if os.getppid() != ppid:
            try:
                teardown()
            finally:
                os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("BROWSER_PORT", 8788)))
    ap.add_argument("--headless", action="store_true",
                    help="run Chromium hidden (the live view still works)")
    args = ap.parse_args()

    import signal
    # A killed browser can leave the driver writing to a dead pipe. Default
    # SIGPIPE handling kills us mid-recovery; ignoring it lets teardown run.
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    except (AttributeError, ValueError):
        pass
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    if os.getppid() != 1:
        threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()

    HTTPServer.allow_reuse_address = True
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    srv.headless = args.headless          # single-threaded on purpose: sync Playwright
    print(f"browser service on 127.0.0.1:{args.port}  driver={DRIVER}  profile={PROFILE}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
