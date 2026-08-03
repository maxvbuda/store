/**
 * Client for the longrun architecture — the user's own agent backend
 * (persistent memory threads, its own Chromium + crawl4ai, supervised runs).
 *
 * When LONGRUN_URL answers, agent goals are commissioned there instead of the
 * built-in see-think-act loop. The service issues bearer keys once and never
 * again (sha256-stored), so ours lives in .data/longrun.json — runtime state,
 * never the repo.
 *
 * The final deliverable has no read endpoint by design; it is read from the
 * service's sqlite store on disk (LONGRUN_DIR), read-only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function create(env) {
  const dataDir = env('DATA_DIR', path.join(__dirname, '..', '.data'));
  const stateFile = path.join(dataDir, 'longrun.json');

  const base = () => String(env('LONGRUN_URL', '')).trim().replace(/\/+$/, '');
  const configured = () => !!base();

  const local = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (e) { return {}; }
  };
  const saveLocal = (patch) => {
    const cur = Object.assign(local(), patch);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
    } catch (e) { /* key survives in memory for this process */ }
    return cur;
  };

  async function http(method, p, body, key, timeoutMs) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const r = await fetch(base() + p, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || (p + ' -> HTTP ' + r.status));
    return data;
  }

  /** The bearer key, issued once on first use. The service never re-shows a
   *  key, so losing longrun.json means issuing a fresh one — harmless. */
  async function ensureKey() {
    const cur = local();
    if (cur.key) return cur.key;
    const out = await http('POST', '/api/keys', { label: 'shop-agent' });
    if (!out.key) throw new Error('key endpoint returned no key');
    saveLocal({ key: out.key, keyId: out.info && out.info.id });
    return out.key;
  }

  /**
   * Commission a run. Returns { threadId, echo } — echo is the service's
   * resolved config, logged so silent defaults (its domain allowlist ships
   * pointed at PubMed) are visible instead of mysterious.
   */
  async function begin(task) {
    const key = await ensureKey();
    const body = { task, supervise: true };
    const worker = env('LONGRUN_WORKER', '');
    if (worker) body.worker = worker;
    // Its default allowlist is a research set (eutils/pubmed) — for shop work
    // LONGRUN_DOMAINS must say so. Only pass what the user configured.
    const domains = env('LONGRUN_DOMAINS', '');
    if (domains) body.domains = domains;
    const maxUsd = Number(env('LONGRUN_MAX_USD', ''));
    if (maxUsd > 0) body.max_usd = maxUsd;
    if (String(env('LONGRUN_WRITE_LOCK', '')).toLowerCase() === '0') body.write_lock = false;
    // One rolling thread = its no-context-drift memory carries across goals.
    const thread = env('LONGRUN_THREAD', '') || local().thread;
    if (thread) body.thread = thread;

    const echo = await http('POST', '/api/start', body, key, 20000);
    const threadId = echo.thread_id || (echo.config && echo.config.thread) || thread || '';
    if (threadId) saveLocal({ thread: threadId });
    return { threadId, echo };
  }

  /** Persist the thread id once the state poll reveals it. */
  const remember = (thread) => { if (thread) saveLocal({ thread }); };

  const state = () => http('GET', '/api/state', undefined, local().key, 10000);
  const stop = () => http('POST', '/api/stop', {}, local().key);
  const wrapup = () => http('POST', '/api/wrapup', {}, local().key);
  const nudge = (text) => http('POST', '/api/nudge', { text: String(text || '') }, local().key);

  /** The deliverable, straight from the service's sqlite store. Best-effort:
   *  '' when the DB/row/binary is missing, never a throw. */
  function deliverable(threadId) {
    return new Promise((resolve) => {
      if (!threadId) return resolve('');
      const dir = env('LONGRUN_DIR', path.join(process.env.HOME || '', 'Downloads', 'longrun-agent'));
      const db = path.join(dir, 'data', 'memory_' + threadId + '.db');
      if (!fs.existsSync(db)) return resolve('');
      execFile('sqlite3', ['file:' + db + '?mode=ro',
        "select content from fts where id like 'art-%article-md'"],
        { timeout: 8000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
    });
  }

  return { configured, begin, state, stop, wrapup, nudge, deliverable, remember };
}

module.exports = { create };
