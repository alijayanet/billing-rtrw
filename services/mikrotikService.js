const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { RouterOSClient } = require('routeros-client');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');

// Runtime patches for node-routeros to prevent uncaught exceptions under RouterOS v7
try {
  const { Channel } = require('node-routeros/dist/Channel');
  const { Receiver } = require('node-routeros/dist/connector/Receiver');
  const { RosException } = require('node-routeros/dist/RosException');

  // 1. Prevent onUnknown from throwing a synchronous exception which crashes the process.
  Channel.prototype.onUnknown = function(reply) {
    logger.warn(`[MikroTik Channel] Received unknown reply: ${reply}`);
  };

  // 2. Reject the write promise when receiving an unknown reply, so it can be handled by try-catch.
  const originalWrite = Channel.prototype.write;
  Channel.prototype.write = function(params, isStream = false, returnPromise = true) {
    if (returnPromise) {
      this.streaming = isStream;
      params.push('.tag=' + this.id);
      this.on('data', (packet) => this.data.push(packet));
      return new Promise((resolve, reject) => {
        this.once('done', (data) => resolve(data));
        this.once('trap', (data) => reject(new Error(data.message)));
        this.once('unknown', (reply) => {
          reject(new RosException('UNKNOWNREPLY', { reply: reply }));
        });
        this.readAndWrite(params);
      });
    }
    return originalWrite.call(this, params, isStream, returnPromise);
  };

  // 3. Prevent sendTagData from throwing a synchronous exception when tag is unregistered.
  Receiver.prototype.sendTagData = function(currentTag) {
    const tag = this.tags.get(currentTag);
    if (tag) {
      tag.callback(this.currentPacket);
    } else {
      logger.warn(`[MikroTik Receiver] Received data for unregistered tag: ${currentTag}`);
    }
    this.cleanUp();
  };
} catch (e) {
  logger.error(`[MikroTik Patch] Failed to apply runtime patches: ${e.message}`);
}

const connectionProbeCache = new Map();
const listCache = new Map();

// CACHE DISABLED untuk data yang selalu akurat
const CACHE_ENABLED = false; // Set false untuk disable cache

function cacheKey(routerId, name) {
  const rid = routerId == null || String(routerId).trim() === '' ? 'default' : String(routerId).trim();
  return `${name}:${rid}`;
}

function getCachedList(key, ttlMs) {
  if (!CACHE_ENABLED) return null; // Skip cache jika disabled
  const hit = listCache.get(key);
  if (!hit) return null;
  const age = Date.now() - Number(hit.ts || 0);
  if (age >= Math.max(0, Number(ttlMs) || 0)) return null;
  return hit.data;
}

function setCachedList(key, data) {
  if (!CACHE_ENABLED) return; // Skip cache jika disabled
  listCache.set(key, { ts: Date.now(), data });
}

function clearCachedByPrefix(prefix) {
  for (const k of listCache.keys()) {
    if (String(k).startsWith(prefix)) listCache.delete(k);
  }
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(200, Number(timeoutMs) || 0);
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        clearTimeout(t);
        reject(new Error(`Timeout ${ms}ms${label ? `: ${label}` : ''}`));
      }, ms);
    })
  ]);
}

async function canConnectTcp(host, port, timeoutMs = 1200) {
  const h = String(host || '').trim();
  const p = Number(port) || 0;
  if (!h || !p) return false;
  return await new Promise((resolve) => {
    const socket = net.connect({ host: h, port: p });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(Boolean(ok));
    };
    socket.setTimeout(Math.max(200, Number(timeoutMs) || 1200));
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function resolveIpv4(hostname) {
  const host = String(hostname || '').trim();
  if (!host) return '';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return host;

  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const res = await dns.promises.lookup(host, { family: 4 });
    return res && res.address ? String(res.address) : '';
  }

  return await new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (err) return reject(err);
      resolve(String(address || ''));
    });
  });
}

function toKebabCase(key) {
  const s = String(key || '').trim();
  if (!s) return s;
  if (s.includes('-') || s.startsWith('.') || s.startsWith('=') || s.startsWith('?')) return s;
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function toCamelCaseKey(key) {
  return String(key || '').replace(/-([a-z0-9])/g, (_, c) => String(c).toUpperCase());
}

function augmentRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const [k, v] of Object.entries(row)) {
    if (!k || k.startsWith('.') || k.includes('-') === false) continue;
    const camel = toCamelCaseKey(k);
    if (camel && row[camel] === undefined) row[camel] = v;
  }
  return row;
}

class MenuAdapter {
  constructor(api, basePath, filters = []) {
    this.api = api;
    this.basePath = basePath;
    this.filters = filters;
  }

  where(keyOrObj, value) {
    const next = [...this.filters];
    if (keyOrObj && typeof keyOrObj === 'object') {
      for (const [k, v] of Object.entries(keyOrObj)) next.push(this.#toQueryWord(k, v));
    } else {
      next.push(this.#toQueryWord(keyOrObj, value));
    }
    return new MenuAdapter(this.api, this.basePath, next);
  }

  async get() {
    const words = [`${this.basePath}/print`, ...this.filters];
    const res = await this.api.send(words);
    return Array.isArray(res) ? res.map(augmentRow) : [];
  }

  async getOnly() {
    const rows = await this.get();
    return rows && rows.length ? rows[0] : null;
  }

  async add(data) {
    const words = [`${this.basePath}/add`, ...this.#toSetWords(data)];
    const res = await this.api.send(words);
    return res;
  }

  async set(data, id) {
    const rid = String(id || '').trim();
    const words = [`${this.basePath}/set`, `=.id=${rid}`, ...this.#toSetWords(data)];
    const res = await this.api.send(words);
    return res;
  }

  async remove(id) {
    const rid = String(id || '').trim();
    const words = [`${this.basePath}/remove`, `=.id=${rid}`];
    const res = await this.api.send(words);
    return res;
  }

  async update(data) {
    const rows = await this.get();
    for (const r of rows) {
      const rid = String(r?.['.id'] || '').trim();
      if (!rid) continue;
      await this.set(data, rid);
    }
    return [];
  }

  async exec(command, params) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('Command is required');
    const path = this.basePath === '/' ? `/${cmd}` : `${this.basePath}/${cmd}`;
    const words = [path, ...this.#toSetWords(params)];
    return await this.api.send(words);
  }

  #toQueryWord(key, value) {
    const k = String(key || '').trim();
    const v = value === undefined || value === null ? '' : String(value);
    const kk = k === 'id' ? '.id' : toKebabCase(k);
    return `?${kk}=${v}`;
  }

  #toSetWords(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    for (const [kRaw, vRaw] of Object.entries(data)) {
      if (vRaw === undefined) continue;
      const k = String(kRaw || '').trim();
      if (!k) continue;
      const kk = k === 'id' ? '.id' : toKebabCase(k);
      const v = vRaw === null ? '' : String(vRaw);
      out.push(`=${kk}=${v}`);
    }
    return out;
  }
}

class ClientAdapter {
  constructor(api) {
    this.api = api;
  }

  menu(path) {
    const raw = String(path || '').trim();
    const normalized = raw
      ? ('/' + raw.replace(/^\/+/, '').replace(/\s+/g, '/').replace(/\/+$/g, ''))
      : '/';
    return new MenuAdapter(this.api, normalized);
  }
}

async function getConnection(routerId = null) {
  let host, port, user, password;

  if (routerId === 'settings_json' || routerId === 'settings') {
    const settings = getSettingsWithCache();
    host = settings.mikrotik_host;
    port = settings.mikrotik_port || 8728;
    user = settings.mikrotik_user;
    password = settings.mikrotik_password;
    logger.info('[MikroTik] Using router from settings.json (explicitly requested)');
  } else if (routerId) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
    if (!router) throw new Error(`Router with ID ${routerId} not found`);
    host = router.host;
    port = router.port || 8728;
    user = router.user;
    password = router.password;
  } else {
    // Tidak ada routerId, coba cari router default dari database
    const defaultRouter = db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    
    if (defaultRouter) {
      // Ada router aktif di database, gunakan itu
      host = defaultRouter.host;
      port = defaultRouter.port || 8728;
      user = defaultRouter.user;
      password = defaultRouter.password;
      logger.info(`[MikroTik] Using default router from database: ${defaultRouter.name} (${defaultRouter.host})`);
    } else {
      // Fallback ke settings.json untuk backward compatibility
      const settings = getSettingsWithCache();
      host = settings.mikrotik_host;
      port = settings.mikrotik_port || 8728;
      user = settings.mikrotik_user;
      password = settings.mikrotik_password;
      logger.info('[MikroTik] Using router from settings.json (no routers in database)');
    }
  }

  if (!host || !user) {
    throw new Error('MikroTik settings not configured');
  }

  const configuredPort = Number(port) || 8728;
  const tlsSetting = getSettingsWithCache().mikrotik_tls === true;
  const fallbackPort = configuredPort === 8728 ? 8729 : 8728;
  const candidates = configuredPort === fallbackPort ? [configuredPort] : [configuredPort, fallbackPort];
  const cacheKey = String(host);
  const now = Date.now();
  const cached = connectionProbeCache.get(cacheKey);
  if (cached && cached.failUntil && now < cached.failUntil) {
    const e = new Error(cached.failMessage || `Tidak bisa konek ke MikroTik ${host}:${configuredPort}.`);
    e.code = 'ECONNREFUSED';
    throw e;
  }
  let selectedPort = (cached && cached.okUntil && now < cached.okUntil && cached.port) ? Number(cached.port) : 0;
  if (!selectedPort) {
    for (const p of candidates) {
      const ok = await canConnectTcp(host, p, 1200);
      if (ok) {
        selectedPort = p;
        break;
      }
    }
    if (!selectedPort) {
      const failMessage = `Tidak bisa konek ke MikroTik ${host}:${configuredPort} (juga sudah coba ${fallbackPort}). Pastikan IP/port benar dan service API (8728) atau API-SSL (8729) aktif di MikroTik.`;
      connectionProbeCache.set(cacheKey, { port: 0, okUntil: 0, failUntil: now + 5000, failMessage });
      const e = new Error(failMessage);
      e.code = 'ECONNREFUSED';
      throw e;
    }
  }

  try {
    const useTls = selectedPort === 8729 || tlsSetting === true;
    const api = new RouterOSClient({
      host,
      port: selectedPort,
      user,
      password,
      tls: useTls ? { rejectUnauthorized: false } : false,
      timeout: 5000
    });

    // Attach defensive error listener to prevent unhandled 'error' events
    // from crashing the process when connection is refused or drops
    if (typeof api.on === 'function') {
      api.on('error', (err) => {
        logger.error(`[MikroTik] Connection error event (${host}): ${err?.message || err}`);
      });
    }

    if (api.rosApi && typeof api.rosApi.on === 'function') {
      api.rosApi.on('error', (err) => {
        logger.error(`[MikroTik Raw API] Connection or parser error (${host}): ${err?.message || err}`);
      });
    }

    await api.connect();
    connectionProbeCache.set(cacheKey, { port: selectedPort, okUntil: Date.now() + 30000, failUntil: 0, failMessage: '' });
    
    // Adapt api so that it exposes the expected .send method and correct close logic
    api.send = async (words) => {
      if (!api.rosApi || typeof api.rosApi.write !== 'function') {
        throw new Error('MikroTik API connection is not established');
      }
      return await api.rosApi.write(words);
    };

    const originalClose = typeof api.close === 'function' ? api.close.bind(api) : null;
    api.close = async () => {
      try {
        if (originalClose) return await originalClose();
      } catch {}
      return undefined;
    };
    if (typeof api.disconnect !== 'function') api.disconnect = api.close;
    
    const client = new ClientAdapter(api);
    return { client, api };
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('EHOSTUNREACH')) {
      connectionProbeCache.set(cacheKey, {
        port: 0,
        okUntil: 0,
        failUntil: Date.now() + 5000,
        failMessage: `Tidak bisa konek ke MikroTik ${host}:${selectedPort}. ${msg}`
      });
    }
    logger.error(`Failed to connect to MikroTik (${host}): ${err?.message || err}`);
    throw err;
  }
}

async function checkConnection(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const identity = await conn.client.menu('/system/identity').getOnly();
    return Boolean(identity && (identity.name || identity['name']));
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('not found')) throw e;
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemIdentity(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const identity = await conn.client.menu('/system/identity').getOnly();
    return identity ? (identity.name || identity['name'] || 'MikroTik') : 'MikroTik';
  } catch (e) {
    return null;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeProfiles(routerId = null) {
  const ck = cacheKey(routerId, 'pppoeProfiles');
  const cached = getCachedList(ck, 15000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const start = Date.now();
    const raw = await conn.api.send([
      '/ppp/profile/print',
      '=.proplist=.id,name,local-address,remote-address,rate-limit'
    ]);
    const ms = Date.now() - start;
    if (ms > 1200) logger.warn(`[MikroTik] Slow /ppp/profile/print (${ms}ms)`);
    const results = Array.isArray(raw) ? raw.map(augmentRow) : [];
    const mapped = results.map(r => ({
      id: r['.id'] || r.id,
      name: r.name,
      localAddress: r.localAddress || r['local-address'] || '-',
      remoteAddress: r.remoteAddress || r['remote-address'] || '-',
      rateLimit: r.rateLimit || r['rate-limit'] || '-'
    }));
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    logger.error('Error getting PPPoE profiles:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeUsers(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    // Only get secrets for pppoe service
    const results = await conn.client.menu('/ppp/secret').where('service', 'pppoe').get();
    return results.map(r => ({
      id: r['.id'],
      name: r.name,
      profile: r.profile,
      disabled: r.disabled === 'true'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE users:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Function to isolate a user
async function setPppoeProfile(username, profileName, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const secretMenu = conn.client.menu('/ppp/secret');
    const secrets = await secretMenu.where('name', username).get();
    
    if (!secrets || secrets.length === 0) {
      throw new Error(`PPPoE User ${username} not found in MikroTik`);
    }

    const secret = secrets[0];
    const secretId = secret['.id'] || secret.id;
    if (!secretId) {
      throw new Error(`PPPoE secret ID not found for user ${username}`);
    }
    const currentProfile = secret.profile;

    // Hanya update dan kick jika profil berubah
    if (currentProfile !== profileName) {
      logger.info(`[MikroTik] Changing profile for ${username}: ${currentProfile} -> ${profileName}`);
      await secretMenu.set({ profile: profileName }, secretId);
      
      // Disconnect active connection so they reconnect with new profile
      await kickPppoeUser(username, routerId);
    } else {
      logger.info(`[MikroTik] Profile for ${username} is already ${profileName}. Skipping update and kick.`);
    }

    return true;
  } catch (e) {
    logger.error(`Error setting PPPoE profile for ${username}:`, e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickPppoeUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) {
    logger.warn('[MikroTik] kickPppoeUser called without username. Skipping.');
    return false;
  }
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping PPPoE active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ppp/active').remove(sessionId);
      }
      activeSessionsMapCache = { ts: 0, data: new Map() };
      return true;
    }
    
    logger.info(`[MikroTik] No active PPPoE session found for user: ${normalizedUsername}`);
    return false;
  } catch (e) {
    logger.error(`Error kicking PPPoE user ${normalizedUsername}:`, e);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickHotspotUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return false;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ip/hotspot/active').where('user', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active hotspot session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping Hotspot active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ip/hotspot/active').remove(sessionId);
      }
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Could not kick active hotspot connection for ${normalizedUsername}: ${e.message}`);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeSecrets(routerId = null) {
  const ck = cacheKey(routerId, 'pppoeSecrets');
  const cached = getCachedList(ck, 5000); // Reduced cache to 5s for real-time consistency
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    // Use proplist to only fetch needed fields for better performance
    let rows;
    try {
      rows = await withTimeout(
        conn.api.send([
          '/ppp/secret/print',
          '?service=pppoe', // Only get PPPoE service
          '=.proplist=.id,name,profile,local-address,remote-address,disabled,service'
        ]),
        25000, // Increased timeout to 25s for very slow routers
        'getPppoeSecrets'
      );
    } catch (timeoutErr) {
      // Fallback: try without proplist if timeout occurs
      logger.warn(`[MikroTik] Timeout with proplist, trying full query: ${timeoutErr.message}`);
      const allRows = await withTimeout(
        conn.client.menu('/ppp/secret').get(),
        30000, // 30 second timeout for fallback
        'getPppoeSecrets-fallback'
      );
      // Filter only pppoe service
      rows = Array.isArray(allRows) ? allRows.filter(r => {
        const svc = String(r?.service || '').toLowerCase();
        return svc === 'pppoe' || svc === 'any' || !svc;
      }) : [];
    }
    const mapped = Array.isArray(rows) ? rows.map(augmentRow) : [];
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    logger.error('Error getting PPPoE secrets:', e);
    // Return cached data if available, even if expired
    const staleCache = listCache.get(ck);
    if (staleCache && staleCache.data) {
      logger.warn('[MikroTik] Returning stale cache due to error');
      return staleCache.data;
    }
    return [];
  } finally {
    if (conn && conn.api) {
      try {
        conn.api.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
  }
}

async function addPppoeSecret(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').add(data);
    listCache.delete(cacheKey(routerId, 'pppoeSecrets'));
    listCache.delete(cacheKey(routerId, 'pppoeActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeSecret(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').set(data, id);
    listCache.delete(cacheKey(routerId, 'pppoeSecrets'));
    listCache.delete(cacheKey(routerId, 'pppoeActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeSecret(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').remove(id);
    listCache.delete(cacheKey(routerId, 'pppoeSecrets'));
    listCache.delete(cacheKey(routerId, 'pppoeActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function createPppoeSecret({ username, password, profile, remoteAddress, routerId = null }) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const secretData = {
      name: username,
      password: password,
      service: 'pppoe',
      profile: profile
    };
    
    // Add remote address if provided
    if (remoteAddress && remoteAddress.trim()) {
      secretData['remote-address'] = remoteAddress.trim();
    }
    
    const res = await conn.client.menu('/ppp/secret').add(secretData);
    listCache.delete(cacheKey(routerId, 'pppoeSecrets'));
    listCache.delete(cacheKey(routerId, 'pppoeActive'));
    logger.info(`[MikroTik] Created PPPoE secret: ${username} with profile ${profile}`);
    return res;
  } catch (e) {
    logger.error(`Error creating PPPoE secret for ${username}:`, e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeActive(routerId = null) {
  const ck = cacheKey(routerId, 'pppoeActive');
  const cached = getCachedList(ck, 2000); // Very short cache (2s) for real-time active sessions
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    let rows = await withTimeout(
      conn.client.menu('/ppp/active').get(),
      10000,
      'getPppoeActive'
    ).catch(() => []);

    if (Array.isArray(rows) && rows.length > 0) {
      try {
        const ifaces = await withTimeout(
          conn.client.menu('/interface').get(),
          5000,
          'getPppoeActive-interface'
        ).catch(() => []);

        if (Array.isArray(ifaces) && ifaces.length > 0) {
          const ifaceMap = new Map();
          for (const f of ifaces) {
            const rawName = String(f.name || f['name'] || '').trim();
            const cleanName = rawName.replace(/^<|>$/g, '').trim().toLowerCase();
            const rx = Number(f['rx-byte'] || f['rx-bytes'] || f['rxByte'] || f['rxBytes'] || f['bytes-in'] || f['bytesIn'] || 0);
            const tx = Number(f['tx-byte'] || f['tx-bytes'] || f['txByte'] || f['txBytes'] || f['bytes-out'] || f['bytesOut'] || 0);
            const ifData = { rx, tx, rawName, cleanName };

            ifaceMap.set(cleanName, ifData);
            ifaceMap.set(rawName.toLowerCase(), ifData);

            if (cleanName.startsWith('pppoe-')) {
              const uname = cleanName.substring(6);
              if (uname) ifaceMap.set(uname, ifData);
            }
          }

          for (const s of rows) {
            const uname = String(s.name || s.user || '').trim().toLowerCase();
            const ifaceField = String(s.interface || s['interface'] || '').trim().toLowerCase().replace(/^<|>$/g, '');
            const match = ifaceMap.get(uname) || ifaceMap.get(`pppoe-${uname}`) || (ifaceField ? ifaceMap.get(ifaceField) : null);
            if (match) {
              s['bytes-in'] = match.rx;
              s['bytes-out'] = match.tx;
              s['bytesIn'] = match.rx;
              s['bytesOut'] = match.tx;
              s['rx-byte'] = match.rx;
              s['tx-byte'] = match.tx;
            }
          }
        }
      } catch (ifErr) {
        logger.warn(`[MikroTik] Error augmenting /interface bytes: ${ifErr.message}`);
      }
    }

    const mapped = Array.isArray(rows) ? rows.map(augmentRow) : [];
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    logger.error('Error getting active PPPoE sessions:', e);
    // Return cached data if available, even if expired
    const staleCache = listCache.get(ck);
    if (staleCache && staleCache.data) {
      logger.warn('[MikroTik] Returning stale active sessions cache due to error');
      return staleCache.data;
    }
    return [];
  } finally {
    if (conn && conn.api) {
      try {
        conn.api.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
  }
}

async function getActivePppoeSessionsMap() {
  const routers = getAllRouters().filter(r => r.is_active === 1 || r.is_active === '1' || r.is_active === true);
  const sessionsMap = new Map();
  for (const r of routers) {
    try {
      const actives = await getPppoeActive(r.id);
      for (const s of actives) {
        if (s.name) {
          sessionsMap.set(s.name.toLowerCase(), {
            ip: s.address,
            uptime: s.uptime,
            callerId: s['caller-id'] || '',
            routerId: r.id,
            routerName: r.name
          });
        }
      }
    } catch (err) {
      logger.error(`[MikroTik] Failed to get active PPPoE sessions from router ${r.name}: ${err.message}`);
    }
  }
  return sessionsMap;
}

let activeSessionsMapCache = { ts: 0, data: new Map() };

async function getAllActiveSessionsMap(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && activeSessionsMapCache.data && (now - activeSessionsMapCache.ts) < 3000 && activeSessionsMapCache.data.size > 0) {
    return activeSessionsMapCache.data;
  }

  const routers = getAllRouters().filter(r => r.is_active === 1 || r.is_active === '1' || r.is_active === true);
  const sessionsMap = new Map();

  const withTimeout = (promise, ms = 4000) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]).catch(() => []);
  };

  await Promise.all(routers.map(async (r) => {
    try {
      const pppoeActives = await withTimeout(getPppoeActive(r.id), 4000);
      if (Array.isArray(pppoeActives)) {
        for (const s of pppoeActives) {
          if (s && (s.name || s.user)) {
            const username = String(s.name || s.user).trim().toLowerCase();
            const bIn = Number(s['bytes-in'] || s['bytesIn'] || s['bytes_in'] || s['rx-byte'] || s['rx_byte'] || s['bytes-in-count'] || 0);
            const bOut = Number(s['bytes-out'] || s['bytesOut'] || s['bytes_out'] || s['tx-byte'] || s['tx_byte'] || s['bytes-out-count'] || 0);
            sessionsMap.set(username, {
              username: s.name || s.user,
              ip: s.address || s['address'] || '-',
              uptime: s.uptime || s['uptime'] || '-',
              callerId: s['caller-id'] || s['callerId'] || s['mac-address'] || '',
              bytesIn: bIn,
              bytesOut: bOut,
              type: 'pppoe',
              routerId: r.id,
              routerName: r.name
            });
          }
        }
      }
    } catch (err) {}

    try {
      const hsActives = await withTimeout(getHotspotActive(r.id), 4000);
      if (Array.isArray(hsActives)) {
        for (const s of hsActives) {
          if (s && (s.user || s.name)) {
            const username = String(s.user || s.name).trim().toLowerCase();
            const bIn = Number(s['bytes-in'] || s['bytesIn'] || s['bytes_in'] || s['rx-byte'] || s['rx_byte'] || s['bytes-in-count'] || 0);
            const bOut = Number(s['bytes-out'] || s['bytesOut'] || s['bytes_out'] || s['tx-byte'] || s['tx_byte'] || s['bytes-out-count'] || 0);
            sessionsMap.set(username, {
              username: s.user || s.name,
              ip: s.address || s['address'] || '-',
              uptime: s.uptime || s['uptime'] || '-',
              callerId: s['mac-address'] || s['macAddress'] || s['caller-id'] || '',
              bytesIn: bIn,
              bytesOut: bOut,
              type: 'hotspot',
              routerId: r.id,
              routerName: r.name
            });
          }
        }
      }
    } catch (err) {}
  }));

  if (sessionsMap.size > 0 || !activeSessionsMapCache.data || activeSessionsMapCache.data.size === 0) {
    activeSessionsMapCache = { ts: now, data: sessionsMap };
    return sessionsMap;
  }
  return activeSessionsMapCache.data;
}


async function getHotspotActive(routerId = null) {
  const ck = cacheKey(routerId, 'hotspotActive');
  const cached = getCachedList(ck, 5000); // Increased cache from 3s to 5s for better performance
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const rows = await withTimeout(
      conn.client.menu('/ip/hotspot/active').get(),
      5000, // 5 second timeout
      'getHotspotActive'
    );
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    logger.error('Error getting active Hotspot sessions:', e.message);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getIpPools(routerId = null) {
  const ck = cacheKey(routerId, 'ipPools');
  const cached = getCachedList(ck, 30000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const rows = await conn.api.send(['/ip/pool/print', '=.proplist=.id,name,ranges']);
    const mapped = (Array.isArray(rows) ? rows : [])
      .map(augmentRow)
      .map((r) => ({
        id: r['.id'] || r.id,
        name: r.name,
        ranges: r.ranges || r['ranges'] || ''
      }))
      .filter((p) => p && p.name);
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    logger.error('Error getting IP pools:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// PPPoE Profiles CRUD
async function addPppoeProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/profile').add(data);
    listCache.delete(cacheKey(routerId, 'pppoeProfiles'));
    return res;
  } catch (e) {
    logger.error('Error adding PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/profile').set(data, id);
    listCache.delete(cacheKey(routerId, 'pppoeProfiles'));
    return res;
  } catch (e) {
    logger.error('Error updating PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/profile').remove(id);
    listCache.delete(cacheKey(routerId, 'pppoeProfiles'));
    return res;
  } catch (e) {
    logger.error('Error deleting PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Hotspot Profiles CRUD (User Profiles)
async function getHotspotUserProfiles(routerId = null) {
  const ck = cacheKey(routerId, 'hotspotUserProfiles');
  const cached = getCachedList(ck, 15000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const start = Date.now();
    // Gunakan client.menu().get() karena dengan routeros-client sudah stabil dan tidak hang
    const rows = await conn.client.menu('/ip/hotspot/user/profile').get();
    const ms = Date.now() - start;
    if (ms > 1200) logger.warn(`[MikroTik] Slow /ip/hotspot/user/profile.get (${ms}ms)`);
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    logger.error('Error getting Hotspot user profiles:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUserProfileById(id, routerId = null) {
  const rid = String(id || '').trim();
  if (!rid) throw new Error('Hotspot profile id is required');
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const raw = await conn.api.send([
      '/ip/hotspot/user/profile/print',
      `?.id=${rid}`,
      '=.proplist=.id,name,rate-limit,shared-users,session-timeout,on-login'
    ]);
    const rows = Array.isArray(raw) ? raw.map(augmentRow) : [];
    return rows.length ? rows[0] : null;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUserProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const name = String(data?.name || '').trim();
    if (!name) throw new Error('Nama profile hotspot wajib diisi');
    logger.info(`[MikroTik] add hotspot user profile start name="${name}" routerId=${routerId || ''}`);
    const menu = conn.client.menu('/ip/hotspot/user/profile');

    const payload = {
      name,
      'shared-users': data && data['shared-users'] != null ? data['shared-users'] : 1
    };

    if (data && data['rate-limit'] != null) {
      const rl = String(data['rate-limit'] || '').trim();
      const first = rl ? rl.split(/\\s+/)[0] : '';
      if (first) payload['rate-limit'] = first;
    }
    if (data && data['session-timeout'] != null) {
      const st = String(data['session-timeout'] || '').trim();
      const first = st ? st.split(/\\s+/)[0] : '';
      if (first) payload['session-timeout'] = first;
    }
    
    // Handle on-login (Mikhmon metadata)
    if (data && data['on-login'] != null) {
      const onLogin = String(data['on-login'] || '').trim();
      if (onLogin) payload['on-login'] = onLogin;
    }

    const op = menu.add(payload);
    const res = await withTimeout(op, 8000, '/ip/hotspot/user/profile/add').catch(async (err) => {
      const msg = String(err?.message || err || '');
      if (msg.includes('Timeout')) {
        try {
          const found = await withTimeout(menu.where('name', name).get(), 4000, '/ip/hotspot/user/profile/print(find-after-timeout)');
          if (Array.isArray(found) && found.length) return { timeoutRecovered: true };
        } catch {}
      }
      try { await conn.api.close(); } catch {}
      throw err;
    });

    logger.info(`[MikroTik] add hotspot user profile done name="${name}" routerId=${routerId || ''}`);
    listCache.delete(cacheKey(routerId, 'hotspotUserProfiles'));
    return res;
  } catch (e) {
    logger.error('Error adding Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) {
      try { await conn.api.close(); } catch {}
    }
  }
}

async function updateHotspotUserProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const safe = {};
    if (data && data.name != null && String(data.name).trim()) safe.name = String(data.name).trim();
    if (data && data['shared-users'] != null && String(data['shared-users']).trim()) safe['shared-users'] = String(data['shared-users']).trim();
    if (data && data['rate-limit'] != null) {
      const rl = String(data['rate-limit'] || '').trim();
      const first = rl ? rl.split(/\\s+/)[0] : '';
      if (first) safe['rate-limit'] = first;
    }
    if (data && data['session-timeout'] != null) {
      const st = String(data['session-timeout'] || '').trim();
      const first = st ? st.split(/\\s+/)[0] : '';
      if (first) safe['session-timeout'] = first;
    }
    
    // Handle on-login (Mikhmon metadata)
    if (data && data['on-login'] != null) {
      const onLogin = String(data['on-login'] || '').trim();
      if (onLogin) safe['on-login'] = onLogin;
    }

    const name = String(safe?.name || '').trim();
    logger.info(`[MikroTik] update hotspot user profile start id="${String(id || '')}" name="${name}" routerId=${routerId || ''}`);
    const op = conn.client.menu('/ip/hotspot/user/profile').set(safe, id);
    const res = await withTimeout(op, 8000, '/ip/hotspot/user/profile/set').catch(async (err) => {
      try { await conn.api.close(); } catch {}
      throw err;
    });
    logger.info(`[MikroTik] update hotspot user profile done id="${String(id || '')}" name="${name}" routerId=${routerId || ''}`);
    listCache.delete(cacheKey(routerId, 'hotspotUserProfiles'));
    return res;
  } catch (e) {
    logger.error('Error updating Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) {
      try { await conn.api.close(); } catch {}
    }
  }
}

async function deleteHotspotUserProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    logger.info(`[MikroTik] delete hotspot user profile start id="${String(id || '')}" routerId=${routerId || ''}`);
    const op = conn.client.menu('/ip/hotspot/user/profile').remove(id);
    const res = await withTimeout(op, 8000, '/ip/hotspot/user/profile/remove').catch(async (err) => {
      try { await conn.api.close(); } catch {}
      throw err;
    });
    logger.info(`[MikroTik] delete hotspot user profile done id="${String(id || '')}" routerId=${routerId || ''}`);
    listCache.delete(cacheKey(routerId, 'hotspotUserProfiles'));
    return res;
  } catch (e) {
    logger.error('Error deleting Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) {
      try { await conn.api.close(); } catch {}
    }
  }
}

async function getHotspotUsers(routerId = null) {
  const ck = cacheKey(routerId, 'hotspotUsers');
  const cached = getCachedList(ck, 10000); // Reduced cache to 10s for more consistent data
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    // Use proplist to only fetch needed fields for better performance
    let rows;
    try {
      rows = await withTimeout(
        conn.api.send([
          '/ip/hotspot/user/print',
          '=.proplist=.id,name,profile,mac-address,disabled,comment'
        ]),
        20000, // Increased timeout to 20s for very slow routers
        'getHotspotUsers'
      );
    } catch (timeoutErr) {
      // Fallback: try without proplist if timeout occurs
      logger.warn(`[MikroTik] Timeout with proplist for hotspot users, trying full query: ${timeoutErr.message}`);
      rows = await withTimeout(
        conn.client.menu('/ip/hotspot/user').get(),
        25000, // 25 second timeout for fallback
        'getHotspotUsers-fallback'
      );
    }
    const mapped = Array.isArray(rows) ? rows.map(augmentRow) : [];
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    logger.error('Error getting Hotspot users:', e.message);
    // Return empty array instead of throwing to prevent page crash
    return [];
  } finally {
    if (conn && conn.api) {
      try {
        conn.api.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
  }
}

async function addHotspotUser(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').add(data);
    listCache.delete(cacheKey(routerId, 'hotspotUsers'));
    listCache.delete(cacheKey(routerId, 'hotspotActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUser(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').set(data, id);
    listCache.delete(cacheKey(routerId, 'hotspotUsers'));
    listCache.delete(cacheKey(routerId, 'hotspotActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUser(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').remove(id);
    listCache.delete(cacheKey(routerId, 'hotspotUsers'));
    listCache.delete(cacheKey(routerId, 'hotspotActive'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUserByName(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) throw new Error('Hotspot username wajib diisi');
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const rows = await conn.client.menu('/ip/hotspot/user').where('name', normalizedUsername).get();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0] || null;
    if (!row) return null;
    return { ...row, id: row.id || row['.id'] };
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function setHotspotUserDisabled(username, disabled, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) throw new Error('Hotspot username wajib diisi');
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const userMenu = conn.client.menu('/ip/hotspot/user');
    const rows = await userMenu.where('name', normalizedUsername).get();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Hotspot user "${normalizedUsername}" tidak ditemukan di MikroTik`);
    const row = rows[0] || null;
    const id = row ? (row['.id'] || row.id) : null;
    if (!id) throw new Error('ID hotspot user tidak ditemukan');
    await userMenu.set({ disabled: disabled ? 'true' : 'false' }, id);
    listCache.delete(cacheKey(routerId, 'hotspotUsers'));
    if (disabled) {
      try {
        const sessions = await conn.client.menu('/ip/hotspot/active').where('user', normalizedUsername).get();
        if (Array.isArray(sessions) && sessions.length) {
          for (const s of sessions) {
            const sid = s['.id'] || s.id;
            if (sid) await conn.client.menu('/ip/hotspot/active').remove(sid);
          }
        }
      } catch {}
      listCache.delete(cacheKey(routerId, 'hotspotActive'));
    }
    return true;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function upsertHotspotUser(data, routerId = null) {
  const username = String(data?.username || '').trim();
  if (!username) throw new Error('Hotspot username wajib diisi');
  const password = data?.password != null ? String(data.password) : '';
  const profile = data?.profile != null ? String(data.profile).trim() : '';
  const macAddress = data?.macAddress != null ? String(data.macAddress).trim() : '';
  const disabled = data?.disabled != null ? !!data.disabled : false;

  let conn = null;
  try {
    conn = await getConnection(routerId);
    const userMenu = conn.client.menu('/ip/hotspot/user');
    const existing = await userMenu.where('name', username).get();
    const row = Array.isArray(existing) && existing.length ? existing[0] : null;
    const id = row ? (row['.id'] || row.id) : null;

    const payload = {};
    if (!id) payload.name = username;
    if (password) payload.password = password;
    if (profile) payload.profile = profile;
    if (macAddress) payload['mac-address'] = macAddress;
    payload.disabled = disabled ? 'true' : 'false';

    if (id) {
      await userMenu.set(payload, id);
    } else {
      const addPayload = { ...payload, name: username };
      if (!addPayload.password) addPayload.password = username;
      await userMenu.add(addPayload);
    }

    listCache.delete(cacheKey(routerId, 'hotspotUsers'));
    if (disabled) {
      try {
        const sessions = await conn.client.menu('/ip/hotspot/active').where('user', username).get();
        if (Array.isArray(sessions) && sessions.length) {
          for (const s of sessions) {
            const sid = s['.id'] || s.id;
            if (sid) await conn.client.menu('/ip/hotspot/active').remove(sid);
          }
        }
      } catch {}
      listCache.delete(cacheKey(routerId, 'hotspotActive'));
    }

    return { ok: true, updated: !!id };
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getBackup(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/').exec('export');
    return result;
  } catch (e) {
    logger.error('Error exporting MikroTik config:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemScripts(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/system/script').get();
  } catch (e) {
    logger.error('Error getting MikroTik system scripts:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemResource(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/system/resource').get();
    return result[0];
  } catch (e) {
    logger.error('Error getting MikroTik system resource:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotProfiles(routerId = null) {
  const ck = cacheKey(routerId, 'hotspotProfiles');
  const cached = getCachedList(ck, 30000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const rows = await conn.client.menu('/ip/hotspot/profile').get();
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    logger.error('Error getting Hotspot profiles:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/profile').add(data);
    listCache.delete(cacheKey(routerId, 'hotspotProfiles'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/profile').set(data, id);
    listCache.delete(cacheKey(routerId, 'hotspotProfiles'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/profile').remove(id);
    listCache.delete(cacheKey(routerId, 'hotspotProfiles'));
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Router CRUD Services
function getAllRouters() {
  return db.prepare('SELECT * FROM routers ORDER BY name ASC').all();
}

function getRouterById(id) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
}

function createRouter(data) {
  return db.prepare(`
    INSERT INTO routers (name, host, port, user, password, description, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.name, data.host, data.port || 8728, data.user, data.password, data.description || '', data.is_active || 1);
}

function updateRouter(id, data) {
  return db.prepare(`
    UPDATE routers SET name=?, host=?, port=?, user=?, password=?, description=?, is_active=?
    WHERE id=?
  `).run(data.name, data.host, data.port || 8728, data.user, data.password, data.description || '', data.is_active || 1, id);
}

function deleteRouter(id) {
  return db.prepare('DELETE FROM routers WHERE id = ?').run(id);
}

/**
 * RouterOS (.rsc) untuk mengarahkan pelanggan di address-list LIST_ISOLIR ke portal billing
 * (HTTP/HTTPS ke IP server sesuai Pengaturan → app_url). Salin ke Terminal / Import.
 * PPPoE: set profil isolir on-up agar IP masuk LIST_ISOLIR (sama seperti tombol Setup Firewall di panel).
 */
async function generateIsolirPortalScript() {
  const settings = getSettingsWithCache();
  const raw = String(settings.app_url || '').trim();
  const normalized = raw && /^https?:\/\//i.test(raw) ? raw : (raw ? `https://${raw}` : '');
  let hostname = '';
  let port = 443;
  let isHttps = true;
  try {
    const u = new URL(normalized || 'http://127.0.0.1:4555');
    hostname = u.hostname;
    port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    isHttps = u.protocol === 'https:';
  } catch {
    hostname = 'GANTI-host-portal-billing';
    port = 4555;
    isHttps = false;
  }

  let billingIp = hostname;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    try {
      billingIp = await resolveIpv4(hostname);
    } catch {
      billingIp = 'GANTI_IP_SERVER_PORTAL';
    }
  }

  const httpServicePort = isHttps ? 80 : port;
  const httpsServicePort = isHttps ? port : 443;

  const lines = [
    '# ============================================================',
    '# Script halaman isolir / portal penagihan (generate Billing)',
    `# Sumber URL: ${normalized || '(atur app_url di Pengaturan)'}`,
    `# Host: ${hostname}  →  IP NAT: ${billingIp}`,
    '# Address-list: LIST_ISOLIR — saat isolir, billing memasang on-up di profil PPPoE (nama = isolir_profile pelanggan).',
    '# Hapus rule lama dengan comment=BILLING_ISOLIR_* sebelum import ulang.',
    '# ============================================================',
    '',
    '# --- DNS ---',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR protocol=udp dst-port=53 action=accept comment="BILLING_ISOLIR_DNS"',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR protocol=tcp dst-port=53 action=accept comment="BILLING_ISOLIR_DNS_TCP"',
    '',
    '# --- Izinkan akses ke server portal billing ---',
    `/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR dst-address=${billingIp} action=accept comment="BILLING_ISOLIR_ALLOW"`,
    '',
    '# --- Walled Garden: Izinkan Akses Payment Gateway (Tripay / Midtrans / Duitku / Xendit) ---',
    '/ip firewall address-list add list=LIST_ISOLIR_GATEWAY address=tripay.co.id comment="Tripay Gateway" disabled=no',
    '/ip firewall address-list add list=LIST_ISOLIR_GATEWAY address=app.midtrans.com comment="Midtrans Gateway" disabled=no',
    '/ip firewall address-list add list=LIST_ISOLIR_GATEWAY address=api.xendit.co comment="Xendit Gateway" disabled=no',
    '/ip firewall address-list add list=LIST_ISOLIR_GATEWAY address=passport.duitku.com comment="Duitku Gateway" disabled=no',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR dst-address-list=LIST_ISOLIR_GATEWAY action=accept comment="BILLING_ISOLIR_ALLOW_GATEWAYS"',
    '',
    '# --- NAT: HTTP menuju portal (untuk redirect ke /isolated, dll.) ---',
    `/ip firewall nat add chain=dstnat protocol=tcp dst-port=80 src-address-list=LIST_ISOLIR action=dst-nat to-addresses=${billingIp} to-ports=${httpServicePort} comment="BILLING_ISOLIR_HTTP"`,
    '',
    '# --- NAT: HTTPS ke portal (jika portal pakai TLS) ---',
    `/ip firewall nat add chain=dstnat protocol=tcp dst-port=443 src-address-list=LIST_ISOLIR action=dst-nat to-addresses=${billingIp} to-ports=${httpsServicePort} comment="BILLING_ISOLIR_HTTPS"`,
    '',
    '# --- Blokir sisa traffic forward dari pelanggan terisolir (opsional; sesuaikan urutan) ---',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR action=drop comment="BILLING_ISOLIR_BLOCK_REST" disabled=yes',
    '',
    '# --- PPPoE: contoh memasukkan IP ke LIST_ISOLIR saat login (nama profil = isolir) ---',
    '# Jalankan sekali, atau salin ke on-up profil isolir di Winbox:',
    '# /ppp profile set [find name=isolir] on-up="/ip firewall address-list add list=LIST_ISOLIR address=$remote-address comment=$user timeout=23h"',
    '',
  ];

  return {
    script: lines.join('\n'),
    appUrl: normalized || raw,
    billingHost: hostname,
    billingIp,
    httpNatPort: httpServicePort,
    httpsNatPort: httpsServicePort,
  };
}

const ISOLIR_ADDR_LIST = 'LIST_ISOLIR';

/** Nama profil PPPoE isolir yang dipakai pelanggan di router ini (distinct dari DB). */
function getDistinctIsolirProfilesForRouter(routerId) {
  const rid = Number(routerId);
  if (!Number.isFinite(rid) || rid <= 0) return ['isolir'];
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(COALESCE(isolir_profile, '')) AS n
    FROM customers
    WHERE router_id IS ? AND TRIM(COALESCE(pppoe_username, '')) != ''
  `).all(rid);
  const names = new Set();
  for (const r of rows || []) {
    const n = String(r.n || '').trim();
    names.add(n || 'isolir');
  }
  if (names.size === 0) names.add('isolir');
  return [...names];
}

/**
 * Pasang on-up / on-down di profil PPPoE (mis. isolir) agar IP pelanggan masuk address-list LIST_ISOLIR
 * saat login — supaya NAT/firewall "halaman isolir" berlaku untuk trafik internet mereka.
 * @param {object|null} reuseConn - hasil getConnection() jika sudah terbuka (mis. dari setupIsolirFirewall).
 */
async function ensurePppProfileIsolirAddressListHook(profileName, routerId = null, reuseConn = null) {
  const name = String(profileName || 'isolir').trim() || 'isolir';
  let conn = reuseConn;
  let ownConn = false;
  try {
    if (!conn) {
      conn = await getConnection(routerId);
      ownConn = true;
    }
    const menu = conn.client.menu('/ppp/profile');
    const rows = await menu.get();
    const list = Array.isArray(rows) ? rows : [];
    const prof = list.find((r) => String(r.name || '') === name);
    if (!prof) {
      const msg = `Profil PPPoE "${name}" tidak ada di router (buat profil isolir di MikroTik atau samakan nama dengan isolir_profile pelanggan).`;
      logger.warn(`[MikroTik] ${msg}`);
      return { ok: false, profile: name, message: msg };
    }
    const id = prof['.id'] || prof.id;
    if (!id) {
      return { ok: false, profile: name, message: 'ID profil tidak ditemukan' };
    }

    let onUp = prof['on-up'] != null ? String(prof['on-up']) : (prof.onUp != null ? String(prof.onUp) : '');
    let onDown = prof['on-down'] != null ? String(prof['on-down']) : (prof.onDown != null ? String(prof.onDown) : '');
    onUp = onUp.trim();
    onDown = onDown.trim();

    const hookUp =
      `/ip firewall address-list remove [find list=${ISOLIR_ADDR_LIST} address=$remote-address]; ` +
      `/ip firewall address-list add list=${ISOLIR_ADDR_LIST} address=$remote-address comment=$user timeout=23h`;
    const hookDown = `/ip firewall address-list remove [find list=${ISOLIR_ADDR_LIST} address=$remote-address]`;

    const addSnip = `address-list add list=${ISOLIR_ADDR_LIST}`;
    const remSnip = `remove [find list=${ISOLIR_ADDR_LIST}`;
    if (!onUp.includes(addSnip)) {
      onUp = onUp ? `${onUp}; ${hookUp}` : hookUp;
    }
    if (!onDown.includes(remSnip)) {
      onDown = onDown ? `${onDown}; ${hookDown}` : hookDown;
    }

    await menu.set({ 'on-up': onUp, 'on-down': onDown }, id);
    logger.info(`[MikroTik] Profil PPPoE "${name}": on-up/on-down diset untuk ${ISOLIR_ADDR_LIST} (isolir portal).`);
    return { ok: true, profile: name, message: `Profil "${name}" memasukkan IP ke ${ISOLIR_ADDR_LIST} saat PPP login.` };
  } catch (e) {
    logger.error(`[MikroTik] ensurePppProfileIsolirAddressListHook(${name}):`, e);
    return { ok: false, profile: name, message: e.message || String(e) };
  } finally {
    if (ownConn && conn && conn.api) conn.api.close();
  }
}

// --- FIREWALL & ISOLIR STATIC IP ---
async function setupIsolirFirewall(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const settings = getSettingsWithCache();

    /** IP portal (app_url) untuk rule allow/NAT — pelanggan isolir tetap bisa DNS + ke server billing saja */
    let billingIp = '';
    let httpNatPort = 80;
    let httpsNatPort = 443;
    try {
      const raw = String(settings.app_url || '').trim();
      const normalized = raw && /^https?:\/\//i.test(raw) ? raw : (raw ? `https://${raw}` : '');
      const u = new URL(normalized || 'http://127.0.0.1:4555');
      const isHttps = u.protocol === 'https:';
      const port = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
      httpNatPort = isHttps ? 80 : port;
      httpsNatPort = isHttps ? port : 443;
      let host = u.hostname;
      if (host && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) host = await resolveIpv4(host);
      billingIp = host || '';
    } catch (e) {
      logger.warn('[setupIsolirFirewall] app_url tidak valid / tidak bisa di-resolve:', e.message);
    }

    // 1. NAT HTTP/HTTPS untuk mengarahkan pelanggan isolir ke portal billing
    const natMenu = conn.client.menu('/ip/firewall/nat');
    const ensureNat = async (comment, dstPort, toPort) => {
      if (!billingIp) return;
      const desired = {
        chain: 'dstnat',
        'src-address-list': 'LIST_ISOLIR',
        protocol: 'tcp',
        'dst-port': String(dstPort),
        action: 'dst-nat',
        'to-addresses': billingIp,
        'to-ports': String(toPort),
        comment,
      };

      const ex = await natMenu.where('comment', comment).get();
      if (ex && ex.length > 0) {
        const id = ex[0]['.id'] || ex[0].id;
        await natMenu.set(desired, id);
        return;
      }
      if (comment === 'BILLING_API_ISOLIR_HTTP') {
        const legacy = await natMenu.where('comment', 'ISOLIR_REDIRECT').get();
        if (legacy && legacy.length > 0) {
          const id = legacy[0]['.id'] || legacy[0].id;
          await natMenu.set(desired, id);
          return;
        }
      }
      await natMenu.add(desired);
    };

    await ensureNat('BILLING_API_ISOLIR_HTTP', 80, httpNatPort);
    await ensureNat('BILLING_API_ISOLIR_HTTPS', 443, httpsNatPort);

    const filterMenu = conn.client.menu('/ip/firewall/filter');
    let blockRows = await filterMenu.where('comment', 'BLOCK_ISOLIR').get();
    let blockId = blockRows[0] ? (blockRows[0]['.id'] || blockRows[0].id) : null;

    if (!blockId) {
      await filterMenu.add({
        chain: 'forward',
        'src-address-list': 'LIST_ISOLIR',
        action: 'drop',
        comment: 'BLOCK_ISOLIR',
      });
      blockRows = await filterMenu.where('comment', 'BLOCK_ISOLIR').get();
      blockId = blockRows[0] ? (blockRows[0]['.id'] || blockRows[0].id) : null;
    }

    const insertBeforeBlock = async (comment, fields) => {
      if (!blockId) return;
      const ex = await filterMenu.where('comment', comment).get();
      if (ex && ex.length > 0) return;
      await filterMenu.add({ ...fields, comment, 'place-before': blockId });
    };

    await insertBeforeBlock('BILLING_API_ISOLIR_DNS', {
      chain: 'forward',
      'src-address-list': 'LIST_ISOLIR',
      protocol: 'udp',
      'dst-port': '53',
      action: 'accept',
    });
    await insertBeforeBlock('BILLING_API_ISOLIR_DNS_TCP', {
      chain: 'forward',
      'src-address-list': 'LIST_ISOLIR',
      protocol: 'tcp',
      'dst-port': '53',
      action: 'accept',
    });
    if (billingIp) {
      await insertBeforeBlock('BILLING_API_ISOLIR_ALLOW', {
        chain: 'forward',
        'src-address-list': 'LIST_ISOLIR',
        'dst-address': billingIp,
        action: 'accept',
      });
    }

    const hookResults = [];
    for (const pname of getDistinctIsolirProfilesForRouter(routerId)) {
      hookResults.push(await ensurePppProfileIsolirAddressListHook(pname, routerId, conn));
    }
    const okNames = hookResults.filter((h) => h.ok).map((h) => h.profile).join(', ');
    const bad = hookResults.filter((h) => !h.ok);
    const warn = bad.length
      ? ` Perhatian: ${bad.map((h) => `${h.profile} (${h.message})`).join('; ')}`
      : '';

    return {
      success: true,
      message: `Firewall isolir + NAT siap. Profil PPPoE di-hook ke ${ISOLIR_ADDR_LIST}: ${okNames || '-'}.${warn}`,
      hooks: hookResults,
    };
  } catch (e) {
    logger.error('Error setupIsolirFirewall:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function manageStaticIp(data, routerId = null) {
  const { ip, name, limit, isolate } = data;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // 1. Manage Simple Queue for Bandwidth
    const queueMenu = conn.client.menu('/queue/simple');
    const existingQueue = await queueMenu.where('target', `${ip}/32`).get();
    const safeName = String(name || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || String(ip || '').trim();
    
    const queueData = {
      name: `CUST-${safeName}`,
      target: `${ip}/32`,
      'max-limit': limit || '5M/5M',
      comment: `Managed by Billing - ${String(name || '').trim()}`
    };

    if (existingQueue.length > 0) {
      await queueMenu.set(queueData, existingQueue[0]['.id']);
    } else {
      await queueMenu.add(queueData);
    }

    // 2. Manage Address List for Isolation
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const existingEntry = await addrListMenu.where('address', ip).where('list', 'LIST_ISOLIR').get();

    if (isolate) {
      if (existingEntry.length === 0) {
        await addrListMenu.add({ list: 'LIST_ISOLIR', address: ip, comment: name });
      }
    } else {
      if (existingEntry.length > 0) {
        await addrListMenu.remove(existingEntry[0]['.id']);
      }
    }

    return true;
  } catch (e) {
    logger.error('Error manageStaticIp:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function removeStaticIp(ip, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // Remove Queue
    const queueMenu = conn.client.menu('/queue/simple');
    const queues = await queueMenu.where('target', `${ip}/32`).get();
    for (const q of queues) await queueMenu.remove(q['.id']);

    // Remove from Address List
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const entries = await addrListMenu.where('address', ip).where('list', 'LIST_ISOLIR').get();
    for (const e of entries) await addrListMenu.remove(e['.id']);

    return true;
  } catch (e) {
    logger.error('Error removeStaticIp:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

async function getLiveMikrotikExportViaSsh(host, user, password, port = 22, timeoutMs = 30000) {
  const { Client } = require('ssh2');
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { conn.end(); } catch {}
        reject(new Error(`Timeout (${timeoutMs}ms) saat mengambil export langsung dari MikroTik`));
      }
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec('/export compact', (err, stream) => {
        if (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { conn.end(); } catch {}
            reject(err);
          }
          return;
        }

        stream.on('data', (data) => {
          output += data.toString('utf8');
        });

        stream.stderr.on('data', (data) => {
          output += data.toString('utf8');
        });

        stream.on('close', (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { conn.end(); } catch {}
            const cleaned = stripAnsi(output).trim();
            if (cleaned.length > 200) {
              resolve(cleaned);
            } else {
              reject(new Error('Hasil export MikroTik terlalu pendek atau kosong'));
            }
          }
        });
      });
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { conn.end(); } catch {}
        reject(err);
      }
    });

    conn.connect({
      host,
      port: Number(port) || 22,
      username: user,
      password,
      readyTimeout: 10000,
      keepaliveInterval: 5000
    });
  });
}

async function getBackup(routerId = null) {
  try {
    const rid = (routerId && routerId !== 'all') ? String(routerId) : null;
    let router = null;
    if (rid) {
      router = db.prepare('SELECT * FROM routers WHERE id = ?').get(rid);
    }
    if (!router) {
      router = db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    }

    const routerName = router ? router.name : 'MikroTik';
    const routerHost = router ? router.host : '192.168.8.1';
    const routerUser = router ? router.user : 'billing';
    const routerPass = router ? router.password : '060111';
    const sshPort = Number(router?.ssh_port || 22);

    // 1. PRIORITAS UTAMA: Tarik LIVE /export compact langsung dari console MikroTik via SSH
    try {
      logger.info(`[getBackup] Mencoba menarik LIVE backup RSC langsung dari MikroTik (${routerHost}:${sshPort})...`);
      const liveRsc = await getLiveMikrotikExportViaSsh(routerHost, routerUser, routerPass, sshPort, 25000);
      if (liveRsc && liveRsc.length > 300) {
        logger.info(`[getBackup] Berhasil menarik LIVE backup RSC langsung dari MikroTik (${liveRsc.length} bytes).`);
        return liveRsc;
      }
    } catch (sshErr) {
      logger.warn(`[getBackup] Live export via SSH tidak aktif atau gagal (${sshErr.message}). Beralih ke fallback file tersimpan / database...`);
    }

    // 2. FALLBACK KEDUA: Jika router 1 (atau default) dan file hasil kurasi ROS7 tersedia di server
    const ros7RscPath = path.join(__dirname, '..', 'backup_rb4011_ros7_ready.rsc');
    const baseRscPath = path.join(__dirname, '..', 'backup_rb4011.rsc');

    if ((!rid || rid === '1') && fs.existsSync(ros7RscPath)) {
      const savedContent = fs.readFileSync(ros7RscPath, 'utf8');
      if (savedContent && savedContent.length > 500) {
        return savedContent;
      }
    } else if ((!rid || rid === '1') && fs.existsSync(baseRscPath)) {
      const savedContent = fs.readFileSync(baseRscPath, 'utf8');
      if (savedContent && savedContent.length > 500) {
        return savedContent;
      }
    }

    // 3. FALLBACK KETIGA: Generate dinamis dari Database Billing (IP Pools, Secrets, Profiles, Queues, Isolir)
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const rscLines = [];
    rscLines.push(`# ===================================================`);
    rscLines.push(`# ALIJAYANET MIKROTIK RSC BACKUP EXPORT`);
    rscLines.push(`# Router   : ${routerName} (${routerHost})`);
    rscLines.push(`# Tanggal  : ${nowStr}`);
    rscLines.push(`# Format   : RouterOS Script (.rsc) ROS7 Ready`);
    rscLines.push(`# Generator: Billing RTRW System`);
    rscLines.push(`# ===================================================\n`);

    // 1. IP Pools
    rscLines.push(`/ip pool`);
    rscLines.push(`add name=pool-pppoe ranges=192.168.10.10-192.168.10.250`);
    rscLines.push(`add name=pool-hotspot ranges=192.168.100.10-192.168.100.250`);
    rscLines.push(`add name=isolir ranges=192.168.205.10-192.168.205.250\n`);

    // 2. PPP Profiles dari packages
    const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1').all();
    rscLines.push(`/ppp profile`);
    rscLines.push(`add local-address=192.168.205.1 name=isolir rate-limit=2k/2k remote-address=isolir`);
    for (const pkg of packages) {
      const up = Number(pkg.speed_up || 0) || 0;
      const down = Number(pkg.speed_down || 0) || 0;
      const rateLimit = (up > 0 && down > 0) ? `${Math.round(up/1000)}M/${Math.round(down/1000)}M` : '5M/5M';
      rscLines.push(`add local-address=192.168.10.1 name="${pkg.name}" rate-limit="${rateLimit}" remote-address=pool-pppoe`);
    }
    rscLines.push('');

    // 3. PPP Secrets dari database customers
    const pppCustomers = db.prepare("SELECT * FROM customers WHERE connection_type = 'pppoe' AND pppoe_username IS NOT NULL AND pppoe_username != ''").all();
    if (pppCustomers.length > 0) {
      rscLines.push(`/ppp secret`);
      for (const c of pppCustomers) {
        const pkg = packages.find(p => p.id === c.package_id);
        const profile = (c.status === 'suspended' || c.status === 'isolated') ? (c.isolir_profile || 'isolir') : (pkg ? pkg.name : 'default');
        const pass = c.pppoe_password || c.pppoe_username;
        let parts = [`add name="${c.pppoe_username}" password="${pass}" profile="${profile}" service=pppoe`];
        if (c.name) parts.push(`comment="${c.name.replace(/"/g, '')} - ${c.phone || ''}"`);
        if (c.status === 'inactive') parts.push(`disabled=yes`);
        rscLines.push(parts.join(' '));
      }
      rscLines.push('');
    }

    // 4. Hotspot Profiles & Users
    rscLines.push(`/ip hotspot user profile`);
    rscLines.push(`add name=default shared-users=1`);
    for (const pkg of packages) {
      const up = Number(pkg.speed_up || 0) || 0;
      const down = Number(pkg.speed_down || 0) || 0;
      const rateLimit = (up > 0 && down > 0) ? `${Math.round(up/1000)}M/${Math.round(down/1000)}M` : '5M/5M';
      rscLines.push(`add name="${pkg.name}" rate-limit="${rateLimit}" shared-users=1`);
    }
    rscLines.push('');

    const hotspotCustomers = db.prepare("SELECT * FROM customers WHERE connection_type = 'hotspot' AND hotspot_username IS NOT NULL AND hotspot_username != ''").all();
    if (hotspotCustomers.length > 0) {
      rscLines.push(`/ip hotspot user`);
      for (const c of hotspotCustomers) {
        const pkg = packages.find(p => p.id === c.package_id);
        const profile = pkg ? pkg.name : 'default';
        const pass = c.hotspot_password || c.hotspot_username;
        rscLines.push(`add name="${c.hotspot_username}" password="${pass}" profile="${profile}" comment="${c.name.replace(/"/g, '')}"`);
      }
      rscLines.push('');
    }

    // 5. Static IP Queues
    const staticCustomers = db.prepare("SELECT * FROM customers WHERE connection_type = 'static' AND static_ip IS NOT NULL AND static_ip != ''").all();
    if (staticCustomers.length > 0) {
      rscLines.push(`/queue simple`);
      for (const c of staticCustomers) {
        const pkg = packages.find(p => p.id === c.package_id);
        const up = Number(pkg?.speed_up || 0) || 0;
        const down = Number(pkg?.speed_down || 0) || 0;
        const rateLimit = (up > 0 && down > 0) ? `${Math.round(up/1000)}M/${Math.round(down/1000)}M` : '5M/5M';
        rscLines.push(`add name="QUEUE_${c.name.replace(/"/g, '')}" target="${c.static_ip}/32" max-limit="${rateLimit}" comment="${c.name.replace(/"/g, '')}"`);
      }
      rscLines.push('');
    }

    // 6. Routing & Isolir Rules (ROS7 Ready)
    rscLines.push(`/routing table\nadd disabled=no fib name=isolir\n`);
    rscLines.push(`/ip route rule\nadd src-address=192.168.205.0/24 table=isolir\n`);
    rscLines.push(`/ip firewall nat\nadd action=masquerade chain=srcnat comment="NAT MASQUERADE DEFAULT" out-interface-list=WAN\n`);

    return rscLines.join('\r\n');
  } catch (err) {
    logger.error(`[getBackup] Error generating backup: ${err.message}`);
    return `# Gagal generate backup RSC: ${err.message}\r\n`;
  }
}

module.exports = {
  checkConnection,
  getConnection,
  getPppoeProfiles,
  getPppoeUsers,
  setPppoeProfile,
  getPppoeSecrets,
  addPppoeSecret,
  createPppoeSecret,
  updatePppoeSecret,
  deletePppoeSecret,
  getHotspotUsers,
  addHotspotUser,
  updateHotspotUser,
  deleteHotspotUser,
  getHotspotUserByName,
  setHotspotUserDisabled,
  upsertHotspotUser,
  getHotspotProfiles,
  getPppoeActive,
  getActivePppoeSessionsMap,
  getAllActiveSessionsMap,
  getHotspotActive,
  getIpPools,
  addPppoeProfile,
  updatePppoeProfile,
  deletePppoeProfile,
  getHotspotUserProfiles,
  getHotspotUserProfileById,
  addHotspotUserProfile,
  updateHotspotUserProfile,
  deleteHotspotUserProfile,
  getBackup,
  kickPppoeUser,
  kickHotspotUser,
  getSystemIdentity,
  getSystemResource,
  getSystemScripts,
  getAllRouters,
  getRouterById,
  createRouter,
  updateRouter,
  deleteRouter,
  setupIsolirFirewall,
  ensurePppProfileIsolirAddressListHook,
  generateIsolirPortalScript,
  manageStaticIp,
  removeStaticIp
};
