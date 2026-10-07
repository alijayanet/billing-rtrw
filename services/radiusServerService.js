/**
 * Service RADIUS Server (Authentication & Accounting UDP Service)
 * Menggunakan SQLite database billing.db & modul radiusPacket
 */
const dgram = require('dgram');
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const {
  CODES,
  ATTR_TYPES,
  MIKROTIK_VENDOR_ID,
  MIKROTIK_VSAS,
  decodePacket,
  encodeResponsePacket,
  verifyChapPassword
} = require('../utils/radiusPacket');

let authSocket = null;
let acctSocket = null;
let isRunning = false;

/**
 * Mencari Secret NAS berdasarkan IP NAS
 */
function getNasSecret(nasIp) {
  const defaultSecret = getSetting('radius_secret', 'secret123');
  const cleanIp = String(nasIp || '').replace(/^::ffff:/, '').trim();
  try {
    const nasRow = db.prepare(`
      SELECT secret FROM radius_nas
      WHERE is_active = 1 AND (nasname = ? OR nasname = '0.0.0.0' OR nasname = '0.0.0.0/0')
      ORDER BY CASE WHEN nasname = ? THEN 1 ELSE 2 END ASC, id DESC LIMIT 1
    `).get(cleanIp, cleanIp);

    if (nasRow && nasRow.secret) {
      return nasRow.secret;
    }
  } catch (err) {
    logger.error(`[RADIUS] Error getNasSecret: ${err.message}`);
  }
  return defaultSecret;
}

/**
 * Mencari data pelanggan / pengguna dari SQLite DB
 */
function findUserCredentials(username) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return null;

  // 1. Cek tabel customers (pppoe_username atau hotspot_username atau name atau phone)
  try {
    const cust = db.prepare(`
      SELECT c.id, c.name, c.pppoe_username, c.pppoe_password, c.status, c.static_ip, c.pppoe_remote_address, c.package_id,
             c.hotspot_username, c.hotspot_password,
             p.name as package_name, p.speed_up, p.speed_down, p.speed_up_upto, p.speed_down_upto
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.pppoe_username = ? OR c.hotspot_username = ? OR c.name = ? OR c.phone = ?
      ORDER BY 
        CASE 
          WHEN c.pppoe_username = ? THEN 1 
          WHEN c.hotspot_username = ? THEN 2
          ELSE 3 
        END ASC
      LIMIT 1
    `).get(cleanUsername, cleanUsername, cleanUsername, cleanUsername, cleanUsername, cleanUsername);

    if (cust) {
      let secret = '';
      if (cust.pppoe_username === cleanUsername) {
        secret = cust.pppoe_password || '';
      } else if (cust.hotspot_username === cleanUsername) {
        secret = cust.hotspot_password || '';
      } else {
        secret = cust.pppoe_password || cust.hotspot_password || '';
      }

      const staticIp = (cust.static_ip && cust.static_ip.trim()) || (cust.pppoe_remote_address && cust.pppoe_remote_address.trim()) || '';

      return {
        type: 'customer',
        id: cust.id,
        username: cleanUsername,
        secret: secret,
        status: cust.status,
        staticIp: staticIp,
        speedUp: cust.speed_up || 0,
        speedDown: cust.speed_down || 0,
        speedUpUpto: cust.speed_up_upto || 0,
        speedDownUpto: cust.speed_down_upto || 0,
        packageName: cust.package_name || ''
      };
    }
  } catch (err) {
    logger.error(`[RADIUS] Error findUserCredentials customers: ${err.message}`);
  }

  // 2. Cek tabel vouchers (Voucher Hotspot/PPPoE)
  try {
    const voucher = db.prepare(`
      SELECT code, password, profile_name, status FROM vouchers WHERE code = ? LIMIT 1
    `).get(cleanUsername);

    if (voucher) {
      return {
        type: 'voucher',
        id: voucher.code,
        username: voucher.code,
        secret: voucher.password || voucher.code,
        status: voucher.status === 'used' || voucher.status === 'expired' ? 'suspended' : 'active',
        speedUp: 0,
        speedDown: 0,
        speedUpUpto: 0,
        speedDownUpto: 0,
        packageName: voucher.profile_name || ''
      };
    }
  } catch (err) {
    logger.error(`[RADIUS] Error findUserCredentials vouchers: ${err.message}`);
  }

  return null;
}

/**
 * Memproses RADIUS Access-Request (Authentication)
 */
function handleAuthMessage(msg, rinfo) {
  const nasIp = rinfo.address;
  const secret = getNasSecret(nasIp);

  let reqPacket;
  try {
    reqPacket = decodePacket(msg, secret);
  } catch (err) {
    logger.warn(`[RADIUS Auth] Gagal decode paket dari ${nasIp}:${rinfo.port} - ${err.message}`);
    return;
  }

  if (reqPacket.code !== CODES.ACCESS_REQUEST) {
    return;
  }

  const username = reqPacket.parsedAttrs.username || '';
  const inputPassword = reqPacket.parsedAttrs.password || '';

  logger.info(`[RADIUS Auth] Request dari NAS ${nasIp} untuk user '${username}'`);

  const user = findUserCredentials(username);
  if (!user) {
    logger.warn(`[RADIUS Auth] Reject '${username}' - User tidak ditemukan`);
    sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
    return;
  }

  // Verifikasi Password (Mendukung PAP dan CHAP RFC 2865)
  if (reqPacket.parsedAttrs.chapPassword) {
    const challenge = reqPacket.parsedAttrs.chapChallenge || reqPacket.authenticator;
    const isChapValid = verifyChapPassword(reqPacket.parsedAttrs.chapPassword, user.secret, challenge);
    if (!isChapValid) {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Password CHAP salah`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    }
  } else if (reqPacket.parsedAttrs.password !== undefined) {
    const inputPassword = reqPacket.parsedAttrs.password;
    if (inputPassword !== user.secret) {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Password PAP salah (input: '${inputPassword}', expected: '${user.secret}')`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    }
  } else {
    logger.warn(`[RADIUS Auth] Reject '${username}' - Tidak ada atribut Password (PAP/CHAP) pada request`);
    sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
    return;
  }

  const isolirAction = getSetting('radius_isolir_action', 'pool');
  const isolirPool = getSetting('radius_isolir_pool', 'isolir');

  // Penanganan Status Terisolir / Non-Aktif
  if (user.status === 'suspended' || user.status === 'isolir' || user.status === 'inactive') {
    if (isolirAction === 'reject') {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Status terisolir`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    } else {
      const isolirAttrs = [
        { type: ATTR_TYPES.SERVICE_TYPE, value: 2 },
        { type: ATTR_TYPES.FRAMED_PROTOCOL, value: 1 }
      ];

      const isolirRateLimit = getSetting('radius_isolir_rate_limit', '512k/512k');
      const isolirIpPoolEnabled = getSetting('radius_isolir_ip_pool_enabled', '1') === '1';
      const isolirIpPoolStart = getSetting('radius_isolir_ip_pool_start', '10.10.99.2');
      const isolirIpPoolEnd = getSetting('radius_isolir_ip_pool_end', '10.10.99.254');

      let allocatedIsolirIp = null;
      if (isolirIpPoolEnabled && isolirIpPoolStart && isolirIpPoolEnd) {
        allocatedIsolirIp = allocateDynamicIp(username, isolirIpPoolStart, isolirIpPoolEnd, nasIp);
        if (allocatedIsolirIp) {
          isolirAttrs.push({ type: ATTR_TYPES.FRAMED_IP_ADDRESS, value: allocatedIsolirIp, isIp: true });
          isolirAttrs.push({ type: ATTR_TYPES.FRAMED_IP_NETMASK, value: '255.255.255.255', isIp: true });
          logger.info(`[RADIUS Auth] Isolir Dynamic IP '${allocatedIsolirIp}' dialokasikan untuk '${username}'`);
        } else if (isolirPool) {
          isolirAttrs.push({ type: ATTR_TYPES.FRAMED_POOL, value: isolirPool });
        }
      } else if (isolirPool) {
        isolirAttrs.push({ type: ATTR_TYPES.FRAMED_POOL, value: isolirPool });
      }

      if (isolirRateLimit) {
        isolirAttrs.push({
          type: ATTR_TYPES.VENDOR_SPECIFIC,
          vendorId: MIKROTIK_VENDOR_ID,
          vendorType: MIKROTIK_VSAS.RATE_LIMIT,
          value: isolirRateLimit
        });
      }

      logger.info(`[RADIUS Auth] Accept (Isolir) '${username}' - Terisolir`);
      sendAuthResponse(CODES.ACCESS_ACCEPT, reqPacket, isolirAttrs, secret, rinfo);
      return;
    }
  }

  // Hapus dummy auth-* session untuk user ini agar re-dial / re-connect tidak terblokir
  try {
    db.prepare(`
      DELETE FROM radius_accounting
      WHERE username = ? AND session_id LIKE 'auth-%'
    `).run(username);
  } catch (e) {}

  // 3. Cek Batasan Sesi Login Ganda (Simultaneous-Use / Multi-Login)
  const limitSimultaneous = getSetting('radius_limit_simultaneous', '1') === '1';
  if (limitSimultaneous) {
    const activeSession = db.prepare(`
      SELECT COUNT(1) as c FROM radius_accounting
      WHERE username = ? AND status_type IN (1, 3)
        AND session_id NOT LIKE 'auth-%'
        AND updated_at >= datetime('now', '-15 minutes')
    `).get(username)?.c || 0;

    if (activeSession >= 1) {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Sesi aktif ganda terdeteksi (User sudah online)`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    }
  }

  // Status Aktif -> Access-Accept dengan Atribut Kuota/Speed Limit
  const responseAttrs = [
    { type: ATTR_TYPES.SERVICE_TYPE, value: 2 },
    { type: ATTR_TYPES.FRAMED_PROTOCOL, value: 1 }
  ];

  // Dynamic IP Pool & Static IP Allocation
  const ipPoolEnabled = getSetting('radius_ip_pool_enabled', '1') === '1';
  const ipPoolStart = getSetting('radius_ip_pool_start', '10.10.10.2');
  const ipPoolEnd = getSetting('radius_ip_pool_end', '10.10.10.254');
  const framedPool = getSetting('radius_framed_pool', 'pool-pppoe');

  let allocatedIp = null;
  if (user.staticIp) {
    responseAttrs.push({ type: ATTR_TYPES.FRAMED_IP_ADDRESS, value: user.staticIp, isIp: true });
    responseAttrs.push({ type: ATTR_TYPES.FRAMED_IP_NETMASK, value: '255.255.255.255', isIp: true });
  } else if (ipPoolEnabled && ipPoolStart && ipPoolEnd) {
    allocatedIp = allocateDynamicIp(username, ipPoolStart, ipPoolEnd, nasIp);
    if (allocatedIp) {
      responseAttrs.push({ type: ATTR_TYPES.FRAMED_IP_ADDRESS, value: allocatedIp, isIp: true });
      responseAttrs.push({ type: ATTR_TYPES.FRAMED_IP_NETMASK, value: '255.255.255.255', isIp: true });
      logger.info(`[RADIUS Auth] Dynamic IP '${allocatedIp}' dialokasikan untuk '${username}'`);
    } else if (framedPool) {
      responseAttrs.push({ type: ATTR_TYPES.FRAMED_POOL, value: framedPool });
    }
  } else if (framedPool) {
    responseAttrs.push({ type: ATTR_TYPES.FRAMED_POOL, value: framedPool });
  }

  // Atribut Rate Limit (Mikrotik-Rate-Limit) & Mikrotik-Group (Profile)
  const defaultRateLimit = getSetting('radius_default_rate_limit', '5M/10M');
  const rateLimitStr = formatRateLimit(user.speedUp, user.speedDown, defaultRateLimit, user.speedUpUpto || 0, user.speedDownUpto || 0);
  if (rateLimitStr) {
    responseAttrs.push({
      type: ATTR_TYPES.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_VSAS.RATE_LIMIT,
      value: rateLimitStr
    });
    logger.info(`[RADIUS Auth] Rate-limit '${rateLimitStr}' dikirim untuk '${username}'`);
  }

  // Kirimkan nama paket / profile ke MikroTik via Mikrotik-Group hanya jika diset & valid
  const sendGroup = getSetting('radius_send_group', '0') === '1';
  if (sendGroup && user.packageName) {
    responseAttrs.push({
      type: ATTR_TYPES.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_VSAS.GROUP,
      value: String(user.packageName).trim()
    });
  }

  logger.info(`[RADIUS Auth] Accept '${username}' - Berhasil diautentikasi`);

  // Record instant online session entry upon Access-Accept
  try {
    const authSessionId = reqPacket.parsedAttrs.acctSessionId || `auth-${Date.now()}-${username}`;
    db.prepare(`
      INSERT INTO radius_accounting (
        username, nas_ip, framed_ip, session_id, status_type,
        calling_station_id, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, NOW_LOCAL())
    `).run(
      username,
      nasIp,
      user.staticIp || allocatedIp || '',
      authSessionId,
      reqPacket.parsedAttrs.callingStationId || ''
    );
  } catch (e) {}

  sendAuthResponse(CODES.ACCESS_ACCEPT, reqPacket, responseAttrs, secret, rinfo);
}

function sendAuthResponse(code, reqPacket, attributes, secret, rinfo) {
  try {
    const resBuf = encodeResponsePacket({
      code,
      identifier: reqPacket.identifier,
      requestAuthenticator: reqPacket.authenticator,
      attributes,
      secret
    });
    authSocket.send(resBuf, rinfo.port, rinfo.address);
  } catch (err) {
    logger.error(`[RADIUS Auth] Gagal me-reply response: ${err.message}`);
  }
}

/**
 * Memproses RADIUS Accounting-Request
 */
function handleAcctMessage(msg, rinfo) {
  const nasIp = rinfo.address;
  const secret = getNasSecret(nasIp);

  let reqPacket;
  try {
    reqPacket = decodePacket(msg, secret);
  } catch (err) {
    logger.warn(`[RADIUS Acct] Gagal decode paket dari ${nasIp}:${rinfo.port} - ${err.message}`);
    return;
  }

  if (reqPacket.code !== CODES.ACCOUNTING_REQUEST) {
    return;
  }

  const {
    username = '',
    acctStatusType = 1,
    acctSessionId = '',
    framedIp = '',
    acctInputOctets = 0,
    acctOutputOctets = 0,
    acctInputGigawords = 0,
    acctOutputGigawords = 0,
    acctSessionTime = 0,
    acctTerminateCause = 0,
    callingStationId = '',
    calledStationId = ''
  } = reqPacket.parsedAttrs;

  if (username && acctSessionId) {
    try {
      let effectiveFramedIp = framedIp;
      if (!effectiveFramedIp || effectiveFramedIp === '0.0.0.0') {
        const recentAuth = db.prepare(`
          SELECT framed_ip FROM radius_accounting
          WHERE username = ? AND framed_ip IS NOT NULL AND framed_ip != '' AND framed_ip != '0.0.0.0'
          ORDER BY id DESC LIMIT 1
        `).get(username);
        if (recentAuth && recentAuth.framed_ip) {
          effectiveFramedIp = recentAuth.framed_ip;
        } else {
          const cust = db.prepare(`SELECT static_ip FROM customers WHERE pppoe_username = ? OR name = ? LIMIT 1`).get(username, username);
          if (cust && cust.static_ip) {
            effectiveFramedIp = cust.static_ip;
          }
        }
      }

      // Upsert ke radius_accounting
      const stmt = db.prepare(`
        INSERT INTO radius_accounting (
          username, nas_ip, framed_ip, session_id, status_type,
          input_octets, output_octets, input_gigawords, output_gigawords,
          session_time, terminate_cause, calling_station_id, called_station_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW_LOCAL())
      `);

      // Cek apakah session_id sudah ada
      const existing = db.prepare(`SELECT id FROM radius_accounting WHERE session_id = ? LIMIT 1`).get(acctSessionId);
      if (existing) {
        db.prepare(`
          UPDATE radius_accounting SET
            status_type = ?,
            framed_ip = COALESCE(NULLIF(?, ''), framed_ip),
            input_octets = ?,
            output_octets = ?,
            input_gigawords = ?,
            output_gigawords = ?,
            session_time = ?,
            terminate_cause = ?,
            updated_at = NOW_LOCAL()
          WHERE session_id = ?
        `).run(
          acctStatusType,
          effectiveFramedIp,
          acctInputOctets,
          acctOutputOctets,
          acctInputGigawords,
          acctOutputGigawords,
          acctSessionTime,
          acctTerminateCause,
          acctSessionId
        );
      } else {
        // Hapus entri auth-* dummy lama dan tutup sesi aktif lama untuk user ini
        try {
          db.prepare(`DELETE FROM radius_accounting WHERE username = ? AND session_id LIKE 'auth-%'`).run(username);
          db.prepare(`
            UPDATE radius_accounting 
            SET status_type = 2, terminate_cause = 1, updated_at = NOW_LOCAL() 
            WHERE username = ? AND session_id != ? AND status_type IN (1, 3)
          `).run(username, acctSessionId);
        } catch (e) {}

        stmt.run(
          username, nasIp, effectiveFramedIp, acctSessionId, acctStatusType,
          acctInputOctets, acctOutputOctets, acctInputGigawords, acctOutputGigawords,
          acctSessionTime, acctTerminateCause, callingStationId, calledStationId
        );
      }

      // Hitung total bytes termasuk Gigawords (untuk sesi > 4GB)
      const totalBytesIn = (acctInputGigawords * 4294967296) + acctInputOctets;
      const totalBytesOut = (acctOutputGigawords * 4294967296) + acctOutputOctets;

      // Catat sampel pemakaian ke customer_usage jika terdaftar di customers
      try {
        const cust = db.prepare(`SELECT id FROM customers WHERE pppoe_username = ? OR name = ? LIMIT 1`).get(username, username);
        if (cust) {
          const now = new Date();
          const month = now.getMonth() + 1;
          const year = now.getFullYear();
          db.prepare(`
            INSERT INTO customer_usage (customer_id, period_month, period_year, bytes_in, bytes_out, updated_at)
            VALUES (?, ?, ?, ?, ?, NOW_LOCAL())
            ON CONFLICT(customer_id, period_month, period_year) DO UPDATE SET
              bytes_in = MAX(customer_usage.bytes_in, excluded.bytes_in),
              bytes_out = MAX(customer_usage.bytes_out, excluded.bytes_out),
              updated_at = NOW_LOCAL()
          `).run(cust.id, month, year, totalBytesIn, totalBytesOut);
        }
      } catch (e) {}
    } catch (err) {
      logger.error(`[RADIUS Acct] Gagal simpan accounting: ${err.message}`);
    }
  }

  // Kirim Accounting-Response
  try {
    const resBuf = encodeResponsePacket({
      code: CODES.ACCOUNTING_RESPONSE,
      identifier: reqPacket.identifier,
      requestAuthenticator: reqPacket.authenticator,
      attributes: [],
      secret
    });
    acctSocket.send(resBuf, rinfo.port, rinfo.address);
  } catch (err) {
    logger.error(`[RADIUS Acct] Gagal me-reply Accounting-Response: ${err.message}`);
  }
}

/**
 * Menjalankan Server RADIUS (UDP Auth & Acct)
 */
function start() {
  if (isRunning) return;

  const authPort = parseInt(getSetting('radius_auth_port', 1812), 10) || 1812;
  const acctPort = parseInt(getSetting('radius_acct_port', 1813), 10) || 1813;

  try {
    authSocket = dgram.createSocket('udp4');
    authSocket.on('message', handleAuthMessage);
    authSocket.on('error', (err) => logger.error(`[RADIUS Auth Error] ${err.message}`));
    authSocket.bind(authPort, () => {
      logger.info(`[RADIUS] Auth Server mendengarkan pada port UDP ${authPort}`);
    });

    acctSocket = dgram.createSocket('udp4');
    acctSocket.on('message', handleAcctMessage);
    acctSocket.on('error', (err) => logger.error(`[RADIUS Acct Error] ${err.message}`));
    acctSocket.bind(acctPort, () => {
      logger.info(`[RADIUS] Accounting Server mendengarkan pada port UDP ${acctPort}`);
    });

    isRunning = true;
  } catch (err) {
    logger.error(`[RADIUS] Gagal menjalankan server RADIUS: ${err.message}`);
  }
}

/**
 * Menghentikan Server RADIUS
 */
function stop() {
  if (!isRunning) return;
  try {
    if (authSocket) authSocket.close();
    if (acctSocket) acctSocket.close();
  } catch (e) {}
  authSocket = null;
  acctSocket = null;
  isRunning = false;
  logger.info(`[RADIUS] Server RADIUS telah dihentikan.`);
}

/**
 * Format Mikrotik-Rate-Limit string dari nilai kecepatan paket.
 * 
 * PENTING: Format MikroTik Rate-Limit menggunakan perspektif CLIENT:
 * - RX (Receive) = Download = Data yang DITERIMA client dari internet
 * - TX (Transmit) = Upload = Data yang DIKIRIM client ke internet
 * 
 * Format standar: "rx-rate/tx-rate" atau lebih lengkap dengan burst:
 * "rx-rate/tx-rate rx-burst/tx-burst rx-threshold/tx-threshold burst-time"
 * 
 * Contoh: "10M/5M" = Download 10Mbps / Upload 5Mbps
 * Contoh burst: "10M/5M 20M/10M 10M/5M 8" = CIR 10M/5M, Burst 20M/10M, Threshold 10M/5M, Time 8s
 * 
 * @param {number} upVal - Kecepatan UPLOAD dalam Kbps (TX)
 * @param {number} downVal - Kecepatan DOWNLOAD dalam Kbps (RX)
 * @param {string} defaultVal - Nilai default jika speed tidak valid
 * @param {number} uptoUp - Burst UPLOAD dalam Kbps (TX-burst)
 * @param {number} uptoDown - Burst DOWNLOAD dalam Kbps (RX-burst)
 * @returns {string} Format MikroTik Rate-Limit: "rx-rate/tx-rate" atau dengan burst
 */
function formatRateLimit(upVal, downVal, defaultVal = '5M/10M', uptoUp = 0, uptoDown = 0) {
  function parseSpeed(v) {
    if (!v) return 0;
    const str = String(v).trim().toLowerCase();
    // Jika sudah dalam Kbps mentah (angka tanpa satuan — dari DB yang menyimpan dalam Kbps)
    if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000);
    if (str.endsWith('k')) return Math.round(parseFloat(str));
    const num = parseFloat(str) || 0;
    return num;
  }

  function kbpsToStr(kbps) {
    if (kbps <= 0) return null;
    if (kbps >= 1000 && kbps % 1000 === 0) return `${kbps / 1000}M`;
    return `${kbps}k`;
  }

  const upKbps = parseSpeed(upVal);      // Client Upload -> Router RX
  const downKbps = parseSpeed(downVal);  // Client Download -> Router TX

  if (upKbps <= 0 || downKbps <= 0) {
    return defaultVal;
  }

  // Format MikroTik RouterOS: rx-rate/tx-rate (Upload/Download)
  const rxStr = kbpsToStr(upKbps);    // rx-rate = Upload (client to router)
  const txStr = kbpsToStr(downKbps);  // tx-rate = Download (router to client)

  // Tambahkan burst rate jika tersedia (format: rx/tx rx-burst/tx-burst rx-threshold/tx-threshold burst-time)
  const uptoUpKbps = parseSpeed(uptoUp);      // Burst Upload
  const uptoDownKbps = parseSpeed(uptoDown);  // Burst Download

  if (uptoUpKbps > 0 && uptoDownKbps > 0 && (uptoUpKbps > upKbps || uptoDownKbps > downKbps)) {
    const rxBurstStr = kbpsToStr(uptoUpKbps);
    const txBurstStr = kbpsToStr(uptoDownKbps);
    
    // Threshold default 50% dari burst, waktu burst 8 detik
    const rxThresholdStr = kbpsToStr(Math.round(uptoUpKbps * 0.5));
    const txThresholdStr = kbpsToStr(Math.round(uptoDownKbps * 0.5));
    
    return `${rxStr}/${txStr} ${rxBurstStr}/${txBurstStr} ${rxThresholdStr}/${txThresholdStr} 8`;
  }

  // Format standar: rx/tx (Upload/Download)
  return `${rxStr}/${txStr}`;
}

function ipToInt(ip) {
  if (!ip) return 0;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int) {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255
  ].join('.');
}

function allocateDynamicIp(username, startIpStr, endIpStr, nasIp) {
  try {
    const startInt = ipToInt(startIpStr);
    const endInt = ipToInt(endIpStr);
    if (!startInt || !endInt || startInt > endInt) return null;

    // Direct check if user has active session with framed_ip within requested pool range
    const userSession = db.prepare(`
      SELECT framed_ip FROM radius_accounting
      WHERE username = ? AND status_type IN (1, 3) AND framed_ip IS NOT NULL AND framed_ip != ''
      ORDER BY id DESC LIMIT 1
    `).get(username);
    if (userSession && userSession.framed_ip) {
      const sessInt = ipToInt(userSession.framed_ip);
      if (sessInt >= startInt && sessInt <= endInt) {
        return userSession.framed_ip;
      }
    }

    const assignedRows = db.prepare(`
      SELECT framed_ip FROM radius_accounting
      WHERE status_type IN (1, 3) AND framed_ip IS NOT NULL AND framed_ip != ''
    `).all();
    const usedIps = new Set(assignedRows.map(r => r.framed_ip));

    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
    }
    const range = (endInt - startInt + 1);
    const preferredInt = startInt + (hash % range);
    const preferredIp = intToIp(preferredInt);

    if (!usedIps.has(preferredIp)) {
      return preferredIp;
    }

    for (let current = startInt; current <= endInt; current++) {
      const candidateIp = intToIp(current);
      if (!usedIps.has(candidateIp)) {
        return candidateIp;
      }
    }
  } catch (err) {
    logger.error(`[RADIUS Dynamic IP] Error allocating IP: ${err.message}`);
  }
  return null;
}

function getStatus() {
  return {
    enabled: getSetting('radius_enabled', '0') === '1',
    running: isRunning,
    authPort: parseInt(getSetting('radius_auth_port', 1812), 10) || 1812,
    acctPort: parseInt(getSetting('radius_acct_port', 1813), 10) || 1813,
    secret: getSetting('radius_secret', 'secret123'),
    isolirAction: getSetting('radius_isolir_action', 'pool'),
    isolirPool: getSetting('radius_isolir_pool', 'isolir'),
    isolirRateLimit: getSetting('radius_isolir_rate_limit', '512k/512k'),
    isolirIpPoolEnabled: getSetting('radius_isolir_ip_pool_enabled', '1') === '1',
    isolirIpPoolStart: getSetting('radius_isolir_ip_pool_start', '10.10.99.2'),
    isolirIpPoolEnd: getSetting('radius_isolir_ip_pool_end', '10.10.99.254'),
    limitSimultaneous: getSetting('radius_limit_simultaneous', '1') === '1',
    defaultRateLimit: getSetting('radius_default_rate_limit', '5M/10M'),
    ipPoolEnabled: getSetting('radius_ip_pool_enabled', '1') === '1',
    ipPoolStart: getSetting('radius_ip_pool_start', '10.10.10.2'),
    ipPoolEnd: getSetting('radius_ip_pool_end', '10.10.10.254'),
    framedPool: getSetting('radius_framed_pool', 'pool-pppoe')
  };
}

function getOnlineSessions() {
  try {
    return db.prepare(`
      SELECT ra.*, c.name as customer_name
      FROM radius_accounting ra
      LEFT JOIN customers c ON (c.pppoe_username = ra.username OR c.name = ra.username)
      WHERE ra.status_type IN (1, 3)
        AND ra.updated_at >= datetime('now', '-24 hours')
      ORDER BY ra.updated_at DESC LIMIT 200
    `).all();
  } catch (e) {
    return [];
  }
}

function getAccountingLogs(limit = 100) {
  try {
    return db.prepare(`
      SELECT * FROM radius_accounting
      ORDER BY id DESC LIMIT ?
    `).all(limit);
  } catch (e) {
    return [];
  }
}

async function disconnectSession(username, sessionId, nasIp) {
  try {
    const mikrotikSvc = require('./mikrotikService');
    
    // 1. Clear session entry from radius_accounting database table
    if (sessionId) {
      db.prepare(`
        UPDATE radius_accounting
        SET status_type = 2, updated_at = NOW_LOCAL()
        WHERE session_id = ? OR (username = ? AND status_type IN (1, 3))
      `).run(sessionId, username);
    } else {
      db.prepare(`
        UPDATE radius_accounting
        SET status_type = 2, updated_at = NOW_LOCAL()
        WHERE username = ? AND status_type IN (1, 3)
      `).run(username);
    }

    // 2. Disconnect active session from MikroTik via API
    let routerId = null;
    if (nasIp) {
      const r = db.prepare('SELECT id FROM routers WHERE host = ?').get(nasIp);
      if (r) routerId = r.id;
    }
    
    await mikrotikSvc.kickPppoeUser(username, routerId);
    return true;
  } catch (err) {
    logger.error(`[RADIUS Disconnect] Error disconnecting user '${username}': ${err.message}`);
    return false;
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  getOnlineSessions,
  getAccountingLogs,
  disconnectSession
};
