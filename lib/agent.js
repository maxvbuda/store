/**
 * The agent loop, running server-side.
 *
 * It used to live in the browser page, which meant closing the tab killed the
 * run. Here it keeps going regardless — the page just polls for status.
 *
 * Three things it owns:
 *   - the standing brief (a system prompt describing the agent's job), which
 *     is persisted and injected into every step;
 *   - CAPTCHA / bot-wall detection: it stops and asks for a human rather than
 *     flailing at a challenge it cannot pass;
 *   - a bounded see -> think -> act loop with a run log.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BRIEF = `You are the Shop Agent of an e-commerce store. You work inside a real web
browser on the owner's behalf. Be careful and literal: prefer reading what is
on the page over guessing, and never invent data you have not seen.

You cannot sign in to anything. If credentials are required, stop and say so.`;

const ACTION_RULES = `Each turn you receive the page URL, its visible text, and a numbered list of
the interactive controls on screen.

Reply with ONE action as strict JSON and nothing else:
  {"action":"click","index":<n>,"why":"..."}
  {"action":"type","index":<n>,"text":"...","why":"..."}
  {"action":"key","key":"Enter","why":"..."}
  {"action":"scroll","dy":600,"why":"..."}
  {"action":"goto","url":"https://...","why":"..."}
  {"action":"done","answer":"what you found or did","why":"..."}

Rules:
- "index" must be a number from the control list. Never invent one.
- If what you need is not listed, scroll to reveal more before giving up.
- The answer is often already in the page text — if so, reply done immediately.
- Never attempt to sign in or solve a CAPTCHA. Reply done and say a human is needed.
- When the goal is met, reply done with the answer.`;

// Signatures of a bot wall. Passing these needs a human, not another retry.
const WALL_TITLE = /just a moment|attention required|access denied|are you human|security check|verify you are/i;
const WALL_TEXT = /connection needs to be verified|checking your browser|enable javascript and cookies|complete the security check|unusual traffic|verify you are a human|cf-challenge|recaptcha|hcaptcha/i;

/** A sign-in page is a wall too — the agent can't pass it, you can. */
function detectLogin(page) {
  const hasPassword = (page.elements || []).some(e => /input:password/i.test(e.kind || ''));
  if (hasPassword) return 'a sign-in page';
  const title = String(page.title || '');
  const text = String(page.text || '').slice(0, 1200);
  if (/(^|\W)(log ?in|sign ?in)(\W|$)/i.test(title) &&
      /(password|continue with|email)/i.test(text)) return 'a sign-in page';
  return null;
}

function detectWall(page) {
  const title = String(page.title || '');
  const text = String(page.text || '');
  if (WALL_TITLE.test(title) || WALL_TEXT.test(text)) {
    return (title.match(WALL_TITLE) || text.match(WALL_TEXT) || ['a bot check'])[0];
  }
  // A page with a body but no operable controls is usually a challenge too.
  if ((page.elements || []).length === 0 && text.length > 0 && text.length < 400
      && /verif|challeng|robot|captcha/i.test(text)) {
    return 'a challenge page';
  }
  return null;
}

function create(env, send, readBody, browser, askModel, onError) {
  const dataDir = env('DATA_DIR', path.join(__dirname, '..', '.data'));
  const briefFile = path.join(dataDir, 'brief.txt');
  // The user's own agent backend (persistent threads, its own Chromium).
  // Runs go there whenever LONGRUN_URL answers; this loop is the fallback.
  const longrun = require('./longrun').create(env);

  let brief = DEFAULT_BRIEF;
  try {
    if (fs.existsSync(briefFile)) brief = fs.readFileSync(briefFile, 'utf8');
  } catch (e) { /* default */ }

  const run = {
    id: 0, goal: '', status: 'idle',   // idle | running | done | failed | needs_human | stopped
    step: 0, maxSteps: 12, answer: '', error: '',
    startedAt: null, endedAt: null, log: [], backend: 'builtin',
  };
  let stopRequested = false;
  let lrPoll = null;       // interval handle while a longrun run is live
  let lrThread = '';

  const note = (kind, text, extra) => {
    run.log.unshift(Object.assign({ at: new Date().toISOString(), kind, text }, extra || {}));
    if (run.log.length > 200) run.log.length = 200;
    console.log('[agent] %s: %s', kind, String(text).slice(0, 120));
    // Surface real failures to the error log; needs_human is expected, not a bug.
    if (kind === 'error' && typeof onError === 'function') {
      try { onError('agent', text, { goal: run.goal, step: run.step }); } catch (e) {}
    }
  };

  const describe = (p) => {
    const list = (p.elements || [])
      .map(e => `[${e.i}] ${e.kind}${e.editable ? ' (editable)' : ''} "${e.label}"`)
      .join('\n') || '(no interactive controls found)';
    const more = p.scrollHeight > (p.viewport ? p.viewport.h : 800)
      ? `\nScroll: ${p.scrollY} of ${p.scrollHeight - p.viewport.h} (more below)` : '';
    return `URL: ${p.url}\nTitle: ${p.title}${more}\n\nControls:\n${list}\n\nPage text:\n${String(p.text || '').slice(0, 3500)}`;
  };

  async function loop(goal, maxSteps) {
    const history = [];
    for (let i = 1; i <= maxSteps; i++) {
      if (stopRequested) { run.status = 'stopped'; note('stopped', 'stopped by you'); break; }
      run.step = i;

      let page;
      try {
        page = await browser.read();
      } catch (e) {
        run.status = 'failed'; run.error = 'could not read the page: ' + e.message;
        note('error', run.error); break;
      }

      // A bot wall or a sign-in page cannot be argued past. Hand it over.
      const wall = detectWall(page) || detectLogin(page);
      if (wall) {
        run.status = 'needs_human';
        run.error = `Blocked by ${wall} at ${page.url}`;
        note('needs_human',
          `Hit ${wall}. Sort it out in the live view above — the session is saved, `
          + `so you only have to do it once — then run the goal again.`,
          { url: page.url });
        break;
      }

      let out;
      try {
        out = await askModel({
          system: brief + '\n\n' + ACTION_RULES,
          prompt: 'Goal: ' + goal + '\n\n' + describe(page)
            + (history.length ? '\n\nActions so far:\n' + history.join('\n') : '')
            + '\n\nWhat is your next single action? JSON only.',
          max_tokens: 900, temperature: 0.2,
          model: env('BROWSER_MODEL', '') || undefined,
        });
      } catch (e) {
        run.status = 'failed'; run.error = e.message; note('error', e.message); break;
      }

      let step;
      const m = String(out.text).match(/\{[\s\S]*\}/);
      try { step = JSON.parse(m ? m[0] : out.text); }
      catch (e) {
        run.status = 'failed'; run.error = 'model did not return JSON';
        note('error', 'unreadable reply: ' + String(out.text).slice(0, 160)); break;
      }

      note(step.action, step.why || '', { step: i });
      history.push(i + '. ' + JSON.stringify(step));

      if (step.action === 'done') {
        run.status = 'done'; run.answer = step.answer || '';
        note('done', run.answer); break;
      }

      try {
        const byIndex = n => (page.elements || []).find(e => e.i === Number(n));
        if (step.action === 'click' || step.action === 'type') {
          const el = byIndex(step.index);
          if (!el) {
            note('error', 'no control numbered ' + step.index);
            history.push(i + '. ERROR: index ' + step.index + ' does not exist');
            continue;
          }
          await browser.act('click', { x: el.x, y: el.y });
          if (step.action === 'type') await browser.act('type', { text: step.text || '' });
        }
        else if (step.action === 'key') await browser.act('key', { key: step.key || 'Enter' });
        else if (step.action === 'scroll') await browser.act('scroll', { dy: step.dy || 600 });
        else if (step.action === 'goto') await browser.act('goto', { url: step.url || '' });
        else { run.status = 'failed'; run.error = 'unknown action ' + step.action; note('error', run.error); break; }
      } catch (e) {
        run.status = 'failed'; run.error = e.message; note('error', e.message); break;
      }

      if (i === maxSteps) {
        run.status = 'failed';
        run.error = 'step limit reached (' + maxSteps + ')';
        note('error', run.error);
      }
    }
    run.endedAt = new Date().toISOString();
  }

  /**
   * Drive a run on the longrun backend: commission it, then translate its
   * /api/state into this run object every few seconds so the UI (chat,
   * updates, status) needs no idea which backend is underneath.
   */
  async function longrunRun(goal) {
    const { threadId, echo } = await longrun.begin(goal);   // throws -> caller falls back
    lrThread = threadId;
    run.backend = 'longrun';
    // Open-ended by design — '∞' reads right in "step 3 of ∞" and quietly
    // disarms the numeric progress math (NaN% -> no bar) instead of lying.
    run.maxSteps = '∞';
    note('goal', 'commissioned on your longrun backend'
      + (threadId ? ' · thread ' + threadId : ''));
    const cfg = echo && (echo.config || echo);
    if (cfg && cfg.domains) note('brief', 'domain allowlist: ' + cfg.domains);
    if (cfg && cfg.worker) note('brief', 'worker: ' + cfg.worker);

    let lastTurn = -1;
    let lastStatus = '';
    clearInterval(lrPoll);
    lrPoll = setInterval(async () => {
      let s;
      try { s = await longrun.state(); }
      catch (e) { return; /* transient — keep polling */ }

      // /api/start's echo doesn't carry the thread id, but state does —
      // without it, thread memory doesn't continue and the deliverable
      // lookup has no database to read.
      if (!lrThread && s.thread_id) {
        lrThread = s.thread_id;
        longrun.remember(lrThread);
      }

      const turn = (s.run && s.run.turn) || s.turn || 0;
      const usd = s.usage && s.usage.est_usd_total;
      if (turn !== lastTurn) {
        lastTurn = turn;
        run.step = turn;
        note('turn', 'turn ' + turn + (usd != null ? ' · ~$' + Number(usd).toFixed(2) : ''));
      }
      if (s.status !== lastStatus) {
        lastStatus = s.status;
        if (s.status === 'paused') note('brief', 'backend paused');
      }

      const finished = s.status === 'finished' || s.status === 'stopped' || s.error;
      if (!finished) return;
      clearInterval(lrPoll); lrPoll = null;

      if (s.error) {
        run.status = 'failed'; run.error = String(s.error).slice(0, 300);
        note('error', run.error);
      } else {
        const outcome = (s.run && s.run.outcome) || '';
        // The deliverable lives only in the backend's sqlite store.
        const article = await longrun.deliverable(lrThread);
        run.status = stopRequested ? 'stopped' : 'done';
        run.answer = (article || outcome || 'Run finished.').slice(0, 4000);
        note('done', run.answer.slice(0, 600)
          + (usd != null ? '  (~$' + Number(usd).toFixed(2) + ')' : ''));
      }
      run.endedAt = new Date().toISOString();
    }, 3000);
    if (lrPoll.unref) lrPoll.unref();
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/agent/')) return false;
    const action = p.slice('/api/agent/'.length);

    if (action === 'status') {
      send(res, 200, { run, brief, defaultBrief: DEFAULT_BRIEF });
      return true;
    }

    if (action === 'brief' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e.message) }); return true; }
      brief = String(body.brief || '').slice(0, 8000) || DEFAULT_BRIEF;
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(briefFile, brief);
      } catch (e) { /* in-memory is still fine */ }
      note('brief', 'standing brief updated');
      send(res, 200, { ok: true, brief });
      return true;
    }

    if (action === 'stop' && req.method === 'POST') {
      stopRequested = true;
      if (run.backend === 'longrun' && run.status === 'running') {
        longrun.stop().then(() => note('stopped', 'stop sent — lands at the next turn boundary'))
          .catch(e => note('error', 'stop did not reach the backend: ' + e.message));
      }
      send(res, 200, { ok: true });
      return true;
    }

    // Mid-run steering: only meaningful on the longrun backend, which queues
    // nudges and applies them at the next turn boundary.
    if (action === 'nudge' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e.message) }); return true; }
      const text = String(body.text || '').trim();
      if (!text) { send(res, 400, { error: 'text is required' }); return true; }
      if (run.backend !== 'longrun' || run.status !== 'running') {
        send(res, 409, { error: 'nothing running that can take a nudge' });
        return true;
      }
      try {
        await longrun.nudge(text);
        note('nudge', text);
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 502, { error: 'nudge failed: ' + e.message });
      }
      return true;
    }

    if (action === 'start' && req.method === 'POST') {
      if (run.status === 'running') { send(res, 409, { error: 'already running' }); return true; }
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e.message) }); return true; }
      const goal = String(body.goal || '').trim();
      if (!goal) { send(res, 400, { error: 'goal is required' }); return true; }

      stopRequested = false;
      clearInterval(lrPoll); lrPoll = null;
      Object.assign(run, {
        id: run.id + 1, goal, status: 'running', step: 0,
        maxSteps: Math.max(1, Math.min(40, Number(body.maxSteps) || 12)),
        answer: '', error: '', startedAt: new Date().toISOString(), endedAt: null,
        log: [], backend: 'builtin',
      });
      note('goal', goal);

      // Deliberately not awaited: the run continues after this response, and
      // after the page that started it goes away. Longrun first when
      // configured; any failure to commission falls back to the built-in
      // loop so a dead backend (or the VM, where none runs) still works.
      (async () => {
        if (longrun.configured()) {
          try { await longrunRun(goal); return; }
          catch (e) {
            note('brief', 'longrun backend unreachable (' + String(e.message).slice(0, 90)
              + ') — using the built-in loop');
            run.backend = 'builtin';
          }
        }
        await loop(goal, run.maxSteps);
      })().catch(e => {
        run.status = 'failed'; run.error = String(e.message || e);
        note('error', run.error);
      });

      send(res, 200, { ok: true, id: run.id });
      return true;
    }

    send(res, 404, { error: 'unknown agent endpoint' });
    return true;
  }

  return { handle, detectWall, detectLogin };
}

module.exports = { create, DEFAULT_BRIEF };
