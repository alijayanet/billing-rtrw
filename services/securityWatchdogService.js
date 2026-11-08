/**
 * Service: AI Security & Brute-Force Anomaly Watchdog
 * Mendeteksi anomali serangan brute force pada:
 * 1. Aplikasi billing (Web Admin, Kasir, Agent, Teknisi)
 * 2. Hotspot MikroTik (serangan tebak kode voucher / login user acak berulang)
 * 3. Router MikroTik Management (brute force Winbox, SSH, Telnet, API, WebFig, FTP)
 * 
 * Tindakan Otomatis (IPS / Intrusion Prevention):
 * - Otomatis memasukkan MAC Address penyerang Hotspot ke /ip hotspot ip-binding (type: blocked)
 * - Otomatis memasukkan IP penyerang ke /ip firewall address-list (BLACKLIST_BRUTEFORCE) dengan timeout 24 jam
 * - Memutus paksa (kick) sesi aktif penyerang di Hotspot
 * - Memastikan filter drop aktif pada MikroTik
 * - Mengirim peringatan siaga ke Telegram Admin & WhatsApp
 * - Membunyikan peringatan suara darurat via Soundbox (TTS)
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const soundboxSvc = require('./soundboxService');
const { getSetting } = require('../config/settingsManager');

// In-memory state tracking
const failedAttemptsByIp = new Map();
const blockedIps = new Map(); // ip -> unblockTime
const mikrotikAlertCache = new Map(); // routerId:ip -> timestamp
const processedLogIdsByRouter = new Map(); // routerId -> Set of log IDs

const WINDOW_MS = 5 * 60 * 1000; // 5 menit window
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 menit untuk app login
const APP_CRITICAL_THRESHOLD = 5;

/**
 * Mengonversi IP address menjadi format lisan ramah suara TTS
 */
function formatIpForSpeech(ip) {
  if (!ip) return 'tidak diketahui';
  const cleanIp = String(ip).replace(/^::ffff:/, '');
  return cleanIp.split('.').map(octet => octet.split('').join(' ')).join(' titik ');
}

class SecurityWatchdogService {
  /**
   * Cek apakah IP sedang dalam masa blokir sementara pada aplikasi web
   */
  isIpBlocked(rawIp) {
    const ip = String(rawIp || '').replace(/^::ffff:/, '').trim();
    if (!ip) return false;

    const unblockTime = blockedIps.get(ip);
    if (unblockTime) {
      if (Date.now() < unblockTime) {
        return true;
      } else {
        blockedIps.delete(ip);
      }
    }
    return false;
  }

  /**
   * Buka blokir IP aplikasi secara manual
   */
  unblockIp(rawIp) {
    const ip = String(rawIp || '').replace(/^::ffff:/, '').trim();
    if (!ip) return false;
    blockedIps.delete(ip);
    failedAttemptsByIp.delete(ip);
    return true;
  }

  /**
   * Mencatat percobaan login pada aplikasi (Admin / Kasir / Agent / Tech)
   */
  async recordAppLoginAttempt({ type = 'admin', username = '', ip: rawIp = '127.0.0.1', success = false, userAgent = '' }) {
    const ip = String(rawIp || '').replace(/^::ffff:/, '').trim();
    const now = Date.now();

    if (success) {
      failedAttemptsByIp.delete(ip);
      return { allowed: true };
    }

    let record = failedAttemptsByIp.get(ip);
    if (!record || (now - record.lastAttempt > WINDOW_MS)) {
      record = {
        ip,
        count: 1,
        firstAttempt: now,
        lastAttempt: now,
        usernames: new Set([username]),
        alerted: false
      };
    } else {
      record.count++;
      record.lastAttempt = now;
      if (username) record.usernames.add(username);
    }
    failedAttemptsByIp.set(ip, record);

    logger.warn(`[SecurityWatchdog] Login gagal ke ${type} dari IP ${ip} (Percobaan ke-${record.count}, target: ${username})`);

    if (record.count >= APP_CRITICAL_THRESHOLD && !record.alerted) {
      record.alerted = true;
      blockedIps.set(ip, now + BLOCK_DURATION_MS);

      const targetList = Array.from(record.usernames).filter(Boolean).join(', ') || 'admin';
      const ipSpoken = formatIpForSpeech(ip);

      const speechText = `Peringatan keamanan! Terdeteksi anomali percobaan login gagal berulang kali ke aplikasi ${type} dari alamat i pe ${ipSpoken}. Sistem telah memblokir sementara akses tersebut.`;
      
      soundboxSvc.queueSoundboxEvent({
        type: 'security_alert',
        title: 'PERINGATAN BRUTE FORCE APLIKASI',
        speechText: speechText,
        amount: 0,
        customerName: `IP: ${ip} (Target: ${targetList})`
      });

      const waMsg = 
        `🚨 *PERINGATAN KEAMANAN (BRUTE FORCE APLIKASI DIBLOKIR)*\n\n` +
        `Sistem mendeteksi percobaan login gagal berulang kali ke portal *${type.toUpperCase()}*:\n` +
        `🌐 *Alamat IP:* \`${ip}\`\n` +
        `👤 *Target Username:* ${targetList}\n` +
        `📊 *Jumlah Kegagalan:* ${record.count} kali dalam 5 menit\n` +
        `⏱️ *Waktu:* ${new Date().toLocaleString('id-ID')}\n` +
        `🛡️ *Status Tindakan:* IP telah diblokir sementara dari akses aplikasi selama 15 menit.\n\n` +
        `_Peringatan suara telah dibunyikan otomatis melalui Soundbox._`;

      await this._notifyAdmin(waMsg);

      this._recordAudit({
        action: 'BRUTE_FORCE_BLOCKED',
        entity_type: 'app_login',
        entity_id: ip,
        details: {
          portal: type,
          failedCount: record.count,
          targets: Array.from(record.usernames),
          userAgent
        },
        ip_address: ip,
        user_agent: userAgent
      });
    }

    return {
      allowed: !this.isIpBlocked(ip),
      attempts: record.count,
      remaining: Math.max(0, APP_CRITICAL_THRESHOLD - record.count)
    };
  }

  /**
   * Pastikan MikroTik memiliki aturan Drop Firewall Filter untuk BLACKLIST_BRUTEFORCE
   */
  async ensureFirewallDropRules(conn) {
    try {
      const filterMenu = conn.client.menu('/ip/firewall/filter');
      const filters = await filterMenu.get();

      // 1. Cek rule drop pada chain input
      const hasInputDrop = filters.some(f => 
        f.chain === 'input' && 
        f.action === 'drop' && 
        (f['src-address-list'] === 'BLACKLIST_BRUTEFORCE' || f.srcAddressList === 'BLACKLIST_BRUTEFORCE')
      );

      if (!hasInputDrop) {
        await filterMenu.add({
          chain: 'input',
          action: 'drop',
          srcAddressList: 'BLACKLIST_BRUTEFORCE',
          comment: 'AI_AUTO_DROP_BLACKLIST_BRUTEFORCE'
        }).catch(() => {});
        logger.info('[SecurityWatchdog] Ditambahkan filter drop input: BLACKLIST_BRUTEFORCE');
      }

      // 2. Cek rule drop pada chain forward
      const hasForwardDrop = filters.some(f => 
        f.chain === 'forward' && 
        f.action === 'drop' && 
        (f['src-address-list'] === 'BLACKLIST_BRUTEFORCE' || f.srcAddressList === 'BLACKLIST_BRUTEFORCE')
      );

      if (!hasForwardDrop) {
        await filterMenu.add({
          chain: 'forward',
          action: 'drop',
          srcAddressList: 'BLACKLIST_BRUTEFORCE',
          comment: 'AI_AUTO_FORWARD_DROP_BLACKLIST_BRUTEFORCE'
        }).catch(() => {});
        logger.info('[SecurityWatchdog] Ditambahkan filter drop forward: BLACKLIST_BRUTEFORCE');
      }
    } catch (err) {
      logger.warn(`[SecurityWatchdog] Gagal memastikan firewall filter drop: ${err.message}`);
    }
  }

  /**
   * Resolusi Alamat MAC dari Alamat IP (via Hotspot Host, DHCP Lease, atau ARP Table)
   */
  async resolveMacFromIp(conn, ip, logs = []) {
    if (!ip) return null;
    try {
      // 1. Cek tabel Hotspot Host
      const hostMenu = conn.client.menu('/ip/hotspot/host');
      const hosts = await hostMenu.get();
      const matchHost = hosts.find(h => h.address === ip);
      if (matchHost) {
        const mac = (matchHost['mac-address'] || matchHost.macAddress || '').toUpperCase();
        if (mac) return mac;
      }

      // 2. Cek tabel DHCP Server Lease
      const leaseMenu = conn.client.menu('/ip/dhcp-server/lease');
      const leases = await leaseMenu.get();
      const matchLease = leases.find(l => l.address === ip);
      if (matchLease) {
        const mac = (matchLease['mac-address'] || matchLease.macAddress || '').toUpperCase();
        if (mac) return mac;
      }

      // 3. Cek tabel ARP
      const arpMenu = conn.client.menu('/ip/arp');
      const arps = await arpMenu.get();
      const matchArp = arps.find(a => a.address === ip);
      if (matchArp) {
        const mac = (matchArp['mac-address'] || matchArp.macAddress || '').toUpperCase();
        if (mac) return mac;
      }

      // 4. Fallback scan dari log buffer DHCP (misal: "dhcp1 assigned 192.168.100.136 to CA:32:A4:EA:B1:78")
      if (Array.isArray(logs) && logs.length > 0) {
        for (let i = logs.length - 1; i >= 0; i--) {
          const m = logs[i].message || '';
          if (m.includes(ip) && (m.includes('assigned') || m.includes('deassigned') || m.includes('dhcp'))) {
            const macMatch = m.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/);
            if (macMatch) return macMatch[0].toUpperCase();
          }
        }
      }

      // 5. Fallback dari riwayat audit_trail sebelumnya untuk IP ini
      try {
        const prevAudit = db.prepare("SELECT entity_id FROM audit_trail WHERE ip_address = ? AND action LIKE '%BRUTE_FORCE%' AND entity_id NOT LIKE '%no-mac' ORDER BY id DESC LIMIT 1").get(ip);
        if (prevAudit && prevAudit.entity_id) {
          const parts = prevAudit.entity_id.split(':');
          const possibleMac = parts.slice(2).join(':');
          if (/^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/.test(possibleMac)) {
            return possibleMac.toUpperCase();
          }
        }
      } catch (_) {}
    } catch (err) {
      logger.warn(`[SecurityWatchdog] Gagal resolusi MAC dari IP ${ip}: ${err.message}`);
    }
    return null;
  }

  /**
   * Eksekusi Pemblokiran Otomatis pada Router MikroTik
   */
  async blockMikrotikTarget({ conn, routerId, routerName, ip, mac, reason, count, targets, service }) {
    const actionsTaken = [];
    let isNewlyBlocked = false;
    const targetsStr = Array.from(targets).slice(0, 3).join(', ') || 'unknown';

    try {
      // 1. Jika ada MAC Address (terutama kasus Hotspot Brute Force)
      if (mac) {
        const ipBindingMenu = conn.client.menu('/ip/hotspot/ip-binding');
        const bindings = await ipBindingMenu.get();
        const existingBinding = bindings.find(b => {
          const m = (b['mac-address'] || b.macAddress || '').toUpperCase();
          return m === mac.toUpperCase();
        });

        if (!existingBinding) {
          await ipBindingMenu.add({
            macAddress: mac,
            address: ip || undefined,
            toAddress: ip || undefined,
            type: 'blocked',
            comment: `AI_BLOCKED: Hotspot Brute Force (${count}x gagal, user: ${targetsStr})`
          });
          actionsTaken.push(`MAC ${mac} dimasukkan ke Hotspot IP-Binding (type: blocked)`);
          isNewlyBlocked = true;
        } else if (existingBinding.type !== 'blocked') {
          await ipBindingMenu.set({
            type: 'blocked',
            comment: `AI_BLOCKED: Hotspot Brute Force (${count}x gagal, user: ${targetsStr})`
          }, existingBinding['.id']);
          actionsTaken.push(`MAC ${mac} diperbarui ke type: blocked di IP-Binding`);
          isNewlyBlocked = true;
        } else {
          actionsTaken.push(`MAC ${mac} sudah berstatus blocked`);
        }

        // Kick dari Hotspot Active
        const activeMenu = conn.client.menu('/ip/hotspot/active');
        const activeUsers = await activeMenu.get();
        for (const u of activeUsers) {
          const uMac = (u['mac-address'] || u.macAddress || '').toUpperCase();
          if (u.address === ip || uMac === mac.toUpperCase()) {
            await activeMenu.remove(u['.id']).catch(() => {});
            actionsTaken.push(`Sesi Hotspot aktif user '${u.user}' diputus paksa`);
          }
        }

        // Kick dari Hotspot Host
        const hostMenu = conn.client.menu('/ip/hotspot/host');
        const hosts = await hostMenu.get();
        for (const h of hosts) {
          const hMac = (h['mac-address'] || h.macAddress || '').toUpperCase();
          if (h.address === ip || hMac === mac.toUpperCase()) {
            await hostMenu.remove(h['.id']).catch(() => {});
            actionsTaken.push(`Host Hotspot ${ip || mac} dibersihkan`);
          }
        }
      }

      // 2. Blokir Alamat IP pada /ip firewall address-list (timeout 24 jam)
      if (ip && ip !== '127.0.0.1' && ip !== 'localhost') {
        const addrListMenu = conn.client.menu('/ip/firewall/address-list');
        const addrLists = await addrListMenu.get();
        const existingList = addrLists.find(a => 
          (a.list === 'BLACKLIST_BRUTEFORCE' || a.list === 'BLACKLIST_ANOMALY') && 
          a.address === ip
        );

        if (!existingList) {
          await addrListMenu.add({
            list: 'BLACKLIST_BRUTEFORCE',
            address: ip,
            timeout: '1d',
            comment: `AI_BLOCKED: ${service.toUpperCase()} (${count}x gagal, user: ${targetsStr})`
          });
          actionsTaken.push(`IP ${ip} dimasukkan ke Firewall Address-List 'BLACKLIST_BRUTEFORCE' (timeout 1 hari)`);
          isNewlyBlocked = true;
        } else {
          actionsTaken.push(`IP ${ip} sudah terdaftar di Blacklist Firewall`);
        }

        // Pastikan filter drop aktif
        await this.ensureFirewallDropRules(conn);
      }
    } catch (err) {
      logger.error(`[SecurityWatchdog] Gagal blokir target di MikroTik ${routerName}: ${err.message}`);
      actionsTaken.push(`Error blokir: ${err.message}`);
    }

    return { actionsTaken, isNewlyBlocked };
  }

  /**
   * Buka Blokir IP atau MAC Address di MikroTik & Billing
   */
  async unblockMikrotikTarget({ target, routerId = null }) {
    if (!target) return { success: false, message: 'Target IP atau MAC address harus disebutkan.' };
    const cleanTarget = String(target).trim();
    const isMac = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/.test(cleanTarget);
    const mt = require('./mikrotikService');

    let routers = [];
    if (routerId) {
      const r = db.prepare('SELECT id, name, host FROM routers WHERE id = ?').get(routerId);
      if (r) routers.push(r);
    } else {
      routers = db.prepare('SELECT id, name, host FROM routers WHERE is_active = 1').all() || [];
    }

    if (routers.length === 0) {
      return { success: false, message: 'Tidak ditemukan router MikroTik yang aktif.' };
    }

    const unblockedDetails = [];

    for (const r of routers) {
      try {
        const conn = await mt.getConnection(r.id);
        if (!conn || !conn.client) continue;

        // 1. Jika MAC Address: buka dari /ip hotspot ip-binding
        if (isMac) {
          const ipBindingMenu = conn.client.menu('/ip/hotspot/ip-binding');
          const bindings = await ipBindingMenu.get();
          for (const b of bindings) {
            const m = (b['mac-address'] || b.macAddress || '').toUpperCase();
            if (m === cleanTarget.toUpperCase() && b.type === 'blocked') {
              await ipBindingMenu.remove(b['.id']).catch(() => {});
              unblockedDetails.push(`Router ${r.name}: Menghapus blokir MAC ${cleanTarget} dari Hotspot IP-Binding`);
            }
          }
        }

        // 2. Jika IP Address (atau buka MAC binding yang terkait IP)
        if (!isMac) {
          const addrListMenu = conn.client.menu('/ip/firewall/address-list');
          const addrLists = await addrListMenu.get();
          for (const a of addrLists) {
            if (a.address === cleanTarget && (a.list === 'BLACKLIST_BRUTEFORCE' || a.list === 'BLACKLIST_ANOMALY')) {
              await addrListMenu.remove(a['.id']).catch(() => {});
              unblockedDetails.push(`Router ${r.name}: Menghapus IP ${cleanTarget} dari Firewall Address-List '${a.list}'`);
            }
          }

          // Cek juga apakah ada IP binding blocked dengan address ini
          const ipBindingMenu = conn.client.menu('/ip/hotspot/ip-binding');
          const bindings = await ipBindingMenu.get();
          for (const b of bindings) {
            if (b.address === cleanTarget && b.type === 'blocked') {
              await ipBindingMenu.remove(b['.id']).catch(() => {});
              unblockedDetails.push(`Router ${r.name}: Menghapus blokir IP ${cleanTarget} dari Hotspot IP-Binding`);
            }
          }

          // Hapus dari in-memory blacklist web app
          this.unblockIp(cleanTarget);
        }

        await conn.api.close().catch(() => {});
      } catch (err) {
        logger.warn(`[SecurityWatchdog] Gagal unblock di router ${r.name}: ${err.message}`);
      }
    }

    // Catat ke audit log
    this._recordAudit({
      action: 'SECURITY_TARGET_UNBLOCKED',
      entity_type: isMac ? 'mac_address' : 'ip_address',
      entity_id: cleanTarget,
      details: {
        target: cleanTarget,
        isMac,
        unblockedDetails
      }
    });

    if (unblockedDetails.length === 0) {
      return {
        success: true,
        message: `Target ${cleanTarget} tidak ditemukan dalam daftar blokir aktif di MikroTik, atau sudah tidak diblokir.`
      };
    }

    return {
      success: true,
      message: `✅ Berhasil membuka blokir untuk ${cleanTarget}:\n` + unblockedDetails.map(d => `• ${d}`).join('\n')
    };
  }

  /**
   * Pindai log MikroTik untuk mendeteksi brute-force:
   * A. Hotspot login brute-force (acak user/voucher gagal berulang kali)
   * B. Admin management brute-force (Winbox, SSH, Telnet, API, Web, FTP)
   * Dan langsung eksekusi penindakan (Auto-Block) serta kirim notifikasi siaga.
   */
  async scanMikrotikLoginFailures(options = {}) {
    const isManualTrigger = Boolean(options.manual);
    const summary = {
      scannedRouters: 0,
      totalFailuresFound: 0,
      threatsDetected: [],
      blockedCount: 0
    };

    try {
      const mt = require('./mikrotikService');
      const routers = db.prepare("SELECT id, name, host FROM routers WHERE is_active = 1").all() || [];
      const autoBlockEnabled = getSetting('security_auto_block_enabled', true);
      const hotspotThreshold = Math.max(Number(getSetting('security_hotspot_threshold', 5)) || 5, 2);
      const adminThreshold = Math.max(Number(getSetting('security_admin_threshold', 5)) || 5, 2);

      for (const r of routers) {
        summary.scannedRouters++;
        try {
          const conn = await mt.getConnection(r.id);
          if (!conn || !conn.client) continue;

          // Ambil log dari MikroTik
          const logs = await conn.client.menu('/log').get();
          if (!Array.isArray(logs) || logs.length === 0) {
            await conn.api.close().catch(() => {});
            continue;
          }

          let processedSet = processedLogIdsByRouter.get(r.id);
          if (!processedSet) {
            processedSet = new Set();
            processedLogIdsByRouter.set(r.id, processedSet);
          }

          // Filter log kegagalan login
          const failures = [];
          for (const l of logs) {
            const logId = l['.id'] || l.id;
            if (!isManualTrigger && processedSet.has(logId)) continue;
            processedSet.add(logId);

            const msg = String(l.message || '');
            const lowerMsg = msg.toLowerCase();
            const topics = String(l.topics || '').toLowerCase();

            const isFail = lowerMsg.includes('login failure') || 
                           lowerMsg.includes('login failed') || 
                           (lowerMsg.includes('failure') && lowerMsg.includes('user'));

            if (isFail) {
              failures.push({ ...l, topicsRaw: topics });
            }
          }

          // Batasi ukuran set agar tidak bocor memori (pertahankan 1000 ID terakhir)
          if (processedSet.size > 2500) {
            const arr = Array.from(processedSet);
            processedSet = new Set(arr.slice(-1000));
            processedLogIdsByRouter.set(r.id, processedSet);
          }

          if (failures.length === 0) {
            await conn.api.close().catch(() => {});
            continue;
          }

          summary.totalFailuresFound += failures.length;

          // Kelompokkan kegagalan berdasarkan IP penyerang
          const failuresByIp = new Map();

          for (const f of failures) {
            const msg = f.message || '';
            const lowerMsg = msg.toLowerCase();
            const topics = f.topicsRaw || '';

            // 1. Coba regex Admin Login Failure:
            // "login failure for user admin from 192.168.1.50 via winbox"
            const adminMatch = msg.match(/login failure for user\s+(\S+)\s+from\s+([0-9a-fA-F.:]+)(?:\s+via\s+(\S+))?/i) ||
                               msg.match(/failure.*user\s+(\S+).*from\s+([0-9a-fA-F.:]+)(?:\s+via\s+(\S+))?/i);

            if (adminMatch) {
              const targetUser = adminMatch[1] || 'unknown';
              const attackerIp = String(adminMatch[2] || '').replace(/^::ffff:/, '').trim();
              const service = adminMatch[3] || 'winbox/ssh';

              if (attackerIp && attackerIp !== '127.0.0.1' && attackerIp !== 'localhost') {
                if (!failuresByIp.has(attackerIp)) {
                  failuresByIp.set(attackerIp, {
                    type: 'admin',
                    count: 1,
                    targets: new Set([targetUser]),
                    service: service.toLowerCase(),
                    reasons: new Set(['password_salah']),
                    routerId: r.id,
                    routerName: r.name,
                    routerHost: r.host
                  });
                } else {
                  const item = failuresByIp.get(attackerIp);
                  item.count++;
                  item.targets.add(targetUser);
                }
              }
              continue;
            }

            // 2. Coba regex Hotspot Login Failure:
            // "->: 99285 (192.168.100.242): login failed: invalid username or password"
            // "yogi55 (192.168.100.88): login failed: invalid username or password"
            const isHotspotTopic = topics.includes('hotspot') || lowerMsg.includes('hotspot');

            if (isHotspotTopic || lowerMsg.includes('login failed')) {
              // 2a. ABAIKAN aktivitas normal / cache / relogin / limit sesi (BUKAN brute force):
              const isBenignHotspot = 
                lowerMsg.includes('no more sessions') ||
                lowerMsg.includes('already authorizing') ||
                lowerMsg.includes('mac-cookie') ||
                lowerMsg.includes('cookie') ||
                lowerMsg.includes('session limit') ||
                lowerMsg.includes('uptime limit') ||
                lowerMsg.includes('traffic limit') ||
                lowerMsg.includes('logged in') ||
                lowerMsg.includes('logged out');

              if (isBenignHotspot) {
                // Abaikan aktivitas normal user
                continue;
              }

              // 2b. HANYA proses jika kegagalan karena kredensial salah / user tidak ditemukan
              const isCredentialFailure = 
                lowerMsg.includes('invalid username or password') ||
                lowerMsg.includes('user not found') ||
                lowerMsg.includes('invalid password') ||
                lowerMsg.includes('cannot find user');

              if (!isCredentialFailure) {
                // Bukan kesalahan username/password, abaikan
                continue;
              }

              const hotspotMatch = msg.match(/(?:->:\s*)?(\S+)\s*\(([0-9a-fA-F.:]+)\):\s*login failed:\s*(.+)/i) ||
                                   msg.match(/login failed:\s*(?:user\s+(\S+)\s+)?(?:from\s+)?([0-9a-fA-F.:]+)?(?:\s*\((.+)\))?/i);

              let targetUser = 'voucher-hotspot';
              let attackerIp = '';
              let reason = 'invalid username or password';

              if (hotspotMatch) {
                targetUser = hotspotMatch[1] || 'voucher-hotspot';
                attackerIp = String(hotspotMatch[2] || '').replace(/^::ffff:/, '').trim();
                reason = hotspotMatch[3] || 'invalid username or password';
              } else {
                const ipInParen = msg.match(/\(([0-9a-fA-F.:]+)\)/);
                if (ipInParen) attackerIp = ipInParen[1];
              }

              // Bersihkan format username dari karakter sisa regex
              targetUser = targetUser.replace(/^[->:\s]+/, '').replace(/[:\s]+$/, '').trim();

              if (attackerIp && attackerIp !== '127.0.0.1' && attackerIp !== 'localhost') {
                if (!failuresByIp.has(attackerIp)) {
                  failuresByIp.set(attackerIp, {
                    type: 'hotspot',
                    count: 1,
                    targets: new Set([targetUser]),
                    service: 'hotspot',
                    reasons: new Set([reason]),
                    routerId: r.id,
                    routerName: r.name,
                    routerHost: r.host
                  });
                } else {
                  const item = failuresByIp.get(attackerIp);
                  item.count++;
                  item.targets.add(targetUser);
                  item.reasons.add(reason);
                }
              }
            }
          }

          // Periksa setiap IP yang melampaui kriteria serangan brute force
          const now = Date.now();
          for (const [attackerIp, data] of failuresByIp.entries()) {
            let isThreat = false;
            let threatReason = '';

            if (data.type === 'admin') {
              // Serangan Admin Management (Winbox, SSH, Telnet, API, WebFig): adminThreshold gagal
              if (data.count >= adminThreshold) {
                isThreat = true;
                threatReason = `Brute force login admin (${data.service.toUpperCase()}) sebanyak ${data.count}x percobaan`;
              }
            } else if (data.type === 'hotspot') {
              // Serangan Hotspot Brute Force (Tebak Voucher / User Acak):
              // HANYA JIKA mencoba BEBERAPA USERNAME/VOUCHER BERBEDA (minimal minDistinctUsers berbeda dan minimal hotspotThreshold gagal)
              const distinctUsersCount = data.targets.size;
              const minDistinctUsers = Math.max(Number(getSetting('security_hotspot_distinct_users', 3)) || 3, 2);
              const minAttempts = hotspotThreshold;

              if (distinctUsersCount >= minDistinctUsers && data.count >= minAttempts) {
                isThreat = true;
                threatReason = `Mencoba login Hotspot acak dengan ${distinctUsersCount} user/voucher berbeda (${data.count}x gagal)`;
              } else {
                // Jika hanya 1 atau 2 user (seperti user 'ompong' mencoba ulang atau cache peramban),
                // BUKAN serangan acak, sehingga JANGAN DIBLOKIR.
                logger.info(`[SecurityWatchdog] IP ${attackerIp} diabaikan: hanya mencoba ${distinctUsersCount} user (${Array.from(data.targets).join(', ')}), bukan brute force acak.`);
              }
            }

            if (isThreat) {
              const cacheKey = `${r.id}:${attackerIp}`;
              const lastAlert = mikrotikAlertCache.get(cacheKey) || 0;

              // Resolusi Alamat MAC
              const macAddress = await this.resolveMacFromIp(conn, attackerIp, logs);
              const targetsStr = Array.from(data.targets).join(', ');
              const reasonsStr = Array.from(data.reasons).join('; ') || 'invalid credential';

              summary.threatsDetected.push({
                router: r.name,
                ip: attackerIp,
                mac: macAddress || '-',
                type: data.type,
                service: data.service,
                count: data.count,
                targets: targetsStr
              });

              // Eksekusi Pemblokiran Otomatis di MikroTik jika diaktifkan
              let actionResults = [];
              let isNewlyBlocked = false;
              if (autoBlockEnabled) {
                const blockRes = await this.blockMikrotikTarget({
                  conn,
                  routerId: r.id,
                  routerName: r.name,
                  ip: attackerIp,
                  mac: macAddress,
                  reason: reasonsStr,
                  count: data.count,
                  targets: data.targets,
                  service: data.service
                });
                actionResults = blockRes.actionsTaken || [];
                isNewlyBlocked = blockRes.isNewlyBlocked || false;
                if (isNewlyBlocked) summary.blockedCount++;
              }

              // DEDUKLIKASI PINTAR: Cek apakah target ini sudah pernah di-alert dalam 6 jam terakhir
              const hasRecentAlertInDb = db.prepare(`
                SELECT id FROM audit_trail 
                WHERE (ip_address = ? OR entity_id LIKE '%' || ? || '%')
                  AND action LIKE '%BRUTE_FORCE%' 
                  AND created_at >= datetime('now', '-6 hours')
                LIMIT 1
              `).get(attackerIp, attackerIp);

              const isDuplicate = !isNewlyBlocked && (hasRecentAlertInDb || (now - lastAlert <= 6 * 60 * 60 * 1000));
              if (isDuplicate) {
                logger.info(`[SecurityWatchdog] Target ${attackerIp} sudah berstatus terblokir di MikroTik dan alert sudah terkirim sebelumnya. Melewati pengiriman ulang alert Telegram.`);
                continue;
              }

              // Catat waktu alert
              if (now - lastAlert > 15 * 60 * 1000 || isNewlyBlocked) {
                mikrotikAlertCache.set(cacheKey, now);

                const ipSpoken = formatIpForSpeech(attackerIp);
                logger.warn(`[SecurityWatchdog] Terdeteksi brute-force ${data.type.toUpperCase()} di '${r.name}' dari ${attackerIp} (MAC: ${macAddress || '-'}, ${data.count}x via ${data.service})`);

                // 1. ANNOUNCEMENT VOICE VIA SOUNDBOX (SPEAKER KASIR / ADMIN)
                const attackTypeLabel = data.type === 'hotspot' ? 'hotspot voucher' : `admin ${data.service}`;
                const speechText = autoBlockEnabled
                  ? `Peringatan darurat! Terdeteksi serangan brute force login ${attackTypeLabel} pada router MikroTik ${r.name} dari alamat i pe ${ipSpoken}. Sistem telah memblokir akses tersebut secara otomatis.`
                  : `Peringatan siaga! Terdeteksi aktivitas brute force login ${attackTypeLabel} pada router MikroTik ${r.name} dari alamat i pe ${ipSpoken}. Pemblokiran otomatis saat ini dinonaktifkan.`;
                
                soundboxSvc.queueSoundboxEvent({
                  type: 'security_alert',
                  title: `PERINGATAN BRUTE FORCE ${data.type.toUpperCase()}`,
                  speechText: speechText,
                  amount: 0,
                  customerName: `Router: ${r.name} | IP: ${attackerIp} | MAC: ${macAddress || '-'}`
                });

                // 2. KIRIM NOTIFIKASI SIAGA KE TELEGRAM ADMIN & WHATSAPP
                const actionListText = autoBlockEnabled && actionResults.length > 0 
                  ? actionResults.map(a => `• ✅ ${a}`).join('\n')
                  : '• ⚠️ Auto-block dinonaktifkan di pengaturan (Hanya pantau & notifikasi, target tidak diblokir).';

                const alertHeader = autoBlockEnabled
                  ? `🚨 *PERINGATAN KEAMANAN (BRUTE FORCE DIBLOKIR OTOMATIS)*`
                  : `⚠️ *PERINGATAN KEAMANAN (BRUTE FORCE TERDETEKSI - AUTO BLOCK OFF)*`;

                const alertTip = autoBlockEnabled
                  ? `_💡 Tips Admin: Untuk membuka blokir kembali, Anda cukup chat bot: "Buka blokir IP ${attackerIp}" atau "Buka blokir MAC ${macAddress || ''}"_`
                  : `_💡 Tips Admin: Auto-block sedang nonaktif. Jika ingin memblokirnya manual, chat bot: "Blokir IP ${attackerIp}". Untuk mengaktifkan kembali blokir otomatis, chat: "Aktifkan auto block"._`;

                const alertMessage = 
                  `${alertHeader}\n\n` +
                  `Sistem mendeteksi aktivitas mencurigakan pada Router *${r.name}* (${r.host}):\n\n` +
                  `🛡️ *Kategori Serangan:* ${data.type === 'hotspot' ? '🔥 Hotspot Login Brute Force' : '⚠️ Admin Management Brute Force'}\n` +
                  `🌐 *Alamat IP Penyerang:* \`${attackerIp}\`\n` +
                  `📱 *Alamat MAC:* \`${macAddress || '(Tidak terdeteksi)'}\`\n` +
                  `🔌 *Layanan:* ${data.service.toUpperCase()}\n` +
                  `👤 *Target User / Voucher:* \`${targetsStr.slice(0, 100)}\`\n` +
                  `📊 *Jumlah Percobaan Gagal:* *${data.count} kali*\n` +
                  `⏱️ *Waktu Deteksi:* ${new Date().toLocaleString('id-ID')}\n\n` +
                  `*Status Tindakan:*\n${actionListText}\n\n` +
                  alertTip;

                await this._notifyAdmin(alertMessage);

                // 3. CATAT KE AUDIT TRAIL
                this._recordAudit({
                  action: autoBlockEnabled 
                    ? (data.type === 'hotspot' ? 'HOTSPOT_BRUTE_FORCE_BLOCKED' : 'ROUTER_BRUTE_FORCE_BLOCKED')
                    : (data.type === 'hotspot' ? 'HOTSPOT_BRUTE_FORCE_DETECTED' : 'ROUTER_BRUTE_FORCE_DETECTED'),
                  entity_type: 'mikrotik_intrusion',
                  entity_id: `${r.name}:${attackerIp}:${macAddress || 'no-mac'}`,
                  details: {
                    router: r.name,
                    routerHost: r.host,
                    attackerIp,
                    macAddress,
                    attackType: data.type,
                    service: data.service,
                    count: data.count,
                    targets: Array.from(data.targets),
                    autoBlockEnabled,
                    actionsTaken: actionResults
                  },
                  ip_address: attackerIp
                });
              }
            }
          }

          await conn.api.close().catch(() => {});
        } catch (err) {
          logger.warn(`[SecurityWatchdog] Scan router ${r.name} error: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[SecurityWatchdog] Scan MikroTik failures fatal: ${e.message}`);
    }

    return summary;
  }

  /**
   * Ringkasan status keamanan dan daftar blokir aktif di MikroTik & Billing
   */
  async getDetailedSecurityStatus() {
    const mt = require('./mikrotikService');
    const routers = db.prepare("SELECT id, name, host FROM routers WHERE is_active = 1").all() || [];

    const mikrotikBlockedIps = [];
    const mikrotikBlockedMacs = [];

    for (const r of routers) {
      try {
        const conn = await mt.getConnection(r.id);
        if (!conn || !conn.client) continue;

        // Ambil IP address-list yang diblokir
        const addrListMenu = conn.client.menu('/ip/firewall/address-list');
        const addrLists = await addrListMenu.get();
        for (const a of addrLists) {
          if (a.list === 'BLACKLIST_BRUTEFORCE' || a.list === 'BLACKLIST_ANOMALY') {
            mikrotikBlockedIps.push({
              router: r.name,
              address: a.address,
              list: a.list,
              timeout: a.timeout || '-',
              comment: a.comment || '-'
            });
          }
        }

        // Ambil MAC IP-Binding yang diblokir
        const ipBindingMenu = conn.client.menu('/ip/hotspot/ip-binding');
        const bindings = await ipBindingMenu.get();
        for (const b of bindings) {
          if (b.type === 'blocked') {
            mikrotikBlockedMacs.push({
              router: r.name,
              mac: (b['mac-address'] || b.macAddress || '-').toUpperCase(),
              address: b.address || '-',
              comment: b.comment || '-'
            });
          }
        }

        await conn.api.close().catch(() => {});
      } catch (err) {
        logger.warn(`[SecurityWatchdog] Gagal get status blokir router ${r.name}: ${err.message}`);
      }
    }

    // App login blocked IPs
    const appBlocked = [];
    const now = Date.now();
    for (const [ip, unblockTime] of blockedIps.entries()) {
      if (now < unblockTime) {
        appBlocked.push({ ip, remainingSeconds: Math.ceil((unblockTime - now) / 1000) });
      }
    }

    // Audit trail terbaru
    let recentAlerts = [];
    try {
      recentAlerts = db.prepare(`
        SELECT * FROM audit_trail 
        WHERE action LIKE '%BRUTE_FORCE%' 
        ORDER BY id DESC LIMIT 15
      `).all() || [];
    } catch (_) {}

    return {
      status: (mikrotikBlockedIps.length > 0 || mikrotikBlockedMacs.length > 0 || appBlocked.length > 0) ? 'guarded' : 'secure',
      policy: {
        autoBlockEnabled: getSetting('security_auto_block_enabled', true),
        hotspotThreshold: Math.max(Number(getSetting('security_hotspot_threshold', 5)) || 5, 2),
        adminThreshold: Math.max(Number(getSetting('security_admin_threshold', 5)) || 5, 2),
        hotspotDistinctUsers: Math.max(Number(getSetting('security_hotspot_distinct_users', 3)) || 3, 2)
      },
      appBlockedIps: appBlocked,
      mikrotikBlockedIps,
      mikrotikBlockedMacs,
      recentAlerts,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Helper: Kirim notifikasi ke Telegram Admin & WhatsApp
   */
  async _notifyAdmin(message) {
    try {
      // 1. Telegram Admin Bot
      const { sendAdminMessage } = require('./telegramBot');
      if (typeof sendAdminMessage === 'function') {
        const ok = await sendAdminMessage(message);
        if (ok) logger.info('[SecurityWatchdog] Notifikasi siaga terkirim ke Telegram Admin');
      }

      // 2. WhatsApp Admin Bot
      const adminPhone = getSetting('admin_phone') || getSetting('company_phone');
      if (adminPhone) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          await sendWA(adminPhone, message);
          logger.info('[SecurityWatchdog] Notifikasi siaga terkirim ke WhatsApp Admin');
        }
      }
    } catch (err) {
      logger.warn(`[SecurityWatchdog] Gagal kirim notifikasi siaga: ${err.message}`);
    }
  }

  /**
   * Helper: Catat audit log
   */
  _recordAudit({ action, entity_type, entity_id, details, ip_address, user_agent }) {
    try {
      const audit = require('./auditTrailService');
      if (audit && typeof audit.logAuditTrail === 'function') {
        audit.logAuditTrail({
          action,
          entity_type,
          entity_id,
          actor_type: 'system',
          actor_id: 'security-watchdog',
          actor_name: 'AI Security Watchdog',
          details,
          ip_address,
          user_agent
        });
      }
    } catch (_) {}
  }
}

const securityWatchdogService = new SecurityWatchdogService();
module.exports = securityWatchdogService;
