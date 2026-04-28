const snmp = require('net-snmp');
const net = require('net');
const Database = require('better-sqlite3');
const path = require('path');
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const dbPath = path.join(__dirname, '../database/billing.db');
const db = new Database(dbPath);

/**
 * Profil SNMP per brand OLT
 * Setiap profil mendefinisikan OID tabel untuk status, nama, dan cara deteksi.
 */
const BRAND_PROFILES = {
  hioso: [
    {
      name: 'HIOSO_EPON_C',
      status_table: '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
      name_table:   '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
      sn_table:     '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
      tx_power_table: '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
      rx_power_table: '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
      probe_oid:    '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
    },
    {
      name: 'HIOSO_EPON_B',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
    {
      name: 'HIOSO_GPON',
      status_table: '1.3.6.1.4.1.25355.3.3.1.1.1.11',
      name_table:   '1.3.6.1.4.1.25355.3.3.1.1.1.2',
      sn_table:     '1.3.6.1.4.1.25355.3.3.1.1.1.5',
      tx_power_table: '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
      rx_power_table: '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
      probe_oid:    '1.3.6.1.4.1.25355.3.3.1.1.1.11',
    },
  ],
  hsgq: [
    {
      name: 'HSGQ_EPON',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
  ],
  zte: [
    {
      name: 'ZTE_C300',
      status_table: '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
      name_table:   '1.3.6.1.4.1.3902.1012.3.28.1.1.3',
      probe_oid:    '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
      is_counter: true,
    },
  ],
  vsol: [
    {
      name: 'VSOL_EPON',
      status_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
      name_table:   '1.3.6.1.4.1.37950.1.1.5.13.1.1.10',
      sn_table:     '1.3.6.1.4.1.37950.1.1.5.13.1.1.2',
      rx_power_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
    },
  ],
  huawei: [
    {
      name: 'HUAWEI_GPON',
      status_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
      name_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
      sn_table:     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.1',
      rx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4', // 0.01 dBm
      probe_oid:    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
    }
  ],
  cdata: [
    {
      name: 'CDATA_EPON',
      status_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
      name_table:   '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.10',
      sn_table:     '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.10',
      rx_power_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
    }
  ]
};

// Nilai status yang dianggap "online" per brand
const ONLINE_VALUES = {
  hioso: [1, 3, 4],
  hsgq:  [1, 3, 4],
  zte:   [],
  vsol:  [1],
  huawei: [5], // 5: operation
  cdata: [1, 3],
};

const getOnlineValues = (brandKey, profile) => {
  const base = ONLINE_VALUES[brandKey] || [1, 3];
  const profileName = String(profile?.name || '').toLowerCase();
  const nameOid = String(profile?.name_table || '');
  const isHiosoGpon = (brandKey === 'hioso' || brandKey === 'hsgq')
    && (profileName.includes('gpon') || nameOid.includes('.25355.3.3.'));
  if (isHiosoGpon) return [2, 3, 4];
  return base;
};

/**
 * OID sistem per brand untuk mengambil metrics hardware.
 * Semua diambil dengan snmp.get (bukan walk).
 */
const SYSTEM_OIDS = {
  hioso: {
    temp:      '1.3.6.1.4.1.25355.3.2.1.1.1.0',  // Suhu (°C)
    cpu:       '1.3.6.1.4.1.25355.3.2.1.1.2.0',  // CPU Usage (%)
    ram:       '1.3.6.1.4.1.25355.3.2.1.1.3.0',  // RAM Usage (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',       // ifHCInOctets (uplink port 1)
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',      // ifHCOutOctets (uplink port 1)
  },
  hsgq: {
    temp:      '1.3.6.1.4.1.25355.3.2.1.1.1.0',
    cpu:       '1.3.6.1.4.1.25355.3.2.1.1.2.0',
    ram:       '1.3.6.1.4.1.25355.3.2.1.1.3.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  zte: {
    temp:      '1.3.6.1.4.1.3902.1012.3.1.1.1.2.1',
    cpu:       '1.3.6.1.4.1.3902.1012.3.1.1.1.1.1',
    ram:       '1.3.6.1.4.1.3902.1012.3.1.1.1.3.1',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  vsol: {
    temp:      '1.3.6.1.4.1.37950.1.1.5.1.1.11',
    cpu:       '1.3.6.1.4.1.37950.1.1.5.1.1.2',
    ram:       '1.3.6.1.4.1.37950.1.1.5.1.1.4',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  huawei: {
    temp:      '1.3.6.1.4.1.2011.6.128.1.1.2.2.1.2.0',
    cpu:       '1.3.6.1.4.1.2011.6.128.1.1.2.2.1.3.0',
    ram:       '1.3.6.1.4.1.2011.6.128.1.1.2.2.1.4.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  cdata: {
    temp:      '1.3.6.1.4.1.34592.1.3.100.1.1.1.2.0',
    cpu:       '1.3.6.1.4.1.34592.1.3.100.1.1.1.3.0',
    ram:       '1.3.6.1.4.1.34592.1.3.100.1.1.1.4.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
};

// ─── DB CRUD ────────────────────────────────────────────────────────────────

function getAllOlts() {
  return db.prepare('SELECT * FROM olts ORDER BY created_at DESC').all();
}

function getActiveOlts() {
  return db.prepare('SELECT * FROM olts WHERE is_active = 1').all();
}

function getOltById(id) {
  return db.prepare('SELECT * FROM olts WHERE id = ?').get(id);
}

function createOlt(data) {
  const stmt = db.prepare(`
    INSERT INTO olts (name, host, snmp_community, snmp_port, brand, description, is_active, web_user, web_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.host,
    data.snmp_community || 'public',
    data.snmp_port || 161,
    data.brand || 'hioso',
    data.description || '',
    data.is_active !== undefined ? data.is_active : 1,
    data.web_user || '',
    data.web_password || ''
  );
}

function updateOlt(id, data) {
  const stmt = db.prepare(`
    UPDATE olts 
    SET name = ?, host = ?, snmp_community = ?, snmp_port = ?, brand = ?, description = ?, is_active = ?, web_user = ?, web_password = ?
    WHERE id = ?
  `);
  return stmt.run(
    data.name,
    data.host,
    data.snmp_community,
    data.snmp_port,
    data.brand,
    data.description,
    data.is_active ? 1 : 0,
    data.web_user || '',
    data.web_password || '',
    id
  );
}

function deleteOlt(id) {
  return db.prepare('DELETE FROM olts WHERE id = ?').run(id);
}

// ─── SNMP HELPERS ────────────────────────────────────────────────────────────

/**
 * Normalisasi OID: hapus prefix 'iso.' atau awalan '1.' yang ganda
 */
const normalizeOid = (oid) => {
  if (!oid) return '';
  return oid.replace(/^iso\./, '1.').replace(/^\./, '');
};

/**
 * Ekstrak suffix index dari OID yang di-walk
 */
const extractIdx = (rawOid, baseOid) => {
  const normRaw  = normalizeOid(rawOid);
  const normBase = normalizeOid(baseOid);
  if (normRaw.startsWith(normBase + '.')) {
    return normRaw.substring(normBase.length + 1);
  }
  if (normRaw.startsWith(normBase)) {
    return normRaw.substring(normBase.length).replace(/^\./, '');
  }
  // fallback
  return rawOid.split('.').slice(-1)[0];
};

/**
 * Cek apakah OID yang di-return masih di bawah baseOid
 */
const oidUnderBase = (rawOid, baseOid) => {
  const normRaw  = normalizeOid(rawOid);
  const normBase = normalizeOid(baseOid);
  return normRaw.startsWith(normBase + '.') || normRaw === normBase;
};

const decodeSn = (val) => {
  if (!val) return 'N/A';
  if (Buffer.isBuffer(val)) {
    const ascii = val.toString('utf8').replace(/\0/g, '').trim();
    const looksAscii = ascii.length >= 4 && /^[\x20-\x7E]+$/.test(ascii);
    if (looksAscii) return ascii.toUpperCase();
    return val.toString('hex').toUpperCase();
  }
  return val.toString().toUpperCase();
};

const decodeUptime = (ticks) => {
  if (!ticks) return 'N/A';
  let seconds = Math.floor(ticks / 100);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  return `${days}d ${hours}h ${minutes}m`;
};

const hiosoOnuIdFromIndex = (index) => {
  if (index == null) return null;
  const s = String(index).trim();
  if (!s) return null;

  if (s.includes('.')) {
    const parts = s.split('.').filter(Boolean);
    if (parts.length >= 2) {
      const onu = parseInt(parts[parts.length - 1], 10);
      const port = parseInt(parts[parts.length - 2], 10);
      if (Number.isFinite(port) && Number.isFinite(onu)) return `0/${port}:${onu}`;
    }
    return null;
  }

  const intIdx = parseInt(s, 10);
  if (!Number.isFinite(intIdx)) return null;
  let port = (intIdx >> 16) & 0xff;
  if (port === 0 || port > 16) port = (intIdx >> 8) & 0xff;
  const onu = intIdx & 0xff;
  if (port === 0) return null;
  return `0/${port}:${onu}`;
};

const telnetReadUntil = (socket, matcher, timeoutMs) => {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.includes('--More--') || buf.includes('--Press Enter--')) {
        socket.write(' ');
      }
      if (typeof matcher === 'function' ? matcher(buf) : matcher.test(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('Telnet connection closed')); };
    const t = setTimeout(() => { cleanup(); reject(new Error('Telnet timeout')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
};

const telnetLoginAndRun = async (host, user, pass, commands) => {
  const socket = new net.Socket();
  socket.setTimeout(15000);

  await new Promise((resolve, reject) => {
    socket.connect(23, host, resolve);
    socket.once('error', reject);
  });

  const promptRe = /[>#]\s*$/m;
  const loginRe = /(login|username)\s*[:>]\s*$/im;
  const passRe = /(password|passwd)\s*[:>]\s*$/im;

  let banner = '';
  try {
    banner = await telnetReadUntil(socket, (b) => loginRe.test(b) || passRe.test(b) || promptRe.test(b), 8000);
  } catch (e) {
    socket.destroy();
    throw e;
  }

  if (loginRe.test(banner)) {
    socket.write(String(user || 'admin') + '\r\n');
    await telnetReadUntil(socket, passRe, 8000);
    socket.write(String(pass || 'admin') + '\r\n');
    await telnetReadUntil(socket, promptRe, 8000);
  } else if (passRe.test(banner)) {
    socket.write(String(pass || 'admin') + '\r\n');
    await telnetReadUntil(socket, promptRe, 8000);
  } else if (promptRe.test(banner)) {
  } else {
    socket.destroy();
    throw new Error('Telnet prompt not detected');
  }

  const outputs = [];
  for (const cmd of commands) {
    socket.write(cmd + '\r\n');
    const out = await telnetReadUntil(socket, promptRe, 15000);
    outputs.push(out);
  }

  socket.end();
  socket.destroy();
  return outputs.join('\n');
};

const parseHiosoOnuTable = (text) => {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const rows = [];

  for (const line of lines) {
    const t = line.trim();
    if (!/^0\/\d+:\d+/.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 22) continue;

    const id = parts[0];
    const name = parts[1];
    const mac = parts[2];
    const status = parts[3];
    const fwVersion = parts[4];
    const chipId = parts[5];
    const ports = parts[6];
    const rtt = parts[7];
    const distance = parts[8];
    const ctcStatus = parts[9];
    const ctcVer = parts[10];
    const activate = parts[11];
    const temperature = parts[12];
    const txPower = parts[13];
    const rxPower = parts[14];
    const onlineTime = parts[15] + ' ' + parts[16];
    const offlineTime = parts[17] + ' ' + parts[18];
    const offlineReason = parts[19];
    const deregisterCnt = parts[parts.length - 1];
    const online = parts.slice(20, parts.length - 1).join(' ');

    rows.push({
      id,
      name: name === 'NA' ? null : name,
      mac,
      status,
      fwVersion,
      chipId,
      ports,
      rtt,
      distance,
      ctcStatus,
      ctcVer,
      activate,
      temperature,
      txPower,
      rxPower,
      onlineTime,
      offlineTime,
      offlineReason,
      online,
      deregisterCnt,
    });
  }

  return rows;
};

const fetchHiosoOnuDetailViaTelnet = async (olt) => {
  const user = olt.web_user || 'admin';
  const pass = olt.web_password || 'admin';
  const cmds = [
    'show onu',
    'show onu all',
    'show onu info',
    'show onu status',
  ];

  try {
    const out = await telnetLoginAndRun(olt.host, user, pass, cmds);
    const rows = parseHiosoOnuTable(out);
    return rows.length > 0 ? rows : null;
  } catch (e) {
    return null;
  }
};

// ─── CORE SNMP FUNCTIONS ─────────────────────────────────────────────────────

/**
 * Lakukan SNMP getNext (walk manual) untuk satu OID base.
 * Kembalikan object { index: value }.
 */
const slowWalk = async (session, baseOid, maxEntries = 5000) => {
  let currentOid = baseOid;
  let walkCount  = 0;
  const results  = {};

  while (true) {
    try {
      const vb = await new Promise((rv, rj) => {
        session.getNext([currentOid], (err, vbs) => {
          if (err) rj(err);
          else rv(vbs[0]);
        });
      });

      // Berhenti jika tidak ada data, error, atau OID sudah keluar dari subtree
      if (!vb || vb.oid == null) break;
      if (vb.type === snmp.ObjectType.EndOfMibView || vb.type === snmp.ObjectType.NoSuchObject || vb.type === snmp.ObjectType.NoSuchInstance) break;
      if (!oidUnderBase(vb.oid, baseOid)) break;

      const idx = extractIdx(vb.oid, baseOid);
      results[idx] = vb.value;
      currentOid = normalizeOid(vb.oid);
      walkCount++;

      if (walkCount >= maxEntries) break;
    } catch (e) {
      break;
    }
  }

  return results;
};

const walkSample = async (session, baseOid, maxItems = 3) => {
  let currentOid = baseOid;
  let count = 0;
  const values = [];

  while (count < maxItems) {
    try {
      const vb = await new Promise((rv, rj) => {
        session.getNext([currentOid], (err, vbs) => {
          if (err) rj(err);
          else rv(vbs[0]);
        });
      });

      if (!vb || vb.oid == null) break;
      if (vb.type === snmp.ObjectType.EndOfMibView || vb.type === snmp.ObjectType.NoSuchObject || vb.type === snmp.ObjectType.NoSuchInstance) break;
      if (!oidUnderBase(vb.oid, baseOid)) break;

      values.push(vb.value);
      currentOid = normalizeOid(vb.oid);
      count++;
    } catch (e) {
      break;
    }
  }

  return values;
};

/**
 * Test apakah sebuah OID probe memberikan respons SNMP getNext yang valid
 */
const probeOid = async (session, oid) => {
  try {
    const vb = await new Promise((rv, rj) => {
      session.getNext([oid], (err, vbs) => {
        if (err) rj(err);
        else rv(vbs[0]);
      });
    });
    if (!vb || vb.type === snmp.ObjectType.EndOfMibView || vb.type === snmp.ObjectType.NoSuchObject) return false;
    // Cek apakah hasil masih di bawah OID ini atau sub-treenya ada data
    return oidUnderBase(vb.oid, oid);
  } catch (e) {
    return false;
  }
};

/**
 * Ambil satu atau beberapa OID sekaligus menggunakan snmp.get.
 * Kembalikan array nilai (atau null jika error/tidak ada).
 */
const snmpGet = async (session, oids) => {
  try {
    const vbs = await new Promise((rv, rj) => {
      session.get(oids, (err, result) => {
        if (err) rj(err);
        else rv(result);
      });
    });
    return vbs.map(vb => {
      if (!vb || vb.type === snmp.ObjectType.NoSuchObject ||
          vb.type === snmp.ObjectType.NoSuchInstance ||
          vb.type === snmp.ObjectType.EndOfMibView) return null;
      return vb.value;
    });
  } catch (e) {
    return oids.map(() => null);
  }
};

const bufferToInt = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') {
    if (val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(val);
    return null;
  }
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  if (Buffer.isBuffer(val)) {
    if (val.length === 1) return val.readUInt8(0);
    if (val.length === 2) return val.readInt16BE(0);
    if (val.length === 4) return val.readInt32BE(0);
    if (val.length === 8) {
      try {
        const bi = val.readBigUInt64BE(0);
        if (bi <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(bi);
      } catch (e) {}
      return null;
    }
    const s = val.toString();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const bufferToCounterBigInt = (val) => {
  if (val == null) return null;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return BigInt(Math.max(0, Math.floor(val)));
  }
  if (typeof val === 'string') {
    try {
      if (val.trim() === '') return null;
      return BigInt(val);
    } catch (e) {
      return null;
    }
  }
  if (Buffer.isBuffer(val)) {
    if (val.length === 8) {
      try { return val.readBigUInt64BE(0); } catch (e) { return null; }
    }
    if (val.length === 4) {
      try { return BigInt(val.readUInt32BE(0)); } catch (e) { return null; }
    }
    const s = val.toString();
    try { return BigInt(s); } catch (e) { return null; }
  }
  return null;
};

const getByIdx = (map, idx) => {
  if (!map) return undefined;
  if (map[idx] != null) return map[idx];

  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;

  const idxParts = String(idx).split('.').filter(Boolean);
  const maxSegments = Math.min(6, idxParts.length);

  for (let seg = 2; seg <= maxSegments; seg++) {
    const suffix = '.' + idxParts.slice(-seg).join('.');
    const matches = keys.filter(k => k.endsWith(suffix));
    if (matches.length === 1) return map[matches[0]];
  }

  return undefined;
};

const toSigned16 = (n) => {
  if (!Number.isFinite(n)) return null;
  const u = n & 0xffff;
  return u > 0x7fff ? u - 0x10000 : u;
};

const pickFirstPlausible = (candidates) => {
  for (const v of candidates) {
    if (!Number.isFinite(v)) continue;
    if (v < -50 || v > 10) continue;
    if (v > 0) continue;
    return v;
  }
  return null;
};

const computeRxDbm = (brand, raw) => {
  const signal = parseSignal(raw);
  if (signal != null) return signal;

  const n = bufferToInt(raw);
  if (n == null) return null;
  if (n === 0 || n === 65535) return null;

  const signed = (n >= 0 && n <= 65535) ? toSigned16(n) : n;
  if (signed == null) return null;

  if (typeof signed === 'number' && signed < 0 && signed >= -60 && signed <= 10) return signed;

  const ordered = brand === 'huawei'
    ? [signed / 100, signed / 10, signed / 1000, (signed / 100) - 100, (signed / 10) - 100]
    : [signed / 10, signed / 100, signed / 1000, (signed / 10) - 100, (signed / 100) - 100];

  const picked = pickFirstPlausible(ordered);
  if (picked != null) return picked;

  const fallback = pickFirstPlausible([signed / 10, signed / 100, signed / 1000]);
  return fallback;
};

const safeToString = (val) => {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'bigint') return val.toString();
  if (Buffer.isBuffer(val)) return val.toString();
  return String(val);
};

const walkValues = async (session, baseOid) => Object.values(await slowWalk(session, baseOid));

const isLikelySn = (sample) => {
  if (sample == null) return false;
  let s = safeToString(sample);
  if (!s) return false;
  s = s.replace(/["']/g, '').replace(/\s+/g, '').trim();
  if (s.length < 6) return false;
  if (/(registered|offline|active|online|down|up|power|alarm)/i.test(s)) return false;
  return true;
};

const pickSnTable = async (session, activeProfile) => {
  const nameOid = activeProfile.name_table || '';
  const lastDot = nameOid.lastIndexOf('.');
  const parentBranch = lastDot > 0 ? nameOid.slice(0, lastDot) : nameOid;

  const candidates = [
    activeProfile.sn_table,
    `${parentBranch}.11`,
    '1.3.6.1.4.1.25355.3.2.10.1.1.2',
    `${parentBranch}.12`,
    `${parentBranch}.2`,
    '1.3.6.1.4.1.25355.3.2.1.2.1.2',
    '1.3.6.1.4.1.25355.3.2.6.1.1.18',
    '1.3.6.1.4.1.25355.3.2.6.3.2.1.12',
    '1.3.6.1.4.1.25355.3.2.6.1.1.2.1.6',
    '1.3.6.1.4.1.25355.3.3.1.1.1.5',
    '1.3.6.1.4.1.3320.101.10.1.1.3',
  ].filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const oid of candidates) {
    const n = normalizeOid(oid);
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(oid);
  }

  for (const oid of unique) {
    const samples = await walkSample(session, oid, 2);
    if (samples.length === 0) continue;
    if (!isLikelySn(samples[0])) continue;
    const m = await slowWalk(session, oid);
    return { oid, map: m };
  }

  return { oid: activeProfile.sn_table || null, map: {} };
};

const parseSignal = (val) => {
  if (val == null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'bigint') return null;
  const s = safeToString(val);
  if (!s) return null;
  const m = s.match(/[-+]?\d*\.?\d+/);
  if (!m) return null;
  const num = Number(m[0]);
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  if (abs > 500) return num / 100;
  if (abs > 50) return num / 10;
  return num;
};

const getHrCpuPercent = async (session) => {
  const values = await walkValues(session, '1.3.6.1.2.1.25.3.3.1.2');
  const nums = values.map(v => bufferToInt(v)).filter(v => Number.isFinite(v));
  if (nums.length === 0) return null;
  const avg = nums.reduce((s, v) => s + v, 0) / nums.length;
  return Math.max(0, Math.min(100, Math.round(avg)));
};

const getHrRamPercent = async (session) => {
  const descrMap = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.3');
  const typeMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.2');
  const sizeMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.5');
  const usedMap  = await slowWalk(session, '1.3.6.1.2.1.25.2.3.1.6');

  const hrStorageRamType = '1.3.6.1.2.1.25.2.1.2';

  const indices = new Set([
    ...Object.keys(descrMap),
    ...Object.keys(typeMap),
    ...Object.keys(sizeMap),
    ...Object.keys(usedMap),
  ]);

  let best = null;

  for (const idx of indices) {
    const descr = (safeToString(descrMap[idx]) || '').toLowerCase();
    const type  = safeToString(typeMap[idx]) || '';
    const size  = bufferToInt(sizeMap[idx]);
    const used  = bufferToInt(usedMap[idx]);
    if (!Number.isFinite(size) || !Number.isFinite(used) || size <= 0) continue;

    const isRam = type.includes(hrStorageRamType) || descr.includes('ram') || descr.includes('memory') || descr.includes('mem');
    if (!isRam) continue;

    const pct = Math.round((used / size) * 100);
    const entry = { pct, size, used };
    if (!best) best = entry;
    else if (entry.size > best.size) best = entry;
  }

  if (!best) return null;
  return Math.max(0, Math.min(100, best.pct));
};

const getEntityTemperatureC = async (session) => {
  const typeMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.1');
  const valueMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.4');
  const precisionMap = await slowWalk(session, '1.3.6.1.2.1.99.1.1.1.3');

  const indices = new Set([
    ...Object.keys(typeMap),
    ...Object.keys(valueMap),
    ...Object.keys(precisionMap),
  ]);

  const candidates = [];

  for (const idx of indices) {
    const t = bufferToInt(typeMap[idx]);
    if (t !== 8) continue;
    const v = bufferToInt(valueMap[idx]);
    const p = bufferToInt(precisionMap[idx]);
    if (!Number.isFinite(v) || !Number.isFinite(p)) continue;
    const c = v / Math.pow(10, p);
    if (Number.isFinite(c) && c >= -20 && c <= 120) candidates.push(c);
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b - a);
  return candidates[0];
};

const autoPickUplinkIfIndex = async (session) => {
  const ifNameMap = await slowWalk(session, '1.3.6.1.2.1.31.1.1.1.1');
  const ifDescrMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.2');
  const ifOperMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.8');
  const ifHighSpeedMap = await slowWalk(session, '1.3.6.1.2.1.31.1.1.1.15');
  const ifSpeedMap = await slowWalk(session, '1.3.6.1.2.1.2.2.1.5');

  const indices = new Set([
    ...Object.keys(ifNameMap),
    ...Object.keys(ifDescrMap),
    ...Object.keys(ifOperMap),
    ...Object.keys(ifHighSpeedMap),
    ...Object.keys(ifSpeedMap),
  ]);

  const candidates = [];

  for (const idx of indices) {
    const name = (safeToString(ifNameMap[idx]) || safeToString(ifDescrMap[idx]) || '').toLowerCase();
    const oper = bufferToInt(ifOperMap[idx]);
    const hs = bufferToInt(ifHighSpeedMap[idx]);
    const sp = bufferToInt(ifSpeedMap[idx]);
    const speedScore = Number.isFinite(hs) && hs > 0 ? hs : (Number.isFinite(sp) ? (sp / 1_000_000) : 0);

    let nameScore = 0;
    if (name.includes('uplink')) nameScore += 50;
    if (name.includes('trunk')) nameScore += 30;
    if (name.includes('xge')) nameScore += 25;
    if (name.includes('10g')) nameScore += 25;
    if (name.includes('ge')) nameScore += 10;
    if (name.includes('eth')) nameScore += 5;
    if (name.includes('mgmt') || name.includes('loopback') || name.includes('null')) nameScore -= 50;

    const operScore = oper === 1 ? 20 : 0;
    const score = nameScore + operScore + Math.min(100, speedScore);
    candidates.push({ idx, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.idx || null;
};

const readInterfaceOctets = async (session, ifIndex) => {
  const [hcIn, hcOut] = await snmpGet(session, [
    `1.3.6.1.2.1.31.1.1.1.6.${ifIndex}`,
    `1.3.6.1.2.1.31.1.1.1.10.${ifIndex}`,
  ]);

  let rx = bufferToCounterBigInt(hcIn);
  let tx = bufferToCounterBigInt(hcOut);

  if (rx == null || tx == null) {
    const [in32, out32] = await snmpGet(session, [
      `1.3.6.1.2.1.2.2.1.10.${ifIndex}`,
      `1.3.6.1.2.1.2.2.1.16.${ifIndex}`,
    ]);
    if (rx == null) rx = bufferToCounterBigInt(in32);
    if (tx == null) tx = bufferToCounterBigInt(out32);
  }

  return {
    rx,
    tx,
  };
};

/**
 * Ambil system metrics (temp, cpu, ram, uplink) untuk brand tertentu.
 * Mengisi field stats secara langsung.
 */
const fetchSystemMetrics = async (session, brandKey, stats) => {
  const oids = SYSTEM_OIDS[brandKey] || SYSTEM_OIDS.hioso;
  try {
    const [temp, cpu, ram, rx, tx] = await snmpGet(session, [
      oids.temp, oids.cpu, oids.ram, oids.uplink_rx, oids.uplink_tx
    ]);
    const tempN = bufferToInt(temp);
    const cpuN  = bufferToInt(cpu);
    const ramN  = bufferToInt(ram);
    if (tempN != null) stats.temp = `${tempN}°C`;
    if (cpuN  != null) stats.cpu  = `${cpuN}%`;
    if (ramN  != null) stats.ram  = `${ramN}%`;
    if (stats.temp === 'N/A') {
      const c = await getEntityTemperatureC(session);
      if (c != null) stats.temp = `${c.toFixed(1)}°C`;
    }

    const ifIndex = await autoPickUplinkIfIndex(session);
    if (ifIndex) {
      const first = await readInterfaceOctets(session, ifIndex);
      await new Promise(rv => setTimeout(rv, 800));
      const second = await readInterfaceOctets(session, ifIndex);

      const seconds = 0.8;
      const wrap64 = BigInt(1) << BigInt(64);

      if (first.rx != null && second.rx != null) {
        let delta = second.rx - first.rx;
        if (delta < BigInt(0)) delta = delta + wrap64;
        const rate = Number(delta) / seconds;
        stats.uplink_rx = Number.isFinite(rate) ? Math.max(0, Math.round(rate)) : 0;
      }
      if (first.tx != null && second.tx != null) {
        let delta = second.tx - first.tx;
        if (delta < BigInt(0)) delta = delta + wrap64;
        const rate = Number(delta) / seconds;
        stats.uplink_tx = Number.isFinite(rate) ? Math.max(0, Math.round(rate)) : 0;
      }
    } else {
      const rxN = bufferToInt(rx);
      const txN = bufferToInt(tx);
      if (rxN != null) stats.uplink_rx = rxN;
      if (txN != null) stats.uplink_tx = txN;
    }

    if (stats.cpu === 'N/A') {
      const hrCpu = await getHrCpuPercent(session);
      if (hrCpu != null) stats.cpu = `${hrCpu}%`;
    }
    if (stats.ram === 'N/A') {
      const hrRam = await getHrRamPercent(session);
      if (hrRam != null) stats.ram = `${hrRam}%`;
    }
  } catch (e) {
  }
};

const decodeRxPower = (brand, val) => {
  const rx = computeRxDbm(brand, val);
  if (rx == null) return 'N/A';
  return rx.toFixed(2);
};

// ─── MAIN: getOltStats ────────────────────────────────────────────────────────

async function getOltStats(id, full = false) {
  const olt = getOltById(id);
  if (!olt) return null;

  const stats = {
    id:          olt.id,
    name:        olt.name,
    host:        olt.host,
    brand:       olt.brand,
    status:      'Offline',
    error:       null,
    uptime:      'N/A',
    temp:        'N/A',
    cpu:         'N/A',
    ram:         'N/A',
    onus_total:  0,
    onus_online: 0,
    onus_offline: 0,
    onus_weak:   0,
    onus:        [],
    voltage:     'N/A',
    uplink_rx:   0,
    uplink_tx:   0,
  };

  const community  = olt.snmp_community || 'public';
  const brandKey   = (olt.brand || 'hioso').toLowerCase();
  
  // Gabungkan semua profil untuk deteksi otomatis jika brand yang dipilih tidak cocok
  const selectedProfiles = (BRAND_PROFILES[brandKey] || []).map(p => ({ ...p, __brandKey: brandKey }));
  const otherProfiles = Object.keys(BRAND_PROFILES)
    .filter(k => k !== brandKey)
    .reduce((acc, k) => acc.concat((BRAND_PROFILES[k] || []).map(p => ({ ...p, __brandKey: k }))), []);
  const allAvailableProfiles = [...selectedProfiles, ...otherProfiles];

  const session = snmp.createSession(olt.host, community, {
    port:     olt.snmp_port || 161,
    timeout:  full ? 8000 : 5000,
    retries:  full ? 2 : 1,
    version:  snmp.Version2c,
  });

  let isResolved = false;

  return new Promise((resolve) => {
    const safeResolve = (data) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(globalTimeout);
      try { session.close(); } catch (e) {}
      resolve(data);
    };

    const timeoutMs = full ? 60000 : 25000;
    const globalTimeout = setTimeout(() => {
      stats.error = `Request Timeout (${Math.round(timeoutMs / 1000)}s)`;
      safeResolve(stats);
    }, timeoutMs);

    (async () => {
      try {
        // 1. Cek koneksi dasar (Uptime)
        const uptimeVbs = await new Promise(rv => {
          session.get(['1.3.6.1.2.1.1.3.0'], (err, vbs) => {
            if (err) {
              stats.error = err.message;
              rv([]);
            } else rv(vbs);
          });
        });

        if (!uptimeVbs[0] || uptimeVbs[0].type === snmp.ObjectType.NoSuchObject || uptimeVbs[0].type === snmp.ObjectType.EndOfMibView) {
          if (!stats.error) stats.error = 'SNMP Agent not responding / Wrong Community String';
          safeResolve(stats);
          return;
        }

        stats.uptime = decodeUptime(uptimeVbs[0].value);
        stats.status = 'Online';

        // 3. Deteksi profil yang cocok
        let activeProfile = null;
        for (const profile of allAvailableProfiles) {
          const ok = await probeOid(session, profile.probe_oid);
          if (ok) {
            activeProfile = profile;
            break;
          }
        }

        if (!activeProfile) {
          stats.error = 'Brand/Profile OID tidak cocok dengan perangkat ini';
          safeResolve(stats);
          return;
        }

        const detectedBrandKey = activeProfile.__brandKey || brandKey;
        const onlineVals = getOnlineValues(detectedBrandKey, activeProfile);

        await fetchSystemMetrics(session, detectedBrandKey, stats);

        // 4. Mode Counter (ZTE)
        if (activeProfile.is_counter) {
          const onlineMap = await slowWalk(session, activeProfile.status_table);
          const totalMap  = await slowWalk(session, activeProfile.name_table);

          stats.onus_online  = Object.values(onlineMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_total   = Object.values(totalMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_offline = Math.max(0, stats.onus_total - stats.onus_online);

          safeResolve(stats);
          return;
        }

        // 5. Mode Table (Hioso, VSOL, HSGQ, etc)
        const statusMap = await slowWalk(session, activeProfile.status_table);
        const nameMap   = await slowWalk(session, activeProfile.name_table);

        let snMap = {};
        let rxMap = {};
        let txMap = {};
        if (full) {
          const snPick = await pickSnTable(session, activeProfile);
          snMap = snPick.map || {};
          if (activeProfile.rx_power_table) rxMap = await slowWalk(session, activeProfile.rx_power_table);
          if (activeProfile.tx_power_table) txMap = await slowWalk(session, activeProfile.tx_power_table);
        }

        const allIndices = new Set([...Object.keys(statusMap), ...Object.keys(nameMap)]);
        stats.onus_total = allIndices.size;
        
        const onus = [];
        let weakCount = 0;

        for (const idx of allIndices) {
          const stRaw = getByIdx(statusMap, idx);
          const stInt = bufferToInt(stRaw);
          const stStr = stRaw == null ? '' : String(stRaw).trim().toLowerCase();
          const isUp = stInt != null
            ? onlineVals.includes(stInt)
            : (stStr === 'online' || stStr === 'up' || stStr === 'on' || stStr === 'operation');

          const nameRaw = getByIdx(nameMap, idx);
          const nameStr = nameRaw == null ? '' : String(nameRaw).replace(/\0/g, '').trim();
          const name = nameStr || ('ONU-' + idx);
          const snVal = getByIdx(snMap, idx);
          const rxVal = getByIdx(rxMap, idx);
          const txVal = getByIdx(txMap, idx);
          const sn   = snVal ? decodeSn(snVal) : '-';
          const rx   = decodeRxPower(detectedBrandKey, rxVal);
          const tx   = decodeRxPower(detectedBrandKey, txVal);
          const onuId = hiosoOnuIdFromIndex(idx);
          
          if (isUp) stats.onus_online++;
          else stats.onus_offline++;

          if (rx !== 'N/A') {
            const n = parseFloat(rx);
            if (Number.isFinite(n) && n < -27) weakCount++;
          }

          if (full) {
            const rxShown = rx === 'N/A' ? rx : rx + ' dBm';
            const txShown = tx === 'N/A' ? tx : tx + ' dBm';

            onus.push({
              index: idx,
              id: onuId || '-',
              name,
              sn,
              status: isUp ? 'Online' : 'Offline',
              tx: txShown,
              rx: rxShown
            });
          }
        }

        stats.onus_weak = weakCount;
        stats.onus = onus.sort((a, b) => a.name.localeCompare(b.name));

        safeResolve(stats);
      } catch (err) {
        stats.error = err.message;
        safeResolve(stats);
      }
    })();
  });
}

// ─── ONU ACTIONS ─────────────────────────────────────────────────────────────

async function rebootOnu(oltId, index) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const community = olt.snmp_community || 'public';
  const session = snmp.createSession(olt.host, community, { port: olt.snmp_port || 161, version: snmp.Version2c });
  const oid = `1.3.6.1.4.1.25355.3.2.6.3.2.1.40.${index}`;
  return new Promise((resolve, reject) => {
    session.set([{ oid, type: snmp.ASN1.Integer, value: 1 }], (error) => {
      session.close();
      if (error) reject(error);
      else resolve(true);
    });
  });
}

async function renameOnu(oltId, index, newName) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');
  const community = olt.snmp_community || 'public';
  const session = snmp.createSession(olt.host, community, { port: olt.snmp_port || 161, version: snmp.Version2c });
  const oid = `1.3.6.1.4.1.25355.3.2.6.3.2.1.37.${index}`;
  return new Promise((resolve, reject) => {
    session.set([{ oid, type: snmp.ASN1.OctetString, value: newName }], (error) => {
      session.close();
      if (error) reject(error);
      else resolve(true);
    });
  });
}

module.exports = { getAllOlts, getActiveOlts, getOltById, createOlt, updateOlt, deleteOlt, getOltStats, rebootOnu, renameOnu };
