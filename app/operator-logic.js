
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
      run: null, updates: [], browserOk: false, model: '', pageTitle: '', pageUrl: ''
    };
    this.tick = 0;
    this.bootedAt = Date.now();
    this.viewportRef = React.createRef();
    this.stageRef = React.createRef();
    this.cursorRef = React.createRef();
    this.rippleRef = React.createRef();
    this.progressRef = React.createRef();
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
    this.framer = setInterval(() => { this.tick++; this.sync(); }, 1200);
  }

  /** Pull the real agent run and browser state. */
  async poll() {
    try {
      const a = await (await fetch('/api/agent/status', { cache: 'no-store' })).json();
      this.setState({ run: a.run, updates: (a.run && a.run.log) || [] });
    } catch (e) { /* server restarting */ }
    try {
      const b = await (await fetch('/api/browser/status', { cache: 'no-store' })).json();
      const bs = b.state || {};
      this.setState({ browserOk: !!bs.healthy, model: b.model || '',
                      pageTitle: bs.title || '', pageUrl: bs.url || '' });
    } catch (e) { this.setState({ browserOk: false }); }
  }

  /** Map a click on the scaled frame back to real 1280x800 page coordinates. */
  onFrameClick(ev) {
    const img = this.frameRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    fetch('/api/browser/click', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x: Math.round((ev.clientX - r.left) * (1280 / r.width)),
        y: Math.round((ev.clientY - r.top) * (800 / r.height)),
      }),
    }).then(() => { this.tick++; this.sync(); }).catch(() => {});
  }

  componentDidUpdate() { this.measure(); this.sync(); }

  componentWillUnmount() {
    clearInterval(this.poller); clearInterval(this.framer);
    this.clearTimers();
    clearInterval(this.clock);
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
    // The live screen is the agent's real Chromium, refetched on a timer.
    const img = this.frameRef.current;
    if (img) {
      img.src = '/api/browser/screenshot?t=' + this.tick;
      if (!img.__wired) {
        img.__wired = true;
        img.style.cursor = 'crosshair';
        img.addEventListener('click', e => this.onFrameClick(e));
      }
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
      // Ask for a goal and start a real server-side run. It keeps going even
      // if this tab is closed.
      togglePlay: () => {
        if (busy) return;
        const goal = window.prompt('What should the agent do in the browser?',
                                   run.goal || 'Open example.com and tell me the main heading.');
        if (!goal) return;
        fetch('/api/agent/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal, maxSteps: 12 }),
        }).then(() => this.poll()).catch(() => {});
      },
      stop: () => { fetch('/api/agent/stop', { method: 'POST' }).then(() => this.poll()).catch(() => {}); },
      toggleManual: () => this.setState(s => ({ manual: !s.manual })),

      backlogOpen: st.backlog,
      screenOpen: !st.backlog,
      toggleBacklog: () => this.setState(s => ({ backlog: !s.backlog })),
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

