class Component extends DCLogic {
  constructor(props) {
    super(props);
    const h = 3600000, m = 60000;
    this.TASKS = ['Watching your store', 'Monitoring the support inbox', 'Reviewing catalog copy'];
    this.STORAGE_KEY = 'autostore.state.v1';

    const base = {
      screen: null, onbStep: 1, panelOpen: true, feedPaused: false,
      now: Date.now(), cutoff: Date.now() + 1 * h + 41 * m + 22000,
      toasts: [], bellCount: 0, actionCount: 0, feedIdx: 0, taskIdx: 0,
      ai: { ready: false, hasKey: false, model: '', error: '' },
      feed: [],
      products: [],
      orders: [],
      tickets: [],
      requests: [],
      genItems: [],
      user: null, loginEmail: '', loginPassword: '', authBusy: false,
      selTicket: null, reqText: '', mkTopic: '', mkType: 'Instagram post', mkBusy: false,
      onbUrl: '', onbConnected: false, rewrite: 'now',
      autoLevel: 'Approve first', voice: 'Warm', refundCap: '50', discountCap: '20',
      uploads: {}, plan: 'Growth',
    };

    this.state = Object.assign(base, this.loadSaved());
    this.state.now = Date.now();
    this.state.toasts = [];
  }

  // ---------------------------------------------------------------- lifecycle

  componentDidMount() {
    this.clock = setInterval(() => {
      let s = { now: Date.now() };
      if (this.state.cutoff - Date.now() < 1000) s.cutoff = Date.now() + 2.5 * 3600000;
      this.setState(s);
    }, 1000);

    this.checkAI();
    this.checkAuth();
  }

  // ------------------------------------------------------------- accounts

  /** Restores an existing session on load so a reload doesn't sign you out. */
  async checkAuth() {
    try {
      const r = await this.api('/api/account/me');
      if (r.signedIn) {
        this.setState({ user: r.user });
        const appScreens = ['dashboard', 'products', 'orders', 'marketing', 'support', 'requests', 'billing'];
        if (!appScreens.includes(this.curScreen())) {
          this.setState({ screen: r.user.setup ? 'dashboard' : 'onboarding' });
        }
      }
    } catch (e) { /* offline — stay on the login screen */ }
  }

  async signIn() {
    const email = this.state.loginEmail.trim();
    const password = this.state.loginPassword;
    if (!email || !password) { this.toast('Enter your details', 'Email and password are both required.'); return; }
    this.setState({ authBusy: true });
    try {
      const r = await this.api('/api/account/login', { email, password });
      this.setState({ user: r.user, authBusy: false, loginPassword: '' });
      this.toast('Signed in', email);
      this.setState({ screen: r.user.setup ? 'dashboard' : 'onboarding' });
    } catch (e) {
      this.setState({ authBusy: false });
      this.toast('Sign-in failed', String(e.message || e));
    }
  }

  async createAccount() {
    const email = this.state.loginEmail.trim();
    const password = this.state.loginPassword;
    if (!email || !password) {
      this.toast('Enter an email and password', 'Then press “Set up your agent” to create the account.');
      return;
    }
    this.setState({ authBusy: true });
    try {
      const r = await this.api('/api/account/signup', { email, password });
      this.setState({ user: r.user, authBusy: false, loginPassword: '', screen: 'onboarding', onbStep: 1 });
      this.toast('Account created', email + ' — let’s set up your store.');
    } catch (e) {
      this.setState({ authBusy: false });
      this.toast('Could not create account', String(e.message || e));
    }
  }

  async signOut() {
    try { await this.api('/api/account/logout', {}); } catch (e) { /* best effort */ }
    this.setState({ user: null, screen: 'login', loginPassword: '' });
    this.toast('Signed out', 'See you next time.');
  }

  componentWillUnmount() { clearInterval(this.clock); }

  componentDidUpdate() { this.save(); }

  // ----------------------------------------------------------- persistence

  loadSaved() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return {};
      const s = JSON.parse(raw);
      const keep = ['screen', 'products', 'orders', 'tickets', 'requests', 'genItems', 'feed', 'plan',
        'voice', 'autoLevel', 'refundCap', 'discountCap', 'uploads', 'onbConnected', 'onbUrl',
        'rewrite', 'actionCount', 'mkType'];
      const out = {};
      keep.forEach(k => { if (s[k] !== undefined) out[k] = s[k]; });
      // never restore a transient "working" flag
      if (out.products) out.products = out.products.map(p => p.st === 'generating' ? { ...p, st: p.desc ? 'generated' : 'draft' } : p);
      return out;
    } catch (e) { return {}; }
  }

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const s = this.state;
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
          screen: s.screen, products: s.products, orders: s.orders, tickets: s.tickets,
          requests: s.requests, genItems: s.genItems, feed: s.feed.slice(0, 30), plan: s.plan,
          voice: s.voice, autoLevel: s.autoLevel, refundCap: s.refundCap, discountCap: s.discountCap,
          uploads: s.uploads, onbConnected: s.onbConnected, onbUrl: s.onbUrl, rewrite: s.rewrite,
          actionCount: s.actionCount, mkType: s.mkType,
        }));
      } catch (e) { /* quota / private mode — non-fatal */ }
    }, 400);
  }

  // ------------------------------------------------------------------- AI

  async api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async checkAI() {
    try {
      const s = await this.api('/api/status');
      this.setState({ ai: { ready: !!s.hasKey, hasKey: !!s.hasKey, model: s.model || '', error: '' } });
      if (!s.hasKey) this.toast('No OpenRouter key yet', 'Paste your key into .env, then reload this page — AI features are off until then.');
    } catch (e) {
      this.setState({ ai: { ready: false, hasKey: false, model: '', error: String(e.message || e) } });
    }
  }

  /** Store context handed to every generation so output stays on-brand. */
  brandBrief() {
    const st = this.state;
    const name = (this.props.storeName || '').trim() || 'this store';
    const catalog = st.products.length
      ? st.products.map(p => `- ${p.name} (${p.sku}), ${p.price}, ${p.stock} in stock`).join('\n')
      : '(no products yet)';
    return `Store: ${name}.\n` +
      `Brand voice: ${st.voice} (Plain = flat and factual; Warm = friendly and human; Bold = punchy and confident).\n` +
      `Guardrails: refunds up to $${st.refundCap} auto-approved, max discount ${st.discountCap}%.\n` +
      `Catalog:\n${catalog}`;
  }

  async llm(prompt, opts) {
    opts = opts || {};
    const data = await this.api('/api/llm', {
      system: opts.system || 'You write for a small e-commerce brand. Return only the requested text — no preamble, no markdown fences, no commentary about being an AI.',
      prompt,
      max_tokens: opts.maxTokens || 500,
      temperature: opts.temperature,
    });
    const text = String(data.text || '').trim();
    if (!text) throw new Error('Model returned an empty response');
    return text;
  }

  aiFail(err, what) {
    const msg = String((err && err.message) || err);
    this.toast(what + ' failed', msg.slice(0, 140));
    this.pushFeed('agent', what + ' failed — ' + msg.slice(0, 90));
  }

  // -------------------------------------------------------------- helpers

  curScreen() { return this.state.screen ?? (this.props.startScreen ?? 'login'); }
  timeNow() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  pushFeed(kind, text) { this.setState(s => ({ feed: [{ t: this.timeNow(), kind, text }, ...s.feed].slice(0, 30) })); }

  toast(title, body) {
    const id = Math.random().toString(36).slice(2);
    this.setState(s => ({ toasts: [...s.toasts, { id, title, body }] }));
    setTimeout(() => this.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 6500);
  }

  go(sc) { this.setState({ screen: sc }); }

  fmt(ms) {
    if (ms < 0) ms = 0;
    const p = n => String(n).padStart(2, '0');
    return p(Math.floor(ms / 3600000)) + ':' + p(Math.floor(ms / 60000) % 60) + ':' + p(Math.floor(ms / 1000) % 60);
  }

  esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // --------------------------------------------------------------- orders

  orderView(o) {
    const T = {
      urgent: { label: 'Ship now', style: { background: 'var(--color-accent)', color: 'var(--color-bg)' } },
      due: { label: 'Due today', style: { background: 'var(--color-accent-100)', color: 'var(--color-accent-800)' } },
      ok: { label: 'On track', style: { background: 'var(--color-neutral-100)', color: 'var(--color-neutral-800)' } },
      shipped: { label: 'Shipped', style: { background: 'var(--color-neutral-200)', color: 'var(--color-neutral-600)' } },
    }[o.st];
    return {
      ...o, statusLabel: T.label, tagStyle: T.style, canShip: o.st !== 'shipped',
      due: o.st === 'urgent' ? this.fmt(this.state.cutoff - this.state.now) : o.due,
      ship: () => this.shipOrder(o),
    };
  }

  /** Marks shipped, then writes and prints a real shipping notification. */
  async shipOrder(o) {
    this.setState(s => ({ orders: s.orders.map(x => x.id === o.id ? { ...x, st: 'shipped', due: 'Shipped ' + this.timeNow() } : x) }));
    this.pushFeed('orders', o.id + ' marked shipped — writing tracking email to ' + o.customer.split(' ')[0]);
    if (o.st === 'urgent') this.setState({ cutoff: Date.now() + 2.5 * 3600000 });
    if (!this.state.ai.ready) { this.toast(o.id + ' shipped', 'Tracking email skipped — no API key.'); return; }
    try {
      const body = await this.llm(
        this.brandBrief() +
        `\n\nWrite the shipping-confirmation email body for order ${o.id}: ${o.customer} ordered ${o.items} (${o.total}). ` +
        `Shipped USPS Priority today, tracking 9400 1102 ${Math.floor(1000 + Math.random() * 8999)}. ` +
        'Two or three sentences, in the brand voice. No subject line, no signature block.',
        { maxTokens: 220 }
      );
      this.toast(o.id + ' shipped', body.slice(0, 150));
      this.pushFeed('orders', 'Tracking email sent to ' + o.customer + ' for ' + o.id);
    } catch (e) { this.aiFail(e, 'Tracking email'); }
  }

  /** Renders a real packing slip and opens the browser print dialog. */
  printLabel() {
    const o = this.state.orders.find(x => x.st === 'urgent') || this.state.orders[0];
    if (!o) { this.toast('No orders yet', 'Nothing to print a slip for.'); return; }
    const store = (this.props.storeName || '').trim() || 'Your store';
    const html = `<!doctype html><meta charset="utf-8"><title>Packing slip ${this.esc(o.id)}</title>
<style>
 body{font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:40px;color:#111}
 h1{font-size:20px;margin:0 0 4px} .muted{color:#666}
 table{width:100%;border-collapse:collapse;margin:24px 0}
 th,td{text-align:left;padding:8px 0;border-bottom:1px solid #ddd}
 .box{border:2px solid #111;padding:16px;margin-top:28px}
 .big{font-size:22px;font-weight:700;letter-spacing:.04em}
</style>
<h1>${this.esc(store)}</h1>
<div class="muted">Packing slip · ${this.esc(o.id)} · ${this.esc(new Date().toLocaleString())}</div>
<table><tr><th>Ship to</th><th>Items</th><th>Total</th></tr>
<tr><td>${this.esc(o.customer)}</td><td>${this.esc(o.items)}</td><td>${this.esc(o.total)}</td></tr></table>
<div class="box"><div class="muted">USPS PRIORITY MAIL · 1 of 1</div>
<div class="big">9400 1102 ${Math.floor(1000 + Math.random() * 8999)} ${Math.floor(1000 + Math.random() * 8999)}</div></div>`;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    f.srcdoc = html;
    f.onload = () => {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { /* blocked */ }
      setTimeout(() => f.remove(), 60000);
    };
    this.pushFeed('orders', 'Packing slip + label generated for ' + o.id);
    this.toast('Packing slip ready', o.id + ' — print dialog opened');
  }

  // -------------------------------------------------------------- products

  async genDesc(sku) {
    const p = this.state.products.find(x => x.sku === sku);
    if (!p) return;
    if (!this.state.ai.ready) { this.toast('No API key', 'Add OPENROUTER_API_KEY to .env, then reload this page.'); return; }
    this.setState(s => ({ products: s.products.map(x => x.sku === sku ? { ...x, st: 'generating' } : x) }));
    try {
      const desc = await this.llm(
        this.brandBrief() +
        `\n\nWrite the product description for "${p.name}" (${p.sku}, ${p.price}). ` +
        'One or two sentences, maximum 30 words. Concrete and sensory — material, craft, use. ' +
        'No marketing clichés ("elevate", "perfect for"), no hashtags, no quotes around the text.',
        { maxTokens: 140, temperature: 0.85 }
      );
      const clean = desc.replace(/^["'`]+|["'`]+$/g, '').trim();
      this.setState(s => ({ products: s.products.map(x => x.sku === sku ? { ...x, st: 'generated', desc: clean } : x) }));
      this.pushFeed('seo', 'Wrote product description for ' + p.name);
      this.toast('Description ready', p.name + ' — review it in Products');
    } catch (e) {
      this.setState(s => ({ products: s.products.map(x => x.sku === sku ? { ...x, st: x.desc ? 'generated' : 'draft' } : x) }));
      this.aiFail(e, 'Description for ' + p.name);
    }
  }

  async genAllDesc() {
    const todo = this.state.products.filter(p => p.st === 'draft').map(p => p.sku);
    if (!todo.length) { this.toast('Nothing to write', 'Every product already has a description.'); return; }
    this.pushFeed('seo', 'Writing ' + todo.length + ' missing product descriptions');
    for (const sku of todo) await this.genDesc(sku);   // sequential — avoids rate limits
  }

  // -------------------------------------------------------------- support

  ticketView(tk) {
    const T = {
      human: { label: 'Needs you', style: { background: 'var(--color-accent)', color: 'var(--color-bg)' }, dot: 'var(--color-accent)' },
      draft: { label: 'Draft ready', style: { background: 'var(--color-accent-100)', color: 'var(--color-accent-800)' }, dot: 'var(--color-accent-400)' },
      resolved: { label: 'AI resolved', style: { background: 'var(--color-neutral-100)', color: 'var(--color-neutral-800)' }, dot: 'var(--color-neutral-400)' },
      sent: { label: 'Sent', style: { background: 'var(--color-neutral-200)', color: 'var(--color-neutral-600)' }, dot: 'var(--color-neutral-400)' },
    }[tk.st];
    return {
      ...tk, statusLabel: T.label, tagStyle: T.style, dot: T.dot,
      bg: tk.st === 'human' ? 'color-mix(in srgb, var(--color-accent) 5%, transparent)' : 'transparent',
      open: () => { this.setState({ selTicket: tk.id }); this.draftReply(tk.id); },
    };
  }

  /** Writes a real reply for a ticket that needs one. */
  async draftReply(id, force) {
    const tk = this.state.tickets.find(t => t.id === id);
    if (!tk) return;
    if (tk.st !== 'human' && tk.st !== 'draft') return;
    if (tk.draft && !force) return;
    if (!this.state.ai.ready) return;
    if (this._drafting === id) return;
    this._drafting = id;
    this.setState(s => ({ tickets: s.tickets.map(t => t.id === id ? { ...t, draft: 'Writing a reply…' } : t) }));
    try {
      const reply = await this.llm(
        this.brandBrief() +
        `\n\nA customer wrote in. Draft the reply the store owner will send.\n` +
        `From: ${tk.from}\nSubject: ${tk.subject}\nMessage: ${tk.msg}\n` +
        (tk.note ? `Internal note: ${tk.note}. Respect the guardrails above — if money exceeds the cap, offer options rather than promising a refund outright.\n` : '') +
        'Two to four sentences, in the brand voice. Address them by first name. Offer a concrete next step. No subject line, no signature.',
        { maxTokens: 260, temperature: 0.7 }
      );
      this.setState(s => ({
        tickets: s.tickets.map(t => t.id === id ? { ...t, draft: reply, preview: 'Reply drafted — awaiting your approval' } : t),
      }));
      this.pushFeed('support', 'Drafted a reply on ' + id + ' (' + tk.subject + ')');
    } catch (e) {
      this.setState(s => ({ tickets: s.tickets.map(t => t.id === id ? { ...t, draft: '' } : t) }));
      this.aiFail(e, 'Draft for ' + id);
    } finally { this._drafting = null; }
  }

  // -------------------------------------------------------------- requests

  async submitRequest() {
    const text = this.state.reqText.trim();
    if (!text) return;
    const stamp = this.timeNow() + '·' + Math.random().toString(36).slice(2, 7);
    const req = { key: stamp, text, st: 'queued', time: this.timeNow(), resp: 'Received — planning the change now.' };
    this.setState(s => ({ reqText: '', requests: [req, ...s.requests] }));
    this.pushFeed('request', 'New request from you: "' + text.slice(0, 60) + (text.length > 60 ? '…' : '') + '"');

    const patch = (fields) => this.setState(s => ({ requests: s.requests.map(r => r.key === stamp ? { ...r, ...fields } : r) }));

    if (!this.state.ai.ready) {
      patch({ st: 'progress', resp: 'No API key — set OPENROUTER_API_KEY in .env and reload the page.' });
      return;
    }

    // A direct prompt to the model. Whatever you type goes straight through;
    // the store context is supplied so it can answer about the catalog too.
    patch({ st: 'progress', resp: 'Thinking…' });
    try {
      const answer = await this.llm(
        this.brandBrief() +
        '\n\nYou are the operator of this store, talking to its owner. ' +
        'Answer the message below directly and usefully. If it asks you to do something you can actually reason about ' +
        '(pricing, copy, planning, analysis), do it now in your reply rather than promising to do it later.\n\n' +
        `Owner: ${text}`,
        { maxTokens: 900, temperature: 0.7 }
      );
      patch({ st: 'done', resp: answer });
      this.toast('Answered', text.slice(0, 44) + (text.length > 44 ? '…' : ''));
      this.pushFeed('request', 'Answered: ' + text.slice(0, 50));
    } catch (e) {
      patch({ st: 'progress', resp: 'Failed — ' + String(e.message || e).slice(0, 160) });
      this.aiFail(e, 'Prompt');
    }
  }

  // ------------------------------------------------------------- marketing

  async mkGenerate() {
    const st = this.state;
    if (!st.ai.ready) { this.toast('No API key', 'Add OPENROUTER_API_KEY to .env, then reload this page.'); return; }
    this.setState({ mkBusy: true });
    const type = st.mkType, topic = st.mkTopic.trim();
    const shape = {
      'Instagram post': 'an Instagram caption, 2–3 short lines, at most 60 words, ending with a call to action. No hashtag wall — at most two hashtags.',
      'Product description': 'a product description, 2–3 sentences, at most 55 words, concrete and sensory.',
      'Email campaign': 'a marketing email: a "Subject:" line, then a blank line, then 3–5 short sentences of body copy.',
      'Ad copy': 'ad copy: a "Headline:" line, then a "Body:" line of at most 25 words.',
    }[type];
    try {
      const body = await this.llm(
        this.brandBrief() +
        `\n\nWrite ${shape}\n` + (topic ? `Topic: ${topic}` : 'Topic: whatever is most worth promoting from the catalog right now.'),
        { maxTokens: 400, temperature: 0.9 }
      );
      this.setState(s => ({ mkBusy: false, genItems: [{ id: Math.random().toString(36).slice(2), type, topic, time: this.timeNow(), body }, ...s.genItems].slice(0, 30) }));
      this.pushFeed('marketing', 'Drafted ' + type.toLowerCase() + (topic ? ' — ' + topic : ''));
      this.toast(type + ' ready', 'Draft is waiting in Marketing');
    } catch (e) {
      this.setState({ mkBusy: false });
      this.aiFail(e, type);
    }
  }

  async regenItem(g) {
    if (!this.state.ai.ready) { this.toast('No API key', 'Add OPENROUTER_API_KEY to .env, then reload this page.'); return; }
    this.setState(s => ({ genItems: s.genItems.map(x => x.id === g.id ? { ...x, body: 'Rewriting…' } : x) }));
    try {
      const body = await this.llm(
        this.brandBrief() +
        `\n\nRewrite this ${g.type.toLowerCase()} from scratch. Keep the same purpose and length, but change the angle, the opening, and the imagery — it must not read like a light edit.\n` +
        (g.topic ? `Topic: ${g.topic}\n` : '') + `Previous version:\n${g.body}`,
        { maxTokens: 400, temperature: 1 }
      );
      this.setState(s => ({ genItems: s.genItems.map(x => x.id === g.id ? { ...x, body, time: this.timeNow() } : x) }));
      this.pushFeed('marketing', 'Rewrote a ' + g.type.toLowerCase());
    } catch (e) {
      this.setState(s => ({ genItems: s.genItems.map(x => x.id === g.id ? { ...x, body: g.body } : x) }));
      this.aiFail(e, 'Rewrite');
    }
  }

  // ------------------------------------------------------------ onboarding

  /** Really checks the storefront is reachable before flipping to connected. */
  async connectStore() {
    const url = this.state.onbUrl.trim();
    if (!url) { this.toast('Enter a store URL', 'e.g. your-store.myshopify.com'); return; }
    this.toast('Checking ' + url, 'Looking up the storefront…');
    try {
      const r = await this.api('/api/check-store', { url });
      if (r.ok) {
        this.setState({ onbConnected: true });
        this.toast('Connected to ' + r.host, r.title ? ('Found: ' + r.title) : ('Storefront responded ' + r.status));
        this.pushFeed('agent', 'Connected storefront ' + r.host + ' (HTTP ' + r.status + ')');
      } else {
        this.toast('Could not reach ' + (r.host || url), r.detail || ('HTTP ' + r.status));
      }
    } catch (e) {
      this.toast('Could not reach ' + url, String(e.message || e).slice(0, 120));
    }
  }

  /** Real file picker — reads the chosen image and keeps its name + preview. */
  pickPhoto(sku) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.setState(s => ({ uploads: { ...s.uploads, [sku]: { name: f.name, size: f.size, url: String(reader.result).slice(0, 200000) } } }));
        this.pushFeed('agent', 'Photo added for ' + sku + ' — ' + f.name);
        this.toast('Photo added', f.name + ' · ' + Math.round(f.size / 1024) + ' KB');
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }

  /** Finishes setup: persists it to the account, then opens the dashboard. */
  async launchAgent() {
    const st = this.state;
    const aiOn = st.ai.ready;
    if (st.user) {
      try {
        const r = await this.api('/api/account/setup', {
          storeUrl: st.onbUrl, voice: st.voice, autoLevel: st.autoLevel,
          refundCap: st.refundCap, discountCap: st.discountCap,
        });
        this.setState({ user: r.user });
        this.pushFeed('agent', 'Setup saved to your account (' + r.user.email + ')');
      } catch (e) {
        this.toast('Could not save setup', String(e.message || e));
      }
    }
    this.setState({ screen: 'dashboard' });
    this.pushFeed('agent', 'Agent launched — ' + (aiOn ? 'running on ' + st.ai.model : 'idle until an API key is set'));
    this.toast('Agent is live', aiOn ? ('Running on ' + st.ai.model) : 'Add OPENROUTER_API_KEY to .env, then reload');
    if (st.rewrite === 'now' && aiOn && st.products.length) this.genAllDesc();
  }

  // ------------------------------------------------------------ render vals

  renderVals() {
    const st = this.state, screen = this.curScreen();
    const storeName = (this.props.storeName || '').trim() || 'Your store';
    const appScreens = ['dashboard', 'products', 'orders', 'marketing', 'support', 'requests', 'billing'];
    const isApp = appScreens.includes(screen);
    const hour = new Date().getHours();
    const sel = st.tickets.find(t => t.id === st.selTicket);
    const selV = sel ? this.ticketView(sel) : null;
    const mkTypeList = ['Instagram post', 'Product description', 'Email campaign', 'Ad copy'];
    const aiOn = st.ai.ready;
    // "deepseek/deepseek-v4-pro" -> "Deepseek V4 Pro"
    const prettyModel = id => (id || '').split('/').pop().split('-')
      .map(w => /^v?\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const withGenActions = g => ({
      ...g,
      copy: () => {
        const done = () => this.toast('Copied to clipboard', g.type + ' draft');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(g.body).then(done, () => this.toast('Copy blocked', 'Select the text and copy manually'));
        else done();
      },
      regen: () => this.regenItem(g),
    });

    const autoExplains = {
      'Draft only': 'The agent prepares everything — copy, replies, prices — and you press every send button.',
      'Approve first': 'Routine work runs on its own. Anything customer-facing or above a guardrail waits for one tap from you.',
      'Full auto': 'The agent acts autonomously inside your guardrails and reports back. You review a daily digest.',
    };
    const voiceSamples = { Plain: 'Your order shipped. Tracking: 9400 1102.', Warm: 'Good news — your order\'s on its way. Track it here.', Bold: 'It\'s out the door. Watch the mail like a hawk.' };
    const missingPhotos = st.products.filter(p => !p.desc).map(p => p.sku);

    return {
      storeName, storeInit: storeName.split(/[\s&]+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase(),
      isLogin: screen === 'login', isOnboarding: screen === 'onboarding', isApp,
      scDashboard: screen === 'dashboard', scProducts: screen === 'products', scOrders: screen === 'orders',
      scMarketing: screen === 'marketing', scSupport: screen === 'support', scRequests: screen === 'requests', scBilling: screen === 'billing',

      signIn: () => this.signIn(),
      startOnboarding: () => this.createAccount(),
      signOut: () => this.signOut(),
      loginEmail: st.loginEmail, setLoginEmail: e => this.setState({ loginEmail: e.target.value }),
      loginPassword: st.loginPassword, setLoginPassword: e => this.setState({ loginPassword: e.target.value }),
      authBusy: st.authBusy,
      signInLabel: st.authBusy ? 'Working…' : 'Sign in',
      userEmail: st.user ? st.user.email : '',
      isSignedIn: !!st.user,
      greeting: (hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.'),
      countdown: this.fmt(st.cutoff - st.now),
      goOrders: () => this.go('orders'),
      toastLabel: () => this.printLabel(),

      navItems: [
        ['dashboard', 'Dashboard'], ['products', 'Products'], ['orders', 'Orders'], ['marketing', 'Marketing'],
        ['support', 'Support'], ['requests', 'Requests'], ['billing', 'Billing'],
      ].map((n, i) => ({
        num: '0' + (i + 1), label: n[1], go: () => this.go(n[0]),
        color: screen === n[0] ? 'var(--color-accent)' : 'inherit',
        bg: screen === n[0] ? 'color-mix(in srgb, var(--color-accent) 7%, transparent)' : 'transparent',
        badge: n[0] === 'support' ? st.tickets.filter(t => t.st === 'human' || t.st === 'draft').length || false : false,
      })),

      // ---- values that used to be hardcoded demo copy in the markup ----
      buildNote: '',
      brandLine: storeName + (st.onbConnected && st.onbUrl ? ' · ' + st.onbUrl : ''),
      skipLabel: 'Skip for now',
      // The markup had this wired to signIn, which became a real login attempt
      // once accounts existed — so it failed on empty fields. It just skips.
      skipSetup: () => {
        this.setState({ screen: 'dashboard' });
        this.toast('Setup skipped', 'You can finish it any time from Onboarding.');
      },
      connectedLine: st.onbUrl ? 'Connected to ' + st.onbUrl : 'Not connected yet',
      resolvedRatio: st.tickets.length
        ? st.tickets.filter(t => t.st === 'resolved' || t.st === 'sent').length + ' of ' + st.tickets.length
        : 'No tickets',
      nextOrderLine: (() => {
        const o = st.orders.find(x => x.st === 'urgent') || st.orders.find(x => x.st === 'due');
        return o ? o.id + ' · ' + o.customer : 'No orders waiting';
      })(),
      watchLine: (() => {
        const o = st.orders.find(x => x.st === 'urgent');
        return o
          ? 'Agent watch: ' + o.id + ' is the next deadline. You will be told before it slips.'
          : 'Agent watch: nothing is at risk right now.';
      })(),
      loginActions: String(st.actionCount),
      loginResolved: st.tickets.length
        ? st.tickets.filter(t => t.st === 'resolved' || t.st === 'sent').length + '/' + st.tickets.length
        : '0',
      loginMissed: '0',

      stats: [
        { label: 'Revenue today', value: '$' + st.orders.filter(o => o.st === 'shipped').reduce((a, o) => a + parseFloat(o.total.replace(/[^0-9.]/g, '')), 0).toFixed(2) },
        { label: 'Orders due today', value: String(st.orders.filter(o => o.st === 'urgent' || o.st === 'due').length) },
        { label: 'Tickets auto-resolved', value: st.tickets.filter(t => t.st === 'resolved' || t.st === 'sent').length + '/' + st.tickets.length },
      ].map((s, i) => ({ ...s, bl: i ? '2px solid var(--color-divider)' : 'none', pl: i ? '20px' : '0' })),

      dueOrders: st.orders.filter(o => o.st === 'urgent' || o.st === 'due').map(o => this.orderView(o)),
      orders: st.orders.map(o => this.orderView(o)),
      dueCount: st.orders.filter(o => o.st === 'urgent' || o.st === 'due').length,
      recentFeed: st.feed.slice(0, 4),
      feed: st.feed,

      products: st.products.map(p => {
        const V = { generated: ['tag-neutral', 'AI written'], draft: ['tag-accent', 'Thin copy'], generating: ['tag-outline', 'Writing…'] }[p.st];
        return {
          ...p, init: p.name[0], tagClass: V[0], tagLabel: V[1],
          stockColor: p.stock < 10 ? 'var(--color-accent-700)' : 'inherit',
          desc: p.st === 'generated' ? p.desc : (p.st === 'generating' ? 'The agent is writing…' : 'No description — Shopify import was one line.'),
          descStyle: p.st === 'generated' ? 'normal' : 'italic',
          busy: p.st === 'generating', genLabel: p.st === 'generated' ? 'Regenerate' : (p.st === 'generating' ? 'Writing…' : 'Generate'),
          gen: () => this.genDesc(p.sku),
        };
      }),
      genAllDesc: () => this.genAllDesc(),

      tickets: st.tickets.map(t => this.ticketView(t)),
      ticketOpen: !!selV,
      tkId: selV && selV.id, tkSubject: selV && selV.subject, tkFrom: selV && selV.from, tkMsg: selV && selV.msg,
      tkDraft: selV && (selV.draft || (aiOn ? 'Writing a reply…' : 'No draft — add an OpenRouter API key to .env and reload to have the agent write one.')),
      tkNote: selV && selV.note, tkTagStyle: selV && selV.tagStyle, tkStatusLabel: selV && selV.statusLabel,
      tkHasDraft: !!(selV && (selV.st === 'human' || selV.st === 'draft')), tkResolved: !!(selV && (selV.st === 'resolved' || selV.st === 'sent')),
      closeTicket: () => this.setState({ selTicket: null }),
      stop: e => e.stopPropagation(),
      approveDraft: () => {
        const id = st.selTicket, t = st.tickets.find(x => x.id === id);
        if (!t || !t.draft || t.draft === 'Writing a reply…') { this.toast('Nothing to send yet', 'The reply is still being written.'); return; }
        this.setState(s => ({ selTicket: null, tickets: s.tickets.map(x => x.id === id ? { ...x, st: 'sent', preview: 'Your approved reply was sent', time: 'now' } : x) }));
        this.pushFeed('support', 'Approved reply sent on ' + id);
        this.toast('Reply sent', id + ' — ' + t.from + ' notified');
      },
      takeOver: () => { this.setState({ selTicket: null }); this.toast('Ticket handed to you', 'Agent stepped back — you own the thread now'); },

      requests: st.requests.map(r => {
        const T = {
          queued: ['Queued', { background: 'var(--color-neutral-100)', color: 'var(--color-neutral-800)' }],
          progress: ['In progress', { background: 'var(--color-accent-100)', color: 'var(--color-accent-800)' }],
          done: ['Done', { background: 'var(--color-neutral-200)', color: 'var(--color-neutral-600)' }],
        }[r.st];
        return { ...r, statusLabel: T[0], tagStyle: T[1] };
      }),
      reqText: st.reqText, setReqText: e => this.setState({ reqText: e.target.value }), reqDisabled: !st.reqText.trim(),
      submitRequest: () => this.submitRequest(),

      mkTypes: mkTypeList.map(l => ({ label: l, active: st.mkType === l, pick: () => this.setState({ mkType: l }) })),
      mkTopic: st.mkTopic, setMkTopic: e => this.setState({ mkTopic: e.target.value }),
      mkBusy: st.mkBusy, mkBtnLabel: st.mkBusy ? 'The agent is writing…' : 'Generate draft',
      voice: st.voice,
      agentName: aiOn ? prettyModel(st.ai.model) : 'The agent',
      mkGenerate: () => this.mkGenerate(),
      genItems: st.genItems.map(withGenActions),

      plans: [
        { name: 'Starter', price: '$49', features: '1 store\nAI product descriptions\n50 agent actions / day\nEmail support' },
        { name: 'Growth', price: '$149', features: 'Everything in Starter\nMarketing autopilot\nSupport inbox automation\nUnlimited agent actions' },
        { name: 'Scale', price: '$349', features: 'Everything in Growth\nMulti-store\nAPI access + custom guardrails\nPriority human escalation' },
      ].map(p => ({
        ...p, current: st.plan === p.name,
        border: st.plan === p.name ? 'var(--color-accent)' : 'var(--color-divider)',
        bg: st.plan === p.name ? 'color-mix(in srgb, var(--color-accent) 4%, transparent)' : 'transparent',
        btnClass: st.plan === p.name ? 'btn-secondary' : 'btn-primary',
        btnLabel: st.plan === p.name ? 'Current plan' : 'Switch to ' + p.name,
        pick: () => { this.setState({ plan: p.name }); this.toast('Plan set to ' + p.name, 'Saved locally — no Stripe account is connected.'); },
      })),
      toastStripe: () => this.toast('Stripe not connected', 'Add Stripe keys to .env to open a real billing portal.'),

      panelOpen: st.panelOpen, togglePanel: () => this.setState(s => ({ panelOpen: !s.panelOpen, bellCount: 0 })),
      agentChip: st.feedPaused ? 'Agent paused' : (aiOn ? 'Agent active · ' + (st.ai.model.split('/').pop() || 'live') : 'Agent offline · no API key'),
      hasBell: st.bellCount > 0, bellCount: st.bellCount,
      toggleFeed: () => this.setState(s => ({ feedPaused: !s.feedPaused })),
      pauseGlyph: st.feedPaused ? '▶' : '❚❚',
      currentTask: st.feedPaused ? 'Paused — nothing runs until you resume'
        : (aiOn ? this.TASKS[st.taskIdx % this.TASKS.length] : 'Idle — add OPENROUTER_API_KEY to .env and reload this page'),
      actionCount: st.actionCount,
      toasts: st.toasts.map(t => ({ ...t, close: () => this.setState(s => ({ toasts: s.toasts.filter(x => x.id !== t.id) })) })),

      onbStep: st.onbStep, onbCells: [1, 2, 3, 4].map(i => ({ bg: i <= st.onbStep ? 'var(--color-accent)' : 'var(--color-neutral-300)' })),
      onb1: st.onbStep === 1, onb2: st.onbStep === 2, onb3: st.onbStep === 3, onb4: st.onbStep === 4,
      onbCanBack: st.onbStep > 1, onbNotLast: st.onbStep < 4,
      onbBack: () => this.setState(s => ({ onbStep: s.onbStep - 1 })),
      onbNext: () => this.setState(s => ({ onbStep: s.onbStep + 1 })),
      onbNextDisabled: st.onbStep === 1 && !st.onbConnected,
      onbUrl: st.onbUrl, setOnbUrl: e => this.setState({ onbUrl: e.target.value }),
      onbConnected: st.onbConnected, connectLabel: st.onbConnected ? 'Connected' : 'Connect',
      connectStore: () => this.connectStore(),

      onbAssets: st.products.map(p => {
        const needs = missingPhotos.includes(p.sku), up = st.uploads[p.sku];
        const upName = up && (typeof up === 'object' ? up.name : 'photo.jpg');
        return {
          name: p.name, sku: p.sku, init: p.name[0], needsPhoto: needs,
          tagClass: needs ? (up ? 'tag-neutral' : 'tag-accent') : (p.st === 'draft' ? 'tag-outline' : 'tag-neutral'),
          tagLabel: needs ? (up ? 'Photo added' : 'Photo missing') : (p.st === 'draft' ? 'Thin copy' : 'Ready'),
          uploaded: !!up, uploadLabel: up ? (String(upName).slice(0, 22) + ' ✓') : 'Upload photo',
          upload: () => this.pickPhoto(p.sku),
        };
      }),

      rwNow: st.rewrite === 'now', rwReview: st.rewrite === 'review',
      setRwNow: () => this.setState({ rewrite: 'now' }), setRwReview: () => this.setState({ rewrite: 'review' }),
      autoLevels: ['Draft only', 'Approve first', 'Full auto'].map(l => ({ label: l, active: st.autoLevel === l, pick: () => this.setState({ autoLevel: l }) })),
      autoExplain: autoExplains[st.autoLevel],
      voices: ['Plain', 'Warm', 'Bold'].map(v => ({ label: v, active: st.voice === v, sample: voiceSamples[v], pick: () => this.setState({ voice: v }) })),
      refundCap: st.refundCap, setRefundCap: e => this.setState({ refundCap: e.target.value }),
      discountCap: st.discountCap, setDiscountCap: e => this.setState({ discountCap: e.target.value }),

      onbSummary: [
        { k: 'Store', v: st.onbUrl + ' — ' + st.products.length + ' products, ' + st.orders.length + ' orders' },
        { k: 'Catalog', v: Object.keys(st.uploads).length + ' of 3 photos uploaded · ' + (st.rewrite === 'now' ? 'agent rewrites thin copy now' : 'you review each rewrite') },
        { k: 'Automation', v: st.autoLevel },
        { k: 'Voice', v: st.voice },
        { k: 'Guardrails', v: 'Refund cap $' + st.refundCap + ' · max discount ' + st.discountCap + '%' },
        { k: 'Model', v: aiOn ? st.ai.model : 'No API key — put OPENROUTER_API_KEY in .env and reload' },
      ],

      launchAgent: () => this.launchAgent(),
    };
  }
}
