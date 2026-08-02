/**
 * Accounts + the shared-password gate.
 *
 * Accounts and sessions live in Supabase Postgres (set SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY) instead of a flat file, so they survive
 * restarts and redeploys on Render's ephemeral filesystem. Run
 * supabase/schema.sql once in the Supabase SQL editor before first use.
 *
 * Passwords: scrypt with a per-user random salt. Sessions: random 32-byte token
 * in an HttpOnly cookie, compared in constant time. The service-role key
 * bypasses RLS — this file is the only thing that touches these tables, and
 * it never runs in the browser.
 */
'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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

async function createStore(supabaseUrl, serviceRoleKey) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set');
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Fails fast at startup rather than on the first request if the schema
  // hasn't been created yet (see supabase/schema.sql).
  const probe = await db.from('agent_users').select('id', { count: 'exact', head: true });
  if (probe.error) {
    throw new Error('agent_users table not reachable — run supabase/schema.sql first: ' + probe.error.message);
  }

  return {
    async count() {
      const { count, error } = await db.from('agent_users').select('id', { count: 'exact', head: true });
      if (error) throw error;
      return count || 0;
    },
    async findByEmail(email) {
      const { data, error } = await db.from('agent_users').select('*')
        .eq('email', String(email).trim().toLowerCase()).maybeSingle();
      if (error) throw error;
      return data;
    },
    async findById(id) {
      const { data, error } = await db.from('agent_users').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
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
      const { error } = await db.from('agent_users').insert(user);
      if (error) throw error;
      return user;
    },
    async saveSetup(userId, setup) {
      const { data, error } = await db.from('agent_users').update({ setup }).eq('id', userId).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async newSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      const { error } = await db.from('agent_sessions')
        .insert({ token, user_id: userId, created_at: new Date().toISOString() });
      if (error) throw error;
      return token;
    },
    async userForToken(token) {
      if (!token) return null;
      const cutoff = new Date(Date.now() - SESSION_TTL_DAYS * DAY * 1000).toISOString();
      const { data: session, error } = await db.from('agent_sessions').select('user_id, created_at')
        .eq('token', token).gt('created_at', cutoff).maybeSingle();
      if (error) throw error;
      if (!session) return null;
      const { data: user, error: userErr } = await db.from('agent_users').select('*').eq('id', session.user_id).maybeSingle();
      if (userErr) throw userErr;
      return user;
    },
    async dropSession(token) {
      const { error } = await db.from('agent_sessions').delete().eq('token', token);
      if (error) throw error;
    },
  };
}

// ------------------------------------------------------------------ module

async function create(env, send, readBody) {
  // Accepts the plain name or the Next.js-style NEXT_PUBLIC_ prefix, so the
  // same Supabase project's env vars work here without renaming anything.
  const supabaseUrl = env('SUPABASE_URL', '') || env('NEXT_PUBLIC_SUPABASE_URL', '');
  const store = await createStore(supabaseUrl, env('SUPABASE_SERVICE_ROLE_KEY', ''));

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
