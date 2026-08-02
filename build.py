#!/usr/bin/env python3
"""Rebuild app/index.html from the original bundled export + app/app-logic.js.

The shipped "AutoStore AI.html" is a self-extracting bundle: a JSON manifest of
gzip+base64 blobs plus an HTML template that references them by UUID.  This
script unpacks it once into plain files under app/ and rewrites the template so
every asset is a normal relative path, so the app can be edited by hand.

    python3 build.py
"""
import base64
import gzip
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
BUNDLE = ROOT / "AutoStore AI.html"
APP = ROOT / "app"
LOGIC = APP / "app-logic.js"

# UUID -> path the rewritten template should reference
ASSETS = {
    "f6f9dd9c-4e19-40b0-be29-f326f6ab9882": "support.js",
    "904f5720-c700-490c-8b7e-a7abf934276c": "ds-bundle.js",
    "8b8bad10-5454-4649-acf1-f412bccf7072": "fonts/archivo-vietnamese.woff2",
    "bfa04f1b-167a-4331-abae-f3868e7bb478": "fonts/archivo-latin-ext.woff2",
    "b2d289b9-1bd1-4761-9826-f6650d4d971e": "fonts/archivo-latin.woff2",
}

# support.js loads these from unpkg unless window.__resources redirects them.
# Hosted checkout link supplied by the site owner. The link itself handles the
# entire payment — there is no Stripe integration, no cart, and no fallback
# path in this codebase by design.
PAY_LINK = ("https://www.foundersweekends.com/api/pay"
            "?venture=5fafe8d0-8f98-4405-9ed7-752846dbccfa&amount=2800&name=Venture+1")
BUY_LABEL = "Subscribe — $28"

BUY_CSS = """<style>
.buy-btn{display:flex;align-items:center;justify-content:center;gap:10px;
  width:100%;min-height:60px;padding:18px 28px;margin:22px 0;
  background:var(--color-accent);color:var(--color-bg);
  font-family:var(--font-heading);font-weight:800;font-size:18px;letter-spacing:.01em;
  text-decoration:none;border:2px solid var(--color-accent);cursor:pointer;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.buy-btn:hover{background:var(--color-bg);color:var(--color-accent)}
.buy-btn:focus-visible{outline:3px solid var(--color-accent);outline-offset:3px}
@media (max-width:640px){.buy-btn{min-height:64px;font-size:19px;padding:20px 22px}}
</style>"""


def buy_button() -> str:
    """A plain anchor to the owner's hosted checkout. No JS, no fallback."""
    href = PAY_LINK.replace("&", "&amp;")
    return ('<a class="buy-btn" href="%s">%s <span aria-hidden="true">→</span></a>'
            % (href, BUY_LABEL))


RESOURCE_MAP = {
    "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "vendor/react.production.min.js",
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "vendor/react-dom.production.min.js",
    "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js": "vendor/babel.min.js",
}


def section(src: str, name: str) -> str:
    m = re.search(r'<script type="__bundler/%s">\s*(.*?)\s*</script>' % name, src, re.S)
    if not m:
        raise SystemExit("bundle is missing the %s section" % name)
    return m.group(1)


def main() -> None:
    src = BUNDLE.read_text()
    manifest = json.loads(section(src, "manifest"))
    template = json.loads(section(src, "template"))

    APP.mkdir(exist_ok=True)
    (APP / "fonts").mkdir(exist_ok=True)
    (APP / "vendor").mkdir(exist_ok=True)

    for uuid, rel in ASSETS.items():
        entry = manifest.get(uuid)
        if not entry:
            raise SystemExit("bundle is missing asset %s" % uuid)
        raw = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            raw = gzip.decompress(raw)
        (APP / rel).write_bytes(raw)

    html = template
    for uuid, rel in ASSETS.items():
        html = html.replace(uuid, rel)

    # Point the runtime at the vendored React/Babel instead of unpkg.
    shim = ("<script>window.__resources = %s;</script>\n"
            % json.dumps(RESOURCE_MAP, indent=2))
    html = html.replace("<script src=\"support.js\">", shim + "<script src=\"support.js\">", 1)

    # --- Buy buttons -------------------------------------------------------
    # Two identical links to the owner's hosted checkout: one directly under
    # the headline + offer, one at the end of the content column.
    html = html.replace("<helmet>", "<helmet>" + BUY_CSS, 1)

    TOP_ANCHOR = ("One agent that writes, prices, ships and answers — "
                  "and asks before it matters.</p>")
    BOTTOM_ANCHOR = ('<div style="margin-top:16px;font-size:13px">No account? '
                     '<a style="cursor:pointer" sc-camel-on-click="{{ startOnboarding }}">'
                     'Set up your agent →</a></div>')

    placed = 0
    if TOP_ANCHOR in html:
        html = html.replace(TOP_ANCHOR, TOP_ANCHOR + buy_button(), 1)
        placed += 1
    else:
        raise SystemExit("buy button: top anchor (headline/offer) not found")

    if BOTTOM_ANCHOR in html:
        html = html.replace(BOTTOM_ANCHOR, BOTTOM_ANCHOR + buy_button(), 1)
        placed += 1
    else:
        raise SystemExit("buy button: bottom anchor (end of column) not found")
    print("buy buttons placed: %d -> %s" % (placed, PAY_LINK))

    # Swap the bundled demo logic for the live version in app/app-logic.js.
    logic = LOGIC.read_text()
    m = re.search(r'(<script[^>]*data-dc-script[^>]*>)(.*?)(</script>)', html, re.S)
    if not m:
        raise SystemExit("could not find the x-dc logic script in the template")
    html = html[:m.start()] + m.group(1) + "\n" + logic + "\n" + m.group(3) + html[m.end():]

    # The markup hardcodes the old demo's model name; bind it to the live one.
    html = html.replace("Gemini writes in your", "{{ agentName }} writes in your")

    # "Skip for now" in the setup wizard was wired to {{ signIn }}, which is a
    # real login attempt now that accounts exist — it failed on empty fields.
    # NB: this runs before DEMO_COPY swaps the label for {{ skipLabel }}, so
    # match the raw template text.
    SKIP_OLD = 'sc-camel-on-click="{{ signIn }}">Skip — use demo store</a>'
    SKIP_NEW = 'sc-camel-on-click="{{ skipSetup }}">Skip — use demo store</a>'
    if SKIP_OLD in html:
        html = html.replace(SKIP_OLD, SKIP_NEW, 1)
        print("skip button rebound to skipSetup")
    else:
        print("warning: skip button anchor not found")

    # --- Sign out ----------------------------------------------------------
    # The header shows a store-initials chip but had no way back out. Add a
    # sign-out button next to it, only while a session exists.
    AVATAR = ('<span style="width:30px;height:30px;background:var(--color-text);'
              'color:var(--color-bg);display:grid;place-items:center;'
              'font-family:var(--font-heading);font-weight:800;font-size:11px">'
              '{{ storeInit }}</span>')
    SIGN_OUT = (
        '<sc-if value="{{ isSignedIn }}" hint-placeholder-val="{{ true }}">'
        '<button title="{{ userEmail }}" sc-camel-on-click="{{ signOut }}" '
        'style="margin-left:10px;background:none;border:0;padding:4px 2px;cursor:pointer;'
        'font-family:var(--font-heading);font-weight:700;font-size:11px;letter-spacing:.06em;'
        'text-transform:uppercase;color:var(--color-neutral-600)">Sign out</button>'
        '</sc-if>')
    if AVATAR in html:
        html = html.replace(AVATAR, AVATAR + SIGN_OUT, 1)
        print("sign-out button placed")
    else:
        raise SystemExit("sign out: header avatar anchor not found")

    # The login fields shipped as unbound defaults ("demo@..."), so nothing the
    # user typed ever reached the logic. Bind them to real state.
    LOGIN = {
        '<input class="input" type="email" sc-camel-default-value="demo@kilnember.com">':
            '<input class="input" type="email" placeholder="you@example.com" '
            'value="{{ loginEmail }}" sc-camel-on-change="{{ setLoginEmail }}">',
        '<input class="input" type="password" sc-camel-default-value="••••••••••">':
            '<input class="input" type="password" placeholder="At least 8 characters" '
            'value="{{ loginPassword }}" sc-camel-on-change="{{ setLoginPassword }}">',
        '>Sign in<': '>{{ signInLabel }}<',
        'Demo build — any credentials work.':
            'New here? Enter an email and password, then press “Set up your agent”.',
    }
    for old, new in LOGIN.items():
        if old in html:
            html = html.replace(old, new)
        else:
            print("warning: login markup not found —", old[:52])
    if "Gemini" in html.split("data-dc-script")[0]:
        print("warning: 'Gemini' still present in markup")

    # The export baked a fictional store ("Kiln & Ember", order #1187, ...) into
    # the markup as literal text. Swap each for a binding so the page shows the
    # real state instead of a demo that never existed.
    DEMO_COPY = {
        "Kiln &amp; Ember · live since June": "{{ brandLine }}",
        "Skip — use demo store": "{{ skipLabel }}",
        "Order #1187 · USPS pickup 3:30 PM": "{{ nextOrderLine }}",
        "<strong>Agent watch:</strong> if #1187 isn't scanned by 3:10 PM, "
        "I'll book a UPS pickup as backup and email you.": "{{ watchLine }}",
        ">9 of 11<": ">{{ resolvedRatio }}<",
        "Connected to kiln-ember.myshopify.com": "{{ connectedLine }}",
        # login hero counters
        'tabular-nums">47</span><br>agent actions today':
            'tabular-nums">{{ loginActions }}</span><br>agent actions today',
        'tabular-nums">9/11</span><br>tickets resolved':
            'tabular-nums">{{ loginResolved }}</span><br>tickets resolved',
        'tabular-nums">0</span><br>missed deadlines':
            'tabular-nums">{{ loginMissed }}</span><br>missed deadlines',
    }
    # Prototype prop defaults and prefilled form values from the demo export.
    DEMO_COPY.update({
        '&quot;default&quot;: &quot;Kiln &amp; Ember&quot;': '&quot;default&quot;: &quot;&quot;',
    })

    missed = []
    for old, new in DEMO_COPY.items():
        if old in html:
            html = html.replace(old, new)
        else:
            missed.append(old[:48])
    if missed:
        print("warning: demo copy not found (markup changed?):")
        for x in missed:
            print("   -", x)

    out = APP / "index.html"
    out.write_text(html)
    print("wrote %s (%d KB)" % (out, len(html) // 1024))
    print("assets:", ", ".join(sorted(ASSETS.values())))


if __name__ == "__main__":
    main()
