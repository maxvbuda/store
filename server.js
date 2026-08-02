#!/usr/bin/env node
/**
 * AutoStore AI — local dev server.
 *
 *   node server.js            # http://localhost:8787
 *
 * Serves app/ as static files and proxies the AI calls to OpenRouter so the
 * API key stays on this machine and never reaches the browser. The key is read
 * from .env next to this file; edits to .env are picked up on the next request,
 * so you can paste your key and just reload the page.
 *
 * No dependencies — Node 18+ (uses the built-in fetch).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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
  'anthropic/claude-opus-4.5',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o-mini',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
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
  const key = apiKey();
  if (!key) return send(res, 400, { error: 'No OpenRouter API key configured on the server.' });

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }

  const prompt = String(body.prompt || '').slice(0, 20000);
  if (!prompt) return send(res, 400, { error: 'prompt is required' });

  const model = String(body.model || '').trim() || await pickModel();
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: String(body.system).slice(0, 8000) });
  messages.push({ role: 'user', content: prompt });

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
      'X-Title': 'AutoStore AI (local)',
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
      return send(res, r.status === 401 ? 401 : 502, { error: String(msg).slice(0, 400) });
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
      const why = choice.finish_reason === 'length'
        ? `${model} used its whole ${budget}-token budget on reasoning (${rtok} thinking tokens) and produced no answer. ` +
          'Lower OPENROUTER_REASONING in .env (medium → low → off) or raise OPENROUTER_MAX_TOKENS.'
        : `${model} returned an empty response (finish_reason: ${choice.finish_reason || 'unknown'}).`;
      return send(res, 502, { error: why });
    }

    send(res, 200, { text, model: data.model || model, usage: data.usage || null });
  } catch (e) {
    console.error('[llm] failed:', e.message);
    send(res, 502, { error: String(e.message || e).slice(0, 300) });
  }
}

// ------------------------------------------------------- Shopify MCP

const SHOPIFY_MCP_PATHS = ['/api/mcp', '/api/ucp/mcp'];

function normalizeStoreDomain(raw) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try { return new URL(raw).host; } catch (e) { return ''; }
}

/**
 * Storefront password protection is bypassed the way Shopify itself
 * documents it: HTTP Basic auth with the fixed username "shopify" and the
 * store's storefront password. Domain + password come from the signed-in
 * user's own account (set during onboarding) — every user talks to their
 * own store, never a shared one. This call is server-side only, so the
 * password never reaches the browser.
 */
async function shopifyMcpRequest(path, payload, domain, password) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (password) headers.Authorization = 'Basic ' + Buffer.from('shopify:' + password).toString('base64');

  const r = await fetch('https://' + domain + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {}),
    // Manual redirect handling: Shopify's password gate responds to a
    // locked-out request with a redirect to the login page. Following it
    // would silently hand back an HTML login form instead of the MCP
    // response, so treat any 3xx here as "still gated" and surface that.
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });

  if (r.status >= 300 && r.status < 400) {
    throw new Error(path + ' redirected — still behind the password gate. Check the store password in Settings.');
  }
  return r;
}

/** Loops the MCP request across /api/mcp and /api/ucp/mcp for the caller's own connected store. */
async function handleShopifyMcp(req, res) {
  const user = auth.currentUser(req);
  if (!user) return send(res, 401, { error: 'Sign in first.' });

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }

  const setup = user.setup || {};
  const domain = normalizeStoreDomain(setup.storeUrl);
  if (!domain) return send(res, 400, { error: 'No Shopify store connected yet — add your store URL during onboarding.' });
  const password = setup.storePassword || '';

  const payload = body.payload !== undefined ? body.payload : body;
  const paths = body.endpoint === 'mcp' ? ['/api/mcp']
    : body.endpoint === 'ucp' ? ['/api/ucp/mcp']
    : SHOPIFY_MCP_PATHS;

  let lastError;
  for (const path of paths) {
    try {
      const r = await shopifyMcpRequest(path, payload, domain, password);
      if (r.status === 404) { lastError = new Error(path + ' returned 404'); continue; }
      const data = await r.json().catch(() => null);
      if (!r.ok) { lastError = new Error((data && data.error) || ('HTTP ' + r.status + ' from ' + path)); continue; }
      return send(res, 200, { ok: true, endpoint: path, data });
    } catch (e) {
      lastError = e;
    }
  }
  send(res, 502, { ok: false, error: String((lastError && lastError.message) || lastError || 'Shopify MCP request failed') });
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
      headers: { 'User-Agent': 'AutoStore-AI-local/1.0' },
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

// Accounts + the shared-password gate.
const auth = require('./lib/auth').create(env, send, readBody);

const UNLOCK_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoStore AI</title>
<style>
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;
   justify-content:center;background:#f4f4f2;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#111}
 form{width:min(92vw,340px)} h1{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
 p{margin:0 0 20px;color:#666;font-size:13px}
 input{width:100%;padding:12px;border:1px solid #ccc;background:#fff;font-size:15px;margin-bottom:10px}
 button{width:100%;padding:12px;border:0;background:#ec3013;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 .err{color:#ec3013;font-size:13px;min-height:18px;margin-top:8px}
</style>
<form id="f"><h1>AutoStore AI</h1><p>This instance is password protected.</p>
<input id="p" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button>Unlock</button><div class="err" id="e"></div></form>
<script>
f.onsubmit = async ev => {
  ev.preventDefault(); e.textContent = '';
  const r = await fetch('/api/unlock', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({password: p.value})});
  if (r.ok) location.reload(); else { e.textContent = 'Incorrect password.'; p.select(); }
};
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    // /api/unlock is the only route reachable while locked.
    if (url.pathname === '/api/unlock') {
      if (await auth.handle(req, res, url)) return;
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

    // The template ships no favicon; answer once instead of logging a 404.
    if (url.pathname === '/favicon.ico') {
      return send(res, 200, Buffer.alloc(0), { 'Content-Type': 'image/x-icon' });
    }
    if (url.pathname === '/api/status') return handleStatus(res);
    if (url.pathname === '/api/models') return handleModels(res);
    if (url.pathname === '/api/llm' && req.method === 'POST') return handleLLM(req, res);
    if (url.pathname === '/api/check-store' && req.method === 'POST') return handleCheckStore(req, res);
    if (url.pathname === '/api/shopify-mcp' && req.method === 'POST') return handleShopifyMcp(req, res);
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const key = apiKey();
  console.log('AutoStore AI  →  http://localhost:' + PORT);
  console.log('  app dir : ' + APP_DIR);
  console.log('  env file: ' + ENV_FILE + (fs.existsSync(ENV_FILE) ? '' : '  (missing)'));
  console.log('  API key : ' + (key ? 'set (' + key.length + ' chars)' : 'NOT SET — AI features are off'));
  console.log('  accounts: ' + auth.store.count() + '  (' + auth.store.file + ')');
  console.log('  gate    : ' + (auth.gatePassword() ? 'ON — password required' : 'OFF'));
  if (!key) console.log('\n  Add this line to .env, then just reload the page:\n    OPENROUTER_API_KEY=sk-or-v1-...\n');
  if (!auth.gatePassword()) {
    console.log('\n  ⚠  APP_PASSWORD is not set — /api/llm is OPEN.');
    console.log('     Fine on localhost; set it before exposing this publicly.\n');
  }
});
