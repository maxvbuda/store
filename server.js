#!/usr/bin/env node
/**
 * Shop Agent — local dev server.
 *
 *   node server.js            # http://localhost:8787
 *
 * Serves app/ as static files and proxies the AI calls to OpenRouter so the
 * API key stays on this machine and never reaches the browser. The key is read
 * from .env next to this file; edits to .env are picked up on the next request,
 * so you can paste your key and just reload the page.
 *
 * Accounts + sessions live in Supabase Postgres — set SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY in .env, and run supabase/schema.sql once.
 *
 * Node 18+ (uses the built-in fetch). Dependencies: @supabase/supabase-js.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function setCookie(name, value, req, maxAge) {
  const isHttps = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (isHttps ? '; Secure' : '');
}

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, 'app');
const ENV_FILE = path.join(ROOT, '.env');
// Render (and most PaaS) inject PORT and route to the container's public
// interface — binding to 127.0.0.1 makes the port scan fail and the service
// reads as "unavailable". Default to all interfaces; override with HOST=... .
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const OPENROUTER = 'https://openrouter.ai/api/v1';

// Preference order used when OPENROUTER_MODEL is not set. The first one the
// account can actually see in /models wins.
const MODEL_PREFERENCE = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v3.2',
];

// ---------------------------------------------------------------- .env

let envCache = { mtime: 0, values: {} };

function readEnv() {
  let stat;
  try { stat = fs.statSync(ENV_FILE); } catch (e) { envCache = { mtime: 0, values: {} }; return envCache.values; }
  if (stat.mtimeMs === envCache.mtime) return envCache.values;

  const values = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    values[key] = val;
  }
  envCache = { mtime: stat.mtimeMs, values };
  resolvedModel = null;   // key or model may have changed
  return values;
}

function env(name, fallback) {
  const v = readEnv()[name];
  return (v === undefined || v === '') ? (process.env[name] || fallback) : v;
}

function apiKey() {
  const k = env('OPENROUTER_API_KEY', '');
  return k && !k.startsWith('sk-or-v1-your') ? k : '';
}

// ------------------------------------------------------------- model

let resolvedModel = null;

async function pickModel() {
  const explicit = env('OPENROUTER_MODEL', '');
  if (explicit) return explicit;
  if (resolvedModel) return resolvedModel;
  try {
    const res = await fetch(OPENROUTER + '/models', { headers: { Authorization: 'Bearer ' + apiKey() } });
    const body = await res.json();
    const ids = new Set((body.data || []).map(m => m.id));
    resolvedModel = MODEL_PREFERENCE.find(id => ids.has(id)) || MODEL_PREFERENCE[1];
  } catch (e) {
    resolvedModel = MODEL_PREFERENCE[1];
  }
  return resolvedModel;
}

// ---------------------------------------------------------------- http

function send(res, status, body, headers) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(payload);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(APP_DIR, rel));
  if (!full.startsWith(APP_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  });
}

// ------------------------------------------------------------- handlers

async function handleStatus(res) {
  const key = apiKey();
  send(res, 200, {
    hasKey: !!key,
    model: key ? await pickModel() : '',
    hint: key ? '' : 'No API key configured. Set OPENROUTER_API_KEY in .env (local) or in your host\'s environment variables.',
  });
}

async function handleModels(res) {
  const key = apiKey();
  if (!key) return send(res, 200, { models: [] });
  try {
    const r = await fetch(OPENROUTER + '/models', { headers: { Authorization: 'Bearer ' + key } });
    const body = await r.json();
    send(res, 200, {
      models: (body.data || []).map(m => ({ id: m.id, name: m.name, context: m.context_length })).slice(0, 400),
    });
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}

async function handleLLM(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }
  try {
    const out = await askModel(body);
    send(res, 200, out);
  } catch (e) {
    const status = /no openrouter api key/i.test(e.message) ? 400
      : /unauthor|401/i.test(e.message) ? 401 : 502;
    send(res, status, { error: String(e.message || e).slice(0, 400) });
  }
}

/** One model call. Shared by POST /api/llm and the background agent. */
async function askModel(body) {
  const key = apiKey();
  if (!key) throw new Error('No OpenRouter API key configured on the server.');

  const prompt = String(body.prompt || '').slice(0, 20000);
  if (!prompt) throw new Error('prompt is required');

  const model = String(body.model || '').trim() || await pickModel();
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: String(body.system).slice(0, 8000) });

  // `images` (data: URLs) turns this into a vision call — that's how the
  // computer-use loop shows the model what's on screen.
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  if (images.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.map(u => ({ type: 'image_url', image_url: { url: String(u) } })),
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  // Reasoning models (DeepSeek V4 Pro, o-series, R1, …) spend max_tokens on
  // chain-of-thought before emitting a single output token. With a tight cap
  // the whole budget goes to thinking and `content` comes back empty with
  // finish_reason "length". So: give the model real headroom and control the
  // thinking depth explicitly. Output length is governed by the prompt.
  const budget = Math.max(Number(env('OPENROUTER_MAX_TOKENS', 4000)), Number(body.max_tokens) || 0);
  const effort = String(env('OPENROUTER_REASONING', 'medium')).toLowerCase();

  const payload = {
    model,
    messages,
    max_tokens: budget,
    temperature: body.temperature === undefined ? 0.8 : Math.min(Math.max(Number(body.temperature), 0), 2),
  };
  if (effort === 'off' || effort === 'none' || effort === 'false') payload.reasoning = { enabled: false };
  else if (['low', 'medium', 'high'].includes(effort)) payload.reasoning = { effort };

  const started = Date.now();
  const call = (p) => fetch(OPENROUTER + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:' + PORT,
      'X-Title': 'Shop Agent (local)',
    },
    body: JSON.stringify(p),
    signal: AbortSignal.timeout(180000),
  });

  try {
    let r = await call(payload);
    let data = await r.json().catch(() => ({}));

    // Some providers reject the unified `reasoning` control — retry without it.
    if (!r.ok && payload.reasoning && /reasoning/i.test(JSON.stringify(data.error || ''))) {
      const { reasoning, ...bare } = payload;
      console.warn('[llm] %s rejected reasoning control — retrying without it', model);
      r = await call(bare);
      data = await r.json().catch(() => ({}));
    }

    if (!r.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || ('OpenRouter HTTP ' + r.status);
      console.error('[llm] %s -> %s', model, msg);
      throw new Error(String(msg).slice(0, 400));
    }

    const choice = (data.choices && data.choices[0]) || {};
    const text = ((choice.message && choice.message.content) || '').trim();
    const usage = data.usage || {};
    const rtok = (usage.completion_tokens_details || {}).reasoning_tokens || 0;
    console.log('[llm] %s  %dms  %d tok (%d reasoning)  finish=%s%s',
      model, Date.now() - started, usage.total_tokens || 0, rtok,
      choice.finish_reason || '?', text ? '' : '  ← EMPTY');

    if (!text) {
      // Almost always the reasoning-starvation case. Say so plainly.
      throw new Error(choice.finish_reason === 'length'
        ? `${model} used its whole ${budget}-token budget on reasoning (${rtok} thinking tokens) and produced no answer. `
          + 'Lower OPENROUTER_REASONING in .env (medium -> low -> off) or raise OPENROUTER_MAX_TOKENS.'
        : `${model} returned an empty response (finish_reason: ${choice.finish_reason || 'unknown'}).`);
    }

    return { text, model: data.model || model, usage: data.usage || null };
  } catch (e) {
    console.error('[llm] failed:', e.message);
    try { watch.record('llm', e.message, { model }); } catch (_) {}
    throw e;
  }
}

/** Real reachability check for the storefront URL typed during onboarding. */
async function handleCheckStore(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }
  let raw = String(body.url || '').trim();
  if (!raw) return send(res, 400, { error: 'url is required' });
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let url;
  try { url = new URL(raw); } catch (e) { return send(res, 200, { ok: false, detail: 'That does not look like a URL' }); }

  try {
    const r = await fetch(url.origin, {
      redirect: 'follow',
      headers: { 'User-Agent': 'ShopAgent-local/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    let title = '';
    if (r.ok) {
      const html = (await r.text()).slice(0, 40000);
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      if (m) title = m[1].trim().slice(0, 90);
    }
    send(res, 200, { ok: r.ok, status: r.status, host: url.host, title });
  } catch (e) {
    send(res, 200, { ok: false, status: 0, host: url.host, detail: String(e.message || e).slice(0, 140) });
  }
}

// ---------------------------------------------------------------- serve

// Accounts + the shared-password gate. Assigned once Supabase is reachable,
// below — request handling never starts until that's done.
let auth;
// The agent's Chromium (Python sidecar, spawned on first use).
const browser = require('./lib/browser').create(env, send, readBody);
// The agent loop runs here, not in the page, so a closed tab doesn't kill it.
// A background task must never take the server down. Node exits on an
// unhandled rejection by default, which is how the server died silently mid
// health-check: no stack, no log line, just gone.
process.on('unhandledRejection', (err) => {
  console.error('[fatal-guard] unhandled rejection:', (err && err.stack) || err);
  try { watch.record('http', 'unhandled rejection: ' + ((err && err.message) || err)); } catch (e) {}
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaught exception:', (err && err.stack) || err);
  try { watch.record('http', 'uncaught exception: ' + ((err && err.message) || err)); } catch (e) {}
});

// Error recording + a watchdog that restarts a wedged browser on its own.
const watch = require('./lib/watch').create(env, send, readBody, browser);
const agent = require('./lib/agent').create(env, send, readBody, browser, askModel, watch.record);
process.on('exit', () => browser.stop());
process.on('SIGINT', () => { browser.stop(); process.exit(0); });
process.on('SIGTERM', () => { browser.stop(); process.exit(0); });

const UNLOCK_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop Agent</title>
<style>
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;
   justify-content:center;background:#f4f4f2;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#111}
 div{width:min(92vw,340px);text-align:center} h1{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
 p{margin:0 0 20px;color:#666;font-size:13px}
 button{width:100%;padding:16px;border:0;background:linear-gradient(135deg, #3b82f6, #8b5cf6);color:#fff;font-size:16px;font-weight:800;cursor:pointer;border-radius:0;box-shadow:0 4px 12px rgba(59, 130, 246, 0.3);text-decoration:none;margin-bottom:12px}
 .or{color:#999;font-size:12px;margin:10px 0}
</style>
<h1>Shop Agent</h1>
<p>Subscribe to access Shop Agent.</p>
<a href="https://www.foundersweekends.com/api/pay?venture=5fafe8d0-8f98-4405-9ed7-752846dbccfa&amount=2800&name=Venture+1" onclick="localStorage.setItem('shopagent_pending', 'true'); setTimeout(() => window.location.reload(), 2000);" style="display:inline-block">Subscribe — $28</a>
<div class="or">Or enter password</div>
<form id="f"><input id="p" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Unlock</button></form>
<script>
if (localStorage.getItem('shopagent_pending') === 'true') {
  localStorage.removeItem('shopagent_pending');
  fetch('/api/payment-success', {method:'POST'}).then(() => location.reload());
}
f.onsubmit = async ev => {
  ev.preventDefault();
  const r = await fetch('/api/unlock', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({password: p.value})});
  if (r.ok) location.reload(); else { alert('Incorrect password.'); p.select(); }
};
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    // /api/unlock is the only route reachable while locked.
    if (url.pathname === '/api/unlock') {
      if (await auth.handle(req, res, url)) return;
    }
    // Payment success endpoint - simplified version (in production, use Stripe webhook verification)
    if (url.pathname === '/api/payment-success' && req.method === 'POST') {
      // For now, accept any POST as successful payment
      // In production: verify Stripe webhook signature and check payment_status
      const gatePassword = env('APP_PASSWORD', '');
      const gateToken = crypto.createHmac('sha256', gatePassword).update('unlock-v1').digest('hex');
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(GATE_COOKIE, gateToken, req, 30 * DAY) });
      return;
    }
    // Payment success GET endpoint - for redirect handling
    if (url.pathname === '/payment-success' && req.method === 'GET') {
      const gatePassword = env('APP_PASSWORD', '');
      const gateToken = crypto.createHmac('sha256', gatePassword).update('unlock-v1').digest('hex');
      send(res, 200, UNLOCK_PAGE.replace('Subscribe to access Shop Agent', 'Payment successful! Unlocked.'), { 'Set-Cookie': setCookie(GATE_COOKIE, gateToken, req, 30 * DAY) });
      return;
    }
    // Payment success page (GET) - triggers the unlock
    if (url.pathname === '/payment-success' && req.method === 'GET') {
      const gatePassword = env('APP_PASSWORD', '');
      const gateToken = crypto.createHmac('sha256', gatePassword).update('unlock-v1').digest('hex');
      send(res, 200, UNLOCK_PAGE.replace('Subscribe to access Shop Agent', 'Payment successful! Redirecting...'), { 'Set-Cookie': setCookie(GATE_COOKIE, gateToken, req, 30 * DAY) });
      return;
    }
    // The agent's OWN browser boots to this page and never has a gate cookie,
    // so the gate would trap it on the unlock screen — which is exactly the
    // "the agent just sits on the password page" bug. It is a static
    // instruction page with no secrets and no API access, so let it through.
    if (url.pathname === '/agent-start.html') {
      return serveStatic(req, res, '/agent-start.html');
    }
    if (!auth.isUnlocked(req)) {
      if (url.pathname.startsWith('/api/')) {
        return send(res, 401, { error: 'locked — unlock this instance first' });
      }
      return send(res, 200, UNLOCK_PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (url.pathname.startsWith('/api/account/')) {
      if (await auth.handle(req, res, url)) return;
    }
    if (url.pathname.startsWith('/api/browser/')) {
      if (await browser.handle(req, res, url)) return;
    }
    if (url.pathname.startsWith('/api/agent/')) {
      if (await agent.handle(req, res, url)) return;
    }
    if (url.pathname === '/api/errors' || url.pathname === '/api/health') {
      if (await watch.handle(req, res, url)) return;
    }
    // The agent console is the start page now. The original store app — login,
    // products, marketing, support — still lives at /app.
    // Shop Agent is the UI now; the earlier console stays at /console.
    if (url.pathname === '/' || url.pathname === '/shop-agent') {
      return serveStatic(req, res, '/operator.html');
    }
    if (url.pathname === '/console' || url.pathname === '/browser' || url.pathname === '/browser/') {
      return serveStatic(req, res, '/console.html');
    }
    if (url.pathname === '/app' || url.pathname === '/app/') {
      return serveStatic(req, res, '/index.html');
    }

    // The template ships no favicon; answer once instead of logging a 404.
    if (url.pathname === '/favicon.ico') {
      return send(res, 200, Buffer.alloc(0), { 'Content-Type': 'image/x-icon' });
    }
    if (url.pathname === '/api/status') return handleStatus(res);
    if (url.pathname === '/api/models') return handleModels(res);
    if (url.pathname === '/api/llm' && req.method === 'POST') return handleLLM(req, res);
    if (url.pathname === '/api/check-store' && req.method === 'POST') return handleCheckStore(req, res);
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    try { watch.record('http', e.message, { path: url.pathname }); } catch (_) {}
    send(res, 500, { error: String(e.message || e) });
  }
});

// Two servers on one port is the fault behind most "503 / stuck starting"
// reports: the second one keeps respawning a sidecar that can never bind.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use — another copy of this server is running.');
    console.error('  Stop it first:   lsof -ti tcp:' + PORT + ' | xargs kill\n');
    process.exit(1);
  }
  throw e;
});

(async () => {
  // Supabase when configured (accounts survive redeploys), the flat-file
  // store otherwise (zero-setup local dev). lib/auth.js picks.
  auth = await require('./lib/auth').create(env, send, readBody);

  server.listen(PORT, HOST, async () => {
    const key = apiKey();
    console.log('AutoStore AI  →  http://localhost:' + PORT);
    console.log('  app dir : ' + APP_DIR);
    console.log('  env file: ' + ENV_FILE + (fs.existsSync(ENV_FILE) ? '' : '  (missing)'));
    console.log('  API key : ' + (key ? 'set (' + key.length + ' chars)' : 'NOT SET — AI features are off'));
    console.log('  auth    : ' + (auth.store.file ? 'file (' + auth.store.file + ')' : 'supabase'));
    // Watchdog before the first await: this callback's promise is unobserved,
    // so if the count below rejects (a Supabase hiccup at boot, say) anything
    // after it would be skipped silently — and the watchdog must not be.
    watch.start();
    try {
      console.log('  accounts: ' + await auth.store.count());
    } catch (e) {
      console.log('  accounts: unavailable (' + ((e && e.message) || e) + ')');
    }
    console.log('  gate    : ' + (auth.gatePassword() ? 'ON — password required' : 'OFF'));
    if (!key) console.log('\n  Add this line to .env, then just reload the page:\n    OPENROUTER_API_KEY=sk-or-v1-...\n');
    if (!auth.gatePassword()) {
      console.log('\n  ⚠  APP_PASSWORD is not set — /api/llm is OPEN.');
      console.log('     Fine on localhost; set it before exposing this publicly.\n');
    }
  });
})().catch((e) => {
  console.error('[startup] ' + ((e && e.message) || e));
  console.error('  If this mentions Supabase: fix SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  console.error('  in .env, or remove them to use the local file store instead.');
  process.exit(1);
});
