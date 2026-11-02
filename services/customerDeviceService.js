/**
 * Logika GenieACS yang dipakai portal web dan bot WhatsApp.
 * Updated to support multi-server GenieACS setup.
 */
const axios = require('axios');
const db = require('../config/database');
const { getSettingsWithCache } = require('../config/settingsManager');
const auditTrail = require('./auditTrailService');
const { logger } = require('../config/logger');
const genieacsApi = require('../config/genieacs');
const mikrotikService = require('./mikrotikService');

// Helper: Search device across all servers (always get full data)
async function searchDeviceAcrossServers(query, fullData = true) {
  try {
    const servers = genieacsApi.getAllACSServers();
    
    for (const server of servers) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        const params = {
          query: JSON.stringify(query)
        };
        
        // Only add projection if explicitly requesting minimal data
        if (!fullData) {
          params.projection = '_id,_tags';
        }

        let response;
        try {
          response = await instance.get('/devices', {
            params,
            timeout: 2000
          });
        } catch (e) {
          response = await instance.get('/api/devices', {
            params,
            timeout: 2000
          });
        }
        
        if (response.data && response.data.length > 0) {
          const device = response.data[0];
          device._acs_server_id = server.id;
          device._acs_server_name = server.name;
          logger.debug(`[CustomerDevice] Device found on ${server.name}`);
          return device;
        }
      } catch (error) {
        logger.debug(`[CustomerDevice] Device not found on ${server.name}: ${error.message}`);
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`[CustomerDevice] Error searching device: ${error.message}`);
    return null;
  }
}


// PPPoE Username search keys matching user's template
const PPPOE_USER_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username',
  'Device.PPP.Interface.3.Username'
];

async function findDeviceByTag(tag) {
  try {
    const query = { $or: [{ _id: tag }, { _tags: tag }] };
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by tag: ${e.message}`);
    return null;
  }
}

async function findDeviceByPppoe(pppoeUser) {
  try {
    const user = String(pppoeUser || '').trim();
    if (!user) return null;
    const keys = [
      'VirtualParameters.pppoeUsername2',
      'VirtualParameters.pppoeUsername',
      'VirtualParameters.pppUsername',
      'VirtualParameters.PPPoEUser',
      ...PPPOE_USER_KEYS
    ];
    const query = { $or: keys.map(k => ({ [k]: user })) };
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by PPPoE: ${e.message}`);
    return null;
  }
}

async function fetchFullDevice(tag) {
  try {
    const query = { $or: [{ _id: tag }, { _tags: tag }] };
    // Always get full data
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error fetching full device: ${e.message}`);
    return null;
  }
}

async function resolveDeviceToken(input) {
  const token = String(input ?? '').replace(/[\r\n\t]+/g, '').trim();
  if (!token) return null;

  // 1. FAST SINGLE COMBINED QUERY: Cek _id, _tags, serial number, dan seluruh parameter PPPoE sekaligus dalam 1 query GenieACS
  const combinedKeys = [
    '_id',
    '_tags',
    '_deviceId._SerialNumber',
    'DeviceID.SerialNumber',
    'VirtualParameters.pppoeUsername2',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'VirtualParameters.PPPoEUser',
    ...PPPOE_USER_KEYS
  ];
  try {
    const query = { $or: combinedKeys.map(k => ({ [k]: token })) };
    const direct = await searchDeviceAcrossServers(query, true);
    if (direct && direct._id) return direct;
  } catch (e) {
    logger.debug(`[resolveDeviceToken] Fast combined query error: ${e.message}`);
  }

  // 2. Fallback: varian prefix tag/nomor (misal 62 vs 08)
  const found = await findDeviceWithTagVariants(token);
  if (found && found.device && found.device._id) return found.device;

  // 3. Fallback: Cari di database billing customers (jika token berupa ID, phone, PPPoE, atau MAC)
  try {
    const db = require('../config/database');
    const cust = db.prepare(`
      SELECT pppoe_username, genieacs_tag, mac_address, phone 
      FROM customers 
      WHERE phone = ? OR id = ? OR pppoe_username = ? OR genieacs_tag = ? OR mac_address = ?
      LIMIT 1
    `).get(token, token, token, token, token);

    if (cust) {
      const candidates = Array.from(new Set([
        cust.pppoe_username,
        cust.genieacs_tag,
        cust.mac_address,
        cust.phone
      ].map(v => String(v || '').trim()).filter(v => v && v !== token)));

      for (const cand of candidates) {
        try {
          const direct = await searchDeviceAcrossServers({ $or: combinedKeys.map(k => ({ [k]: cand })) }, true);
          if (direct && direct._id) return direct;
        } catch (_) {}
        const f = await findDeviceWithTagVariants(cand);
        if (f && f.device && f.device._id) return f.device;
      }
    }
  } catch (e) {
    logger.debug(`[resolveDeviceToken] Customer DB fallback error: ${e.message}`);
  }

  return null;
}

const parameterPaths = {
  serialNumber: [
    'DeviceID.SerialNumber',
    'InternetGatewayDevice.DeviceInfo.SerialNumber',
    'Device.DeviceInfo.SerialNumber'
  ],
  model: [
    'DeviceID.ProductClass',
    'InternetGatewayDevice.DeviceInfo.ModelName',
    'Device.DeviceInfo.ModelName',
    'ModelName'
  ],
  softwareVersion: [
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'Device.DeviceInfo.SoftwareVersion'
  ],
  ssid: [
    'VirtualParameters.WlanSSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'Device.WiFi.SSID.1.SSID',
    'Device.WiFi.SSID.2.SSID'
  ],
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANOAM.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_OpticalSignal.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower',
    'Device.Optical.Interface.1.OpticalSignalLevel',
    'Device.XPON.Interface.1.Stats.RXPower'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'VirtualParameters.WanIP',
    'VirtualParameters.IPTR069',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername2',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'VirtualParameters.PPPoEUser',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.3.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
    'Device.PPP.Interface.1.Username',
    'Device.PPP.Interface.2.Username',
    'Device.PPP.Interface.3.Username'
  ],
  uptime: [
    'VirtualParameters.getpppuptime',
    'VirtualParameters.uptimeDevice',
    'VirtualParameters.getdeviceuptime',
    'VirtualParameters.uptime',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ],
  userConnected: [
    'VirtualParameters.activedevices',
    'VirtualParameters.userconnected',
    'VirtualParameters.getAssociation',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Associations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Associations',
    'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
    'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
    'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries',
    'Device.Hosts.HostNumberOfEntries'
  ]
};

// PPPoE IP search keys matching user's template
const PPPOE_IP_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress',
  'Device.PPP.Interface.1.ExternalIPAddress',
  'Device.IP.Interface.1.IPv4Address.1.IPAddress'
];


function getNestedValue(obj, path) {
  try {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (!current) return null;
      current = current[part];
    }
    if (current && typeof current === 'object' && '_value' in current) {
      return current._value;
    }
    if (current && typeof current === 'object' && current.hasOwnProperty('_value')) {
      return current._value;
    }
    return current;
  } catch (e) {
    return null;
  }
}

function getWildcardMatches(device, path) {
  const parts = path.split('.');
  const results = [];

  function recurse(current, index, currentPathParts) {
    if (current === undefined || current === null) return;
    
    if (index === parts.length) {
      let val = current;
      if (typeof current === 'object' && '_value' in current) {
        val = current._value;
      }
      results.push({
        path: currentPathParts.join('.'),
        value: val
      });
      return;
    }

    const part = parts[index];
    if (part === '*') {
      if (typeof current === 'object') {
        for (const key of Object.keys(current)) {
          if (!key.startsWith('_')) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    } else {
      if (typeof current === 'object') {
        const targetLower = part.toLowerCase();
        for (const key of Object.keys(current)) {
          if (key.toLowerCase() === targetLower) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    }
  }

  recurse(device, 0, []);
  return results;
}

function getDeviceParameterValue(device, keys, filterFn) {
  for (const key of keys) {
    const matches = getWildcardMatches(device, key);
    for (const match of matches) {
      if (filterFn) {
        if (filterFn(match.path, match.value, device)) {
          return match.value;
        }
      } else if (match.value !== undefined && match.value !== null && match.value !== '') {
        return match.value;
      }
    }
  }
  return '';
}

function extractPppoeIp(d) {
  const ip = getDeviceParameterValue(d, PPPOE_IP_KEYS, (matchedPath, value, device) => {
    if (!value || value === '0.0.0.0' || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('ExternalIPAddress', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'bridge') {
        return false;
      }
    }
    return true;
  });
  
  if (ip) return ip;
  if (d._ip && d._ip !== '-' && d._ip !== '0.0.0.0') return d._ip;
  return 'N/A';
}

function extractPppoeUser(d) {
  const user = getDeviceParameterValue(d, PPPOE_USER_KEYS, (matchedPath, value, device) => {
    if (!value || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('Username', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });
  
  return user || 'N/A';
}

function formatUptime(seconds) {
  if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
  if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
    return seconds;
  }
  const totalSecs = parseInt(seconds, 10);
  if (isNaN(totalSecs)) return seconds || 'N/A';
  const days = Math.floor(totalSecs / 86400);
  const rem = totalSecs % 86400;
  let hrs = Math.floor(rem / 3600);
  if (hrs < 10) hrs = "0" + hrs;
  const rem2 = rem % 3600;
  let mins = Math.floor(rem2 / 60);
  if (mins < 10) mins = "0" + mins;
  let secs = rem2 % 60;
  if (secs < 10) secs = "0" + secs;
  return days + "d " + hrs + ":" + mins + ":" + secs;
}

function formatDeviceTimestamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID');
}

function formatRelativeTime(value) {
  if (!value) return '-';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '-';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'baru saja';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} detik lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} jam lalu`;
  const day = Math.floor(hour / 24);
  return `${day} hari lalu`;
}

function collectRefreshObjects(device) {
  const objects = [];
  const isTr181 = !!device?.Device;

  if (isTr181) {
    // TR-181 Device - validate before pushing
    if (device?.Device?.Hosts?.Host) {
      objects.push('Device.Hosts.Host');
    }
    if (device?.Device?.WiFi?.AccessPoint?.['1']) {
      objects.push('Device.WiFi.AccessPoint.1.AssociatedDevice');
    }
    if (device?.Device?.WiFi?.AccessPoint?.['2']) {
      objects.push('Device.WiFi.AccessPoint.2.AssociatedDevice');
    }
  } else {
    // TR-098 Device (InternetGatewayDevice) - validate before pushing
    // FIX for Error 9005: Only query objects that exist in device cache
    // Some devices (e.g. ZTE GM220-S XPON) don't have LANDevice/WiFi support
    if (device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host) {
      objects.push('InternetGatewayDevice.LANDevice.1.Hosts.Host');
    }
    if (device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.AssociatedDevice) {
      objects.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice');
    }
    if (device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['5']) {
      objects.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice');
    }
  }

  return Array.from(new Set(objects));
}

function getBuiltinSyncState(deviceId) {
  const empty = {
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueAt: '',
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle'
  };
  if (!deviceId) return empty;

  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS count, MAX(created_at) AS last_queue_at
       FROM acs_tasks
       WHERE device_id = ?
         AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
         AND status IN ('pending', 'in_progress')`
    ).get(deviceId);

    const count = Number(pending?.count || 0);
    const lastQueueAt = String(pending?.last_queue_at || '');
    return {
      syncInProgress: count > 0,
      syncPendingCount: count,
      syncLastQueueAt: lastQueueAt,
      syncLastQueueLabel: formatDeviceTimestamp(lastQueueAt),
      syncStatusLabel: count > 0 ? `Sinkronisasi berjalan (${count})` : 'Idle'
    };
  } catch (e) {
    logger.debug(`[CustomerDevice] Failed reading ACS sync state for ${deviceId}: ${e.message}`);
    return empty;
  }
}

const PPPOE_UPTIME_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Uptime',
  'Device.PPP.Interface.1.UpTime'
];

function extractPppoeUptime(d) {
  let uptimeVal = getDeviceParameterValue(d, PPPOE_UPTIME_KEYS, (matchedPath, value, device) => {
    if (value === undefined || value === null || value === '' || value === '-') return false;
    
    if (matchedPath.toLowerCase().includes('wanpppconnection')) {
      const connTypePath = matchedPath.substring(0, matchedPath.toLowerCase().lastIndexOf('.uptime')) + '.ConnectionType';
      const connTypeMatches = getWildcardMatches(device, connTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });

  if (!uptimeVal || uptimeVal === '-') {
    const UPTIME_PATHS = [
      'VirtualParameters.getdeviceuptime',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
      const val = getNestedValue(d, path);
      if (val && val !== '-' && val !== '') {
        uptimeVal = val;
        break;
      }
    }
  }

  if (uptimeVal) {
    return formatUptime(uptimeVal);
  }
  return 'N/A';
}

function getParameterWithPaths(device, paths) {
  let values = [];
  for (const p of paths) {
    const parts = p.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        if (value && value._value !== undefined) value = value._value;
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null && value !== '' && value !== 'N/A') {
      const isIpPath = p.toLowerCase().includes('ipaddress') || p.toLowerCase().includes('pppoeip') || p.toLowerCase().includes('pppip') || p.toLowerCase().includes('pppusername') || p.toLowerCase().includes('pppoeusername');
      if (isIpPath && String(value) === '0.0.0.0') {
        continue;
      }
      const isCountParam = p.includes('TotalAssociations') || 
                           p.includes('AssociatedDeviceNumberOfEntries') || 
                           p.includes('HostNumberOfEntries');
                           
      if (isCountParam) {
        // Ensure we push a number
        const val = (typeof value === 'object' && value._value !== undefined) ? value._value : value;
        values.push(parseInt(val) || 0);
      } else {
        // If it's still an object, try to get _value or stringify it
        if (typeof value === 'object') {
          if (value._value !== undefined) return String(value._value);
          return 'N/A'; // Don't return raw object
        }
        return String(value);
      }
    }
  }
  
  if (values.length > 0) {
    // If it's a count parameter, sum them up (for dual band)
    return values.reduce((a, b) => a + b, 0);
  }
  
  return 'N/A';
}

function expandTagCandidates(input) {
  const t = String(input || '').trim();
  if (!t) return [];
  if (/^\d+$/.test(t)) {
    const d = t.replace(/\D/g, '');
    const set = new Set([d]);
    if (d.startsWith('62') && d.length > 2) set.add('0' + d.slice(2));
    if (d.startsWith('0')) set.add('62' + d.slice(1));
    return [...set];
  }
  return [t];
}

/** Coba beberapa varian tag (62/0 untuk nomor) sampai device ketemu */
async function findDeviceWithTagVariants(input) {
  for (const c of expandTagCandidates(input)) {
    const dev = await findDeviceByTag(c);
    if (dev) return { device: dev, canonicalTag: c };
  }
  return null;
}

/** Nomor dari JID WhatsApp @s.whatsapp.net */
function phoneFromPnJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const [user, host] = jid.split('@');
  if (!user || host !== 's.whatsapp.net') return null;
  return user.replace(/\D/g, '') || null;
}

function mapDeviceData(device, tag, isPppoeActive = false) {
  if (!device) return null;

  const ssid = getParameterWithPaths(device, parameterPaths.ssid);
  const ssidDisplay = ssid === 'N/A' ? '-' : ssid;

  const lastInformRaw =
    device?._lastInform ||
    device?.Events?.Inform ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value ||
    '';
  const lastInform = formatDeviceTimestamp(lastInformRaw);
  const lastSyncRaw = device?._updatedAt || lastInformRaw || '';
  const lastSync = formatDeviceTimestamp(lastSyncRaw);
  const syncState = getBuiltinSyncState(device?._id);

  let status = 'Unknown';
  if (device?._lastInform) {
    const diffMs = Date.now() - new Date(device._lastInform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  } else if (device?.Events?.Inform) {
    const diffMs = Date.now() - new Date(device.Events.Inform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  }

  if (status !== 'Online' && isPppoeActive) {
    status = 'Online';
  }

  let connectedUsers = [];
  try {
    const hosts = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || device?.Device?.Hosts?.Host;
    if (hosts && typeof hosts === 'object') {
      for (const key in hosts) {
        if (!isNaN(key)) {
          const entry = hosts[key];
          connectedUsers.push({
            hostname: typeof entry?.HostName === 'object' ? entry?.HostName?._value || '-' : entry?.HostName || '-',
            ip: typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value || '-' : entry?.IPAddress || '-',
            mac: typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value || '-' : entry?.MACAddress || '-',
            iface: typeof entry?.InterfaceType === 'object' ? entry?.InterfaceType?._value || '-' : entry?.InterfaceType || entry?.Interface || '-',
            status: (
              entry?.Active?._value === 'true' || 
              entry?.Active?._value === '1' || 
              entry?.Active?._value === 1 || 
              entry?.Active === true || 
              entry?.Active === '1' || 
              entry?.Active === 1 || 
              String(entry?.Active || '').toLowerCase() === 'online'
            ) ? 'Online' : 'Offline'
          });
        }
      }
    }

    const assocCandidates = [
      device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.AssociatedDevice,
      device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['5']?.AssociatedDevice,
      device?.Device?.WiFi?.AccessPoint?.['1']?.AssociatedDevice,
      device?.Device?.WiFi?.AccessPoint?.['2']?.AssociatedDevice
    ];
    for (const assoc of assocCandidates) {
      if (!assoc || typeof assoc !== 'object') continue;
      for (const key in assoc) {
        if (key === '_value' || key === '_type' || key === '_timestamp') continue;
        if (isNaN(key)) continue;
        const entry = assoc[key];
        const mac =
          (typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value : entry?.MACAddress) ||
          (typeof entry?.AssociatedDeviceMACAddress === 'object' ? entry?.AssociatedDeviceMACAddress?._value : entry?.AssociatedDeviceMACAddress) ||
          '-';
        const ip =
          (typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value : entry?.IPAddress) ||
          (typeof entry?.IP === 'object' ? entry?.IP?._value : entry?.IP) ||
          '-';
        const hostname =
          (typeof entry?.HostName === 'object' ? entry?.HostName?._value : entry?.HostName) ||
          (typeof entry?.DeviceName === 'object' ? entry?.DeviceName?._value : entry?.DeviceName) ||
          '-';
        const ssidName =
          (typeof entry?.SSID === 'object' ? entry?.SSID?._value : entry?.SSID) ||
          (typeof entry?.WLANConfiguration === 'object' ? entry?.WLANConfiguration?._value : entry?.WLANConfiguration) ||
          '';
        if (!mac || mac === '-') continue;
        connectedUsers.push({
          hostname: hostname || '-',
          ip: ip || '-',
          mac: mac || '-',
          iface: ssidName ? `WiFi ${ssidName}` : 'WiFi',
          status: 'Online'
        });
      }
    }
  } catch (e) {}

  try {
    const seen = new Set();
    connectedUsers = connectedUsers.filter((u) => {
      const mac = String(u?.mac || '').toUpperCase();
      const ip = String(u?.ip || '');
      const key = mac ? `${mac}|${ip}` : ip;
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {}

  let rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
  if (rxPower !== 'N/A' && rxPower !== '-' && rxPower !== '' && rxPower !== null && rxPower !== undefined) {
    const raw = parseFloat(rxPower);
    if (!isNaN(raw)) {
      if (raw === 0 || raw >= 65535) {
        rxPower = 'LOS';
      } else if (raw < 0 && raw > -50) {
        rxPower = raw.toFixed(2);
      } else if (raw <= -50) {
        rxPower = (raw / 100).toFixed(2);
      } else if (raw > 0) {
        const dbm = 30 + (Math.log10(raw * 1e-7) * 10);
        rxPower = (Math.round(dbm * 100) / 100).toFixed(2);
      }
    }
  }
  const pppoeIP = extractPppoeIp(device);
  const pppoeUsername = extractPppoeUser(device);
  const uptimeRaw = getParameterWithPaths(device, parameterPaths.uptime);
  let totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);

  // Fallback: If N/A or 0, count from connectedUsers list (LAN + WLAN)
  if ((totalAssociations === 'N/A' || totalAssociations === 0 || totalAssociations === '0') && connectedUsers.length > 0) {
    totalAssociations = connectedUsers.filter(u => u.status === 'Online').length;
  }
  if (totalAssociations === 'N/A' || totalAssociations === '-' || totalAssociations === '' || totalAssociations === null || totalAssociations === undefined) {
    totalAssociations = 0;
  }
  if (typeof totalAssociations === 'string' && /^\d+$/.test(totalAssociations)) {
    totalAssociations = parseInt(totalAssociations, 10);
  }

  function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
    if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
      return seconds;
    }
    const totalSecs = parseInt(seconds, 10);
    if (isNaN(totalSecs)) return seconds || 'N/A';
    const days = Math.floor(totalSecs / 86400);
    const rem = totalSecs % 86400;
    
    let hrs = Math.floor(rem / 3600);
    if (hrs < 10) hrs = "0" + hrs;
    
    const rem2 = rem % 3600;
    let mins = Math.floor(rem2 / 60);
    if (mins < 10) mins = "0" + mins;
    
    let secs = rem2 % 60;
    if (secs < 10) secs = "0" + secs;
    
    return days + "d " + hrs + ":" + mins + ":" + secs;
  }
  const uptime = formatUptime(uptimeRaw);
  const pppoeUptime = extractPppoeUptime(device);

  const serialNumber = getParameterWithPaths(device, parameterPaths.serialNumber);
  const productClass = getParameterWithPaths(device, parameterPaths.model);
  const softwareVersion = getParameterWithPaths(device, parameterPaths.softwareVersion);
  const model = productClass;

  let lokasi = device?._tags || '-';
  if (Array.isArray(lokasi)) lokasi = lokasi.join(', ');

  return {
    id: device?._id || '',
    tags: Array.isArray(device?._tags) ? device._tags : (device?._tags ? [device._tags] : []),
    phone: tag,
    ssid: ssidDisplay,
    status,
    lastInform,
    lastInformRaw: lastInformRaw || '',
    lastInformAgo: formatRelativeTime(lastInformRaw),
    lastSync,
    lastSyncRaw: lastSyncRaw || '',
    lastSyncAgo: formatRelativeTime(lastSyncRaw),
    syncInProgress: !!syncState.syncInProgress,
    syncPendingCount: Number(syncState.syncPendingCount || 0),
    syncLastQueueAt: syncState.syncLastQueueAt || '',
    syncLastQueueLabel: syncState.syncLastQueueLabel || '-',
    syncStatusLabel: syncState.syncStatusLabel || 'Idle',
    connectedUsers,
    rxPower: rxPower === 'N/A' ? '-' : rxPower,
    pppoeIP: pppoeIP === 'N/A' ? '-' : pppoeIP,
    pppoeUsername: pppoeUsername === 'N/A' ? '-' : pppoeUsername,
    pppoeUptime: pppoeUptime === 'N/A' ? '-' : pppoeUptime,
    serialNumber: serialNumber === 'N/A' ? '-' : serialNumber,
    productClass: productClass === 'N/A' ? '-' : productClass,
    lokasi,
    softwareVersion: softwareVersion === 'N/A' ? '-' : softwareVersion,
    model: model === 'N/A' ? '-' : model,
    uptime: uptime === 'N/A' ? '-' : uptime,
    totalAssociations
  };
}

async function getCustomerDeviceData(tag) {
  const base = await resolveDeviceToken(tag);
  if (!base || !base._id) return null;
  const hasFullData = Boolean(base.InternetGatewayDevice || base.Device || base.VirtualParameters);
  const device = hasFullData ? base : (await fetchFullDevice(base._id) || base);
  
  let isPppoeActive = false;
  try {
    const pppoeUser = extractPppoeUser(device);
    if (pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-') {
      const activeSessionsMap = await Promise.race([
        mikrotikService.getActivePppoeSessionsMap(),
        new Promise(r => setTimeout(() => r(new Map()), 500))
      ]).catch(() => new Map());
      if (activeSessionsMap.has(pppoeUser.toLowerCase())) {
        isPppoeActive = true;
      }
    }
  } catch (e) {}

  return mapDeviceData(device, tag, isPppoeActive);
}

function fallbackCustomer(tag) {
  return {
    phone: tag,
    ssid: '-',
    status: 'Tidak ditemukan',
    lastInform: '-',
    lastInformAgo: '-',
    lastSync: '-',
    lastSyncAgo: '-',
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle',
    connectedUsers: [],
    rxPower: '-',
    pppoeIP: '-',
    pppoeUsername: '-',
    pppoeUptime: '-',
    serialNumber: '-',
    productClass: '-',
    lokasi: '-',
    softwareVersion: '-',
    model: '-',
    uptime: '-',
    totalAssociations: '-'
  };
}

async function updateSSID(tag, newSSID, actor = null) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device) return false;
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${deviceId}/tasks`;

    const parameterValues = [];
    const igd = device.InternetGatewayDevice;
    const dev181 = device.Device;
    
    // Check supported paths directly from loaded device object
    if (igd && igd.LANDevice && igd.LANDevice['1'] && igd.LANDevice['1'].WLANConfiguration) {
      const wlan = igd.LANDevice['1'].WLANConfiguration;
      // Selalu ubah SSID 1 (2.4GHz Utama)
      parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', newSSID, 'xsd:string']);
      
      // HANYA jika parameter SSID 5G (WLANConfiguration.5) benar-benar ada di perangkat.
      // JANGAN PERNAH mengubah WLANConfiguration.2 (SSID 2) karena itu adalah SSID2/Guest pada perangkat single-band!
      const hasFiveG = Boolean(
        wlan['5'] && (
          wlan['5'].SSID !== undefined ||
          wlan['5']._object === true ||
          wlan['5'].Enable !== undefined ||
          wlan['5'].KeyPassphrase !== undefined
        )
      );
      if (hasFiveG) {
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', `${newSSID}-5G`, 'xsd:string']);
      }
    } else if (dev181 && dev181.WiFi) {
      parameterValues.push(['Device.WiFi.SSID.1.SSID', newSSID, 'xsd:string']);
    } else {
      // Fallback check in local DB
      const db = require('../config/database');
      const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(device._id);
      const flatParams = row && row.params ? JSON.parse(row.params) : null;
      if (flatParams) {
        if (flatParams['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'] !== undefined) {
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', newSSID, 'xsd:string']);
        } else if (flatParams['Device.WiFi.SSID.1.SSID'] !== undefined) {
          parameterValues.push(['Device.WiFi.SSID.1.SSID', newSSID, 'xsd:string']);
        }
        if (flatParams['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID'] !== undefined) {
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', `${newSSID}-5G`, 'xsd:string']);
        }
      }
      if (parameterValues.length === 0) {
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', newSSID, 'xsd:string']);
      }
    }

    let ok = false;
    for (const pv of parameterValues) {
      try {
        await instance.post(tasksUrl, {
          name: 'setParameterValues',
          parameterValues: [pv]
        }, { timeout: 15000 });
        ok = true;
      } catch (e) {
        logger.error(`[updateSSID] Failed to set parameter ${pv[0]}: ${e.message}`);
      }
    }

    // Refresh objects untuk trigger update parameter dari ONU
    try {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { timeout: 15000 });
    } catch (e) {}

    // Tunggu sesaat agar task dieksekusi oleh ONU
    if (ok) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Sinkronkan nama WiFi (SSID) baru ke database pelanggan
      try {
        const db = require('../config/database');
        const pppoeUser = extractPppoeUser(device);
        const tagCandidate = (device._tags && device._tags[0]) || null;
        const snCandidate = device._deviceId?._SerialNumber || null;
        const idCandidate = device._id || null;

        const cust = db.prepare(`
          SELECT id FROM customers 
          WHERE id = ? 
             OR (pppoe_username IS NOT NULL AND pppoe_username != '' AND (pppoe_username = ? OR pppoe_username = ?))
             OR (genieacs_tag IS NOT NULL AND genieacs_tag != '' AND (genieacs_tag = ? OR genieacs_tag = ?))
             OR (mac_address IS NOT NULL AND mac_address != '' AND (mac_address = ? OR mac_address = ? OR mac_address = ?))
             OR phone = ?
          LIMIT 1
        `).get(tag, tag, pppoeUser, tag, tagCandidate, tag, snCandidate, idCandidate, tag);

        if (cust && cust.id) {
          db.prepare('UPDATE customers SET wifi_ssid = ? WHERE id = ?').run(newSSID, cust.id);
        }
      } catch (err) {
        logger.debug(`[updateSSID] Failed to sync customer wifi_ssid: ${err.message}`);
      }
    }

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_SSID',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          oldSSID: device._id || 'unknown',
          newSSID: newSSID
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    return false;
  }
}

async function updatePassword(tag, newPassword, actor = null) {
  try {
    const pwRaw = String(newPassword ?? '');
    const pw = pwRaw.replace(/[\r\n\t]+/g, '').trim();
    if (pw.length < 8) {
      logger.warn(`[updatePassword] Password too short for tag ${tag}`);
      return false;
    }
    const device = await resolveDeviceToken(tag);
    if (!device) {
      logger.warn(`[updatePassword] Device not found for tag ${tag}`);
      return false;
    }
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${deviceId}/tasks`;

    logger.info(`[updatePassword] Setting password for device ${deviceId}, tag ${tag}`);

    const parameterValues = [];
    const igd = device.InternetGatewayDevice;
    const dev181 = device.Device;

    if (igd && igd.LANDevice && igd.LANDevice['1'] && igd.LANDevice['1'].WLANConfiguration) {
      const wlan = igd.LANDevice['1'].WLANConfiguration;
      const wlan1 = wlan['1'] || {};

      if (wlan1.KeyPassphrase !== undefined) {
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', pw, 'xsd:string']);
      }
      if (wlan1.PreSharedKey && typeof wlan1.PreSharedKey === 'object') {
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', pw, 'xsd:string']);
      }
      if (parameterValues.length === 0) {
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', pw, 'xsd:string']);
        parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', pw, 'xsd:string']);
      }

      // 5G if available - HANYA jika WLANConfiguration.5 ada di perangkat. JANGAN PERNAH mengubah WLANConfiguration.2!
      const hasFiveG = Boolean(
        wlan['5'] && (
          wlan['5'].SSID !== undefined ||
          wlan['5'].KeyPassphrase !== undefined ||
          wlan['5'].PreSharedKey !== undefined ||
          wlan['5']._object === true ||
          wlan['5'].Enable !== undefined
        )
      );
      if (hasFiveG) {
        const wlan5 = wlan['5'] || {};
        if (wlan5.KeyPassphrase !== undefined) {
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase', pw, 'xsd:string']);
        }
        if (wlan5.PreSharedKey && typeof wlan5.PreSharedKey === 'object') {
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey', pw, 'xsd:string']);
        }
        if (!wlan5.KeyPassphrase && (!wlan5.PreSharedKey || typeof wlan5.PreSharedKey !== 'object')) {
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase', pw, 'xsd:string']);
          parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey', pw, 'xsd:string']);
        }
      }
    } else if (dev181 && dev181.WiFi) {
      parameterValues.push(['Device.WiFi.AccessPoint.1.Security.KeyPassphrase', pw, 'xsd:string']);
    } else {
      parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', pw, 'xsd:string']);
      parameterValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', pw, 'xsd:string']);
    }

    let ok = false;
    for (const pv of parameterValues) {
      try {
        await instance.post(tasksUrl, {
          name: 'setParameterValues',
          parameterValues: [pv]
        }, { timeout: 15000 });
        ok = true;
      } catch (e) {
        logger.debug(`[updatePassword] Param ${pv[0]} failed: ${e.message}`);
      }
    }

    // Refresh object - only refresh InternetGatewayDevice path yang lebih universal
    try {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { timeout: 15000 });
    } catch (e) {}
    // Skip Device.WiFi.AccessPoint refresh karena tidak semua ONU support (CIOT tidak support)

    // Tunggu sesaat agar task dieksekusi oleh ONU
    if (ok) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_PASSWORD',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: deviceId
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    logger.error(`[updatePassword] Error: ${e.message}`, e.response?.data || '');
    return false;
  }
}

async function requestRefresh(tag, actor = null) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device || !device._id) {
      return { ok: false, message: 'Perangkat tidak ditemukan.' };
    }

    const server = device._acs_server_id
      ? genieacsApi.getACSServer(device._acs_server_id)
      : genieacsApi.getACSServer('legacy');
    if (!server) {
      return { ok: false, message: 'Server ACS tidak ditemukan.' };
    }

    if (server.id === 'builtin') {
      try {
        const pending = db.prepare(
          `SELECT COUNT(*) AS c
           FROM acs_tasks
           WHERE device_id = ?
             AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
             AND status IN ('pending', 'in_progress')`
        ).get(device._id);
        if (pending && pending.c > 0) {
          return { ok: true, message: 'Sinkronisasi ONU masih berjalan. Mohon tunggu sebentar.' };
        }
      } catch (e) {
        logger.debug(`[CustomerDevice] Unable to check pending ACS tasks for ${device._id}: ${e.message}`);
      }
    }

    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${encodeURIComponent(device._id)}/tasks`;
    const refreshObjects = collectRefreshObjects(device);

    for (const objectName of refreshObjects) {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName }, { timeout: 15000 });
    }

    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REFRESH_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id,
          refreshObjects
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return {
      ok: true,
      message: `Sinkronisasi ONU dimulai. ${refreshObjects.length} jalur TR-069 dipoll.`,
      deviceId: device._id,
      acsServerId: server.id
    };
  } catch (e) {
    logger.error(`[CustomerDevice] Error requesting refresh for ${tag}: ${e.message}`);
    return { ok: false, message: 'Gagal memulai sinkronisasi ONU.' };
  }
}

async function requestReboot(tag, actor = null) {
  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    await instance.post(
      `/devices/${encodeURIComponent(device._id)}/tasks`,
      { name: 'reboot', timestamp: new Date().toISOString() }
    );

    // Catat audit trail jika berhasil
    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REBOOT_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return { ok: true, message: 'Perintah reboot terkirim. Tunggu beberapa menit hingga ONU online.' };
  } catch (e) {
    return { ok: false, message: 'Gagal mengirim reboot ke GenieACS.' };
  }
}

/** Daftar perangkat yang punya minimal satu tag (untuk admin WA). */
async function listDevicesWithTags(limit = 250) {
  const servers = genieacsApi.getAllACSServers();
  const queries = [
    { _tags: { $exists: true, $ne: [] } },
    { _tags: { $exists: true, $not: { $size: 0 } } },
    { '_tags.0': { $exists: true } }
  ];
  const projection = [
    '_id',
    '_tags',
    '_lastInform',
    'DeviceID.SerialNumber',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value'
  ].join(',');

  let allDevices = [];
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 250, 500));

  for (const server of servers) {
    let found = false;
    for (const query of queries) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        let response;
        try {
          response = await instance.get(`/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        } catch (e) {
          response = await instance.get(`/api/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        }
        const rows = Array.isArray(response.data) ? response.data : [];
        if (rows.length > 0) {
          rows.forEach(d => {
            d._acs_server_id = server.id;
            d._acs_server_name = server.name;
          });
          allDevices.push(...rows);
          found = true;
          break;
        }
      } catch (e) {
        /* coba query alternatif */
      }
    }
  }
  
  if (allDevices.length > 0) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS.' };
}

/** Mengambil semua perangkat tanpa melihat tag. */
async function listAllDevices(limit = 999999, acsId = null) {
  let servers = genieacsApi.getAllACSServers();
  if (acsId && acsId !== 'all') {
    servers = servers.filter(s => String(s.id) === String(acsId));
  }
  
  let allDevices = [];
  let lastError = null;

  // Query servers in parallel using Promise.allSettled
  const promises = servers.map(async (server) => {
    try {
      const instance = genieacsApi.createAxiosInstance(server);
      const params = {
        limit,
        projection: '_id,_tags,_lastInform,DeviceID.SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress,Device.PPP.Interface.1.Username,Device.PPP.Interface.1.ExternalIPAddress,InternetGatewayDevice.DeviceInfo.ModelName,InternetGatewayDevice.DeviceInfo.SoftwareVersion,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations,InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries,Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries,Device.Hosts.HostNumberOfEntries,InternetGatewayDevice.LANDevice.1.Hosts.Host,Device.Hosts.Host'
      };
      let response;
      try {
        response = await instance.get(`/devices`, { params, timeout: 8000 });
      } catch (e) {
        response = await instance.get(`/api/devices`, { params, timeout: 8000 });
      }
      const rows = Array.isArray(response.data) ? response.data : [];
      rows.forEach(d => {
        d._acs_server_id = server.id;
        d._acs_server_name = server.name;
      });
      return rows;
    } catch (e) {
      logger.error(`[CustomerDevice] Error listing devices on ${server.name}: ${e.message}`);
      throw e;
    }
  });

  const results = await Promise.allSettled(promises);
  results.forEach((r) => {
    if (r.status === 'fulfilled') {
      allDevices.push(...r.value);
    } else {
      lastError = r.reason;
    }
  });
  
  if (allDevices.length > 0 || !lastError) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS: ' + (lastError ? lastError.message : 'Unknown error') };
}

async function updateCustomerTag(oldTag, newTag) {
  const device = await findDeviceByTag(oldTag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    const tags = Array.isArray(device._tags) ? device._tags.filter((t) => t !== oldTag) : [];
    tags.push(newTag);
    await instance.put(
      `/devices/${encodeURIComponent(device._id)}`,
      { _id: device._id, _tags: tags }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, message: 'Gagal mengubah tag.' };
  }
}

module.exports = {
  findDeviceByTag,
  findDeviceByPppoe,
  fetchFullDevice,
  resolveDeviceToken,
  mapDeviceData,
  extractPppoeUser,
  getCustomerDeviceData,
  fallbackCustomer,
  requestRefresh,
  updateSSID,
  updatePassword,
  requestReboot,
  updateCustomerTag,
  listDevicesWithTags,
  listAllDevices,
  expandTagCandidates,
  findDeviceWithTagVariants,
  phoneFromPnJid
};
