/**
 * Error recording + a self-healing watchdog.
 *
 * Nothing here can fix a code bug — that needs a person (or a scheduled agent
 * reading /api/errors). What it does do:
 *   - records every failure to .data/errors.jsonl with enough context to act on
 *   - periodically checks the browser and restarts it when it has wedged,
 *     which is the one failure that recurs and is mechanically recoverable
 *   - exposes /api/errors so a cron job can read what actually broke
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_MEM = 300;

function create(env, send, readBody, browser) {
  const dataDir = env('DATA_DIR', path.join(__dirname, '..', '.data'));
  const file = path.join(dataDir, 'errors.jsonl');
  const recent = [];
  const counts = Object.create(null);
  let healed = 0;
  let checks = 0;

  function record(source, message, extra) {
    const entry = Object.assign({
      at: new Date().toISOString(),
      source,                                   // browser | agent | llm | http | watchdog
      message: String(message || '').slice(0, 600),
    }, extra || {});

    recent.unshift(entry);
    if (recent.length > MAX_MEM) recent.length = MAX_MEM;

    const key = source + ': ' + entry.message.slice(0, 80);
    counts[key] = (counts[key] || 0) + 1;

    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (e) { /* recording must never take the server down */ }

    console.error('[error] %s: %s', source, entry.message.slice(0, 160));
    return entry;
  }

  /**
   * One health pass. Returns what it found and whether it repaired anything.
   * Safe to call on a timer or on demand.
   */
  async function check() {
    checks++;
    const out = { at: new Date().toISOString(), ok: true, browser: null, repaired: false };
    try {
      const state = await browser.state();
      out.browser = state;
      // `running:false` is fine — Chromium starts lazily on first use. Only an
      // explicit unhealthy verdict means it died under us.
      if (state && state.healthy === false && state.error) {
        out.ok = false;
        record('watchdog', 'browser unhealthy: ' + state.error);
        const fixed = await browser.restart();
        out.repaired = fixed;
        healed += fixed ? 1 : 0;
        if (fixed) {
          // Confirm from the outside rather than trusting the repair path.
          const after = await browser.state();
          out.browser = after;
          const really = !!(after && after.healthy);
          record('watchdog', really
            ? 'browser restarted and serving pages again'
            : 'browser restart reported success but it is still not serving — needs a human');
          out.repaired = really;
          if (!really) healed -= 1;
        } else {
          record('watchdog', 'browser restart FAILED — needs a human');
        }
      }
    } catch (e) {
      out.ok = false;
      out.browser = { error: String(e.message || e) };
      record('watchdog', 'health check failed: ' + e.message);
    }
    return out;
  }

  let timer = null;
  function start() {
    const mins = Number(env('WATCHDOG_MINUTES', 5));
    if (!mins || mins < 0) { console.log('  watchdog: off'); return; }
    timer = setInterval(() => { check().catch(() => {}); }, mins * 60000);
    if (timer.unref) timer.unref();
    console.log('  watchdog: every ' + mins + ' min');
  }

  async function handle(req, res, url) {
    if (url.pathname === '/api/errors') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, MAX_MEM);
      const since = url.searchParams.get('since');
      let list = recent;
      if (since) list = list.filter(e => e.at > since);
      send(res, 200, {
        checks, healed,
        total: recent.length,
        topRepeats: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([k, n]) => ({ what: k, times: n })),
        errors: list.slice(0, limit),
      });
      return true;
    }
    if (url.pathname === '/api/health') {
      send(res, 200, await check());
      return true;
    }
    return false;
  }

  return { record, check, start, handle };
}

module.exports = { create };
