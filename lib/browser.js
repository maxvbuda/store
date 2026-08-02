/**
 * Bridge to agent/browser_service.py — a persistent Chromium the agent drives.
 *
 * Node stays dependency-free: Playwright runs in a Python sidecar we spawn on
 * first use and proxy to. The see-think-act loop lives in the /browser page,
 * so a long model call never blocks the live view.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SIDECAR = path.join(__dirname, '..', 'agent', 'browser_service.py');

function create(env, send, readBody) {
  const PORT = Number(env('BROWSER_PORT', 8788));
  const BASE = 'http://127.0.0.1:' + PORT;
  let child = null;
  let starting = null;

  // Generous timeout: the sidecar is single-threaded, so it can legitimately
  // be mid-screenshot. Too short a probe makes us think it's dead and spawn a
  // second one, which then dies on EADDRINUSE.
  const alive = async (ms) => {
    try {
      const r = await fetch(BASE + '/state', { signal: AbortSignal.timeout(ms || 8000) });
      return r.ok;
    } catch (e) { return false; }
  };

  /** True only if the sidecar answers AND its Chromium is actually usable. */
  const healthy = async (ms) => {
    try {
      const r = await fetch(BASE + '/state', { signal: AbortSignal.timeout(ms || 8000) });
      if (!r.ok) return false;
      const s = await r.json();
      // `running:false` right after boot is fine — Chromium starts lazily.
      // `healthy:false` with an error means it died under us.
      return !(s.healthy === false && s.error);
    } catch (e) { return false; }
  };

  /** Spawns the sidecar once and waits for it to answer. */
  async function ensure() {
    if (await alive()) {
      if (await healthy()) return true;
      // Answers, but its browser is wedged. Replace it rather than 503 forever.
      console.log('[browser] sidecar is up but unhealthy — restarting it');
      try { await fetch(BASE + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch (e) {}
      if (child) { child.kill('SIGKILL'); child = null; }
      await new Promise(r => setTimeout(r, 1200));
    }
    if (starting) return starting;

    starting = (async () => {
      const headless = String(env('BROWSER_HEADLESS', '')).toLowerCase();
      const args = [SIDECAR, '--port', String(PORT)];
      if (headless === '1' || headless === 'true') args.push('--headless');

      console.log('[browser] starting sidecar: python3 ' + args.join(' '));
      child = spawn('python3', args, {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, {
          BROWSER_PROFILE: env('BROWSER_PROFILE', '') || undefined,
          BROWSER_START_URL: env('BROWSER_START_URL', '')
            || ('http://127.0.0.1:' + (process.env.PORT || 8787) + '/agent-start.html'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', d => process.stdout.write('[browser] ' + d));
      child.stderr.on('data', d => process.stderr.write('[browser] ' + d));
      let bindClash = false;
      child.stderr.on('data', d => { if (/Address already in use/i.test(String(d))) bindClash = true; });
      child.on('exit', (code) => { console.log('[browser] sidecar exited (' + code + ')'); child = null; });

      // Chromium's first launch can take a few seconds.
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await alive(3000)) { starting = null; return true; }
        if (!child) {
          // Someone else already owns the port — most likely a sidecar from a
          // previous run. Give it a long probe before declaring failure.
          if (bindClash) {
            console.log('[browser] port ' + PORT + ' already in use — probing the existing sidecar');
            const up = await alive(20000);
            starting = null;
            return up;
          }
          starting = null;
          return false;
        }
      }
      starting = null;
      return false;
    })();

    return starting;
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/browser/')) return false;
    const action = p.slice('/api/browser/'.length);

    if (action === 'status') {
      const up = await alive();
      let state = null;
      if (up) { try { state = await (await fetch(BASE + '/state')).json(); } catch (e) {} }
      send(res, 200, { running: up, state, model: env('BROWSER_MODEL', 'deepseek/deepseek-v4-pro') });
      return true;
    }

    if (action === 'stop') {
      if (await alive()) { try { await fetch(BASE + '/shutdown', { method: 'POST' }); } catch (e) {} }
      if (child) { child.kill('SIGTERM'); child = null; }
      send(res, 200, { ok: true, running: false });
      return true;
    }

    if (!(await ensure())) {
      send(res, 503, { error: 'Could not start the browser service. Is python3 + playwright installed?' });
      return true;
    }

    // Page contents as text — how a text-only model sees the page.
    if (action === 'elements') {
      try {
        const r = await fetch(BASE + '/elements', { signal: AbortSignal.timeout(30000) });
        send(res, r.status, await r.json());
      } catch (e) {
        send(res, 502, { error: String(e.message || e) });
      }
      return true;
    }

    // Screenshot is a binary passthrough.
    if (action === 'screenshot') {
      try {
        const r = await fetch(BASE + '/screenshot', { signal: AbortSignal.timeout(30000) });
        const buf = Buffer.from(await r.arrayBuffer());
        send(res, r.status, buf, { 'Content-Type': 'image/png' });
      } catch (e) {
        send(res, 502, { error: String(e.message || e) });
      }
      return true;
    }

    const ALLOWED = ['goto', 'click', 'type', 'key', 'scroll', 'back'];
    if (!ALLOWED.includes(action)) { send(res, 404, { error: 'unknown browser action' }); return true; }

    let body = {};
    try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e.message) }); return true; }

    try {
      const r = await fetch(BASE + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      send(res, r.status, await r.json());
    } catch (e) {
      send(res, 502, { error: String(e.message || e) });
    }
    return true;
  }

  /** Direct helpers for the in-process agent (no HTTP round trip). */
  async function act(action, body) {
    if (!(await ensure())) throw new Error('browser service is not running');
    const r = await fetch(BASE + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('browser ' + action + ' failed (' + r.status + ')'));
    return data;
  }

  async function read() {
    if (!(await ensure())) throw new Error('browser service is not running');
    const r = await fetch(BASE + '/elements', { signal: AbortSignal.timeout(45000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('could not read the page (' + r.status + ')'));
    return data;
  }

  /** Raw sidecar state, for the watchdog. Never throws. */
  async function state() {
    try {
      const r = await fetch(BASE + '/state', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { running: false, healthy: false, error: 'state HTTP ' + r.status };
      return await r.json();
    } catch (e) {
      return { running: false, healthy: false, error: String(e.message || e) };
    }
  }

  /**
   * Kill the sidecar, bring a fresh one up, and actually relaunch the browser.
   *
   * ensure() only guarantees the sidecar answers — Chromium starts lazily on
   * first use. Returning true at that point reports a repair that has not
   * happened: the service is still down until something requests a page. So
   * warm it here and only claim success if a real page comes back.
   */
  async function restart() {
    try { await fetch(BASE + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch (e) {}
    if (child) { child.kill('SIGKILL'); child = null; }
    await new Promise(r => setTimeout(r, 1500));
    if (!(await ensure())) return false;
    try {
      const page = await read();          // forces a Chromium launch
      return !!(page && page.url);
    } catch (e) {
      console.log('[browser] restart: sidecar is up but the browser would not launch — ' + e.message);
      return false;
    }
  }

  return { handle, act, read, state, restart,
           stop: () => { if (child) child.kill('SIGTERM'); } };
}

module.exports = { create };
