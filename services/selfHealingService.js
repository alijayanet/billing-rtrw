/**
 * Service: Autonomous Self-Healing & Network Auto-Repair Engine
 * Memindai anomali dan secara otomatis memperbaiki ketidaksesuaian antara
 * Billing System, Router MikroTik, GenieACS TR-069, dan RADIUS Server.
 */
const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const billingSvc = require('./billingService');
const customerSvc = require('./customerService');
const customerDevice = require('./customerDeviceService');
const { logger } = require('../config/logger');
let auditSvc = null;
try { auditSvc = require('./auditTrailService'); } catch (_) {}
let radiusSvc = null;
try { radiusSvc = require('./radiusServerService'); } catch (_) {}

class SelfHealingService {
  /**
   * Jalankan diagnosa lengkap tanpa eksekusi perbaikan (Dry Run / Scan Mode)
   */
  async diagnose() {
    return this.run({ autoRepair: false });
  }

  /**
   * Jalankan diagnosa DAN perbaikan otomatis (Healing Mode)
   */
  async autoRepair(actorName = 'AI Self-Healing Agent') {
    return this.run({ autoRepair: true, actorName });
  }

  /**
   * Mesin Utama Pemindaian & Perbaikan
   */
  async run({ autoRepair = true, actorName = 'System' } = {}) {
    const startTime = Date.now();
    const result = {
      timestamp: new Date().toISOString(),
      mode: autoRepair ? 'repair' : 'scan_only',
      actor: actorName,
      stats: {
        customersChecked: 0,
        routersChecked: 0,
        anomaliesFound: 0,
        anomaliesRepaired: 0,
        failedRepairs: 0
      },
      repairs: [],
      issues: [],
      warnings: [],
      errors: []
    };

    try {
      // ─────────────────────────────────────────────────────────────────
      // 1. SINKRONISASI KONSISTENSI STATUS BILLING VS TAGIHAN PELANGGAN
      // ─────────────────────────────────────────────────────────────────
      await this._healBillingCustomerStatus(result, autoRepair);

      // ─────────────────────────────────────────────────────────────────
      // 2. SINKRONISASI MIKROTIK (PPPoE SECRETS, ISOLIR, FIREWALL)
      // ─────────────────────────────────────────────────────────────────
      await this._healMikrotikConsistency(result, autoRepair);

      // ─────────────────────────────────────────────────────────────────
      // 3. PEMBERSIHAN SESI RADIUS YANG STALE / KADALUARSA
      // ─────────────────────────────────────────────────────────────────
      await this._healRadiusSessions(result, autoRepair);

      // ─────────────────────────────────────────────────────────────────
      // 4. SINKRONISASI GENIEACS & TR-069 MODEM ONU
      // ─────────────────────────────────────────────────────────────────
      await this._healAcsDevices(result, autoRepair);

      result.durationMs = Date.now() - startTime;

      // Catat di Audit Trail jika ada aksi perbaikan yang dieksekusi
      if (autoRepair && result.repairs.length > 0 && auditSvc && typeof auditSvc.logAuditTrail === 'function') {
        try {
          auditSvc.logAuditTrail({
            action: 'UPDATE',
            entity_type: 'self_healing',
            entity_id: 'network_auto_repair',
            actor_type: 'system',
            actor_id: 'ai-agent',
            actor_name: actorName,
            details: {
              repairedCount: result.stats.anomaliesRepaired,
              repairs: result.repairs,
              issues: result.issues
            }
          });
        } catch (_) {}
      }

      logger.info(`[SelfHealing] Pemindaian selesai dalam ${result.durationMs}ms. Ditemukan: ${result.stats.anomaliesFound}, Diperbaiki: ${result.stats.anomaliesRepaired}`);
    } catch (err) {
      logger.error(`[SelfHealing] Fatal error during self-healing: ${err.message}`);
      result.errors.push(`Fatal error: ${err.message}`);
    }

    return result;
  }

  /**
   * 1. Perbaiki Inkonsistensi Status Billing Pelanggan
   * - Pelanggan berstatus isolir/suspended padahal semua tagihannya sudah lunas -> Buka Isolir
   */
  async _healBillingCustomerStatus(result, autoRepair) {
    try {
      // Cari pelanggan yang statusnya isolated/suspended tetapi TIDAK punya invoice unpaid
      const query = `
        SELECT c.id, c.name, c.status, c.pppoe_username, c.router_id,
               COUNT(CASE WHEN i.status != 'paid' THEN 1 END) as unpaid_count
        FROM customers c
        LEFT JOIN invoices i ON c.id = i.customer_id
        WHERE LOWER(c.status) IN ('isolated', 'suspended', 'isolir')
        GROUP BY c.id
        HAVING unpaid_count = 0
      `;
      const falseIsolated = db.prepare(query).all() || [];

      for (const cust of falseIsolated) {
        result.stats.anomaliesFound++;
        const desc = `Pelanggan #${cust.id} (${cust.name}) berstatus '${cust.status}' padahal seluruh tagihannya telah LUNAS.`;
        result.issues.push({ type: 'false_isolation', customerId: cust.id, name: cust.name, description: desc });

        if (autoRepair) {
          try {
            // Ubah status ke active di database
            db.prepare("UPDATE customers SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(cust.id);
            // Eksekusi buka isolir di MikroTik jika terhubung
            if (cust.router_id && cust.pppoe_username) {
              await mikrotikService.unisolateCustomerPppoe(cust.router_id, cust.pppoe_username).catch(() => {});
            }
            result.stats.anomaliesRepaired++;
            result.repairs.push(`[Billing] Buka isolir & aktifkan pelanggan #${cust.id} (${cust.name}) karena tagihan sudah lunas.`);
          } catch (e) {
            result.stats.failedRepairs++;
            result.errors.push(`Gagal memulihkan status pelanggan #${cust.id}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.error(`[SelfHealing] Error healing billing status: ${e.message}`);
    }
  }

  /**
   * 2. Perbaiki Inkonsistensi MikroTik (Secrets, Profiles, Address-Lists)
   */
  async _healMikrotikConsistency(result, autoRepair) {
    try {
      const routers = db.prepare("SELECT * FROM routers WHERE is_active = 1").all() || [];
      result.stats.routersChecked = routers.length;

      for (const r of routers) {
        let isOnline = false;
        try {
          isOnline = await mikrotikService.checkConnection(r.id);
        } catch (_) {}

        if (!isOnline) {
          result.warnings.push(`Router "${r.name}" (${r.host}) offline atau API port tidak merespons.`);
          continue;
        }

        // Ambil data secrets dan active sessions dari router
        let secrets = [];
        try {
          secrets = await mikrotikService.getPppoeSecrets(r.id) || [];
        } catch (e) {
          result.warnings.push(`Gagal membaca PPP Secrets dari router "${r.name}": ${e.message}`);
          continue;
        }

        const secretMap = new Map();
        for (const s of secrets) {
          if (s.name) secretMap.set(s.name.toLowerCase(), s);
        }

        // Ambil daftar pelanggan yang dialokasikan ke router ini
        const customers = db.prepare(`
          SELECT c.*, p.name as package_name, p.billing_type as package_billing_type
          FROM customers c
          LEFT JOIN packages p ON c.package_id = p.id
          WHERE c.router_id = ? AND c.pppoe_username IS NOT NULL AND c.pppoe_username != ''
        `).all(r.id) || [];

        result.stats.customersChecked += customers.length;

        for (const cust of customers) {
          const userLower = (cust.pppoe_username || '').trim().toLowerCase();
          if (!userLower) continue;

          const sec = secretMap.get(userLower);
          const isActiveCustomer = String(cust.status || '').toLowerCase() === 'active';
          const isIsolatedCustomer = ['isolated', 'suspended', 'isolir'].includes(String(cust.status || '').toLowerCase());
          const targetProfile = cust.package_name || 'default';

          // KASUS A: Pelanggan Aktif, tetapi Secret Belum Dibuat di MikroTik
          if (isActiveCustomer && !sec) {
            result.stats.anomaliesFound++;
            const desc = `Pelanggan aktif #${cust.id} (${cust.name}) belum memiliki Secret PPPoE '${cust.pppoe_username}' di router "${r.name}".`;
            result.issues.push({ type: 'missing_secret', customerId: cust.id, username: cust.pppoe_username, description: desc });

            if (autoRepair) {
              try {
                await mikrotikService.createPppoeSecret({
                  username: cust.pppoe_username,
                  password: cust.pppoe_password || cust.pppoe_username,
                  profile: targetProfile,
                  routerId: r.id
                });
                result.stats.anomaliesRepaired++;
                result.repairs.push(`[MikroTik] Dibuatkan Secret PPPoE baru '${cust.pppoe_username}' (Profile: ${targetProfile}) di router "${r.name}".`);
              } catch (e) {
                result.stats.failedRepairs++;
                result.errors.push(`Gagal membuat secret '${cust.pppoe_username}': ${e.message}`);
              }
            }
          }

          // KASUS B: Pelanggan Aktif, tetapi Secret di MikroTik Disabled atau Masih Berprofil ISOLIR
          else if (isActiveCustomer && sec) {
            const isSecDisabled = sec.disabled === 'true' || sec.disabled === true;
            const isSecIsolirProfile = String(sec.profile || '').toUpperCase().includes('ISOLIR');

            if (isSecDisabled || isSecIsolirProfile) {
              result.stats.anomaliesFound++;
              const desc = `Pelanggan aktif #${cust.id} (${cust.name}) di MikroTik berstatus disabled (${isSecDisabled}) atau profil masih '${sec.profile}'.`;
              result.issues.push({ type: 'active_but_blocked_secret', customerId: cust.id, username: cust.pppoe_username, description: desc });

              if (autoRepair) {
                try {
                  await mikrotikService.updatePppoeSecret({
                    username: cust.pppoe_username,
                    password: cust.pppoe_password || sec.password,
                    profile: targetProfile,
                    disabled: false,
                    routerId: r.id
                  });
                  // Buka juga dari firewall isolir list jika ada
                  await mikrotikService.unisolateCustomerPppoe(r.id, cust.pppoe_username).catch(() => {});
                  result.stats.anomaliesRepaired++;
                  result.repairs.push(`[MikroTik] Mengaktifkan kembali Secret '${cust.pppoe_username}' ke profil '${targetProfile}' di router "${r.name}".`);
                } catch (e) {
                  result.stats.failedRepairs++;
                  result.errors.push(`Gagal memulihkan secret '${cust.pppoe_username}': ${e.message}`);
                }
              }
            }
          }

          // KASUS C: Pelanggan Terisolir di Billing, tetapi di MikroTik Masih Aktif / Profil Normal
          else if (isIsolatedCustomer && sec) {
            const isSecDisabled = sec.disabled === 'true' || sec.disabled === true;
            const isSecIsolirProfile = String(sec.profile || '').toUpperCase().includes('ISOLIR');

            if (!isSecDisabled && !isSecIsolirProfile) {
              result.stats.anomaliesFound++;
              const desc = `Pelanggan terisolir #${cust.id} (${cust.name}) di MikroTik masih aktif dengan profil normal '${sec.profile}'.`;
              result.issues.push({ type: 'isolated_not_enforced', customerId: cust.id, username: cust.pppoe_username, description: desc });

              if (autoRepair) {
                try {
                  await mikrotikService.isolateCustomerPppoe(r.id, cust.pppoe_username, { pppoeProfile: 'ISOLIR' });
                  await mikrotikService.kickPppoeUser(cust.pppoe_username, r.id).catch(() => {});
                  result.stats.anomaliesRepaired++;
                  result.repairs.push(`[MikroTik] Menerapkan isolir & kick sesi '${cust.pppoe_username}' di router "${r.name}".`);
                } catch (e) {
                  result.stats.failedRepairs++;
                  result.errors.push(`Gagal menerapkan isolir '${cust.pppoe_username}': ${e.message}`);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      logger.error(`[SelfHealing] Error healing MikroTik consistency: ${e.message}`);
    }
  }

  /**
   * 3. Bersihkan Sesi RADIUS yang Menggantung (Zombie / Stale)
   */
  async _healRadiusSessions(result, autoRepair) {
    try {
      if (!radiusSvc) return;

      const onlineCountBefore = (radiusSvc.getOnlineSessions() || []).length;
      if (autoRepair && typeof radiusSvc.cleanupStaleSessions === 'function') {
        const cleaned = await radiusSvc.cleanupStaleSessions();
        if (cleaned > 0) {
          result.stats.anomaliesFound += cleaned;
          result.stats.anomaliesRepaired += cleaned;
          result.repairs.push(`[RADIUS Server] Membersihkan ${cleaned} sesi accounting yang menggantung (stale).`);
        }
      }
    } catch (e) {
      logger.warn(`[SelfHealing] RADIUS session check: ${e.message}`);
    }
  }

  /**
   * 4. Sinkronisasi Perangkat ACS TR-069
   */
  async _healAcsDevices(result, autoRepair) {
    try {
      const count = db.prepare("SELECT COUNT(*) as c FROM acs_devices WHERE ip_address IS NULL OR ip_address = ''").get();
      if (count && count.c > 0) {
        result.stats.anomaliesFound += count.c;
        if (autoRepair) {
          // Trigger update IP dari MikroTik active sessions
          const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
          if (activeSessionsMap && activeSessionsMap.size > 0) {
            let fixed = 0;
            const devs = db.prepare("SELECT id, params FROM acs_devices WHERE ip_address IS NULL OR ip_address = ''").all() || [];
            for (const d of devs) {
              let p = {};
              try { p = JSON.parse(d.params || '{}'); } catch (_) {}
              const user = p['VirtualParameters.pppoeUsername'] || p['Device.PPP.Interface.1.Username'];
              if (user && activeSessionsMap.has(user.toLowerCase())) {
                const ip = activeSessionsMap.get(user.toLowerCase()).ip;
                if (ip) {
                  db.prepare("UPDATE acs_devices SET ip_address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ip, d.id);
                  fixed++;
                }
              }
            }
            if (fixed > 0) {
              result.stats.anomaliesRepaired += fixed;
              result.repairs.push(`[ACS TR-069] Memperbarui IP address untuk ${fixed} modem ONU dari sesi aktif MikroTik.`);
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`[SelfHealing] ACS check: ${e.message}`);
    }
  }
}

const selfHealingService = new SelfHealingService();
module.exports = selfHealingService;
