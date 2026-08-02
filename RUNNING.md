# Running Shop Agent locally

```bash
npm install
node server.js          # http://localhost:8787
```

Node 18+. Needs a MongoDB running at `MONGODB_URI` (defaults to
`mongodb://127.0.0.1:27017/shop-agent` for local dev).

## Giving it your OpenRouter key

Open `.env` and paste your key:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

Get one at <https://openrouter.ai/keys>. Save the file and **reload the page** —
the server re-reads `.env` on every request, so no restart is needed.

Leave `OPENROUTER_MODEL` blank to auto-pick the best model your key can reach,
or pin one (`anthropic/claude-sonnet-4.5`, `openai/gpt-4o-mini`, …).

The key never leaves this machine: the browser calls `/api/llm` on localhost and
the server adds the `Authorization` header when it forwards to OpenRouter.

## What each button actually does

| Screen | Action | Behaviour |
|---|---|---|
| Onboarding | **Connect** | Real HTTPS request to the store URL; reads back the page title. Refuses to advance if unreachable. |
| Onboarding | **Upload photo** | Real file picker; reads the image and keeps its name and size. |
| Onboarding | **Launch agent** | If "rewrite thin copy now" is selected, immediately writes every missing description. |
| Products | **Generate / Regenerate** | One LLM call per SKU, using brand voice + catalog as context. |
| Products | **Generate all** | Sequential (not parallel) so you don't trip rate limits. |
| Orders | **Ship** | Marks shipped, then writes a real shipping-confirmation email. |
| Orders | **Print label** | Renders a packing slip with tracking number and opens the print dialog. |
| Marketing | **Generate draft** | Real generation, shaped per content type (caption / description / email / ad). |
| Marketing | **Regenerate** | Rewrites from a different angle, not a light edit. |
| Marketing | **Copy** | Real clipboard write. |
| Support | Open a ticket | Drafts a reply from the customer's actual message, respecting your refund cap. |
| Support | **Approve & send** | Refuses to send while the draft is still being written. |
| Requests | **Send** | Two calls: the agent's plan, then its completion report. |
| Agent feed | live ticker | Activity lines generated once per session from your catalog. |
| Billing | plan switch | Saves locally. **Not** wired to Stripe — no Stripe account is connected. |

Everything except billing survives a reload (`localStorage`). To reset:
`localStorage.removeItem('shopagent.state.v1')` in the browser console.

## Editing

`app/index.html` is **generated** — don't edit it by hand.

* App logic → `app/app-logic.js`
* Markup and CSS → the template inside `AutoStore AI.html`

After changing either, rebuild:

```bash
python3 build.py
```

`build.py` unpacks the original bundle (React, Babel, the DC runtime, fonts) into
`app/` and splices `app-logic.js` in as the component. The original
`AutoStore AI.html` is never modified.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/status` | Is a key present, and which model resolved |
| `GET /api/models` | Live model list from OpenRouter |
| `POST /api/llm` | Chat completion proxy |
| `POST /api/check-store` | Storefront reachability check |
