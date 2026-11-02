// genieacs-commands.js - Module for handling GenieACS commands via WhatsApp
const { logger } = require('./logger');
const genieacsApi = require('./genieacs');
// const responses = require('./responses');

// Store the WhatsApp socket instance
let sock = null;

// Set the WhatsApp socket instance
function setSock(sockInstance) {
    sock = sockInstance;
    logger.info('WhatsApp socket set in genieacs-commands module');
}

// Helper functions for device status and parameters
function getDeviceStatus(lastInform) {
    if (!lastInform) return false;
    const now = Date.now();
    const lastInformTime = new Date(lastInform).getTime();
    const timeDiff = now - lastInformTime;
    // Consider device online if last inform was within 5 minutes
    return timeDiff < 5 * 60 * 1000;
}

function formatUptime(uptimeValue) {
    if (!uptimeValue || uptimeValue === 'N/A') return 'N/A';

    // If already formatted (like "5d 04:50:18"), return as is
    if (typeof uptimeValue === 'string' && uptimeValue.includes('d ')) {
        return uptimeValue;
    }

    // If it's seconds, convert to formatted string
    if (!isNaN(uptimeValue)) {
        const seconds = parseInt(uptimeValue);
        const days = Math.floor(seconds / (24 * 3600));
        const hours = Math.floor((seconds % (24 * 3600)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        let result = '';
        if (days > 0) result += `${days}d `;
        if (hours > 0) result += `${hours}h `;
        if (minutes > 0) result += `${minutes}m `;
        if (secs > 0) result += `${secs}s`;

        return result.trim() || '0s';
    }

    return uptimeValue;
}

function getParameterWithPaths(device, paths) {
    if (!device || !paths || !Array.isArray(paths)) return 'N/A';

    for (const path of paths) {
        try {
            const value = getParameterValue(device, path);
            if (value && value !== 'N/A') {
                return value;
            }
        } catch (error) {
            // Continue to next path
        }
    }
    return 'N/A';
}

function getParameterValue(device, path) {
    if (!device || !path) return 'N/A';

    try {
        const pathParts = path.split('.');
        let current = device;

        for (const part of pathParts) {
            if (current && typeof current === 'object') {
                current = current[part];
            } else {
                return 'N/A';
            }
        }

        // Handle GenieACS parameter format
        if (current && typeof current === 'object' && current._value !== undefined) {
            return current._value;
        }

        // Handle direct value
        if (current !== null && current !== undefined && current !== '') {
            return current;
        }

        return 'N/A';
    } catch (error) {
        logger.debug(`Error getting parameter ${path}: ${error.message}`);
        return 'N/A';
    }
}

// Helper untuk format RX Power (dBm) sesuai standar TR-069 & CTC EPON 0.1 uW
function formatRxPower(val) {
    if (val === undefined || val === null || val === '-' || val === '' || val === 'N/A') return 'N/A';
    const raw = parseFloat(val);
    if (isNaN(raw)) return String(val);
    if (raw === 0 || raw >= 65535) return 'LOS';
    if (raw < 0 && raw > -50) return raw.toFixed(2);
    if (raw <= -50) return (raw / 100).toFixed(2);
    if (raw > 0) {
        const dbm = 30 + (Math.log10(raw * 1e-7) * 10);
        return (Math.round(dbm * 100) / 100).toFixed(2);
    }
    return String(raw);
}

// Parameter paths for different device parameters (updated with confirmed VirtualParameters)
const parameterPaths = {
    rxPower: [
        'VirtualParameters.RXPower',                    // ✅ CONFIRMED: -19.74
        'VirtualParameters.redaman',
        'VirtualParameters.rx_power',
        'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_ALU-COM_RxPower',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.RxPower',
        'Device.Optical.Interface.1.RxPower',
        'Device.Optical.Interface.1.OpticalSignalLevel'
    ],
    pppoeIP: [
        'VirtualParameters.pppoeIP',                    // ✅ CONFIRMED: 192.168.10.159
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
        'Device.PPP.Interface.1.IPCPExtensions.RemoteIPAddress'
    ],
    pppUsername: [
        'VirtualParameters.pppoeUsername',              // ✅ CONFIRMED: leha
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        'Device.PPP.Interface.1.Username'
    ],
    uptime: [
        'VirtualParameters.getdeviceuptime',            // ✅ CONFIRMED: 5d 04:50:18
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'Device.DeviceInfo.UpTime'
    ],
    firmware: [
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SoftwareVersion'
    ],
    userConnected: [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',  // ✅ SSID 1 (2.4GHz) only
        'VirtualParameters.activedevices',              // ✅ Fallback if needed
        'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries'
    ],
    temperature: [
        'VirtualParameters.gettemp',                    // ✅ CONFIRMED: 48
        'InternetGatewayDevice.DeviceInfo.TemperatureStatus.TemperatureValue',
        'Device.DeviceInfo.TemperatureStatus.TemperatureValue'
    ],
    // Additional VirtualParameters yang tersedia
    serialNumber: [
        'VirtualParameters.getSerialNumber',            // ✅ AVAILABLE: CIOT12E8C8B8
        'InternetGatewayDevice.DeviceInfo.SerialNumber'
    ],
    ponMode: [
        'VirtualParameters.getponmode'                  // ✅ AVAILABLE: EPON
    ],
    pppUptime: [
        'VirtualParameters.getpppuptime'                // ✅ AVAILABLE: 0d 08:46:43
    ],
    ponMac: [
        'VirtualParameters.PonMac',                     // ✅ AVAILABLE (but might be empty)
        'VirtualParameters.ponMac',                     // Alternative lowercase
        'VirtualParameters.MacAddress',                 // Alternative name
        'VirtualParameters.deviceMac',                  // Alternative name
        'VirtualParameters.ontMac',                     // Alternative name
        'InternetGatewayDevice.DeviceInfo.X_ALU-COM_MACAddress',
        'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress'
    ],
    wlanPassword: [
        'VirtualParameters.WlanPassword'                // ✅ AVAILABLE
    ]
};

// Menggunakan format pesan dari responses.js
function formatResponse(message) {
    return message; // Tidak pakai header/footer lagi
}

// Get device by phone number
async function getDeviceByNumber(phoneNumber) {
    try {
        return await genieacsApi.findDeviceByPhoneNumber(phoneNumber);
    } catch (error) {
        logger.error(`Error finding device with phone number ${phoneNumber}: ${error.message}`);
        return null;
    }
}

// Handler for WiFi info command
async function handleWifiInfo(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }
        
        // Get SSID information
        const ssid = getSSIDValue(device, '1') || 'N/A';
        const ssid5G = getSSIDValue(device, '5') || 'N/A';
        
        // Send WiFi information
        const wifiInfo = `📱 *INFORMASI WI-FI*\n\n`;
        wifiInfo += `• SSID 2.4G: ${ssid}\n`;
        wifiInfo += `• SSID 5G: ${ssid5G}\n`;
        
        await sock.sendMessage(remoteJid, {
            text: formatResponse(wifiInfo)
        });
    } catch (error) {
        logger.error(`Error handling WiFi info: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mengambil informasi WiFi.')
        });
    }
}

// Handler for change WiFi SSID command
async function handleChangeWifiSSID(remoteJid, senderNumber, newSSID) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        if (!newSSID || newSSID.length < 3 || newSSID.length > 32) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Format SSID tidak valid. SSID harus antara 3-32 karakter.')
            });
            return;
        }
        
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }
        
        // Send processing message
        await sock.sendMessage(remoteJid, { 
            text: formatResponse(`Sedang mengubah SSID perangkat ke "${newSSID}"...`)
        });
        
        // Set SSID parameter value (pass server ID from device)
        await genieacsApi.setParameterValues(device._id, {
            'SSID': newSSID
        }, device._acs_server_id);
        
        // Send success message
        await sock.sendMessage(remoteJid, { 
            text: formatResponse(`SSID berhasil diubah ke "${newSSID}".`)
        });
        
    } catch (error) {
        logger.error(`Error changing WiFi SSID: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mengubah SSID.')
        });
    }
}

// Handler for change WiFi password command
async function handleChangeWifiPassword(remoteJid, senderNumber, newPassword) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        if (!newPassword || newPassword.length < 8 || newPassword.length > 63) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Format password tidak valid. Password harus antara 8-63 karakter.')
            });
            return;
        }
        
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }
        
        // Send processing message
        await sock.sendMessage(remoteJid, { 
            text: formatResponse('Sedang mengubah password WiFi...')
        });
        
        // Set password parameter value (pass server ID from device)
        await genieacsApi.setParameterValues(device._id, {
            'KeyPassphrase': newPassword
        }, device._acs_server_id);
        
        // Send success message
        await sock.sendMessage(remoteJid, { 
            text: formatResponse('Password WiFi berhasil diubah.')
        });
        
    } catch (error) {
        logger.error(`Error changing WiFi password: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mengubah password WiFi.')
        });
    }
}

// Handler for device status command
async function handleDeviceStatus(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }
        
        // Get device status information
        const lastInform = device._lastInform;
        const isOnline = getDeviceStatus(lastInform);
        const serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 'N/A';
        const firmware = getParameterWithPaths(device, parameterPaths.firmware) || 'N/A';
        const uptime = formatUptime(getParameterWithPaths(device, parameterPaths.uptime)) || 'N/A';
        const rxPower = formatRxPower(getParameterWithPaths(device, parameterPaths.rxPower));
        const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP) || 'N/A';
        const pppUsername = getParameterWithPaths(device, parameterPaths.pppUsername) || 'N/A';
        const ssid = getSSIDValue(device, '1') || 'N/A';
        const ssid5G = getSSIDValue(device, '5') || 'N/A';
        const connectedUsers = getParameterWithPaths(device, parameterPaths.userConnected) || '0';
        
        // Format device status
        const statusMessage = `📱 *STATUS PERANGKAT*\n\n`;
        statusMessage += `• Status Online: ${isOnline ? '🟢 Online' : '🔴 Offline'}\n`;
        statusMessage += `• Serial Number: ${serialNumber}\n`;
        statusMessage += `• Firmware: ${firmware}\n`;
        statusMessage += `• Uptime: ${uptime}\n`;
        statusMessage += `• RX Power: ${rxPower} dBm\n`;
        statusMessage += `• PPPoE IP: ${pppoeIP}\n`;
        statusMessage += `• PPP Username: ${pppUsername}\n`;
        statusMessage += `• SSID 2.4G: ${ssid}\n`;
        statusMessage += `• SSID 5G: ${ssid5G}\n`;
        statusMessage += `• Pengguna Terhubung: ${connectedUsers}\n`;
        statusMessage += `• Last Inform: ${new Date(lastInform).toLocaleString()}\n`;
        
        await sock.sendMessage(remoteJid, { 
            text: formatResponse(statusMessage)
        });
        
    } catch (error) {
        logger.error(`Error handling device status: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mengambil status perangkat.')
        });
    }
}

// Handler for restart device command
async function handleRestartDevice(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);
        
        if (!device) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }
        
        // Send confirmation message
        await sock.sendMessage(remoteJid, { 
            text: formatResponse('Apakah Anda yakin ingin merestart perangkat ini? (ketik "confirm restart" untuk melanjutkan)')
        });
        
        // Save restart confirmation status
        global.pendingRestarts = global.pendingRestarts || {};
        global.pendingRestarts[senderNumber] = {
            deviceId: device._id,
            timestamp: Date.now()
        };
        
    } catch (error) {
        logger.error(`Error preparing device restart: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mempersiapkan restart perangkat.')
        });
    }
}

// Handler for restart confirmation
async function handleRestartConfirmation(remoteJid, senderNumber, confirmed) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        if (!global.pendingRestarts || !global.pendingRestarts[senderNumber]) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Tidak ada permintaan restart yang pending.')
            });
            return;
        }
        
        const { deviceId, timestamp } = global.pendingRestarts[senderNumber];
        
        // Check if confirmation is still valid (within 5 minutes)
        if (Date.now() - timestamp > 5 * 60 * 1000) {
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Permintaan restart sudah kadaluarsa.')
            });
            delete global.pendingRestarts[senderNumber];
            return;
        }
        
        if (confirmed) {
            // Send processing message
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Sedang merestart perangkat...')
            });
            
            // Restart device (pass server ID from pending restart)
            const device = await genieacsApi.getDevice(deviceId);
            await genieacsApi.reboot(deviceId, device._acs_server_id);
            
            // Send success message
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Perangkat berhasil direstart.')
            });
        } else {
            // Send cancellation message
            await sock.sendMessage(remoteJid, { 
                text: formatResponse('Restart perangkat dibatalkan.')
            });
        }
        
        // Delete restart confirmation status
        delete global.pendingRestarts[senderNumber];
        
    } catch (error) {
        logger.error(`Error handling restart confirmation: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse('Terjadi kesalahan saat mengkonfirmasi restart.')
        });
        
        // Delete restart confirmation status even if error
        if (global.pendingRestarts && global.pendingRestarts[senderNumber]) {
            delete global.pendingRestarts[senderNumber];
        }
    }
}

// Helper function to get SSID value
function getSSIDValue(device, configIndex) {
    try {
        // Try method 1: Using bracket notation for WLANConfiguration
        if (device.InternetGatewayDevice && 
            device.InternetGatewayDevice.LANDevice && 
            device.InternetGatewayDevice.LANDevice['1'] && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex] && 
            device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex].SSID) {
            
            const ssidObj = device.InternetGatewayDevice.LANDevice['1'].WLANConfiguration[configIndex].SSID;
            if (ssidObj._value !== undefined) {
                return ssidObj._value;
            }
        }
        
        // Try method 2: Using getParameterWithPaths
        const ssidPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${configIndex}.SSID`;
        const ssidValue = getParameterWithPaths(device, [ssidPath]);
        if (ssidValue && ssidValue !== 'N/A') {
            return ssidValue;
        }
        
        // Try method 3: Search in entire object
        for (const key in device) {
            if (device[key]?.LANDevice?.['1']?.WLANConfiguration?.[configIndex]?.SSID?._value) {
                return device[key].LANDevice['1'].WLANConfiguration[configIndex].SSID._value;
            }
        }
        
        // Try method 4: Check in virtual parameters
        if (device.VirtualParameters?.SSID?._value) {
            return device.VirtualParameters.SSID._value;
        }
        
        // Index 5 is 5GHz. Do NOT fallback to index 2 (2.4GHz SSID 2).
        
        return 'N/A';
    } catch (error) {
        logger.error(`Error getting SSID for config ${configIndex}: ${error.message}`);
        return 'N/A';
    }
}

// Handler untuk factory reset perangkat
async function handleFactoryReset(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }

        // Send confirmation message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`⚠️ *PERINGATAN FACTORY RESET*\n\nAnda akan melakukan factory reset pada perangkat Anda.\nSemua pengaturan akan kembali ke default pabrik.\n\nKetik "confirm factory reset" untuk melanjutkan.`)
        });

        // Save factory reset confirmation status
        global.pendingFactoryResets = global.pendingFactoryResets || {};
        global.pendingFactoryResets[senderNumber] = {
            deviceId: device._id,
            timestamp: Date.now()
        };

    } catch (error) {
        logger.error(`Error preparing factory reset: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk konfirmasi factory reset
async function handleFactoryResetConfirmation(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        if (!global.pendingFactoryResets || !global.pendingFactoryResets[senderNumber]) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Tidak ada permintaan factory reset yang pending.`)
            });
            return;
        }

        const { deviceId, timestamp } = global.pendingFactoryResets[senderNumber];

        // Check if confirmation is still valid (within 5 minutes)
        if (Date.now() - timestamp > 5 * 60 * 1000) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Permintaan factory reset sudah expired. Silakan ulangi.`)
            });
            delete global.pendingFactoryResets[senderNumber];
            return;
        }

        // Send processing message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`🔄 Melakukan factory reset perangkat...\nMohon tunggu beberapa menit.`)
        });

        // Factory reset device (pass server ID)
        const device = await genieacsApi.getDevice(deviceId);
        await genieacsApi.factoryReset(deviceId, device._acs_server_id);

        // Send success message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`✅ Factory reset berhasil dilakukan.\nPerangkat akan restart dan kembali ke pengaturan default pabrik.`)
        });

        // Delete factory reset confirmation status
        delete global.pendingFactoryResets[senderNumber];

    } catch (error) {
        logger.error(`Error handling factory reset confirmation: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });

        // Delete factory reset confirmation status even if error
        if (global.pendingFactoryResets && global.pendingFactoryResets[senderNumber]) {
            delete global.pendingFactoryResets[senderNumber];
        }
    }
}

// Handler untuk melihat perangkat yang terhubung ke WiFi
async function handleConnectedDevices(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }

        // Get connected devices information
        // Get number of connected users
        const connectedUsers = getParameterWithPaths(device, parameterPaths.userConnected) || '0';

        // Try to get detailed host information
        let hostInfo = '';
        try {
            // Check for host entries in LANDevice
            if (device.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host) {
                const hosts = device.InternetGatewayDevice.LANDevice['1'].Hosts.Host;
                let hostCount = 0;

                for (const hostKey in hosts) {
                    const host = hosts[hostKey];
                    if (host.Active?._value === 'true' || host.Active?._value === true) {
                        hostCount++;
                        if (hostCount <= 10) { // Limit to 10 devices
                            const hostname = host.HostName?._value || 'Unknown';
                            const ip = host.IPAddress?._value || 'N/A';
                            const mac = host.MACAddress?._value || 'N/A';
                            hostInfo += `${hostCount}. ${hostname}\n   IP: ${ip}\n   MAC: ${mac}\n\n`;
                        }
                    }
                }

                if (hostCount > 10) {
                    hostInfo += `... dan ${hostCount - 10} perangkat lainnya\n`;
                }
            }
        } catch (error) {
            logger.error(`Error getting detailed host info: ${error.message}`);
        }

        let message = `📱 *PERANGKAT TERHUBUNG*\n\n`;
        message += `Jumlah perangkat aktif: ${connectedUsers}\n\n`;

        if (hostInfo) {
            message += `Detail perangkat:\n${hostInfo}`;
        } else {
            message += `Detail perangkat tidak tersedia.`;
        }

        await sock.sendMessage(remoteJid, {
            text: formatResponse(message)
        });

    } catch (error) {
        logger.error(`Error handling connected devices: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk admin - melihat detail lengkap perangkat
async function handleAdminDeviceDetail(remoteJid, phoneNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by phone number
        const device = await getDeviceByNumber(phoneNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Perangkat dengan nomor ${phoneNumber} tidak ditemukan.`)
            });
            return;
        }

        // Get device information
        const lastInform = device._lastInform;
        const isOnline = getDeviceStatus(lastInform);
        const serialNumber = device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || 'N/A';
        const firmware = getParameterWithPaths(device, parameterPaths.firmware) || 'N/A';

        const uptime = formatUptime(getParameterWithPaths(device, parameterPaths.uptime)) || 'N/A';

        const rxPower = formatRxPower(getParameterWithPaths(device, parameterPaths.rxPower));
        const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP) || 'N/A';
        const pppUsername = getParameterWithPaths(device, parameterPaths.pppUsername) || 'N/A';
        const ssid = getSSIDValue(device, '1') || 'N/A';
        const ssid5G = getSSIDValue(device, '5') || 'N/A';
        const connectedUsers = getParameterWithPaths(device, parameterPaths.userConnected) || '0';
        const temperature = getParameterWithPaths(device, parameterPaths.temperature) || 'N/A';

        // Additional VirtualParameters
        const ponMode = getParameterWithPaths(device, parameterPaths.ponMode) || 'N/A';
        const pppUptime = getParameterWithPaths(device, parameterPaths.pppUptime) || 'N/A';

        // Get device model and manufacturer
        const manufacturer = device.InternetGatewayDevice?.DeviceInfo?.Manufacturer?._value || 'N/A';
        const model = device.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || 'N/A';
        const hardwareVersion = device.InternetGatewayDevice?.DeviceInfo?.HardwareVersion?._value || 'N/A';

        let message = `🔍 *DETAIL PERANGKAT ADMIN*\n\n`;
        message += `📱 *Nomor:* ${phoneNumber}\n`;
        message += `🆔 *Device ID:* ${device._id}\n`;
        message += `📟 *Serial Number:* ${serialNumber}\n`;
        message += `🏭 *Manufacturer:* ${manufacturer}\n`;
        message += `📦 *Model:* ${model}\n`;
        message += `🔧 *Hardware Version:* ${hardwareVersion}\n`;
        message += `💾 *Firmware:* ${firmware}\n\n`;

        message += `🌐 *Status Koneksi:*\n`;
        message += `• Status: ${isOnline ? '🟢 Online' : '🔴 Offline'}\n`;
        message += `• Last Inform: ${new Date(lastInform).toLocaleString()}\n`;
        message += `• Device Uptime: ${uptime}\n`;
        message += `• PPP Uptime: ${pppUptime}\n`;
        message += `• PPPoE IP: ${pppoeIP}\n`;
        message += `• PPP Username: ${pppUsername}\n\n`;

        message += `📡 *Network Information:*\n`;
        message += `• PON Mode: ${ponMode}\n`;
        message += `• RX Power: ${rxPower} dBm\n`;
        message += `• Temperature: ${temperature}°C\n\n`;

        message += `📶 *WiFi Information:*\n`;
        message += `• SSID 2.4G: ${ssid}\n`;
        message += `• SSID 5G: ${ssid5G}\n`;
        message += `• Connected Devices: ${connectedUsers}\n\n`;

        // Get tags
        if (device._tags && device._tags.length > 0) {
            message += `🏷️ *Tags:* ${device._tags.join(', ')}\n`;
        }

        await sock.sendMessage(remoteJid, {
            text: formatResponse(message)
        });

    } catch (error) {
        logger.error(`Error handling admin device detail: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk admin - restart perangkat pelanggan
async function handleAdminRestartDevice(remoteJid, phoneNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by phone number
        const device = await getDeviceByNumber(phoneNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Perangkat dengan nomor ${phoneNumber} tidak ditemukan.`)
            });
            return;
        }

        // Send processing message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`🔄 Melakukan restart perangkat pelanggan ${phoneNumber}...\nMohon tunggu beberapa menit.`)
        });

        // Restart device (pass server ID from device)
        await genieacsApi.reboot(device._id, device._acs_server_id);

        // Send success message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`✅ Perintah restart berhasil dikirim ke perangkat pelanggan ${phoneNumber}.\nPerangkat akan restart dalam beberapa menit.`)
        });

    } catch (error) {
        logger.error(`Error handling admin restart device: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk admin - factory reset perangkat pelanggan
async function handleAdminFactoryReset(remoteJid, phoneNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by phone number
        const device = await getDeviceByNumber(phoneNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Perangkat dengan nomor ${phoneNumber} tidak ditemukan.`)
            });
            return;
        }

        // Send confirmation message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`⚠️ *PERINGATAN FACTORY RESET ADMIN*\n\nAnda akan melakukan factory reset pada perangkat pelanggan ${phoneNumber}.\nSemua pengaturan akan kembali ke default pabrik.\n\nKetik "confirm admin factory reset ${phoneNumber}" untuk melanjutkan.`)
        });

        // Save factory reset confirmation status
        global.pendingAdminFactoryResets = global.pendingAdminFactoryResets || {};
        global.pendingAdminFactoryResets[phoneNumber] = {
            deviceId: device._id,
            timestamp: Date.now()
        };

    } catch (error) {
        logger.error(`Error preparing admin factory reset: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk konfirmasi admin factory reset
async function handleAdminFactoryResetConfirmation(remoteJid, phoneNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        if (!global.pendingAdminFactoryResets || !global.pendingAdminFactoryResets[phoneNumber]) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Tidak ada permintaan factory reset yang pending untuk nomor ${phoneNumber}.`)
            });
            return;
        }

        const { deviceId, timestamp } = global.pendingAdminFactoryResets[phoneNumber];

        // Check if confirmation is still valid (within 5 minutes)
        if (Date.now() - timestamp > 5 * 60 * 1000) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse(`❌ Permintaan factory reset untuk ${phoneNumber} sudah expired. Silakan ulangi.`)
            });
            delete global.pendingAdminFactoryResets[phoneNumber];
            return;
        }

        // Send processing message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`🔄 Melakukan factory reset perangkat pelanggan ${phoneNumber}...\nMohon tunggu beberapa menit.`)
        });

        // Factory reset device
        await genieacsApi.factoryReset(deviceId);

        // Send success message
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`✅ Factory reset berhasil dilakukan pada perangkat pelanggan ${phoneNumber}.\nPerangkat akan restart dan kembali ke pengaturan default pabrik.`)
        });

        // Delete factory reset confirmation status
        delete global.pendingAdminFactoryResets[phoneNumber];

    } catch (error) {
        logger.error(`Error handling admin factory reset confirmation: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });

        // Delete factory reset confirmation status even if error
        if (global.pendingAdminFactoryResets && global.pendingAdminFactoryResets[phoneNumber]) {
            delete global.pendingAdminFactoryResets[phoneNumber];
        }
    }
}

// Handler untuk melihat speed test / bandwidth
async function handleSpeedTest(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }

        // Get bandwidth/speed information
        const { getParameterWithPaths } = require('./whatsapp');

        // Try to get bandwidth information from various paths
        const downloadSpeed = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.DownstreamMaxBitRate',
            'Device.IP.Interface.1.Stats.BytesReceived'
        ]) || 'N/A';

        const uploadSpeed = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.UpstreamMaxBitRate',
            'Device.IP.Interface.1.Stats.BytesSent'
        ]) || 'N/A';

        // Get interface statistics
        const bytesReceived = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Stats.BytesReceived',
            'Device.IP.Interface.1.Stats.BytesReceived'
        ]) || 'N/A';

        const bytesSent = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Stats.BytesSent',
            'Device.IP.Interface.1.Stats.BytesSent'
        ]) || 'N/A';

        let message = `📊 *INFORMASI BANDWIDTH*\n\n`;
        message += `📥 *Download Speed:* ${downloadSpeed}\n`;
        message += `📤 *Upload Speed:* ${uploadSpeed}\n\n`;
        message += `📈 *Statistik Interface:*\n`;
        message += `• Bytes Received: ${formatBytes(bytesReceived)}\n`;
        message += `• Bytes Sent: ${formatBytes(bytesSent)}\n\n`;
        message += `💡 *Tips:* Untuk speed test yang akurat, gunakan aplikasi speed test di perangkat Anda.`;

        await sock.sendMessage(remoteJid, {
            text: formatResponse(message)
        });

    } catch (error) {
        logger.error(`Error handling speed test: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk diagnostik jaringan
async function handleNetworkDiagnostic(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }

        // Get diagnostic information
        const { getDeviceStatus, getParameterWithPaths, parameterPaths } = require('./whatsapp');

        const lastInform = device._lastInform;
        const isOnline = getDeviceStatus(lastInform);
        const rxPower = formatRxPower(getParameterWithPaths(device, parameterPaths.rxPower));
        const pppoeIP = getParameterWithPaths(device, parameterPaths.pppoeIP) || 'N/A';
        const temperature = getParameterWithPaths(device, parameterPaths.temperature) || 'N/A';

        // Get connection status
        const wanStatus = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus'
        ]) || 'N/A';

        // Get DNS servers
        const dnsServers = getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.DNSServers',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.DNSServers'
        ]) || 'N/A';

        let message = `🔧 *DIAGNOSTIK JARINGAN*\n\n`;

        // Status koneksi
        message += `🌐 *Status Koneksi:*\n`;
        message += `• Device: ${isOnline ? '🟢 Online' : '🔴 Offline'}\n`;
        message += `• WAN Status: ${wanStatus}\n`;
        message += `• PPPoE IP: ${pppoeIP}\n`;
        message += `• Last Inform: ${new Date(lastInform).toLocaleString()}\n\n`;

        // Signal quality
        message += `📶 *Kualitas Signal:*\n`;
        message += `• RX Power: ${rxPower} dBm\n`;
        const rxPowerNum = parseFloat(rxPower);
        if (!isNaN(rxPowerNum)) {
            if (rxPowerNum >= -25) {
                message += `• Status: 🟢 Excellent\n`;
            } else if (rxPowerNum >= -27) {
                message += `• Status: 🟡 Good\n`;
            } else if (rxPowerNum >= -30) {
                message += `• Status: 🟠 Fair\n`;
            } else {
                message += `• Status: 🔴 Poor\n`;
            }
        }
        message += `• Temperature: ${temperature}°C\n\n`;

        // Network settings
        message += `⚙️ *Pengaturan Jaringan:*\n`;
        message += `• DNS Servers: ${dnsServers}\n\n`;

        // Recommendations
        message += `💡 *Rekomendasi:*\n`;
        if (!isOnline) {
            message += `• Perangkat offline, coba restart perangkat\n`;
        }
        if (!isNaN(rxPowerNum) && rxPowerNum < -27) {
            message += `• Signal lemah, hubungi teknisi\n`;
        }
        if (!isNaN(parseFloat(temperature)) && parseFloat(temperature) > 70) {
            message += `• Temperature tinggi, pastikan ventilasi baik\n`;
        }

        await sock.sendMessage(remoteJid, {
            text: formatResponse(message)
        });

    } catch (error) {
        logger.error(`Error handling network diagnostic: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Handler untuk melihat riwayat koneksi
async function handleConnectionHistory(remoteJid, senderNumber) {
    if (!sock) {
        logger.error('Sock instance not set');
        return;
    }

    try {
        // Find device by sender's phone number
        const device = await getDeviceByNumber(senderNumber);

        if (!device) {
            await sock.sendMessage(remoteJid, {
                text: formatResponse('Perangkat tidak ditemukan.')
            });
            return;
        }

        // Get connection history information
        const { formatUptime, getParameterWithPaths, parameterPaths } = require('./whatsapp');

        const deviceUptime = formatUptime(getParameterWithPaths(device, parameterPaths.uptime)) || 'N/A';
        const pppUptime = formatUptime(getParameterWithPaths(device, [
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.UpTime',
            'Device.PPP.Interface.1.UpTime'
        ])) || 'N/A';

        const lastInform = device._lastInform;
        const firstInform = device._registered || device._created || 'N/A';

        let message = `📊 *RIWAYAT KONEKSI*\n\n`;
        message += `⏰ *Waktu Aktif:*\n`;
        message += `• Device Uptime: ${deviceUptime}\n`;
        message += `• PPPoE Uptime: ${pppUptime}\n\n`;

        message += `📅 *Riwayat:*\n`;
        message += `• First Registered: ${firstInform !== 'N/A' ? new Date(firstInform).toLocaleString() : 'N/A'}\n`;
        message += `• Last Inform: ${new Date(lastInform).toLocaleString()}\n\n`;

        // Calculate connection stability
        const now = Date.now();
        const lastInformTime = new Date(lastInform).getTime();
        const timeDiff = now - lastInformTime;

        message += `🔄 *Status Koneksi:*\n`;
        if (timeDiff < 5 * 60 * 1000) { // 5 minutes
            message += `• Status: 🟢 Stabil (Last inform ${Math.round(timeDiff / 1000)} detik lalu)\n`;
        } else if (timeDiff < 30 * 60 * 1000) { // 30 minutes
            message += `• Status: 🟡 Normal (Last inform ${Math.round(timeDiff / 60000)} menit lalu)\n`;
        } else {
            message += `• Status: 🔴 Bermasalah (Last inform ${Math.round(timeDiff / 60000)} menit lalu)\n`;
        }

        await sock.sendMessage(remoteJid, {
            text: formatResponse(message)
        });

    } catch (error) {
        logger.error(`Error handling connection history: ${error.message}`);
        await sock.sendMessage(remoteJid, {
            text: formatResponse(`❌ Terjadi kesalahan: ${error.message}`)
        });
    }
}

// Helper function untuk format bytes
function formatBytes(bytes) {
    if (bytes === 'N/A' || !bytes) return 'N/A';

    const num = parseInt(bytes);
    if (isNaN(num)) return bytes;

    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (num === 0) return '0 Bytes';

    const i = Math.floor(Math.log(num) / Math.log(1024));
    return Math.round(num / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

module.exports = {
    setSock,
    handleWifiInfo,
    handleChangeWifiSSID,
    handleChangeWifiPassword,
    handleDeviceStatus,
    handleRestartDevice,
    handleRestartConfirmation,
    handleFactoryReset,
    handleFactoryResetConfirmation,
    handleConnectedDevices,
    handleAdminDeviceDetail,
    handleAdminRestartDevice,
    handleAdminFactoryReset,
    handleAdminFactoryResetConfirmation,
    handleSpeedTest,
    handleNetworkDiagnostic,
    handleConnectionHistory
};
