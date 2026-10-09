const express = require('express');
const router = express.Router();
const rawAxios = require('axios');
const db = require('../config/database');
const { getSetting, getSettings } = require('../config/settingsManager');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const customerDevice = require('../services/customerDeviceService');
const mikrotikSvc = require('../services/mikrotikService');
const fs = require('fs');
const path = require('path');
const { createAxiosInstance, isBuiltinAcsEnabled } = require('../config/genieacs');

// Proxy axios to support local built-in ACS proxy
const axios = {
    get: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && (url.startsWith('local/') || url === 'local')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.get(path, config);
        }
        return rawAxios.get(url, config);
    },
    post: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.post(path, data, config);
        }
        return rawAxios.post(url, data, config);
    },
    delete: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.delete(path, config);
        }
        return rawAxios.delete(url, config);
    },
    put: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.put(path, data, config);
        }
        return rawAxios.put(url, data, config);
    }
};

// Helper for DB queries (using better-sqlite3)
function getACSServers(id = null) {
    const builtinServer = isBuiltinAcsEnabled() ? {
        id: 'builtin',
        name: 'Built-in ACS',
        url: 'local',
        location: 'Built-in TR-069 Server',
        status: 'active',
        device_count: (() => {
            try {
                return db.prepare('SELECT count(*) as count FROM acs_devices').get()?.count || 0;
            } catch (_) {
                return 0;
            }
        })()
    } : null;

    if (id === 'builtin') {
        return builtinServer ? [builtinServer] : [];
    }

    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        return row ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    const allServers = [];
    if (builtinServer) allServers.push(builtinServer);
    if (legacyServer) allServers.push(legacyServer);
    allServers.push(...rows);
    return allServers;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', ''),
        acs_vparams: '', // Default empty for now
        acs_path_pppoe: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        acs_path_ip: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 15000,
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
    return config;
}

// Helper to normalize URL
function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toBool(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function normalizeSelectionArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return Array.from(new Set(
        items.map(v => String(v || '').trim()).filter(Boolean)
    ));
}

function buildSingleParamTasks(parameterValues) {
    return (parameterValues || [])
        .filter(pv => Array.isArray(pv) && pv.length >= 2 && pv[0])
        .map(pv => ({
            name: 'setParameterValues',
            payload: { parameterValues: [pv] }
        }));
}

function attachWorkflowMeta(taskSpec, workflowMeta) {
    if (!taskSpec || typeof taskSpec !== 'object') return taskSpec;
    const meta = workflowMeta && typeof workflowMeta === 'object' ? workflowMeta : {};
    const next = { ...taskSpec };
    if (next.payload && typeof next.payload === 'object' && !Array.isArray(next.payload)) {
        next.payload = { ...next.payload };
    }

    if (meta.workflowId) {
        next.workflowId = meta.workflowId;
        if (next.payload) next.payload.workflowId = meta.workflowId;
    }
    if (meta.workflowType) {
        next.workflowType = meta.workflowType;
        if (next.payload) next.payload.workflowType = meta.workflowType;
    }
    if (meta.workflowLabel) {
        next.workflowLabel = meta.workflowLabel;
        if (next.payload) next.payload.workflowLabel = meta.workflowLabel;
    }
    if (Array.isArray(next.followup)) {
        next.followup = next.followup.map(item => attachWorkflowMeta(item, meta));
    }
    if (next.payload && Array.isArray(next.payload.followup)) {
        next.payload.followup = next.payload.followup.map(item => attachWorkflowMeta(item, meta));
    }
    return next;
}

function describeAddWanTask(task) {
    const name = String(task?.name || '').trim();
    const payload = task && task.payload && typeof task.payload === 'object' ? task.payload : {};

    if (name === 'addObject') {
        const objectName = String(payload.objectName || payload.object || '');
        if (/WANConnectionDevice\.\{\{wanDeviceInstance\}\}\.(WANPPPConnection|WANIPConnection)/.test(objectName)) {
            return 'Membuat koneksi WAN';
        }
        if (objectName.includes('WANConnectionDevice')) {
            return 'Membuat slot WAN';
        }
    }

    if (name === 'setParameterValues') {
        const firstParam = Array.isArray(payload.parameterValues) && payload.parameterValues[0]
            ? String(payload.parameterValues[0][0] || '')
            : '';
        if (firstParam.includes('DHCPServerEnable')) return 'Mengatur DHCP LAN';
        if (firstParam.includes('WLANConfiguration')) return 'Mengatur Wi-Fi';
        if (/(VLAN|LANBind|SSIDBind)/.test(firstParam)) return 'Mengatur VLAN dan binding';
        if (/(ConnectionType|NATEnabled|Username|Password|Enable)/.test(firstParam)) return 'Mengatur koneksi WAN';
        return 'Menerapkan parameter WAN';
    }

    if (name === 'getParameterValues') return 'Verifikasi hasil provisioning';
    if (name === 'refreshObject') return 'Menyegarkan data perangkat';
    return name || 'Task ACS';
}

function buildBuiltinAddWanWorkflow({
    mode,
    parsedVlan,
    pppoeUser,
    pppoePass,
    dhcp,
    lanPorts,
    wlanSsids,
    configureWifi,
    wifiSsid24,
    wifiPass24,
    wifiSsid5,
    wifiPass5,
    manufacturer,
    wlanConfig,
    workflowMeta
}) {
    const isPppoe = mode === 'pppoe';
    const connectionType = isPppoe ? 'WANPPPConnection' : 'WANIPConnection';
    const lanPortsArray = normalizeSelectionArray(lanPorts);
    const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
    const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.{{wanConnectionInstance}}`;
    const followup = [];

    const baseParamValues = [
        [`${baseConnPath}.Enable`, true, 'xsd:boolean'],
        [`${baseConnPath}.ConnectionType`, isPppoe ? 'IP_Routed' : 'Bridged', 'xsd:string']
    ];

    if (isPppoe) {
        baseParamValues.push(
            [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
            [`${baseConnPath}.Username`, pppoeUser, 'xsd:string'],
            [`${baseConnPath}.Password`, pppoePass, 'xsd:string']
        );
    }

    followup.push(...buildSingleParamTasks(baseParamValues));

    const vendorParamValues = [];
    if (manufacturer.includes('huawei')) {
        vendorParamValues.push(
            [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_HW_WANMode`, isPppoe ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else if (manufacturer.includes('zte')) {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
    }

    followup.push(...buildSingleParamTasks(vendorParamValues));

    followup.push({
        name: 'setParameterValues',
        payload: {
            parameterValues: [[
                'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable',
                toBool(dhcp),
                'xsd:boolean'
            ]]
        }
    });

    const verifyNames = [
        `${baseConnPath}.Enable`,
        `${baseConnPath}.ConnectionType`,
        `${baseConnPath}.ExternalIPAddress`,
        `${baseConnPath}.Uptime`
    ];
    if (isPppoe) {
        verifyNames.push(`${baseConnPath}.Username`, `${baseConnPath}.NATEnabled`);
    }

    const wifiParamValues = [];
    const wlanObj = wlanConfig || {};
    if (toBool(configureWifi)) {
        if (wlanObj['1'] && wifiSsid24) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
            verifyNames.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            if (wifiPass24) {
                wifiParamValues.push(
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', wifiPass24, 'xsd:string'],
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']
                );
            }
        }

        const fiveGIndex = wlanObj['5'] ? '5' : (wlanObj['2'] ? '2' : null);
        if (fiveGIndex && wifiSsid5) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
            verifyNames.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`);
            if (wifiPass5) {
                wifiParamValues.push(
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                );
            }
        }
    }

    followup.push(...buildSingleParamTasks(wifiParamValues));
    followup.push({
        name: 'getParameterValues',
        payload: {
            parameterNames: Array.from(new Set(verifyNames))
        }
    });

    return attachWorkflowMeta({
        name: 'addObject',
        objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
        instanceVariable: 'wanDeviceInstance',
        followup: [{
            name: 'addObject',
            payload: {
                objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}`,
                instanceVariable: 'wanConnectionInstance',
                followup
            }
        }]
    }, workflowMeta);
}

// Helper to get nested value like genieacs.js
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

// Standard paths for RX Power
const RX_POWER_PATHS = [
    'VirtualParameters.RXPower',
    'VirtualParameters.RXpower',
    'VirtualParameters.rx_power',
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
    'Device.XPON.Interface.1.Stats.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANDSLDiagnostics.FECOutput' // some devices
];

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
    return '-';
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
    
    return user || '-';
}

function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || '-';
    if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
        return seconds;
    }
    const totalSecs = parseInt(seconds, 10);
    if (isNaN(totalSecs)) return seconds || '-';
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
    return '-';
}

function formatRxPower(val) {
    if (val === undefined || val === null || val === '-' || val === '') return '-';
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num > 0) {
        const dbVal = 30 + (Math.log10(num * Math.pow(10, -7)) * 10);
        return (Math.ceil(dbVal * 100) / 100).toFixed(2);
    }
    return String(num);
}

function extractRxPower(d) {
    let rxPower = '-';
    for (const path of RX_POWER_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-') {
            rxPower = val;
            break;
        }
    }
    return formatRxPower(rxPower);
}

function extractSsid(d) {
    const SSID_PATHS = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'Device.WiFi.SSID.1.SSID',
        'Device.WiFi.SSID.2.SSID'
    ];
    for (const path of SSID_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') return val;
    }
    return '-';
}

function extractSoftwareVersion(d) {
    const SW_PATHS = [
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SoftwareVersion'
    ];
    for (const path of SW_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') return val;
    }
    return '-';
}

function extractUptime(d) {
    const UPTIME_PATHS = [
        'VirtualParameters.getdeviceuptime',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') {
            if (typeof val === 'string' && (val.includes('d') || val.includes(':')) && isNaN(val)) {
                return val;
            }
            const totalSecs = parseInt(val, 10);
            if (isNaN(totalSecs)) return val;
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
    }
    return '-';
}

// Middleware: Require Admin Session
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.status(403).json({ success: false, message: 'Forbidden' });
};

const requireAdminSession = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
};

function company() { return getSetting('company_header', 'ISP Admin'); }

function requireSidebarMenuAccess(menuKey) {
    return (req, res, next) => {
        const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
        if (access.allowed) return next();

        if (access.reason === 'hidden') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
            return res.redirect('/admin');
        }

        if (access.reason === 'locked') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password.` };
            return res.redirect('/admin/sidebar-settings');
        }

        req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
        return res.redirect('/admin');
    };
}

router.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
    res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
    res.locals.settings = getSettings();
    res.locals.company = company();
    next();
});

router.use(requireAdminSession, requireSidebarMenuAccess('acs_pro'));

async function getLANHosts(deviceId, serverConfig) {
    try {
        const baseUrl = normalizeUrl(serverConfig.url);
        const [hostsResponse, wifiResponse] = await Promise.all([
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.Hosts'
                }
            }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice'
                }
            }).catch(() => ({ data: [] }))
        ]);

        const device = Array.isArray(hostsResponse.data) && hostsResponse.data.length > 0 ? hostsResponse.data[0] : null;
        if (!device) return [];

        const hostsData = device.InternetGatewayDevice?.LANDevice?.['1']?.Hosts;
        if (!hostsData) return [];

        let hostArray = [];
        if (hostsData.Host) {
            if (Array.isArray(hostsData.Host)) {
                hostArray = hostsData.Host;
            } else if (typeof hostsData.Host === 'object') {
                hostArray = Object.values(hostsData.Host).filter(v => v && typeof v === 'object');
            }
        }

        const wifiRssiMap = new Map();
        const wifiDevice = Array.isArray(wifiResponse.data) && wifiResponse.data.length > 0 ? wifiResponse.data[0] : null;
        if (wifiDevice) {
            const wlanConfig = wifiDevice.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
            if (wlanConfig) {
                for (const bandKey of ['1', '5']) {
                    const band = wlanConfig[bandKey];
                    if (!band || !band.AssociatedDevice) continue;

                    let devArray = [];
                    if (Array.isArray(band.AssociatedDevice)) {
                        devArray = band.AssociatedDevice;
                    } else if (typeof band.AssociatedDevice === 'object') {
                        devArray = Object.values(band.AssociatedDevice).filter(v => v && typeof v === 'object');
                    }

                    const bandLabel = bandKey === '5' ? '5GHz' : '2.4GHz';
                    devArray.forEach(dev => {
                        const mac = dev.AssociatedDeviceMACAddress?._value || dev.MACAddress?._value || null;
                        const rssi = dev.X_HW_RSSI?._value || dev.SignalStrength?._value || null;
                        const rate = dev.LastDataTransmitRate?._value || dev.X_HW_TxRate?._value || null;

                        if (mac) {
                            wifiRssiMap.set(mac.toString().toLowerCase(), {
                                rssi: rssi !== null ? parseInt(rssi) : null,
                                rate: rate,
                                band: bandLabel
                            });
                        }
                    });
                }
            }
        }

        return hostArray.map((host, index) => {
            const getHostVal = (key) => {
                const val = host[key];
                if (val && typeof val === 'object' && '_value' in val) return val._value;
                return val;
            };

            const mac = getHostVal('MACAddress') || '-';
            const ip = getHostVal('IPAddress') || '-';
            const hostname = getHostVal('HostName') || 'Unknown';
            const activeRaw = getHostVal('Active');
            const interfaceType = getHostVal('InterfaceType') || '';
            const layer2Interface = getHostVal('Layer2Interface') || '';
            
            let bytesReceived = 0;
            let bytesSent = 0;
            const stats = host['X_HW_Stats'];
            if (stats && typeof stats === 'object') {
                bytesReceived = parseInt(stats.BytesReceived?._value || stats.BytesReceived || 0);
                bytesSent = parseInt(stats.BytesSent?._value || stats.BytesSent || 0);
            }

            const l2Str = layer2Interface.toString().toLowerCase();
            const isWiFi = interfaceType.toString().toLowerCase().includes('802.11') || l2Str.includes('wlan') || l2Str.includes('wifi');
            
            let finalRssi = null;
            let band = l2Str.includes('5') ? '5GHz' : '2.4GHz';
            const macLower = mac.toString().toLowerCase();

            if (isWiFi && wifiRssiMap.has(macLower)) {
                const wifiInfo = wifiRssiMap.get(macLower);
                finalRssi = wifiInfo.rssi;
                band = wifiInfo.band;
            }

            return {
                index: index + 1,
                mac, ip, hostname,
                active: activeRaw === true || activeRaw === 'true' || activeRaw === 1,
                isWiFi, band, rssi: finalRssi,
                bytesReceived, bytesSent
            };
        });
    } catch (err) {
        console.error(`[getLANHosts] Error:`, err.message);
        return [];
    }
}

// ============================================
// DEVICE FETCH HELPERS
// ============================================

async function fetchDevicesFromACS(server, vParams = [], paths = {}, options = {}) {
    const { page = 1, limit = null, activeSessionsMap = null } = options;
    try {
        const baseUrl = normalizeUrl(server.url);
        // Gabungkan proyeksi dasar dengan path pencarian
        let projection = '_id,_lastInform,_ip,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1';
        
        const params = { projection };
        if (limit !== null) {
            params.limit = limit + 1;
            params.skip = (page - 1) * limit;
        }

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params
        });

        if (!Array.isArray(response.data)) return { server, devices: [], hasMore: false };

        const hasMore = limit !== null && response.data.length > limit;
        const devicesData = hasMore ? response.data.slice(0, limit) : response.data;

        const sessionsMap = activeSessionsMap || (await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map()));

        const devices = devicesData.map(d => {
            // Fallback PPPoE
            let pppoeUser = extractPppoeUser(d);

            // Fallback RX Power
            let rxPower = extractRxPower(d);

            // Fallback IP
            let ip = extractPppoeIp(d);

            // Customer Name
            const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') || 
                                getNestedValue(d, 'VirtualParameters.customer_name') || 
                                '-';

            const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                             (pppoeUser && pppoeUser !== '-' && sessionsMap.has(pppoeUser.toLowerCase()));

            return {
                id: d._id,
                sn: d._deviceId?._SerialNumber || d._id,
                last_inform: d._lastInform,
                isOnline: isOnline,
                manufacturer: d._deviceId?._Manufacturer || '-',
                model: d._deviceId?._ProductClass || '-',
                customer_name: customerName,
                rx_power: rxPower,
                pppoe_user: pppoeUser,
                ip: ip,
                acs_server_name: server.name,
                acs_server_id: server.id
            };
        });

        return { server, devices, hasMore };
    } catch (err) {
        console.error(`[fetchDevicesFromACS] Error on ${server.name}:`, err.message);
        return { server, devices: [], hasMore: false, error: err.message };
    }
}

function enrichDevicesWithCustomerNames(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return devices;

    let customers = [];
    try {
        customers = db.prepare(`
            SELECT id, name, genieacs_tag, pppoe_username, hotspot_username, static_ip
            FROM customers
        `).all();
    } catch (e) {
        console.error('[enrichDevicesWithCustomerNames] Error loading customers:', e.message);
        return devices;
    }

    const byTag = new Map();
    const byPppoe = new Map();
    const byHotspot = new Map();
    const byIp = new Map();

    for (const c of customers) {
        if (!c.name) continue;
        const name = String(c.name).trim();
        if (c.genieacs_tag) byTag.set(String(c.genieacs_tag).trim().toLowerCase(), name);
        if (c.pppoe_username) byPppoe.set(String(c.pppoe_username).trim().toLowerCase(), name);
        if (c.hotspot_username) byHotspot.set(String(c.hotspot_username).trim().toLowerCase(), name);
        if (c.static_ip) byIp.set(String(c.static_ip).trim().toLowerCase(), name);
    }

    return devices.map(d => {
        let matchedName = null;

        // 1. PPPoE Username Match
        const pppUser = String(d.pppoe_user || d.pppoeUser || d.pppoeUsername || '').trim().toLowerCase();
        if (pppUser && pppUser !== '-' && pppUser !== 'n/a' && byPppoe.has(pppUser)) {
            matchedName = byPppoe.get(pppUser);
        }

        // 2. Serial Number, Device ID, or Tags Match
        if (!matchedName) {
            const sn = String(d.sn || d.serialNumber || '').trim().toLowerCase();
            const devId = String(d.id || d.phone || '').trim().toLowerCase();
            if (sn && byTag.has(sn)) matchedName = byTag.get(sn);
            else if (devId && byTag.has(devId)) matchedName = byTag.get(devId);
            else if (Array.isArray(d.tags)) {
                for (const t of d.tags) {
                    const tagKey = String(t || '').trim().toLowerCase();
                    if (byTag.has(tagKey)) {
                        matchedName = byTag.get(tagKey);
                        break;
                    }
                }
            }
        }

        // 3. Hotspot Username Match
        if (!matchedName && pppUser && byHotspot.has(pppUser)) {
            matchedName = byHotspot.get(pppUser);
        }

        // 4. IP Address Match
        if (!matchedName) {
            const ip = String(d.ip || d.pppoe_ip || d.pppoeIP || '').trim().toLowerCase();
            if (ip && ip !== '-' && byIp.has(ip)) {
                matchedName = byIp.get(ip);
            }
        }

        const finalName = matchedName || (d.customer_name && d.customer_name !== '-' ? d.customer_name : (d.customerName && d.customerName !== '-' ? d.customerName : '-'));

        return {
            ...d,
            customer_name: finalName,
            customerName: finalName
        };
    });
}

// ============================================
// ROUTES
// ============================================

router.get('/', async (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim() || null;
        const acsServers = getACSServers();
        const legacyACS = getLegacyACS();
        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());
        
        const activeServers = acsServers.length > 0 ? acsServers :
            (legacyACS.acs_url ? [{ id: 'legacy', name: 'Default ACS', url: legacyACS.acs_url, username: legacyACS.acs_user, password: legacyACS.acs_pass }] : []);

        const selectedAcsId = req.query.acs || (activeServers[0]?.id);
        const targetServers = selectedAcsId && selectedAcsId !== 'all' ? activeServers.filter(s => String(s.id) === String(selectedAcsId)) : activeServers;

        let allDevices = [];
        if (targetServers.length > 0) {
            if (searchQuery) {
                // Search mode: query devices with search filter
                const query = JSON.stringify({
                    $or: [
                        { '_deviceId._SerialNumber': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.CustomerName': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.customer_name': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.PPPoEUser': { $regex: searchQuery, $options: 'i' } },
                        { '_tags': searchQuery }
                    ]
                });
                
                for (const server of targetServers) {
                    try {
                        const baseUrl = normalizeUrl(server.url);
                        const response = await axios.get(`${baseUrl}/devices`, {
                            ...getAxiosConfig(server),
                            params: { query }
                        });
                        
                        if (Array.isArray(response.data)) {
                            const devices = response.data.map(d => {
                                 let rxPower = extractRxPower(d);
                                
                                let pppoeUser = extractPppoeUser(d);
                                
                                let ip = extractPppoeIp(d);
                                
                                const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') ||
                                                    getNestedValue(d, 'VirtualParameters.customer_name') || '-';
                                
                                const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                                                 (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));
                                
                                return {
                                    id: d._id,
                                    sn: d._deviceId?._SerialNumber || d._id,
                                    last_inform: d._lastInform,
                                    isOnline: isOnline,
                                    manufacturer: d._deviceId?._Manufacturer || '-',
                                    model: d._deviceId?._ProductClass || '-',
                                    rx_power: rxPower,
                                    pppoe_ip: ip,
                                    pppoe_user: pppoeUser,
                                    customer_name: customerName,
                                    acs_server_id: server.id,
                                    acs_server_name: server.name
                                };
                            });
                            allDevices = allDevices.concat(devices);
                        }
                    } catch (err) {
                        console.error(`Search error on server ${server.name}:`, err.message);
                    }
                }
            } else {
                // Normal mode: fetch all devices
                const results = await Promise.allSettled(targetServers.map(s => fetchDevicesFromACS(s, [], legacyACS, { activeSessionsMap })));
                results.forEach(r => { if (r.status === 'fulfilled') allDevices = allDevices.concat(r.value.devices); });
            }
        }

        // Enrich devices with matching customer names from Billing DB
        allDevices = enrichDevicesWithCustomerNames(allDevices);

        if (searchQuery) {
            const qLower = searchQuery.toLowerCase();
            allDevices = allDevices.filter(d => 
                String(d.sn || '').toLowerCase().includes(qLower) ||
                String(d.id || '').toLowerCase().includes(qLower) ||
                String(d.customer_name || '').toLowerCase().includes(qLower) ||
                String(d.pppoe_user || '').toLowerCase().includes(qLower) ||
                String(d.ip || d.pppoe_ip || '').toLowerCase().includes(qLower)
            );
        }

        let pppoeProfiles = [];
        try {
            // Get routerId dari query parameter jika ada (untuk multi-router support)
            const selectedRouterId = req.query.router_id ? Number(req.query.router_id) : null;
            pppoeProfiles = await mikrotikSvc.getPppoeProfiles(selectedRouterId);
        } catch (e) {
            console.error('Failed to load PPPoE profiles from MikroTik:', e.message);
        }

        res.render('admin/acs', {
            user: req.session,
            devices: allDevices,
            acsServers: activeServers,
            selectedAcsId,
            searchQuery,
            pppoeProfiles,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        console.error('ACS page error:', err);
        res.render('admin/acs', { user: req.session, devices: [], acsServers: [], selectedAcsId: null, searchQuery: null, pppoeProfiles: [], currentPage: 'acs_pro' });
    }
});

router.get('/search', async (req, res, next) => {
    req.url = '/';
    return router.handle(req, res, next);
});

router.get('/device/:deviceId', async (req, res) => {
    try {
        const acsId = String(req.query.acsId || req.query.acs || '').trim() || null;
        const deviceToken = String(req.params.deviceId || '');

        const legacyData = await customerDevice.getCustomerDeviceData(deviceToken);
        if (legacyData && legacyData.phone) {
            const isOnline = String(legacyData.status || '').toLowerCase() === 'online';
            const clients = Array.isArray(legacyData.connectedUsers) ? legacyData.connectedUsers : [];
            return res.render('admin/acs_device', {
                user: req.session,
                device: legacyData,
                clients,
                isOnline,
                acsId: acsId || 'legacy',
                acsName: 'Default ACS',
                currentPage: 'acs_pro'
            });
        }

        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).send('ACS Server not found');

        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = deviceToken;

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_lastInform,_deviceId,_registered,_ip,_tags,_events,VirtualParameters,InternetGatewayDevice'
            }
        });

        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).send('Device not found');

        let pppoeUser = extractPppoeUser(deviceData);
        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());

        const lastInform = deviceData._lastInform;
        const isOnline = (lastInform && (Date.now() - new Date(lastInform).getTime() < 900000)) ||
                         (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));

        // Fallbacks for detail page using the same logic as listing
        let rxPower = extractRxPower(deviceData);

        const customerName = getNestedValue(deviceData, 'VirtualParameters.CustomerName') || 
                            getNestedValue(deviceData, 'VirtualParameters.customer_name') || 
                            '-';

        let ip = extractPppoeIp(deviceData);

        const rawClients = await getLANHosts(deviceData._id, server);
        const clients = (Array.isArray(rawClients) ? rawClients : []).map((c) => ({
            hostname: c.hostname || 'Unknown',
            ip: c.ip || '-',
            mac: c.mac || '-',
            iface: c.isWiFi ? `WiFi ${c.band || ''}`.trim() : 'LAN',
            status: c.active ? 'Online' : 'Offline',
            rssi: typeof c.rssi === 'number' ? c.rssi : null
        }));

        res.render('admin/acs_device', {
            user: req.session,
            device: {
                phone: deviceData._id,
                serialNumber: deviceData._deviceId?._SerialNumber || deviceData._id,
                model: deviceData._deviceId?._ProductClass || '-',
                softwareVersion: extractSoftwareVersion(deviceData),
                status: isOnline ? 'Online' : 'Offline',
                lastInform: lastInform || null,
                rxPower: rxPower,
                pppoeIP: ip,
                pppoeUsername: pppoeUser,
                pppoeUptime: extractPppoeUptime(deviceData),
                ssid: extractSsid(deviceData),
                uptime: extractUptime(deviceData)
            },
            clients,
            isOnline,
            acsId: server.id,
            acsName: server.name,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /admin/acs/api/servers
router.post('/api/servers', requireAdmin, async (req, res) => {
    const { name, url, username, password, location } = req.body;
    try {
        db.prepare(
            'INSERT INTO genieacs_servers (name, url, username, password, location) VALUES (?, ?, ?, ?, ?)'
        ).run(name, url, username || null, password || null, location || '');
        res.json({ success: true, message: 'ACS server added' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/legacy (Default ACS)
router.put('/api/servers/legacy', requireAdmin, express.json(), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        if (!url) return res.status(400).json({ success: false, message: 'URL wajib diisi' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'URL harus diawali http:// atau https://' });

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);
        const usernameInput = String(req.body?.username || '').trim();
        const passwordInput = String(req.body?.password || '');

        const currentSettings = getSettings();
        currentSettings.genieacs_url = url;

        if (clearUsername) currentSettings.genieacs_username = '';
        else if (usernameInput) currentSettings.genieacs_username = usernameInput;

        if (clearPassword) currentSettings.genieacs_password = '';
        else if (String(passwordInput || '').trim()) currentSettings.genieacs_password = String(passwordInput || '');

        const settingsPath = path.join(__dirname, '../settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

        res.json({ success: true, message: 'Default ACS berhasil diperbarui.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/:id
router.put('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ success: false, message: 'Invalid server id' });

        const name = String(req.body?.name || '').trim();
        const url = String(req.body?.url || '').trim();
        if (!name || !url) return res.status(400).json({ success: false, message: 'Name and URL are required' });

        const existing = db.prepare('SELECT id, password FROM genieacs_servers WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ success: false, message: 'ACS server not found' });

        const usernameRaw = req.body?.username;
        const passwordRaw = req.body?.password;
        const location = String(req.body?.location || '');

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);

        const username = clearUsername ? null : (String(usernameRaw || '').trim() || null);

        let password = existing.password || null;
        if (clearPassword) password = null;
        else if (String(passwordRaw || '').trim()) password = String(passwordRaw || '');

        db.prepare(
            'UPDATE genieacs_servers SET name = ?, url = ?, username = ?, password = ?, location = ? WHERE id = ?'
        ).run(name, url, username, password, location, id);

        res.json({ success: true, message: 'ACS server updated' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/servers/:id
router.delete('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        db.prepare('DELETE FROM genieacs_servers WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'ACS server deleted' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/device/:deviceId
router.delete('/api/device/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.delete(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(server)
        );
        res.json({ success: true, message: 'Device deleted' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/remote-enable/:deviceId
router.post('/api/remote-enable/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { 
                name: 'setParameterValues',
                parameterValues: [['InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable', true, 'xsd:boolean']]
            },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Remote WAN enabled' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/reboot/:deviceId
router.post('/api/reboot/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'reboot' },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Reboot command sent' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/refresh/:deviceId
router.post('/api/refresh/:deviceId', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const result = await customerDevice.requestRefresh(deviceId, {
            type: 'admin',
            id: req.session?.adminId || null,
            name: req.session?.username || req.session?.name || 'Admin',
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });
        res.json({ success: !!result.ok, message: result.message });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/refresh
router.post('/api/bulk/refresh', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const result = await customerDevice.requestRefresh(deviceId, {
                type: 'admin',
                id: req.session?.adminId || null,
                name: req.session?.username || req.session?.name || 'Admin',
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            return { id: deviceId, success: !!result.ok, message: result.message };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil mengirim perintah summon untuk ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/delete
router.post('/api/bulk/delete', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const acsId = String(d.acsId || '');
            const servers = getACSServers(acsId);
            if (servers.length === 0) return { id: deviceId, success: false, message: 'ACS tidak ditemukan' };
            const server = servers[0];
            const baseUrl = normalizeUrl(server.url);
            
            await axios.delete(
                `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
                getAxiosConfig(server)
            );
            return { id: deviceId, success: true };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil menghapus ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// POST /admin/acs/api/sync/all
router.post('/api/sync/all', requireAdmin, async (req, res) => {
    try {
        const servers = getACSServers();
        if (servers.length === 0) return res.json({ success: true, message: 'No servers to sync' });
        
        let total = 0;
        for (const s of servers) {
            const result = await fetchDevicesFromACS(s, [], {});
            total += result.devices.length;
            if (s.id !== 'builtin' && s.id !== 'legacy') {
                db.prepare('UPDATE genieacs_servers SET device_count = ?, last_sync = (NOW_LOCAL()) WHERE id = ?').run(result.devices.length, s.id);
            }
        }
        res.json({ success: true, message: `Sync complete. Total ${total} devices.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /api/clients/:deviceId
router.get('/api/clients/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false });

        const hosts = await getLANHosts(String(deviceId || ''), servers[0]);
        res.json({ success: true, data: hosts });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /admin/acs/api/wifi-settings/:deviceId
router.get('/api/wifi-settings/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).json({ success: false, message: 'ACS Server not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        
        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).json({ success: false, message: 'Device not found' });
        
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        
        // Return all SSID indices (1 to 8) that exist on the ONU
        for (let i = 1; i <= 8; i++) {
            if (wlanConfig[String(i)]) {
                bands.push({
                    index: String(i),
                    ssid: getNestedValue(wlanConfig[String(i)], 'SSID') || `SSID ${i}`,
                    name: i <= 4 ? `Wi-Fi 2.4GHz (SSID ${i})` : `Wi-Fi 5GHz (SSID ${i})`
                });
            }
        }
        
        res.json({ success: true, bands });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/add-wan-status/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const workflowId = String(req.query.workflowId || '').trim();
        const rootTaskId = parseInt(req.query.rootTaskId, 10);

        if (!workflowId && !Number.isFinite(rootTaskId)) {
            return res.status(400).json({ success: false, message: 'workflowId atau rootTaskId wajib diisi' });
        }

        let rows = [];
        if (workflowId) {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND payload LIKE ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, `%"workflowId":"${workflowId}"%`);
        } else {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND id >= ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, rootTaskId);
        }

        const tasks = rows.map(row => {
            let payload = {};
            try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
            return {
                id: Number(row.id),
                name: String(row.name || ''),
                status: String(row.status || 'pending'),
                updatedAt: row.updated_at || null,
                label: describeAddWanTask({ name: row.name, payload }),
                payload
            };
        });

        const total = tasks.length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const completed = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const done = total > 0 && pending === 0 && inProgress === 0;
        const summary = failed > 0
            ? `Ada ${failed} task yang gagal dari ${total} task workflow.`
            : done
                ? `Workflow selesai. ${completed}/${total} task selesai.`
                : `Workflow berjalan. ${completed}/${total} task selesai.`;

        return res.json({
            success: true,
            supported: true,
            workflowId: workflowId || null,
            rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null,
            totals: { total, pending, inProgress, completed, failed },
            done,
            hasFailure: failed > 0,
            summary,
            tasks: tasks.map(t => ({
                id: t.id,
                name: t.name,
                status: t.status,
                label: t.label,
                updatedAt: t.updatedAt
            }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /admin/acs/api/add-wan/:deviceId
router.post('/api/add-wan/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const {
            acsId,
            mode,
            vlanId,
            pppoeUser,
            pppoePass,
            pppoeProfile,
            autoCreateMikrotik,
            lanPorts,
            wlanSsids,
            configureWifi,
            wifiSsid24,
            wifiPass24,
            wifiSsid5,
            wifiPass5,
            dhcp
        } = req.body;
        
        // 1. Validasi awal
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['pppoe', 'bridge'].includes(normalizedMode)) {
            return res.json({ success: false, message: 'Mode WAN tidak valid' });
        }

        const parsedVlan = parseInt(vlanId, 10);
        if (isNaN(parsedVlan) || parsedVlan < 1 || parsedVlan > 4094) {
            return res.json({ success: false, message: 'VLAN ID tidak valid (harus 1-4094)' });
        }
        
        const trimmedPppoeUser = String(pppoeUser || '').trim();
        const trimmedPppoePass = String(pppoePass || '').trim();
        if (normalizedMode === 'pppoe' && (!trimmedPppoeUser || !trimmedPppoePass)) {
            return res.json({ success: false, message: 'Username dan password PPPoE wajib diisi untuk mode PPPoE' });
        }
        
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS Server tidak ditemukan' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const config = getAxiosConfig(server);
        
        // 2. Jika Auto-create MikroTik diaktifkan
        if (normalizedMode === 'pppoe' && toBool(autoCreateMikrotik)) {
            try {
                await mikrotikSvc.createPppoeSecret({
                    username: trimmedPppoeUser,
                    password: trimmedPppoePass,
                    profile: pppoeProfile || 'default'
                });
            } catch (mErr) {
                console.error('[AddWAN] Failed to create PPPoE Secret in MikroTik:', mErr.message);
                return res.json({ success: false, message: `Gagal membuat akun PPPoE di MikroTik: ${mErr.message}` });
            }
        }
        
        // 3. Ambil data instansi WANConnectionDevice saat ini untuk menghitung nextInstance
        const getDeviceRes = await axios.get(`${baseUrl}/devices`, {
            ...config,
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_deviceId.Manufacturer,_deviceId._Manufacturer,InternetGatewayDevice.WANDevice.1.WANConnectionDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(getDeviceRes.data) && getDeviceRes.data.length > 0 ? getDeviceRes.data[0] : null;
        if (!deviceData) return res.json({ success: false, message: 'CPE/Device tidak ditemukan di GenieACS' });
        
        const manufacturer = (deviceData._deviceId?._Manufacturer || deviceData._deviceId?.Manufacturer || '').toLowerCase();
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const isBuiltinServer = String(server.id || '').trim() === 'builtin' || baseUrl === 'local';

        if (isBuiltinServer) {
            const workflowId = `addwan:${deviceId}:${Date.now()}`;
            const task = buildBuiltinAddWanWorkflow({
                mode: normalizedMode,
                parsedVlan,
                pppoeUser: trimmedPppoeUser,
                pppoePass: trimmedPppoePass,
                dhcp,
                lanPorts,
                wlanSsids,
                configureWifi,
                wifiSsid24,
                wifiPass24,
                wifiSsid5,
                wifiPass5,
                manufacturer,
                wlanConfig,
                workflowMeta: {
                    workflowId,
                    workflowType: 'add_wan',
                    workflowLabel: 'Add WAN'
                }
            });

            const taskRes = await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, task, config);
            const rootTaskId = parseInt(taskRes?.data?._id, 10);
            return res.json({
                success: true,
                message: 'Workflow Add WAN built-in berhasil dikirim. Progress akan dimonitor otomatis.',
                trackingSupported: true,
                workflowId,
                rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null
            });
        }

        const wanConnObj = deviceData.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
        const existingKeys = Object.keys(wanConnObj).map(Number).filter(n => !isNaN(n));
        const nextInstance = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 2;

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
        }, config);

        const connectionType = normalizedMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection';
        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.`
        }, config);

        const paramValues = [];
        const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.1`;
        paramValues.push([`${baseConnPath}.Enable`, true, 'xsd:boolean']);

        if (normalizedMode === 'pppoe') {
            paramValues.push(
                [`${baseConnPath}.ConnectionType`, 'IP_Routed', 'xsd:string'],
                [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
                [`${baseConnPath}.Username`, trimmedPppoeUser, 'xsd:string'],
                [`${baseConnPath}.Password`, trimmedPppoePass, 'xsd:string']
            );
        } else {
            paramValues.push([`${baseConnPath}.ConnectionType`, 'Bridged', 'xsd:string']);
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: [[`InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable`, toBool(dhcp), 'xsd:boolean']]
        }, config).catch(() => {});

        const lanPortsArray = normalizeSelectionArray(lanPorts);
        const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
        if (manufacturer.includes('huawei')) {
            paramValues.push(
                [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
                [`${baseConnPath}.X_HW_WANMode`, normalizedMode === 'pppoe' ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else if (manufacturer.includes('zte')) {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
        }

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: paramValues
        }, config);

        if (toBool(configureWifi)) {
            const wifiParamValues = [];
            if (wlanConfig['1'] && wifiSsid24) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
                if (wifiPass24) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey`, wifiPass24, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase`, wifiPass24, 'xsd:string']
                    );
                }
            }

            const fiveGIndex = wlanConfig['5'] ? '5' : (wlanConfig['2'] ? '2' : null);
            if (fiveGIndex && wifiSsid5) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
                if (wifiPass5) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }

            if (wifiParamValues.length > 0) {
                await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                    name: 'setParameterValues',
                    parameterValues: wifiParamValues
                }, config);
            }
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'refreshObject',
            objectName: ''
        }, config).catch(() => {});
        
        res.json({
            success: true,
            message: 'Semua antrean tugas Add WAN (dan Wi-Fi) berhasil dikirimkan ke GenieACS.',
            trackingSupported: false
        });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// GET /admin/acs/search - Redirect to main page with query params
router.get('/search', requireAdminSession, async (req, res) => {
    const { q, acs } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (acs) params.append('acs', acs);
    res.redirect(`/admin/acs?${params.toString()}`);
});

module.exports = router;
