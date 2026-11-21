'use strict';

/**
 * Service: NOC Wallboard & Monitoring Telemetry
 * Provides high-performance, cached, and aggregated data for NOC display screens.
 */

const os = require('os');
const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const { getSetting, getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');

// Cache to prevent hammering MikroTik when multiple screens/tabs are open
let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 1200; // 1.2 second cache

/**
 * Get all available routers for NOC display
 */
function getNocRouters() {
  const dbRouters = mikrotikService.getAllRouters();
  const settings = getSettings();
  const defaultRouter = {
    id: 'settings_json',
    name: settings.mikrotik_name || 'MikroTik Utama',
    host: settings.mikrotik_host || '192.168.8.1',
    user: settings.mikrotik_user || 'admin',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };

  return dbRouters.length > 0 ? dbRouters : [defaultRouter];
}

/**
 * Gather complete real-time NOC metrics
 * @param {string|number} routerId 
 */
async function getNocData(routerId = null) {
  const effectiveRouterId = (routerId && routerId !== 'null' && routerId !== 'settings' && routerId !== 'settings_json')
    ? (isNaN(Number(routerId)) ? routerId : Number(routerId))
    : 'settings_json';

  const now = Date.now();
  if (cachedData && cachedData._routerId === String(effectiveRouterId) && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedData.payload;
  }

  try {
    const conn = await mikrotikService.getConnection(effectiveRouterId);
    if (!conn) {
      throw new Error('Gagal terhubung ke router MikroTik');
    }

    // Parallel fetch from MikroTik for maximum speed
    const [
      resourceRaw,
      healthRaw,
      interfacesRaw,
      activePppoeRaw,
      secretsRaw,
      activeHotspotRaw,
      hotspotUsersRaw
    ] = await Promise.all([
      // 1. System Resource
      mikrotikService.getSystemResource(effectiveRouterId).catch(err => {
        logger.debug(`[NOC Service] Resource error: ${err.message}`);
        return null;
      }),
      // 2. System Health (Voltage & Temp on RB4011 / CCR)
      conn.client.menu('/system/health').get().catch(() => []),
      // 3. Active Interfaces
      conn.client.menu('/interface').get().catch(() => []),
      // 4. PPPoE Active
      mikrotikService.getPppoeActive(effectiveRouterId).catch(() => []),
      // 5. PPPoE Secrets
      mikrotikService.getPppoeSecrets(effectiveRouterId).catch(() => []),
      // 6. Hotspot Active
      mikrotikService.getHotspotActive(effectiveRouterId).catch(() => []),
      // 7. Hotspot Users
      mikrotikService.getHotspotUsers(effectiveRouterId).catch(() => [])
    ]);

    // Parse MikroTik System Resource
    const res = Array.isArray(resourceRaw) ? resourceRaw[0] : resourceRaw;
    const cpuLoad = res ? Number(res['cpu-load'] || res.cpuLoad || res['cpu'] || 0) : 0;
    const totalMem = res ? Number(res['total-memory'] || res.totalMemory || 0) : 0;
    const freeMem = res ? Number(res['free-memory'] || res.freeMemory || 0) : 0;
    const usedMem = Math.max(0, totalMem - freeMem);
    const memPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;

    const totalHdd = res ? Number(res['total-hdd-space'] || res.totalHddSpace || 0) : 0;
    const freeHdd = res ? Number(res['free-hdd-space'] || res.freeHddSpace || 0) : 0;
    const usedHdd = Math.max(0, totalHdd - freeHdd);
    const hddPercent = totalHdd > 0 ? Number(((usedHdd / totalHdd) * 100).toFixed(1)) : 0;

    // Parse MikroTik Health (Temperature & Voltage)
    let voltage = null;
    let temperature = null;
    if (Array.isArray(healthRaw) && healthRaw.length > 0) {
      const h = healthRaw[0];
      if (h.voltage) voltage = Number(parseFloat(h.voltage)).toFixed(1);
      if (h.temperature) temperature = Math.round(Number(h.temperature));
      else if (h['cpu-temperature']) temperature = Math.round(Number(h['cpu-temperature']));
    }

    // Format Interfaces
    const formattedInterfaces = (interfacesRaw || []).map(i => {
      const isRunning = i.running === true || i.running === 'true' || i.running === 'yes';
      const isDisabled = i.disabled === true || i.disabled === 'true' || i.disabled === 'yes';
      const bytesIn = Number(i['rx-byte'] || i['rx-bytes'] || i['bytes-in'] || 0);
      const bytesOut = Number(i['tx-byte'] || i['tx-bytes'] || i['bytes-out'] || 0);
      const packetsIn = Number(i['rx-packet'] || i['rx-packets'] || 0);
      const packetsOut = Number(i['tx-packet'] || i['tx-packets'] || 0);
      const errorsIn = Number(i['rx-error'] || i['rx-errors'] || 0);
      const errorsOut = Number(i['tx-error'] || i['tx-errors'] || 0);
      const dropsIn = Number(i['rx-drop'] || i['rx-drops'] || 0);
      const dropsOut = Number(i['tx-drop'] || i['tx-drops'] || 0);

      return {
        name: i.name,
        type: i.type || 'ether',
        running: isRunning,
        disabled: isDisabled,
        comment: i.comment || '',
        mac: i['mac-address'] || '',
        bytesIn,
        bytesOut,
        packetsIn,
        packetsOut,
        errorsIn,
        errorsOut,
        dropsIn,
        dropsOut
      };
    });

    // Client Calculations (PPPoE & Hotspot)
    const activePppoeCount = Array.isArray(activePppoeRaw) ? activePppoeRaw.length : 0;
    const activePppoeNames = new Set((activePppoeRaw || []).map(s => String(s.name || '').trim()));
    const secretsList = Array.isArray(secretsRaw) ? secretsRaw : [];
    const totalSecrets = secretsList.length;

    let offlinePppoeCount = 0;
    let disabledPppoeCount = 0;
    for (const sec of secretsList) {
      const name = String(sec.name || '').trim();
      const isDisabled = sec.disabled === true || sec.disabled === 'true';
      if (isDisabled) {
        disabledPppoeCount++;
      } else if (!activePppoeNames.has(name)) {
        offlinePppoeCount++;
      }
    }

    const activeHotspotCount = Array.isArray(activeHotspotRaw) ? activeHotspotRaw.length : 0;
    const totalHotspotUsers = Array.isArray(hotspotUsersRaw) ? hotspotUsersRaw.length : 0;

    // Database Queries (TR-069 ACS, Billing Customers & Firewall Blocks)
    let acsStats = { total: 0, online: 0, critical: 0 };
    let customerStats = { total: 0, active: 0, suspended: 0 };
    let securityStats = { blockedCount: 0 };

    try {
      // 1. TR-069 stats
      const devRows = db.prepare('SELECT params, last_inform FROM acs_devices').all();
      acsStats.total = devRows.length;
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      for (const d of devRows) {
        if (d.last_inform && new Date(d.last_inform).getTime() >= tenMinutesAgo) {
          acsStats.online++;
        }
        try {
          const p = JSON.parse(d.params || '{}');
          const rx = parseFloat(p.rx_power || p.optical_rx_power || p.rxPower);
          if (!isNaN(rx) && rx <= -27) {
            acsStats.critical++;
          }
        } catch (_) {}
      }

      // 2. Billing customer stats
      const cRows = db.prepare("SELECT status, COUNT(*) as c FROM customers GROUP BY status").all();
      for (const r of cRows) {
        customerStats.total += r.c;
        if (r.status === 'active') customerStats.active += r.c;
        if (r.status === 'suspended' || r.status === 'isolated') customerStats.suspended += r.c;
      }

      // 3. Security watchdog blocked count
      try {
        const secRow = db.prepare("SELECT COUNT(*) as c FROM audit_trail WHERE action LIKE '%BLOCK%' OR action LIKE '%BRUTE%'").get();
        if (secRow) securityStats.blockedCount = secRow.c;
      } catch (_) {}
    } catch (dbErr) {
      logger.debug(`[NOC Service] DB query error: ${dbErr.message}`);
    }

    // Host Server (Node.js & OS) Telemetry
    const hostTotalMem = os.totalmem();
    const hostFreeMem = os.freemem();
    const hostUsedMem = hostTotalMem - hostFreeMem;
    const hostMemPercent = Number(((hostUsedMem / hostTotalMem) * 100).toFixed(1));

    const payload = {
      ok: true,
      timestamp: now,
      router: {
        id: effectiveRouterId,
        boardName: res ? String(res['board-name'] || res.boardName || 'MikroTik') : 'MikroTik',
        model: res ? String(res['model'] || res.model || res['board-name'] || 'RouterBOARD') : 'RouterBOARD',
        version: res ? String(res['version'] || res.version || 'RouterOS') : 'RouterOS',
        architecture: res ? String(res['architecture-name'] || res.architectureName || '-') : '-',
        cpuType: res ? String(res['cpu'] || res.cpu || 'CPU') : 'CPU',
        cpuCount: res ? Number(res['cpu-count'] || res.cpuCount || 1) : 1,
        cpuFrequency: res ? Number(res['cpu-frequency'] || res.cpuFrequency || 0) : 0,
        cpuLoad,
        totalMemory: totalMem,
        freeMemory: freeMem,
        usedMemory: usedMem,
        memoryPercent: memPercent,
        totalHdd,
        freeHdd,
        usedHdd,
        hddPercent,
        uptime: res ? String(res['uptime'] || res.uptime || '00:00:00') : '00:00:00',
        voltage,
        temperature
      },
      interfaces: formattedInterfaces,
      clients: {
        pppoe: {
          active: activePppoeCount,
          offline: offlinePppoeCount,
          disabled: disabledPppoeCount,
          total: totalSecrets,
          activePercent: totalSecrets > 0 ? Number(((activePppoeCount / totalSecrets) * 100).toFixed(1)) : 0
        },
        hotspot: {
          active: activeHotspotCount,
          total: totalHotspotUsers
        },
        billing: customerStats
      },
      acs: acsStats,
      security: securityStats,
      server: {
        nodeVersion: process.version,
        hostUptime: Math.round(os.uptime()),
        hostMemPercent,
        hostMemoryUsedMb: Math.round(hostUsedMem / (1024 * 1024)),
        hostMemoryTotalMb: Math.round(hostTotalMem / (1024 * 1024)),
        loadAvg: os.loadavg().map(n => Number(n.toFixed(2)))
      }
    };

    // Update cache
    cachedData = {
      _routerId: String(effectiveRouterId),
      payload
    };
    lastFetchTime = now;

    return payload;
  } catch (err) {
    logger.error(`[NOC Service] Failed to fetch data: ${err.message}`);
    // If we have previous cache, return it with error notice instead of hard 500
    if (cachedData && cachedData.payload) {
      return {
        ...cachedData.payload,
        cached: true,
        warning: `Koneksi MikroTik terputus: ${err.message}`
      };
    }
    throw err;
  }
}

module.exports = {
  getNocRouters,
  getNocData
};
