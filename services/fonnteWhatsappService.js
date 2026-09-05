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
  if (options.inboxid) {
    payload.inboxid = options.inboxid;
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

/**
 * Memproses Webhook Event Masuk dari Fonnte (Inbound Message & Bot Auto-Reply)
 * @param {object} data Payload dari Fonnte webhook
 */
async function processFonnteWebhook(data = {}) {
  const rawSender = data.sender || data.from || '';
  const messageText = String(data.message || data.text || '').trim();
  const senderName = data.name || 'Pelanggan';
  const inboxid = data.inboxid || null;

  if (!rawSender || !messageText) {
    return { ok: false, reason: 'Sender atau message kosong' };
  }

  const phone = normalizePhone(rawSender);

  // 1. Simpan pesan masuk ke database wa_chat_messages untuk Live Chat
  let customerName = senderName;
  let customerId = null;
  try {
    const cust = db.prepare('SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ?').get(`%${phone.slice(-8)}%`, `%${phone}%`);
    if (cust) {
      customerName = cust.name;
      customerId = cust.id;
    }
  } catch (e) {}

  try {
    db.prepare(`
      INSERT INTO wa_chat_messages 
      (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status, meta_message_id)
      VALUES ('inbound', 'fonnte', ?, ?, ?, ?, ?, 'read', ?)
    `).run(phone, getSetting('company_phone', 'fonnte_bot'), customerId, customerName, messageText, String(data.id || inboxid || ''));
  } catch (dbErr) {
    logger.error('[Fonnte WA Webhook DB Error]', dbErr.message);
  }

  // 2. Cek apakah WhatsApp aktif di pengaturan
  const waEnabled = getSetting('whatsapp_enabled', false);
  if (!waEnabled) {
    logger.info('[Fonnte Bot] WhatsApp dinonaktifkan di pengaturan, lewati bot auto-reply.');
    return { ok: true, handled: false };
  }

  // Fungsi reply otomatis via Fonnte API Gateway
  const reply = async (replyMsg) => {
    logger.info(`[Fonnte Bot Reply] Mengirim balasan ke ${phone}: "${replyMsg.substring(0, 60)}..."`);
    return await sendFonnteMessage(phone, replyMsg, { inboxid });
  };

  try {
    const botMod = await import('./whatsappBot.mjs');
    if (typeof botMod.processIncomingCommand === 'function') {
      const handled = await botMod.processIncomingCommand({
        senderPhone: phone,
        text: messageText,
        reply: reply,
        senderName: customerName
      });
      return { ok: true, handled: !!handled };
    }
  } catch (botErr) {
    logger.error('[Fonnte Bot Error] Gagal memproses perintah:', botErr.message);
  }

  return { ok: true, handled: false };
}

module.exports = {
  normalizePhone,
  sendFonnteMessage,
  testFonnteConnection,
  processFonnteWebhook
};
