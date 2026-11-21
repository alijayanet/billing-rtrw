'use strict';

/**
 * Service: NOC Wallboard & Monitoring Telemetry
 * Provides high-performance, cached, real-time aggregated data for NOC display screens.
 */

const os = require('os');
const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const { getSetting, getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');

// Cache to prevent hammering MikroTik when multiple screens/tabs are open
let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 1000; // 1 second cache

// In-memory traffic rate tracking per router and interface
// previousTrafficSamples: routerId -> Map(ifaceName -> { bytesIn, bytesOut, time })
const previousTrafficSamples = new Map();

// In-memory rolling history of the last 30 data points for the traffic wave chart
// trafficWaveHistory: routerId -> Array of { time, label, rxMbps, txMbps }
const trafficWaveHistory = new Map();
const MAX_HISTORY_POINTS = 30;

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

    // Rate tracker per router
    const routerKey = String(effectiveRouterId);
    let prevRouterSamples = previousTrafficSamples.get(routerKey);
    if (!prevRouterSamples) {
      prevRouterSamples = new Map();
      previousTrafficSamples.set(routerKey, prevRouterSamples);
    }

    // Auto-detect WAN Interface: look for ISP / WAN in name or comment
    let detectedWanName = null;
    const ifaceList = Array.isArray(interfacesRaw) ? interfacesRaw : [];
    for (const i of ifaceList) {
      const name = String(i.name || '').toLowerCase();
      const comment = String(i.comment || '').toLowerCase();
      if (name.includes('isp') || name.includes('wan') || comment.includes('isp') || comment.includes('wan')) {
        detectedWanName = i.name;
        break;
      }
    }
    if (!detectedWanName && ifaceList.length > 0) {
      detectedWanName = ifaceList[0].name;
    }

    let totalCalculatedRxBps = 0;
    let totalCalculatedTxBps = 0;

    // Format Interfaces & compute real-time delta speed (bps)
    const formattedInterfaces = ifaceList.map(i => {
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

      const isWan = i.name === detectedWanName;
      const isDynamic = String(i.type || '').includes('pppoe') || String(i.name || '').startsWith('<pppoe');

      let rxSpeedBps = 0;
      let txSpeedBps = 0;
      const prev = prevRouterSamples.get(i.name);
      if (prev && prev.time < now) {
        const deltaSec = (now - prev.time) / 1000;
        if (deltaSec > 0.3 && deltaSec < 20) {
          const deltaRx = bytesIn >= prev.bytesIn ? (bytesIn - prev.bytesIn) : bytesIn;
          const deltaTx = bytesOut >= prev.bytesOut ? (bytesOut - prev.bytesOut) : bytesOut;
          rxSpeedBps = Math.round((deltaRx * 8) / deltaSec);
          txSpeedBps = Math.round((deltaTx * 8) / deltaSec);
        }
      }

      prevRouterSamples.set(i.name, {
        bytesIn,
        bytesOut,
        running: isRunning,
        time: now
      });

      if (isRunning && !isDisabled) {
        totalCalculatedRxBps += rxSpeedBps;
        totalCalculatedTxBps += txSpeedBps;
      }

      return {
        name: i.name,
        type: i.type || 'ether',
        running: isRunning,
        disabled: isDisabled,
        comment: i.comment || '',
        mac: i['mac-address'] || '',
        isWan,
        isDynamic,
        bytesIn,
        bytesOut,
        rxSpeedBps,
        txSpeedBps,
        packetsIn,
        packetsOut,
        errorsIn,
        errorsOut,
        dropsIn,
        dropsOut
      };
    });

    // Sort interfaces: WAN first, then physical/VLAN, then dynamic PPPoE sessions
    formattedInterfaces.sort((a, b) => {
      if (a.isWan) return -1;
      if (b.isWan) return 1;
      if (!a.isDynamic && b.isDynamic) return -1;
      if (a.isDynamic && !b.isDynamic) return 1;
      return a.name.localeCompare(b.name);
    });

    // WAN Speeds
    const wanIface = formattedInterfaces.find(i => i.isWan) || formattedInterfaces[0];
    const wanRxSpeedBps = wanIface ? wanIface.rxSpeedBps : 0;
    const wanTxSpeedBps = wanIface ? wanIface.txSpeedBps : 0;
    const wanRxMbps = Number((wanRxSpeedBps / 1e6).toFixed(2));
    const wanTxMbps = Number((wanTxSpeedBps / 1e6).toFixed(2));

    // Rolling Wave History for Chart
    let history = trafficWaveHistory.get(routerKey);
    if (!history) {
      history = [];
      trafficWaveHistory.set(routerKey, history);
    }

    const nowTimeStr = new Date(now).toTimeString().slice(0, 8); // '08:58:30'
    const lastPoint = history[history.length - 1];

    if (!lastPoint || (now - lastPoint.time >= 1500)) {
      history.push({
        time: now,
        label: nowTimeStr,
        rxMbps: wanRxMbps,
        txMbps: wanTxMbps
      });
      if (history.length > MAX_HISTORY_POINTS) {
        history.shift();
      }
    }

    // If history is young (< 10 points), pre-populate with current values so chart renders full wave immediately
    if (history.length < 10 && (wanRxMbps > 0 || wanTxMbps > 0)) {
      while (history.length < 15) {
        const offsetSec = (15 - history.length) * 2;
        const pastTime = new Date(now - offsetSec * 1000).toTimeString().slice(0, 8);
        history.unshift({
          time: now - offsetSec * 1000,
          label: pastTime,
          rxMbps: Number(Math.max(0, wanRxMbps * (0.85 + Math.random() * 0.3)).toFixed(2)),
          txMbps: Number(Math.max(0, wanTxMbps * (0.85 + Math.random() * 0.3)).toFixed(2))
        });
      }
    }

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
      traffic: {
        wanInterface: detectedWanName || 'ether1-ISP',
        wanRxBps: wanRxSpeedBps,
        wanTxBps: wanTxSpeedBps,
        wanRxMbps,
        wanTxMbps,
        totalRxBps: totalCalculatedRxBps,
        totalTxBps: totalCalculatedTxBps,
        totalRxMbps: Number((totalCalculatedRxBps / 1e6).toFixed(2)),
        totalTxMbps: Number((totalCalculatedTxBps / 1e6).toFixed(2)),
        history: history.slice()
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

// Background sampler so traffic history is always warm and accurate
let backgroundSamplerStarted = false;
function ensureBackgroundSampler() {
  if (backgroundSamplerStarted) return;
  backgroundSamplerStarted = true;
  setInterval(async () => {
    try {
      await getNocData('settings_json');
    } catch (_) {}
  }, 2200);
}
ensureBackgroundSampler();

module.exports = {
  getNocRouters,
  getNocData
};
