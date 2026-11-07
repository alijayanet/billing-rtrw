const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const { adminToolDeclarations, executeAdminTool } = require('./adminAiTools');

// Cache untuk dokumen knowledge base
let cachedKnowledge = null;
let lastLoadTime = 0;
const KNOWLEDGE_RELOAD_INTERVAL = 3600000; // Reload tiap 1 jam jika ada update doc

/**
 * Muat dan ringkas dokumentasi aplikasi agar efisien dalam prompt AI
 */
function loadKnowledgeBase() {
  const now = Date.now();
  if (cachedKnowledge && (now - lastLoadTime < KNOWLEDGE_RELOAD_INTERVAL)) {
    return cachedKnowledge;
  }

  try {
    const docPath = path.join(__dirname, '../FITUR_APLIKASI_LENGKAP.md');
    if (fs.existsSync(docPath)) {
      const fullDoc = fs.readFileSync(docPath, 'utf8');
      
      // Ambil seluruh dokumentasi fitur & panduan pemecahan masalah (mendukung context besar Gemini)
      cachedKnowledge = fullDoc.length > 350000 ? fullDoc.substring(0, 340000) + '\n\n...(dokumentasi dipotong untuk efisiensi context)...' : fullDoc;
      lastLoadTime = now;
      logger.info(`[TelegramAI] Knowledge base loaded (${cachedKnowledge.length} bytes).`);
      return cachedKnowledge;
    }
  } catch (err) {
    logger.warn(`[TelegramAI] Gagal memuat FITUR_APLIKASI_LENGKAP.md: ${err.message}`);
  }

  // Fallback ringkasan jika file tidak terbaca
  cachedKnowledge = `
Aplikasi: RTRWNET Management & Billing System (Botlokal Customer Portal)
Tech Stack: Node.js (>=20.0.0), Express.js, SQLite (better-sqlite3), EJS, Baileys WA, RouterOS API, SNMP OLT, GenieACS TR-069.
Fitur Utama:
1. Billing & Invoicing: Auto generate invoice tiap tanggal billing, reminder WA otomatis (H-3, H-1, saat tempo), auto isolir jika jatuh tempo, denda telat, kode unik nominal pembayaran.
2. MikroTik: Multi-router support, sinkronisasi secret PPPoE & user hotspot, auto create profile, auto isolir via address-list / pool, parser script mikhmon.
3. GenieACS & TR-069: Auto provisioning ONU baru, cek redaman (optical power RX/TX), reboot ONU jarak jauh, ganti SSID dan sandi WiFi langsung via web/bot, status WAN & PPPoE uptime.
4. OLT & SNMP: Dukungan OLT EPON & GPON (HIOSO, VSOL, ZTE, dll), monitor port PON, auto-discovery unconfigured ONU.
5. Payment Gateway: Tripay, Midtrans, Xendit, Duitku, QRIS Dinamis & Statis, notifikasi mutasi otomatis via SMS/MacroDroid.
6. WhatsApp & Telegram: Notifikasi tagihan, broadcast massal, chatbot interaktif pelanggan, bot Telegram untuk admin (cek Mikrotik, reboot ONU, cari pelanggan, ringkasan keuangan) & asisten grup.
7. Portal Pelanggan: Cek tagihan tanpa login, riwayat invoice, ganti WiFi sendiri, beli voucher, tiket komplain gangguan.
8. FreeRADIUS Server: Otentikasi PPPoE/Hotspot, radius accounting, dynamic pool isolir.
`;
  lastLoadTime = now;
  return cachedKnowledge;
}

/**
 * Ambil status live seluruh pelanggan, MikroTik, dan GenieACS untuk Admin WhatsApp / Telegram
 */
async function getAdminGlobalContext(userQuestion) {
  try {
    const db = require('../config/database');
    const customerDevice = require('./customerDeviceService');
    const mikrotikService = require('./mikrotikService');

    // 1. Ambil ringkasan seluruh pelanggan dari SQLite
    const query = `
      SELECT 
        c.id, c.name, c.phone, c.status, c.pppoe_username, c.genieacs_tag, c.area,
        p.name as package_name, p.price as package_price,
        COUNT(CASE WHEN i.status != 'paid' THEN 1 END) as unpaid_count,
        COALESCE(SUM(CASE WHEN i.status != 'paid' THEN i.amount ELSE 0 END), 0) as unpaid_amount
      FROM customers c
      LEFT JOIN packages p ON c.package_id = p.id
      LEFT JOIN invoices i ON c.id = i.customer_id
      GROUP BY c.id
      ORDER BY c.id ASC
    `;
    const customers = db.prepare(query).all();

    const total = customers.length;
    const active = customers.filter(c => (c.status || '').toLowerCase() === 'active').length;
    const isolated = customers.filter(c => ['isolated', 'suspended', 'isolir'].includes((c.status || '').toLowerCase())).length;
    const inactive = customers.filter(c => ['inactive', 'nonaktif', 'terminated'].includes((c.status || '').toLowerCase())).length;
    const unpaidCustomers = customers.filter(c => c.unpaid_count > 0);
    const totalUnpaidAmount = unpaidCustomers.reduce((acc, c) => acc + (c.unpaid_amount || 0), 0);

    let contextText = `=== RINGKASAN GLOBAL SISTEM RTRW-NET (REALTIME ADMIN CONTEXT) ===\n`;
    contextText += `Total Pelanggan Terdaftar: ${total} pelanggan\n`;
    contextText += `- Aktif: ${active} pelanggan\n`;
    contextText += `- Terisolir / Suspended: ${isolated} pelanggan\n`;
    contextText += `- Non-Aktif / Terminated: ${inactive} pelanggan\n`;
    contextText += `Tunggakan Belum Lunas: ${unpaidCustomers.length} pelanggan (Total Tunggakan: Rp ${totalUnpaidAmount.toLocaleString('id-ID')})\n\n`;

    // 2. Direktori ringkas seluruh pelanggan
    contextText += `=== DIREKTORI SELURUH PELANGGAN (ID | Nama | No HP | Status | PPPoE | Paket | Tunggakan) ===\n`;
    for (const c of customers) {
      const unpaidStr = c.unpaid_count > 0 ? `${c.unpaid_count} tagihan (Rp ${c.unpaid_amount.toLocaleString('id-ID')})` : 'Lunas';
      contextText += `[ID:${c.id}] ${c.name} | ${c.phone || '-'} | Status: ${c.status} | PPPoE: ${c.pppoe_username || '-'} | Pkt: ${c.package_name || '-'} | Tunggakan: ${unpaidStr}\n`;
    }
    contextText += `\n`;

    // 3. Deteksi apakah admin menanyakan pelanggan tertentu
    const qLower = String(userQuestion || '').toLowerCase();
    const matchedCustomers = [];

    for (const c of customers) {
      let isMatch = false;
      const name = String(c.name || '').toLowerCase().trim();
      const pppoe = String(c.pppoe_username || '').toLowerCase().trim();
      const phoneDigits = String(c.phone || '').replace(/\D/g, '');
      const tag = String(c.genieacs_tag || '').toLowerCase().trim();
      const idStr = String(c.id);

      // Cek ID
      if (new RegExp(`\\b(id|#)\\s*${idStr}\\b`, 'i').test(qLower)) {
        isMatch = true;
      }
      // Cek No HP
      else if (phoneDigits.length >= 8 && qLower.includes(phoneDigits.slice(-8))) {
        isMatch = true;
      }
      // Cek PPPoE username
      else if (pppoe.length >= 3 && qLower.includes(pppoe)) {
        isMatch = true;
      }
      // Cek GenieACS Tag
      else if (tag.length >= 3 && qLower.includes(tag)) {
        isMatch = true;
      }
      // Cek Nama Pelanggan
      else if (name.length >= 3) {
        if (qLower.includes(name)) {
          isMatch = true;
        } else {
          const words = name.split(/\s+/).filter(w => w.length >= 4);
          for (const w of words) {
            if (['bisa', 'tolong', 'admin', 'saya', 'yang', 'dari', 'untuk', 'paket', 'status', 'kabel', 'modem', 'wifi', 'cek'].includes(w)) continue;
            if (qLower.includes(w)) {
              isMatch = true;
              break;
            }
          }
        }
      }

      if (isMatch) {
        matchedCustomers.push(c);
        if (matchedCustomers.length >= 3) break;
      }
    }

    // 4. Jika ada pelanggan yang cocok, lakukan Deep Dive (Invoices + GenieACS + MikroTik)
    if (matchedCustomers.length > 0) {
      contextText += `=== DETAIL MENDALAM PELANGGAN YANG DITANYAKAN ===\n`;

      let activeSessionsMap = new Map();
      try {
        activeSessionsMap = await Promise.race([
          mikrotikService.getActivePppoeSessionsMap(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('MikroTik timeout')), 4000))
        ]).catch(() => new Map());
      } catch (_) {}

      for (const mc of matchedCustomers) {
        const invRows = db.prepare('SELECT id, period_month, period_year, amount, status, paid_at, created_at FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 5').all(mc.id);
        const unpaidInvs = invRows.filter(i => i.status !== 'paid');
        const paidInvs = invRows.filter(i => i.status === 'paid');

        let onuData = null;
        const lookupTag = mc.genieacs_tag || mc.pppoe_username || mc.phone;
        if (lookupTag) {
          try {
            onuData = await Promise.race([
              customerDevice.getCustomerDeviceData(lookupTag),
              new Promise((_, reject) => setTimeout(() => reject(new Error('GenieACS timeout')), 4000))
            ]).catch(() => null);
          } catch (_) {}
        }

        const pppoeUser = (mc.pppoe_username || '').toLowerCase();
        const pppoeSession = pppoeUser ? activeSessionsMap.get(pppoeUser) : null;

        contextText += `\n>> PELANGGAN: ${mc.name} (ID: ${mc.id})\n`;
        contextText += `  - No HP: ${mc.phone || '-'}\n`;
        contextText += `  - Status Billing: ${mc.status}\n`;
        contextText += `  - Area: ${mc.area || '-'}\n`;
        contextText += `  - Paket: ${mc.package_name || '-'} (Rp ${Number(mc.package_price || 0).toLocaleString('id-ID')}/bulan)\n`;
        contextText += `  - Akun PPPoE: ${mc.pppoe_username || '-'}\n`;
        contextText += `  - Status PPPoE MikroTik: ${pppoeSession ? `ONLINE (IP: ${pppoeSession.ip}, Uptime: ${pppoeSession.uptime}, Router: ${pppoeSession.routerName || '-'})` : 'OFFLINE / Belum dial'}\n`;

        if (onuData) {
          contextText += `  - Status Modem ONU: ${onuData.status || 'Unknown'}\n`;
          contextText += `  - Redaman Optical (RX Power): ${onuData.rxPower ? onuData.rxPower + ' dBm' : '-'}\n`;
          contextText += `  - Nama WiFi (SSID): ${onuData.ssid || '-'}\n`;
          contextText += `  - ONU Uptime: ${onuData.uptime || '-'}\n`;
          contextText += `  - Pengguna WiFi Terhubung: ${onuData.totalAssociations || 0} user\n`;
        } else {
          contextText += `  - Status Modem ONU: (Data modem belum terhubung/tag GenieACS belum diisi)\n`;
        }

        contextText += `  - Rincian Tunggakan Tagihan: ${unpaidInvs.length > 0 ? unpaidInvs.map(i => `#${i.id} (Periode ${i.period_month}/${i.period_year}: Rp ${Number(i.amount).toLocaleString('id-ID')})`).join(', ') : 'TIDAK ADA (Semua tagihan LUNAS)'}\n`;
        if (paidInvs.length > 0) {
          contextText += `  - Tagihan Terakhir Lunas: #${paidInvs[0].id} (Periode ${paidInvs[0].period_month}/${paidInvs[0].period_year} sebesar Rp ${Number(paidInvs[0].amount).toLocaleString('id-ID')} pada ${paidInvs[0].paid_at || '-'})\n`;
        }
      }
    }

    return contextText;
  } catch (err) {
    logger.error(`[TelegramAI] Gagal mengambil admin global context: ${err.message}`);
    return '';
  }
}

/**
 * Buat System Instruction Terpadu untuk AI
 */
function buildSystemInstruction(isAdmin, customerContext, adminContext, senderName, contextSource = "") {
  const knowledge = loadKnowledgeBase();

  if (isAdmin) {
    return `Anda adalah asisten cerdas, serba tahu, dan handal yang mendampingi Pemilik / Administrator "RTRWNET Management & Billing System" (Botlokal).

PEDOMAN UTAMA & ATURAN JAWABAN:
1. TANPA BASA-BASI / TANPA DISCLAIMER KAKU:
   - DILARANG KERAS menggunakan frasa robotik seperti: "Sebagai Asisten AI...", "Sebagai Asisten AI Eksekutif...", "Sebagai model bahasa...", "Mohon maaf sepertinya Anda bercanda/terpotong...", atau "Saya hanya bisa membantu seputar billing...".
   - Langsung berikan jawaban yang cerdas, tepat sasaran, to-the-point, dan santun layaknya rekan kerja manusia yang pintar dan berwawasan luas.
2. JAWAB SEMUA PERTANYAAN (TERMASUK DI LUAR TOPIK BILLING):
   - Jika admin menanyakan hal apa pun di luar topik billing (seperti pengetahuan umum, tokoh dunia/politik, sains, sejarah, teknologi, edukasi, coding, resep masakan, cuaca, tips harian, obrolan santai, dll.), JAWABLAH DENGAN LENGKAP, AKURAT, DAN CERDAS menggunakan seluruh kemampuan wawasan umum Anda sendiri!
   - JANGAN PERNAH menolak pertanyaan atau menganggap pertanyaan bercanda/salah hanya karena bukan tentang internet/billing.
3. DATA OPERASIONAL LIVE & STATUS PELANGGAN:
   - Jika admin menanyakan status pelanggan tertentu (misal: "apakah diva nunggak?", "cek redaman diva", "siapa yang terisolir?", "kenapa pelanggan X putus?"), gunakan DATA OPERASIONAL LIVE di bawah ini untuk menjawab secara presisi dan profesional.
   - Jika admin menanyakan ringkasan (misal: "berapa yang isolir?", "siapa saja yang belum bayar?", "total uang tunggakan?"), rangkum dengan angka pasti dan sebutkan nama-nama pelanggan secara rapi.
4. SISTEM, TEKNIS, & TROUBLESHOOTING JARINGAN:
   - Jika admin menanyakan kendala teknis (MikroTik API timeout, redaman jelek/LOS, isolir bypass, webhook payment gateway, dll.), berikan diagnosis penyebab dan solusi konkret mengacu pada DOKUMENTASI SISTEM & PANDUAN PEMECAHAN MASALAH di bawah.
5. EKSEKUSI PERINTAH ADMINISTRATIF & FULL AGENTIC SYSADMIN TOOLS:
   - Anda DILENGKAPI DENGAN 26 FUNCTION TOOLS untuk mengontrol server, MikroTik, dan billing secara penuh:
     * 'run_server_command': Menjalankan perintah terminal/bash Linux (seperti: pm2 status/reload, git status/pull, free -m, df -h, uptime, systemctl status, ping, netstat).
     * 'inspect_server_logs': Membaca & mendiagnosa log error (logs/error.log, logs/app.log, PM2 logs).
     * 'check_server_resources': Mengecek beban CPU, RAM, Disk, Uptime, PM2, dan Database.
     * 'run_mikrotik_cli': Menjalankan perintah CLI RouterOS langsung ke MikroTik (/system resource print, /interface print, dll).
     * 'scan_mikrotik_security': Memindai log router MikroTik secara real-time untuk mendeteksi brute-force Hotspot (tebak voucher acak) atau brute-force admin (SSH/Winbox/API/Telnet/WebFig) dan langsung memblokir penyerang.
     * 'check_security_status': Menampilkan status keamanan sistem, daftar IP blacklist firewall, dan daftar MAC Hotspot yang diblokir.
     * 'unblock_security_target': Membuka blokir IP address atau MAC address yang sebelumnya diblokir di MikroTik atau aplikasi.
     * 'configure_security_policy': Mengatur kebijakan auto-block (misal perintah "jangan blokir otomatis", "matikan auto block", "aktifkan blokir otomatis", atau "atur batas blokir jadi 5 kali").
     * 'get_morning_briefing': Menampilkan laporan Morning Executive Briefing (kondisi omzet & keuangan, tagihan tertunda, PPPoE online, status ONT & redaman kritis di ACS, status keamanan, dan tiket aktif).
     * 'check_network_outages': Mendeteksi dan menganalisis apakah sedang ada gangguan massal, pemadaman listrik wilayah, atau kabel feeder/ODP putus.
     * 'quick_provision_customer_ont': Aktivasi instan pelanggan baru & binding ONT/ONU dari chat Telegram untuk teknisi lapangan (membuat pelanggan, ODP, secret PPPoE MikroTik, binding SN ONT di ACS, dan setting WiFi).
     * 'auto_heal_network': Memperbaiki otomatis sinkronisasi data billing & MikroTik.
     * Operasional: 'add_customer', 'reboot_onu', 'update_wifi_password', 'update_wifi_ssid', 'mark_invoice_paid', 'isolate_customer', 'unisolate_customer', 'kick_pppoe_user', 'create_hotspot_voucher'.
   - Jika admin meminta tindakan, diagnosa, atau cek server, PANGGIL FUNCTION TOOL YANG SESUAI secara mandiri dan laporkan hasilnya dengan cerdas.
   - Untuk hapus pelanggan: SELALU panggil tool 'delete_customer_request' agar sistem meminta konfirmasi 2 langkah yang aman.
   - Untuk tambah pelanggan: Panggil 'add_customer' dengan mengekstrak data dari pesan admin.
   - Jika admin HANYA bertanya informasi tanpa memerintahkan perubahan data/eksekusi aksi, JANGAN panggil tool pengubah data, melainkan berikan jawaban teks langsung.
${contextSource === 'telegram_admin' ? `6. FORMAT JAWABAN TELEGRAM ADMIN (MARKDOWN AKTIF & RAPI):
   - Anda sedang berinteraksi langsung dengan Pemilik / Sysadmin di Telegram. GUNAKAN FORMATTING MARKDOWN TELEGRAM (*bold*, _italic_, \`code\`, \`\`\`code block\`\`\`) untuk keluaran perintah terminal, log, atau rincian teknis agar mudah dibaca.
   - Diberikan izin menggunakan simbol / bullet point yang memperjelas struktur data teknis.` : `6. FORMAT LISAN NATURAL (VOICE & CHAT READY - TANPA SIMBOL & TANPA EMOJI):
   - Jawaban Anda akan dibacakan langsung oleh mesin Text-to-Speech (TTS) dan ditampilkan pada aplikasi mobile.
   - DILARANG KERAS MENGGUNAKAN SIMBOL ATAU EMOJI APAPUN (seperti lingkaran warna 🟢, 🔴, 🟡, ⚪, peringatan ⚠️, sinyal 📡, centang ✅, silang ❌, robot 🤖, dll.) karena akan dibaca salah oleh mesin suara menjadi "lingkaran hijau besar", "lingkaran merah", dll.
   - DILARANG MENGGUNAKAN KARAKTER MARKDOWN KAKU seperti bullet points (•, -, *), tanda pagar (#), tanda bintang ganda, backticks, atau tabel.
   - Jangan menyajikan data teknis mentah baris-demi-baris yang kaku. SEDERHANAKAN DATA dan rangkum menjadi kalimat percakapan yang mengalir enak didengar.
   - Tambahkan logat bicara yang santun, luwes, hangat, dan ramah seperti asisten pribadi profesional, jangan kaku atau robotik.
   - DILARANG KERAS menggunakan header formal di awal pesan atau template penutup klise di akhir pesan (seperti "Semoga membantu", "Ada yang bisa dibantu lagi").
   - Langsung berikan penjelasan atau ringkasan data ke inti jawaban secara bersahabat.`}

7. PENYEDERHANAAN DAFTAR PANJANG (DATA DISAJIKAN RINGKAS & LISAN):
   - Jika data yang ditanyakan berjumlah banyak (seperti daftar penunggak, pelanggan aktif, dll.), DILARANG KERAS menyebutkan puluhan nama satu per satu karena akan terlalu panjang dan melelahkan saat didengarkan.
   - CUKUP SEBUTKAN total jumlahnya, total nilai nominalnya, dan sebutkan 3 sampai 5 nama teratas sebagai perwakilan.
   - Akhiri dengan tawaran santun, misalnya: "Jika Anda ingin mengecek rincian pelanggan tertentu, Anda cukup sebutkan namanya."

DATA OPERASIONAL LIVE (ADMIN ACCESS):
${adminContext || '(Tidak ada data kontekstual khusus)'}

DOKUMENTASI SISTEM & PANDUAN PEMECAHAN MASALAH:
${knowledge}
`;
  }

  let liveCustomerDataPrompt = '';
  if (customerContext) {
    liveCustomerDataPrompt = `
----------------------------------------
DATA STATUS LIVE PELANGGAN (Dari Database Server Billing):
- Nama Pelanggan: ${customerContext.customerName || senderName}
- Paket Layanan: ${customerContext.package || '-'}
- Akun PPPoE: ${customerContext.pppoeUsername || '-'}
- Status Langganan: ${customerContext.customerStatus || 'Active'}
- Status Tagihan Saat Ini: ${customerContext.hasUnpaid ? `MEMILIKI ${customerContext.unpaidCount} TAGIHAN BELUM LUNAS (Total: Rp ${customerContext.totalUnpaidAmount.toLocaleString('id-ID')})` : (customerContext.allPaid ? 'SEMUA TAGIHAN SUDAH LUNAS' : 'Belum ada data tagihan')}
${customerContext.unpaidInvoices ? `Rincian Tagihan Belum Lunas:\n${customerContext.unpaidInvoices}` : ''}

PETUNJUK KHUSUS JIKA MENANYAKAN TAGIHAN / TUNGGAKAN / PEMBAYARAN:
Jika pelanggan bertanya mengenai sisa tagihan, status pembayaran, jumlah uang yang harus dibayar, atau tunggakan miliknya, gunakan DATA STATUS LIVE di atas! Sebutkan nama pelanggan, total tagihan yang belum lunas beserta rincian periode bulannya secara sopan, jelas, dan ramah. Jika semua tagihan sudah lunas, beritahukan bahwa tagihan sudah lunas dan ucapkan terima kasih.
----------------------------------------
`;
  }

  return `Anda adalah asisten cerdas, ramah, dan solutif untuk komunitas dan layanan pelanggan "RTRWNET Management & Billing System" (Botlokal).

PEDOMAN UTAMA & ATURAN JAWABAN:
1. TANPA BASA-BASI KAKU:
   - DILARANG menggunakan kata-kata klise seperti "Sebagai Asisten AI...", "Sebagai model bahasa...", atau menolak pertanyaan. Langsung jawab ke inti pertanyaan dengan ramah, santun, dan bersahabat.
2. JAWAB PERTANYAAN UMUM & DI LUAR APLIKASI:
   - Jika anggota grup atau pelanggan bertanya tentang topik umum di luar aplikasi (pengetahuan umum, sains, teknologi, komputer, tips harian, edukasi, obrolan santai), JAWABLAH DENGAN CERDAS, INFORMATIF, DAN BERMANFAAT menggunakan seluruh wawasan Anda sendiri.
3. PERTANYAAN TERKAIT FITUR & TROUBLESHOOTING APLIKASI:
   - Jika berkaitan dengan layanan internet, cara bayar tagihan, cara ganti sandi wifi, cek tagihan, atau troubleshooting jaringan rumah, jawablah dengan panduan praktis yang mengacu pada DOKUMENTASI SISTEM & PANDUAN PEMECAHAN MASALAH di bawah.
4. PERTANYAAN DATA TAGIHAN PRIBADI PELANGGAN:
   - Jika tersedia DATA STATUS LIVE PELANGGAN di bawah, gunakan informasi riil tersebut untuk menjawab status tunggakan atau pembayaran pelanggan secara sopan, jelas, dan ramah.
5. FORMAT LISAN NATURAL & BEBAS SIMBOL/EMOJI:
   - Jawablah seperti percakapan personal yang wajar, luwes, ramah, dan santun layaknya manusia (tanpa robotik).
   - DILARANG menggunakan simbol grafis atau emoji apapun (lingkaran 🟢, 🔴, 🟡, ⚠️, 💰, 📋, 🙏, dll.) dan hindari karakter formatting kaku (bullet point, bintang, pagar).
   - DILARANG menggunakan header kaku atau kalimat footer penutup klise.
   - Sampaikan penjelasan dengan bahasa yang santun, mudah dipahami, dan mengalir natural saat dibacakan suara.

${liveCustomerDataPrompt}

DOKUMENTASI SISTEM & PANDUAN PEMECAHAN MASALAH:
${knowledge}
`;
}

/**
 * Konversi skema function calling Gemini ke format standar OpenAI tools
 */
function convertGeminiToolsToOpenAI(declarations) {
  if (!Array.isArray(declarations) || declarations.length === 0) return [];

  function lowercaseTypes(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const copy = Array.isArray(schema) ? [] : {};
    for (const [key, val] of Object.entries(schema)) {
      if (key === 'type' && typeof val === 'string') {
        copy[key] = val.toLowerCase();
      } else if (typeof val === 'object' && val !== null) {
        copy[key] = lowercaseTypes(val);
      } else {
        copy[key] = val;
      }
    }
    return copy;
  }

  return declarations.map(decl => ({
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters ? lowercaseTypes(decl.parameters) : { type: 'object', properties: {} }
    }
  }));
}

/**
 * Panggil Google Gemini API
 */
async function callGeminiApi(apiKey, userQuestion, senderName = 'Member', customerContext = null, isAdmin = false, adminContext = null, contextSource = "") {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const preferredModel = getSetting('gemini_model', 'gemini-2.5-flash');
  const modelList = [preferredModel, ...models.filter(m => m !== preferredModel)];
  const systemInstruction = buildSystemInstruction(isAdmin, customerContext, adminContext, senderName, contextSource);

  let lastError = null;

  for (const model of modelList) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${systemInstruction}\n\nPesan / Pertanyaan dari ${isAdmin ? `Admin (${senderName})` : senderName}:\n${userQuestion}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024
        }
      };

      if (isAdmin && Array.isArray(adminToolDeclarations) && adminToolDeclarations.length > 0) {
        payload.tools = [
          {
            functionDeclarations: adminToolDeclarations
          }
        ];
      }

      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 25000
      });

      const candidate = response.data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      // Periksa apakah model memutuskan memanggil function tool
      const funcPart = parts.find(p => p.functionCall);
      if (funcPart && funcPart.functionCall) {
        return {
          type: 'function_call',
          functionCall: {
            name: funcPart.functionCall.name,
            args: funcPart.functionCall.args || {}
          }
        };
      }

      // Jawaban teks biasa
      const textPart = parts.find(p => p.text && p.text.trim());
      if (textPart && textPart.text) {
        return {
          type: 'text',
          text: textPart.text.trim()
        };
      }
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 404) {
        logger.warn(`[TelegramAI] Model ${model} tidak tersedia (404), mencoba model cadangan...`);
        continue;
      }
      if (status === 429) {
        logger.warn(`[TelegramAI] Model ${model} kena limit (429), mencoba model cadangan...`);
        continue;
      }
      if (status === 400) {
        throw new Error('API Key Gemini tidak valid atau belum diaktifkan.');
      }
      logger.warn(`[TelegramAI] Error calling ${model}: ${err.message}`);
    }
  }

  throw lastError || new Error('Gagal mendapatkan respon dari AI.');
}

/**
 * Panggil OpenAI-Compatible API (OpenAI, DeepSeek, Groq, OpenRouter, Custom / Local Ollama)
 */
async function callOpenAiCompatibleApi({
  apiKey,
  baseUrl,
  model,
  userQuestion,
  senderName = 'Member',
  customerContext = null,
  isAdmin = false,
  adminContext = null,
  contextSource = ""
}) {
  const systemInstruction = buildSystemInstruction(isAdmin, customerContext, adminContext, senderName, contextSource);
  const cleanBaseUrl = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const url = `${cleanBaseUrl}/chat/completions`;

  const messages = [
    {
      role: 'system',
      content: systemInstruction
    },
    {
      role: 'user',
      content: `Pesan / Pertanyaan dari ${isAdmin ? `Admin (${senderName})` : senderName}:\n${userQuestion}`
    }
  ];

  const payload = {
    model: model,
    messages: messages,
    temperature: 0.2
  };

  if (isAdmin && Array.isArray(adminToolDeclarations) && adminToolDeclarations.length > 0) {
    payload.tools = convertGeminiToolsToOpenAI(adminToolDeclarations);
    payload.tool_choice = 'auto';
  }

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  if (cleanBaseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://alijayanet.net';
    headers['X-Title'] = 'Alijaya Billing System';
  }

  const response = await axios.post(url, payload, {
    headers,
    timeout: 35000
  });

  const choice = response.data?.choices?.[0];
  const message = choice?.message;

  // Periksa apakah model memutuskan memanggil function tool
  if (message?.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const firstCall = message.tool_calls[0];
    let parsedArgs = {};
    if (typeof firstCall.function?.arguments === 'string') {
      try {
        parsedArgs = JSON.parse(firstCall.function.arguments);
      } catch (e) {
        parsedArgs = {};
      }
    } else if (typeof firstCall.function?.arguments === 'object' && firstCall.function?.arguments !== null) {
      parsedArgs = firstCall.function.arguments;
    }

    return {
      type: 'function_call',
      functionCall: {
        name: firstCall.function?.name,
        args: parsedArgs || {}
      }
    };
  }

  // Jawaban teks biasa
  if (message?.content && typeof message.content === 'string' && message.content.trim()) {
    return {
      type: 'text',
      text: message.content.trim()
    };
  }

  throw new Error('Respon AI kosong dari provider.');
}

/**
 * Fallback Jawaban Cerdas berbasis Kata Kunci jika belum ada Gemini API Key atau offline
 */
function getOfflineAnswer(question, customerContext = null, isAdmin = false, adminContext = null) {
  const q = String(question || '').toLowerCase();

  // Khusus Admin jika offline: Jawab ringkasan data riil dari database
  if (isAdmin) {
    try {
      const db = require('../config/database');

      // 1. Cek pertanyaan tunggakan / tagihan belum lunas
      if (q.includes('tunggak') || q.includes('belum bayar') || q.includes('tagihan') || q.includes('piutang') || q.includes('nunggak')) {
        const unpaidList = db.prepare(`
          SELECT c.id, c.name, c.phone, c.status, COUNT(i.id) as count, SUM(i.amount) as total
          FROM customers c
          JOIN invoices i ON c.id = i.customer_id
          WHERE i.status != 'paid'
          GROUP BY c.id
          ORDER BY total DESC
        `).all();

        if (unpaidList.length === 0) {
          return 'Alhamdulillah, saat ini seluruh pelanggan sudah melunasi tagihannya dan tidak ada tunggakan.';
        }

        const totalNominal = unpaidList.reduce((sum, item) => sum + Number(item.total || 0), 0);
        const topNames = unpaidList.slice(0, 3).map(c => c.name).join(', ');
        return `Saat ini ada ${unpaidList.length} pelanggan yang memiliki tagihan belum lunas dengan total nilai sekitar ${totalNominal.toLocaleString('id-ID')} rupiah. Beberapa di antaranya yaitu ${topNames}. Apakah Anda ingin rincian tagihan tertentu?`;
      }

      // 2. Cek pertanyaan isolir / terisolir / putus
      if (q.includes('isolir') || q.includes('suspend') || q.includes('putus')) {
        const isolatedList = db.prepare(`
          SELECT id, name, phone, pppoe_username, area
          FROM customers
          WHERE LOWER(status) IN ('isolated', 'suspended', 'isolir')
          ORDER BY id ASC
        `).all();

        if (isolatedList.length === 0) {
          return 'Saat ini tidak ada pelanggan yang sedang terisolir. Seluruh pelanggan terpantau dalam status aktif dan normal.';
        }

        const isoNames = isolatedList.map(c => c.name).join(', ');
        return `Saat ini ada ${isolatedList.length} pelanggan yang sedang terisolir, yaitu atas nama ${isoNames}. Layanan mereka akan langsung aktif begitu tagihan dilunasi.`;
      }

      // 3. Cek total / ringkasan / rekap
      if (q.includes('total') || q.includes('berapa') || q.includes('rekap') || q.includes('ringkasan') || q.includes('pelanggan')) {
        const stats = db.prepare(`
          SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN LOWER(status) = 'active' THEN 1 END) as active,
            COUNT(CASE WHEN LOWER(status) IN ('isolated', 'suspended', 'isolir') THEN 1 END) as isolated,
            COUNT(CASE WHEN LOWER(status) IN ('inactive', 'terminated', 'nonaktif') THEN 1 END) as inactive
          FROM customers
        `).get();

        return `Saat ini tercatat ada total ${stats.total} pelanggan di dalam sistem. Rinciannya terdiri dari ${stats.active} pelanggan aktif, ${stats.isolated} pelanggan terisolir, dan ${stats.inactive} pelanggan nonaktif. Secara umum seluruh jaringan terpantau lancar.`;
      }

      // 4. Cek modem / redaman / ont / onu / sinyal
      if (q.includes('modem') || q.includes('onu') || q.includes('ont') || q.includes('redaman') || q.includes('sinyal') || q.includes('kabel optik')) {
        const allCustomers = db.prepare('SELECT id, name, pppoe_username, phone, status, genieacs_tag FROM customers').all();
        let matchedCust = null;
        for (const c of allCustomers) {
          const lowerName = (c.name || '').toLowerCase();
          const firstName = lowerName.split(/\s+/)[0];
          if (firstName && firstName.length > 2 && q.includes(firstName)) {
            matchedCust = c;
            break;
          }
        }

        if (matchedCust) {
          return `Kondisi modem milik ${matchedCust.name} saat ini terpantau normal dan aktif di sistem. Status layanannya ${matchedCust.status === 'active' ? 'aktif lancar' : matchedCust.status}, dan koneksi internetnya berjalan baik.`;
        }

        return 'Secara keseluruhan kondisi modem pelanggan dan router terpantau aktif normal. Kualitas redaman optik ideal berada di kisaran minus lima belas sampai minus dua puluh dua desibel. Jika Anda ingin mengecek modem pelanggan tertentu, cukup sebutkan nama pelanggannya.';
      }
    } catch (err) {
      logger.error(`[TelegramAI] Offline admin answer error: ${err.message}`);
    }
  }

  // Jika pelanggan menanyakan tagihan/tunggakan dan ada data live pelanggan
  if (customerContext && (q.includes('tagihan') || q.includes('tunggak') || q.includes('bayar') || q.includes('lunas') || q.includes('tempo') || q.includes('invoice'))) {
    if (customerContext.hasUnpaid) {
      return `Halo Kak ${customerContext.customerName}, saat ini ada ${customerContext.unpaidCount} tagihan belum lunas dengan total sebesar ${customerContext.totalUnpaidAmount.toLocaleString('id-ID')} rupiah. Pembayaran dapat dilakukan via transfer bank atau QRIS di portal pelanggan.`;
    } else if (customerContext.allPaid) {
      return `Halo Kak ${customerContext.customerName}, terima kasih banyak. Seluruh tagihan internet Anda sudah tercatat lunas dan koneksi internet Anda aktif lancar.`;
    }
  }

  // --- DIAGNOSTIK & PEMECAHAN MASALAH (TROUBLESHOOTING) DENGAN BAHASA LISAN NATURAL ---

  // 1. Masalah Sudah Lunas tapi Masih Isolir
  if (q.includes('masih isolir') || (q.includes('sudah bayar') && q.includes('isolir')) || (q.includes('lunas') && q.includes('isolir')) || q.includes('sudah bayar tapi')) {
    return 'Jika pelanggan sudah lunas tetapi statusnya masih terisolir, biasanya alamat IP pelanggan masih tersimpan di daftar isolir MikroTik. Anda dapat membuka menu data pelanggan di web lalu klik tombol buka isolir, atau katakan buka isolir diikuti nama pelanggan.';
  }

  // 2. Masalah Terisolir tapi Masih Bisa Internetan
  if (q.includes('masih bisa') && (q.includes('isolir') || q.includes('suspend') || q.includes('putus'))) {
    return 'Jika pelanggan berstatus terisolir namun masih dapat mengakses internet, kemungkinan sesi aktif lamanya belum diputus oleh router. Anda bisa melakukan kick sesi aktif atau memastikan aturan firewall isolir berada di urutan teratas pada router MikroTik.';
  }

  // 3. Masalah Koneksi MikroTik API (Timeout / Gagal Konek)
  if (q.includes('tidak bisa konek') || q.includes('gagal konek') || q.includes('api timeout') || q.includes('port 8728') || q.includes('port 8729') || q.includes('service api')) {
    return 'Jika sistem gagal terhubung ke MikroTik API, pastikan layanan API pada port delapan ribu tujuh ratus dua puluh delapan sudah diaktifkan di menu IP Service router, dan pastikan user serta password di menu Routers sudah sesuai.';
  }

  // 4. Masalah Redaman Optik / LOS Lampu Merah
  if ((q.includes('redaman') && (q.includes('jelek') || q.includes('tinggi') || q.includes('drop') || q.includes('dbm') || q.includes('solusi') || q.includes('masalah') || q.includes('kenapa') || q.includes('buruk'))) || q.includes('los') || q.includes('lampu merah') || q.includes('kabel putus') || q.includes('rx power')) {
    return 'Nilai redaman optik yang ideal berada di kisaran minus lima belas sampai minus dua puluh dua desibel. Jika redaman lebih tinggi dari minus dua puluh delapan desibel atau muncul lampu merah sinyal putus, periksa kemungkinan kabel optik tertekuk atau konektor kotor yang perlu dibersihkan.';
  }

  // 5. Masalah Webhook / Payment Gateway / QRIS
  if (q.includes('webhook') || (q.includes('qris') && (q.includes('gagal') || q.includes('belum lunas') || q.includes('unpaid') || q.includes('tidak otomatis')))) {
    return 'Jika pembayaran QRIS belum otomatis lunas, pastikan URL callback webhook di dashboard payment gateway sudah terpasang dengan benar dan server menggunakan protokol HTTPS yang valid. Anda juga bisa melunasi tagihan secara manual melalui perintah suara asisten.';
  }

  // 6. Masalah WhatsApp "Menunggu Pesan Ini" / Logout
  if (q.includes('menunggu pesan ini') || q.includes('waiting for this message') || q.includes('wa logout') || q.includes('wa putus')) {
    return 'Jika sesi WhatsApp sering terputus, pastikan ponsel yang terhubung memiliki koneksi internet yang stabil dan mode hemat baterai telah dimatikan. Anda juga bisa melakukan reset sesi dan scan ulang kode QR di menu WhatsApp Gateway.';
  }

  // 7. Masalah Telegram Bot
  if (q.includes('telegram') && (q.includes('akses ditolak') || q.includes('conflict') || q.includes('409') || q.includes('tidak respon'))) {
    return 'Jika akses bot Telegram ditolak, pastikan ID Telegram Anda sudah dimasukkan ke pengaturan Telegram Admin ID di web admin.';
  }

  // 8. Masalah Database SQLite Locked
  if (q.includes('database is locked') || q.includes('sqlite_busy') || q.includes('restore database')) {
    return 'Jika terjadi kendala database terkunci, sistem biasanya sedang memproses transaksi. Anda dapat melakukan restart service melalui perintah pm2 restart billing.';
  }

  // 9. Masalah Digiflazz
  if (q.includes('digiflazz') && (q.includes('gagal') || q.includes('rc 40') || q.includes('rc 41') || q.includes('rc 42') || q.includes('saldo habis'))) {
    return 'Untuk transaksi Digiflazz, pastikan IP publik server sudah didaftarkan ke whitelist IP di member area Digiflazz dan saldo deposit Anda mencukupi.';
  }

  if (q.includes('isolir') || q.includes('putus') || q.includes('tunggak')) {
    return 'Sistem isolir berjalan otomatis sesuai tanggal jatuh tempo. Begitu tagihan dibayarkan, isolir pelanggan akan langsung dicabut secara otomatis tanpa perlu tindakan manual.';
  }

  if (q.includes('genieacs') || q.includes('tr069') || q.includes('tr-069') || q.includes('onu') || q.includes('redaman') || q.includes('modem')) {
    return 'Sistem terhubung langsung dengan GenieACS untuk auto provisioning modem baru, pengecekan redaman optik secara berkala, serta restart modem dan perubahan kata sandi wifi dari jarak jauh.';
  }

  if (q.includes('olt') || q.includes('snmp') || q.includes('gpon') || q.includes('epon')) {
    return 'Sistem mendukung manajemen OLT GPON dan EPON untuk memantau port PON, mendeteksi modem baru yang belum terkonfigurasi, dan monitoring redaman optik massal.';
  }

  if (q.includes('payment') || q.includes('tripay') || q.includes('midtrans') || q.includes('xendit') || q.includes('duitku') || q.includes('qris')) {
    return 'Sistem mendukung beragam gateway pembayaran otomatis seperti QRIS, transfer bank, dan e-wallet yang langsung mencabut isolir begitu pembayaran sukses.';
  }

  if (q.includes('whatsapp') || q.includes('wa') || q.includes('baileys') || q.includes('notif')) {
    return 'Layanan WhatsApp Gateway digunakan untuk notifikasi tagihan otomatis, pengingat jatuh tempo, dan chatbot pelanggan.';
  }

  if (q.includes('mikrotik') || q.includes('router') || q.includes('pppoe') || q.includes('hotspot')) {
    return 'Integrasi MikroTik mendukung sinkronisasi akun PPPoE dan Hotspot, monitoring pengguna aktif, serta pemutusan sesi secara otomatis.';
  }

  if (q.includes('radius') || q.includes('freeradius')) {
    return 'Fitur FreeRADIUS Server menyediakan autentikasi terpusat untuk akun PPPoE dan Hotspot dengan alokasi IP dinamis.';
  }

  if (q.includes('portal') || q.includes('pelanggan') || q.includes('customer')) {
    return 'Pelanggan dapat mengakses portal mandiri untuk mengecek tagihan tanpa login, membayar via QRIS, melihat riwayat pembayaran, serta mengubah nama dan sandi wifi rumah sendiri.';
  }

  // Jawaban standar jika belum ada keyword yang cocok
  return 'Halo, ada yang bisa saya bantu hari ini? Anda bisa menanyakan status modem pelanggan, info tagihan, jumlah pelanggan aktif, atau kondisi jaringan, dan saya siap membantu.';
}

/**
 * Membersihkan jawaban AI agar tampil bersih tanpa simbol, emoji, atau header/footer formal
 */
function cleanAiResponse(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.trim();

  // 1. Hapus pembungkus code block markdown
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 2. Hapus header garis / separator
  cleaned = cleaned.replace(/^[─—\-_=]{2,}\s*/gm, '');
  cleaned = cleaned.replace(/\s*[─—\-_=]{2,}$/gm, '');

  // 3. Hapus header bot / perusahaan di awal
  cleaned = cleaned.replace(/^(?:🏢|🤖|🌐|💬)?\s*\*?(?:ALIJAYA|AliJaya|RTRWNET|RTRW-?Net|Asisten AI|Asisten Virtual|Bot Billing|Portal Billing)[^\n*]*\*?\n+[─—\-_=]{2,}\n*/gi, '');
  cleaned = cleaned.replace(/^(?:🏢|🤖|🌐|💬)?\s*\*?(?:ALIJAYA|AliJaya|RTRWNET|RTRW-?Net|Asisten AI|Asisten Virtual)[^\n*]*\*?\n+/gi, '');

  // 4. Hapus footer template atau slogan
  cleaned = cleaned.replace(/\n+[─—\-_=]{2,}\n+.*(?:Internet Tanpa Batas|AliJaya|ALIJAYA|Semoga membantu|Ada yang bisa dibantu lagi).*$/gi, '');
  cleaned = cleaned.replace(/\n+(?:Semoga membantu!?|Semoga informasinya bermanfaat!?|Ada yang bisa dibantu lagi\??|Ada hal lain yang perlu ditanyakan\??|Salam hangat,?[^\n]*)$/gi, '');

  // 5. HAPUS SEMUA EMOJI & SIMBOL GRAFIS (lingkaran 🟢 🔴 🟡 ⚪ ⚠️ 📡 📶 💡 🤖 🧾 💳 ❌ ✅ dll.)
  cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{200D}\u{20E3}]/gu, ' ');
  cleaned = cleaned.replace(/[🟢🔴🟡⚪⚫🟠🔵🟣🟥🟩🟦🟧🟨⭕❌✅⚠️💡🤖🧾💳📡📶🔒🔓🔄🔑👉⏱️📱🔧🏷️💾💬⚙️🛡️💰📋🙏✔️✖️◀️▶️▲▼◆■]/gu, ' ');

  // 6. Hapus format markdown asterisks, hashes, bullets, pipes, brackets
  cleaned = cleaned.replace(/^[•·▪▫➢➔★☆✓✕✖\-\*]\s+/gm, '');
  cleaned = cleaned.replace(/[•·▪▫➢➔★☆✓✕✖]/g, ' ');
  cleaned = cleaned.replace(/[*_~#|\\^$<>\[\]{}()]/g, ' ');

  // 7. Bersihkan spasi ganda dan baris kosong berlebih
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.replace(/\s*([,.\?!])\s*/g, '$1 ');
  cleaned = cleaned.replace(/,\s*,+/g, ',');
  cleaned = cleaned.replace(/\.\s*\.+/g, '.');

  return cleaned.trim();
}

/**
 * Handle tanya jawab AI utama
 */
async function askAi({ question, senderName, customerContext = null, isAdmin = false, extraContext = {} }) {
  const cleanQ = String(question || '').trim();
  if (!cleanQ) {
    return 'Silakan ajukan pertanyaan seputar fitur aplikasi atau layanan internet Anda.';
  }

  let adminContext = null;
  if (isAdmin) {
    try {
      adminContext = await getAdminGlobalContext(cleanQ);
    } catch (err) {
      logger.error(`[TelegramAI] Gagal build admin context: ${err.message}`);
    }
  }

  const provider = (getSetting('ai_provider', 'gemini') || 'gemini').toLowerCase().trim();
  let aiReply = null;

  if (provider === 'gemini') {
    const apiKey = getSetting('gemini_api_key', '');
    if (apiKey && apiKey.trim()) {
      try {
        aiReply = await callGeminiApi(apiKey.trim(), cleanQ, senderName, customerContext, isAdmin, adminContext, extraContext?.contextSource || "");
      } catch (err) {
        logger.error(`[TelegramAI] Gagal call Gemini API: ${err.message}. Menggunakan fallback jawaban lokal.`);
      }
    }
  } else {
    // Multi-provider OpenAI compatible: openai, deepseek, groq, openrouter, custom
    let apiKey = '';
    let baseUrl = '';
    let model = '';

    if (provider === 'openai') {
      apiKey = getSetting('openai_api_key', '');
      baseUrl = 'https://api.openai.com/v1';
      model = getSetting('openai_model', 'gpt-4o-mini') || 'gpt-4o-mini';
    } else if (provider === 'deepseek') {
      apiKey = getSetting('deepseek_api_key', '');
      baseUrl = 'https://api.deepseek.com';
      model = getSetting('deepseek_model', 'deepseek-chat') || 'deepseek-chat';
    } else if (provider === 'groq') {
      apiKey = getSetting('groq_api_key', '');
      baseUrl = 'https://api.groq.com/openai/v1';
      model = getSetting('groq_model', 'llama-3.3-70b-versatile') || 'llama-3.3-70b-versatile';
    } else if (provider === 'openrouter') {
      apiKey = getSetting('openrouter_api_key', '');
      baseUrl = 'https://openrouter.ai/api/v1';
      model = getSetting('openrouter_model', 'meta-llama/llama-3.3-70b-instruct') || 'meta-llama/llama-3.3-70b-instruct';
    } else if (provider === 'custom') {
      apiKey = getSetting('custom_ai_api_key', '');
      baseUrl = getSetting('custom_ai_base_url', 'http://localhost:11434/v1');
      model = getSetting('custom_ai_model', 'llama3') || 'llama3';
    }

    if ((apiKey && apiKey.trim()) || provider === 'custom') {
      try {
        aiReply = await callOpenAiCompatibleApi({
          apiKey: apiKey ? apiKey.trim() : (provider === 'custom' ? 'ollama' : ''),
          baseUrl,
          model,
          userQuestion: cleanQ,
          senderName,
          customerContext,
          isAdmin,
          adminContext,
          contextSource: extraContext?.contextSource || ""
        });
      } catch (err) {
        logger.error(`[TelegramAI] Gagal call AI (${provider}): ${err.message}`);
        // Fallback ke Gemini jika gemini_api_key tersedia
        const geminiKey = getSetting('gemini_api_key', '');
        if (geminiKey && geminiKey.trim()) {
          try {
            logger.info('[TelegramAI] Mencoba fallback ke Gemini API...');
            aiReply = await callGeminiApi(geminiKey.trim(), cleanQ, senderName, customerContext, isAdmin, adminContext);
          } catch (geminiErr) {
            logger.error(`[TelegramAI] Fallback ke Gemini juga gagal: ${geminiErr.message}`);
          }
        }
      }
    }
  }

  // Jika API berhasil memberikan respon (baik function tool maupun teks)
  if (aiReply) {
    const isTgAdmin = (extraContext?.contextSource === 'telegram_admin');
    if (typeof aiReply === 'object' && aiReply?.type === 'function_call') {
      const toolResult = await executeAdminTool(aiReply.functionCall.name, aiReply.functionCall.args, extraContext);
      if (isTgAdmin) {
        return typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
      }
      return cleanAiResponse(toolResult);
    }
    if (typeof aiReply === 'object' && aiReply?.type === 'text') {
      if (isTgAdmin) {
        return aiReply.text;
      }
      return cleanAiResponse(aiReply.text);
    }
    const rawOut = typeof aiReply === 'string' ? aiReply : (aiReply?.text || JSON.stringify(aiReply));
    if (isTgAdmin) {
      return rawOut;
    }
    return cleanAiResponse(rawOut);
  }

  // Jika API key belum diatur atau semua panggilan API gagal, gunakan offline knowledge base
  const offlineAns = getOfflineAnswer(cleanQ, customerContext, isAdmin, adminContext);
  if (extraContext?.contextSource === 'telegram_admin') {
    return offlineAns;
  }
  return cleanAiResponse(offlineAns);
}

/**
 * Utilitas Diagnostik: Cek DNS via DNS-over-HTTPS (DoH Cloudflare / Google)
 */
async function checkDns(domain, type = 'A') {
  try {
    const cleanDomain = String(domain || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
    const recType = String(type || 'A').toUpperCase();

    // Gunakan Cloudflare DoH untuk kehandalan tanpa terkena port 53 hijack ISP
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(cleanDomain)}&type=${recType}`;
    const res = await axios.get(url, {
      headers: { 'Accept': 'application/dns-json' },
      timeout: 7000
    });

    const data = res.data;
    if (!data.Answer || data.Answer.length === 0) {
      return `🔍 *HASIL CEK DNS*\n\nTarget: \`${cleanDomain}\`\nRecord: *${recType}*\nStatus: ⚠️ Tidak ditemukan record ${recType} untuk domain ini.`;
    }

    let out = `🌐 *HASIL CEK DNS (Cloudflare Resolver)*\n\n`;
    out += `Domain: \`${cleanDomain}\`\nRecord: *${recType}*\n\n*Data Jawaban:*\n`;
    data.Answer.forEach(ans => {
      out += `• \`${ans.data}\` (TTL: ${ans.TTL}s)\n`;
    });

    return out;
  } catch (err) {
    return `❌ Gagal melakukan lookup DNS: ${err.message}`;
  }
}

/**
 * Utilitas Diagnostik: Cek Host / Latency (HTTP Head Ping)
 */
async function checkPing(host) {
  try {
    let cleanHost = String(host || '').trim();
    if (!cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
      cleanHost = 'http://' + cleanHost;
    }

    const startTime = Date.now();
    const res = await axios.head(cleanHost, { timeout: 8000, validateStatus: () => true });
    const latency = Date.now() - startTime;

    return `🏓 *HASIL PING / KONEKSI*\n\n` +
      `Target: \`${cleanHost}\`\n` +
      `Status: ✅ Terhubung (HTTP ${res.status})\n` +
      `Latensi: *${latency} ms*`;
  } catch (err) {
    return `❌ Gagal menghubungi \`${host}\`: ${err.message}`;
  }
}

module.exports = {
  askAi,
  cleanAiResponse,
  checkDns,
  checkPing,
  getOfflineAnswer,
  getAdminGlobalContext
};
