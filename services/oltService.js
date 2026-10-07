const snmp = require('net-snmp');
const net = require('net');
const Database = require('better-sqlite3');
const path = require('path');
const winston = require('winston');
const axios = require('axios');
const genieacs = require('../config/genieacs');

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
      /** OLT_OID_REFERENCE: integer meter (bukan per 0,1 m seperti ZTE/Huawei) */
      distance_table: '1.3.6.1.4.1.25355.3.2.6.3.2.1.25',
      distance_tenths_meter: false,
    },
    {
      name: 'HIOSO_EPON_B',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      offline_reason_table: '1.3.6.1.4.1.3320.101.11.1.1.11',
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
      offline_reason_table: '1.3.6.1.4.1.3320.101.11.1.1.11',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
  ],
  zte: [
    {
      name: 'ZTE_GPON_C300',
      status_table: '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.9',
      name_table:   '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.6',
      tx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.1', // TX Optical power (0.01 dBm)
      rx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.2', // RX Optical power (0.01 dBm)
      offline_reason_table: '1.3.6.1.4.1.3902.1082.500.10.2.3.8.1.7',
      probe_oid:    '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.9',
      unauth_sn_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.2',
      unauth_type_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.10',
      distance_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.4',
      distance_tenths_meter: true,
      firmware_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.5',
      uptime_table:   '1.3.6.1.4.1.3902.1015.1010.11.2.1.6',
    },
    {
      name: 'ZTE_GPON_C600',
      status_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.10',
      name_table:   '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.3',
      tx_power_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.7.1.2',
      rx_power_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.7.1.3',
      offline_reason_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.8.1.7',
      probe_oid:    '1.3.6.1.4.1.3902.1082.500.12.2.3.3.1.10',
      unauth_sn_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.11.1.2',
      unauth_type_table: '1.3.6.1.4.1.3902.1082.500.12.2.3.11.1.10',
    },
    {
      name: 'ZTE_GPON_OLD',
      status_table: '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
      name_table:   '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.2',
      sn_table:     '1.3.6.1.4.1.3902.1082.500.10.2.3.3.1.6',
      tx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.1',
      rx_power_table: '1.3.6.1.4.1.3902.1015.1010.11.2.1.2',
      probe_oid:    '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
      unauth_sn_table: '1.3.6.1.4.1.3902.1012.3.13.3.1.2',
    }
  ],
  vsol: [
    {
      name: 'VSOL_EPON',
      status_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
      name_table:   '1.3.6.1.4.1.37950.1.1.5.13.1.1.10',
      sn_table:     '1.3.6.1.4.1.37950.1.1.5.13.1.1.2',
      tx_power_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.20', // 0.1 dBm
      rx_power_table: '1.3.6.1.4.1.37950.1.1.5.13.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.37950.1.1.5.13.1.1.4',
    },
  ],
  huawei: [
    {
      name: 'HUAWEI_GPON',
      status_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      name_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
      sn_table:     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
      tx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.3', // 0.01 dBm
      rx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.4', // 0.01 dBm
      offline_reason_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.24',
      probe_oid:    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      unauth_sn_table: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.4',
      unauth_type_table: '1.3.6.1.4.1.2011.6.128.1.1.2.45.1.5',
      distance_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.20',
      distance_tenths_meter: true,
      firmware_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.10',
      uptime_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.15',
    }
  ],
  fiberhome: [
    {
      name: 'FIBERHOME_GPON',
      status_table: '1.3.6.1.4.1.27332.1.1.1.8.1.7',
      name_table:   '1.3.6.1.4.1.27332.1.1.1.8.1.3',
      sn_table:     '1.3.6.1.4.1.27332.1.1.1.8.1.4',
      tx_power_table: '1.3.6.1.4.1.27332.1.1.1.11.1.3',
      rx_power_table: '1.3.6.1.4.1.27332.1.1.1.11.1.4',
      probe_oid:    '1.3.6.1.4.1.27332.1.1.1.8.1.7',
      unauth_sn_table: '1.3.6.1.4.1.27332.1.1.1.1.1.1.10',
    }
  ],
  bdcom: [
    {
      name: 'BDCOM_GPON',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.7',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.3',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.4',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.3.1.3',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.3.1.4',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.7',
    }
  ],
  cdata: [
    {
      name: 'CDATA_EPON',
      status_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
      name_table:   '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.10',
      sn_table:     '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.2', // LLID / MAC table (bukan .10)
      tx_power_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.20',
      rx_power_table: '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.21', // 0.1 dBm
      probe_oid:    '1.3.6.1.4.1.34592.1.3.100.12.1.1.1.15',
    }
  ],
  generic: [
    {
      name: 'GENERIC_EPON_CTC',
      status_table: '1.3.6.1.4.1.3320.101.10.1.1.26',
      name_table:   '1.3.6.1.4.1.3320.101.10.1.1.79',
      sn_table:     '1.3.6.1.4.1.3320.101.10.1.1.3',
      tx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.5',
      rx_power_table: '1.3.6.1.4.1.3320.101.10.5.1.6',
      probe_oid:    '1.3.6.1.4.1.3320.101.10.1.1.26',
    },
    {
      name: 'GENERIC_GPON_STD',
      status_table: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
      name_table:   '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
      sn_table:     '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
      tx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.3',
      rx_power_table: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.4',
      probe_oid:    '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.11',
    }
  ]
};

// Nilai status yang dianggap "online" per brand
const ONLINE_VALUES = {
  hioso: [1, 3, 4],
  hsgq:  [1, 3, 4],
  zte:   [1, 3, 'working', 'online'],
  vsol:  [1, 3, 4],
  huawei: [5, 1, 'active', 'online'], // 5: operation
  fiberhome: [1, 2, 3],
  bdcom: [1, 2, 3],
  cdata: [1, 3],
  generic: [1, 2, 3, 4, 5, 'online', 'active', 'working'],
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
    temp:      '1.3.6.1.4.1.3320.101.11.1.12.1', // Temp sensor
    cpu:       '1.3.6.1.4.1.3320.101.11.1.13.1', // CPU Usage
    ram:       '1.3.6.1.4.1.3320.101.11.1.14.1', // RAM Usage
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  zte: {
    temp:      '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.19.1.1.1', // Temp sensor (zxAnCardCpuTemp)
    cpu:       '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.10.1.1.1', // CPU Usage
    ram:       '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.11.1.1.1', // RAM Usage
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
    temp:      '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.13.0.0', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.14.0.0', // CPU (%)
    ram:       '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.15.0.0', // RAM (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  fiberhome: {
    temp:      '1.3.6.1.4.1.27332.1.1.1.9.1.11.1.1', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.27332.1.1.1.9.1.12.1.1', // CPU (%)
    ram:       '1.3.6.1.4.1.27332.1.1.1.9.1.14.1.1', // RAM (%)
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  bdcom: {
    temp:      '1.3.6.1.4.1.3320.101.11.1.12.1', // Suhu (°C)
    cpu:       '1.3.6.1.4.1.3320.101.11.1.13.1', // CPU (%)
    ram:       '1.3.6.1.4.1.3320.101.11.1.14.1', // RAM (%)
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

const CARD_OIDS = {
  zte: {
    type:   '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.4',
    status: '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.6',
    ports:  '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.7',
    cpu:    '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.10',
    ram:    '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.11',
    serial: '1.3.6.1.4.1.3902.1082.500.10.2.2.4.1.12',
  },
  huawei: {
    type:   '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.4',
    status: '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.6',
    ports:  '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.3',
    cpu:    '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.14',
    ram:    '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.15',
    serial: '1.3.6.1.4.1.2011.6.128.1.1.2.23.1.9',
  },
  fiberhome: {
    type:   '1.3.6.1.4.1.27332.1.1.1.9.1.3',
    status: '1.3.6.1.4.1.27332.1.1.1.9.1.5',
    ports:  '1.3.6.1.4.1.27332.1.1.1.9.1.6',
    cpu:    '1.3.6.1.4.1.27332.1.1.1.9.1.12',
    ram:    '1.3.6.1.4.1.27332.1.1.1.9.1.14',
    serial: '1.3.6.1.4.1.27332.1.1.1.9.1.8',
  },
  bdcom: {
    type:   '1.3.6.1.4.1.3320.101.11.1.3',
    status: '1.3.6.1.4.1.3320.101.11.1.5',
    ports:  '1.3.6.1.4.1.3320.101.11.1.6',
    cpu:    '1.3.6.1.4.1.3320.101.11.1.13',
    ram:    '1.3.6.1.4.1.3320.101.11.1.14',
    serial: '1.3.6.1.4.1.3320.101.11.1.8',
  }
};

const CARD_STATUS_MAP = {
  1: 'INSERVICE',
  2: 'STANDBY',
  3: 'OFFLINE',
  4: 'FAILED',
  5: 'INIT',
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
  const apiBase = String(data.api_base_url || '').trim();
  const telnetPort = parseInt(data.telnet_port, 10);
  const stmt = db.prepare(`
    INSERT INTO olts (name, host, snmp_community, snmp_port, brand, description, is_active, web_user, web_password, api_base_url, telnet_port, enable_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.web_password || '',
    apiBase || null,
    Number.isFinite(telnetPort) && telnetPort > 0 ? telnetPort : 23,
    data.enable_password != null && String(data.enable_password).length ? String(data.enable_password) : null
  );
}

function updateOlt(id, data) {
  const prev = getOltById(id);
  const apiBase = String(data.api_base_url || '').trim();
  const telnetPort = parseInt(data.telnet_port, 10);
  const enablePass = String(data.enable_password || '').trim().length > 0
    ? String(data.enable_password).trim()
    : (prev && prev.enable_password) || null;
  const stmt = db.prepare(`
    UPDATE olts 
    SET name = ?, host = ?, snmp_community = ?, snmp_port = ?, brand = ?, description = ?, is_active = ?, web_user = ?, web_password = ?, api_base_url = ?, telnet_port = ?, enable_password = ?
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
    apiBase || null,
    Number.isFinite(telnetPort) && telnetPort > 0 ? telnetPort : 23,
    enablePass,
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

function formatSnWithColons(val) {
  if (!val || typeof val !== 'string') return val;
  const clean = val.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  // Jika 12 karakter hex (MAC address format MikroTik, misal 2C334187A820 -> 2C:33:41:87:A8:20)
  if (/^[0-9A-F]{12}$/.test(clean)) {
    return clean.match(/.{1,2}/g).join(':');
  }
  // Jika 16 karakter hex (8 bytes GPON hex)
  if (/^[0-9A-F]{16}$/.test(clean)) {
    return clean.match(/.{1,2}/g).join(':');
  }
  return val;
}

const decodeSn = (val) => {
  if (!val) return 'N/A';
  let res = '';
  if (Buffer.isBuffer(val)) {
    const ascii = val.toString('utf8').replace(/\0/g, '').trim();
    const looksAscii = ascii.length >= 4 && /^[\x20-\x7E]+$/.test(ascii);
    res = looksAscii ? ascii.toUpperCase() : val.toString('hex').toUpperCase();
  } else {
    res = val.toString().toUpperCase();
  }
  return formatSnWithColons(res);
};

/**
 * SN di SNMP sering jadi hex rapat (mis. 88D2742B900D); di CLI OLT bisa ditampilkan bertitik dua (88:D2:74:2B:90:0D).
 * Untuk perintah otorisasi, keduanya harus jadi bentuk yang sama (hex huruf besar tanpa separator, atau SN GPON vendor).
 */
function normalizeSnForOltProvision(sn) {
  const raw = String(sn == null ? '' : sn).trim();
  if (!raw) return raw;
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (/^[A-F0-9]+$/.test(alnum) && (alnum.length === 12 || alnum.length === 16)) return alnum;
  if (/^[A-Z]{4}/.test(alnum) && alnum.length >= 8) return alnum;
  return alnum;
}

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
      if (buf.includes('--More--') || buf.includes('--Press Enter--') || buf.includes('Enter Key To Continue')) {
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

const telnetLoginAndRun = async (host, user, pass, commands, opts = {}) => {
  const telnetPort = Number(opts.port) > 0 ? Number(opts.port) : 23;
  const enablePassword = opts.enablePassword != null && String(opts.enablePassword).length > 0
    ? String(opts.enablePassword)
    : null;

  const socket = new net.Socket();
  socket.setTimeout(15000);

  await new Promise((resolve, reject) => {
    socket.connect(telnetPort, host, resolve);
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

  if (enablePassword) {
    try {
      socket.write('enable\r\n');
      const enBuf = await telnetReadUntil(socket, (b) => /password\s*[:>]\s*$/im.test(b) || promptRe.test(b), 12000);
      if (/password\s*[:>]\s*$/im.test(enBuf)) {
        socket.write(enablePassword + '\r\n');
        await telnetReadUntil(socket, promptRe, 12000);
      }
    } catch (e) {
      socket.destroy();
      throw new Error('Telnet enable gagal: ' + (e.message || String(e)));
    }
  }

  let cmdList = Array.isArray(commands) ? [...commands] : [];
  while (cmdList.length && /^enable\s*$/i.test(String(cmdList[0]).trim())) {
    cmdList.shift();
  }

  const outputs = [];
  for (const cmd of cmdList) {
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
    if (parts.length >= 20) {
      // 22-column legacy format
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
        mac: formatSnWithColons(mac),
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
    } else if (parts.length >= 10) {
      // 12-column modern format (HA7304 / HA7308)
      // OnuId MacAddress Status Firmware ChipId Ge Fe Pots CtcStatus CtcVer Activate Uptime [Name]
      const id = parts[0];
      const mac = parts[1];
      const status = parts[2];
      const fwVersion = parts[3];
      const chipId = parts[4];
      const ports = (parts[5] || '0') + '/' + (parts[6] || '0');
      const ctcStatus = parts[8];
      const ctcVer = parts[9];
      const activate = parts[10];
      const uptime = parts[11];
      const name = parts.length > 12 ? parts.slice(12).join(' ') : null;

      rows.push({
        id,
        name: name === 'NA' || !name ? null : name,
        mac,
        status,
        fwVersion,
        chipId,
        ports,
        distance: '-',
        ctcStatus,
        ctcVer,
        activate,
        uptime,
        txPower: 'N/A',
        rxPower: 'N/A'
      });
    }
  }

  return rows;
};

const fetchHiosoOnuDetailViaTelnet = async (olt) => {
  const user = olt.web_user || 'admin';
  const pass = olt.web_password || 'admin';
  const cmds = [
    'show onu info epon 0/1 all',
    'show onu info epon 0/2 all',
    'show onu info epon 0/3 all',
    'show onu info epon 0/4 all',
    'show onu',
    'show onu all',
    'show onu info',
    'show onu status',
  ];

  try {
    const out = await telnetLoginAndRun(olt.host, user, pass, cmds, {
      port: olt.telnet_port || 23,
      enablePassword: olt.enable_password || pass || 'admin'
    });
    const rows = parseHiosoOnuTable(out);
    return rows.length > 0 ? rows : null;
  } catch (e) {
    return null;
  }
};

// ─── CORE SNMP FUNCTIONS ─────────────────────────────────────────────────────

const slowWalk = async (session, baseOid, maxEntries = 5000) => {
  const results  = {};
  let walkCount  = 0;

  return new Promise((resolve) => {
    session.subtree(
      baseOid,
      20, // maxRepetitions (GETBULK size)
      (varbinds) => {
        for (const vb of varbinds) {
          if (!vb || vb.oid == null) continue;
          if (snmp.isVarbindError(vb)) continue;
          if (!oidUnderBase(vb.oid, baseOid)) continue;

          const idx = extractIdx(vb.oid, baseOid);
          results[idx] = vb.value;
          walkCount++;
          if (walkCount >= maxEntries) {
            break;
          }
        }
      },
      (error) => {
        // Resolve results when done, ignoring errors
        resolve(results);
      }
    );
  });
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
  if (activeProfile.sn_table) {
    try {
      const m = await slowWalk(session, activeProfile.sn_table);
      if (m && Object.keys(m).length > 0) {
        return { oid: activeProfile.sn_table, map: m };
      }
    } catch (e) {}
  }

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
  // Fast path: try direct GET on common hrStorage indices first (1, 3, 6, 7)
  // hrStorageSize and hrStorageUsed with allocation unit 1024 bytes
  const fastOids = [
    '1.3.6.1.2.1.25.2.2.0',         // hrMemorySize (total KB)
    '1.3.6.1.2.1.25.2.3.1.4.1',     // hrStorageAllocationUnits.1
    '1.3.6.1.2.1.25.2.3.1.5.1',     // hrStorageSize.1
    '1.3.6.1.2.1.25.2.3.1.6.1',     // hrStorageUsed.1
    '1.3.6.1.2.1.25.2.3.1.2.1',     // hrStorageType.1 (OID value)
  ];
  try {
    const vbs = await snmpGet(session, fastOids);
    const totalKb   = bufferToInt(vbs[0]);
    const allocUnit = bufferToInt(vbs[1]);
    const size      = bufferToInt(vbs[2]);
    const used      = bufferToInt(vbs[3]);

    if (Number.isFinite(totalKb) && totalKb > 0 &&
        Number.isFinite(allocUnit) && allocUnit > 0 &&
        Number.isFinite(size) && size > 0 &&
        Number.isFinite(used)) {
      // size/used are in allocation units
      const usedKb = (used * allocUnit) / 1024;
      const pct = Math.round((usedKb / totalKb) * 100);
      return Math.max(0, Math.min(100, pct));
    }
    // Fallback: size as a percentage directly
    if (Number.isFinite(size) && size > 0 && Number.isFinite(used)) {
      return Math.max(0, Math.min(100, Math.round((used / size) * 100)));
    }
  } catch (e) {
    // fall through to slow path
  }

  // Slow path: full walk (for other brands)
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

const autoPickUplinkCandidates = async (session) => {
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
    if (name.includes('gpon') || name.includes('epon') || name.includes('pon') || name.includes('onu') || name.includes('llid')) nameScore -= 35;
    if (name.includes('mgmt') || name.includes('loopback') || name.includes('null')) nameScore -= 50;

    const operScore = oper === 1 ? 20 : 0;
    const score = nameScore + operScore + Math.min(100, speedScore);
    candidates.push({ idx, score, name });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
};

const autoPickUplinkIfIndex = async (session) => {
  const candidates = await autoPickUplinkCandidates(session);
  return candidates[0]?.idx || null;
};

const uplinkCache = new Map();

const pickUplinkIfIndexByTraffic = async (session, oltId) => {
  if (oltId) {
    const now = Date.now();
    const cached = uplinkCache.get(oltId);
    if (cached && (now - cached.timestamp < 3600000)) { // 1 hour cache
      return cached.ifIndex;
    }
  }

  const candidates = await autoPickUplinkCandidates(session);
  if (candidates.length === 0) return null;

  const top = candidates.slice(0, 6);
  let best = null;

  for (const c of top) {
    const first = await readInterfaceOctets(session, c.idx);
    await new Promise(rv => setTimeout(rv, 100)); // Jedah scan lebih cepat (100ms)
    const second = await readInterfaceOctets(session, c.idx);

    const wrap64 = BigInt(1) << BigInt(64);
    let sum = BigInt(0);
    let ok = false;

    if (first.rx != null && second.rx != null) {
      let d = second.rx - first.rx;
      if (d < BigInt(0)) d = d + wrap64;
      if (d > BigInt(0)) ok = true;
      sum += d;
    }
    if (first.tx != null && second.tx != null) {
      let d = second.tx - first.tx;
      if (d < BigInt(0)) d = d + wrap64;
      if (d > BigInt(0)) ok = true;
      sum += d;
    }

    if (!ok) continue;
    if (!best || sum > best.sum) best = { idx: c.idx, sum };
  }

  const ifIndex = best?.idx || candidates[0].idx;
  if (oltId && ifIndex) {
    uplinkCache.set(oltId, { ifIndex, timestamp: Date.now() });
  }
  return ifIndex;
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
 * Ambil CPU, RAM, Suhu modul optik, dan Uptime via Telnet CLI untuk Hioso / HSGQ.
 * Berfungsi sebagai fallback handal jika OLT tidak mendukung OID Suhu/CPU vendor via SNMP.
 */
const fetchHiosoSystemMetricsViaTelnet = async (olt, stats) => {
  if (!olt || !olt.host) return;
  const user = olt.web_user || 'admin';
  const pass = olt.web_password || 'admin';
  const cmds = [
    'show cpu resource',
    'show epon optical-ddm 0/1'
  ];
  try {
    const out = await telnetLoginAndRun(olt.host, user, pass, cmds, {
      port: olt.telnet_port || 23,
      enablePassword: olt.enable_password || pass || 'admin'
    });
    if (!out) return;

    if (stats.cpu === 'N/A' || !stats.cpu || stats.cpu === '-') {
      const cpuMatch = out.match(/CPU usage\s*:\s*(\d+)%/i);
      if (cpuMatch) stats.cpu = `${cpuMatch[1]}%`;
    }

    if (stats.ram === 'N/A' || !stats.ram || stats.ram === '-') {
      const ramMatch = out.match(/Memory usage\s*:\s*([\d\.]+)%/i);
      if (ramMatch) stats.ram = `${Math.round(parseFloat(ramMatch[1]))}%`;
    }

    if (stats.temp === 'N/A' || !stats.temp || stats.temp === '-') {
      const tempMatch = out.match(/Temperature\s*:\s*([\d\.]+)\s*C/i);
      if (tempMatch) stats.temp = `${parseFloat(tempMatch[1]).toFixed(0)}°C`;
    }

    if (stats.uptime === 'N/A' || !stats.uptime || stats.uptime === '-') {
      const uptimeMatch = out.match(/OS up time\s*:\s*([^\r\n]+)/i);
      if (uptimeMatch) stats.uptime = uptimeMatch[1].trim();
    }
  } catch (e) {
    logger.debug(`[oltService] fetchHiosoSystemMetricsViaTelnet: ${e.message}`);
  }
};

/**
 * Ambil system metrics (temp, cpu, ram, uplink) untuk brand tertentu.
 * Mengisi field stats secara langsung.
 */
const fetchSystemMetrics = async (session, brandKey, stats, oltOrId) => {
  const oids = SYSTEM_OIDS[brandKey] || SYSTEM_OIDS.hioso;
  const oltId = (oltOrId && typeof oltOrId === 'object') ? oltOrId.id : oltOrId;
  try {
    const [temp, cpu, ram, rx, tx] = await snmpGet(session, [
      oids.temp, oids.cpu, oids.ram, oids.uplink_rx, oids.uplink_tx
    ]);
    const tempN = bufferToInt(temp);
    const cpuN  = bufferToInt(cpu);
    const ramN  = bufferToInt(ram);
    if (Number.isFinite(tempN) && tempN >= -20 && tempN <= 120 && tempN !== 0) stats.temp = `${tempN}°C`;
    if (cpuN  != null) stats.cpu  = `${cpuN}%`;
    if (ramN  != null) stats.ram  = `${ramN}%`;
    if (stats.temp === 'N/A') {
      const c = await getEntityTemperatureC(session);
      if (c != null) stats.temp = `${c.toFixed(1)}°C`;
    }

    const ifIndex = await pickUplinkIfIndexByTraffic(session, oltId);
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

    // Telnet Fallback untuk Suhu/CPU/RAM pada Hioso/HSGQ jika SNMP tidak menyediakan
    if (stats.cpu === 'N/A' || stats.ram === 'N/A' || stats.temp === 'N/A') {
      if (brandKey === 'hioso' || brandKey === 'hsgq') {
        const oltObj = (oltOrId && typeof oltOrId === 'object') ? oltOrId : getOltById(oltOrId);
        if (oltObj) {
          await fetchHiosoSystemMetricsViaTelnet(oltObj, stats);
        }
      }
    }
  } catch (e) {
  }
};

/**
 * Ambil daftar card/board OLT.
 */
const fetchCardMetrics = async (session, brandKey, stats) => {
  const oids = CARD_OIDS[brandKey];
  if (!oids) return;

  try {
    const typeMap   = await slowWalk(session, oids.type);
    const statusMap = await slowWalk(session, oids.status);
    const portMap   = await slowWalk(session, oids.ports);
    const serialMap = await slowWalk(session, oids.serial);
    const cpuMap    = await slowWalk(session, oids.cpu);
    const ramMap    = await slowWalk(session, oids.ram);

    const cards = [];
    const indices = Object.keys(typeMap);

    for (const idx of indices) {
      const type = safeToString(typeMap[idx]);
      if (!type || type === '0') continue;

      const statusNum = bufferToInt(statusMap[idx]);
      const statusText = CARD_STATUS_MAP[statusNum] || (statusNum != null ? String(statusNum) : 'UNKNOWN');
      
      const cpuVal = bufferToInt(cpuMap[idx]);
      const ramVal = bufferToInt(ramMap[idx]);

      cards.push({
        index: idx,
        type: type,
        status: statusText,
        ports: bufferToInt(portMap[idx]) || 0,
        serial: decodeSn(serialMap[idx]),
        cpu: cpuVal != null ? `${cpuVal}%` : 'N/A',
        ram: ramVal != null ? `${ramVal}%` : 'N/A',
      });
    }

    if (cards.length > 0) {
      stats.cards = cards.sort((a, b) => String(a.index).localeCompare(String(b.index), undefined, { numeric: true }));
    }
  } catch (e) {
    logger.error(`fetchCardMetrics error: ${e.message}`);
  }
};

/**
 * Ambil daftar ONU yang belum diotorisasi (Unregistered).
 */
const fetchUnauthOnus = async (session, profile, stats) => {
  if (!profile.unauth_sn_table) return;

  try {
    const snMap = await slowWalk(session, profile.unauth_sn_table);
    let typeMap = {};
    if (profile.unauth_type_table) {
      typeMap = await slowWalk(session, profile.unauth_type_table);
    }

    const indices = Object.keys(snMap);
    for (const idx of indices) {
      const sn = decodeSn(snMap[idx]);
      if (!sn || sn === 'N/A') continue;

      const type = safeToString(typeMap[idx]) || 'GENERIC';
      const onuId = hiosoOnuIdFromIndex(idx);

      stats.unauth_onus.push({
        index: idx,
        id: onuId || idx,
        sn: sn,
        type: type
      });
    }
  } catch (e) {
    logger.error(`fetchUnauthOnus error: ${e.message}`);
  }
};

const decodeRxPower = (brand, val) => {
  const rx = computeRxDbm(brand, val);
  if (rx == null) return 'N/A';
  return rx.toFixed(2);
};

function translateOfflineReason(brand, rawValue) {
  if (rawValue == null) return null;
  const valNum = bufferToInt(rawValue);
  if (valNum == null) {
    const valStr = String(rawValue).trim().toLowerCase();
    if (valStr.includes('dying_gasp') || valStr.includes('power_off') || valStr.includes('poweroff')) {
      return 'Mati Listrik / Adaptor Dicabut';
    }
    if (valStr.includes('los') || valStr.includes('wire_down') || valStr.includes('link_down')) {
      return 'Kabel Fiber Optik Putus (LOS)';
    }
    if (valStr.includes('mpcp') || valStr.includes('timeout') || valStr.includes('unregister')) {
      return 'Koneksi Terputus / Redaman Drop';
    }
    if (valStr.includes('manual') || valStr.includes('deactive')) {
      return 'Dimatikan dari OLT (Deactive)';
    }
    return valStr;
  }

  const bKey = String(brand || '').toLowerCase();
  
  if (bKey === 'zte') {
    switch (valNum) {
      case 2:
      case 3:
        return 'Kabel Fiber Optik Putus (LOS)';
      case 4:
        return 'Loss of Frame (Gangguan Sinyal)';
      case 5:
        return 'Signal Failure (Gangguan Sinyal)';
      case 8:
        return 'Gagal Otorisasi / Registrasi';
      case 9:
        return 'Mati Listrik / Adaptor Dicabut';
      case 10:
        return 'Dimatikan dari OLT (Deactive)';
      case 12:
        return 'ONU Reboot';
      case 13:
        return 'ONU Dimatikan';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  if (bKey === 'huawei') {
    switch (valNum) {
      case 1:
      case 2:
        return 'Kabel Fiber Optik Putus (LOS)';
      case 3:
        return 'Loss of Frame (Gangguan Sinyal)';
      case 4:
        return 'Signal Failure (Gangguan Sinyal)';
      case 7:
        return 'Gagal Deaktivasi';
      case 8:
        return 'Dimatikan dari OLT (Deactive)';
      case 9:
        return 'ONU Reboot / Reset';
      case 10:
        return 'ONU Re-registrasi';
      case 13:
        return 'Mati Listrik / Adaptor Dicabut';
      case 31:
      case 32:
      case 33:
        return 'Reset oleh Pelanggan (Tombol/Sistem)';
      case 30:
        return 'Modul Optik Dimatikan';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  if (bKey === 'hioso' || bKey === 'hsgq') {
    switch (valNum) {
      case 2:
        return 'Normal / Berhasil Terkoneksi';
      case 3:
        return 'Koneksi Terputus (MPCP Down)';
      case 4:
        return 'Gangguan Link (OAM Down)';
      case 7:
        return 'Dimatikan dari OLT (Admin Down)';
      case 8:
        return 'Kabel Fiber Optik Putus (Wire Down)';
      case 9:
        return 'Mati Listrik / Adaptor Dicabut (Power Off)';
      case 255:
        return 'Penyebab tidak diketahui';
      default:
        return `Penyebab Lain (${valNum})`;
    }
  }

  return `Kode (${valNum})`;
}

// ─── MAIN: getOltStats ────────────────────────────────────────────────────────

async function limitConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

const statsCache = new Map();
const pendingPromises = new Map();

async function getOltStats(id, full = false) {
  const cacheKey = `${id}:${full}`;
  const now = Date.now();
  const cached = statsCache.get(cacheKey);
  const cacheDuration = full ? 120000 : 10000; // 120s cache for full table, 10s for summary

  if (cached && (now - cached.timestamp < cacheDuration)) {
    logger.info(`[oltService] Returning cached stats for OLT ${id} (full: ${full})`);
    return cached.data;
  }

  if (pendingPromises.has(cacheKey)) {
    logger.info(`[oltService] Coalescing concurrent stats request for OLT ${id} (full: ${full})`);
    return pendingPromises.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const result = await getOltStatsInternal(id, full);
      if (result && !result.error) {
        statsCache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });
      }
      return result;
    } finally {
      pendingPromises.delete(cacheKey);
    }
  })();

  pendingPromises.set(cacheKey, promise);
  return promise;
}

async function getOltStatsInternal(id, full = false) {
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
    unauth_onus: [],
    cards:       [],
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
    timeout:  full ? 10000 : 5000,
    retries:  full ? 2 : 1,
    version:  snmp.Version2c,
  });

  session.on('error', (err) => {
    logger.warn(`[SNMP Session Error] OLT ${olt.host}: ${err.message}`);
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

    const timeoutMs = full ? 90000 : 20000;
    const globalTimeout = setTimeout(() => {
      stats.error = `Koneksi Timeout (${Math.round(timeoutMs / 1000)}s) - OLT ${olt.host} tidak merespons SNMP/Telnet`;
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
          // Telnet Fallback for HIOSO/HSGQ if SNMP is not enabled
          if (brandKey === 'hioso' || brandKey === 'hsgq') {
            const telnetData = await fetchHiosoOnuDetailViaTelnet(olt);
            if (telnetData && telnetData.length > 0) {
              stats.status = 'Online';
              stats.error = null;
              stats.onus_total = telnetData.length;
              stats.onus_online = telnetData.filter(r => String(r.status).toLowerCase().includes('on')).length;
              stats.onus_offline = stats.onus_total - stats.onus_online;
              if (full) {
                stats.onus = telnetData.map((r, idx) => ({
                  index: r.id || idx,
                  id: r.id || '-',
                  name: r.name || r.mac || `ONU-${idx+1}`,
                  sn: formatSnWithColons(r.mac) || '-',
                  status: String(r.status).toLowerCase().includes('on') ? 'Online' : 'Offline',
                  offline_reason: translateOfflineReason(brandKey, r.offlineReason),
                  tx: r.txPower || 'N/A',
                  rx: r.rxPower || 'N/A',
                  distance: r.distance || '-',
                  firmware: r.fwVersion || '-',
                  uptime: r.onlineTime || '-'
                }));
              }
              await fetchHiosoSystemMetricsViaTelnet(olt, stats);
              safeResolve(stats);
              return;
            }
          }

          stats.error = `Tidak dapat terhubung ke OLT ${olt.host}:${olt.snmp_port || 161} (${stats.error || 'Offline / Socket Closed'}). Pastikan IP OLT aktif & Community string ('${community}') benar.`;
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
          // Telnet Fallback if profile not matched
          if (brandKey === 'hioso' || brandKey === 'hsgq') {
            const telnetData = await fetchHiosoOnuDetailViaTelnet(olt);
            if (telnetData && telnetData.length > 0) {
              stats.status = 'Online';
              stats.error = null;
              stats.onus_total = telnetData.length;
              stats.onus_online = telnetData.filter(r => String(r.status).toLowerCase().includes('on')).length;
              stats.onus_offline = stats.onus_total - stats.onus_online;
              if (full) {
                stats.onus = telnetData.map((r, idx) => ({
                  index: r.id || idx,
                  id: r.id || '-',
                  name: r.name || r.mac || `ONU-${idx+1}`,
                  sn: formatSnWithColons(r.mac) || '-',
                  status: String(r.status).toLowerCase().includes('on') ? 'Online' : 'Offline',
                  offline_reason: translateOfflineReason(brandKey, r.offlineReason),
                  tx: r.txPower || 'N/A',
                  rx: r.rxPower || 'N/A',
                  distance: r.distance || '-',
                  firmware: r.fwVersion || '-',
                  uptime: r.onlineTime || '-'
                }));
              }
              await fetchHiosoSystemMetricsViaTelnet(olt, stats);
              safeResolve(stats);
              return;
            }
          }

          stats.error = `Brand/Profile OID tidak cocok dengan perangkat OLT ${olt.host}. Silakan ganti Brand di menu 'Edit OLT'.`;
          safeResolve(stats);
          return;
        }

        const detectedBrandKey = activeProfile.__brandKey || brandKey;
        stats.activeProfile = activeProfile;
        stats.systemOids = SYSTEM_OIDS[detectedBrandKey] || null;
        stats.cardOids = CARD_OIDS[detectedBrandKey] || null;
        stats.snmpConfig = {
          host: olt.host,
          port: olt.snmp_port || 161,
          community: olt.snmp_community || 'public',
          brand: olt.brand
        };
        const onlineVals = getOnlineValues(detectedBrandKey, activeProfile);

        // Start system metrics concurrently
        const systemMetricsPromise = fetchSystemMetrics(session, detectedBrandKey, stats, olt);

        // 4. Mode Counter (ZTE)
        if (activeProfile.is_counter) {
          const [onlineMap, totalMap] = await Promise.all([
            slowWalk(session, activeProfile.status_table),
            slowWalk(session, activeProfile.name_table)
          ]);

          stats.onus_online  = Object.values(onlineMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_total   = Object.values(totalMap).reduce((s, v) => s + (bufferToInt(v) || 0), 0);
          stats.onus_offline = Math.max(0, stats.onus_total - stats.onus_online);

          await systemMetricsPromise;
          safeResolve(stats);
          return;
        }

        // 5. Mode Table (Hioso, VSOL, HSGQ, etc)
        const [statusMap, nameMap] = await Promise.all([
          slowWalk(session, activeProfile.status_table),
          slowWalk(session, activeProfile.name_table)
        ]);

        let snMap = {};
        let rxMap = {};
        let txMap = {};
        let distMap = {};
        let fwMap = {};
        let upMap = {};
        let reasonMap = {};

        // OPTIMIZATION: Only fetch detailed metrics if full=true
        // Summary mode: skip rx/tx/distance/firmware/uptime/reason walks
        // This makes summary 5-10x faster
        if (full) {
          // For Hioso/HSGQ, rx/tx DDM walks take ~33s (OLT measures all 256 slots on demand).
          // Use a dedicated slow session (30s timeout, 0 retries) and walk them SEQUENTIALLY
          // AFTER the fast walks complete. This prevents packet loss from concurrent walking.
          const isSlowDdmBrand = (detectedBrandKey === 'hioso' || detectedBrandKey === 'hsgq');

          if (isSlowDdmBrand && (activeProfile.rx_power_table || activeProfile.tx_power_table)) {
            // --- Phase 1: Fast walks (status already done, now sn + distance + card + unauth) ---
            const fastTasks = [];
            fastTasks.push(() => fetchCardMetrics(session, detectedBrandKey, stats));
            fastTasks.push(() => fetchUnauthOnus(session, activeProfile, stats));
            fastTasks.push(() => pickSnTable(session, activeProfile).then(res => snMap = res.map || {}));
            if (activeProfile.distance_table) {
              fastTasks.push(() => slowWalk(session, activeProfile.distance_table).then(res => distMap = res));
            }
            if (activeProfile.firmware_table) {
              fastTasks.push(() => slowWalk(session, activeProfile.firmware_table).then(res => fwMap = res));
            }
            if (activeProfile.uptime_table) {
              fastTasks.push(() => slowWalk(session, activeProfile.uptime_table).then(res => upMap = res));
            }
            if (activeProfile.offline_reason_table) {
              fastTasks.push(() => slowWalk(session, activeProfile.offline_reason_table).then(res => reasonMap = res));
            }
            await limitConcurrency(fastTasks, 2);

            // --- Phase 2: Slow DDM walks on dedicated session (sequential, high timeout) ---
            const slowSession = snmp.createSession(olt.host, community, {
              port:    olt.snmp_port || 161,
              timeout: 30000, // 30s per GETBULK batch — DDM on Hioso needs long timeouts
              retries: 0,     // No retries; a retry on a 30s timeout would kill the budget
              version: snmp.Version2c,
            });
            slowSession.on('error', (err) => {
              logger.warn(`[SNMP SlowSession Error] OLT ${olt.host}: ${err.message}`);
            });
            try {
              if (activeProfile.rx_power_table) {
                logger.info(`[oltService] Walking rx_power_table for OLT ${olt.host} (slow DDM session)`);
                rxMap = await slowWalk(slowSession, activeProfile.rx_power_table);
                logger.info(`[oltService] rx_power_table done, ${Object.keys(rxMap).length} entries`);
              }
              if (activeProfile.tx_power_table) {
                logger.info(`[oltService] Walking tx_power_table for OLT ${olt.host} (slow DDM session)`);
                txMap = await slowWalk(slowSession, activeProfile.tx_power_table);
                logger.info(`[oltService] tx_power_table done, ${Object.keys(txMap).length} entries`);
              }

              // Gap-fill: Hioso OLT truncates walk responses but individual GET works for all slots.
              // Find indices present in statusMap but missing from rxMap/txMap, then GET them directly.
              const statusIndices = Object.keys(statusMap);
              const missingRx = activeProfile.rx_power_table
                ? statusIndices.filter(idx => rxMap[idx] == null)
                : [];
              const missingTx = activeProfile.tx_power_table
                ? statusIndices.filter(idx => txMap[idx] == null)
                : [];

              if (missingRx.length > 0 || missingTx.length > 0) {
                logger.info(`[oltService] Gap-filling DDM: ${missingRx.length} rx + ${missingTx.length} tx missing, fetching via GET`);

                // Build OID list for batch GET (up to 50 per request)
                const batchGet = async (oidBase, indices, targetMap) => {
                  const BATCH = 50;
                  for (let i = 0; i < indices.length; i += BATCH) {
                    const batch = indices.slice(i, i + BATCH);
                    const oids = batch.map(idx => `${oidBase}.${idx}`);
                    await new Promise(rv => {
                      slowSession.get(oids, (err, vbs) => {
                        if (err) { rv(); return; }
                        for (const vb of vbs) {
                          if (!vb || snmp.isVarbindError(vb)) continue;
                          const suffix = vb.oid.split(oidBase + '.')[1];
                          if (!suffix) continue;
                          const val = Buffer.isBuffer(vb.value)
                            ? vb.value.toString('utf8').replace(/\0/g,'').trim()
                            : String(vb.value).trim();
                          if (val && val !== 'null' && val !== '0') {
                            targetMap[suffix] = vb.value; // store raw for decoding
                          }
                        }
                        rv();
                      });
                    });
                  }
                };

                await batchGet(activeProfile.rx_power_table, missingRx, rxMap);
                await batchGet(activeProfile.tx_power_table, missingTx, txMap);
                logger.info(`[oltService] Gap-fill done, rx now ${Object.keys(rxMap).length}, tx now ${Object.keys(txMap).length}`);
              }
            } catch (ddmErr) {
              logger.warn(`[oltService] DDM walk failed for OLT ${olt.host}: ${ddmErr.message}`);
            } finally {
              try { slowSession.close(); } catch (e) {}
            }

          } else {
            // --- Standard path for all other brands ---
            const tasks = [];
            tasks.push(() => fetchCardMetrics(session, detectedBrandKey, stats));
            tasks.push(() => fetchUnauthOnus(session, activeProfile, stats));
            tasks.push(() => pickSnTable(session, activeProfile).then(res => snMap = res.map || {}));
            if (activeProfile.rx_power_table) {
              tasks.push(() => slowWalk(session, activeProfile.rx_power_table).then(res => rxMap = res));
            }
            if (activeProfile.tx_power_table) {
              tasks.push(() => slowWalk(session, activeProfile.tx_power_table).then(res => txMap = res));
            }
            if (activeProfile.distance_table) {
              tasks.push(() => slowWalk(session, activeProfile.distance_table).then(res => distMap = res));
            }
            if (activeProfile.firmware_table) {
              tasks.push(() => slowWalk(session, activeProfile.firmware_table).then(res => fwMap = res));
            }
            if (activeProfile.uptime_table) {
              tasks.push(() => slowWalk(session, activeProfile.uptime_table).then(res => upMap = res));
            }
            if (activeProfile.offline_reason_table) {
              tasks.push(() => slowWalk(session, activeProfile.offline_reason_table).then(res => reasonMap = res));
            }

            // OPTIMIZATION: Tune concurrency per brand
            // ZTE handles 5, others 3-4
            const concurrencyMap = {
              'zte': 5,
              'huawei': 4,
              'hioso': 2,
              'vsol': 4,
              'cdata': 3,
              'hsgq': 2
            };
            const concurrency = concurrencyMap[detectedBrandKey] || 4;
            await limitConcurrency(tasks, concurrency);
          }
        }

        await systemMetricsPromise;

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
          // SNMP returns ONU name as Buffer (OctetString) — must decode as UTF-8
          const nameStr = nameRaw == null
            ? ''
            : (Buffer.isBuffer(nameRaw)
                ? nameRaw.toString('utf8')
                : String(nameRaw)
              ).replace(/\0/g, '').trim();
          const name = nameStr || ('ONU-' + idx);
          const snVal = getByIdx(snMap, idx);
          const rxVal = getByIdx(rxMap, idx);
          const txVal = getByIdx(txMap, idx);
          const distVal = getByIdx(distMap, idx);
          const fwVal = getByIdx(fwMap, idx);
          const upVal = getByIdx(upMap, idx);

          const sn   = snVal ? decodeSn(snVal) : '-';
          const rx   = decodeRxPower(detectedBrandKey, rxVal);
          const tx   = decodeRxPower(detectedBrandKey, txVal);
          const distInt = bufferToInt(distVal);
          let distance = '-';
          if (activeProfile.distance_table && distInt != null && distInt > 0) {
            const tenths = activeProfile.distance_tenths_meter !== false;
            distance = tenths ? (distInt / 10).toFixed(1) + ' m' : `${distInt} m`;
          }
          const firmware = safeToString(fwVal) || '-';
          const onuUptime = upVal ? decodeUptime(bufferToInt(upVal)) : '-';
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

            const rawReason = getByIdx(reasonMap, idx);
            const offlineReason = translateOfflineReason(detectedBrandKey, rawReason);

            onus.push({
              index: idx,
              id: onuId || '-',
              name,
              sn,
              status: isUp ? 'Online' : 'Offline',
              offline_reason: isUp ? null : (offlineReason || null),
              tx: txShown,
              rx: rxShown,
              distance,
              firmware,
              uptime: onuUptime
            });
          }
        }

        stats.onus_weak = weakCount;
        stats.onus = enrichOnusWithCustomerData(onus.sort((a, b) => a.name.localeCompare(b.name)));
        safeResolve(stats);
      } catch (err) {
        stats.error = err.message;
        safeResolve(stats);
      }
    })();
  });
}

function enrichOnusWithCustomerData(onus) {
  if (!Array.isArray(onus) || onus.length === 0) return onus;
  try {
    const custs = db.prepare(`
      SELECT id, name, pppoe_username, mac_address, genieacs_tag, phone
      FROM customers
    `).all() || [];

    const pppoeMap = new Map();
    const macMap = new Map();
    const tagMap = new Map();
    const nameMap = new Map();

    for (const c of custs) {
      if (c.pppoe_username) pppoeMap.set(String(c.pppoe_username).trim().toLowerCase(), c);
      if (c.mac_address) {
        const rawMac = String(c.mac_address).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (rawMac) macMap.set(rawMac, c);
      }
      if (c.genieacs_tag) tagMap.set(String(c.genieacs_tag).trim().toLowerCase(), c);
      if (c.name) nameMap.set(String(c.name).trim().toLowerCase(), c);
    }

    for (const onu of onus) {
      const snClean = String(onu.sn || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const nameClean = String(onu.name || '').trim().toLowerCase();

      let matched = null;
      if (snClean && macMap.has(snClean)) matched = macMap.get(snClean);
      else if (snClean && tagMap.has(snClean)) matched = tagMap.get(snClean);
      else if (nameClean && pppoeMap.has(nameClean)) matched = pppoeMap.get(nameClean);
      else if (nameClean && nameMap.has(nameClean)) matched = nameMap.get(nameClean);
      else if (snClean.length >= 6) {
        for (const [mac, c] of macMap.entries()) {
          if (mac.length >= 8 && (snClean.includes(mac) || mac.includes(snClean))) {
            matched = c;
            break;
          }
        }
      }

      if (matched) {
        onu.customer_id = matched.id;
        onu.customer_name = matched.name;
        onu.customer_phone = matched.phone || null;
      }
    }
  } catch (e) {
    logger.warn(`[OLT] Error enriching ONUs with customer data: ${e.message}`);
  }
  return onus;
}

// ─── ONU ACTIONS ─────────────────────────────────────────────────────────────

function decodeOltSnmpIndex(brand, index) {
  const idxNum = parseInt(index, 10);
  if (!Number.isFinite(idxNum)) {
    const s = String(index || '');
    let frame = '0', board = '1', port = '1', onuId = '1';
    const parts = s.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
    return { frame, board, port, onuId };
  }

  const bKey = String(brand || '').toLowerCase();
  if (bKey === 'zte') {
    const board = (idxNum >> 16) & 0xFF;
    const port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: '0', board: String(board), port: String(port), onuId: String(onuId) };
  } else if (bKey === 'huawei') {
    const frame = (idxNum >> 21) & 0x1F;
    const slot = (idxNum >> 16) & 0x1F;
    const port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: String(frame), board: String(slot), port: String(port), onuId: String(onuId) };
  } else {
    let port = (idxNum >> 16) & 0xFF;
    if (port === 0 || port > 16) port = (idxNum >> 8) & 0xFF;
    const onuId = idxNum & 0xFF;
    return { frame: '0', board: '0', port: String(port), onuId: String(onuId) };
  }
}

async function rebootOnu(oltId, index) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  if (brand === 'zte' || brand === 'huawei') {
    const onuProvisionSvc = require('./onuProvisionService');
    const oltConfig = {
      vendor: olt.brand,
      host: olt.host,
      username: olt.web_user,
      password: olt.web_password
    };
    const portVal = parseInt(olt.telnet_port, 10);
    oltConfig.port = (Number.isFinite(portVal) && portVal > 0) ? portVal : 22;
    
    const parsed = decodeOltSnmpIndex(olt.brand, index);
    return await onuProvisionSvc.rebootONU(oltConfig, olt.brand, parsed);
  }

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

  const brand = (olt.brand || 'hioso').toLowerCase();
  if (brand === 'zte' || brand === 'huawei') {
    const onuProvisionSvc = require('./onuProvisionService');
    const oltConfig = {
      vendor: olt.brand,
      host: olt.host,
      username: olt.web_user,
      password: olt.web_password
    };
    const portVal = parseInt(olt.telnet_port, 10);
    oltConfig.port = (Number.isFinite(portVal) && portVal > 0) ? portVal : 22;
    
    const parsed = decodeOltSnmpIndex(olt.brand, index);
    parsed.newName = newName;
    return await onuProvisionSvc.renameONU(oltConfig, olt.brand, parsed);
  }

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

/**
 * Otorisasi ONU (Provisioning) via Telnet CLI.
 */
async function authorizeOnu(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  const { index, sn, name, vlan } = data;
  const snCli = normalizeSnForOltProvision(sn);

  // Parsing index (format ZTE: 1/board/port:onuId)
  let board = 1, port = 1, onuId = 1;
  if (index.includes('/')) {
    const parts = index.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
  }

  const cmds = [];
  if (brand === 'zte') {
    cmds.push('enable');
    cmds.push('configure terminal');
    cmds.push(`interface gpon-olt_1/${board}/${port}`);
    cmds.push(`onu ${onuId} type ALL sn ${snCli}`);
    cmds.push('exit');
    cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
    if (name) cmds.push(`name ${name}`);
    cmds.push('tcont 1 profile UP-100M'); // Default profile
    cmds.push('gemport 1 tcont 1');
    if (vlan) cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    cmds.push('exit');
    cmds.push('end');
    cmds.push('write');
  } else if (brand === 'huawei') {
    cmds.push('enable');
    cmds.push('config');
    cmds.push(`interface gpon 0/${board}`);
    cmds.push(`ont add ${port} ${onuId} sn-auth ${snCli} omci ont-lineprofile-id 1 ont-srvprofile-id 1`);
    if (name) cmds.push(`ont name ${port} ${onuId} "${name}"`);
    cmds.push('quit');
    if (vlan) cmds.push(`service-port vlan ${vlan} gpon 0/${board}/${port} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
    cmds.push('save');
  } else {
    throw new Error(`Fitur otorisasi otomatis belum didukung untuk brand ${brand}`);
  }

  return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
}

/**
 * Cari data tambahan ONU dari ACS (WiFi, Client Count, dll)
 */
async function enrichOnusWithAcsData(onus) {
  try {
    logger.info(`[ACS-Sync] Memulai sinkronisasi data untuk ${onus.length} ONU`);
    const acsDevices = await genieacs.getDevices();
    if (!acsDevices || !acsDevices.length) {
      logger.warn('[ACS-Sync] Tidak ada perangkat ditemukan di GenieACS');
      return onus;
    }

    const normalizeSN = (sn) => String(sn || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

    for (const onu of onus) {
      const targetSn = normalizeSN(onu.sn);
      if (!targetSn || targetSn === '-') continue;

      logger.debug(`[ACS-Sync] Mencari SN: ${targetSn}`);

      // Cari device di ACS berdasarkan SN (fuzzy match)
      const acsDev = acsDevices.find(d => {
        const sn1 = d.Device?.DeviceInfo?.SerialNumber?._value;
        const sn2 = d.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value;
        const sn3 = d._id;
        
        const acsSn = normalizeSN(sn1 || sn2 || sn3);
        const match = acsSn.includes(targetSn) || targetSn.includes(acsSn);
        if (match) logger.info(`[ACS-Sync] Match Found: ${targetSn} matches ${acsSn} (ID: ${d._id})`);
        return match;
      });

      if (acsDev) {
        // Ambil SSID (Cek beberapa path umum)
        const ssid = 
          acsDev.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value ||
          acsDev.Device?.WiFi?.SSID?.['1']?.SSID?._value || 
          acsDev.Device?.WiFi?.SSID?.['1']?.SSID || 
          acsDev.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['5']?.SSID?._value || '-';
        
        onu.wifi_ssid = ssid;
        
        // Hitung Client Connected (Sum up all radios if possible)
        let associations = 0;
        const paths = [
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
          'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
          'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries',
          'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
          'Device.Hosts.HostNumberOfEntries'
        ];

        for (const p of paths) {
          const val = getNestedValue(acsDev, p);
          if (val !== undefined && val !== null) {
            associations += parseInt(val) || 0;
          }
        }
        
        onu.client_count = associations;
        onu.acs_id = acsDev._id;
        logger.info(`[ACS-Sync] Updated ${onu.sn}: SSID=${onu.wifi_ssid}, Users=${onu.client_count}`);
      }
    }
  } catch (e) {
    logger.error(`[ACS-Sync] Error: ${e.message}`);
  }
  return onus;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((prev, curr) => {
    if (prev && prev[curr] !== undefined) {
      const val = prev[curr];
      return (val && val._value !== undefined) ? val._value : val;
    }
    return undefined;
  }, obj);
}

function parseZteOnuIndex(index) {
  let board = 1;
  let port = 1;
  let onuId = 1;
  const s = String(index || '');
  if (s.includes('/')) {
    const parts = s.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
  }
  return { board: String(board), port: String(port), onuId: String(onuId) };
}

const telnetOptsFromOlt = (olt) => ({
  port: Number(olt.telnet_port) > 0 ? Number(olt.telnet_port) : 23,
  enablePassword: olt.enable_password != null && String(olt.enable_password).length > 0 ? String(olt.enable_password) : null
});

/**
 * Delegasi VLAN / service-port ke [go-api-c320](https://github.com/s4lfanet/go-api-c320) — POST /api/v1/vlan/onu
 * Format pon_port: rack/shelf/slot (contoh 1/2/7) dari indeks gpon-onu_1/2/7:5
 */
async function configureZteWanViaGoApi(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const base = String(olt.api_base_url || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('Isi "API Base URL" pada data OLT (contoh http://10.0.0.5:8081) agar metode Go API dapat memanggil go-api-c320.');
  }

  const mode = String(data.mode || 'Bridge');
  if (mode === 'PPPoE') {
    throw new Error('Integrasi REST ini memetakan ke VLAN/service-port go-api-c320. Untuk PPPoE gunakan Telnet CLI (OMCI) atau TR069.');
  }

  const { board, port, onuId } = parseZteOnuIndex(data.index);
  const ponPort = `1/${board}/${port}`;
  if (!/^\d+\/\d+\/\d+$/.test(ponPort)) {
    throw new Error('Indeks ONU tidak valid untuk Go API (butuh slot/port/onu, mis. gpon-onu_1/2/7:5 → pon_port 1/2/7).');
  }

  const onu_id = parseInt(String(onuId), 10);
  if (!Number.isFinite(onu_id) || onu_id < 1 || onu_id > 128) {
    throw new Error('ONU ID tidak valid (1–128).');
  }

  const svlan = parseInt(String(data.vlan != null ? data.vlan : data.svlan), 10);
  const cvlanIn = data.cvlan != null && String(data.cvlan).trim() !== '' ? parseInt(String(data.cvlan), 10) : NaN;
  const cvlan = Number.isFinite(cvlanIn) ? cvlanIn : svlan;

  if (!Number.isFinite(svlan) || svlan < 1 || svlan > 4094) {
    throw new Error('VLAN / SVLAN harus antara 1 dan 4094.');
  }

  const vlan_mode = String(data.vlan_mode || 'tag').toLowerCase();
  const allowed = ['tag', 'translation', 'transparent'];
  if (!allowed.includes(vlan_mode)) {
    throw new Error('vlan_mode harus: tag, translation, atau transparent (sesuai go-api-c320).');
  }

  if (vlan_mode === 'translation' && (!Number.isFinite(cvlan) || cvlan < 1)) {
    throw new Error('Mode translation membutuhkan CVLAN.');
  }

  const priority = Number.isFinite(parseInt(data.priority, 10)) ? parseInt(data.priority, 10) : 0;
  if (priority < 0 || priority > 7) {
    throw new Error('Priority harus 0–7.');
  }

  const url = `${base}/api/v1/vlan/onu`;
  const body = {
    pon_port: ponPort,
    onu_id,
    svlan,
    cvlan: vlan_mode === 'translation' ? cvlan : (Number.isFinite(cvlan) ? cvlan : svlan),
    vlan_mode,
    priority
  };

  const res = await axios.post(url, body, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });

  const payload = res.data;
  const httpOk = res.status >= 200 && res.status < 300;
  const apiCode = payload != null && payload.code != null ? Number(payload.code) : null;
  if (!httpOk || (apiCode != null && apiCode >= 400)) {
    const msg = payload?.message || payload?.status || payload?.error || `HTTP ${res.status}`;
    throw new Error(`go-api-c320: ${msg}`);
  }

  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

/**
 * Konfigurasi WAN ONU via TR069 (GenieACS).
 */
async function configureWanViaAcs(sn, data) {
  const acsDevices = await genieacs.getDevices();
  const acsDev = acsDevices.find(d => d._id.includes(sn) || (d.Device?.DeviceInfo?.SerialNumber?._value && d.Device.DeviceInfo.SerialNumber._value.includes(sn)));
  
  if (!acsDev) throw new Error(`Perangkat dengan SN ${sn} tidak ditemukan di ACS.`);

  const { mode, vlan, username, password, lans, ssids } = data;
  const params = {};

  // Helper to build binding strings
  // Typical formats: "LAN1,LAN2" or "WLAN1,WLAN2"
  const lanBind = lans ? lans.split(',').map(l => `LAN${l}`).join(',') : '';
  const ssidBind = ssids ? ssids.split(',').map(s => `WLAN${s}`).join(',') : '';

  if (mode === 'PPPoE') {
    const basePath = "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.";
    params[`${basePath}Enable`] = true;
    params[`${basePath}ConnectionType`] = "IP_Routed";
    params[`${basePath}Name`] = "INTERNET";
    params[`${basePath}Username`] = username;
    params[`${basePath}Password`] = password;
    if (vlan) {
      params[`${basePath}VLANID`] = vlan;
    }
    // LAN & SSID Binding for Broadcom/Typical ONUs
    if (lanBind) params[`${basePath}X_BROADCOM_COM_LANBind`] = lanBind;
    if (ssidBind) params[`${basePath}X_BROADCOM_COM_WLANBind`] = ssidBind;
    
  } else {
    const basePath = "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.";
    params[`${basePath}Enable`] = true;
    params[`${basePath}ConnectionType`] = "IP_Bridged";
    if (vlan) {
      params[`${basePath}VLANID`] = vlan;
    }
    // LAN & SSID Binding
    if (lanBind) params[`${basePath}X_BROADCOM_COM_LANBind`] = lanBind;
    if (ssidBind) params[`${basePath}X_BROADCOM_COM_WLANBind`] = ssidBind;
  }

  return await genieacs.setParameterValues(acsDev._id, params);
}

/**
 * Konfigurasi WAN ONU (PPPoE / Bridge) via Telnet CLI.
 */
 async function configureOnuWan(oltId, data) {
  const olt = getOltById(oltId);
  if (!olt) throw new Error('OLT tidak ditemukan');

  const brand = (olt.brand || 'hioso').toLowerCase();
  const method = String(data.method || 'telnet').toLowerCase();

  if (method === 'go-api' && brand !== 'zte') {
    throw new Error('Metode REST (go-api-c320) hanya untuk OLT brand ZTE.');
  }
  if (brand === 'zte' && method === 'go-api') {
    return configureZteWanViaGoApi(oltId, data);
  }

  const { index, mode, vlan, username, password, lans, ssids } = data;

  // Parsing index
  let board = 1, port = 1, onuId = 1;
  if (index.includes('/')) {
    const parts = index.split(/[/: ]+/).filter(Boolean);
    if (parts.length >= 3) {
      board = parts[parts.length - 3];
      port = parts[parts.length - 2];
      onuId = parts[parts.length - 1];
    }
  }

  const cmds = [];
  if (brand === 'zte') {
    cmds.push('enable');
    cmds.push('configure terminal');
    
    if (mode === 'PPPoE') {
      // ZTE C300/C320 PPPoE Config via OMCI (pon-onu-mng)
      cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
      
      // 1. Configure WAN IP with PPPoE
      // Note: vlan here is used as vlan-profile name. Usually named 'VLAN100' or just '100'
      cmds.push(`wan-ip 1 mode pppoe username ${username} password ${password} vlan-profile ${vlan} host 1`);
      
      // 2. Binding LAN & SSID
      if (lans || ssids) {
        let bindCmd = `wan 1`;
        if (lans) bindCmd += ` ethuni ${lans}`;
        if (ssids) bindCmd += ` ssid ${ssids}`;
        bindCmd += ` service internet host 1`;
        cmds.push(bindCmd);
      }
      
      cmds.push('exit');
      
      // OLT side service-port
      cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
      cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    } else {
      // Bridge Mode
      cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
      
      // Tagging each selected port to the target VLAN
      if (vlan) {
        if (lans) {
          lans.split(',').forEach(l => {
            cmds.push(`vlan port eth_0/${l} mode tag vlan ${vlan}`);
          });
        }
        if (ssids) {
          ssids.split(',').forEach(s => {
            cmds.push(`vlan port wifi_0/${s} mode tag vlan ${vlan}`);
          });
        }
      }
      
      cmds.push('exit');
      
      // OLT side service-port
      cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
      cmds.push(`service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`);
    }
    
    cmds.push('exit');
    cmds.push('end');
    cmds.push('write');
    return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
  } else if (brand === 'huawei') {
     cmds.push('enable');
     cmds.push('config');
     if (mode === 'PPPoE') {
       // Huawei usually configures WAN via OMCI/TR069, but basic service-port is needed
       cmds.push(`service-port vlan ${vlan} gpon 0/${board}/${port} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
     } else {
       cmds.push(`service-port vlan ${vlan} gpon 0/${board}/${port} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
     }
     cmds.push('save');
   } else {
     throw new Error(`Fitur konfigurasi WAN belum didukung untuk brand ${brand}`);
   }
 
   return await telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, cmds, telnetOptsFromOlt(olt));
 }
 
 async function getAllOltsStats(full = false) {
   const olts = getActiveOlts();
   if (!olts || olts.length === 0) {
     return {
       is_all: true,
       onus_total: 0,
       onus_online: 0,
       onus_offline: 0,
       onus_weak: 0,
       onus: [],
       unauth_onus: [],
       olts_summary: [],
       error: 'Tidak ada OLT aktif'
     };
   }

   const results = await Promise.all(olts.map(o => getOltStats(o.id, full)));

   let onus_total = 0;
   let onus_online = 0;
   let onus_offline = 0;
   let onus_weak = 0;
   let uplink_rx = 0;
   let uplink_tx = 0;
   const allOnus = [];
   const allUnauth = [];
   const olts_summary = [];

   const tempValues = [];
   const cpuValues = [];
   const ramValues = [];

   for (let i = 0; i < results.length; i++) {
     const s = results[i];
     const oltInfo = olts[i];
     if (s) {
       onus_total += (s.onus_total || 0);
       onus_online += (s.onus_online || 0);
       onus_offline += (s.onus_offline || 0);
       onus_weak += (s.onus_weak || 0);
       uplink_rx += (s.uplink_rx || 0);
       uplink_tx += (s.uplink_tx || 0);

       const tN = parseFloat(s.temp);
       if (Number.isFinite(tN) && tN > 0) tempValues.push(tN);
       const cN = parseFloat(s.cpu);
       if (Number.isFinite(cN) && cN >= 0) cpuValues.push(cN);
       const rN = parseFloat(s.ram);
       if (Number.isFinite(rN) && rN > 0) ramValues.push(rN);

       olts_summary.push({
         id: oltInfo.id,
         name: oltInfo.name,
         host: oltInfo.host,
         brand: oltInfo.brand,
         status: s.status,
         onus_total: s.onus_total,
         onus_online: s.onus_online,
         onus_offline: s.onus_offline,
         onus_weak: s.onus_weak,
         temp: s.temp,
         cpu: s.cpu,
         ram: s.ram,
         uptime: s.uptime,
         uplink_rx: s.uplink_rx || 0,
         uplink_tx: s.uplink_tx || 0,
         error: s.error,
         activeProfile: s.activeProfile || null,
         systemOids: s.systemOids || null,
         snmpConfig: s.snmpConfig || null
       });

       if (Array.isArray(s.onus)) {
         s.onus.forEach(onu => {
           allOnus.push({ ...onu, olt_id: oltInfo.id, olt_name: oltInfo.name });
         });
       }

       if (Array.isArray(s.unauth_onus)) {
         s.unauth_onus.forEach(u => {
           allUnauth.push({ ...u, olt_id: oltInfo.id, olt_name: oltInfo.name });
         });
       }
     }
   }

   let temp = 'N/A';
   let cpu = 'N/A';
   let ram = 'N/A';
   let uptime = 'Multi-OLT Active';

   if (olts_summary.length === 1) {
     const s0 = olts_summary[0];
     temp = s0.temp || 'N/A';
     cpu = s0.cpu || 'N/A';
     ram = s0.ram || 'N/A';
     uptime = s0.uptime || 'N/A';
   } else if (olts_summary.length > 1) {
     if (tempValues.length > 0) {
       const avgT = Math.round(tempValues.reduce((a, b) => a + b, 0) / tempValues.length);
       temp = `${avgT}°C (rata-rata)`;
     }
     if (cpuValues.length > 0) {
       const avgC = Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length);
       cpu = `${avgC}% (rata-rata)`;
     }
     if (ramValues.length > 0) {
       const avgR = Math.round(ramValues.reduce((a, b) => a + b, 0) / ramValues.length);
       ram = `${avgR}% (rata-rata)`;
     }
     const onlineCount = olts_summary.filter(o => o.status === 'Online').length;
     uptime = `${onlineCount}/${olts_summary.length} OLT Online`;
   }

   return {
     is_all: true,
     onus_total,
     onus_online,
     onus_offline,
     onus_weak,
     temp,
     cpu,
     ram,
     uptime,
     uplink_rx,
     uplink_tx,
     onus: allOnus,
     unauth_onus: allUnauth,
     olts_summary
   };
 }

 async function testOltConnection(data) {
   const host = String(data.host || '').trim();
   const snmpPort = parseInt(data.snmp_port, 10) || 161;
   const snmpCommunity = String(data.snmp_community || 'public').trim();
   const brand = String(data.brand || 'generic').toLowerCase();
   const telnetPort = parseInt(data.telnet_port, 10) || 23;
   const webUser = String(data.web_user || 'admin').trim();
   const webPassword = String(data.web_password || 'admin').trim();
   const enablePassword = data.enable_password ? String(data.enable_password).trim() : null;

   if (!host) {
     return { success: false, message: 'Host/IP OLT harus diisi.' };
   }

   const result = {
     success: false,
     host,
     snmp: { ok: false, error: null, uptime: null, sysDescr: null, profile: null, onus: 0 },
     telnet: { ok: false, error: null },
     messages: []
   };

   // 1. Test SNMP v2c
   try {
     const session = snmp.createSession(host, snmpCommunity, {
       port: snmpPort,
       timeout: 3000,
       retries: 1,
       version: snmp.Version2c
     });

     const vbs = await new Promise((resolve) => {
       session.get(['1.3.6.1.2.1.1.3.0'], (err, res) => {
         if (err) resolve(null);
         else resolve(res);
       });
     });

     if (vbs && vbs[0] && !snmp.isVarbindError(vbs[0])) {
       result.snmp.ok = true;
       result.snmp.uptime = decodeUptime(vbs[0].value);

       // Probe profile
       const selectedProfiles = (BRAND_PROFILES[brand] || []).map(p => ({ ...p, __brandKey: brand }));
       const otherProfiles = Object.keys(BRAND_PROFILES)
         .filter(k => k !== brand)
         .reduce((acc, k) => acc.concat((BRAND_PROFILES[k] || []).map(p => ({ ...p, __brandKey: k }))), []);
       const allProfiles = [...selectedProfiles, ...otherProfiles];

       for (const p of allProfiles) {
         const ok = await probeOid(session, p.probe_oid);
         if (ok) {
           result.snmp.profile = p.name;
           try {
             const statusMap = await slowWalk(session, p.status_table, 500);
             result.snmp.onus = Object.keys(statusMap).length;
           } catch (e) {}
           break;
         }
       }
       result.messages.push(`SNMP OK (Uptime: ${result.snmp.uptime}, Profil: ${result.snmp.profile || 'Standar'}, ${result.snmp.onus} ONU)`);
     } else {
       result.snmp.error = 'Tidak ada respon SNMP. Pastikan Service SNMP di OLT sudah Aktif dan IP/Community benar.';
     }
     try { session.close(); } catch (e) {}
   } catch (e) {
     result.snmp.error = e.message;
   }

   // 2. Test Telnet
   try {
     await telnetLoginAndRun(host, webUser, webPassword, ['show version'], {
       port: telnetPort,
       enablePassword
     });
     result.telnet.ok = true;
     result.messages.push('Telnet CLI OK (Login Berhasil)');
   } catch (e) {
     result.telnet.error = e.message;
   }

   result.success = result.snmp.ok || result.telnet.ok;
   result.message = result.messages.join(' | ') || (result.snmp.error || result.telnet.error || 'Gagal terhubung ke OLT');
   return result;
 }

 module.exports = {
  getAllOlts, getActiveOlts, getOltById, createOlt, updateOlt, deleteOlt, getOltStats, getAllOltsStats, testOltConnection, rebootOnu, renameOnu, authorizeOnu,
  configureOnuWan, configureZteWanViaGoApi, configureWanViaAcs
};
