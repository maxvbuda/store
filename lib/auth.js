/**
 * Accounts + the shared-password gate.
 *
 * Accounts and sessions live in MongoDB (set MONGODB_URI) instead of a flat
 * file, so they survive restarts and redeploys on Render's ephemeral
 * filesystem. Sessions auto-expire via a TTL index instead of manual cleanup.
 *
 * Passwords: scrypt with a per-user random salt. Sessions: random 32-byte token
 * in an HttpOnly cookie, compared in constant time.
 */
'use strict';

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const SESSION_COOKIE = 'as_session';
const GATE_COOKIE = 'as_gate';
const DAY = 86400;
const SESSION_TTL_DAYS = 30;

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

async function createStore(mongoUri) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db();
  const users = db.collection('users');
  const sessions = db.collection('sessions');

  await users.createIndex({ email: 1 }, { unique: true });
  // TTL index: MongoDB drops a session doc once createdAt is this old, so
  // expiry needs no manual sweep — it matches the cookie's own Max-Age.
  await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: SESSION_TTL_DAYS * DAY });

  return {
    client,
    count: () => users.countDocuments(),
    findByEmail: (email) => users.findOne({ email: String(email).trim().toLowerCase() }),
    findById: (id) => users.findOne({ _id: id }),
    async addUser(email, password) {
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        _id: 'u_' + crypto.randomBytes(9).toString('hex'),
        email: String(email).trim().toLowerCase(),
        salt,
        hash: hashPassword(password, salt),
        createdAt: new Date().toISOString(),
        setup: null,
      };
      await users.insertOne(user);
      return user;
    },
    async saveSetup(userId, setup) {
      await users.updateOne({ _id: userId }, { $set: { setup } });
      return users.findOne({ _id: userId });
    },
    async newSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      await sessions.insertOne({ _id: token, userId, createdAt: new Date() });
      return token;
    },
    async userForToken(token) {
      if (!token) return null;
      const s = await sessions.findOne({ _id: token });
      if (!s) return null;
      return users.findOne({ _id: s.userId });
    },
    dropSession: (token) => sessions.deleteOne({ _id: token }),
  };
}

// ------------------------------------------------------------------ module

async function create(env, send, readBody) {
  const mongoUri = env('MONGODB_URI', 'mongodb://127.0.0.1:27017/shop-agent');
  const store = await createStore(mongoUri);

  const gatePassword = () => env('APP_PASSWORD', '');
  const gateToken = () =>
    crypto.createHmac('sha256', gatePassword()).update('unlock-v1').digest('hex');

  const isUnlocked = (req) =>
    !gatePassword() || timingEq(cookieValue(req, GATE_COOKIE), gateToken());

  const currentUser = (req) => store.userForToken(cookieValue(req, SESSION_COOKIE));

  // storePassword travels with the account (needed server-side to reach a
  // password-gated Shopify store) but must never round-trip to the browser.
  const publicUser = (u) => {
    if (!u) return null;
    const { storePassword, ...setupRest } = u.setup || {};
    return { id: u._id, email: u.email, createdAt: u.createdAt, setup: u.setup ? setupRest : null };
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
      if (await store.findByEmail(email)) {
        return send(res, 409, { error: 'An account with that email already exists.' }), true;
      }
      const user = await store.addUser(email, password);
      const token = await store.newSession(user._id);
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
      const user = await store.findByEmail(email);
      // Always hash, so a missing user and a wrong password cost the same.
      const candidate = hashPassword(String(body.password || ''), user ? user.salt : 'x'.repeat(32));
      if (!user || !timingEq(candidate, user.hash)) {
        return send(res, 401, { error: 'Wrong email or password.' }), true;
      }
      const token = await store.newSession(user._id);
      console.log('[auth] login ' + email);
      send(res, 200, { ok: true, user: publicUser(user) },
        { 'Set-Cookie': setCookie(SESSION_COOKIE, token, req, 30 * DAY) });
      return true;
    }

    if (p === '/api/account/logout' && req.method === 'POST') {
      await store.dropSession(cookieValue(req, SESSION_COOKIE));
      send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', req, 0) });
      return true;
    }

    if (p === '/api/account/me') {
      const u = await currentUser(req);
      send(res, 200, { signedIn: !!u, user: publicUser(u), accounts: await store.count() });
      return true;
    }

    if (p === '/api/account/setup' && req.method === 'POST') {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { error: 'Sign in first.' }), true;
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: String(e.message) }), true; }
      const saved = await store.saveSetup(u._id, {
        storeUrl: String(body.storeUrl || '').slice(0, 200),
        storePassword: String(body.storePassword || '').slice(0, 200),
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
