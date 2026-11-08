/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Service: Morning Executive Briefing
 * ──────────────────────────────────────────────────────────────────────────────
 * Menyajikan ringkasan eksekutif harian kondisi operasional RT/RW Net & ISP:
 * 1. Keuangan & Kasir: Pemasukan kemarin, bulan berjalan, tagihan tertunda, dan voucher.
 * 2. Kesehatan Jaringan: Sesi PPPoE aktif di MikroTik, status ONT di ACS, dan redaman kritis.
 * 3. Keamanan: Rangkuman penangkalan brute force, auto-block status, dan blacklist.
 * 4. Layanan: Tiket komplain pelanggan yang masih open / in-progress.
 */

'use strict';

const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

class MorningBriefingService {

  /**
   * Mengumpulkan semua metrik operasional secara real-time
   */
  async collectBriefingMetrics() {
    const metrics = {
      timestamp: new Date(),
      invoices: { yesterday: { count: 0, total: 0 }, thisMonth: { count: 0, total: 0 }, unpaid: { count: 0, total: 0 } },
      vouchers: { yesterday: { count: 0, total: 0 }, thisMonth: { count: 0, total: 0 } },
      network: { activePppoe: 0, totalAcs: 0, onlineAcs: 0, offlineAcs: 0, criticalOptical: [] },
      security: { autoBlock: true, blockedIps: 0, blockedMacs: 0, attacksLast24h: 0 },
      tickets: { openCount: 0, sampleTickets: [] }
    };

    // 1. KEUANGAN & INVOICE
    try {
      const yesterdayInv = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total 
        FROM invoices 
        WHERE status = 'paid' AND date(paid_at) = date('now', '-1 day', 'localtime')
      `).get();
      if (yesterdayInv) metrics.invoices.yesterday = yesterdayInv;

      const thisMonthInv = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total 
        FROM invoices 
        WHERE status = 'paid' AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now', 'localtime')
      `).get();
      if (thisMonthInv) metrics.invoices.thisMonth = thisMonthInv;

      const unpaidInv = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total 
        FROM invoices 
        WHERE status = 'unpaid'
      `).get();
      if (unpaidInv) metrics.invoices.unpaid = unpaidInv;
    } catch (err) {
      logger.warn(`[MorningBriefing] Gagal query invoice: ${err.message}`);
    }

    // 2. PENJUALAN VOUCHER HOTSPOT
    try {
      const yesterdayVch = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(price), 0) as total 
        FROM public_voucher_orders 
        WHERE status = 'paid' AND date(paid_at) = date('now', '-1 day', 'localtime')
      `).get();
      if (yesterdayVch) metrics.vouchers.yesterday = yesterdayVch;

      const thisMonthVch = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(price), 0) as total 
        FROM public_voucher_orders 
        WHERE status = 'paid' AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now', 'localtime')
      `).get();
      if (thisMonthVch) metrics.vouchers.thisMonth = thisMonthVch;
    } catch (_) {}

    // 3. KESEHATAN JARINGAN (PPPOE MIKROTIK & ONT ACS)
    try {
      const mt = require('./mikrotikService');
      const activeMap = await mt.getActivePppoeSessionsMap().catch(() => new Map());
      metrics.network.activePppoe = activeMap ? activeMap.size : 0;
    } catch (err) {
      logger.warn(`[MorningBriefing] Gagal cek PPPoE MikroTik: ${err.message}`);
    }

    try {
      const acsDevs = db.prepare(`
        SELECT a.id, a.serial_number, a.manufacturer, a.params, a.last_inform,
               c.name as customer_name, c.address as customer_address, o.name as odp_name
        FROM acs_devices a
        LEFT JOIN customers c ON (c.genieacs_tag = a.serial_number OR a.tags LIKE '%' || c.name || '%')
        LEFT JOIN odps o ON c.odp_id = o.id
      `).all() || [];

      metrics.network.totalAcs = acsDevs.length;
      const nowMs = Date.now();
      const onlineThresholdMs = 15 * 60 * 1000; // 15 menit

      for (const d of acsDevs) {
        const lastMs = d.last_inform ? new Date(d.last_inform).getTime() : 0;
        const isOnline = (nowMs - lastMs) <= onlineThresholdMs;
        if (isOnline) {
          metrics.network.onlineAcs++;
        } else {
          metrics.network.offlineAcs++;
        }

        // Ekstraksi Redaman Optik (RX Power)
        let params = {};
        try { params = JSON.parse(d.params || '{}'); } catch (_) {}
        let rxVal = null;
        for (const [k, v] of Object.entries(params)) {
          if (k.toLowerCase().includes('rxpower') || k.toLowerCase().includes('redaman') || k.toLowerCase().includes('opticalsignallevel')) {
            const val = typeof v === 'object' ? (v._value !== undefined ? v._value : v) : v;
            if (val !== undefined && val !== null && val !== '' && val !== '-') {
              const raw = parseFloat(val);
              if (!isNaN(raw)) {
                if (raw === 0 || raw >= 65535) rxVal = 'LOS';
                else if (raw < 0 && raw > -50) rxVal = raw;
                else if (raw <= -50) rxVal = raw / 100;
                else if (raw > 0) rxVal = Math.round((30 + (Math.log10(raw * 1e-7) * 10)) * 100) / 100;
                break;
              }
            }
          }
        }

        if (rxVal === 'LOS' || (typeof rxVal === 'number' && rxVal <= -27)) {
          metrics.network.criticalOptical.push({
            id: d.id,
            sn: d.serial_number,
            manufacturer: d.manufacturer || 'ONT',
            rx: rxVal,
            customer: d.customer_name || 'Belum di-bind',
            odp: d.odp_name || '-'
          });
        }
      }
    } catch (err) {
      logger.warn(`[MorningBriefing] Gagal analisis perangkat ACS: ${err.message}`);
    }

    // 4. KEAMANAN & WATCHDOG
    try {
      const securityWatchdog = require('./securityWatchdogService');
      const secStatus = await securityWatchdog.getDetailedSecurityStatus().catch(() => ({}));
      metrics.security.autoBlock = secStatus.policy ? secStatus.policy.autoBlockEnabled : getSetting('security_auto_block_enabled', true);
      metrics.security.blockedIps = secStatus.mikrotikBlockedIps ? secStatus.mikrotikBlockedIps.length : 0;
      metrics.security.blockedMacs = secStatus.mikrotikBlockedMacs ? secStatus.mikrotikBlockedMacs.length : 0;

      const attacks24h = db.prepare(`
        SELECT COUNT(*) as count 
        FROM audit_trail 
        WHERE action LIKE '%BRUTE_FORCE%' AND created_at >= datetime('now', '-24 hours')
      `).get();
      metrics.security.attacksLast24h = attacks24h ? attacks24h.count : 0;
    } catch (_) {}

    // 5. TIKET KOMPLAIN & GANGGUAN
    try {
      const openTix = db.prepare(`
        SELECT t.id, t.subject, t.status, COALESCE(c.name, 'Umum') as customer_name
        FROM tickets t
        LEFT JOIN customers c ON t.customer_id = c.id
        WHERE t.status IN ('open', 'in_progress', 'pending')
        ORDER BY t.created_at DESC LIMIT 5
      `).all() || [];

      const totalOpenTix = db.prepare(`
        SELECT COUNT(*) as count FROM tickets WHERE status IN ('open', 'in_progress', 'pending')
      `).get();

      metrics.tickets.openCount = totalOpenTix ? totalOpenTix.count : 0;
      metrics.tickets.sampleTickets = openTix;
    } catch (_) {}

    return metrics;
  }

  /**
   * Format metrik menjadi pesan Markdown Telegram yang rapi dan elegan
   */
  formatBriefingMessage(m) {
    const formatRp = (num) => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

    const tz = getSetting('timezone', 'Asia/Jakarta') || 'Asia/Jakarta';
    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).replace('.', ':');

    let msg = `☀️ *MORNING EXECUTIVE BRIEFING — ALIJAYA NET*\n`;
    msg += `📅 *${dateStr}* | ⏰ *${timeStr} WIB*\n\n`;

    // 1. KEUANGAN
    msg += `💰 *KEUANGAN & OMZET:*\n`;
    msg += `• Pemasukan Kemarin: *${formatRp(m.invoices.yesterday.total)}* (${m.invoices.yesterday.count} tagihan lunas)\n`;
    msg += `• Pemasukan Bulan Berjalan: *${formatRp(m.invoices.thisMonth.total)}* (${m.invoices.thisMonth.count} tagihan)\n`;
    if (m.vouchers.yesterday.count > 0 || m.vouchers.thisMonth.count > 0) {
      msg += `• Penjualan Hotspot Kemarin: *${formatRp(m.vouchers.yesterday.total)}* (${m.vouchers.yesterday.count} voucher)\n`;
    }
    msg += `• Tagihan Belum Terbayar: *${m.invoices.unpaid.count} Pelanggan* (${formatRp(m.invoices.unpaid.total)})\n\n`;

    // 2. KESEHATAN JARINGAN & ONT
    msg += `📡 *KESEHATAN JARINGAN & ONT:*\n`;
    msg += `• Sesi PPPoE Online: *${m.network.activePppoe} Pelanggan Aktif*\n`;
    msg += `• Status ONT TR-069: *${m.network.onlineAcs} Online* / ${m.network.totalAcs} Total Perangkat\n`;
    if (m.network.criticalOptical.length > 0) {
      msg += `• ⚠️ *Redaman Optik Kritis (≥ -27 dBm / LOS):* *${m.network.criticalOptical.length} Perangkat*\n`;
      m.network.criticalOptical.slice(0, 4).forEach((dev, idx) => {
        const rxLabel = dev.rx === 'LOS' ? '🔴 LOS' : `⚠️ ${dev.rx} dBm`;
        msg += `  ${idx + 1}. *${dev.customer}* (${dev.sn}): *${rxLabel}* [ODP: ${dev.odp}]\n`;
      });
      if (m.network.criticalOptical.length > 4) {
        msg += `  _...dan ${m.network.criticalOptical.length - 4} perangkat lainnya._\n`;
      }
    } else {
      msg += `• Redaman Optik: *✅ Semua normal (< -27 dBm)*\n`;
    }
    msg += `\n`;

    // 3. KEAMANAN & PENGAMANAN BRUTE FORCE
    msg += `🛡️ *KEAMANAN SISTEM:*\n`;
    msg += `• Auto-Block Brute Force: *${m.security.autoBlock ? '🟢 AKTIF' : '🔴 NONAKTIF (Hanya Notif)'}*\n`;
    msg += `• Blacklist MikroTik: *${m.security.blockedIps} IP* | *${m.security.blockedMacs} MAC Hotspot*\n`;
    msg += `• Serangan Ditangkal (24 Jam): *${m.security.attacksLast24h} kali*\n\n`;

    // 4. TIKET & TUGAS LAPANGAN
    msg += `🎫 *TIKET & GANGGUAN:*\n`;
    if (m.tickets.openCount > 0) {
      msg += `• Tiket Aktif/Pending: *${m.tickets.openCount} Tiket*\n`;
      m.tickets.sampleTickets.slice(0, 3).forEach((t, idx) => {
        msg += `  ${idx + 1}. [${t.status.toUpperCase()}] *${t.customer_name}*: ${t.subject}\n`;
      });
    } else {
      msg += `• Tiket Aktif: *✅ Nihil (Tidak ada komplain terbuka)*\n`;
    }

    msg += `\n══════════════════════════════\n`;
    msg += `_💡 Semoga hari ini penuh berkah dan jaringan selalu lancar! Anda bisa membalas chat ini untuk perintah langsung apa pun._`;

    return msg;
  }

  /**
   * Menghasilkan teks briefing langsung
   */
  async getFormattedBriefing() {
    const metrics = await this.collectBriefingMetrics();
    return this.formatBriefingMessage(metrics);
  }

  /**
   * Mengirim briefing pagi ke Telegram Admin secara otomatis
   */
  async sendMorningBriefing() {
    try {
      logger.info('[MorningBriefing] Mempersiapkan Morning Executive Briefing...');
      const msg = await this.getFormattedBriefing();

      const { sendAdminMessage } = require('./telegramBot');
      if (typeof sendAdminMessage === 'function') {
        const ok = await sendAdminMessage(msg);
        if (ok) {
          logger.info('[MorningBriefing] Berhasil mengirim Morning Executive Briefing ke Telegram Admin.');
        } else {
          logger.warn('[MorningBriefing] Gagal mengirim briefing ke Telegram Admin.');
        }
      }

      // Bunyikan Soundbox Kasir (opsional)
      try {
        const soundboxSvc = require('./soundboxService');
        soundboxSvc.queueSoundboxEvent({
          type: 'morning_briefing',
          title: 'Morning Briefing',
          speechText: 'Selamat pagi Admin Alijaya Net. Laporan eksekutif pagi telah dikirim ke Telegram Anda.',
          amount: 0,
          customerName: 'System'
        });
      } catch (_) {}

      return true;
    } catch (err) {
      logger.error(`[MorningBriefing] Error eksekusi briefing: ${err.message}`);
      return false;
    }
  }
}

module.exports = new MorningBriefingService();
