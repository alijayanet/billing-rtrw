/**
 * Logika GenieACS yang dipakai portal web dan bot WhatsApp.
 */
const axios = require('axios');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');

async function findDeviceByTag(tag) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const username = settings.genieacs_username || '';
  const password = settings.genieacs_password || '';
  try {
    const response = await axios.get(`${genieacsUrl}/devices`, {
      params: {
        query: JSON.stringify({ $or: [{ _id: tag }, { _tags: tag }] }),
        projection: '_id,_tags'
      },
      auth: { username, password },
      timeout: 10000
    });
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function findDeviceByPppoe(pppoeUser) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const username = settings.genieacs_username || '';
  const password = settings.genieacs_password || '';
  try {
    const query = {
      $or: [
        { "VirtualParameters.pppoeUsername": pppoeUser },
        { "VirtualParameters.pppUsername": pppoeUser },
        { "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username": pppoeUser },
        { "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value": pppoeUser },
        { "Device.PPP.Interface.1.Username": pppoeUser },
        { "Device.PPP.Interface.1.Username._value": pppoeUser }
      ]
    };
    const response = await axios.get(`${genieacsUrl}/devices`, {
      params: {
        query: JSON.stringify(query),
        projection: '_id,_tags'
      },
      auth: { username, password },
      timeout: 10000
    });
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchFullDevice(tag) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const username = settings.genieacs_username || '';
  const password = settings.genieacs_password || '';
  try {
    const response = await axios.get(`${genieacsUrl}/devices`, {
      params: { query: JSON.stringify({ $or: [{ _id: tag }, { _tags: tag }] }) },
      auth: { username, password },
      timeout: 15000
    });
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function resolveDeviceToken(input) {
  const token = String(input || '').trim();
  if (!token) return null;

  const direct = await findDeviceByTag(token);
  if (direct && direct._id) return direct;

  const byPppoe = await findDeviceByPppoe(token);
  if (byPppoe && byPppoe._id) return byPppoe;

  const found = await findDeviceWithTagVariants(token);
  if (found && found.device && found.device._id) return found.device;

  return null;
}

const parameterPaths = {
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANOAM.RXPower',
    'Device.Optical.Interface.1.OpticalSignalLevel'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.3.Username',
    'Device.PPP.Interface.1.Username',
    'Device.PPP.Interface.2.Username',
    'Device.PPP.Interface.3.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
    'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
    'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries',
    'Device.Hosts.HostNumberOfEntries'
  ]
};

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

function mapDeviceData(device, tag) {
  if (!device) return null;

  const ssid =
    device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1']?.SSID?._value ||
    device?.Device?.WiFi?.SSID?.['1']?.SSID?._value ||
    device?.Device?.WiFi?.SSID?.['1']?.SSID ||
    '-';

  const lastInform =
    device?._lastInform
      ? new Date(device._lastInform).toLocaleString('id-ID')
      : device?.Events?.Inform
        ? new Date(device.Events.Inform).toLocaleString('id-ID')
        : device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value
          ? new Date(device.InternetGatewayDevice.DeviceInfo['1'].LastInform._value).toLocaleString('id-ID')
          : '-';

  let status = 'Unknown';
  if (device?._lastInform) {
    const diffMs = Date.now() - new Date(device._lastInform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  } else if (device?.Events?.Inform) {
    const diffMs = Date.now() - new Date(device.Events.Inform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
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
  } catch (e) {}

  const rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
  const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP);
  const pppoeUsername = getParameterWithPaths(device, parameterPaths.pppUsername);
  const uptimeRaw = getParameterWithPaths(device, parameterPaths.uptime);
  let totalAssociations = getParameterWithPaths(device, parameterPaths.userConnected);

  // Fallback: If N/A or 0, count from connectedUsers list (LAN + WLAN)
  if ((totalAssociations === 'N/A' || totalAssociations === 0 || totalAssociations === '0') && connectedUsers.length > 0) {
    totalAssociations = connectedUsers.filter(u => u.status === 'Online').length;
  }

  function formatUptime(seconds) {
    if (!seconds || isNaN(seconds) || seconds === 'N/A') return seconds || 'N/A';
    const s = parseInt(seconds, 10);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} hari ${h} jam ${m} menit`;
    if (h > 0) return `${h} jam ${m} menit`;
    return `${m} menit`;
  }
  const uptime = formatUptime(uptimeRaw);

  const serialNumber = device?.DeviceID?.SerialNumber || 
                       device?.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 
                       device?.Device?.DeviceInfo?.SerialNumber?._value || 
                       device?.Device?.DeviceInfo?.SerialNumber || '-';
                       
  const productClass = device?.DeviceID?.ProductClass || 
                       device?.InternetGatewayDevice?.DeviceInfo?.ProductClass?._value || 
                       device?.Device?.DeviceInfo?.ProductClass || '-';
                       
  const softwareVersion = device?.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value || 
                          device?.Device?.DeviceInfo?.SoftwareVersion?._value || 
                          device?.Device?.DeviceInfo?.SoftwareVersion || '-';
                          
  const model = device?.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || 
                device?.Device?.DeviceInfo?.ModelName?._value || 
                device?.Device?.DeviceInfo?.ModelName || 
                device?.ModelName || '-';

  let lokasi = device?._tags || '-';
  if (Array.isArray(lokasi)) lokasi = lokasi.join(', ');

  return {
    phone: tag,
    ssid,
    status,
    lastInform,
    connectedUsers,
    rxPower,
    pppoeIP,
    pppoeUsername,
    serialNumber,
    productClass,
    lokasi,
    softwareVersion,
    model,
    uptime,
    totalAssociations
  };
}

async function getCustomerDeviceData(tag) {
  const base = await resolveDeviceToken(tag);
  if (!base || !base._id) return null;
  const device = await fetchFullDevice(base._id);
  return mapDeviceData(device, tag);
}

function fallbackCustomer(tag) {
  return {
    phone: tag,
    ssid: '-',
    status: 'Tidak ditemukan',
    lastInform: '-',
    connectedUsers: [],
    rxPower: '-',
    pppoeIP: '-',
    pppoeUsername: '-',
    serialNumber: '-',
    productClass: '-',
    lokasi: '-',
    softwareVersion: '-',
    model: '-',
    uptime: '-',
    totalAssociations: '-'
  };
}

async function updateSSID(tag, newSSID) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device) return false;
    const deviceId = encodeURIComponent(device._id);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
    const tasksUrl = `${genieacsUrl}/devices/${deviceId}/tasks`;

    const trySet = async (path, value) => {
      try {
        await axios.post(tasksUrl, {
          name: 'setParameterValues',
          parameterValues: [[path, value, 'xsd:string']]
        }, { auth, timeout: 15000 });
        return true;
      } catch (e) {
        return false;
      }
    };

    let ok = false;
    ok = (await trySet('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', newSSID)) || ok;
    ok = (await trySet('Device.WiFi.SSID.1.SSID', newSSID)) || ok;

    const newSSID5G = `${newSSID}-5G`;
    for (const idx of [5, 6, 7, 8]) {
      try {
        const ok5 = await trySet(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.SSID`, newSSID5G);
        if (ok5) ok = true;
        break;
      } catch (e) {}
    }

    ok = (await trySet('Device.WiFi.SSID.2.SSID', newSSID5G)) || ok;

    try {
      await axios.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { auth, timeout: 15000 });
    } catch (e) {}
    try {
      await axios.post(tasksUrl, { name: 'refreshObject', objectName: 'Device.WiFi.SSID' }, { auth, timeout: 15000 });
    } catch (e) {}

    return ok;
  } catch (e) {
    return false;
  }
}

async function updatePassword(tag, newPassword) {
  try {
    if (newPassword.length < 8) {
      logger.warn(`[updatePassword] Password too short for tag ${tag}`);
      return false;
    }
    const device = await resolveDeviceToken(tag);
    if (!device) {
      logger.warn(`[updatePassword] Device not found for tag ${tag}`);
      return false;
    }
    const deviceId = encodeURIComponent(device._id);
    const settings = getSettingsWithCache();
    const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
    const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
    const tasksUrl = `${genieacsUrl}/devices/${deviceId}/tasks`;

    logger.info(`[updatePassword] Setting password for device ${deviceId}, tag ${tag}`);

    const trySet = async (path) => {
      try {
        await axios.post(tasksUrl, {
          name: 'setParameterValues',
          parameterValues: [[path, newPassword, 'xsd:string']]
        }, { auth, timeout: 15000 });
        return true;
      } catch (e) {
        return false;
      }
    };

    let ok = false;

    ok = (await trySet('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase')) || ok;
    ok = (await trySet('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase')) || ok;
    ok = (await trySet('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey')) || ok;

    ok = (await trySet('Device.WiFi.AccessPoint.1.Security.KeyPassphrase')) || ok;
    ok = (await trySet('Device.WiFi.AccessPoint.1.Security.PreSharedKey')) || ok;

    // Set password 5GHz (index 5-8)
    for (const idx of [5, 6, 7, 8]) {
      try {
        const ok1 = await trySet(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.KeyPassphrase`);
        const ok2 = await trySet(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.PreSharedKey.1.KeyPassphrase`);
        const ok3 = await trySet(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.PreSharedKey.1.PreSharedKey`);
        if (ok1 || ok2 || ok3) ok = true;
        break;
      } catch (e) {
        logger.debug(`[updatePassword] 5GHz WLAN.${idx} not available or failed: ${e.message}`);
      }
    }

    ok = (await trySet('Device.WiFi.AccessPoint.2.Security.KeyPassphrase')) || ok;
    ok = (await trySet('Device.WiFi.AccessPoint.2.Security.PreSharedKey')) || ok;

    // Refresh object
    try {
      await axios.post(tasksUrl, { name: 'refreshObject', objectName: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration' }, { auth, timeout: 15000 });
    } catch (e) {}
    try {
      await axios.post(tasksUrl, { name: 'refreshObject', objectName: 'Device.WiFi.AccessPoint' }, { auth, timeout: 15000 });
    } catch (e) {}

    return ok;
  } catch (e) {
    logger.error(`[updatePassword] Error: ${e.message}`, e.response?.data || '');
    return false;
  }
}

async function requestReboot(tag) {
  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
  try {
    await axios.post(
      `${genieacsUrl}/devices/${encodeURIComponent(device._id)}/tasks`,
      { name: 'reboot', timestamp: new Date().toISOString() },
      { auth }
    );
    return { ok: true, message: 'Perintah reboot terkirim. Tunggu beberapa menit hingga ONU online.' };
  } catch (e) {
    return { ok: false, message: 'Gagal mengirim reboot ke GenieACS.' };
  }
}

/** Daftar perangkat yang punya minimal satu tag (untuk admin WA). */
async function listDevicesWithTags(limit = 250) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
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
  for (const query of queries) {
    try {
      const response = await axios.get(`${genieacsUrl}/devices`, {
        params: {
          query: JSON.stringify(query),
          limit: Math.max(1, Math.min(parseInt(limit, 10) || 250, 500)),
          projection
        },
        auth,
        timeout: 45000
      });
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length > 0) {
        return { ok: true, devices: rows.slice(0, limit) };
      }
    } catch (e) {
      /* coba query alternatif */
    }
  }
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS.' };
}

/** Mengambil semua perangkat tanpa melihat tag. */
async function listAllDevices(limit = 500) {
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
  try {
    const response = await axios.get(`${genieacsUrl}/devices`, {
      params: {
        limit,
        projection: '_id,_tags,_lastInform,DeviceID.SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress,Device.PPP.Interface.1.Username,Device.PPP.Interface.1.ExternalIPAddress,InternetGatewayDevice.DeviceInfo.ModelName,InternetGatewayDevice.DeviceInfo.SoftwareVersion,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations,InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries,Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries,Device.Hosts.HostNumberOfEntries,InternetGatewayDevice.LANDevice.1.Hosts.Host,Device.Hosts.Host'
      },
      auth,
      timeout: 45000
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    return { ok: true, devices: rows.slice(0, limit) };
  } catch (e) {
    return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS: ' + e.message };
  }
}

async function updateCustomerTag(oldTag, newTag) {
  const device = await findDeviceByTag(oldTag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  const settings = getSettingsWithCache();
  const genieacsUrl = settings.genieacs_url || 'http://localhost:7557';
  const auth = { username: settings.genieacs_username || '', password: settings.genieacs_password || '' };
  try {
    const tags = Array.isArray(device._tags) ? device._tags.filter((t) => t !== oldTag) : [];
    tags.push(newTag);
    await axios.put(
      `${genieacsUrl}/devices/${encodeURIComponent(device._id)}`,
      { _id: device._id, _tags: tags },
      { auth }
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
  getCustomerDeviceData,
  fallbackCustomer,
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
