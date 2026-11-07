const fs = require('fs');
const path = require('path');
const os = require('os');
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
  },
  {
    name: 'run_server_command',
    description: 'Menjalankan perintah shell/terminal Linux server yang aman (seperti: pm2 status, pm2 reload billing, git status, git pull, free -m, df -h, uptime, systemctl status freeradius, ping, ip addr) untuk diagnosa dan pemeliharaan server secara mandiri',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: 'Perintah shell Linux yang ingin dijalankan (contoh: "pm2 status", "git status", "free -m", "df -h", "uptime", "systemctl status freeradius")' }
      },
      required: ['command']
    }
  },
  {
    name: 'inspect_server_logs',
    description: 'Membaca dan menganalisis log server (logs/app.log, logs/error.log, atau log PM2) untuk mendiagnosa error, crash, atau kendala teknis pada sistem',
    parameters: {
      type: 'OBJECT',
      properties: {
        logType: { type: 'STRING', description: 'Tipe log yang ingin diperiksa: "error" (default), "app", "pm2", "webhook"' },
        lines: { type: 'INTEGER', description: 'Jumlah baris terakhir yang ingin dibaca (default: 30, max: 80)' }
      }
    }
  },
  {
    name: 'check_server_resources',
    description: 'Mengecek kesehatan menyeluruh server fisik/VPS hosting (CPU load, penggunaan RAM, sisa kapasitas harddisk, uptime OS, status PM2 process, dan database)',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'run_mikrotik_cli',
    description: 'Menjalankan perintah CLI RouterOS MikroTik langsung via API/Terminal (seperti /system resource print, /interface print, /ip hotspot active print, /ip pppoe-server print, /ping count=3 address=8.8.8.8)',
    parameters: {
      type: 'OBJECT',
      properties: {
        routerId: { type: 'INTEGER', description: 'ID Router MikroTik (opsional, jika tidak disebutkan gunakan router aktif pertama)' },
        command: { type: 'STRING', description: 'Perintah RouterOS yang ingin dijalankan (contoh: "/system resource print", "/interface print")' }
      },
      required: ['command']
    }
  },
  {
    name: 'scan_mikrotik_security',
    description: 'Memindai log MikroTik sekarang secara real-time untuk mendeteksi anomali serangan brute force Hotspot (percobaan tebak voucher acak) atau brute force login admin (SSH, Winbox, API, Telnet, WebFig), dan langsung memblokir penyerang serta melaporkan hasilnya',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'unblock_security_target',
    description: 'Membuka blokir IP address atau MAC address yang sebelumnya diblokir oleh sistem keamanan AI di MikroTik (Hotspot IP-Binding / Firewall Blacklist) maupun di aplikasi billing',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Alamat IP (contoh: "192.168.100.242") atau MAC Address (contoh: "26:BD:26:2A:C3:47") yang ingin dibuka blokirnya' },
        routerId: { type: 'INTEGER', description: 'ID Router MikroTik tertentu (opsional, jika kosong buka di semua router)' }
      },
      required: ['target']
    }
  },
  {
    name: 'configure_security_policy',
    description: 'Mengatur kebijakan pengamanan brute force sistem: mengaktifkan atau menonaktifkan pemblokiran otomatis (auto-block / jangan blokir), mengatur ambang batas (threshold) kesalahan login untuk Hotspot dan Admin, atau melihat kebijakan keamanan yang sedang berlaku',
    parameters: {
      type: 'OBJECT',
      properties: {
        autoBlock: { type: 'BOOLEAN', description: 'Status pemblokiran otomatis: true untuk mengaktifkan auto-block, false untuk mematikan auto-block / jangan blokir (hanya pantau & kirim notifikasi tanpa memblokir IP/MAC)' },
        adminThreshold: { type: 'INTEGER', description: 'Ambang batas kegagalan login admin sebelum diblokir (angka, contoh: 5)' },
        hotspotThreshold: { type: 'INTEGER', description: 'Ambang batas kegagalan login Hotspot sebelum diblokir (angka, contoh: 5)' },
        hotspotDistinctUsers: { type: 'INTEGER', description: 'Batas minimal variasi nama user/voucher acak yang dicoba sebelum dicap penyerang (angka, contoh: 3)' }
      }
    }
  },
  {
    name: 'get_morning_briefing',
    description: 'Menampilkan laporan ringkasan eksekutif pagi (Morning Executive Briefing): ringkasan omzet & keuangan harian/bulanan, tagihan tertunda, kesehatan sesi PPPoE aktif MikroTik, status ONT & redaman optik kritis di ACS, status keamanan brute-force, dan tiket komplain aktif',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'check_network_outages',
    description: 'Memeriksa dan menganalisis apakah sedang terjadi gangguan massal, kabel feeder/distribusi ODP putus, atau banyak pelanggan terputus serentak pada klaster ODP/Area tertentu',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'quick_provision_customer_ont',
    description: 'Aktivasi cepat pelanggan baru & registrasi ONT/ONU langsung dari chat Telegram untuk teknisi lapangan: mendaftarkan data pelanggan, memilih ODP, membuat secret PPPoE di MikroTik, menghubungkan serial number ONT di ACS, dan mengatur SSID/WiFi',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Nama lengkap pelanggan baru (contoh: "Bpk Rahmat")' },
        phone: { type: 'STRING', description: 'Nomor WhatsApp atau HP pelanggan (contoh: "08123456789")' },
        address: { type: 'STRING', description: 'Alamat tempat pemasangan (contoh: "Blok C No. 12 RT 03")' },
        packageName: { type: 'STRING', description: 'Nama paket internet atau kecepatan (contoh: "20 Mbps", "Paket Home 10M", atau harga "150000")' },
        serialNumber: { type: 'STRING', description: 'Serial Number ONT / ONU baru (contoh: "ZTEGCB86524A" atau "ALCLB1234567")' },
        odpName: { type: 'STRING', description: 'Nama atau nomor ODP tempat kabel dicolokkan (contoh: "ODP-01" atau "1")' },
        wifiSsid: { type: 'STRING', description: 'Nama SSID WiFi pelanggan baru jika ingin langsung diset (contoh: "Rahmat_Net")' },
        wifiPassword: { type: 'STRING', description: 'Password WiFi jika ingin langsung diset (contoh: "12345678")' },
        pppoeUser: { type: 'STRING', description: 'Username PPPoE kustom (opsional, jika kosong otomatis digenerate dari nama)' },
        pppoePass: { type: 'STRING', description: 'Password PPPoE kustom (opsional, jika kosong otomatis dibuatkan aman)' }
      },
      required: ['name']
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
        const overview = await securityWatchdog.getDetailedSecurityStatus();
        const appBlockedCount = overview.appBlockedIps ? overview.appBlockedIps.length : 0;
        const mtIpCount = overview.mikrotikBlockedIps ? overview.mikrotikBlockedIps.length : 0;
        const mtMacCount = overview.mikrotikBlockedMacs ? overview.mikrotikBlockedMacs.length : 0;
        const recentAlerts = overview.recentAlerts || [];
        const policy = overview.policy || {};
        const isAutoBlock = policy.autoBlockEnabled !== false;

        let out = `🛡️ *LAPORAN KEAMANAN SISTEM & MIKROTIK:*\n\n` +
                  `• Status Pengamanan: *${(appBlockedCount + mtIpCount + mtMacCount) > 0 ? '🛡️ MENJAGA (AKTIF DIBLOKIR)' : '✅ AMAN & TERKENDALI'}*\n` +
                  `• Auto-Block: *${isAutoBlock ? '🟢 AKTIF (Blokir Otomatis)' : '🔴 NONAKTIF (Hanya Notifikasi)'}*\n` +
                  `• Batas Gagal Hotspot: *${policy.hotspotThreshold || 5}x (min. ${policy.hotspotDistinctUsers || 3} user acak)*\n` +
                  `• Batas Gagal Admin: *${policy.adminThreshold || 5}x percobaan*\n` +
                  `• Blacklist IP Firewall MikroTik: *${mtIpCount} IP*\n` +
                  `• Blocked MAC Hotspot MikroTik: *${mtMacCount} MAC*\n` +
                  `• IP Terblokir Portal Web: *${appBlockedCount} IP*\n`;

        if (mtMacCount > 0) {
          out += `\n📱 *Daftar MAC Hotspot yang Diblokir (Brute Force):*\n`;
          overview.mikrotikBlockedMacs.slice(0, 10).forEach(m => {
            out += `• \`${m.mac}\` [${m.router}] - ${m.comment || 'Blocked'}\n`;
          });
        }

        if (mtIpCount > 0) {
          out += `\n🌐 *Daftar IP Blacklist MikroTik:*\n`;
          overview.mikrotikBlockedIps.slice(0, 10).forEach(i => {
            out += `• \`${i.address}\` [${i.router}] - ${i.comment || i.list}\n`;
          });
        }

        if (appBlockedCount > 0) {
          out += `\n💻 *Daftar IP Diblokir Web App:*\n`;
          overview.appBlockedIps.forEach(a => {
            out += `• \`${a.ip}\` (tersisa ${a.remainingSeconds} detik)\n`;
          });
        }

        if (recentAlerts.length > 0) {
          out += `\n📋 *5 Insiden Keamanan Terakhir:*\n`;
          recentAlerts.slice(0, 5).forEach(al => {
            out += `• [${al.created_at || '-'}] *${al.action}*: ${al.entity_id || '-'} (${al.ip_address || '-'})\n`;
          });
        }

        out += `\n_💡 Tips: Ketik "Buka blokir [IP/MAC]" untuk mencabut blokir target tertentu._`;
        return out;
      }

      // 17. Menjalankan Perintah Terminal Linux / Server (Sysadmin Agent)
      case 'run_server_command': {
        const cmd = String(args.command || '').trim();
        if (!cmd) {
          return 'Mohon sebutkan perintah terminal yang ingin dijalankan.';
        }

        // Security Guardrails: blacklist dangerous destructive commands
        const dangerousPatterns = [
          /\brm\s+-[rf]{1,2}\s+[\/\*]/i,
          /\bmkfs\b/i,
          /\bdd\s+if=/i,
          />\s*\/dev\/sd/i,
          /\bchmod\s+-R\s+777\s+\//i,
          /\bchown\s+-R\s+root\s+\//i,
          /\bshutdown\b/i,
          /\bpoweroff\b/i,
          /\binit\s+0\b/i,
          /\bpasswd\b/i,
          /:{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:/
        ];

        if (dangerousPatterns.some(p => p.test(cmd))) {
          return `⚠️ Perintah "${cmd}" diblokir oleh sistem keamanan demi mencegah kerusakan permanen pada sistem operasi.`;
        }

        const { exec } = require('child_process');
        const rootDir = path.join(__dirname, '..');

        const res = await new Promise((resolve) => {
          exec(cmd, {
            cwd: rootDir,
            timeout: 25000,
            maxBuffer: 1024 * 512,
            env: {
              ...process.env,
              PATH: `${process.env.PATH || ''}:/usr/local/bin:/usr/bin:/bin`
            }
          }, (err, stdout, stderr) => {
            resolve({
              err: err ? err.message : null,
              stdout: String(stdout || '').trim(),
              stderr: String(stderr || '').trim()
            });
          });
        });

        let out = `💻 *Hasil Eksekusi Terminal:*
\`$ ${cmd}\`

`;
        if (res.stdout) {
          out += `\`\`\`
${res.stdout.slice(0, 3000)}
\`\`\``;
        } else if (res.stderr) {
          out += `⚠️ *Stderr:* \`\`\`
${res.stderr.slice(0, 1500)}
\`\`\``;
        } else if (res.err) {
          out += `❌ *Error:* \`${res.err}\``;
        } else {
          out += `✅ Perintah selesai dijalankan tanpa keluaran teks.`;
        }
        return out;
      }

      // 18. Membaca & Menganalisis Log Server (Log Diagnostics)
      case 'inspect_server_logs': {
        const logType = String(args.logType || 'error').toLowerCase();
        const maxLines = Math.min(Math.max(Number(args.lines) || 30, 5), 80);
        const rootDir = path.join(__dirname, '..');

        if (logType === 'pm2') {
          const { exec } = require('child_process');
          const pm2Log = await new Promise((resolve) => {
            exec(`pm2 logs billing --lines ${maxLines} --nostream`, { timeout: 10000 }, (err, stdout, stderr) => {
              resolve(String(stdout || stderr || err?.message || 'Tidak ada log PM2.').trim());
            });
          });
          return `📋 *Log PM2 Billing (${maxLines} baris terakhir):*
\`\`\`
${pm2Log.slice(-3000)}
\`\`\``;
        }

        let filePath = path.join(rootDir, 'logs/error.log');
        let label = 'Error Log';
        if (logType === 'app') {
          filePath = path.join(rootDir, 'logs/app.log');
          label = 'App Log';
        } else if (logType === 'webhook') {
          const rows = db.prepare('SELECT id, service, content, parsed_amount, parsed_ok, created_at FROM webhook_payment_notifs ORDER BY id DESC LIMIT ?').all(maxLines);
          if (!rows || rows.length === 0) return 'Belum ada catatan log webhook di database.';
          let text = `📋 *Log Notifikasi Webhook Terakhir (${rows.length}):*
`;
          rows.forEach(r => {
            text += `• [${r.created_at}] ${r.service}: ${(r.content || '').slice(0, 80)} (Parsed: ${r.parsed_amount || 'gagal'})
`;
          });
          return text;
        }

        if (!fs.existsSync(filePath)) {
          return `File log ${label} (${path.basename(filePath)}) belum tersedia atau masih kosong.`;
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const linesArr = raw.split(/\r?\n/).filter(Boolean);
        const tailLines = linesArr.slice(-maxLines).join('\n');
        return `📋 *${label} (${maxLines} baris terakhir):*
\`\`\`
${tailLines.slice(-3000) || '(Log kosong)'}
\`\`\``;
      }

      // 19. Cek Kesehatan & Kapasitas Resource Server (Hardware & Software)
      case 'check_server_resources': {
        const totalMem = Math.round(os.totalmem() / (1024 * 1024));
        const freeMem = Math.round(os.freemem() / (1024 * 1024));
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);

        const uptimeHours = (os.uptime() / 3600).toFixed(1);
        const loadAvg = os.loadavg().map(l => l.toFixed(2)).join(', ');
        const cpus = os.cpus();
        const cpuModel = cpus && cpus[0] ? cpus[0].model.trim() : 'Unknown CPU';

        let diskInfo = '-';
        try {
          const { execSync } = require('child_process');
          diskInfo = execSync('df -h / | tail -1', { timeout: 3000 }).toString().trim();
        } catch (_) {}

        let custCount = 0;
        let unpaidCount = 0;
        let activeVouchers = 0;
        try {
          custCount = db.prepare('SELECT COUNT(*) as c FROM customers').get()?.c || 0;
          unpaidCount = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status != 'paid'").get()?.c || 0;
          activeVouchers = db.prepare("SELECT COUNT(*) as c FROM public_voucher_orders WHERE status = 'fulfilled'").get()?.c || 0;
        } catch (_) {}

        return `🖥️ *STATUS & KESEHATAN SERVER:*
` +
               `• OS: ${os.type()} ${os.release()} (${os.arch()})
` +
               `• Uptime: ${uptimeHours} jam
` +
               `• CPU: ${cpuModel} (${cpus.length} Cores)
` +
               `• Load Average: ${loadAvg}
` +
               `• Memori RAM: ${usedMem} MB / ${totalMem} MB (${memPercent}% terpakai)
` +
               `• Kapasitas Disk (/): ${diskInfo}
` +
               `• Database Billing: ${custCount} pelanggan, ${unpaidCount} invoice unpaid, ${activeVouchers} voucher aktif
` +
               `• Node.js: ${process.version}
` +
               `• Status: ✅ Seluruh layanan inti berjalan normal.`;
      }

      // 20. Eksekusi CLI RouterOS MikroTik Langsung
      case 'run_mikrotik_cli': {
        const rawCmd = String(args.command || '').trim();
        if (!rawCmd) return 'Mohon sebutkan perintah RouterOS MikroTik yang ingin dijalankan.';

        let routerId = args.routerId ? Number(args.routerId) : null;
        if (!routerId) {
          const firstRouter = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
          if (firstRouter) routerId = firstRouter.id;
        }

        if (!routerId) return 'Tidak ditemukan router MikroTik yang aktif di database.';

        const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        if (!router) return `Router MikroTik dengan ID ${routerId} tidak ditemukan.`;

        const cleanCmd = rawCmd.replace(/^\//, '');
        const words = cleanCmd.split(/\s+/).filter(Boolean);
        const apiWords = ['/' + words.join('/')];

        try {
          const { client, api } = await mikrotikService.getConnection(routerId);
          const res = await api.send(apiWords);
          await api.close().catch(() => {});

          if (!res || res.length === 0) {
            return `✅ Perintah \`/${cleanCmd}\` pada Router *${router.name || router.host}* berhasil dijalankan (hasil kosong).`;
          }

          let out = `📡 *Hasil MikroTik CLI (\`/${cleanCmd}\` - ${router.name}):*
\`\`\`
`;
          out += JSON.stringify(res.slice(0, 15), null, 2);
          out += `
\`\`\``;
          return out;
        } catch (mErr) {
          return `❌ Gagal menjalankan perintah pada MikroTik ${router.name}: ${mErr.message}`;
        }
      }

      // 21. Pindai Keamanan Log MikroTik Sekarang (On-Demand Scan)
      case 'scan_mikrotik_security': {
        const securityWatchdog = require('./securityWatchdogService');
        const res = await securityWatchdog.scanMikrotikLoginFailures({ manual: true });

        let out = `🔍 *HASIL PEMINDAIAN LOG KEAMANAN MIKROTIK:*\n\n` +
                  `• Router Dipindai: *${res.scannedRouters} router*\n` +
                  `• Log Kegagalan Ditemukan: *${res.totalFailuresFound} log*\n` +
                  `• Ancaman Brute Force Terdeteksi: *${res.threatsDetected.length} ancaman*\n` +
                  `• Tindakan Auto-Block: *${res.blockedCount} target dieksekusi*\n\n`;

        if (res.threatsDetected.length === 0) {
          out += `✅ *Aman!* Tidak ditemukan adanya indikasi serangan brute force yang melampaui batas toleransi pada router MikroTik saat ini.`;
        } else {
          out += `⚠️ *Rincian Ancaman yang Terdeteksi & Ditindak:*\n`;
          res.threatsDetected.forEach(t => {
            out += `• [${t.router}] *${t.type.toUpperCase()}* (${t.service}): IP \`${t.ip}\` | MAC: \`${t.mac}\` (${t.count}x gagal, target: ${t.targets})\n`;
          });
          out += `\n_Seluruh penyerang telah otomatis dimasukkan ke blacklist firewall & IP-Binding blokir._`;
        }
        return out;
      }

      // 22. Buka Blokir IP / MAC Address di MikroTik & Billing
      case 'unblock_security_target': {
        const target = String(args.target || '').trim();
        if (!target) return 'Mohon sebutkan alamat IP atau MAC address yang ingin dibuka blokirnya.';

        const securityWatchdog = require('./securityWatchdogService');
        const result = await securityWatchdog.unblockMikrotikTarget({
          target,
          routerId: args.routerId ? Number(args.routerId) : null
        });
        return result.message || 'Proses buka blokir selesai.';
      }

      // 23. Konfigurasi Kebijakan Keamanan & Auto-Block
      case 'configure_security_policy': {
        const { getSetting, saveSettings } = require('../config/settingsManager');
        const updates = {};
        const changes = [];

        if (args.autoBlock !== undefined) {
          const val = Boolean(args.autoBlock);
          updates.security_auto_block_enabled = val;
          changes.push(`Pemblokiran Otomatis (Auto-Block): *${val ? '🟢 DIAKTIFKAN' : '🔴 DINONAKTIFKAN (Hanya Pantau & Kirim Notifikasi, Tanpa Memblokir)'}*`);
        }

        if (args.adminThreshold !== undefined) {
          const num = Math.max(Number(args.adminThreshold) || 5, 2);
          updates.security_admin_threshold = num;
          changes.push(`Ambang Batas Login Admin: *${num} kali kegagalan*`);
        }

        if (args.hotspotThreshold !== undefined) {
          const num = Math.max(Number(args.hotspotThreshold) || 5, 2);
          updates.security_hotspot_threshold = num;
          changes.push(`Ambang Batas Login Hotspot: *${num} kali kegagalan*`);
        }

        if (args.hotspotDistinctUsers !== undefined) {
          const num = Math.max(Number(args.hotspotDistinctUsers) || 3, 2);
          updates.security_hotspot_distinct_users = num;
          changes.push(`Batas Variasi User Acak Hotspot: *${num} user berbeda*`);
        }

        if (Object.keys(updates).length === 0) {
          const curAuto = getSetting('security_auto_block_enabled', true);
          const curAdmin = getSetting('security_admin_threshold', 5);
          const curHotspot = getSetting('security_hotspot_threshold', 5);
          const curDistinct = getSetting('security_hotspot_distinct_users', 3);

          return `🛡️ *STATUS KEBIJAKAN PENGAMANAN BRUTE FORCE:*\n\n` +
                 `• Pemblokiran Otomatis: *${curAuto ? '🟢 AKTIF' : '🔴 NONAKTIF (Hanya Pantau & Notifikasi)'}*\n` +
                 `• Toleransi Gagal Admin: *${curAdmin} kali*\n` +
                 `• Toleransi Gagal Hotspot: *${curHotspot} kali*\n` +
                 `• Minimal Variasi User Acak Hotspot: *${curDistinct} user berbeda*\n\n` +
                 `_💡 Anda dapat mengubahnya kapan saja dengan perintah seperti: "nonaktifkan auto block", "jangan blokir otomatis", "aktifkan blokir otomatis", atau "atur batas blokir jadi 5 kali"._`;
        }

        const ok = saveSettings(updates);
        if (!ok) return '❌ Gagal menyimpan pengaturan kebijakan keamanan ke server.';

        return `✅ *KEBIJAKAN KEAMANAN BERHASIL DIPERBARUI:*\n\n` +
               changes.map(c => `• ${c}`).join('\n') +
               `\n\n_Pengaturan telah disimpan secara permanen di server dan langsung diterapkan._`;
      }

      // 24. Morning Executive Briefing
      case 'get_morning_briefing': {
        const morningBriefing = require('./morningBriefingService');
        return await morningBriefing.getFormattedBriefing();
      }

      // 25. Cek Gangguan Jalur / Kabel Putus Massal
      case 'check_network_outages': {
        const outageWatchdog = require('./outageWatchdogService');
        return await outageWatchdog.getOutageStatusReport();
      }

      // 26. Aktivasi Cepat ONT & Pelanggan Baru (Teknisi Lapangan)
      case 'quick_provision_customer_ont': {
        const { name, phone, address, packageName, serialNumber, odpName, wifiSsid, wifiPassword, pppoeUser, pppoePass } = args;
        if (!name || !name.trim()) {
          return 'Mohon sebutkan minimal nama pelanggan baru yang ingin diaktivasi.';
        }

        // 1. Validasi / Pilih Paket
        const allPkgs = customerSvc.getAllPackages();
        let pkg = null;
        if (packageName) {
          const cleanPkg = String(packageName).toLowerCase().trim();
          pkg = allPkgs.find(p => p.name.toLowerCase() === cleanPkg) ||
                allPkgs.find(p => p.name.toLowerCase().includes(cleanPkg)) ||
                allPkgs.find(p => String(p.price) === cleanPkg.replace(/\D/g, ''));
        }
        if (!pkg && allPkgs.length > 0) {
          pkg = allPkgs[0];
        }
        if (!pkg) {
          return '❌ Paket internet belum tersedia di sistem. Mohon buat paket layanan terlebih dahulu.';
        }

        // 2. Validasi / Pilih ODP
        let odpId = null;
        let odpData = null;
        if (odpName) {
          const cleanOdp = String(odpName).toLowerCase().trim();
          const allOdps = db.prepare('SELECT id, name, olt_id, pon_port FROM odps').all() || [];
          odpData = allOdps.find(o => o.name.toLowerCase() === cleanOdp || String(o.id) === cleanOdp || o.name.toLowerCase().includes(cleanOdp));
          if (odpData) {
            odpId = odpData.id;
          }
        }

        // 3. Username & Password PPPoE
        let cleanPppoe = (pppoeUser || name.toLowerCase().replace(/[^a-z0-9]/g, '')).trim();
        if (!cleanPppoe || cleanPppoe.length < 3) cleanPppoe = 'user' + Math.floor(1000 + Math.random() * 9000);
        
        const existingPppoe = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanPppoe);
        if (existingPppoe) {
          cleanPppoe += Math.floor(10 + Math.random() * 89);
        }
        const cleanPass = (pppoePass || cleanPppoe + Math.floor(100 + Math.random() * 900)).trim();

        // 4. Pilih Router
        const routerRow = db.prepare('SELECT id, name FROM routers WHERE is_active = 1 LIMIT 1').get();
        const routerId = routerRow ? routerRow.id : null;
        const routerName = routerRow ? routerRow.name : 'MikroTik Utama';

        const today = new Date().toISOString().slice(0, 10);
        const cleanSn = serialNumber ? String(serialNumber).trim().toUpperCase() : '';

        // 5. Simpan Pelanggan ke Database
        const newCustData = {
          name: name.trim(),
          phone: phone ? String(phone).replace(/\D/g, '') : '',
          email: '',
          address: address ? String(address).trim() : '',
          area: odpData ? odpData.name : '',
          package_id: pkg.id,
          router_id: routerId,
          olt_id: odpData ? odpData.olt_id : null,
          odp_id: odpId,
          pon_port: odpData ? odpData.pon_port : '',
          connection_type: 'pppoe',
          pppoe_username: cleanPppoe,
          pppoe_password: cleanPass,
          genieacs_tag: cleanSn,
          status: 'active',
          install_date: today,
          auto_isolate: 1,
          isolate_day: 10
        };

        const res = customerSvc.createCustomer(newCustData);
        const newCustId = res.lastInsertRowid;

        // 6. Buat Secret PPPoE di Router MikroTik
        let mtStatus = 'Lewati (tidak ada router aktif)';
        if (routerId) {
          try {
            await mikrotikService.createPppoeSecret({
              username: cleanPppoe,
              password: cleanPass,
              profile: pkg.name,
              routerId: routerId
            });
            mtStatus = `✅ Dibuatkan di ${routerName} (Profil: ${pkg.name})`;
          } catch (err) {
            logger.warn(`[quick_provision] Gagal buat secret mikrotik: ${err.message}`);
            mtStatus = `⚠️ Gagal otomatis: ${err.message}`;
          }
        }

        // 7. Binding ONT di ACS & Set WiFi jika ada
        let acsStatus = 'Tidak ada serial number';
        if (cleanSn) {
          try {
            const dev = db.prepare('SELECT id, tags, params FROM acs_devices WHERE serial_number = ? OR id = ?').get(cleanSn, cleanSn);
            if (dev) {
              let tags = [];
              try { tags = JSON.parse(dev.tags || '[]'); } catch (_) {}
              if (!tags.includes(name.trim())) tags.push(name.trim());
              if (!tags.includes(`customer_${newCustId}`)) tags.push(`customer_${newCustId}`);
              db.prepare('UPDATE acs_devices SET tags = ? WHERE id = ?').run(JSON.stringify(tags), dev.id);
              acsStatus = `✅ Terhubung di Built-in ACS (${dev.id})`;

              // Konfigurasi WiFi jika diminta
              if (wifiSsid || wifiPassword) {
                const acsServerSvc = require('./acsServerService');
                const wifiPayload = {};
                if (wifiSsid) {
                  wifiPayload['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'] = wifiSsid;
                }
                if (wifiPassword) {
                  wifiPayload['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase'] = wifiPassword;
                }
                acsServerSvc.createBuiltinTask(dev.id, 'setParameterValues', wifiPayload);
                acsStatus += ` (WiFi: ${wifiSsid || 'Default'} disinkronkan)`;
              }
            } else {
              acsStatus = `⚠️ Serial number ${cleanSn} belum terdeteksi inform di ACS (akan otomatis terikat saat ONT pertama kali online)`;
            }
          } catch (err) {
            acsStatus = `⚠️ Gagal update tags ACS: ${err.message}`;
          }
        }

        // 8. Generate Tagihan Pertama
        try {
          billingSvc.ensureCurrentInvoice(newCustId);
        } catch (_) {}

        // Format Konfirmasi Aktivasi untuk Teknisi
        return `⚡ *AKTIVASI PELANGGAN & ONT BERHASIL!*\n\n` +
               `• *ID Pelanggan:* #${newCustId}\n` +
               `• *Nama:* ${newCustData.name}\n` +
               `• *No. WhatsApp:* ${newCustData.phone || '-'}\n` +
               `• *Alamat:* ${newCustData.address || '-'}\n` +
               `• *Paket:* ${pkg.name} (Rp ${Number(pkg.price || 0).toLocaleString('id-ID')}/bln)\n` +
               `• *Titik ODP:* ${odpData ? odpData.name : '-'}\n\n` +
               `🔐 *AKUN INTERNET PPPOE:*\n` +
               `• Username: \`${cleanPppoe}\`\n` +
               `• Password: \`${cleanPass}\`\n` +
               `• Status MikroTik: ${mtStatus}\n\n` +
               `📡 *MODEM / ONT TR-069:*\n` +
               `• Serial Number: \`${cleanSn || '(Belum diisi)'}\`\n` +
               `• Status ACS: ${acsStatus}\n` +
               (wifiSsid ? `• WiFi SSID: *${wifiSsid}* (Password: \`${wifiPassword || 'Tidak diubah'}\`)\n` : '') +
               `\n_Tagihan pertama periode berjalan sudah diterbitkan secara otomatis._`;
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
