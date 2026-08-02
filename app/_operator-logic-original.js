
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
      seconds: 15129
    };
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
    this.clock = setInterval(() => this.setState(s => ({ seconds: s.seconds + 1 })), 1000);
    this.sync();
    this.schedule();
  }

  componentDidUpdate() { this.measure(); this.sync(); }

  componentWillUnmount() {
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
    const src = this.props.frameSrc || '';
    if (this.frameRef.current && src && this.frameRef.current.getAttribute('src') !== src) {
      this.frameRef.current.setAttribute('src', src);
    }
    const step = STEPS[Math.min(this.state.done, STEPS.length - 1)];
    if (this.cursorRef.current) {
      this.cursorRef.current.style.transform = 'translate3d(' + (step.x * s) + 'px,' + (step.y * s) + 'px,0)';
      this.cursorRef.current.style.opacity = this.state.manual ? '0' : '1';
    }
    if (this.progressRef.current) {
      this.progressRef.current.style.width = ((this.state.done / STEPS.length) * 100) + '%';
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
    this.clearTimers();
    if (!this.state.running || this.state.manual) return;
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
    const desks = [
      { name: 'Sales', task: 'Reconcile the Q3 renewal queue', detail: 'Atlas CRM · ' + step.text.toLowerCase(), queue: '12', state: 'Running', dotStyle: Object.assign(dot('var(--color-accent)'), { animation: 'op-pulse 1.8s ease-in-out infinite' }) },
      { name: 'Marketing', task: 'Schedule the August lifecycle drip', detail: 'Braze · 4 sends staged, awaiting copy approval', queue: '5', state: 'Waiting', dotStyle: dot('color-mix(in srgb, var(--color-text) 30%, transparent)') },
      { name: 'Customer service', task: 'Clear the tier-one ticket backlog', detail: 'Help Scout · 19 resolved in the last hour', queue: '31', state: 'Running', dotStyle: dot('var(--color-text)') }
    ];

    const mm = String(Math.floor(this.state.seconds / 3600)).padStart(2, '0');
    const ss = String(Math.floor(this.state.seconds / 60) % 60).padStart(2, '0');
    const s3 = String(this.state.seconds % 60).padStart(2, '0');

    const frameSrc = this.props.frameSrc || '';

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
      playLabel: st.running && !st.manual ? 'Pause' : 'Resume',
      manualLabel: st.manual ? 'Give back' : 'Take over',
      togglePlay: () => this.setState(s => ({ running: !s.running, manual: false }), () => this.schedule()),
      stop: () => this.setState({ running: false, done: 0, typed: '' }, () => this.schedule()),
      toggleManual: () => this.setState(s => ({ manual: !s.manual, running: s.manual ? true : s.running }), () => this.schedule()),

      backlogOpen: st.backlog,
      screenOpen: !st.backlog,
      toggleBacklog: () => this.setState(s => ({ backlog: !s.backlog })),
      backlogHint: st.backlog ? 'close' : '12 queued',
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
      updates: UPDATES.map(u => ({
        time: u.time, desk: u.desk, text: u.text, flag: u.flag || '',
        flagStyle: {
          fontSize: '10.5px', letterSpacing: '0.12em', textTransform: 'uppercase', justifySelf: 'end',
          color: u.flag === 'Needs you' ? 'var(--color-accent-700)' : 'color-mix(in srgb, var(--color-text) 45%, transparent)'
        }
      })),

      liveFrame: !!frameSrc,
      showMock: !frameSrc,
      frameSrc,
      manual: st.manual,
      liveDotStyle: Object.assign(dot('var(--color-accent)'), st.running && !st.manual ? { animation: 'op-pulse 1.8s ease-in-out infinite' } : {}),

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

      stepCounter: 'Step ' + Math.min(st.done + 1, STEPS.length) + ' / ' + STEPS.length,
      stepText: st.done >= STEPS.length ? 'Task complete — 1 record updated' : step.text,
      stepCall: st.manual ? 'agent paused — you have the screen' : (st.running ? step.call : 'paused')
    };
  }
}

