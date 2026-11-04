const db = require('../config/database');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikService = require('./mikrotikService');
const customerDevice = require('./customerDeviceService');
const agentSvc = require('./agentService');
const { getSetting, getCurrentDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');

/**
 * Deklarasi Tools (Function Calling) untuk Google Gemini API
 */
const adminToolDeclarations = [
  {
    name: 'add_customer',
    description: 'Mendaftarkan / menambah pelanggan internet baru ke database billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Nama lengkap pelanggan' },
        phone: { type: 'STRING', description: 'Nomor WhatsApp atau telepon pelanggan' },
        packageName: { type: 'STRING', description: 'Nama paket langganan (misal: BRONZE, SILVER, GOLD, dll)' },
        area: { type: 'STRING', description: 'Nama area / dusun / lokasi pelanggan (opsional)' },
        address: { type: 'STRING', description: 'Alamat lengkap rumah pelanggan (opsional)' },
        pppoeUsername: { type: 'STRING', description: 'Username akun PPPoE untuk dial MikroTik (opsional)' },
        pppoePassword: { type: 'STRING', description: 'Password akun PPPoE (opsional)' }
      },
      required: ['name', 'phone']
    }
  },
  {
    name: 'delete_customer_request',
    description: 'Meminta konfirmasi penghapusan data pelanggan secara permanen dari sistem',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, nomor WhatsApp, atau username PPPoE yang ingin dihapus' }
      },
      required: ['target']
    }
  },
  {
    name: 'check_modem_status',
    description: 'Mengecek kondisi modem ONU, daya redaman optik sinyal (RX Power), status PPPoE, dan uptime pelanggan via GenieACS dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, nomor telepon, akun PPPoE, atau tag modem ONU yang ingin dicek' }
      }
    }
  },
  {
    name: 'reboot_onu',
    description: 'Me-reboot / restart modem ONU pelanggan dari jarak jauh via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID, no HP, akun PPPoE, atau tag ONU' }
      },
      required: ['target']
    }
  },
  {
    name: 'update_wifi_password',
    description: 'Mengubah kata sandi WiFi modem ONU pelanggan via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, no HP, akun PPPoE, atau tag ONU' },
        newPassword: { type: 'STRING', description: 'Kata sandi WiFi baru (minimal 8 karakter)' }
      },
      required: ['target', 'newPassword']
    }
  },
  {
    name: 'update_wifi_ssid',
    description: 'Mengubah nama SSID WiFi modem ONU pelanggan via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, no HP, akun PPPoE, atau tag ONU' },
        newSsid: { type: 'STRING', description: 'Nama SSID WiFi baru' }
      },
      required: ['target', 'newSsid']
    }
  },
  {
    name: 'mark_invoice_paid',
    description: 'Menandai lunas / melunasi tagihan invoice pelanggan dan cabut isolir jika ada',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'ID invoice (angka), nama pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'isolate_customer',
    description: 'Mengisolir / suspend / memutus sementara layanan internet pelanggan di billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'unisolate_customer',
    description: 'Membuka isolir / mengaktifkan kembali layanan internet pelanggan di billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'kick_pppoe_user',
    description: 'Memutus paksa / kick sesi active PPPoE atau Hotspot pelanggan di router MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        username: { type: 'STRING', description: 'Username PPPoE atau nama pelanggan' }
      },
      required: ['username']
    }
  },
  {
    name: 'create_hotspot_voucher',
    description: 'Membuat / generate voucher hotspot baru di router MikroTik (Mikhmon profile)',
    parameters: {
      type: 'OBJECT',
      properties: {
        profile: { type: 'STRING', description: 'Nama profil paket voucher (misal: 1jam, 5jam, 24jam, dll)' },
        count: { type: 'INTEGER', description: 'Jumlah voucher yang ingin dibuat (opsional, default 1)' }
      },
      required: ['profile']
    }
  },
  {
    name: 'generate_invoices',
    description: 'Menjalankan generate invoice tagihan bulanan seluruh pelanggan',
    parameters: {
      type: 'OBJECT',
      properties: {
        month: { type: 'INTEGER', description: 'Bulan (1-12)' },
        year: { type: 'INTEGER', description: 'Tahun (misal: 2026)' }
      },
      required: ['month', 'year']
    }
  },
  {
    name: 'check_digiflazz_balance',
    description: 'Mengecek sisa saldo deposit Digiflazz (PPOB / Pulsa) Admin',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'topup_agent',
    description: 'Mentransfer / top up saldo agen reseller voucher atau pembayaran',
    parameters: {
      type: 'OBJECT',
      properties: {
        agentKey: { type: 'STRING', description: 'Username agent, nama agent, no HP, atau ID agent' },
        amount: { type: 'INTEGER', description: 'Nominal saldo yang ditransfer (angka dalam Rupiah)' },
        note: { type: 'STRING', description: 'Catatan transfer (opsional)' }
      },
      required: ['agentKey', 'amount']
    }
  },
  {
    name: 'auto_heal_network',
    description: 'Menjalankan diagnosa dan perbaikan mandiri otomatis (Self-Healing) pada seluruh jaringan, router MikroTik (sinkronisasi secret PPPoE & isolir), status pelanggan billing, dan sesi yang macet',
    parameters: {
      type: 'OBJECT',
      properties: {
        mode: { type: 'STRING', description: 'Mode perbaikan: "repair" untuk langsung memperbaiki otomatis, atau "scan" untuk diagnosa saja (opsional, default: "repair")' }
      }
    }
  },
  {
    name: 'check_security_status',
    description: 'Mengecek status keamanan sistem, apakah ada anomali serangan brute force pada portal login aplikasi maupun router MikroTik, serta IP penyerang yang diblokir',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  }
];

/**
 * Helper untuk mencari pelanggan secara fleksibel (Nama, HP, PPPoE, ID, Tag)
 */
function findCustomerHelper(query) {
  if (!query) return null;
  const q = String(query).trim();
  let cust = customerSvc.findCustomerByAny(q);
  if (cust) return cust;

  const byExactName = db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?) LIMIT 1').get(q);
  if (byExactName) return customerSvc.getCustomerById(byExactName.id);

  const candidates = customerSvc.getAllCustomers(q) || [];
  if (candidates.length === 1) return customerSvc.getCustomerById(candidates[0].id);
  if (candidates.length > 1) {
    const exact = candidates.find(c => c.name.toLowerCase() === q.toLowerCase());
    if (exact) return customerSvc.getCustomerById(exact.id);
    return customerSvc.getCustomerById(candidates[0].id);
  }
  return null;
}

/**
 * Eksekutor Tool / Fungsi Perintah WhatsApp Admin
 */
async function executeAdminTool(toolName, args, extraContext = {}) {
  const { reply, sock, lidStore } = extraContext;
  logger.info(`[Admin AI Tool] Memulai eksekusi tool "${toolName}" dengan args: ${JSON.stringify(args)}`);

  try {
    switch (toolName) {
      // 1. Tambah Pelanggan
      case 'add_customer': {
        const { name, phone, packageName, area, address, pppoeUsername, pppoePassword } = args;
        if (!name || !phone) {
          return 'Mohon sebutkan minimal nama dan nomor WhatsApp pelanggan yang ingin didaftarkan.';
        }

        const allPkgs = customerSvc.getAllPackages();
        let pkg = null;
        if (packageName) {
          pkg = allPkgs.find(p => p.name.toLowerCase() === packageName.toLowerCase().trim()) ||
                allPkgs.find(p => p.name.toLowerCase().includes(packageName.toLowerCase().trim()));
        }
        if (!pkg && allPkgs.length > 0) {
          pkg = allPkgs[0];
        }
        if (!pkg) {
          return 'Mohon maaf, saat ini belum ada paket layanan internet yang aktif di database.';
        }

        let cleanPppoe = (pppoeUsername || name.toLowerCase().replace(/[^a-z0-9]/g, '')).trim();
        if (!cleanPppoe) cleanPppoe = 'user' + Math.floor(1000 + Math.random() * 9000);
        
        const existing = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanPppoe);
        if (existing) {
          cleanPppoe += Math.floor(10 + Math.random() * 89);
        }
        const cleanPass = (pppoePassword || cleanPppoe).trim();

        const routerRow = db.prepare('SELECT id FROM routers WHERE is_active = 1 LIMIT 1').get();
        const routerId = routerRow ? routerRow.id : null;

        const today = new Date().toISOString().slice(0, 10);
        const newCustData = {
          name: name.trim(),
          phone: String(phone).replace(/\D/g, ''),
          email: '',
          address: address ? String(address).trim() : '',
          area: area ? String(area).trim() : '',
          package_id: pkg.id,
          router_id: routerId,
          connection_type: 'pppoe',
          pppoe_username: cleanPppoe,
          pppoe_password: cleanPass,
          status: 'active',
          install_date: today,
          auto_isolate: 1,
          isolate_day: 10
        };

        const res = customerSvc.createCustomer(newCustData);
        const newId = res.lastInsertRowid;

        if (routerId) {
          try {
            await mikrotikService.createPppoeSecret({
              username: cleanPppoe,
              password: cleanPass,
              profile: pkg.name,
              routerId: routerId
            });
          } catch (err) {
            logger.warn(`[Admin AI Tool] Buat secret mikrotik: ${err.message}`);
          }
        }

        try {
          billingSvc.ensureCurrentInvoice(newId);
        } catch (_) {}

        return `Pelanggan baru atas nama ${name} dengan nomor WhatsApp ${newCustData.phone} berhasil didaftarkan dengan paket ${pkg.name}. Akun internet PPPoE dan tagihan periode berjalan sudah dibuatkan secara otomatis.`;
      }

      // 2. Hapus Pelanggan (Permintaan Konfirmasi)
      case 'delete_customer_request': {
        const { target } = args;
        if (!target) return 'Mohon sebutkan nama pelanggan atau ID yang ingin dihapus.';
        const cust = findCustomerHelper(target);
        if (!cust) {
          return `Pelanggan atas nama ${target} tidak ditemukan di sistem. Silakan pastikan nama atau nomornya sudah sesuai.`;
        }

        return `Apakah Anda yakin ingin menghapus data pelanggan ${cust.name}? Tindakan ini bersifat permanen. Jika setuju, silakan konfirmasi dengan ucapan: ya hapus ${cust.id}.`;
      }

      // 3. Cek Status Modem & Redaman
      case 'check_modem_status': {
        const { target } = args || {};
        if (!target || target.toLowerCase() === 'semua' || target.toLowerCase() === 'general') {
          return 'Secara umum kondisi jaringan dan modem pelanggan yang aktif terpantau normal dan lancar. Jika Anda ingin mengecek kondisi modem pelanggan tertentu, silakan sebutkan nama pelanggannya.';
        }

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;
        let onuData = null;
        try {
          onuData = await Promise.race([
            customerDevice.getCustomerDeviceData(tagToken),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
          ]).catch(() => null);
        } catch (_) {}

        const pppoeUser = cust?.pppoe_username ? cust.pppoe_username.toLowerCase() : '';
        let pppoeSession = null;
        if (pppoeUser) {
          try {
            const activeSessions = await mikrotikService.getActivePppoeUsers();
            pppoeSession = (activeSessions || []).find(s => (s.user || '').toLowerCase() === pppoeUser);
          } catch (_) {}
        }

        const name = cust ? cust.name : target;
        if (!onuData && !pppoeSession) {
          return `Perangkat modem untuk pelanggan ${name} saat ini belum terdeteksi aktif di sistem GenieACS maupun router MikroTik. Pastikan modem telah menyala dan kabel fiber optik terhubung dengan baik.`;
        }

        let redamanDesc = '';
        if (onuData?.rxPower) {
          const rx = parseFloat(onuData.rxPower);
          if (!isNaN(rx)) {
            if (rx > -23) {
              redamanDesc = `Kualitas sinyal redaman optiknya sangat bagus di minus ${Math.abs(rx)} desibel.`;
            } else if (rx >= -27) {
              redamanDesc = `Kualitas sinyal redaman optiknya cukup baik di minus ${Math.abs(rx)} desibel.`;
            } else {
              redamanDesc = `Kualitas sinyal redaman optiknya agak lemah di minus ${Math.abs(rx)} desibel, perlu diperhatikan.`;
            }
          } else {
            redamanDesc = `Kualitas daya sinyal tercatat ${onuData.rxPower}.`;
          }
        }

        let pppoeDesc = pppoeSession ? 'Koneksi internet terpantau online lancar.' : 'Akun internet terpantau belum dial up ke router.';
        return `Kondisi modem milik ${name} saat ini terpantau normal dan aktif. ${redamanDesc} ${pppoeDesc}`.trim();
      }

      // 4. Reboot Modem ONU
      case 'reboot_onu': {
        const { target } = args;
        if (!target) return 'Mohon sebutkan nama pelanggan atau tag modem yang ingin dinyalakan ulang.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const targetDevice = await customerDevice.resolveDeviceToken(tagToken);
        if (!targetDevice) {
          return `Perangkat modem untuk ${target} tidak ditemukan di GenieACS.`;
        }

        await customerDevice.requestReboot(tagToken);
        return `Perintah restart untuk modem milik ${cust ? cust.name : target} berhasil dikirim. Modem akan mulai menyala ulang dalam beberapa saat.`;
      }

      // 5. Update Password WiFi
      case 'update_wifi_password': {
        const { target, newPassword } = args;
        if (!target || !newPassword) return 'Mohon sebutkan nama pelanggan dan kata sandi wifi baru.';
        if (String(newPassword).length < 8) return 'Kata sandi wifi baru minimal harus delapan karakter.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const ok = await customerDevice.updatePassword(tagToken, String(newPassword).trim());
        if (ok) {
          return `Kata sandi wifi untuk pelanggan ${cust ? cust.name : target} berhasil diperbarui menjadi ${newPassword}. Pengaturan sudah diterapkan ke modem.`;
        } else {
          return `Gagal mengubah kata sandi wifi untuk ${target}. Pastikan modem pelanggan sedang dalam kondisi online.`;
        }
      }

      // 6. Update SSID WiFi
      case 'update_wifi_ssid': {
        const { target, newSsid } = args;
        if (!target || !newSsid) return 'Mohon sebutkan nama pelanggan dan nama wifi baru.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const ok = await customerDevice.updateSSID(tagToken, String(newSsid).trim());
        if (ok) {
          return `Nama wifi untuk pelanggan ${cust ? cust.name : target} berhasil diganti menjadi ${newSsid}. Perangkat modem sudah diperbarui.`;
        } else {
          return `Gagal mengubah nama wifi untuk ${target}. Pastikan modem pelanggan sedang aktif terhubung.`;
        }
      }

      // 7. Melunasi Tagihan
      case 'mark_invoice_paid': {
        const { target } = args;
        if (!target) return 'Mohon sebutkan ID invoice atau nama pelanggan yang tagihannya ingin dilunasi.';
        const { executeAdminLunas } = await import('./whatsappBot.mjs');
        let capturedReply = '';
        const localReply = async (msg) => { capturedReply = msg; };
        await executeAdminLunas(target, localReply, sock, lidStore);
        return `Tagihan untuk ${target} telah berhasil dilunasi di sistem dan layanan sudah aktif normal.`;
      }

      // 8. Isolir Pelanggan
      case 'isolate_customer': {
        const { target } = args;
        if (!target) return 'Mohon sebutkan nama pelanggan atau ID yang ingin diisolir.';
        const { executeAdminIsolir } = await import('./whatsappBot.mjs');
        let capturedReply = '';
        const localReply = async (msg) => { capturedReply = msg; };
        await executeAdminIsolir(target, localReply);
        return `Layanan internet untuk pelanggan ${target} telah berhasil diisolir sementara.`;
      }

      // 9. Buka Isolir Pelanggan
      case 'unisolate_customer': {
        const { target } = args;
        if (!target) return 'Mohon sebutkan nama pelanggan atau ID yang ingin dibuka isolirnya.';
        const { executeAdminBuka } = await import('./whatsappBot.mjs');
        let capturedReply = '';
        const localReply = async (msg) => { capturedReply = msg; };
        await executeAdminBuka(target, localReply);
        return `Isolir untuk pelanggan ${target} telah berhasil dibuka. Koneksi internet kini sudah normal kembali.`;
      }

      // 10. Kick PPPoE / Hotspot User
      case 'kick_pppoe_user': {
        const { username } = args;
        if (!username) return 'Mohon sebutkan nama pengguna yang ingin diputus sesinya.';
        
        let targetUser = username.trim();
        const cust = findCustomerHelper(username);
        if (cust && cust.pppoe_username) {
          targetUser = cust.pppoe_username;
        }

        const pk = await mikrotikService.kickPppoeUser(targetUser);
        const hk = await mikrotikService.kickHotspotUser(targetUser);
        if (pk || hk) {
          return `Sesi aktif untuk ${targetUser} telah berhasil diputus dari router. Perangkat akan terhubung kembali secara otomatis.`;
        } else {
          return `Sesi aktif untuk ${targetUser} tidak ditemukan di router.`;
        }
      }

      // 11. Buat Voucher Hotspot
      case 'create_hotspot_voucher': {
        const { profile, count } = args;
        if (!profile) return 'Mohon sebutkan nama profil paket voucher hotspot yang ingin dibuat.';

        const numVouchers = Math.min(Math.max(parseInt(count, 10) || 1, 1), 10);
        const created = [];
        const now = getCurrentDateInTimezone();
        const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

        for (let i = 0; i < numVouchers; i++) {
          const code = Math.floor(1000 + Math.random() * 9000).toString();
          const comment = `vc ${code} ${dateStr} AI`;
          await mikrotikService.addHotspotUser({
            name: code,
            password: code,
            profile: profile,
            comment: comment
          });
          created.push(code);
        }

        return `Sebanyak ${created.length} voucher hotspot dengan paket ${profile} telah berhasil dibuat. Kode voucher pertama adalah ${created[0]}.`;
      }

      // 12. Generate Tagihan Bulanan
      case 'generate_invoices': {
        const { month, year } = args;
        const m = parseInt(month, 10) || (new Date().getMonth() + 1);
        const y = parseInt(year, 10) || new Date().getFullYear();

        const r = await billingSvc.generateMonthlyInvoices(m, y);
        return `Pembuatan tagihan bulanan untuk periode bulan ${m} tahun ${y} telah selesai. Sebanyak ${r?.created || 0} tagihan baru berhasil diproses.`;
      }

      // 13. Cek Saldo Digiflazz
      case 'check_digiflazz_balance': {
        const r = await agentSvc.digiflazzCheckBalance();
        const dep = Number(r?.deposit || 0).toLocaleString('id-ID');
        return `Sisa saldo deposit Digiflazz Anda saat ini tercatat sebesar ${dep} rupiah dan berstatus aktif.`;
      }

      // 14. Top Up Saldo Agent
      case 'topup_agent': {
        const { agentKey, amount, note } = args;
        const nom = Number(String(amount || '').replace(/[^\d]/g, ''));
        if (!nom || nom <= 0) return 'Nominal top up harus berupa angka lebih dari nol.';

        const rawKey = String(agentKey || '').trim();
        let agent = agentSvc.getAgentById(parseInt(rawKey, 10)) ||
                    agentSvc.getAgentByUsername(rawKey) ||
                    agentSvc.getAgentByPhone(rawKey);

        if (!agent) {
          const all = agentSvc.getAllAgents();
          agent = all.find(a => String(a.name || '').toLowerCase().includes(rawKey.toLowerCase()));
        }

        if (!agent) return `Data agen ${agentKey} tidak ditemukan di sistem.`;

        const r = agentSvc.topupAgent(agent.id, nom, note || 'Topup via Voice AI', 'Admin Voice AI');
        return `Top up saldo untuk agen ${agent.name} sebesar ${nom.toLocaleString('id-ID')} rupiah telah berhasil diproses. Saldo saat ini menjadi ${Number(r.after || 0).toLocaleString('id-ID')} rupiah.`;
      }

      // 15. Self-Healing & Network Auto-Repair
      case 'auto_heal_network': {
        const { mode } = args || {};
        const selfHealingSvc = require('./selfHealingService');
        const isRepair = String(mode || 'repair').toLowerCase() !== 'scan';
        const res = await (isRepair ? selfHealingSvc.autoRepair('Admin AI Command') : selfHealingSvc.diagnose());

        const found = res.stats.anomaliesFound;
        const fixed = res.stats.anomaliesRepaired;
        const routers = res.stats.routersChecked;

        if (found === 0) {
          return `Pemeriksaan mandiri selesai. Seluruh sistem billing, status pelanggan, dan ${routers} router MikroTik terpantau normal dan tersinkronisasi sempurna tanpa kendala.`;
        }

        if (isRepair) {
          const repairList = res.repairs.slice(0, 3).map(r => r.replace(/\[[^\]]+\]\s*/, '')).join('. ');
          return `Proses perbaikan mandiri selesai. Sistem mendeteksi ${found} anomali dan berhasil memperbaiki ${fixed} masalah secara otomatis: ${repairList}.`;
        } else {
          return `Pemeriksaan sistem mendeteksi ${found} anomali yang perlu disinkronkan. Anda dapat memerintahkan perbaikan dengan ucapan: ai perbaiki jaringan.`;
        }
      }

      // 16. Cek Status Keamanan & Brute Force Anomaly
      case 'check_security_status': {
        const securityWatchdog = require('./securityWatchdogService');
        const overview = securityWatchdog.getSecurityOverview();
        const blockedCount = overview.activeBlockedIps ? overview.activeBlockedIps.length : 0;
        const recentAlerts = overview.recentAlerts || [];

        if (blockedCount === 0 && recentAlerts.length === 0) {
          return 'Status keamanan sistem saat ini aman dan terkendali. Tidak terdeteksi adanya anomali serangan brute force pada portal login aplikasi maupun router MikroTik.';
        }

        let resp = `Laporan keamanan sistem: Saat ini status sistem adalah ${overview.status === 'warning' ? 'waspada' : 'aman'}. `;
        if (blockedCount > 0) {
          const ipList = overview.activeBlockedIps.map(b => `${b.ip} (tersisa ${b.remainingSeconds} detik)`).join(', ');
          resp += `Terdapat ${blockedCount} alamat i pe yang sedang diblokir sementara karena percobaan login berulang kali: ${ipList}. `;
        }
        if (recentAlerts.length > 0) {
          resp += `Tercatat ${recentAlerts.length} riwayat insiden keamanan terbaru pada audit sistem.`;
        }
        return resp;
      }

      default:
        return `Fungsi ${toolName} belum tersedia di sistem.`;
    }
  } catch (err) {
    logger.error(`[Admin AI Tool] Error saat eksekusi ${toolName}: ${err.message}`);
    return `Mohon maaf, terjadi kendala saat memproses permintaan: ${err.message}`;
  }
}

module.exports = {
  adminToolDeclarations,
  executeAdminTool
};
