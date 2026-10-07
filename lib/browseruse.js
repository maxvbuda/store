/**
 * browser-use (open source, run locally) as the agent's brain.
 *
 * Each goal spawns agent/browseruse_runner.py, which attaches to the
 * sidecar's Chromium over CDP — the same logged-in profile the live view
 * shows — and streams "@@BU {json}" progress lines back. This module turns
 * those into the callbacks lib/agent.js feeds its run log with.
 *
 * Needs `pip install -r requirements.txt` (browser-use is in there). If
 * there's no key or Chromium won't come up, begin() throws and lib/agent.js
 * falls back to its built-in loop; a missing browser-use package surfaces as
 * a failed run that says to install it.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'agent', 'browseruse_runner.py');
const OPENROUTER = 'https://openrouter.ai/api/v1';

function create(env, browser, pickModel, fallbackModel) {
  let child = null;

  // OpenRouter's public model list says which models take images. Sending a
  // screenshot to a text-only model is a hard error, so vision follows it.
  let modalities = null;
  async function takesImages(model) {
    const forced = String(env('BROWSER_USE_VISION', '')).toLowerCase();
    if (forced) return forced === '1' || forced === 'true';
    try {
      if (!modalities) {
        const r = await fetch(OPENROUTER + '/models', { signal: AbortSignal.timeout(10000) });
        const body = await r.json();
        modalities = new Map((body.data || []).map(m =>
          [m.id, (m.architecture && m.architecture.input_modalities) || []]));
      }
      return (modalities.get(model) || []).includes('image');
    } catch (e) {
      return false;   // unknown -> text-only is the safe guess
    }
  }

  const running = () => !!child;

  /**
   * Start a run. Resolves once the runner process is up; progress arrives
   * through `on`: step({n, url, thought, actions}), done({success, answer,
   * stopped}), error(message), exit(code). Exactly one of done/error fires,
   * then exit.
   */
  async function begin(goal, brief, on) {
    if (child) throw new Error('a browser-use run is already going');
    const key = env('OPENROUTER_API_KEY', '');
    if (!key) throw new Error('OPENROUTER_API_KEY is not set');
    // The runner attaches to Chromium, so Chromium has to exist first —
    // reading the page is what makes the sidecar launch it.
    await browser.read();

    const model = env('BROWSER_MODEL', '') || await pickModel();
    const cfg = {
      goal, brief, model,
      fallback_model: fallbackModel,
      vision: await takesImages(model),
      cdp_url: 'http://127.0.0.1:' + Number(env('BROWSER_CDP_PORT', 9242)),
    };

    const proc = spawn('python3', [RUNNER], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, {
        OPENROUTER_API_KEY: key,
        OPENROUTER_FALLBACK_API_KEY: env('OPENROUTER_FALLBACK_API_KEY', ''),
        ANONYMIZED_TELEMETRY: 'false',
        BROWSER_USE_CLOUD_SYNC: 'false',
        PYTHONUNBUFFERED: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;

    let settled = false;
    let tail = '';     // last stderr, for a useful message if it just dies
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith('@@BU ')) { if (line.trim()) console.log('[browser-use] ' + line); continue; }
        let msg;
        try { msg = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (msg.type === 'step') on.step(msg);
        else if (msg.type === 'done' && !settled) { settled = true; on.done(msg); }
        else if (msg.type === 'error' && !settled) { settled = true; on.error(msg.error); }
      }
    });
    proc.stderr.on('data', (d) => {
      tail = (tail + d).slice(-2000);
      process.stderr.write('[browser-use] ' + d);
    });
    proc.on('exit', (code) => {
      child = null;
      if (!settled) {
        settled = true;
        const why = (tail.trim().split('\n').pop() || '').slice(0, 300);
        on.error(/No module named 'browser_use'/.test(tail)
          ? 'browser-use is not installed — run: python3 -m pip install -r requirements.txt'
          : 'browser-use exited (' + code + ')' + (why ? ': ' + why : ''));
      }
      on.exit(code);
    });
    proc.on('error', (e) => {
      child = null;
      if (!settled) { settled = true; on.error('could not start python3: ' + e.message); }
    });

    // stdin stays open: it is the stop channel (see stop()).
    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify(cfg) + '\n');
  }

  /** Ask the run to stop; it lands at the next step boundary. A step can
   *  sit on a slow model call, so kill it outright if it hasn't left in 60s. */
  function stop() {
    const proc = child;
    if (!proc) return;
    try { proc.stdin.write(JSON.stringify({ stop: true }) + '\n'); } catch (e) {}
    const t = setTimeout(() => { if (child === proc) proc.kill('SIGKILL'); }, 60000);
    if (t.unref) t.unref();
  }

  return { begin, stop, running };
}

module.exports = { create };
