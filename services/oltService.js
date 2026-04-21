const snmp = require('net-snmp');
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
      // OID tabel status ONU (1=online, 2=offline)
      status_table: '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
      // OID tabel nama ONU
      name_table:   '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
      // OID probe: OID pertama di tabel ini untuk tes keberadaan
      probe_oid:    '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
    },
    {
      name: 'HIOSO_GPON',
      status_table: '1.3.6.1.4.1.25355.3.3.1.1.1.11',
      name_table:   '1.3.6.1.4.1.25355.3.3.1.1.1.7',
      probe_oid:    '1.3.6.1.4.1.25355.3.3.1.1.1.11',
    },
    {
      name: 'HIOSO_EPON_B',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.5',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
  ],
  hsgq: [
    {
      name: 'HSGQ_EPON',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.5',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
  ],
  zte: [
    {
      name: 'ZTE_C300',
      // OID jumlah ONU terdaftar per PON port
      status_table: '1.3.6.1.4.1.3902.1012.3.28.1.1.2',  // onu online count
      name_table:   '1.3.6.1.4.1.3902.1012.3.28.1.1.3',  // onu total count
      probe_oid:    '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
      is_counter: true,   // nilai adalah counter, bukan status per-ONU
    },
  ],
  vsol: [
    {
      name: 'VSOL_EPON',
      status_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
      name_table:   '1.3.6.1.4.1.37950.1.1.5.13.1.1.10',
      probe_oid:    '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
    },
  ],
};

// Nilai status yang dianggap "online" per brand
const ONLINE_VALUES = {
  hioso: [1, 3],
  hsgq:  [1, 3],
  zte:   [],     // ZTE pakai counter, tidak dipakai untuk per-ONU
  vsol:  [1],
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
    data.web_user || 'admin',
    data.web_password || 'admin'
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
    data.web_user || 'admin',
    data.web_password || 'admin',
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
  if (Buffer.isBuffer(val)) return val.toString('hex').toUpperCase();
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

// ─── CORE SNMP FUNCTIONS ─────────────────────────────────────────────────────

/**
 * Lakukan SNMP getNext (walk manual) untuk satu OID base.
 * Kembalikan object { index: value }.
 */
const slowWalk = async (session, baseOid) => {
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

      await new Promise(rv => setTimeout(rv, 25)); // throttle kecil
      if (walkCount > 1500) break; // batas aman
    } catch (e) {
      break;
    }
  }

  return results;
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
    if (temp != null) stats.temp = `${temp}°C`;
    if (cpu  != null) stats.cpu  = `${cpu}%`;
    if (ram  != null) stats.ram  = `${ram}%`;
    if (rx   != null) stats.uplink_rx = Number(rx)  || 0;
    if (tx   != null) stats.uplink_tx = Number(tx)  || 0;
  } catch (e) {
    // metrics opsional, abaikan error
  }
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
  const profiles   = BRAND_PROFILES[brandKey] || BRAND_PROFILES.hioso;
  const onlineVals = ONLINE_VALUES[brandKey]  || [1, 3];

  const session = snmp.createSession(olt.host, community, {
    port:     olt.snmp_port || 161,
    timeout:  4000,
    retries:  1,
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

    // Timeout global 20 detik
    const globalTimeout = setTimeout(() => {
      logger.warn(`[OLT-SNMP] Global timeout 20s untuk ${olt.name} (${olt.host})`);
      safeResolve(stats);
    }, 20000);

    (async () => {
      try {
        // 1. Cek uptime (koneksi dasar ke OLT)
        const uptimeVbs = await new Promise(rv => {
          session.get(['1.3.6.1.2.1.1.3.0'], (err, vbs) => rv(err ? [] : vbs));
        });

        if (!uptimeVbs[0] || uptimeVbs[0].type === snmp.ObjectType.NoSuchObject || uptimeVbs[0].type === snmp.ObjectType.EndOfMibView) {
          logger.warn(`[OLT-SNMP] ${olt.name} tidak merespons SNMP (uptime check gagal)`);
          safeResolve(stats);
          return;
        }

        stats.uptime = decodeUptime(uptimeVbs[0].value);
        stats.status = 'Online';
        logger.info(`[OLT-SNMP] ${olt.name} (${olt.host}) Online, uptime=${stats.uptime}`);

        // 2. Ambil system metrics (temp/cpu/ram/uplink) — tidak blocking
        await fetchSystemMetrics(session, brandKey, stats);
        logger.info(`[OLT-SNMP] Metrics ${olt.name}: temp=${stats.temp}, cpu=${stats.cpu}, ram=${stats.ram}`);

        // 3. Deteksi profil yang cocok untuk brand ini
        let activeProfile = null;
        for (const profile of profiles) {
          logger.info(`[OLT-SNMP] Mencoba profil ${profile.name} dengan probe OID ${profile.probe_oid}`);
          const ok = await probeOid(session, profile.probe_oid);
          if (ok) {
            activeProfile = profile;
            logger.info(`[OLT-SNMP] Profil terdeteksi: ${profile.name}`);
            break;
          }
        }

        if (!activeProfile) {
          logger.warn(`[OLT-SNMP] Tidak ada profil SNMP yang cocok untuk ${olt.name} (brand=${brandKey}). Periksa OID dan community.`);
          // Status tetap Online (OLT merespons) tapi tidak ada data ONU
          safeResolve(stats);
          return;
        }

        // 4. Untuk brand ZTE (mode counter per port), hitung total dari tabel counter
        if (activeProfile.is_counter) {
          const onlineMap = await slowWalk(session, activeProfile.status_table);
          const totalMap  = await slowWalk(session, activeProfile.name_table);

          stats.onus_online  = Object.values(onlineMap).reduce((s, v) => s + (parseInt(v) || 0), 0);
          stats.onus_total   = Object.values(totalMap).reduce((s, v) => s + (parseInt(v) || 0), 0);
          stats.onus_offline = Math.max(0, stats.onus_total - stats.onus_online);

          logger.info(`[OLT-SNMP][ZTE] Total=${stats.onus_total}, Online=${stats.onus_online}`);
          safeResolve(stats);
          return;
        }

        // 5. Untuk brand lain: walk tabel status dan tabel nama

        logger.info(`[OLT-SNMP] Walk status_table: ${activeProfile.status_table}`);
        const statusMap = await slowWalk(session, activeProfile.status_table);

        logger.info(`[OLT-SNMP] Walk name_table: ${activeProfile.name_table}`);
        const nameMap = await slowWalk(session, activeProfile.name_table);

        // Gabungkan semua index unik yang ditemukan dari kedua tabel
        const allIndices = new Set([...Object.keys(statusMap), ...Object.keys(nameMap)]);

        logger.info(`[OLT-SNMP] Deep Scan ${olt.name}: Status=${Object.keys(statusMap).length}, Nama=${Object.keys(nameMap).length}, Gabungan=${allIndices.size}`);

        stats.onus_total   = allIndices.size;
        stats.onus_online  = Array.from(allIndices).filter(i => onlineVals.includes(statusMap[i])).length;
        stats.onus_offline = stats.onus_total - stats.onus_online;

        safeResolve(stats);
      } catch (err) {
        logger.error(`[OLT-SNMP] Error pada ${olt.name}: ${err.message}`);
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
