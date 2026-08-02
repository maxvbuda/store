#!/usr/bin/env python3
"""Rebuild app/operator.html from ~/Downloads/Operator.html + app/operator-logic.js.

Operator.html is a self-extracting bundle (same format as the original
AutoStore export): a JSON manifest of gzip+base64 assets plus an HTML template
that references them by UUID. This unpacks the assets into app/op/ and splices
in the live logic, so the shipped design is preserved byte-for-byte while the
data behind it comes from the real agent and browser.

    python3 build_operator.py
"""
import base64
import gzip
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
BUNDLE = pathlib.Path.home() / "Downloads" / "Operator.html"
APP = ROOT / "app"
OUT = APP / "operator.html"
LOGIC = APP / "operator-logic.js"
ASSETS = APP / "op"

RESOURCE_MAP = {
    "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "vendor/react.production.min.js",
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "vendor/react-dom.production.min.js",
    "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js": "vendor/babel.min.js",
}

EXT = {"application/javascript": ".js", "text/javascript": ".js",
       "text/css": ".css", "font/woff2": ".woff2"}


def section(src: str, name: str) -> str:
    m = re.search(r'<script type="__bundler/%s">\s*(.*?)\s*</script>' % name, src, re.S)
    if not m:
        raise SystemExit("Operator.html is missing the %s section" % name)
    return m.group(1)


def main() -> None:
    if not BUNDLE.exists():
        raise SystemExit("not found: %s" % BUNDLE)
    src = BUNDLE.read_text()
    manifest = json.loads(section(src, "manifest"))
    html = json.loads(section(src, "template"))

    ASSETS.mkdir(parents=True, exist_ok=True)
    for uuid, entry in manifest.items():
        raw = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            raw = gzip.decompress(raw)
        name = uuid + EXT.get(entry.get("mime", ""), ".bin")
        (ASSETS / name).write_bytes(raw)
        html = html.replace(uuid, "op/" + name)

    # Vendored React/Babel instead of unpkg (the runtime checks __resources).
    shim = "<script>window.__resources = %s;</script>\n" % json.dumps(RESOURCE_MAP, indent=2)
    html = html.replace("<script src=\"op/", shim + "<script src=\"op/", 1)

    # Swap the bundled demo logic for the live version.
    m = re.search(r'(<script[^>]*data-dc-script[^>]*>)(.*?)(</script>)', html, re.S)
    if not m:
        raise SystemExit("could not find the x-dc logic script")
    html = html[:m.start()] + m.group(1) + "\n" + LOGIC.read_text() + "\n" + m.group(3) + html[m.end():]

    # The digest header shipped as fixed copy ("Sunday 2 August", 47 tasks,
    # an eleven-hour summary). Bind each to the real run so Updates reflects
    # what actually happened.
    DIGEST = {
        ">Sunday 2 August</span>": ">{{ digestDate }}</span>",
        ('>Completed</span>\n              <span style="font-size: 17px;">47</span>'):
            '>Completed</span>\n              <span style="font-size: 17px;">{{ digestDone }}</span>',
        ('>Needs you</span>\n              <span style="font-size: 17px; color: var(--color-accent-700);">3</span>'):
            '>Needs you</span>\n              <span style="font-size: 17px; color: var(--color-accent-700);">{{ digestNeedsYou }}</span>',
        ("The agent worked eleven hours across sales, marketing and customer service. "
         "Renewals moved fastest; the marketing drip is staged but held on copy approval, "
         "and one renewal was escalated rather than closed."): "{{ digestSummary }}",
        "<span>Next digest at 18:00</span>": "<span>{{ digestFooter }}</span>",
        "<span>Claude · computer use · 1 approval pending</span>":
            "<span>{{ statusFooter }}</span>",
        ('>Handoffs</span>\n              <span style="font-size: 17px;">2</span>'):
            '>Handoffs</span>\n              <span style="font-size: 17px;">{{ digestNeedsYou }}</span>',
        "<span>Sales — Atlas CRM</span>": "<span>{{ pageLabel }}</span>",
        '<span style="font-size: 27px; letter-spacing: -0.015em;">Reconcile the Q3 renewal queue</span>':
            '<span style="font-size: 27px; letter-spacing: -0.015em;">{{ goalTitle }}</span>',
        '<span style="{{ navBadgeStyle }}">3</span>':
            '<span style="{{ navBadgeStyle }}">{{ navBadgeCount }}</span>',
        ('>Tasks today</span>\n              <span style="font-size: 17px;">47</span>'):
            '>Tasks today</span>\n              <span style="font-size: 17px;">{{ digestDone }}</span>',
    }
    missed = []
    for old_t, new_t in DIGEST.items():
        if old_t in html:
            html = html.replace(old_t, new_t)
        else:
            missed.append(old_t[:44])
    if missed:
        print("warning: digest copy not found:")
        for x in missed:
            print("   -", x)

    OUT.write_text(html)
    print("wrote %s (%d KB), %d assets" % (OUT, len(html) // 1024, len(manifest)))


if __name__ == "__main__":
    main()
