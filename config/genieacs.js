const axios = require('axios');
require('dotenv').config();
const { logger } = require('./logger');
const db = require('./database');
const { getSetting } = require('./settingsManager');

// ─── Built-in ACS Helpers ────────────────────────────────────────────────────

/** Check if built-in ACS mode is active */
function isBuiltinAcsEnabled() {
  return getSetting('use_builtin_acs', false) === true || getSetting('use_builtin_acs', false) === 'true';
}

/**
 * Inflate flat params object into nested GenieACS-style structure.
 * e.g. { "InternetGatewayDevice.DeviceInfo.SerialNumber": "ABC" }
 * becomes { InternetGatewayDevice: { DeviceInfo: { SerialNumber: { _value: "ABC" } } } }
 */
function inflateParams(flatObj) {
  const result = {};
  for (const [key, value] of Object.entries(flatObj)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = { _value: value, _type: typeof value === 'number' ? 'xsd:unsignedInt' : 'xsd:string', _timestamp: new Date().toISOString() };
      } else {
        if (!current[part] || typeof current[part] !== 'object' || current[part]._value !== undefined) {
          current[part] = {};
        }
        current = current[part];
      }
    }
  }
  return result;
}

/** Convert a builtin acs_devices row into GenieACS-compatible device object */
function builtinRowToDevice(row) {
  if (!row) return null;
  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (e) { /* ignore */ }
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch (e) { /* ignore */ }
  tags = tags.filter(t => t !== 'bootstrapped');

  const device = inflateParams(params);
  device._id = row.id;
  device._tags = tags;
  device._lastInform = row.last_inform;
  device._updatedAt = row.updated_at;
  device._registered = row.created_at;
  device._acs_server_id = 'builtin';
  device._acs_server_name = 'Built-in ACS';

  // Set GenieACS special _deviceId root property
  device._deviceId = {
    _SerialNumber: row.serial_number || '',
    _Manufacturer: row.manufacturer || '',
    _ProductClass: row.product_class || '',
    _OUI: row.oui || ''
  };

  // Set DeviceID structure as strings (GenieACS standard)
  device.DeviceID = {
    SerialNumber: row.serial_number || '',
    Manufacturer: row.manufacturer || '',
    ProductClass: row.product_class || '',
    OUI: row.oui || ''
  };

  return device;
}

/** Parse GenieACS-style query filter for SQLite */
function matchesQuery(device, query) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(condition)) return false;
      const anyMatch = condition.some(sub => matchesQuery(device, sub));
      if (!anyMatch) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(condition)) return false;
      const allMatch = condition.every(sub => matchesQuery(device, sub));
      if (!allMatch) return false;
      continue;
    }
    // Get value from nested device object
    const parts = key.split('.');
    let val = device;
    for (const p of parts) {
      if (val && typeof val === 'object') {
        val = val[p];
      } else {
        val = undefined;
        break;
      }
    }
    if (val && val._value !== undefined) val = val._value;

    // Handle condition types
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$exists' in condition) {
        const exists = val !== undefined && val !== null;
        if (condition.$exists !== exists) return false;
      }
      if ('$ne' in condition) {
        if (Array.isArray(condition.$ne) && condition.$ne.length === 0) {
          if (!Array.isArray(val) || val.length === 0) return false;
        } else if (val === condition.$ne) return false;
      }
      if ('$not' in condition) {
        if (condition.$not && typeof condition.$not === 'object' && '$size' in condition.$not) {
          if (Array.isArray(val) && val.length === condition.$not.$size) return false;
        }
      }
    } else {
      // Direct equality
      if (key === '_tags') {
        if (!Array.isArray(device._tags) || !device._tags.includes(condition)) return false;
      } else if (key === '_id') {
        if (device._id !== condition) return false;
      } else {
        if (String(val) !== String(condition)) return false;
      }
    }
  }
  return true;
}

/**
 * Create a proxy object that mimics axios interface but operates on local SQLite.
 * This is the core of the adapter pattern - all downstream code using
 * createAxiosInstance() will transparently use local DB when builtin ACS is active.
 */
function createBuiltinAxiosProxy() {
  return {
    get: async (url, config = {}) => {
      const params = config.params || {};
      
      // GET /devices
      if (url === '/devices' || url === '/devices/') {
        let rows = [];
        try {
          const limit = params.limit || 999999;
          rows = db.prepare('SELECT * FROM acs_devices ORDER BY last_inform DESC LIMIT ?').all(limit);
        } catch (e) {
          logger.error(`[BuiltinACS] Error querying devices: ${e.message}`);
        }
        
        let devices = rows.map(builtinRowToDevice);
        
        // Apply query filter
        if (params.query) {
          try {
            const queryObj = typeof params.query === 'string' ? JSON.parse(params.query) : params.query;
            devices = devices.filter(d => matchesQuery(d, queryObj));
          } catch (e) {
            logger.debug(`[BuiltinACS] Query parse error: ${e.message}`);
          }
        }
        
        return { data: devices, status: 200 };
      }
      
      // GET /devices/:id
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const row = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
        if (!row) {
          const err = new Error(`Device ${deviceId} not found`);
          err.response = { status: 404, data: 'Not found' };
          throw err;
        }
        return { data: builtinRowToDevice(row), status: 200 };
      }
      
      return { data: [], status: 200 };
    },
    
    post: async (url, data = {}, config = {}) => {
      // POST /devices/:id/tasks
      const taskMatch = url.match(/^\/devices\/(.+)\/tasks$/);
      if (taskMatch) {
        const deviceId = decodeURIComponent(taskMatch[1]);
        const taskName = data.name || 'unknown';
        const payload = JSON.stringify(data);
        const now = new Date().toISOString();
        
        try {
          const result = db.prepare(
            'INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(deviceId, taskName, payload, 'pending', now, now);
          
          logger.info(`[BuiltinACS] Task '${taskName}' created for device ${deviceId}, id=${result.lastInsertRowid}`);
          
          // Trigger connection request asynchronously
          try {
            const acsService = require('../services/acsServerService');
            acsService.triggerConnectionRequest(deviceId).catch(() => {});
          } catch (e) { /* service not loaded yet */ }
          
          return { data: { _id: String(result.lastInsertRowid), name: taskName, device: deviceId }, status: 202 };
        } catch (e) {
          logger.error(`[BuiltinACS] Error creating task: ${e.message}`);
          return { data: {}, status: 500 };
        }
      }
      
      return { data: {}, status: 200 };
    },
    
    put: async (url, data = {}, config = {}) => {
      // PUT /devices/:id — update tags
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const now = new Date().toISOString();
        
        if (data._tags) {
          try {
            db.prepare('UPDATE acs_devices SET tags = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(data._tags), now, deviceId);
            return { data: {}, status: 200 };
          } catch (e) {
            logger.error(`[BuiltinACS] Error updating tags: ${e.message}`);
          }
        }
      }
      return { data: {}, status: 200 };
    },
    
    delete: async (url, config = {}) => {
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        try {
          db.prepare('DELETE FROM acs_devices WHERE id = ?').run(deviceId);
          db.prepare('DELETE FROM acs_tasks WHERE device_id = ?').run(deviceId);
          return { data: {}, status: 200 };
        } catch (e) {
          logger.error(`[BuiltinACS] Error deleting device: ${e.message}`);
        }
      }
      return { data: {}, status: 200 };
    }
  };
}

// Import WhatsApp notification function
let sendMonitoringAlert = null;
(async () => {
  try {
    const whatsappBot = await import('../services/whatsappBot.mjs');
    sendMonitoringAlert = whatsappBot.sendMonitoringAlert;
    logger.info('[GenieACS] WhatsApp monitoring alert integration loaded');
  } catch (error) {
    logger.warn('[GenieACS] WhatsApp bot not available for monitoring alerts');
  }
})();

// Konfigurasi GenieACS API (Legacy - untuk backward compatibility)
const GENIEACS_URL = process.env.GENIEACS_URL || 'http://localhost:7557';
const GENIEACS_USERNAME = process.env.GENIEACS_USERNAME;
const GENIEACS_PASSWORD = process.env.GENIEACS_PASSWORD;

// Helper: Get all ACS servers from database
function getAllACSServers() {
    try {
        const servers = [];

        if (isBuiltinAcsEnabled()) {
            servers.push({
                id: 'builtin',
                name: 'Built-in ACS',
                url: 'local',
                status: 'active'
            });
        }

        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        // Add legacy server if configured
        if (legacyUrl) {
            servers.push({
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            });
        }
        
        // Add servers from database
        const dbServers = db.prepare('SELECT * FROM genieacs_servers WHERE status = ?').all('active');
        servers.push(...dbServers);
        
        return servers;
    } catch (error) {
        logger.error(`[GenieACS] Error getting ACS servers: ${error.message}`);
        return [];
    }
}

// Helper: Get specific ACS server by ID
function getACSServer(serverId) {
    if (!serverId) {
        if (isBuiltinAcsEnabled()) {
            return {
                id: 'builtin',
                name: 'Built-in ACS',
                url: 'local',
                status: 'active'
            };
        }
        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        if (legacyUrl) {
            return {
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            };
        }
        return null;
    }

    if (serverId === 'builtin') {
        return {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
    }
    
    if (serverId === 'legacy') {
        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        
        if (legacyUrl) {
            return {
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            };
        }
        return null;
    }
    
    try {
        const server = db.prepare('SELECT * FROM genieacs_servers WHERE id = ?').get(serverId);
        return server || null;
    } catch (error) {
        logger.error(`[GenieACS] Error getting ACS server ${serverId}: ${error.message}`);
        return null;
    }
}

// Helper: Create axios instance for specific server
function createAxiosInstance(server) {
    // Built-in ACS: return proxy object that mimics axios but uses SQLite
    if (server && (server.id === 'builtin' || server.url === 'local')) {
        return createBuiltinAxiosProxy();
    }
    
    const config = {
        baseURL: server.url.endsWith('/') ? server.url.slice(0, -1) : server.url,
        timeout: 30000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    
    return axios.create(config);
}

// Legacy axios instance (untuk backward compatibility)
const axiosInstance = axios.create({
    baseURL: GENIEACS_URL,
    timeout: 30000,
    auth: {
        username: GENIEACS_USERNAME,
        password: GENIEACS_PASSWORD
    },
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    }
});

// GenieACS API wrapper
const genieacsApi = {
    // Get devices from all servers or specific server
    async getDevices(serverId = null) {
        try {
            logger.debug('[GenieACS] Getting all devices...');
            
            const servers = serverId ? [getACSServer(serverId)].filter(Boolean) : getAllACSServers();
            const allDevices = [];
            
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    let response;
                    try {
                        response = await instance.get('/devices', {
                            timeout: 45000
                        });
                    } catch (e) {
                        response = await instance.get('/api/devices', {
                            timeout: 45000
                        });
                    }
                    
                    const devices = response.data || [];
                    // Add server info to each device
                    devices.forEach(device => {
                        device._acs_server_id = server.id;
                        device._acs_server_name = server.name;
                    });
                    
                    allDevices.push(...devices);
                    logger.debug(`[GenieACS] Found ${devices.length} devices from ${server.name}`);
                } catch (error) {
                    logger.error(`[GenieACS] Error getting devices from ${server.name}: ${error.message}`);
                }
            }
            
            logger.debug(`[GenieACS] Total devices found: ${allDevices.length}`);
            return allDevices;
        } catch (error) {
            logger.error(`[GenieACS] Error getting devices: ${error.message}`);
            throw error;
        }
    },

    // Find device by phone number across all servers (returns full device data)
    async findDeviceByPhoneNumber(phoneNumber, serverId = null) {
        try {
            logger.debug(`[GenieACS] Finding device with phone number: ${phoneNumber}`);
            
            const servers = serverId ? [getACSServer(serverId)].filter(Boolean) : getAllACSServers();
            
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    // Don't use projection - get full device data
                    let response;
                    try {
                        response = await instance.get('/devices', {
                            params: {
                                'query': JSON.stringify({
                                    '_tags': phoneNumber
                                })
                            },
                            timeout: 15000
                        });
                    } catch (e) {
                        response = await instance.get('/api/devices', {
                            params: {
                                'query': JSON.stringify({
                                    '_tags': phoneNumber
                                })
                            },
                            timeout: 15000
                        });
                    }

                    if (response.data && response.data.length > 0) {
                        const device = response.data[0];
                        device._acs_server_id = server.id;
                        device._acs_server_name = server.name;
                        logger.debug(`[GenieACS] Device found on ${server.name} with full data`);
                        return device;
                    }
                } catch (error) {
                    logger.debug(`[GenieACS] Device not found on ${server.name}: ${error.message}`);
                }
            }
            
            throw new Error(`No device found with phone number: ${phoneNumber}`);
        } catch (error) {
            logger.error(`[GenieACS] Error finding device with phone number ${phoneNumber}: ${error.message}`);
            throw error;
        }
    },

    async getDeviceByPhoneNumber(phoneNumber, serverId = null) {
        try {
            // findDeviceByPhoneNumber already returns full device data
            return await this.findDeviceByPhoneNumber(phoneNumber, serverId);
        } catch (error) {
            logger.error(`[GenieACS] Error getting device by phone number ${phoneNumber}: ${error.message}`);
            throw error;
        }
    },

    async getDevice(deviceId, serverId = null) {
        try {
            // If serverId provided, use that server
            if (serverId) {
                const server = getACSServer(serverId);
                if (!server) {
                    throw new Error(`ACS Server ${serverId} not found`);
                }
                const instance = createAxiosInstance(server);
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                const device = response.data;
                device._acs_server_id = server.id;
                device._acs_server_name = server.name;
                return device;
            }
            
            // Otherwise, search all servers
            const servers = getAllACSServers();
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                    const device = response.data;
                    device._acs_server_id = server.id;
                    device._acs_server_name = server.name;
                    return device;
                } catch (error) {
                    // Continue to next server
                }
            }
            
            throw new Error(`Device ${deviceId} not found on any server`);
        } catch (error) {
            logger.error(`[GenieACS] Error getting device ${deviceId}: ${error.message}`);
            throw error;
        }
    },

    async setParameterValues(deviceId, parameters, serverId = null) {
        try {
            logger.debug(`[GenieACS] Setting parameters for device: ${deviceId}`);

            // Format parameter values untuk GenieACS
            const parameterValues = [];
            for (const [path, value] of Object.entries(parameters)) {
                // Handle SSID update
                if (path.includes('SSID')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", value],
                        ["Device.WiFi.SSID.1.SSID", value]
                    );
                }
                // Handle WiFi password update
                else if (path.includes('Password') || path.includes('KeyPassphrase')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey", value]
                    );
                }
                // Handle other parameters
                else {
                    parameterValues.push([path, value]);
                }
            }

            logger.debug(`[GenieACS] Formatted parameter values count: ${parameterValues.length}`);

            // Get server instance
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;

            // Kirim task ke GenieACS
            const task = {
                name: "setParameterValues",
                parameterValues: parameterValues
            };

            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );

            logger.debug('[GenieACS] Parameter update task queued');

            // Kirim refresh task
            const refreshTask = {
                name: "refreshObject",
                objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1"
            };

            const refreshResponse = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                refreshTask
            );

            logger.debug('[GenieACS] Refresh task queued');

            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error setting parameters for device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async reboot(deviceId, serverId = null) {
        try {
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;
            
            const task = {
                name: "reboot",
                timestamp: new Date().toISOString()
            };
            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error rebooting device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async factoryReset(deviceId, serverId = null) {
        try {
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;
            
            const task = {
                name: "factoryReset",
                timestamp: new Date().toISOString()
            };
            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error factory resetting device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async getDeviceParameters(deviceId, parameterNames) {
        try {
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                return response.data;
            }
            const queryString = parameterNames.map(name => `query=${encodeURIComponent(name)}`).join('&');
            const response = await axiosInstance.get(`/devices/${encodeURIComponent(deviceId)}?${queryString}`);
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting parameters for device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async getDeviceInfo(deviceId) {
        try {
            logger.debug(`[GenieACS] Getting device info for device ID: ${deviceId}`);
            
            // Built-in ACS mode
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                return response.data;
            }
            
            // Mendapatkan device detail
            const deviceResponse = await axios.get(`${GENIEACS_URL}/devices/${encodeURIComponent(deviceId)}`, {
                auth: {
                    username: GENIEACS_USERNAME,
                    password: GENIEACS_PASSWORD
                }
            });

            if (!deviceResponse.data) {
                logger.warn('[GenieACS] No device data found');
                return null;
            }

            logger.debug('[GenieACS] Device data retrieved successfully');
            return deviceResponse.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting device info: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            return null;
        }
    },

    async getVirtualParameters(deviceId) {
        try {
            logger.debug(`[GenieACS] Getting virtual parameters for device ID: ${deviceId}`);
            
            // Built-in ACS mode: return device data directly (params already stored)
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                try {
                    const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                    return response.data;
                } catch (e) {
                    return null;
                }
            }
            
            const virtualParams = [
                // Serial Number
                'InternetGatewayDevice.DeviceInfo.SerialNumber',
                'Device.DeviceInfo.SerialNumber',
                'VirtualParameters.getSerialNumber',
                
                // Device Uptime
                'InternetGatewayDevice.DeviceInfo.UpTime',
                'Device.DeviceInfo.UpTime',
                'VirtualParameters.getdeviceuptime',
                
                // PPPoE Uptime
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.UpTime',
                'Device.PPP.Interface.1.UpTime',
                'VirtualParameters.getpppuptime',
                
                // Active Devices
                'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
                'Device.Hosts.HostNumberOfEntries',
                'VirtualParameters.activedevices',
                'VirtualParameters.getactivedevices',
                
                // RX Power
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.XPON.RxPower',
                'Device.XPON.Interface.1.RxPower',
                'VirtualParameters.RXPower',
                'VirtualParameters.redaman',
                
                // PON MAC
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.MACAddress',
                'Device.Ethernet.Interface.1.MACAddress',
                'VirtualParameters.PonMac',
                
                // WAN IP
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
                'Device.IP.Interface.1.IPv4Address.1.IPAddress',
                'VirtualParameters.WanIP',
                
                // PPP IP
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
                'Device.PPP.Interface.1.IPCP.LocalIPAddress',
                'VirtualParameters.pppIP',
                'VirtualParameters.pppoeIP',
                
                // Temperature
                'InternetGatewayDevice.DeviceInfo.Temperature',
                'Device.DeviceInfo.Temperature',
                'VirtualParameters.gettemp'
            ];

            // Menggunakan tasks endpoint untuk mendapatkan parameter values
            const response = await axios.post(`${GENIEACS_URL}/tasks`, [{
                name: "getParameterValues",
                parameterNames: virtualParams,
                device: deviceId
            }], {
                auth: {
                    username: GENIEACS_USERNAME,
                    password: GENIEACS_PASSWORD
                }
            });

            logger.debug('[GenieACS] Virtual parameters retrieved successfully');
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting virtual parameters: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            return null;
        }
    },
};

// Fungsi untuk memeriksa nilai RXPower dari semua perangkat
async function monitorRXPower(threshold = -27) {
    try {
        logger.info(`[RXPower] Memulai pemantauan RXPower dengan threshold ${threshold} dBm`);
        
        // Ambil semua perangkat
        const devices = await genieacsApi.getDevices();
        logger.info(`[RXPower] Memeriksa RXPower untuk ${devices.length} perangkat...`);
        
        // Ambil data PPPoE dari Mikrotik
        logger.debug('[RXPower] Mengambil data PPPoE dari Mikrotik...');
        // const conn = await getMikrotikConnection(); // Removed Mikrotik connection
        let pppoeSecrets = [];
        
        // if (conn) { // Removed Mikrotik connection
        //     try {
        //         // Dapatkan semua PPPoE secret dari Mikrotik
        //         pppoeSecrets = await conn.write('/ppp/secret/print');
        //         console.log(`Ditemukan ${pppoeSecrets.length} PPPoE secret`);
        //     } catch (error) {
        //         console.error('Error mendapatkan PPPoE secret:', error.message);
        //     }
        // }
        
        const criticalDevices = [];
        
        // Periksa setiap perangkat
        for (const device of devices) {
            try {
                // Dapatkan nilai RXPower
                const rxPowerPaths = [
                    'VirtualParameters.RXPower',
                    'VirtualParameters.redaman',
                    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
                    'Device.XPON.Interface.1.Stats.RXPower'
                ];
                
                let rxPower = null;
                
                // Periksa setiap jalur yang mungkin berisi nilai RXPower
                for (const path of rxPowerPaths) {
                    // Ekstrak nilai menggunakan path yang ada di device
                    if (getRXPowerValue(device, path)) {
                        rxPower = getRXPowerValue(device, path);
                        break;
                    }
                }
                
                // Jika rxPower ditemukan dan di bawah threshold
                if (rxPower !== null && parseFloat(rxPower) < threshold) {
                    // Cari PPPoE username dari parameter perangkat (seperti di handleAdminCheckONU)
                    let pppoeUsername = "Unknown";
                    const serialNumber = getDeviceSerialNumber(device);
                    const deviceId = device._id;
                    const shortDeviceId = deviceId.split('-')[2] || deviceId;
                    
                    // Ambil PPPoE username dari parameter perangkat
                    pppoeUsername = 
                        device.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
                        device.InternetGatewayDevice?.WANDevice?.['0']?.WANConnectionDevice?.['0']?.WANPPPConnection?.['0']?.Username?._value ||
                        device.VirtualParameters?.pppoeUsername?._value ||
                        "Unknown";
                    
                    // Jika tidak ditemukan dari parameter perangkat, coba cari dari PPPoE secret di Mikrotik
                    if (pppoeUsername === "Unknown") {
                        // Coba cari PPPoE secret yang terkait dengan perangkat ini berdasarkan comment
                        const matchingSecret = pppoeSecrets.find(secret => {
                            if (!secret.comment) return false;
                            
                            // Cek apakah serial number atau device ID ada di kolom comment
                            return (
                                secret.comment.includes(serialNumber) || 
                                secret.comment.includes(shortDeviceId)
                            );
                        });
                        
                        if (matchingSecret) {
                            // Jika ditemukan secret yang cocok, gunakan nama secret sebagai username
                            pppoeUsername = matchingSecret.name;
                            logger.debug(`[RXPower] Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari PPPoE secret`);
                        }
                    } else {
                        logger.debug(`[RXPower] Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari parameter perangkat`);
                    }
                    
                    // Jika masih tidak ditemukan, coba cari dari tag perangkat
                    if (pppoeUsername === "Unknown" && device._tags && Array.isArray(device._tags)) {
                        // Cek apakah ada tag yang dimulai dengan "pppoe:" yang berisi username
                        const pppoeTag = device._tags.find(tag => tag.startsWith('pppoe:'));
                        if (pppoeTag) {
                            pppoeUsername = pppoeTag.replace('pppoe:', '');
                            logger.debug(`[RXPower] Menemukan PPPoE username ${pppoeUsername} untuk perangkat ${shortDeviceId} dari tag`);
                        } else {
                            logger.debug(`[RXPower] Tidak menemukan PPPoE username untuk perangkat ${shortDeviceId}, tags: ${JSON.stringify(device._tags)}`);
                        }
                    }
                    
                    const deviceInfo = {
                        id: device._id,
                        rxPower,
                        serialNumber: getDeviceSerialNumber(device),
                        lastInform: device._lastInform,
                        pppoeUsername: pppoeUsername
                    };
                    
                    criticalDevices.push(deviceInfo);
                    logger.info(`[RXPower] Perangkat redaman tinggi: ${deviceInfo.id}, RXPower: ${rxPower} dBm, PPPoE: ${pppoeUsername}`);
                }
            } catch (deviceError) {
                logger.error(`[RXPower] Error memeriksa RXPower untuk perangkat ${device._id}: ${deviceError.message || String(deviceError)}`);
            }
        }
        
        // Jika ada perangkat dengan RXPower di bawah threshold
        if (criticalDevices.length > 0) {
            // Buat pesan peringatan
            let message = `*PERINGATAN: REDAMAN TINGGI*\n\n`;
            message += `${criticalDevices.length} perangkat memiliki nilai RX Power lebih buruk dari ${threshold} dBm (semakin negatif = semakin buruk):\n\n`;
            
            criticalDevices.forEach((device, index) => {
                message += `${index + 1}. *Device ID:* ${device.id.split('-')[2] || device.id}\n`;
                message += `   📱 *S/N:* ${device.serialNumber}\n`;
                message += `   👤 *PPPoE:* ${device.pppoeUsername}\n`;
                message += `   📡 *RX Power:* ${device.rxPower} dBm\n`;
                message += `   🕒 *Last Inform:* ${new Date(device.lastInform).toLocaleString('id-ID')}\n\n`;
            });
            
            message += `⚠️ *Mohon segera dicek untuk menghindari koneksi terputus.*`;
            
            // Kirim notifikasi WhatsApp jika tersedia
            if (sendMonitoringAlert) {
                try {
                    const result = await sendMonitoringAlert(message, 'high');
                    if (result.success) {
                        logger.info(`[RXPower] Notifikasi WhatsApp terkirim: ${result.message}`);
                    } else {
                        logger.warn(`[RXPower] Gagal mengirim notifikasi WhatsApp: ${result.message}`);
                    }
                } catch (error) {
                    logger.error(`[RXPower] Error mengirim notifikasi WhatsApp: ${error.message}`);
                }
            } else {
                logger.warn('[RXPower] WhatsApp bot tidak tersedia untuk mengirim notifikasi');
            }
            
            logger.info(`[RXPower] Pesan peringatan dibuat untuk ${criticalDevices.length} perangkat`);
        } else {
            logger.info('[RXPower] Tidak ada perangkat dengan nilai RXPower di bawah threshold');
        }
        
        return {
            success: true,
            criticalDevices,
            message: `${criticalDevices.length} perangkat memiliki RXPower di atas threshold`
        };
    } catch (error) {
        logger.error(`[RXPower] Error memantau RXPower: ${error.message || String(error)}`);
        return {
            success: false,
            message: `Error memantau RXPower: ${error.message}`,
            error
        };
    }
}

// Helper function untuk mendapatkan nilai RXPower
function getRXPowerValue(device, path) {
    try {
        // Split path menjadi parts
        const parts = path.split('.');
        let current = device;
        
        // Navigate through nested properties
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }
        
        // Check if it's a GenieACS parameter object
        if (current && current._value !== undefined) {
            return current._value;
        }
        
        return null;
    } catch (error) {
        logger.debug(`[RXPower] Error getting RXPower from path ${path}: ${error.message || String(error)}`);
        return null;
    }
}

// Helper function untuk mendapatkan serial number
function getDeviceSerialNumber(device) {
    try {
        const serialPaths = [
            'DeviceID.SerialNumber',
            'InternetGatewayDevice.DeviceInfo.SerialNumber',
            'Device.DeviceInfo.SerialNumber'
        ];
        
        for (const path of serialPaths) {
            const parts = path.split('.');
            let current = device;
            
            for (const part of parts) {
                if (!current) break;
                current = current[part];
            }
            
            if (current && current._value !== undefined) {
                return current._value;
            }
        }
        
        // Fallback ke ID perangkat jika serial number tidak ditemukan
        if (device._id) {
            const parts = device._id.split('-');
            if (parts.length >= 3) {
                return parts[2];
            }
            return device._id;
        }
        
        return 'Unknown';
    } catch (error) {
        logger.error('Error getting device serial number:', error);
        return 'Unknown';
    }
}

// Fungsi untuk memantau perangkat yang tidak aktif (offline)
async function monitorOfflineDevices(thresholdHours = 24) {
    try {
        logger.info(`[Offline] Memulai pemantauan perangkat offline dengan threshold ${thresholdHours} jam`);
        
        // Ambil semua perangkat
        const devices = await genieacsApi.getDevices();
        logger.info(`[Offline] Memeriksa status untuk ${devices.length} perangkat...`);
        
        const offlineDevices = [];
        const now = new Date();
        const thresholdMs = thresholdHours * 60 * 60 * 1000; // Convert jam ke ms
        
        // Periksa setiap perangkat
        for (const device of devices) {
            try {
                if (!device._lastInform) {
                    logger.info(`[Offline] Perangkat ${device._id} tidak memiliki lastInform`);
                    continue;
                }
                
                const lastInformTime = new Date(device._lastInform).getTime();
                const timeDiff = now.getTime() - lastInformTime;
                
                // Jika perangkat belum melakukan inform dalam waktu yang melebihi threshold
                if (timeDiff > thresholdMs) {
                    const deviceInfo = {
                        id: device._id,
                        serialNumber: getDeviceSerialNumber(device),
                        lastInform: device._lastInform,
                        offlineHours: Math.round(timeDiff / (60 * 60 * 1000) * 10) / 10 // Jam dengan 1 desimal
                    };
                    
                    offlineDevices.push(deviceInfo);
                    logger.info(`[Offline] Perangkat offline: ${deviceInfo.id}, Offline selama: ${deviceInfo.offlineHours} jam`);
                }
            } catch (deviceError) {
                logger.error(`[Offline] Error memeriksa status untuk perangkat ${device._id}: ${deviceError.message || String(deviceError)}`);
            }
        }
        
        // Jika ada perangkat yang offline
        if (offlineDevices.length > 0) {
            // Buat pesan peringatan
            let message = `*PERINGATAN: PERANGKAT OFFLINE*\n\n`;
            message += `${offlineDevices.length} perangkat offline lebih dari ${thresholdHours} jam:\n\n`;
            
            offlineDevices.forEach((device, index) => {
                message += `${index + 1}. *Device ID:* ${device.id.split('-')[2] || device.id}\n`;
                message += `   📱 *S/N:* ${device.serialNumber}\n`;
                message += `   ⏱️ *Offline:* ${device.offlineHours} jam\n`;
                message += `   🕒 *Last Inform:* ${new Date(device.lastInform).toLocaleString('id-ID')}\n\n`;
            });
            
            message += `⚠️ *Mohon segera ditindaklanjuti.*`;
            
            // Kirim notifikasi WhatsApp jika tersedia
            if (sendMonitoringAlert) {
                try {
                    const result = await sendMonitoringAlert(message, 'medium');
                    if (result.success) {
                        logger.info(`[Offline] Notifikasi WhatsApp terkirim: ${result.message}`);
                    } else {
                        logger.warn(`[Offline] Gagal mengirim notifikasi WhatsApp: ${result.message}`);
                    }
                } catch (error) {
                    logger.error(`[Offline] Error mengirim notifikasi WhatsApp: ${error.message}`);
                }
            } else {
                logger.warn('[Offline] WhatsApp bot tidak tersedia untuk mengirim notifikasi');
            }
            
            logger.info(`[Offline] Pesan peringatan perangkat offline terkirim untuk ${offlineDevices.length} perangkat`);
        } else {
            logger.info('[Offline] Tidak ada perangkat yang offline lebih dari threshold');
        }
        
        return {
            success: true,
            offlineDevices,
            message: `${offlineDevices.length} perangkat offline lebih dari ${thresholdHours} jam`
        };
    } catch (error) {
        logger.error(`[Offline] Error memantau perangkat offline: ${error.message || String(error)}`);
        return {
            success: false,
            message: `Error memantau perangkat offline: ${error.message}`,
            error
        };
    }
}

// Jadwalkan monitoring setiap 6 jam
function scheduleMonitoring() {
    // Jalankan sekali saat startup (delay lebih lama untuk stabilitas)
    setTimeout(async () => {
        logger.info('[Monitoring] Menjalankan pemantauan RXPower awal...');
        try {
            await monitorRXPower();
        } catch (error) {
            logger.error('[Monitoring] Error pada pemantauan RXPower awal:', error.message);
        }
        
        logger.info('[Monitoring] Menjalankan pemantauan perangkat offline awal...');
        try {
            await monitorOfflineDevices();
        } catch (error) {
            logger.error('[Monitoring] Error pada pemantauan offline awal:', error.message);
        }
        
        // Jadwalkan secara berkala dengan error handling
        setInterval(async () => {
            logger.info('[Monitoring] Menjalankan pemantauan RXPower terjadwal...');
            try {
                await monitorRXPower();
            } catch (error) {
                logger.error('[Monitoring] Error pada pemantauan RXPower:', error.message);
            }
        }, 6 * 60 * 60 * 1000); // Setiap 6 jam
        
        setInterval(async () => {
            logger.info('[Monitoring] Menjalankan pemantauan perangkat offline terjadwal...');
            try {
                await monitorOfflineDevices();
            } catch (error) {
                logger.error('[Monitoring] Error pada pemantauan offline:', error.message);
            }
        }, 12 * 60 * 60 * 1000); // Setiap 12 jam
    }, 10 * 60 * 1000); // Mulai 10 menit setelah server berjalan (lebih stabil)
}

// Jalankan penjadwalan monitoring
scheduleMonitoring();

module.exports = {
    // Multi-server helpers
    getAllACSServers,
    getACSServer,
    createAxiosInstance,
    isBuiltinAcsEnabled,
    
    // GenieACS API methods (now support multi-server)
    getDevices: genieacsApi.getDevices,
    getDevice: genieacsApi.getDevice,
    getDeviceInfo: genieacsApi.getDeviceInfo,
    findDeviceByPhoneNumber: genieacsApi.findDeviceByPhoneNumber,
    getDeviceByPhoneNumber: genieacsApi.getDeviceByPhoneNumber,
    setParameterValues: genieacsApi.setParameterValues,
    reboot: genieacsApi.reboot,
    factoryReset: genieacsApi.factoryReset,
    getVirtualParameters: genieacsApi.getVirtualParameters,
    
    // Monitoring functions (automatically support multi-server)
    monitorRXPower,
    monitorOfflineDevices
};
