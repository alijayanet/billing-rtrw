const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');

/**
 * Service untuk Fonnte WhatsApp API Gateway (Cloud & Self-Hosted)
 */

/**
 * Format nomor telepon ke format standar (misal 08123456789 atau 628123456789)
 */
function normalizePhone(phone) {
  let cleaned = String(phone || '').replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Kirim Pesan Teks via Fonnte API
 * @param {string} toPhone Nomor tujuan
 * @param {string} messageText Teks pesan WhatsApp
 * @param {object} options Opsi tambahan (delay, schedule, typing, dll)
 */
async function sendFonnteMessage(toPhone, messageText, options = {}) {
  const phone = normalizePhone(toPhone);
  if (!phone) throw new Error('Nomor tujuan WhatsApp tidak valid.');

  const token = getSetting('fonnte_token', '');
  if (!token) {
    throw new Error('Token Fonnte belum dikonfigurasi. Harap isi API Token Fonnte di menu Pengaturan WhatsApp.');
  }

  const apiUrl = getSetting('fonnte_api_url', 'https://api.fonnte.com/send').trim() || 'https://api.fonnte.com/send';
  const countryCode = getSetting('fonnte_country_code', '62').trim() || '62';

  const payload = {
    target: phone,
    message: String(messageText || ''),
    countryCode: countryCode
  };

  if (options.url) {
    payload.url = options.url;
  }
  if (options.filename) {
    payload.filename = options.filename;
  }
  if (options.schedule) {
    payload.schedule = options.schedule;
  }
  if (options.delay) {
    payload.delay = options.delay;
  }

  logger.info(`[Fonnte WA] Mengirim pesan ke ${phone} via ${apiUrl}`);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const resData = await response.json().catch(() => null);

    if (!response.ok || (resData && resData.status === false)) {
      const errMsg = resData?.reason || resData?.message || `HTTP ${response.status}: ${response.statusText}`;
      logger.error(`[Fonnte WA Error] Gagal kirim ke ${phone}: ${errMsg}`);
      throw new Error(`Fonnte API Error: ${errMsg}`);
    }

    logger.info(`[Fonnte WA Sukses] Pesan terkirim ke ${phone}. Response: ${JSON.stringify(resData)}`);

    // Log ke tabel wa_chat_messages
    try {
      let custName = 'Pelanggan';
      let custId = null;
      const cust = db.prepare('SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ?').get(`%${phone.slice(-8)}%`, `%${phone}%`);
      if (cust) {
        custName = cust.name;
        custId = cust.id;
      }

      const msgId = resData?.id?.[0] || resData?.id || '';
      db.prepare(`
        INSERT INTO wa_chat_messages 
        (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status, meta_message_id)
        VALUES ('outbound', 'fonnte', 'fonnte_gateway', ?, ?, ?, ?, 'sent', ?)
      `).run(phone, custId, custName, messageText, String(msgId));
    } catch (dbErr) {
      logger.error('[Fonnte WA DB Log Error]', dbErr.message);
    }

    return { success: true, data: resData };
  } catch (err) {
    logger.error(`[Fonnte WA Exception] ${err.message}`);
    throw err;
  }
}

/**
 * Test Koneksi / Kirim Pesan Uji Coba Fonnte
 */
async function testFonnteConnection(targetPhone, customMessage) {
  const msg = customMessage || '🔔 *Tes Koneksi Fonnte WhatsApp Gateway Berhasil!*\n\nSistem Billing RTRW Net siap mengirimkan notifikasi otomatis melalui gateway Fonnte.';
  return await sendFonnteMessage(targetPhone, msg);
}

module.exports = {
  normalizePhone,
  sendFonnteMessage,
  testFonnteConnection
};
