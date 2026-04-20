const db = require('../config/database');
const { logger } = require('../config/logger');
const snmp = require('net-snmp');

/**
 * SNMP OIDs for common OLT brands
 */
const OIDS = {
  zte: {
    temp: '1.3.6.1.4.1.3902.1012.3.1.1.1.2.1',
    cpu: '1.3.6.1.4.1.3902.1012.3.1.1.1.1.1',
    ram: '1.3.6.1.4.1.3902.1012.3.1.1.1.3.1',
    uptime: '1.3.6.1.2.1.1.3.0',
    onus_total: '1.3.6.1.4.1.3902.1012.3.28.1.1.3', // zxAnOnuCount (Requires table context usually, but some firmwares provide scalar)
    onus_online: '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
    voltage: '1.3.6.1.4.1.3902.1012.3.1.1.1.4.1',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1', // ifHCInOctets (Port 1 usually uplink)
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  huawei: {
    temp: '1.3.6.1.4.1.2011.6.1.1.1.3.0',
    cpu: '1.3.6.1.4.1.2011.6.1.1.1.4.0',
    ram: '1.3.6.1.4.1.2011.6.1.1.1.2.0',
    uptime: '1.3.6.1.2.1.1.3.0',
    onus_total: '1.3.6.1.4.1.2011.6.128.1.1.2.21.1.15', // Placeholder
    onus_online: '1.3.6.1.4.1.2011.6.128.1.1.2.21.1.15', // Placeholder
    voltage: '1.3.6.1.4.1.2011.6.1.1.1.2.0',
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  vsol: {
    temp: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.3.1',
    cpu: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.4.1',
    ram: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.5.1',
    uptime: '1.3.6.1.2.1.1.3.0',
    onus_total: '1.3.6.1.4.1.37950.1.1.5.10.12.2.1.1.2.1', // totalRegisteredOnu
    onus_online: '1.3.6.1.4.1.37950.1.1.5.10.12.2.1.1.3.1', // totalOnlineOnu
    voltage: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.2.1',
    uplink_rx: '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.7.1',
    uplink_tx: '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.8.1',
  },
  hioso: {
    temp: '1.3.6.1.4.1.34592.1.3.1.1.1.1.12.1',
    cpu: '1.3.6.1.4.1.34592.1.3.1.1.1.1.10.1',
    ram: '1.3.6.1.4.1.34592.1.3.1.1.1.1.11.1',
    uptime: '1.3.6.1.2.1.1.3.0',
    onus_total: '1.3.6.1.4.1.34592.1.3.1.1.1.1.2.1', // Placeholder
    onus_online: '1.3.6.1.4.1.34592.1.3.1.1.1.1.2.1', // Placeholder
    voltage: '1.3.6.1.4.1.34592.1.3.1.1.1.1.12.1', // Placeholder
    uplink_rx: '1.3.6.1.2.1.31.1.1.1.6.1',
    uplink_tx: '1.3.6.1.2.1.31.1.1.1.10.1',
  },
  hsgq: {
    temp: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.3.1',
    cpu: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.4.1',
    ram: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.5.1',
    uptime: '1.3.6.1.2.1.1.3.0',
    onus_total: '1.3.6.1.4.1.37950.1.1.5.10.12.2.1.1.2.1',
    onus_online: '1.3.6.1.4.1.37950.1.1.5.10.12.2.1.1.3.1',
    voltage: '1.3.6.1.4.1.37950.1.1.5.10.12.1.1.2.1',
    uplink_rx: '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.7.1',
    uplink_tx: '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.8.1',
  }
};

/**
 * OLT SERVICE
 * Mengelola data Multi-OLT dan monitoring via SNMP
 */

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
    INSERT INTO olts (name, host, snmp_community, snmp_port, brand, description, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.host,
    data.snmp_community || 'public',
    data.snmp_port || 161,
    data.brand || 'zte',
    data.description || '',
    data.is_active !== undefined ? data.is_active : 1
  );
}

function updateOlt(id, data) {
  const stmt = db.prepare(`
    UPDATE olts 
    SET name = ?, host = ?, snmp_community = ?, snmp_port = ?, brand = ?, description = ?, is_active = ?
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
    id
  );
}

function deleteOlt(id) {
  return db.prepare('DELETE FROM olts WHERE id = ?').run(id);
}

/**
 * SNMP MONITORING
 */
async function getOltStats(oltId) {
  const olt = getOltById(oltId);
  if (!olt || !olt.is_active) return null;

  const brand = olt.brand.toLowerCase();
  const oids = OIDS[brand] || OIDS.zte; // Default to ZTE OIDs if brand not found

  return new Promise((resolve) => {
    const session = snmp.createSession(olt.host, olt.snmp_community || 'public', {
      port: olt.snmp_port || 161,
      timeout: 2000,
      retries: 1
    });

    const oidsToGet = [oids.temp, oids.cpu, oids.ram, oids.uptime, oids.onus_total, oids.onus_online, oids.voltage, oids.uplink_rx, oids.uplink_tx];
    
    session.get(oidsToGet, (error, varbinds) => {
      let stats = {
        id: olt.id,
        name: olt.name,
        status: 'Offline',
        uptime: 'N/A',
        temp: 'N/A',
        cpu: 'N/A',
        ram: 'N/A',
        onus_total: 0,
        onus_online: 0,
        voltage: 'N/A',
        uplink_rx: 0,
        uplink_tx: 0
      };

      if (error) {
        logger.error(`[SNMP] Error fetching OLT ${olt.name}: ${error.message}`);
        session.close();
        return resolve(stats);
      }

      stats.status = 'Online';
      
      for (let i = 0; i < varbinds.length; i++) {
        if (snmp.isVarbindError(varbinds[i])) {
          continue;
        }

        const value = varbinds[i].value;
        const oid = varbinds[i].oid;

        if (oid === oids.temp) stats.temp = value + '°C';
        else if (oid === oids.cpu) stats.cpu = value + '%';
        else if (oid === oids.ram) stats.ram = value + '%';
        else if (oid === oids.onus_total) stats.onus_total = parseInt(value) || 0;
        else if (oid === oids.onus_online) stats.onus_online = parseInt(value) || 0;
        else if (oid === oids.uplink_rx) stats.uplink_rx = Number(value);
        else if (oid === oids.uplink_tx) stats.uplink_tx = Number(value);
        else if (oid === oids.voltage) {
            // Usually voltage is in 0.01V or 0.1V units depending on brand
            const v = parseInt(value);
            stats.voltage = (v > 1000 ? (v/1000).toFixed(2) : (v/10).toFixed(1)) + 'V';
        }
        else if (oid === oids.uptime) {
          const sysUpTime = parseInt(value);
          const days = Math.floor(sysUpTime / (100 * 60 * 60 * 24));
          const hours = Math.floor((sysUpTime % (100 * 60 * 60 * 24)) / (100 * 60 * 60));
          stats.uptime = `${days}d ${hours}h`;
        }
      }

      session.close();
      resolve(stats);
    });
  });
}

module.exports = {
  getAllOlts,
  getActiveOlts,
  getOltById,
  createOlt,
  updateOlt,
  deleteOlt,
  getOltStats
};
