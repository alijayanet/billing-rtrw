const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');
const metaWAService = require('./metaWhatsappService');
const fonnteWAService = require('./fonnteWhatsappService');

/**
 * Unified WhatsApp Gateway Service
 * Menangani routing pengiriman pesan baik via Baileys (Unofficial Socket), Fonnte API, maupun Meta Cloud API (Official Meta).
 */

/**
 * Kirim pesan WhatsApp universal
 * @param {string} toPhone Nomor HP tujuan
 * @param {string} messageText Teks pesan
 * @param {object} options Opsi tambahan: { templateName, parameters, langCode, url, filename }
 */
async function sendWhatsAppMessage(toPhone, messageText, options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys'); // 'baileys', 'fonnte', or 'meta'

  if (gatewayType === 'fonnte') {
    // Mode FONNTE API GATEWAY (Cloud / Self-Hosted)
    const res = await fonnteWAService.sendFonnteMessage(toPhone, messageText, options);
    return res && res.success;
  } else if (gatewayType === 'meta') {
    // Mode META API RESMI
    if (options.templateName) {
      // Kirim via Meta Template Message
      return await metaWAService.sendMetaTemplateMessage(
        toPhone,
        options.templateName,
        options.langCode || 'id',
        options.parameters || []
      );
    } else {
      // Kirim via Meta Direct Text Message
      return await metaWAService.sendMetaTextMessage(toPhone, messageText);
    }
  } else {
    // Mode BAILEYS WEB (Default Socket)
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');

    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp (Baileys) belum terhubung / offline. Silakan scan QR Code di menu /admin/whatsapp.');
    }

    const ok = await sendWA(toPhone, messageText, options);

    if (!ok) {
      throw new Error('Gagal mengirim pesan via Baileys. Pastikan nomor HP tujuan terdaftar di WhatsApp.');
    }

    // Logging ke wa_chat_messages untuk Inbox / Live Chat
    try {
      const phone = metaWAService.normalizePhone(toPhone);
      let custName = 'Pelanggan';
      let custId = null;
      const cust = db.prepare('SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ?').get(`%${phone.slice(-8)}%`, `%${phone}%`);
      if (cust) {
        custName = cust.name;
        custId = cust.id;
      }

      db.prepare(`
        INSERT INTO wa_chat_messages 
        (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status)
        VALUES ('outbound', 'baileys', 'baileys_bot', ?, ?, ?, ?, 'sent')
      `).run(phone, custId, custName, messageText);
    } catch (e) {}

    return ok;
  }
}

/**
 * Ambil riwayat chat / percakapan dengan nomor tertentu untuk Live Chat
 */
function getChatHistory(phone, limit = 50) {
  const normalized = metaWAService.normalizePhone(phone);
  if (!normalized) return [];

  const rows = db.prepare(`
    SELECT * FROM wa_chat_messages
    WHERE sender_phone LIKE ? OR recipient_phone LIKE ? OR sender_phone LIKE ? OR recipient_phone LIKE ?
    ORDER BY id ASC
    LIMIT ?
  `).all(`%${normalized.slice(-8)}%`, `%${normalized.slice(-8)}%`, `%${normalized}%`, `%${normalized}%`, Number(limit) || 50);

  return rows || [];
}

/**
 * Ambil daftar percakapan terbaru (Inbox Live Chat)
 */
function getRecentConversations(limit = 30) {
  const rows = db.prepare(`
    SELECT 
      m.id,
      m.direction,
      m.gateway,
      CASE WHEN m.direction = 'inbound' THEN m.sender_phone ELSE m.recipient_phone END as phone,
      m.customer_id,
      m.customer_name,
      m.message_text,
      m.status,
      m.created_at
    FROM wa_chat_messages m
    INNER JOIN (
      SELECT MAX(id) as max_id
      FROM wa_chat_messages
      GROUP BY CASE WHEN direction = 'inbound' THEN sender_phone ELSE recipient_phone END
    ) latest ON m.id = latest.max_id
    ORDER BY m.id DESC
    LIMIT ?
  `).all(Number(limit) || 30);

  return rows || [];
}

const DEFAULT_PAYMENT_SUCCESS_TEMPLATE = 
`🧾 *BUKTI PEMBAYARAN RESMI (LUNAS)*
🏢 *{{company}}*
────────────────────────────
Yth. Pelanggan *{{nama}}*,

Terima kasih, pembayaran tagihan internet Anda telah kami terima dan diverifikasi.

📋 *Rincian Pembayaran:*
• *No. Invoice:* #INV-{{no_invoice}}
• *ID Pelanggan:* {{username}}
• *Paket Layanan:* {{paket}}
• *Periode:* {{periode}}
• *Waktu Bayar:* {{waktu}}
• *Metode Bayar:* {{metode}}
• *Total Bayar:* *Rp {{total}}*
• *Status:* *LUNAS ✅*

🌐 *Status Layanan:*
Layanan internet Anda saat ini dalam status *AKTIF* dan dapat digunakan dengan nyaman.

────────────────────────────
🔗 *Cek Tagihan / Riwayat:*
{{link_portal}}

📞 *Bantuan & Layanan Pelanggan:*
WhatsApp: {{company_phone}}

_Simpan pesan ini sebagai bukti pembayaran yang sah dari {{company}}._`;

const INDONESIAN_MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

function getIndonesianMonthName(monthNumber) {
  const m = parseInt(monthNumber, 10);
  if (m >= 1 && m <= 12) {
    return INDONESIAN_MONTH_NAMES[m - 1];
  }
  return String(monthNumber || '').trim();
}

/**
 * Format periode bulan dan tahun ke dalam bahasa Indonesia, misal: "Oktober 2026"
 * @param {string|number} month - Bulan (angka 1-12 atau string nama bulan atau "10/2026")
 * @param {string|number} [year] - Tahun (misal 2026)
 * @returns {string} Contoh: "Oktober 2026"
 */
function formatIndonesianPeriod(month, year) {
  if (!month && !year) return '-';
  let m = String(month || '').trim();
  let y = String(year || '').trim();

  if (!y && m.includes('/')) {
    const parts = m.split('/');
    m = parts[0].trim();
    y = parts[1].trim();
  } else if (!y && m.includes('-')) {
    const parts = m.split('-');
    if (parts[0].length === 4) {
      y = parts[0].trim();
      m = parts[1].trim();
    } else {
      m = parts[0].trim();
      y = parts[1].trim();
    }
  }

  // Jika terdapat koma (banyak bulan)
  if (m.includes(',')) {
    const monthItems = m.split(',').map(x => x.trim()).filter(Boolean);
    const formattedMonths = monthItems.map(x => getIndonesianMonthName(x));
    if (formattedMonths.length === 2) {
      return `${formattedMonths[0]} & ${formattedMonths[1]}${y ? ' ' + y : ''}`;
    } else if (formattedMonths.length > 2) {
      const last = formattedMonths.pop();
      return `${formattedMonths.join(', ')} & ${last}${y ? ' ' + y : ''}`;
    }
    return `${formattedMonths.join(', ')}${y ? ' ' + y : ''}`;
  }

  const mName = getIndonesianMonthName(m);
  return y ? `${mName} ${y}` : mName;
}

/**
 * Format daftar tagihan belum lunas (unpaid invoices) menjadi ringkasan yang jelas:
 * - count: jumlah tagihan belum lunas
 * - totalAmount: akumulasi nominal rupiah
 * - totalAmountStr: format string rupiah (misal "220.000")
 * - periodText: nama bulan dalam huruf (misal "September & Oktober 2026 (2 Bulan)")
 * - breakdownText: rincian baris per bulan
 * - isMultiple: boolean apakah menunggak > 1 bulan
 */
function formatUnpaidInvoicesSummary(unpaidInvoices) {
  if (!unpaidInvoices || !Array.isArray(unpaidInvoices) || unpaidInvoices.length === 0) {
    return {
      count: 0,
      totalAmount: 0,
      totalAmountStr: '0',
      periodText: '-',
      breakdownText: '',
      isMultiple: false
    };
  }

  const formatter = new Intl.NumberFormat('id-ID');
  const count = unpaidInvoices.length;
  const totalAmount = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
  const totalAmountStr = formatter.format(totalAmount);

  // Urutkan invoice berdasarkan period_year asc, period_month asc, id asc
  const sorted = [...unpaidInvoices].sort((a, b) => {
    const yA = Number(a.period_year) || 0;
    const yB = Number(b.period_year) || 0;
    if (yA !== yB) return yA - yB;
    const mA = Number(a.period_month) || 0;
    const mB = Number(b.period_month) || 0;
    if (mA !== mB) return mA - mB;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const periodStrings = sorted.map(inv => formatIndonesianPeriod(inv.period_month, inv.period_year));

  let periodText = '';
  if (periodStrings.length === 1) {
    periodText = periodStrings[0];
  } else if (periodStrings.length === 2) {
    periodText = `${periodStrings[0]} & ${periodStrings[1]}`;
  } else {
    const last = periodStrings[periodStrings.length - 1];
    periodText = `${periodStrings.slice(0, -1).join(', ')} & ${last}`;
  }

  const breakdownLines = sorted.map(inv => {
    const pStr = formatIndonesianPeriod(inv.period_month, inv.period_year);
    const amtStr = formatter.format(Number(inv.amount) || 0);
    return `• *${pStr}:* Rp ${amtStr}${inv.id ? ` (Inv #${inv.id})` : ''}`;
  });

  return {
    count,
    totalAmount,
    totalAmountStr,
    periodText: count > 1 ? `${periodText} (${count} Bulan)` : periodText,
    breakdownText: breakdownLines.join('\n'),
    isMultiple: count > 1
  };
}

/**
 * Format Payment Success WhatsApp Message
 */
function formatPaymentSuccessMessage({
  customerName = '',
  invoiceId = '',
  customerUsername = '',
  packageName = '',
  periodMonth = '',
  periodYear = '',
  amount = 0,
  paymentMethod = '',
  paidAt = null,
  companyName = '',
  companyPhone = '',
  portalUrl = '',
  customTemplate = '',
  remainingUnpaidInvoices = null,
  customerId = null
}) {
  let template = String(customTemplate || DEFAULT_PAYMENT_SUCCESS_TEMPLATE).trim();
  if (!template) template = DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const periodText = formatIndonesianPeriod(periodMonth, periodYear);

  const tz = getSetting('timezone', 'Asia/Jakarta');
  let tzSuffix = 'WIB';
  if (/Makassar|Ujung_Pandang|Bali|Pontianak|Banjarmasin|Manado|Mataram|Kupang/i.test(tz)) {
    tzSuffix = 'WITA';
  } else if (/Jayapura|Ambon|Papua|Maluku/i.test(tz)) {
    tzSuffix = 'WIT';
  } else if (!/Jakarta|Bangkok|Asia\/Jakarta/i.test(tz)) {
    tzSuffix = tz;
  }

  let formattedTime = '';
  try {
    const { formatDateLocal } = require('../config/settingsManager');
    formattedTime = `${formatDateLocal(paidAt || new Date())} ${tzSuffix}`;
  } catch {
    const now = new Date();
    formattedTime = `${now.toLocaleDateString('id-ID')} ${now.toLocaleTimeString('id-ID')} ${tzSuffix}`;
  }

  const formattedAmount = Number(amount || 0).toLocaleString('id-ID');

  let remainingList = remainingUnpaidInvoices;
  if (remainingList === null && customerId) {
    try {
      const billingSvc = require('./billingService.js');
      const allUnpaid = billingSvc.getUnpaidInvoicesByCustomerId(customerId) || [];
      remainingList = allUnpaid.filter(inv => String(inv.id) !== String(invoiceId));
    } catch (e) {}
  }

  // Format informasi sisa tunggakan jika ada
  let tunggakanInfo = '';
  if (remainingList && Array.isArray(remainingList) && remainingList.length > 0) {
    const summary = formatUnpaidInvoicesSummary(remainingList);
    tunggakanInfo = `\n⚠️ *Perhatian Tunggakan Lain:*\nMasih ada *${summary.count} tagihan lain* belum lunas:\n${summary.breakdownText}\n💰 *Total Sisa Tunggakan:* *Rp ${summary.totalAmountStr}*\n_Mohon segera diselesaikan agar layanan tetap lancar._\n`;
  }

  let rendered = template
    .replace(/{{nama}}/gi, customerName || 'Pelanggan')
    .replace(/{{no_invoice}}/gi, String(invoiceId || '-'))
    .replace(/{{invoice_id}}/gi, String(invoiceId || '-'))
    .replace(/{{username}}/gi, customerUsername || '-')
    .replace(/{{id_pelanggan}}/gi, customerUsername || '-')
    .replace(/{{paket}}/gi, packageName || '-')
    .replace(/{{periode}}/gi, periodText)
    .replace(/{{total}}/gi, formattedAmount)
    .replace(/{{metode}}/gi, paymentMethod || 'Admin / Kasir')
    .replace(/{{waktu}}/gi, formattedTime)
    .replace(/{{tanggal}}/gi, formattedTime)
    .replace(/{{company}}/gi, companyName || 'ALIJAYA NET')
    .replace(/{{company_phone}}/gi, companyPhone || '-')
    .replace(/{{link_portal}}/gi, portalUrl || '-')
    .replace(/{{link}}/gi, portalUrl || '-')
    .replace(/{{tunggakan_info}}/gi, tunggakanInfo);

  // Jika template belum memiliki placeholder {{tunggakan_info}} tapi ada tunggakan lain, sisipkan sebelum link atau footer
  if (tunggakanInfo && !template.includes('{{tunggakan_info}}')) {
    if (rendered.includes('───')) {
      const idx = rendered.lastIndexOf('───');
      rendered = rendered.slice(0, idx) + `${tunggakanInfo}\n` + rendered.slice(idx);
    } else {
      rendered += `\n${tunggakanInfo}`;
    }
  }

  // Process spintax {A|B|C} only if pipe is present
  rendered = rendered.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)].trim();
  });

  return rendered;
}

module.exports = {
  sendWhatsAppMessage,
  sendWA: sendWhatsAppMessage, // Alias untuk kompatibilitas fungsi lama
  getChatHistory,
  getRecentConversations,
  INDONESIAN_MONTH_NAMES,
  getIndonesianMonthName,
  formatIndonesianPeriod,
  formatUnpaidInvoicesSummary,
  formatPaymentSuccessMessage,
  DEFAULT_PAYMENT_SUCCESS_TEMPLATE
};
