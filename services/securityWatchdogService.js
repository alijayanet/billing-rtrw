/**
 * Service: AI Security & Brute-Force Anomaly Watchdog
 * Mendeteksi anomali serangan brute force pada aplikasi billing dan router MikroTik.
 * Mengumumkan peringatan darurat secara otomatis melalui Voice TTS (Soundbox)
 * serta mengirim notifikasi siaga ke WhatsApp & Telegram Admin.
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

const WINDOW_MS = 5 * 60 * 1000; // 5 menit
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 menit
const WARNING_THRESHOLD = 3;
const CRITICAL_THRESHOLD = 5;

/**
 * Mengonversi IP address menjadi format lisan ramah suara TTS
 * Contoh: "192.168.8.50" -> "1 9 2 titik 1 6 8 titik 8 titik 5 0"
 */
function formatIpForSpeech(ip) {
  if (!ip) return 'tidak diketahui';
  const cleanIp = String(ip).replace(/^::ffff:/, '');
  return cleanIp.split('.').map(octet => octet.split('').join(' ')).join(' titik ');
}

class SecurityWatchdogService {
  /**
   * Cek apakah IP sedang dalam masa blokir sementara
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
   * Buka blokir IP secara manual
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

    // Jika login berhasil, reset kegagalan IP ini
    if (success) {
      failedAttemptsByIp.delete(ip);
      return { allowed: true };
    }

    // Login Gagal: Ambil atau buat record tracking
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

    // Cek Ambang Batas Kritis (Brute Force Detected)
    if (record.count >= CRITICAL_THRESHOLD && !record.alerted) {
      record.alerted = true;
      blockedIps.set(ip, now + BLOCK_DURATION_MS);

      const targetList = Array.from(record.usernames).filter(Boolean).join(', ') || 'admin';
      const ipSpoken = formatIpForSpeech(ip);

      // 1. ANNOUNCEMENT VOICE VIA SOUNDBOX (SPEAKER KASIR / ADMIN)
      const speechText = `Peringatan keamanan! Terdeteksi anomali percobaan login gagal berulang kali ke aplikasi ${type} dari alamat i pe ${ipSpoken}. Sistem telah memblokir sementara akses tersebut.`;
      
      soundboxSvc.queueSoundboxEvent({
        type: 'security_alert',
        title: 'PERINGATAN BRUTE FORCE APLIKASI',
        speechText: speechText,
        amount: 0,
        customerName: `IP: ${ip} (Target: ${targetList})`
      });

      // 2. KIRIM NOTIFIKASI SIAGA KE WHATSAPP ADMIN
      const waMsg = 
        `🚨 *PERINGATAN KEAMANAN (BRUTE FORCE DETECTED)*\n\n` +
        `Sistem mendeteksi percobaan login gagal berulang kali ke portal *${type.toUpperCase()}*:\n` +
        `🌐 *Alamat IP:* \`${ip}\`\n` +
        `👤 *Target Username:* ${targetList}\n` +
        `📊 *Jumlah Kegagalan:* ${record.count} kali dalam 5 menit\n` +
        `⏱️ *Waktu:* ${new Date().toLocaleString('id-ID')}\n` +
        `🛡️ *Status:* IP telah diblokir sementara selama 15 menit.\n\n` +
        `_Peringatan suara telah dibunyikan otomatis melalui Soundbox._`;

      await this._notifyAdmin(waMsg);

      // 3. CATAT KE AUDIT TRAIL
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
      remaining: Math.max(0, CRITICAL_THRESHOLD - record.count)
    };
  }

  /**
   * Pindai log MikroTik untuk mendeteksi brute-force login SSH / Telnet / Winbox / WebFig
   */
  async scanMikrotikLoginFailures() {
    try {
      const mt = require('./mikrotikService');
      const routers = db.prepare("SELECT id, name, host FROM routers WHERE is_active = 1").all() || [];

      for (const r of routers) {
        try {
          const conn = await mt.getConnection(r.id);
          if (!conn || !conn.client) continue;

          // Ambil log dari MikroTik
          const logs = await conn.client.menu('/log').get();
          if (!Array.isArray(logs) || logs.length === 0) continue;

          // Ambil atau buat set log ID yang sudah diproses agar tidak duplikat
          let processedSet = processedLogIdsByRouter.get(r.id);
          if (!processedSet) {
            processedSet = new Set();
            processedLogIdsByRouter.set(r.id, processedSet);
          }

          // Filter log kegagalan login
          const failures = [];
          for (const l of logs) {
            const logId = l['.id'] || l.id;
            if (processedSet.has(logId)) continue;
            processedSet.add(logId);

            const msg = String(l.message || '');
            if (msg.toLowerCase().includes('login failure') || msg.toLowerCase().includes('failure')) {
              failures.push(l);
            }
          }

          // Bersihkan cache log ID jika terlalu besar
          if (processedSet.size > 2000) {
            processedSet.clear();
          }

          if (failures.length === 0) continue;

          // Kelompokkan kegagalan berdasarkan IP penyerang
          const failuresByIp = new Map();
          for (const f of failures) {
            const msg = f.message || '';
            // Regex MikroTik format: "login failure for user admin from 192.168.1.50 via winbox"
            const match = msg.match(/login failure for user\s+(\S+)\s+from\s+([0-9a-fA-F.:]+)(?:\s+via\s+(\S+))?/i) ||
                          msg.match(/failure.*user\s+(\S+).*from\s+([0-9a-fA-F.:]+)/i);

            if (match) {
              const targetUser = match[1] || 'unknown';
              const attackerIp = String(match[2] || '').replace(/^::ffff:/, '').trim();
              const service = match[3] || 'router-service';

              if (!attackerIp || attackerIp === '127.0.0.1' || attackerIp === 'localhost') continue;

              if (!failuresByIp.has(attackerIp)) {
                failuresByIp.set(attackerIp, { count: 1, targets: new Set([targetUser]), service });
              } else {
                const item = failuresByIp.get(attackerIp);
                item.count++;
                item.targets.add(targetUser);
              }
            }
          }

          // Periksa setiap penyerang
          const now = Date.now();
          for (const [attackerIp, data] of failuresByIp.entries()) {
            if (data.count >= 2) {
              const cacheKey = `${r.id}:${attackerIp}`;
              const lastAlert = mikrotikAlertCache.get(cacheKey) || 0;

              // Debounce alert per IP router tiap 15 menit
              if (now - lastAlert > 15 * 60 * 1000) {
                mikrotikAlertCache.set(cacheKey, now);

                const targetsStr = Array.from(data.targets).join(', ');
                const ipSpoken = formatIpForSpeech(attackerIp);

                logger.warn(`[SecurityWatchdog] Terdeteksi brute-force MikroTik '${r.name}' dari ${attackerIp} (${data.count}x via ${data.service})`);

                // 1. ANNOUNCEMENT VOICE VIA SOUNDBOX (SPEAKER KASIR / ADMIN)
                const speechText = `Peringatan darurat! Terdeteksi serangan brute force ke router MikroTik ${r.name} dari alamat i pe ${ipSpoken} melalui ${data.service}. Segera periksa keamanan router Anda.`;
                
                soundboxSvc.queueSoundboxEvent({
                  type: 'security_alert',
                  title: 'PERINGATAN BRUTE FORCE MIKROTIK',
                  speechText: speechText,
                  amount: 0,
                  customerName: `Router: ${r.name} | IP: ${attackerIp}`
                });

                // 2. KIRIM NOTIFIKASI SIAGA KE WHATSAPP ADMIN
                const waMsg = 
                  `🚨 *PERINGATAN KEAMANAN (SERANGAN MIKROTIK)*\n\n` +
                  `Terdeteksi serangan brute force login pada router *${r.name}* (${r.host}):\n` +
                  `🌐 *IP Penyerang:* \`${attackerIp}\`\n` +
                  `🔌 *Layanan:* ${data.service.toUpperCase()}\n` +
                  `👤 *Target User:* ${targetsStr}\n` +
                  `📊 *Jumlah Percobaan Gagal:* ${data.count} kali\n` +
                  `⏱️ *Waktu:* ${new Date().toLocaleString('id-ID')}\n\n` +
                  `_Peringatan suara darurat telah dibunyikan melalui Soundbox._`;

                await this._notifyAdmin(waMsg);

                // 3. CATAT KE AUDIT TRAIL
                this._recordAudit({
                  action: 'ROUTER_BRUTE_FORCE',
                  entity_type: 'mikrotik_login',
                  entity_id: `${r.name}:${attackerIp}`,
                  details: {
                    router: r.name,
                    routerHost: r.host,
                    attackerIp,
                    service: data.service,
                    count: data.count,
                    targets: Array.from(data.targets)
                  },
                  ip_address: attackerIp
                });
              }
            }
          }
        } catch (err) {
          logger.warn(`[SecurityWatchdog] Scan router ${r.name} error: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[SecurityWatchdog] Scan MikroTik failures fatal: ${e.message}`);
    }
  }

  /**
   * Ringkasan status keamanan saat ini
   */
  getSecurityOverview() {
    const blockedList = [];
    const now = Date.now();
    for (const [ip, unblockTime] of blockedIps.entries()) {
      if (now < unblockTime) {
        blockedList.push({ ip, remainingSeconds: Math.ceil((unblockTime - now) / 1000) });
      }
    }

    let recentAudit = [];
    try {
      recentAudit = db.prepare(`
        SELECT * FROM audit_trail 
        WHERE action IN ('BRUTE_FORCE_BLOCKED', 'ROUTER_BRUTE_FORCE') 
        ORDER BY id DESC LIMIT 10
      `).all() || [];
    } catch (_) {}

    return {
      status: blockedList.length > 0 ? 'warning' : 'secure',
      activeBlockedIps: blockedList,
      recentAlerts: recentAudit,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Helper: Kirim notifikasi ke WhatsApp dan Telegram Admin
   */
  async _notifyAdmin(message) {
    try {
      const adminPhone = getSetting('admin_phone') || getSetting('company_phone');
      if (adminPhone) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          await sendWA(adminPhone, message);
        }
      }

      // Telegram Admin Notification
      const adminChatId = getSetting('telegram_admin_chat_id') || getSetting('telegram_chat_id');
      const botToken = getSetting('telegram_bot_token');
      if (adminChatId && botToken) {
        const axios = require('axios');
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: adminChatId,
          text: message,
          parse_mode: 'Markdown'
        }).catch(() => {});
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
