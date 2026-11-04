const { Client } = require('ssh2');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

function sanitizeCliInput(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeParams(params) {
  const clean = {};
  if (!params || typeof params !== 'object') return clean;
  for (const k of Object.keys(params)) {
    clean[k] = typeof params[k] === 'string'
      ? params[k].replace(/[\r\n]+/g, ' ').trim()
      : params[k];
  }
  return clean;
}

/**
 * ONU Provision Service
 * Support untuk:
 * - ZTE C300/C320
 * - Huawei MA5800 Series
 * - Fiberhome AN5516 Series
 * - VSOL V1600/V2400 Series
 * - C-Data FD1600/FD1800 Series
 */

class ONUProvisionService {
  constructor() {
    this.connections = new Map();
  }

  /**
   * Connect ke OLT via SSH
   */
  async connectSSH(oltConfig) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('Connection timeout'));
      }, 30000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({
        host: oltConfig.host,
        port: oltConfig.port || 22,
        username: oltConfig.username,
        password: oltConfig.password,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      });
    });
  }

  /**
   * Execute multiple commands sequentially on a single SSH interactive shell stream
   */
  async executeCommands(conn, commands, promptPattern = /#|>/) {
    return new Promise((resolve, reject) => {
      conn.shell((err, stream) => {
        if (err) return reject(err);

        let output = '';
        let cmdIndex = 0;
        const cmdList = Array.isArray(commands) ? [...commands] : [commands];

        const timeout = setTimeout(() => {
          stream.end();
          reject(new Error('SSH command sequence timeout'));
        }, 60000);

        const writeNext = () => {
          if (cmdIndex < cmdList.length) {
            const rawCmd = cmdList[cmdIndex++];
            // Defense-in-depth: strip newlines from commands to make sure no multiline command gets injected
            const cmd = sanitizeCliInput(rawCmd);
            logger.info(`SSH command sent: ${cmd}`);
            stream.write(cmd + '\n');
          } else {
            clearTimeout(timeout);
            stream.end();
          }
        };

        let buffer = '';
        stream.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          buffer += chunk;

          const lines = buffer.split('\n');
          const lastLine = lines[lines.length - 1].trim();

          // If the last line matches the OLT prompt pattern, send the next command
          if (promptPattern.test(lastLine)) {
            buffer = '';
            setTimeout(writeNext, 50);
          }
        });

        stream.on('close', () => {
          clearTimeout(timeout);
          resolve(output);
        });

        stream.stderr.on('data', (data) => {
          logger.error('SSH stderr:', data.toString());
        });
      });
    });
  }

  /**
   * ZTE C300/C320 - Get unconfigured ONUs
   */
  async zteGetUnconfiguredONUs(oltConfig, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const cleanPon = sanitizeCliInput(pon);
      
      const commands = [
        'enable',
        `show gpon onu uncfg gpon-olt_${cleanPon}`
      ];
      
      const output = await this.executeCommands(conn, commands);
      const onus = this.parseZTEUnconfiguredONUs(output);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse ZTE unconfigured ONUs output robustly
   */
  parseZTEUnconfiguredONUs(output) {
    const onus = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const match = line.match(/gpon-onu_(\d+\/\d+\/\d+):(\d+)\s+(.+)/);
      if (match) {
        const pon = match[1];
        const onuId = match[2];
        const rest = match[3].trim().split(/\s+/);
        
        let sn = '';
        let model = 'Unknown';
        
        if (rest.length >= 2) {
          const isSn = (str) => /^[A-Z]{4}[0-9A-F]{8}$/i.test(str) || /^[0-9A-F]{12}$/i.test(str);
          
          if (isSn(rest[0])) {
            sn = rest[0];
            model = rest[1] || 'Unknown';
          } else if (isSn(rest[1])) {
            sn = rest[1];
            model = rest[0];
          } else {
            sn = rest[1] || rest[0];
            model = rest[0];
          }
        } else if (rest.length === 1) {
          sn = rest[0];
        }
        
        if (sn && sn.toLowerCase() !== 'sn-auth') {
          onus.push({
            pon,
            onuId,
            model,
            sn,
            vendor: 'ZTE'
          });
        }
      }
    }
    
    return onus;
  }

  /**
   * ZTE C300/C320 - Provision ONU
   */
  async zteProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'F660'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('tr069 enable');
        cmds.push(`tr069 acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`tr069 acs username ${tr069AcsUsername}`);
          cmds.push(`tr069 acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`tr069 periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('tr069 periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE provision ONU error:', error);
      throw error;
    }
  }

  /**
   * HSGQ / HIOSO - Get unconfigured ONUs
   */
  async hsgqGetUnconfiguredONUs(oltConfig, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const cleanPon = sanitizeCliInput(pon);
      const ponLower = String(cleanPon || '').toLowerCase();
      const isEpon = ponLower.includes('epon');
      
      const commands = ['enable'];
      if (isEpon) {
        commands.push(`show onu unregister`);
      } else {
        const ponInterface = ponLower.includes('gpon') ? cleanPon : `gpon-olt_${cleanPon}`;
        commands.push(`show gpon onu uncfg ${ponInterface}`);
      }
      
      const output = await this.executeCommands(conn, commands);
      const onus = this.parseHSGQUnconfiguredONUs(output, cleanPon, oltConfig.vendor);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error(`${oltConfig.vendor} get unconfigured ONUs error:`, error);
      throw error;
    }
  }

  /**
   * Parse HSGQ/HIOSO unconfigured ONUs output
   */
  parseHSGQUnconfiguredONUs(output, pon, vendor) {
    const onus = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const macMatch = line.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})|([0-9A-Fa-f]{12})/);
      const snMatch = line.match(/([A-Z]{4}[0-9A-F]{8})/i);
      
      if (macMatch || snMatch) {
        const sn = snMatch ? snMatch[1] : macMatch[0];
        const onuIdMatch = line.match(/(?:onu|index)\s*(\d+)/i) || line.match(/^\s*(\d+)/);
        const onuId = onuIdMatch ? onuIdMatch[1] : (onus.length + 1).toString();
        
        onus.push({
          pon,
          onuId,
          model: 'Unknown',
          sn,
          vendor: vendor || 'HSGQ'
        });
      }
    }
    
    return onus;
  }

  /**
   * HSGQ OLT - Provision ONU (Supports EPON & GPON)
   */
  async hsgqProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon');
      
      const cmds = [
        'enable',
        'config'
      ];

      if (isEpon) {
        cmds.push(`interface ${pon}`);
        cmds.push(`onu add ${onuId} mac ${sn}`);
        cmds.push(`onu ${onuId} name ${name}`);
        if (vlan) {
          cmds.push(`onu ${onuId} vlan mode tag vlan ${vlan}`);
        }
      } else {
        const ponInterface = ponLower.includes('gpon') ? pon : `gpon-olt_${pon}`;
        cmds.push(`interface ${ponInterface}`);
        cmds.push(`onu ${onuId} type ${params.onuType || 'HSGQ-ONU'} sn ${sn}`);
        cmds.push('exit');
        const onuInterface = ponLower.includes('gpon') ? `${pon}:${onuId}` : `gpon-onu_${pon}:${onuId}`;
        cmds.push(`interface ${onuInterface}`);
        cmds.push(`name ${name}`);
        cmds.push(`tcont 1 profile ${bandwidth || 'default'}`);
        cmds.push('gemport 1 tcont 1');
        cmds.push('exit');
        cmds.push(`pon-onu-mng ${onuInterface}`);
        cmds.push(`service 1 gemport 1 vlan ${vlan}`);
        cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
        cmds.push('exit');
      }
      
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully on HSGQ${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('HSGQ provision ONU error:', error);
      throw error;
    }
  }

  /**
   * HIOSO OLT - Provision ONU (Supports EPON & GPON)
   */
  async hiosoProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon') || (!ponLower.includes('gpon'));
      
      const cmds = [
        'enable',
        'config'
      ];

      if (isEpon) {
        const epInterface = ponLower.includes('epon') ? pon : `epon 0/${pon}`;
        cmds.push(`interface ${epInterface}`);
        cmds.push(`onu add ${onuId} mac ${sn}`);
        cmds.push(`onu ${onuId} name ${name}`);
        if (vlan) {
          cmds.push(`onu ${onuId} vlan mode tag vlan ${vlan}`);
        }
      } else {
        const gpInterface = ponLower.includes('gpon') ? pon : `gpon-olt_1/${pon}`;
        cmds.push(`interface ${gpInterface}`);
        cmds.push(`onu ${onuId} type ${params.onuType || 'HIOSO-ONU'} sn ${sn}`);
        cmds.push('exit');
        const onuInterface = ponLower.includes('gpon') ? `${pon}:${onuId}` : `gpon-onu_1/${pon}:${onuId}`;
        cmds.push(`interface ${onuInterface}`);
        cmds.push(`name ${name}`);
        cmds.push(`tcont 1 profile ${bandwidth || 'default'}`);
        cmds.push('gemport 1 tcont 1');
        cmds.push('exit');
        cmds.push(`pon-onu-mng ${onuInterface}`);
        cmds.push(`service 1 gemport 1 vlan ${vlan}`);
        cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
        cmds.push('exit');
      }
      
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully on HIOSO${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('HIOSO provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Huawei MA5800 - Get unconfigured ONUs
   */
  async huaweiGetUnconfiguredONUs(oltConfig, frame, slot, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const cleanFrame = sanitizeCliInput(frame);
      const cleanSlot = sanitizeCliInput(slot);
      const cleanPon = sanitizeCliInput(pon);
      
      const commands = [
        'enable',
        `display ont autofind ${cleanFrame}/${cleanSlot}/${cleanPon}`
      ];
      
      const output = await this.executeCommands(conn, commands);
      const onus = this.parseHuaweiUnconfiguredONUs(output, cleanFrame, cleanSlot, cleanPon);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse Huawei unconfigured ONUs output robustly (handles both block and table formats)
   */
  parseHuaweiUnconfiguredONUs(output, frame, slot, pon) {
    const onus = [];
    
    if (output.includes('Ont SN') || output.includes('Slot/Port')) {
      const blocks = output.split(/----------------------------------------------------------------------/);
      for (const block of blocks) {
        const snMatch = block.match(/Ont\s+SN\s*:\s*(\S+)/i);
        if (snMatch) {
          let sn = snMatch[1];
          sn = sn.split('(')[0].trim();
          
          const portMatch = block.match(/Slot\/Port\s*:\s*(\d+\/\d+\/\d+)/i) || block.match(/Slot\/Port\s*:\s*(\d+\/\d+)/i);
          let blockPon = pon;
          let blockSlot = slot;
          let blockFrame = frame;
          
          if (portMatch) {
            const parts = portMatch[1].split('/');
            if (parts.length === 3) {
              blockFrame = parts[0];
              blockSlot = parts[1];
              blockPon = parts[2];
            } else if (parts.length === 2) {
              blockSlot = parts[0];
              blockPon = parts[1];
            }
          }
          
          const modelMatch = block.match(/Ont\s+EquipmentID\s*:\s*(\S+)/i) || block.match(/Ont\s+Type\s*:\s*(\S+)/i);
          const model = modelMatch ? modelMatch[1] : 'Unknown';
          
          onus.push({
            frame: blockFrame,
            slot: blockSlot,
            pon: blockPon,
            onuId: onus.length.toString(),
            sn,
            model,
            vendor: 'Huawei'
          });
        }
      }
    } else {
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/(?:^|\s)([0-9A-F]{16}|[A-Z]{4}[0-9A-F]{8}|HWTC[0-9A-F]{8})(?:\s|$)/i);
        if (match) {
          const sn = match[1];
          const parts = line.trim().split(/\s+/);
          let blockFrame = frame, blockSlot = slot, blockPon = pon;
          const portPart = parts.find(p => /^\d+\/\d+\/\d+$/.test(p) || /^\d+\/\d+$/.test(p));
          if (portPart) {
            const p = portPart.split('/');
            if (p.length === 3) {
              blockFrame = p[0];
              blockSlot = p[1];
              blockPon = p[2];
            } else if (p.length === 2) {
              blockSlot = p[0];
              blockPon = p[1];
            }
          }
          
          onus.push({
            frame: blockFrame,
            slot: blockSlot,
            pon: blockPon,
            onuId: parts[0] || onus.length.toString(),
            sn,
            model: 'Unknown',
            vendor: 'Huawei'
          });
        }
      }
    }
    
    return onus;
  }

  /**
   * Huawei MA5800 - Provision ONU
   */
  async huaweiProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { frame, slot, pon, onuId, sn, name, vlan, bandwidth, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont add ${pon} ${onuId} sn-auth ${sn} omci ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}`
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ont wifi-config ${pon} ${onuId} ssid ${wifiSsid} wpa-psk ${wifiPassword}`);
      }
      
      if (lanMode) {
        cmds.push(`ont port native-vlan ${pon} ${onuId} eth 1 vlan ${vlan} priority 0`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`ont wan-config ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push(`ont tr069-server ${pon} ${onuId} url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`ont tr069-server ${pon} ${onuId} username ${tr069AcsUsername} password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`ont tr069-server ${pon} ${onuId} periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push(`ont tr069-server ${pon} ${onuId} periodic-inform enable`);
        }
        cmds.push(`ont tr069-server ${pon} ${onuId} enable`);
      }
      
      cmds.push('quit');
      cmds.push(`service-port vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
      cmds.push('save');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Fiberhome AN5516 - Provision ONU
   */
  async fiberhomeProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { frame, slot, pon, onuId, sn, name, vlan, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont add ${pon} ${onuId} sn-auth ${sn} ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}`
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ont wlan ssid ${pon} ${onuId} 1 ${wifiSsid}`);
        cmds.push(`ont wlan security ${pon} ${onuId} 1 wpa2-psk aes ${wifiPassword}`);
        cmds.push(`ont wlan enable ${pon} ${onuId} 1`);
      }
      
      if (lanMode) {
        cmds.push(`ont port vlan ${pon} ${onuId} eth 1 mode tag vlan ${vlan}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`ont wan ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push(`ont cwmp ${pon} ${onuId} acs-url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`ont cwmp ${pon} ${onuId} acs-username ${tr069AcsUsername}`);
          cmds.push(`ont cwmp ${pon} ${onuId} acs-password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`ont cwmp ${pon} ${onuId} periodic-inform-interval ${tr069PeriodicInform}`);
          cmds.push(`ont cwmp ${pon} ${onuId} periodic-inform enable`);
        }
        cmds.push(`ont cwmp ${pon} ${onuId} enable`);
      }
      
      cmds.push('quit');
      cmds.push(`service-port ${vlan} vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}`);
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Fiberhome provision ONU error:', error);
      throw error;
    }
  }

  /**
   * VSOL V1600/V2400 - Provision ONU
   */
  async vsolProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'V2802RGW'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('tr069 enable');
        cmds.push(`tr069 acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`tr069 acs username ${tr069AcsUsername}`);
          cmds.push(`tr069 acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`tr069 periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('tr069 periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('VSOL provision ONU error:', error);
      throw error;
    }
  }

  /**
   * C-Data FD1600/FD1800 - Provision ONU
   */
  async cdataProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `onu ${onuId} type ${params.onuType || 'FD1104S'} sn ${sn}`,
        'exit',
        `interface gpon-onu_${pon}:${onuId}`,
        `name ${name}`,
        `tcont 1 profile ${bandwidth || 'default'}`,
        'gemport 1 tcont 1'
      ];
      
      if (wifiSsid && wifiPassword) {
        cmds.push(`ssid 1 ${wifiSsid}`);
        cmds.push(`security 1 wpa2-psk AES ${wifiPassword}`);
        cmds.push('wifi enable 1');
      }
      
      if (lanMode) {
        cmds.push(`lan-mode ${lanMode}`);
      }
      
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmds.push(`wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}`);
      }
      
      if (tr069AcsUrl) {
        cmds.push('cwmp enable');
        cmds.push(`cwmp acs url ${tr069AcsUrl}`);
        if (tr069AcsUsername && tr069AcsPassword) {
          cmds.push(`cwmp acs username ${tr069AcsUsername}`);
          cmds.push(`cwmp acs password ${tr069AcsPassword}`);
        }
        if (tr069PeriodicInform) {
          cmds.push(`cwmp periodic-inform interval ${tr069PeriodicInform}`);
          cmds.push('cwmp periodic-inform enable');
        }
      }
      
      cmds.push('exit');
      cmds.push(`pon-onu-mng gpon-onu_${pon}:${onuId}`);
      cmds.push(`service 1 gemport 1 vlan ${vlan}`);
      cmds.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
      cmds.push('exit');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('C-Data provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Get ONU details (works for both ZTE and Huawei)
   */
  async getONUDetails(oltConfig, vendor, params) {
    if (vendor === 'ZTE') {
      return this.zteGetONUDetails(oltConfig, params);
    } else if (vendor === 'Huawei') {
      return this.huaweiGetONUDetails(oltConfig, params);
    }
    throw new Error('Unsupported vendor');
  }

  /**
   * ZTE - Get ONU details
   */
  async zteGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk membaca detail ONU ZTE.');
      }
      const cmds = [
        'enable',
        `show gpon onu detail-info gpon-onu_${pon}:${onuId}`
      ];
      const output = await this.executeCommands(conn, cmds);
      conn.end();
      
      return this.parseZTEONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse ZTE ONU details
   */
  parseZTEONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Name:')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN:')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Status:')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('RX Power:')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Huawei - Get ONU details
   */
  async huaweiGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      const { frame, slot, pon, onuId } = params;
      if (!frame || !slot || !pon || !onuId) {
        throw new Error('Parameter frame, slot, pon, dan onuId diperlukan untuk membaca detail ONU Huawei.');
      }
      const cmds = [
        'enable',
        `display ont info ${frame} ${slot} ${pon} ${onuId}`
      ];
      const output = await this.executeCommands(conn, cmds);
      conn.end();
      
      return this.parseHuaweiONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse Huawei ONU details
   */
  parseHuaweiONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Description')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Run state')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('Rx optical power')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Delete ONU
   */
  async deleteONU(oltConfig, vendor, params) {
    params = sanitizeParams(params) || {};
    const v = String(vendor || '').toUpperCase();

    // Auto-resolve pon and onuId if missing
    if ((!params.pon || !params.onuId) && (params.id || params.index)) {
      const idxNum = Number(params.index);
      if (Number.isFinite(idxNum) && idxNum > 1000) {
        if (v === 'ZTE') {
          const board = (idxNum >> 16) & 0xFF;
          const port = (idxNum >> 8) & 0xFF;
          params.pon = params.pon || `1/${board}/${port}`;
          params.onuId = params.onuId || String(idxNum & 0xFF);
        } else if (v === 'HUAWEI') {
          const frame = (idxNum >> 21) & 0x1F;
          const slot = (idxNum >> 16) & 0x1F;
          const port = (idxNum >> 8) & 0xFF;
          params.frame = params.frame || String(frame);
          params.slot = params.slot || String(slot);
          params.pon = params.pon || String(port);
          params.onuId = params.onuId || String(idxNum & 0xFF);
        } else {
          let port = (idxNum >> 16) & 0xFF;
          if (port === 0 || port > 16) port = (idxNum >> 8) & 0xFF;
          params.pon = params.pon || String(port);
          params.onuId = params.onuId || String(idxNum & 0xFF);
        }
      } else {
        const idStr = String(params.id || params.index || '');
        const hasEpon = /epon/i.test(idStr);
        const clean = idStr.replace(/^[a-zA-Z_ -]+/, '');
        const parts = clean.split(/[/: ]+/).filter(Boolean);
        if (parts.length >= 2) {
          params.onuId = params.onuId || parts[parts.length - 1];
          if (v === 'HUAWEI' || v === 'FIBERHOME') {
            if (parts.length >= 4) {
              params.frame = params.frame || parts[0];
              params.slot = params.slot || parts[1];
              params.pon = params.pon || parts[2];
            } else if (parts.length === 3) {
              params.frame = params.frame || '0';
              params.slot = params.slot || parts[0];
              params.pon = params.pon || parts[1];
            }
          } else {
            const rawPon = parts.slice(0, parts.length - 1).join('/');
            params.pon = params.pon || (hasEpon ? `epon ${rawPon}` : rawPon);
          }
        }
      }
    }
    if (v === 'ZTE') {
      return this.zteDeleteONU(oltConfig, params);
    } else if (v === 'HUAWEI') {
      return this.huaweiDeleteONU(oltConfig, params);
    } else if (v === 'FIBERHOME') {
      return this.fiberhomeDeleteONU(oltConfig, params);
    } else if (v === 'VSOL') {
      return this.vsolDeleteONU(oltConfig, params);
    } else if (v === 'CDATA') {
      return this.cdataDeleteONU(oltConfig, params);
    } else if (v === 'HSGQ') {
      return this.hsgqDeleteONU(oltConfig, params);
    } else if (v === 'HIOSO') {
      return this.hiosoDeleteONU(oltConfig, params);
    }
    throw new Error(`Unsupported vendor: ${vendor}`);
  }

  /**
   * ZTE - Delete ONU
   */
  async zteDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk menghapus ONU ZTE.');
      }
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit',
        'write'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Huawei - Delete ONU
   */
  async huaweiDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, slot, pon, onuId } = params;
      if (!frame || !slot || !pon || !onuId) {
        throw new Error('Parameter frame, slot, pon, dan onuId diperlukan untuk menghapus ONU Huawei.');
      }
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont delete ${pon} ${onuId}`,
        'quit',
        'save'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Fiberhome - Delete ONU
   */
  async fiberhomeDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, slot, pon, onuId } = params;
      if (!frame || !slot || !pon || !onuId) {
        throw new Error('Parameter frame, slot, pon, dan onuId diperlukan untuk menghapus ONU Fiberhome.');
      }
      const cmds = [
        'enable',
        'config',
        `interface gpon ${frame}/${slot}`,
        `ont delete ${pon} ${onuId}`,
        'quit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on Fiberhome' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * VSOL - Delete ONU
   */
  async vsolDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk menghapus ONU VSOL.');
      }
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on VSOL' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * C-Data - Delete ONU
   */
  async cdataDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk menghapus ONU C-Data.');
      }
      const cmds = [
        'enable',
        'configure terminal',
        `interface gpon-olt_${pon}`,
        `no onu ${onuId}`,
        'exit'
      ];
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on C-Data' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * HSGQ - Delete ONU (Supports EPON & GPON)
   */
  async hsgqDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk menghapus ONU HSGQ.');
      }
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon');
      
      const cmds = [
        'enable',
        'config'
      ];
      
      if (isEpon) {
        cmds.push(`interface ${pon}`);
        cmds.push(`no onu ${onuId}`);
      } else {
        const ponInterface = ponLower.includes('gpon') ? pon : `gpon-olt_${pon}`;
        cmds.push(`interface ${ponInterface}`);
        cmds.push(`no onu ${onuId}`);
      }
      cmds.push('exit');
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on HSGQ' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * HIOSO - Delete ONU (Supports EPON & GPON)
   */
  async hiosoDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { pon, onuId } = params;
      if (!pon || !onuId) {
        throw new Error('Parameter PON interface dan ONU ID diperlukan untuk menghapus ONU HIOSO.');
      }
      const ponLower = String(pon || '').toLowerCase();
      const isEpon = ponLower.includes('epon') || (!ponLower.includes('gpon'));
      
      const cmds = [
        'enable',
        'config'
      ];
      
      if (isEpon) {
        const epInterface = ponLower.includes('epon') ? pon : `epon 0/${pon}`;
        cmds.push(`interface ${epInterface}`);
        cmds.push(`no onu ${onuId}`);
      } else {
        const gpInterface = ponLower.includes('gpon') ? pon : `gpon-olt_1/${pon}`;
        cmds.push(`interface ${gpInterface}`);
        cmds.push(`no onu ${onuId}`);
      }
      cmds.push('exit');
      cmds.push('write');
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU deleted successfully on HIOSO' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Create PPPoE Secret in MikroTik
   */
  async createMikrotikPPPoE(mikrotikConfig, params) {
    const mikrotikService = require('./mikrotikService');
    
    try {
      const { username, password, profile, comment, localAddress, remoteAddress } = params;
      
      const secretData = {
        name: username,
        password: password,
        service: 'pppoe',
        profile: profile || 'default'
      };
      
      if (comment) {
        secretData.comment = comment;
      }
      
      if (localAddress) {
        secretData['local-address'] = localAddress;
      }
      
      if (remoteAddress) {
        secretData['remote-address'] = remoteAddress;
      }
      
      await mikrotikService.addPppoeSecret(secretData, null);
      
      logger.info(`PPPoE secret created in MikroTik: ${username}`);
      return { success: true, message: 'PPPoE secret created successfully' };
    } catch (error) {
      logger.error('Create MikroTik PPPoE error:', error);
      throw error;
    }
  }

  /**
   * Delete PPPoE Secret from MikroTik
   */
  async deleteMikrotikPPPoE(mikrotikConfig, username) {
    const mikrotikService = require('./mikrotikService');
    
    try {
      const conn = await mikrotikService.connect(mikrotikConfig);
      
      const secrets = await conn.write('/ppp/secret/print', [`?name=${username}`]);
      
      if (secrets && secrets.length > 0) {
        const secretId = secrets[0]['.id'];
        await conn.write('/ppp/secret/remove', [`=.id=${secretId}`]);
        logger.info(`PPPoE secret deleted from MikroTik: ${username}`);
      }
      
      conn.close();
      
      return { success: true, message: 'PPPoE secret deleted successfully' };
    } catch (error) {
      logger.error('Delete MikroTik PPPoE error:', error);
      throw error;
    }
  }

  /**
   * Full Provision: ONU + MikroTik PPPoE
   */
  async fullProvision(oltConfig, mikrotikConfig, params) {
    const results = {
      onu: null,
      pppoe: null,
      errors: []
    };
    
    try {
      const { vendor } = params;
      
      if (vendor === 'ZTE') {
        results.onu = await this.zteProvisionONU(oltConfig, params);
      } else if (vendor === 'Huawei') {
        results.onu = await this.huaweiProvisionONU(oltConfig, params);
      } else if (vendor === 'Fiberhome') {
        results.onu = await this.fiberhomeProvisionONU(oltConfig, params);
      } else if (vendor === 'VSOL') {
        results.onu = await this.vsolProvisionONU(oltConfig, params);
      } else if (vendor === 'CData') {
        results.onu = await this.cdataProvisionONU(oltConfig, params);
      } else if (vendor === 'HSGQ') {
        results.onu = await this.hsgqProvisionONU(oltConfig, params);
      } else if (vendor === 'Hioso') {
        results.onu = await this.hiosoProvisionONU(oltConfig, params);
      } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
      }
      
      logger.info(`ONU provisioned: ${params.name} (${vendor})`);
      
      if (params.pppoeUsername && params.pppoePassword && mikrotikConfig) {
        try {
          results.pppoe = await this.createMikrotikPPPoE(mikrotikConfig, {
            username: params.pppoeUsername,
            password: params.pppoePassword,
            profile: params.bandwidth || 'default',
            comment: `${params.name} - Auto-provisioned`,
            remoteAddress: params.remoteAddress
          });
          
          logger.info(`PPPoE created: ${params.pppoeUsername}`);
        } catch (pppoeError) {
          results.errors.push(`PPPoE creation failed: ${pppoeError.message}`);
          logger.error('PPPoE creation failed:', pppoeError);
        }
      }
      
      return {
        success: true,
        message: 'Full provisioning completed',
        results
      };
    } catch (error) {
      results.errors.push(`Provisioning failed: ${error.message}`);
      logger.error('Full provision error:', error);
      throw error;
    }
  }

  /**
   * Reboot ONU via SSH CLI (for ZTE and Huawei)
   */
  async rebootONU(oltConfig, vendor, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, board, port, onuId } = params;
      const cmds = [];
      
      if (vendor === 'ZTE') {
        cmds.push('enable');
        cmds.push('configure terminal');
        cmds.push(`pon-onu-mng gpon-onu_1/${board}/${port}:${onuId}`);
        cmds.push('reboot');
      } else if (vendor === 'Huawei') {
        cmds.push('enable');
        cmds.push('config');
        cmds.push(`interface gpon ${frame}/${board}`);
        cmds.push(`ont reset ${port} ${onuId}`);
        cmds.push('quit');
        cmds.push('save');
      } else {
        throw new Error('Unsupported vendor for SSH reboot');
      }
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU rebooted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Rename ONU via SSH CLI (for ZTE and Huawei)
   */
  async renameONU(oltConfig, vendor, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      params = sanitizeParams(params);
      const { frame, board, port, onuId, newName } = params;
      const cmds = [];
      
      if (vendor === 'ZTE') {
        cmds.push('enable');
        cmds.push('configure terminal');
        cmds.push(`interface gpon-onu_1/${board}/${port}:${onuId}`);
        cmds.push(`name ${newName}`);
        cmds.push('exit');
        cmds.push('write');
      } else if (vendor === 'Huawei') {
        cmds.push('enable');
        cmds.push('config');
        cmds.push(`interface gpon ${frame}/${board}`);
        cmds.push(`ont name ${port} ${onuId} "${newName}"`);
        cmds.push('quit');
        cmds.push('save');
      } else {
        throw new Error('Unsupported vendor for SSH rename');
      }
      
      await this.executeCommands(conn, cmds);
      conn.end();
      return { success: true, message: 'ONU renamed successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }
}

module.exports = new ONUProvisionService();

// Made with Bob
