
// The chat thread lives in localStorage so a reload doesn't wipe the
// conversation. Bounded so it can't grow without limit.
const CHAT_KEY = 'operator.chat.v1';
function loadChat() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    return Array.isArray(raw) ? raw.slice(-120) : [];
  } catch (e) { return []; }
}
function saveChat(chat) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chat.slice(-120))); } catch (e) {}
}

const STEPS = [
  { a: 'screenshot', x: 640, y: 400, call: 'screenshot()', text: 'Read the screen' },
  { a: 'click', x: 100, y: 208, call: 'click(100, 208)', text: 'Open the renewals queue' },
  { a: 'click', x: 520, y: 290, call: 'click(520, 290)', text: 'Select Northwind Traders' },
  { a: 'click', x: 1070, y: 391, call: 'click(1070, 391)', text: 'Focus the renewal note' },
  { a: 'type', x: 1070, y: 391, call: 'type(…)', text: 'Write the renewal note', typed: 'Confirmed 24-month renewal at 8% uplift.' },
  { a: 'click', x: 945, y: 489, call: 'click(945, 489)', text: 'Save the record' },
  { a: 'click', x: 1081, y: 489, call: 'click(1081, 489)', text: 'Send confirmation to billing@northwind.co' }
];

const NAV = ['Pipeline', 'Accounts', 'Renewals', 'Reports', 'Inbox'];

const ROWS = [
  { name: 'Meridian Health', date: 'Aug 12', arr: '$84,000', status: 'Renewed' },
  { name: 'Northwind Traders', date: 'Aug 14', arr: '$126,000', status: 'Due' },
  { name: 'Calder & Fisk', date: 'Aug 19', arr: '$41,500', status: 'Due' },
  { name: 'Ostrom Labs', date: 'Aug 22', arr: '$68,000', status: 'At risk' },
  { name: 'Kestrel Freight', date: 'Aug 30', arr: '$22,400', status: 'Due' },
  { name: 'Lyle Systems', date: 'Sep 02', arr: '$57,800', status: 'Due' }
];

const BACKLOG = [
  { name: 'Meridian Health', date: 'Aug 12', arr: '$84,000', state: 'Done' },
  { name: 'Northwind Traders', date: 'Aug 14', arr: '$126,000', state: 'In progress' },
  { name: 'Calder & Fisk', date: 'Aug 19', arr: '$41,500', state: 'Queued' },
  { name: 'Ostrom Labs', date: 'Aug 22', arr: '$68,000', state: 'Needs approval' },
  { name: 'Kestrel Freight', date: 'Aug 30', arr: '$22,400', state: 'Queued' },
  { name: 'Lyle Systems', date: 'Sep 02', arr: '$57,800', state: 'Queued' },
  { name: 'Bramble & Co', date: 'Sep 04', arr: '$19,200', state: 'Queued' },
  { name: 'Harrow Dynamics', date: 'Sep 08', arr: '$203,000', state: 'Queued' },
  { name: 'Pell Analytics', date: 'Sep 11', arr: '$36,900', state: 'Queued' },
  { name: 'Vance Maritime', date: 'Sep 15', arr: '$71,300', state: 'Queued' },
  { name: 'Ridley Foods', date: 'Sep 19', arr: '$28,600', state: 'Queued' },
  { name: 'Solent Group', date: 'Sep 24', arr: '$94,750', state: 'Queued' }
];

const UPDATES = [
  { time: '07:12', desk: 'Sales', text: 'Opened the Q3 renewal queue — 12 accounts, $853,650 of ARR in scope', flag: 'Logged' },
  { time: '09:04', desk: 'Marketing', text: 'Staged the August lifecycle drip in Braze; four sends are written and held on copy approval', flag: 'Needs you' },
  { time: '10:38', desk: 'Customer service', text: 'Cleared 62 tier-one tickets; median first reply is now under four minutes', flag: 'Logged' },
  { time: '11:20', desk: 'Customer service', text: 'Backlog down 38% against yesterday, with 31 tickets still queued for the afternoon', flag: 'Logged' },
  { time: '13:47', desk: 'Sales', text: 'Ostrom Labs flagged at risk — the renewal terms changed and the agent stopped rather than guess', flag: 'Needs you' },
  { time: '15:02', desk: 'Marketing', text: 'Paused the paid retargeting set: spend was tracking 22% over the daily cap', flag: 'Needs you' },
  { time: '16:31', desk: 'Sales', text: 'Northwind Traders renewed at 8% uplift, confirmation sent to billing', flag: 'Logged' }
];

class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = {
      page: props.startPage === 'status' ? 'status' : 'computer',
      done: 0,
      typed: '',
      running: props.autoPlay !== false,
      manual: false,
      backlog: false,
      seconds: 0,
      // live data, polled from the server
      run: null, updates: [], browserOk: false, model: '', pageTitle: '', pageUrl: '',
      goalDraft: '', composerError: '',
      manualUrl: '',
      chat: loadChat(),        // the conversation thread, persisted across reloads
      chatDraft: ''
    };
    // Which run-log entries are already in the thread — keyed so streaming
    // entries append once and in order.
    this.chatKeys = new Set(this.state.chat.filter(m => m.key).map(m => m.key));
    // Keystrokes are buffered and flushed as one /type call — per-key requests
    // arrive out of order on a slow link and typing comes out scrambled.
    this.typeBuf = '';
    this.typeTimer = null;
    this.scrollAcc = 0;
    this.scrollTimer = null;
    this.scrollPos = { x: 640, y: 400 };  // wheel lands where the pointer last was
    this.moveAt = 0;                      // last mousemove sent, for the ~30ms throttle
    this.streamDown = false;              // stream failed → screenshot polling until a retry works
    this.streamRetry = null;
    this.tick = 0;
    this.bootedAt = Date.now();
    this.viewportRef = React.createRef();
    this.stageRef = React.createRef();
    this.cursorRef = React.createRef();
    this.rippleRef = React.createRef();
    this.progressRef = React.createRef();
    this.chatRef = React.createRef();
    this.frameRef = React.createRef();
    this.frameBoxRef = React.createRef();
    this.scale = 0.8;
    this.timers = [];
  }

  componentDidMount() {
    this.measure();
    if (window.ResizeObserver && this.frameBoxRef.current) {
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(this.frameBoxRef.current);
    }
    this.clock = setInterval(() => this.setState({ seconds: Math.floor((Date.now() - this.bootedAt) / 1000) }), 1000);
    this.sync();
    // Real data instead of the scripted demo.
    this.poll();
    this.poller = setInterval(() => this.poll(), 1500);
    this.setFrameRate(1200);
    // Take-over keyboard: window-level so no element needs focus first.
    this.keyHandler = (e) => this.onManualKey(e);
    window.addEventListener('keydown', this.keyHandler, true);
    this.scrollChat();
  }

  /** Fallback screenshot cadence — faster while a human is driving. */
  setFrameRate(ms) {
    if (this.frameMs === ms) return;
    this.frameMs = ms;
    clearInterval(this.framer);
    // Only the polling fallback needs a timer; the stream pushes frames itself.
    this.framer = setInterval(() => { if (this.streamDown) { this.tick++; this.sync(); } }, ms);
  }

  /**
   * The live screen: an MJPEG stream in an <img>. src is set ONCE — the
   * connection stays open and frames replace each other; rewriting src on a
   * timer would reconnect every tick. On error we drop back to screenshot
   * polling and retry the stream every ~15s.
   */
  startStream() {
    const img = this.frameRef.current;
    if (!img) return;
    clearTimeout(this.streamRetry);
    this.streamDown = false;
    img.src = '/api/browser/stream';
  }

  onStreamError() {
    const img = this.frameRef.current;
    // Only a stream failure demotes us — a missed screenshot just re-polls.
    if (!img || img.src.indexOf('/api/browser/stream') === -1) return;
    this.streamDown = true;
    img.src = '/api/browser/screenshot?t=' + this.tick;
    clearTimeout(this.streamRetry);
    this.streamRetry = setTimeout(() => this.startStream(), 15000);
  }

  /**
   * Take-over mode: keys go to the agent's browser, not this page.
   * Printable characters buffer into one /type call (per-key requests arrive
   * out of order on a slow link); everything else maps to a named key press.
   */
  onManualKey(e) {
    if (!this.state.manual) return;
    const t = e.target;
    // The URL bar and the goal composer keep their own keys.
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // browser shortcuts stay local

    const NAMED = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
                   'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                   'Home', 'End', 'PageUp', 'PageDown'];
    if (e.key.length === 1) {
      e.preventDefault();
      this.typeBuf += e.key;
      clearTimeout(this.typeTimer);
      this.typeTimer = setTimeout(() => this.flushType(), 140);
    } else if (NAMED.includes(e.key)) {
      e.preventDefault();
      // Order matters: anything typed must land before the key press —
      // Enter arriving before the password would submit a half-filled form.
      this.flushType();
      this.browserAct('key', { key: e.key });
    }
  }

  flushType() {
    clearTimeout(this.typeTimer);
    if (!this.typeBuf) return;
    const text = this.typeBuf;
    this.typeBuf = '';
    this.browserAct('type', { text });
  }

  /** One manual action against the agent's browser, then a fresh frame. */
  browserAct(action, body) {
    return fetch('/api/browser/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(() => this.refreshFrame()).catch(() => {});
  }

  /** Post-action refresh — only the fallback needs it; streamed frames arrive on their own. */
  refreshFrame() {
    if (this.streamDown) { this.tick++; this.sync(); }
  }

  /**
   * Fold the agent's run log into the chat thread as replies. The log is
   * newest-first and grows in place, so we walk it oldest-first and append
   * only entries we have not shown, keyed by run + timestamp + text.
   */
  absorbLog(run) {
    if (!run || !Array.isArray(run.log) || !run.log.length) return;
    const fresh = [];
    for (let i = run.log.length - 1; i >= 0; i--) {   // oldest first
      const e = run.log[i];
      const key = run.id + '|' + (e.at || i) + '|' + (e.text || '');
      if (this.chatKeys.has(key)) continue;
      this.chatKeys.add(key);
      fresh.push({ role: 'agent', kind: e.kind || '', text: e.text || '', at: e.at, key });
    }
    if (!fresh.length) return;
    const chat = this.state.chat.concat(fresh).slice(-120);
    saveChat(chat);
    this.setState({ chat }, () => this.scrollChat());
  }

  /** Send a chat message — it becomes the agent's next goal. */
  sendChat() {
    const text = (this.state.chatDraft || '').trim();
    if (!text) return;
    const r = this.state.run;
    if (r && r.status === 'running') {
      this.pushChat({ role: 'note', text: 'The agent is still on the last task — one at a time for now.' });
      return;
    }
    this.pushChat({ role: 'you', text });
    this.setState({ chatDraft: '' });
    fetch('/api/agent/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: text, maxSteps: 12 }),
    }).then(r => r.json()).then(d => {
      if (d && d.error) this.pushChat({ role: 'note', text: d.error });
      this.poll();
    }).catch(e => this.pushChat({ role: 'note', text: 'Server unreachable: ' + (e.message || e) }));
  }

  pushChat(msg) {
    const chat = this.state.chat.concat([msg]).slice(-120);
    saveChat(chat);
    this.setState({ chat }, () => this.scrollChat());
  }

  scrollChat() {
    const el = this.chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** Pull the real agent run and browser state. */
  async poll() {
    try {
      const a = await (await fetch('/api/agent/status', { cache: 'no-store' })).json();
      this.setState({ run: a.run, updates: (a.run && a.run.log) || [] });
      this.absorbLog(a.run);
    } catch (e) { /* server restarting */ }
    try {
      const b = await (await fetch('/api/browser/status', { cache: 'no-store' })).json();
      const bs = b.state || {};
      this.setState({ browserOk: !!bs.healthy, model: b.model || '',
                      pageTitle: bs.title || '', pageUrl: bs.url || '' });
    } catch (e) { this.setState({ browserOk: false }); }
  }

  /**
   * Start a real server-side run from whatever is in the composer.
   *
   * The run outlives this tab — it lives on the server, so closing the page
   * does not stop it. Errors land in the composer rather than a dialog,
   * because the panel is already open and looking at you.
   */
  async submitGoal() {
    const goal = (this.state.goalDraft || '').trim();
    if (!goal) { this.setState({ composerError: 'Type what it should do first.' }); return; }
    const r = this.state.run;
    if (r && r.status === 'running') {
      this.setState({ composerError: 'Already running — stop it first.' });
      return;
    }
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, maxSteps: 12 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.setState({ composerError: data.error || ('Could not start (' + res.status + ')') });
        return;
      }
      // Close the composer and show the screen — the point is watching it work.
      this.setState({ backlog: false, goalDraft: '', composerError: '' });
      this.poll();
    } catch (e) {
      this.setState({ composerError: 'Server unreachable: ' + (e.message || e) });
    }
  }

  /** Navigate the agent's browser to whatever is in the take-over URL bar. */
  manualGo() {
    const url = (this.state.manualUrl || '').trim();
    if (!url) return;
    this.flushType();
    this.browserAct('goto', { url });
  }

  /** Map a pointer event on the scaled frame back to real 1280x800 page coordinates. */
  mapEvent(ev) {
    const img = this.frameRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.round((ev.clientX - r.left) * (1280 / r.width)),
      y: Math.round((ev.clientY - r.top) * (800 / r.height)),
    };
  }

  /** Take-over pointer: real moves make hovers, drags and text selection work. */
  onFrameMove(e) {
    if (!this.state.manual) return;
    const now = Date.now();
    if (now - this.moveAt < 30) return;   // ~30ms throttle
    const p = this.mapEvent(e);
    if (!p) return;
    this.moveAt = now;
    this.browserAct('input', { type: 'move', x: p.x, y: p.y });
  }

  onFrameDown(e) {
    if (!this.state.manual) return;
    e.preventDefault();   // no native image drag — the press belongs to the page
    const p = this.mapEvent(e);
    if (!p) return;
    // Pending keystrokes belong to the field that had focus BEFORE this press.
    this.flushType();
    this.browserAct('input', { type: 'down', x: p.x, y: p.y });
  }

  onFrameUp(e) {
    if (!this.state.manual) return;
    const p = this.mapEvent(e);
    if (!p) return;
    this.browserAct('input', { type: 'up', x: p.x, y: p.y });
  }

  /** Non-manual clicks only — in take-over mode down+up already covered it. */
  onFrameClick(ev) {
    if (this.state.manual) return;
    const p = this.mapEvent(ev);
    if (!p) return;
    // Pending keystrokes belong to the field that had focus BEFORE this click.
    this.flushType();
    fetch('/api/browser/click', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }).then(() => this.refreshFrame()).catch(() => {});
  }

  componentDidUpdate() { this.measure(); this.sync(); }

  componentWillUnmount() {
    clearInterval(this.poller); clearInterval(this.framer);
    this.clearTimers();
    clearInterval(this.clock);
    clearTimeout(this.typeTimer); clearTimeout(this.scrollTimer);
    clearTimeout(this.streamRetry);
    window.removeEventListener('keydown', this.keyHandler, true);
    if (this.ro) this.ro.disconnect();
  }

  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; clearInterval(this.typer); }
  later(fn, ms) { const t = setTimeout(fn, ms); this.timers.push(t); return t; }

  measure() {
    const el = this.viewportRef.current;
    const host = this.frameBoxRef.current;
    if (!el || !host) return;
    const box = host.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const k = Math.min(box.width / 1280, box.height / 800);
    if (k <= 0) return;
    el.style.width = (1280 * k) + 'px';
    el.style.height = (800 * k) + 'px';
    if (Math.abs(k - this.scale) > 0.0001) { this.scale = k; this.sync(); }
  }

  sync() {
    const s = this.scale;
    if (this.stageRef.current) this.stageRef.current.style.transform = 'scale(' + s + ')';
    // The live screen is the agent's real Chromium — an MJPEG stream, with
    // screenshot polling only while the stream is down.
    const img = this.frameRef.current;
    if (img) {
      if (!img.__wired) {
        img.__wired = true;
        img.style.cursor = 'crosshair';
        img.addEventListener('click', e => this.onFrameClick(e));
        img.addEventListener('mousemove', e => this.onFrameMove(e));
        img.addEventListener('mousedown', e => this.onFrameDown(e));
        img.addEventListener('mouseup', e => this.onFrameUp(e));
        img.addEventListener('error', () => this.onStreamError());
        // Wheel over the frame scrolls the agent's page, not this one.
        // Accumulate and flush — one request per wheel tick floods the sidecar.
        img.addEventListener('wheel', (e) => {
          if (!this.state.manual) return;
          e.preventDefault();
          this.scrollAcc += e.deltaY;
          const p = this.mapEvent(e);
          if (p) this.scrollPos = p;
          clearTimeout(this.scrollTimer);
          this.scrollTimer = setTimeout(() => {
            const dy = Math.round(this.scrollAcc);
            this.scrollAcc = 0;
            if (dy) this.browserAct('wheel', { x: this.scrollPos.x, y: this.scrollPos.y, dy });
          }, 120);
        }, { passive: false });
        this.startStream();
      }
      // Fallback only — while streaming, touching src would reconnect.
      if (this.streamDown) img.src = '/api/browser/screenshot?t=' + this.tick;
    }
    // No scripted cursor: the real pointer is inside the screenshot.
    if (this.cursorRef.current) this.cursorRef.current.style.opacity = '0';
    const run = this.state.run;
    if (this.progressRef.current) {
      const pct = run && run.maxSteps ? Math.min(run.step / run.maxSteps, 1) * 100 : 0;
      this.progressRef.current.style.width = pct + '%';
    }
  }

  ripple() {
    const el = this.rippleRef.current;
    if (!el || !el.animate) return;
    el.animate(
      [{ transform: 'scale(0.25)', opacity: 0.85 }, { transform: 'scale(1.5)', opacity: 0 }],
      { duration: 520, easing: 'cubic-bezier(0.2,0,0,1)' }
    );
  }

  get unit() { return Math.max(220, this.props.stepMs || 900); }

  schedule() {
    // The scripted demo animation is gone — the real run drives everything now.
    this.clearTimers();
    return;
    const i = this.state.done;
    const u = this.unit;
    if (i >= STEPS.length) { this.later(() => this.setState({ done: 0, typed: '' }, () => this.schedule()), u * 3); return; }
    const step = STEPS[i];
    const travel = i === 0 ? u * 0.5 : u * 0.95;
    this.later(() => {
      if (step.a === 'type') { this.typeOut(step.typed); }
      else { if (step.a === 'click') this.ripple(); this.later(() => this.advance(), u * 0.5); }
    }, travel);
  }

  typeOut(text) {
    let n = 0;
    this.setState({ typed: '' });
    this.typer = setInterval(() => {
      n += 1;
      this.setState({ typed: text.slice(0, n) });
      if (n >= text.length) { clearInterval(this.typer); this.later(() => this.advance(), this.unit * 0.6); }
    }, Math.max(14, this.unit / 22));
  }

  advance() { this.setState(s => ({ done: s.done + 1 }), () => this.schedule()); }

  renderVals() {
    const st = this.state;
    const idx = Math.min(st.done, STEPS.length - 1);
    const step = STEPS[idx];
    const ink = 'var(--color-text)';
    const muted = 'color-mix(in srgb, var(--color-text) 45%, transparent)';

    const navBase = {
      textAlign: 'left', background: 'transparent', border: 0, borderRadius: 0, cursor: 'pointer',
      fontFamily: "'Comfortaa', system-ui, sans-serif", fontWeight: 300, fontSize: '15px',
      padding: '9px 0 9px 16px', marginLeft: '-16px', display: 'block', width: 'calc(100% + 16px)',
      borderRadius: '5px', transition: 'color 160ms ease'
    };
    const navOn = Object.assign({}, navBase, { color: ink, boxShadow: 'inset 2px 0 0 var(--color-accent)' });
    const navOff = Object.assign({}, navBase, { color: 'color-mix(in srgb, var(--color-text) 42%, transparent)' });

    const ctrl = {
      fontFamily: "'Comfortaa', system-ui, sans-serif", fontWeight: 300, fontSize: '13px',
      padding: '9px 15px', background: 'transparent', color: ink, cursor: 'pointer', borderRadius: '5px',
      border: '1px solid color-mix(in srgb, var(--color-text) 22%, transparent)', textAlign: 'left',
      minWidth: '84px', transition: 'background 150ms ease'
    };
    const takeover = Object.assign({}, ctrl, {
      background: st.manual ? 'var(--color-accent-700)' : 'var(--color-accent)',
      color: '#ffffff', border: '1px solid transparent', minWidth: '104px'
    });

    const mockNav = NAV.map(label => {
      const active = (label === 'Renewals') ? st.done >= 2 : (label === 'Pipeline' && st.done < 2);
      return {
        label,
        style: {
          height: '40px', display: 'flex', alignItems: 'center', padding: '0 24px', fontSize: '13px',
          color: active ? '#1a1a1a' : '#8d8b8b', background: active ? '#f1efef' : 'transparent',
          boxShadow: active ? 'inset 2px 0 0 #1a1a1a' : 'none'
        }
      };
    });

    const cols = '1fr 96px 104px 88px';
    const tableRows = ROWS.map((r, i) => {
      const selected = i === 1 && st.done >= 3;
      return {
        name: r.name, date: r.date, arr: r.arr, status: r.status,
        style: {
          display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: '12px', height: '52px',
          fontSize: '13px', borderBottom: '1px solid #f1efef',
          background: selected ? '#f1f5fb' : 'transparent',
          boxShadow: selected ? 'inset 2px 0 0 #1a1a1a' : 'none',
          paddingLeft: selected ? '10px' : '0', transition: 'background 160ms ease'
        },
        badgeStyle: {
          fontSize: '11px', color: r.status === 'At risk' ? '#b03a20' : (r.status === 'Renewed' ? '#2f7a3f' : '#777575')
        }
      };
    });

    const typing = st.done === 4;
    const noteBox = {
      marginTop: '10px', height: '120px', border: '1px solid ' + (st.done >= 4 ? '#1a1a1a' : '#e2e0e0'),
      background: '#ffffff', padding: '11px 12px', fontSize: '12.5px', lineHeight: '19px', color: '#1a1a1a'
    };
    const saveBtn = {
      display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: '12.5px', borderRadius: '5px',
      background: st.done >= 6 ? '#f1efef' : '#1a1a1a', color: st.done >= 6 ? '#8d8b8b' : '#ffffff'
    };
    const sendBtn = {
      display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: '12.5px', borderRadius: '5px',
      border: '1px solid ' + (st.done >= 6 ? '#1a1a1a' : '#dedbdb'), color: st.done >= 6 ? '#1a1a1a' : '#8d8b8b'
    };

    const dot = c => ({ width: '6px', height: '6px', display: 'block', background: c });
    // Real desks: what the agent is doing, what the browser is on, the model.
    const r = st.run || {};
    const running = r.status === 'running';
    const STATE_LABEL = {
      running: 'Running', done: 'Done', failed: 'Failed',
      needs_human: 'Needs you', stopped: 'Stopped', idle: 'Idle',
    };
    const liveDot = running
      ? Object.assign(dot('var(--color-accent)'), { animation: 'op-pulse 1.8s ease-in-out infinite' })
      : dot('color-mix(in srgb, var(--color-text) 30%, transparent)');
    const desks = [
      {
        name: 'Agent',
        task: r.goal || 'No goal set',
        detail: running ? ('Step ' + r.step + ' of ' + r.maxSteps)
          : (r.answer || r.error || 'Waiting for a goal'),
        queue: running ? String(Math.max(0, (r.maxSteps || 0) - (r.step || 0))) : '0',
        state: STATE_LABEL[r.status] || 'Idle',
        dotStyle: liveDot,
      },
      {
        name: 'Browser',
        task: st.pageTitle || 'No page loaded',
        detail: (st.pageUrl || '').replace(/^https?:\/\//, '').slice(0, 70) || 'idle',
        queue: st.browserOk ? '1' : '0',
        state: st.browserOk ? 'Running' : 'Down',
        dotStyle: st.browserOk ? dot('var(--color-text)')
          : dot('color-mix(in srgb, var(--color-text) 30%, transparent)'),
      },
      {
        name: 'Model',
        task: st.model || 'not configured',
        detail: 'text-only · reads the page, not a screenshot',
        queue: '0',
        state: st.model ? 'Ready' : 'Off',
        dotStyle: dot('color-mix(in srgb, var(--color-text) 30%, transparent)'),
      },
    ];

    const mm = String(Math.floor(this.state.seconds / 3600)).padStart(2, '0');
    const ss = String(Math.floor(this.state.seconds / 60) % 60).padStart(2, '0');
    const s3 = String(this.state.seconds % 60).padStart(2, '0');

    // ---- real updates -------------------------------------------------
    // The agent's run log, turned into the digest rows this UI expects.
    const DESK_OF = {
      goto: 'Browser', click: 'Browser', type: 'Browser', key: 'Browser',
      scroll: 'Browser', done: 'Result', error: 'Problem',
      needs_human: 'Needs you', stopped: 'Stopped', brief: 'Brief', goal: 'Goal',
    };
    const liveUpdates = (st.updates || []).map(e => {
      const when = e.at ? new Date(e.at) : null;
      const time = when
        ? String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
        : '';
      const needsYou = e.kind === 'needs_human' || e.kind === 'error';
      return {
        time,
        desk: DESK_OF[e.kind] || e.kind,
        text: e.text || '',
        flag: needsYou ? 'Needs you' : (e.kind === 'done' ? 'Done' : 'Logged'),
      };
    });
    if (!liveUpdates.length) {
      liveUpdates.push({ time: '', desk: 'Idle',
        text: 'No activity yet. Give the agent a goal and its steps appear here.', flag: '' });
    }

    const run = st.run || {};
    const busy = run.status === 'running';

    return {
      isStatus: st.page === 'status',
      isComputer: st.page === 'computer',
      goStatus: () => this.setState({ page: 'status' }),
      goComputer: e => { if (e && e.preventDefault) e.preventDefault(); this.setState({ page: 'computer' }, () => this.measure()); },
      isUpdates: st.page === 'updates',
      goUpdates: () => this.setState({ page: 'updates' }),
      navStatusStyle: st.page === 'status' ? navOn : navOff,
      navComputerStyle: st.page === 'computer' ? navOn : navOff,
      navUpdatesStyle: Object.assign({}, st.page === 'updates' ? navOn : navOff, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', paddingRight: '10px'
      }),
      navBadgeStyle: {
        fontSize: '10.5px', letterSpacing: '0.08em',
        color: st.page === 'updates' ? 'var(--color-accent-700)' : 'var(--color-accent)'
      },
      navHoverStyle: { color: ink },

      elapsed: mm + ':' + ss + ':' + s3,
      desks,

      ctrlStyle: ctrl,
      ctrlHoverStyle: { background: 'color-mix(in srgb, var(--color-text) 7%, transparent)' },
      takeoverStyle: takeover,
      takeoverHoverStyle: { background: 'var(--color-accent-600)' },
      playLabel: busy ? 'Working' : 'Run goal',
      manualLabel: st.manual ? 'Give back' : 'Take over',

      // ---- take-over mode ------------------------------------------------
      manualOpen: st.manual,
      manualUrl: st.manualUrl,
      setManualUrl: e => this.setState({ manualUrl: e.target.value }),
      onManualUrlKey: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); this.manualGo(); } },
      manualGo: () => this.manualGo(),
      manualBack: () => this.browserAct('back', {}),
      manualReload: () => { if (st.pageUrl) this.browserAct('goto', { url: st.pageUrl }); },
      manualHint: 'clicks, typing and scrolling go to the page',
      manualBarStyle: {
        position: 'absolute', left: 0, top: 0, right: 0, zIndex: 30,
        display: 'flex', gap: '8px', alignItems: 'center', padding: '9px 12px',
        background: 'color-mix(in srgb, var(--color-neutral-100) 92%, transparent)',
        backdropFilter: 'blur(6px)',
        borderBottom: '1px solid color-mix(in srgb, var(--color-text) 18%, transparent)',
      },
      manualInputStyle: {
        flex: 1, minWidth: 0, font: 'inherit', fontSize: '13.5px', padding: '7px 12px',
        border: '1px solid color-mix(in srgb, var(--color-text) 26%, transparent)',
        borderRadius: '5px', background: 'var(--color-neutral-50, #fff)',
        color: 'var(--color-text)', outline: 'none',
      },
      manualBtnStyle: {
        background: 'transparent', font: 'inherit', fontSize: '13px', cursor: 'pointer',
        border: '1px solid color-mix(in srgb, var(--color-text) 24%, transparent)',
        borderRadius: '5px', padding: '6px 12px', color: 'var(--color-text)',
      },
      // Open the composer. This used to be a window.prompt(), which browsers
      // suppress after the first dialog and which no one could see coming.
      togglePlay: () => {
        if (busy) return;
        this.setState({ backlog: true, composerError: '' });
      },
      stop: () => { fetch('/api/agent/stop', { method: 'POST' }).then(() => this.poll()).catch(() => {}); },
      toggleManual: () => this.setState(s => {
        const manual = !s.manual;
        // Faster frames while a human drives; back to easy polling after.
        this.setFrameRate(manual ? 500 : 1200);
        return { manual, manualUrl: manual ? (s.pageUrl || '') : s.manualUrl };
      }),

      backlogOpen: st.backlog,
      screenOpen: !st.backlog,
      toggleBacklog: () => this.setState(s => ({ backlog: !s.backlog, composerError: '' })),

      // ---- goal composer -------------------------------------------------
      goalDraft: st.goalDraft,
      setGoalDraft: e => this.setState({ goalDraft: e.target.value, composerError: '' }),
      // Enter runs it; Shift+Enter is a newline, so multi-line goals still work.
      onGoalKey: e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submitGoal(); }
        if (e.key === 'Escape') this.setState({ backlog: false });
      },
      submitGoal: () => this.submitGoal(),
      submitLabel: busy ? 'Working…' : 'Run it',
      composerState: busy ? ('Step ' + r.step + ' of ' + r.maxSteps) : 'Idle',
      composerHint: st.composerError
        || (st.goalDraft.trim() ? 'Enter to run · Shift+Enter for a new line'
                                : 'Plain English. It reads the page and works out the clicks.'),
      goalInputStyle: {
        width: '100%', minHeight: '96px', resize: 'vertical', display: 'block',
        boxSizing: 'border-box', padding: '15px 17px',
        border: '1px solid ' + (st.composerError
          ? 'var(--color-accent-600)'
          : 'color-mix(in srgb, var(--color-text) 26%, transparent)'),
        borderRadius: '5px', background: 'var(--color-neutral-50, #fff)',
        color: 'var(--color-text)', font: 'inherit', fontSize: '16px', lineHeight: '25px',
        outline: 'none',
      },
      examples: [
        'Open my Shopify orders and list the ones still unfulfilled.',
        'Find the oldest unanswered customer email and draft a reply.',
        'Check which products have no description and write one for each.',
        'Open example.com and tell me the main heading.',
      ].map((text, i) => ({
        key: 'ex' + i, text,
        use: () => this.setState({ goalDraft: text, composerError: '' }),
        style: {
          background: 'transparent', font: 'inherit', fontSize: '13px', textAlign: 'left',
          border: '1px solid color-mix(in srgb, var(--color-text) 20%, transparent)',
          borderRadius: '999px', padding: '7px 14px', cursor: 'pointer',
          color: 'color-mix(in srgb, var(--color-text) 78%, transparent)',
        },
        hoverStyle: { background: 'color-mix(in srgb, var(--color-text) 7%, transparent)' },
      })),
      // ---- chat dock -----------------------------------------------------
      chatDraft: st.chatDraft,
      setChatDraft: e => this.setState({ chatDraft: e.target.value }),
      onChatKey: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendChat(); } },
      sendChat: () => this.sendChat(),
      chatSendLabel: busy ? 'Working…' : 'Send',
      chatPlaceholder: busy
        ? 'The agent is working — messages queue after it finishes'
        : 'Message the agent — e.g. open my Shopify orders',
      chatInputStyle: {
        flex: 1, minWidth: 0, font: 'inherit', fontSize: '14.5px', padding: '10px 14px',
        border: '1px solid color-mix(in srgb, var(--color-text) 26%, transparent)',
        borderRadius: '7px', background: 'var(--color-neutral-50, #fff)',
        color: 'var(--color-text)', outline: 'none',
      },
      chatThread: (st.chat.length ? st.chat : [{ role: 'note',
        text: 'Say what you want done and watch it happen on the screen above.' }]
      ).map((m, i) => {
        const mine = m.role === 'you';
        const note = m.role === 'note';
        const needsYou = m.kind === 'needs_human' || m.kind === 'error';
        return {
          key: 'm' + i + (m.at || ''),
          who: mine ? 'You' : note ? '' : (m.kind === 'done' ? 'Result'
            : m.kind === 'goal' ? 'Goal' : 'Agent'),
          text: m.text,
          rowStyle: {
            display: 'flex', flexDirection: 'column', gap: '3px',
            alignItems: mine ? 'flex-end' : 'flex-start',
          },
          metaStyle: {
            fontSize: '9.5px', letterSpacing: '0.14em', textTransform: 'uppercase',
            color: needsYou ? 'var(--color-accent-700)'
              : 'color-mix(in srgb, var(--color-text) 42%, transparent)',
            display: m.role === 'note' ? 'none' : 'block',
          },
          bubbleStyle: {
            maxWidth: '80%', fontSize: '14px', lineHeight: '20px', padding: '8px 12px',
            borderRadius: mine ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
            background: mine ? 'var(--color-accent)'
              : note ? 'transparent'
              : 'color-mix(in srgb, var(--color-text) 7%, transparent)',
            color: mine ? '#fff' : note
              ? 'color-mix(in srgb, var(--color-text) 55%, transparent)'
              : 'var(--color-text)',
            border: needsYou ? '1px solid var(--color-accent-700)' : 'none',
            fontStyle: note ? 'italic' : 'normal',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
        };
      }),

      backlogHint: st.backlog ? 'close' : (liveUpdates.length + ' logged'),
      titleBtnStyle: {
        display: 'flex', alignItems: 'center', gap: '12px', background: 'transparent', border: 0,
        borderRadius: '5px', padding: '4px 10px 4px 10px', marginLeft: '-10px', cursor: 'pointer',
        fontFamily: "'Comfortaa', system-ui, sans-serif", fontWeight: 300, color: ink, textAlign: 'left',
        transition: 'background 150ms ease'
      },
      titleBtnHoverStyle: { background: 'color-mix(in srgb, var(--color-text) 6%, transparent)' },
      chevronStyle: {
        fontSize: '13px', color: 'var(--color-accent)', display: 'inline-block',
        transform: st.backlog ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 220ms ease'
      },
      queuedTagStyle: {
        fontSize: '10.5px', letterSpacing: '0.14em', textTransform: 'uppercase',
        color: 'color-mix(in srgb, var(--color-text) 45%, transparent)'
      },
      backLinkStyle: {
        fontFamily: "'Comfortaa', system-ui, sans-serif", fontWeight: 300, fontSize: '11px',
        letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-accent-700)',
        background: 'transparent', border: 0, borderRadius: '5px', padding: '5px 9px', marginRight: '-9px',
        cursor: 'pointer', transition: 'background 150ms ease'
      },
      backLinkHoverStyle: { background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' },
      backlog: BACKLOG.map((b, i) => ({
        name: b.name, date: b.date, arr: b.arr, state: b.state,
        rowStyle: {
          display: 'grid', gridTemplateColumns: '1fr 108px 116px 132px', gap: '20px', alignItems: 'center',
          padding: '17px 28px', borderBottom: '1px solid color-mix(in srgb, var(--color-text) 14%, transparent)',
          background: b.state === 'In progress' ? 'color-mix(in srgb, var(--color-accent) 7%, transparent)' : 'transparent'
        },
        stateStyle: {
          fontSize: '10.5px', letterSpacing: '0.12em', textTransform: 'uppercase',
          color: b.state === 'In progress' ? 'var(--color-accent-700)'
            : (b.state === 'Needs approval' ? ink : 'color-mix(in srgb, var(--color-text) 45%, transparent)')
        }
      })),

      viewportRef: this.viewportRef,
      stageRef: this.stageRef,
      cursorRef: this.cursorRef,
      rippleRef: this.rippleRef,
      progressRef: this.progressRef,
      frameRef: this.frameRef,
      frameBoxRef: this.frameBoxRef,
      updates: liveUpdates.map(u => ({
        time: u.time, desk: u.desk, text: u.text, flag: u.flag || '',
        flagStyle: {
          fontSize: '10.5px', letterSpacing: '0.12em', textTransform: 'uppercase', justifySelf: 'end',
          color: u.flag === 'Needs you' ? 'var(--color-accent-700)' : 'color-mix(in srgb, var(--color-text) 45%, transparent)'
        }
      })),

      navBadgeCount: String(liveUpdates.length),
      // The mock said "Claude · computer use". This runs on DeepSeek — name it.
      statusFooter: (st.model || 'no model')
        + ' · computer use · '
        + (r.status === 'needs_human' ? 'waiting on you'
           : r.status === 'running' ? ('step ' + r.step + ' of ' + r.maxSteps)
           : 'nothing pending'),
      // Header reflects the page the agent is actually on and the goal it holds.
      pageLabel: (st.pageTitle || st.pageUrl || 'No page open').slice(0, 46),
      goalTitle: r.goal || 'No goal yet — press Run goal',
      digestDate: new Date().toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long' }),
      digestDone: String(liveUpdates.filter(u => u.flag === 'Done').length),
      digestNeedsYou: String(liveUpdates.filter(u => u.flag === 'Needs you').length),
      digestSummary: (function () {
        if (!r.status || r.status === 'idle') {
          return 'The agent is idle. Give it a goal on the Computer screen and every '
            + 'step it takes is logged here.';
        }
        if (r.status === 'running') {
          return 'Working on "' + r.goal + '" — step ' + r.step + ' of ' + r.maxSteps
            + '. This continues even if you close the tab.';
        }
        if (r.status === 'needs_human') {
          return 'Stopped and handed back: ' + (r.error || 'a wall it cannot pass')
            + ' Sort it out on the Computer screen, then run the goal again.';
        }
        if (r.status === 'done') return 'Finished "' + r.goal + '". ' + (r.answer || '');
        if (r.status === 'failed') return 'Failed on "' + r.goal + '": ' + (r.error || '');
        return 'Run ' + r.status + '.';
      })(),
      digestFooter: r.status === 'running'
        ? ('Running · step ' + r.step + ' of ' + r.maxSteps)
        : (st.browserOk ? 'Browser ready' : 'Browser down'),

      liveFrame: true,          // always the real browser now
      showMock: false,
      frameSrc: '',
      manual: st.manual,
      liveDotStyle: Object.assign(dot('var(--color-accent)'), busy && !st.manual ? { animation: 'op-pulse 1.8s ease-in-out infinite' } : {}),

      navRows: mockNav,
      tableRows,
      tableHeadStyle: {
        display: 'grid', gridTemplateColumns: cols, gap: '12px', alignItems: 'center', height: '32px',
        marginTop: '24px', borderBottom: '1px solid #e2e0e0', fontSize: '10.5px', letterSpacing: '0.12em',
        textTransform: 'uppercase', color: '#8d8b8b'
      },
      panelOpen: st.done >= 3,
      noteBoxStyle: noteBox,
      typedText: st.typed,
      caretStyle: typing
        ? { display: 'inline-block', width: '1px', height: '14px', background: '#1a1a1a', marginLeft: '1px', verticalAlign: 'text-bottom', animation: 'op-caret 1s step-end infinite' }
        : { display: 'none' },
      saveBtnStyle: saveBtn,
      sendBtnStyle: sendBtn,
      sent: st.done >= 7,

      stepCounter: busy ? ('Step ' + run.step + ' / ' + run.maxSteps)
        : (run.status ? String(run.status).replace('_', ' ') : 'idle'),
      stepText: run.answer || run.error || run.goal || 'No goal set',
      stepCall: st.manual ? 'you have the screen — click it directly'
        : (busy ? (st.model || 'thinking') : (st.browserOk ? 'browser ready' : 'browser down'))
    };
  }
}

