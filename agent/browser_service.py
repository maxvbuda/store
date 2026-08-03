#!/usr/bin/env python3
"""A persistent Chromium the agent (and you) share.

The Node server spawns this on demand and proxies /api/browser/* to it. It is
deliberately dumb: it exposes browser primitives only. The see-think-act loop
lives in the /browser page, so this process never blocks on a model call.

Architecture: sync Playwright objects are bound to the thread that made them,
so ONE dedicated worker thread owns every Playwright/CDP call. HTTP handlers
(ThreadingHTTPServer) never touch the browser — they enqueue an op and wait
for the worker to run it. Between ops the worker pumps the CDP event loop,
which is what delivers screencast frames to the /stream live view.

The profile is persistent (BROWSER_PROFILE, default .data/browser-profile), so
when you log into Shopify once, the session survives restarts.

    python3 agent/browser_service.py [--port 8788] [--headless]
"""
import argparse
import base64
import json
import os
import pathlib
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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

# last_launch_error survives teardown() (which nulls page/ctx/pw) so /state
# can tell "never tried yet, that's fine" apart from "tried and it's broken"
# — otherwise both look identical (page is None) and the parent never learns
# a restart won't help until the underlying problem (e.g. Chromium missing)
# is actually fixed. Everything in here is touched by the worker thread only.
state = {"ctx": None, "page": None, "pw": None, "cdp": None,
         "last_launch_error": None}

# ------------------------------------------------------------ worker queue
# HTTP handler threads enqueue ops; the worker thread runs them one at a
# time, so every Playwright call stays on the thread that created the driver.

ops = queue.Queue()


class WorkerTimeout(Exception):
    """The worker did not answer in time — distinct from Playwright's own
    TimeoutError so the handler can map it to 504 rather than 500."""


class _Op:
    """One unit of Playwright work. The Event flips once result/error is set."""
    __slots__ = ("fn", "args", "done", "result", "error")

    def __init__(self, fn, args):
        self.fn, self.args = fn, args
        self.done = threading.Event()
        self.result = None
        self.error = None


def call(fn, *args, timeout=90.0):
    """Run fn(*args) on the worker thread and wait for the answer."""
    op = _Op(fn, args)
    ops.put(op)
    if not op.done.wait(timeout):
        raise WorkerTimeout("browser worker did not answer within %ds" % int(timeout))
    if op.error is not None:
        raise op.error
    return op.result


def worker_loop():
    """Owns Playwright for the life of the process. Drains the ops queue;
    when idle, pumps the CDP event loop so screencast frames keep arriving."""
    while True:
        try:
            op = ops.get_nowait()
        except queue.Empty:
            if state["page"] is None:
                # Nothing to pump yet — block cheaply until an op shows up.
                try:
                    op = ops.get(timeout=0.05)
                except queue.Empty:
                    continue
            else:
                try:
                    state["page"].wait_for_timeout(25)
                except Exception:
                    time.sleep(0.05)  # dead page; don't busy-spin on the error
                continue
        try:
            op.result = op.fn(*op.args)
        except Exception as e:
            op.error = e
        finally:
            op.done.set()


# ------------------------------------------------------------- live view
# The screencast handler (worker thread) writes here; /stream readers (HTTP
# threads) wait on the condition. Nobody on the read side touches Playwright.
frame_cond = threading.Condition()
frame = {"bytes": b"", "seq": 0}  # seq is monotonic across relaunches on purpose

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
    """(worker thread) Release Chromium AND the Playwright driver. Nulling the
    handles without calling stop() leaves the driver's event loop registered in
    this thread, and the next sync_playwright().start() dies with 'Sync API
    inside the asyncio loop'."""
    for key, close in (("ctx", "close"), ("pw", "stop")):
        obj = state.get(key)
        if obj is not None:
            try:
                getattr(obj, close)()
            except Exception:
                pass
    state.update(ctx=None, page=None, pw=None, cdp=None)


def _attach_screencast():
    """(worker thread) open a CDP session on the current page and start the
    screencast that feeds /stream.

    The 'Page.screencastFrame' handler runs on the worker thread while it
    pumps wait_for_timeout, so acking from inside it is thread-safe. Called
    from ensure(), which also covers re-attachment whenever the page is
    recreated after a teardown/restart.
    """
    try:
        cdp = state["ctx"].new_cdp_session(state["page"])
    except Exception as e:
        print("no CDP session (%s) — /input and /stream degraded" % str(e)[:90], flush=True)
        state["cdp"] = None
        return
    state["cdp"] = cdp  # /input and /wheel work even if the screencast fails

    def on_frame(params):
        try:
            data = base64.b64decode(params.get("data") or "")
        except Exception:
            data = b""
        if data:
            with frame_cond:
                frame["bytes"] = data
                frame["seq"] += 1
                frame_cond.notify_all()
        # Chromium withholds the next frame until the last one is acked.
        try:
            cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            pass

    cdp.on("Page.screencastFrame", on_frame)
    try:
        cdp.send("Page.startScreencast", {
            "format": "jpeg", "quality": 60,
            "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 1,
        })
    except Exception as e:
        print("startScreencast failed: %s" % str(e)[:90], flush=True)


def _clean_start():
    """(worker thread) Make Chromium open a clean slate, not last time's tabs.

    We SIGKILL the sidecar's Chromium, so it never records a clean shutdown —
    exit_type stays "Crashed", and Chromium then restores the previous session
    (e.g. a bot-check page opened during testing) no matter that
    --restore-last-session is stripped. Two things stop that, and neither
    touches Cookies / Login Data, so logins still survive:
      1. mark the last exit clean in Preferences
      2. delete the session/tab-restore journals
    """
    prefs = PROFILE / "Default" / "Preferences"
    try:
        d = json.loads(prefs.read_text())
        prof = d.setdefault("profile", {})
        prof["exit_type"] = "Normal"
        prof["exited_cleanly"] = True
        # If a previous run pinned session restore, neutralise it (1 = last).
        sess = d.get("session")
        if isinstance(sess, dict) and sess.get("restore_on_startup") == 1:
            sess["restore_on_startup"] = 5  # open the New Tab Page
        prefs.write_text(json.dumps(d))
    except (OSError, ValueError):
        pass  # no prefs yet (first launch) — nothing to clean

    sessions = PROFILE / "Default" / "Sessions"
    try:
        for f in sessions.iterdir():
            if f.name.startswith(("Session_", "Tabs_")):
                f.unlink()
    except OSError:
        pass
    for name in ("Current Session", "Current Tabs", "Last Session", "Last Tabs"):
        try:
            (PROFILE / "Default" / name).unlink()
        except OSError:
            pass


def ensure(headless: bool):
    """(worker thread) Start Chromium once; reuse it afterwards."""
    page = state["page"]
    if page is not None:
        # A page that has closed under us (renderer crash, target gone) must not
        # be handed back — every op on it throws "Target page has been closed".
        # Tear it down so the relaunch below gives callers a live page instead
        # of waiting on the 5-minute watchdog.
        try:
            if not page.is_closed():
                return page
        except Exception:
            pass
        teardown()
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
    _clean_start()
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
    # Launched cleanly — clear any stale error from a previous failed attempt.
    state["last_launch_error"] = None
    # Own tab is a BRAND-NEW page, never a restored one — so even if the
    # profile revives old tabs (a signed-in Google, a page from testing) our
    # view is guaranteed clean. Everything else gets closed below.
    restored = list(state["ctx"].pages)
    state["page"] = state["ctx"].new_page()
    _close_others(state["page"])
    if _stealth is not None:
        try:
            _stealth.apply_stealth_sync(state["page"])
        except Exception:
            pass
    # Attach the live view before the first navigation so even the start page
    # load is visible in /stream.
    _attach_screencast()
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
    # Tabs the profile restores can arrive a beat late; sweep once more so a
    # slow Google/bot-check tab can't end up the visible one.
    _close_others(state["page"])
    return state["page"]


def _close_others(keep):
    """(worker) close every page in the context except `keep`."""
    ctx = state.get("ctx")
    if ctx is None:
        return
    for pg in list(ctx.pages):
        if pg is keep:
            continue
        try:
            pg.close()
        except Exception:
            pass


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
    # A residential/mobile proxy is the one thing that defeats Cloudflare on a
    # cloud server: the challenge is triggered by the datacenter IP, not the
    # browser, so no amount of stealth fixes it — a residential exit IP does.
    #   BROWSER_PROXY=http://user:pass@host:port   (or socks5://…)
    proxy = os.environ.get("BROWSER_PROXY", "").strip()
    if proxy:
        from urllib.parse import urlparse
        u = urlparse(proxy)
        server = "%s://%s%s" % (u.scheme or "http", u.hostname or "",
                                ":%d" % u.port if u.port else "")
        kwargs["proxy"] = {"server": server}
        if u.username:
            kwargs["proxy"]["username"] = u.username
        if u.password:
            kwargs["proxy"]["password"] = u.password
        print("routing through proxy %s" % server, flush=True)
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


# ------------------------------------------------------------- worker ops
# Everything below the "(worker)" marker runs on the worker thread only.

def _op_state():
    """(worker) health probe — same JSON as always."""
    page = state["page"]
    if page is None:
        resp = {"running": False, "healthy": False}
        if state["last_launch_error"]:
            resp["error"] = state["last_launch_error"]
        return resp
    try:
        # Touch the page: if Chromium died under us, this raises and we
        # report unhealthy so the parent can restart us.
        url, title = page.url, page.title()
    except Exception as e:
        teardown()
        return {"running": False, "healthy": False, "error": str(e)[:160]}
    return {"running": True, "healthy": True, "url": url,
            "title": title, "profile": str(PROFILE)}


def _op_screenshot(headless):
    return ensure(headless).screenshot(type="png")


def _op_elements(headless):
    # A text description of what's on the page. This is how a text-only
    # model (DeepSeek) "sees" — no screenshot needed.
    return ensure(headless).evaluate(ELEMENTS_JS)


def _op_prime(headless):
    """(worker) make sure the browser is up; if the screencast has not painted
    yet, hand back a one-off jpeg so /stream opens with something visible."""
    page = ensure(headless)
    with frame_cond:
        if frame["seq"]:
            return None
    try:
        return page.screenshot(type="jpeg", quality=60)
    except Exception:
        return None


def _mouse_event(body):
    """(worker) translate one /input op into raw CDP mouse events."""
    cdp = state["cdp"]
    if cdp is None:
        raise RuntimeError("no CDP session — browser not started")
    kind = str(body.get("type") or "")
    ev = {
        "x": float(body.get("x", 0)),
        "y": float(body.get("y", 0)),
        "button": str(body.get("button") or "left"),
        "clickCount": int(body.get("clickCount") or 1),
    }
    if kind == "move":
        cdp.send("Input.dispatchMouseEvent", dict(ev, type="mouseMoved"))
    elif kind == "down":
        cdp.send("Input.dispatchMouseEvent", dict(ev, type="mousePressed"))
    elif kind == "up":
        cdp.send("Input.dispatchMouseEvent", dict(ev, type="mouseReleased"))
    elif kind == "click":
        cdp.send("Input.dispatchMouseEvent", dict(ev, type="mousePressed"))
        cdp.send("Input.dispatchMouseEvent", dict(ev, type="mouseReleased"))
    else:
        raise ValueError("input type must be move|down|up|click")


def _op_post(headless, path, body):
    """(worker) the whole POST action table. Returns (status, json_obj)."""
    page = ensure(headless)

    if path == "/goto":
        url = str(body.get("url") or "").strip()
        if not url:
            return 400, {"error": "url required"}
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
        return 200, {"ok": True, "running": False}

    elif path == "/input":
        # Raw pointer events for the live view — no settle, callers stream
        # these at pointer-move rates and expect an immediate ack.
        try:
            _mouse_event(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        return 200, {"ok": True}

    elif path == "/wheel":
        if state["cdp"] is None:
            raise RuntimeError("no CDP session — browser not started")
        state["cdp"].send("Input.dispatchMouseEvent", {
            "type": "mouseWheel",
            "x": float(body.get("x", 0)), "y": float(body.get("y", 0)),
            "deltaX": 0.0, "deltaY": float(body.get("dy", 0)),
        })
        return 200, {"ok": True}

    else:
        return 404, {"error": "unknown endpoint"}

    page.wait_for_timeout(int(body.get("settle", 700)))
    return 200, {"ok": True, "url": page.url, "title": page.title()}


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 on purpose: every response is one-shot with Connection: close,
    # and the MJPEG /stream ends by connection close anyway. Handler threads
    # never touch Playwright — they enqueue ops and wait for the worker.
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

    # ------------------------------------------------------------ live view

    def _stream(self):
        """MJPEG live view, served entirely on this HTTP thread. It only ever
        reads the frame buffer; the priming screenshot goes through the worker
        queue like any other op. Each client tracks its own last-seen seq, so
        any number of parallel streams work."""
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()

            def part(jpeg):
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                self.wfile.write(b"Content-Length: %d\r\n\r\n" % len(jpeg))
                self.wfile.write(jpeg)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

            with frame_cond:
                started = frame["seq"] > 0
            if not started:
                # Browser idle or still launching: prime it and show a plain
                # screenshot so the viewer isn't blank while frames spin up.
                try:
                    shot = call(_op_prime, self.server.headless)
                except Exception:
                    shot = None
                with frame_cond:
                    started = frame["seq"] > 0
                if shot and not started:
                    part(shot)

            interval = 1.0 / 15  # contract fps cap
            next_write = 0.0
            last_seq = 0
            while True:
                with frame_cond:
                    if frame["seq"] == last_seq:
                        frame_cond.wait(timeout=2.0)
                    if frame["seq"] == last_seq:
                        # Static page, nothing new. Re-send the last frame as
                        # a keepalive so a vanished client raises BrokenPipe
                        # here instead of parking this thread forever.
                        if last_seq == 0:
                            continue
                        data = frame["bytes"]
                    else:
                        data, last_seq = frame["bytes"], frame["seq"]
                now = time.monotonic()
                if now < next_write:
                    time.sleep(next_write - now)
                part(data)
                next_write = time.monotonic() + interval
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client went away — the normal end of a stream

    # ----------------------------------------------------------- endpoints

    def do_GET(self):
        try:
            if self.path.startswith("/stream"):
                return self._stream()
            if self.path.startswith("/screenshot"):
                return self._png(call(_op_screenshot, self.server.headless))
            if self.path.startswith("/elements"):
                return self._json(200, call(_op_elements, self.server.headless))
            if self.path.startswith("/state"):
                return self._json(200, call(_op_state))
            return self._json(404, {"error": "unknown endpoint"})
        except WorkerTimeout as e:
            return self._json(504, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)[:300]})

    def do_POST(self):
        body = self._body()
        path = self.path.split("?")[0]
        try:
            status, obj = call(_op_post, self.server.headless, path, body)
            return self._json(status, obj)
        except WorkerTimeout as e:
            return self._json(504, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)[:300]})


def _exit_cleanly():
    """Teardown must run on the worker thread (sync Playwright objects are
    thread-bound), so enqueue it and give it a few seconds. If the worker is
    wedged mid-navigation, reap_orphans() on the next start mops up."""
    try:
        op = _Op(teardown, ())
        ops.put(op)
        op.done.wait(4)
    finally:
        os._exit(0)


def _on_signal(signum, frame_):
    """SIGTERM should close Chromium, not orphan it."""
    _exit_cleanly()


def watch_parent(ppid: int):
    """Exit if the Node server that spawned us goes away, so we never orphan
    a Chromium holding the profile lock and the port."""
    while True:
        time.sleep(2)
        if os.getppid() != ppid:
            _exit_cleanly()


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

    # The one thread allowed to touch Playwright. Launch stays lazy: the
    # browser starts on the first op that calls ensure().
    threading.Thread(target=worker_loop, daemon=True, name="playwright-worker").start()

    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.headless = args.headless  # ops read this via the handler threads
    print(f"browser service on 127.0.0.1:{args.port}  driver={DRIVER}  profile={PROFILE}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
