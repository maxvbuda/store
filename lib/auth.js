/**
 * Accounts + the shared-password gate.
 *
 * Accounts and sessions live in MongoDB (set MONGODB_URI) instead of a flat
 * file, so they survive restarts and redeploys on Render's ephemeral
 * filesystem. Collections and indexes are created on first boot — no schema
 * step. A free MongoDB Atlas cluster is enough.
 *
 * Passwords: scrypt with a per-user random salt. Sessions: random 32-byte token
 * in an HttpOnly cookie, compared in constant time. This file is the only
 * thing that touches these collections, and it never runs in the browser.
 */
'use strict';

const crypto = require('crypto');
// mongodb is required lazily inside createStore, so a machine with no
// node_modules (and no MONGODB_URI) can still boot on the file store without
// ever touching the dependency.

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

async function createStore(uri, dbName) {
  const { MongoClient } = require('mongodb');
  // Short server-selection timeout: a wrong URI or an Atlas IP allowlist that
  // blocks this host should fail the boot in seconds, not hang for 30.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
  } catch (e) {
    await client.close().catch(() => {});
    throw new Error('MongoDB unreachable (' + ((e && e.message) || e) + ') — check MONGODB_URI, '
      + 'and on Atlas that Network Access allows this host (0.0.0.0/0 for Render)');
  }
  const db = client.db(dbName);
  const users = db.collection('agent_users');
  const sessions = db.collection('agent_sessions');

  // Idempotent — a no-op after the first boot. The TTL index lets Mongo
  // delete expired sessions on its own; userForToken still checks the age,
  // since the TTL sweeper only runs about once a minute.
  await Promise.all([
    users.createIndex({ id: 1 }, { unique: true }),
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ token: 1 }, { unique: true }),
    sessions.createIndex({ created_at: 1 }, { expireAfterSeconds: SESSION_TTL_DAYS * DAY }),
  ]);

  // Mongo's own _id never leaves this module; users are keyed by `id`.
  const noId = { projection: { _id: 0 } };

  return {
    async count() {
      return users.countDocuments();
    },
    async findByEmail(email) {
      return users.findOne({ email: String(email).trim().toLowerCase() }, noId);
    },
    async findById(id) {
      return users.findOne({ id }, noId);
    },
    async addUser(email, password) {
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: 'u_' + crypto.randomBytes(9).toString('hex'),
        email: String(email).trim().toLowerCase(),
        salt,
        hash: hashPassword(password, salt),
        created_at: new Date().toISOString(),
        setup: null,
      };
      await users.insertOne({ ...user });
      return user;
    },
    async saveSetup(userId, setup) {
      return users.findOneAndUpdate({ id: userId }, { $set: { setup } },
        { ...noId, returnDocument: 'after' });
    },
    async newSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      // A real Date, not a string: the TTL index only expires Date values.
      await sessions.insertOne({ token, user_id: userId, created_at: new Date() });
      return token;
    },
    async userForToken(token) {
      if (!token) return null;
      const cutoff = new Date(Date.now() - SESSION_TTL_DAYS * DAY * 1000);
      const session = await sessions.findOne({ token: String(token), created_at: { $gt: cutoff } });
      if (!session) return null;
      return users.findOne({ id: session.user_id }, noId);
    },
    async dropSession(token) {
      await sessions.deleteOne({ token: String(token) });
    },
  };
}

// ------------------------------------------------------------------ module

async function create(env, send, readBody) {
  const uri = env('MONGODB_URI', '');

  // No MongoDB configured → the flat-file store (lib/auth-file.js). Same
  // API surface, zero setup; accounts just don't survive a Render redeploy.
  // With MongoDB configured but broken we still fail loudly — a typo in the
  // URI should be a startup error, not a silent fallback that strands
  // accounts in a file nobody expects.
  if (!uri) {
    return require('./auth-file').create(env, send, readBody);
  }
  const store = await createStore(uri, env('MONGODB_DB', '') || 'shop_agent');

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
    return { id: u.id, email: u.email, createdAt: u.created_at, setup: u.setup ? setupRest : null };
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
      const token = await store.newSession(user.id);
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
      const token = await store.newSession(user.id);
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
      const saved = await store.saveSetup(u.id, {
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
