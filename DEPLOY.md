# Deploying to Render

The service is a **Web Service** pointed at this repo, `main` branch.
Every push to `main` auto-deploys.

## Settings that matter

**Build command** — paste exactly this (the `PLAYWRIGHT_BROWSERS_PATH` part is
load-bearing: Render only carries the project directory from build to runtime,
so Chromium must be installed *inside* the repo or it vanishes before boot):

```bash
npm install && pip install -r requirements.txt && PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright python3 -m playwright install chromium
```

**Start command**: `node server.js`

**Instance**: at least 2 GB RAM. Chromium will not survive on the 512 MB free
tier — it OOMs at launch and the browser looks "broken" with no useful error.

## Environment variables (dashboard → Environment)

| Variable | Value | Why |
|---|---|---|
| `OPENROUTER_API_KEY` | your key | AI calls. Never commit it. |
| `APP_PASSWORD` | pick one | **Required on a public URL** — without it `/api/llm` is an open proxy anyone can bill against your key. |
| `SUPABASE_URL` | from your Supabase project | Accounts that survive redeploys. Run `supabase/schema.sql` in the Supabase SQL editor once first. |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → API settings | Same. Without these two, accounts fall back to a file and reset on every deploy. |

`BROWSER_HEADLESS` is not needed — the server detects a display-less Linux box
and runs Chromium headless on its own.

## What still resets on deploy

Everything under `.data/` lives on the ephemeral disk — the agent's browser
profile most painfully, so **sites you logged the agent into log out on every
deploy**. To keep those sessions, add a Render Disk mounted at `/data` and set
`DATA_DIR=/data`: that one variable relocates the accounts file, the error
log, the agent brief, *and* the browser profile. `BROWSER_PROFILE` remains
available as an override if the profile alone needs a different path.
Accounts don't need the disk once Supabase is configured.

## If Chromium still fails to launch

Render's native runtime is missing a system library on rare occasions
(`error while loading shared libraries: ...` in the logs). That is the signal
to switch the service to Docker — say so and a Dockerfile based on
`mcr.microsoft.com/playwright/python` can be added; it ships every library
Chromium needs.

## Known limits on Render

- One instance only. The agent loop, the sidecar, and the accounts file all
  assume a single process — do not scale to 2+ instances.
- Free-tier services sleep after idle; the first request after a sleep pays
  ~30–60 s of cold start plus a Chromium launch.
