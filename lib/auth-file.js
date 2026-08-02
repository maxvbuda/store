/**
 * Accounts + the shared-password gate — the flat-file store.
 *
 * This is the fallback lib/auth.js uses when Supabase is not configured:
 * zero-setup local dev, same API surface. On a platform with an ephemeral
 * filesystem (Render without a disk) accounts vanish on redeploy — configure
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY there instead.
 *
 * Accounts are stored in .data/users.json. That's deliberate for a single-box
 * deploy and it is NOT durable on Render's ephemeral filesystem — set
 * DATA_DIR to a mounted disk, or move to Postgres, before real signups matter.
 *
 * Passwords: scrypt with a per-user random salt. Sessions: random 32-byte token
 * in an HttpOnly cookie, compared in constant time.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE = 'as_session';
const GATE_COOKIE = 'as_gate';
const DAY = 86400;

// ------------------------------------------------------------- utilities

function timingEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(name, value, req, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (isHttps(req) ? '; Secure' : '');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// ------------------------------------------------------------------ store

function createStore(dataDir) {
  const file = path.join(dataDir, 'users.json');
  let db = { users: [], sessions: {} };

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[auth] could not read ' + file + ': ' + e.message);
  }
  db.users = db.users || [];
  db.sessions = db.sessions || {};

  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(db, null, 2)); }
      catch (e) { console.warn('[auth] save failed: ' + e.message); }
    }, 200);
  };

  return {
    file,
    count: () => db.users.length,
    findByEmail: (email) => db.users.find(u => u.email === String(email).trim().toLowerCase()),
    findById: (id) => db.users.find(u => u.id === id),
    addUser(email, password) {
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: 'u_' + crypto.randomBytes(9).toString('hex'),
        email: String(email).trim().toLowerCase(),
        salt,
        hash: hashPassword(password, salt),
        createdAt: new Date().toISOString(),
        setup: null,
      };
      db.users.push(user);
      flush();
      return user;
    },
    saveSetup(userId, setup) {
      const u = db.users.find(x => x.id === userId);
      if (u) { u.setup = setup; flush(); }
      return u;
    },
    newSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[token] = { userId, createdAt: Date.now() };
      flush();
      return token;
    },
    userForToken(token) {
      if (!token) return null;
      const s = db.sessions[token];
      if (!s) return null;
      return db.users.find(u => u.id === s.userId) || null;
    },
    dropSession(token) { delete db.sessions[token]; flush(); },
  };
}

// ------------------------------------------------------------------ module

function create(env, send, readBody) {
  const store = createStore(env('DATA_DIR', path.join(__dirname, '..', '.data')));

  const gatePassword = () => env('APP_PASSWORD', '');
  const gateToken = () =>
    crypto.createHmac('sha256', gatePassword()).update('unlock-v1').digest('hex');

  const isUnlocked = (req) =>
    !gatePassword() || timingEq(cookieValue(req, GATE_COOKIE), gateToken());

  const currentUser = (req) => store.userForToken(cookieValue(req, SESSION_COOKIE));

  const publicUser = (u) => u && {
    id: u.id, email: u.email, createdAt: u.createdAt, setup: u.setup || null,
  };

  /** Returns true if it handled the request. */
  async function handle(req, res, url) {
    const p = url.pathname;

    // ---- gate ----------------------------------------------------------
    if (p === '/api/unlock' && req.method === 'POST') {
      if (!gatePassword()) return send(res, 200, { ok: true, gate: 'disabled' }), true;
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: String(e.message) }), true; }
      if (!timingEq(String(body.password || ''), gatePassword())) {
        return send(res, 401, { error: 'incorrect password' }), true;
      }
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(GATE_COOKIE, gateToken(), req, 30 * DAY) });
      return true;
    }

    // ---- accounts ------------------------------------------------------
    if (p === '/api/account/signup' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: String(e.message) }), true; }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return send(res, 400, { error: 'Enter a valid email address.' }), true;
      }
      if (password.length < 8) {
        return send(res, 400, { error: 'Password must be at least 8 characters.' }), true;
      }
      if (store.findByEmail(email)) {
        return send(res, 409, { error: 'An account with that email already exists.' }), true;
      }
      const user = store.addUser(email, password);
      const token = store.newSession(user.id);
      console.log('[auth] signup ' + email);
      send(res, 200, { ok: true, user: publicUser(user) },
        { 'Set-Cookie': setCookie(SESSION_COOKIE, token, req, 30 * DAY) });
      return true;
    }

    if (p === '/api/account/login' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: String(e.message) }), true; }
      const email = String(body.email || '').trim().toLowerCase();
      const user = store.findByEmail(email);
      // Always hash, so a missing user and a wrong password cost the same.
      const candidate = hashPassword(String(body.password || ''), user ? user.salt : 'x'.repeat(32));
      if (!user || !timingEq(candidate, user.hash)) {
        return send(res, 401, { error: 'Wrong email or password.' }), true;
      }
      const token = store.newSession(user.id);
      console.log('[auth] login ' + email);
      send(res, 200, { ok: true, user: publicUser(user) },
        { 'Set-Cookie': setCookie(SESSION_COOKIE, token, req, 30 * DAY) });
      return true;
    }

    if (p === '/api/account/logout' && req.method === 'POST') {
      store.dropSession(cookieValue(req, SESSION_COOKIE));
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', req, 0) });
      return true;
    }

    if (p === '/api/account/me') {
      const u = currentUser(req);
      send(res, 200, { signedIn: !!u, user: publicUser(u), accounts: store.count() });
      return true;
    }

    if (p === '/api/account/setup' && req.method === 'POST') {
      const u = currentUser(req);
      if (!u) return send(res, 401, { error: 'Sign in first.' }), true;
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: String(e.message) }), true; }
      const saved = store.saveSetup(u.id, {
        storeUrl: String(body.storeUrl || '').slice(0, 200),
        voice: String(body.voice || '').slice(0, 20),
        autoLevel: String(body.autoLevel || '').slice(0, 30),
        refundCap: String(body.refundCap || '').slice(0, 10),
        discountCap: String(body.discountCap || '').slice(0, 10),
        completedAt: new Date().toISOString(),
      });
      console.log('[auth] setup saved for ' + u.email);
      send(res, 200, { ok: true, user: publicUser(saved) });
      return true;
    }

    return false;
  }

  return { handle, isUnlocked, gatePassword, currentUser, store, SESSION_COOKIE, GATE_COOKIE };
}

module.exports = { create, timingEq };
