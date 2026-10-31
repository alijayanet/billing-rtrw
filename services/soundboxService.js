const db = require('../config/database');
const { logger } = require('../config/logger');

// Pastikan tabel soundbox_events ada
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS soundbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      speech_text TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      customer_name TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (NOW_LOCAL())
    );
    CREATE INDEX IF NOT EXISTS idx_soundbox_created ON soundbox_events(created_at);
  `);
} catch (e) {
  logger.error('[Soundbox] Init table error: ' + e.message);
}

function formatRupiahSpoken(n) {
  const num = Number(n || 0);
  return num.toLocaleString('id-ID') + ' rupiah';
}

/**
 * Memasukkan notifikasi pembayaran masuk ke antrean Soundbox
 */
function queueSoundboxEvent({ type = 'payment', title = 'Pembayaran Masuk', speechText = '', amount = 0, customerName = '' }) {
  try {
    if (!speechText) {
      const spokenAmt = formatRupiahSpoken(amount);
      if (type === 'voucher') {
        speechText = `Pembayaran voucher hotspot ${customerName ? 'paket ' + customerName : ''} sebesar ${spokenAmt} berhasil diterima.`;
      } else if (type === 'invoice') {
        speechText = `Pembayaran tagihan ${customerName ? 'atas nama ' + customerName : ''} sebesar ${spokenAmt} berhasil lunas.`;
      } else if (type === 'donation') {
        speechText = `Donasi masuk sebesar ${spokenAmt} ${customerName ? 'dari ' + customerName : ''} berhasil diterima.`;
      } else if (type === 'topup') {
        speechText = `Top up saldo ${customerName ? 'atas nama ' + customerName : ''} sebesar ${spokenAmt} berhasil masuk.`;
      } else {
        speechText = `Pembayaran sebesar ${spokenAmt} berhasil diterima.`;
      }
    }

    const res = db.prepare(`
      INSERT INTO soundbox_events (type, title, speech_text, amount, customer_name, created_at)
      VALUES (?, ?, ?, ?, ?, (NOW_LOCAL()))
    `).run(type, title, speechText, Math.floor(amount || 0), customerName);

    // Bersihkan entri lama jika > 200 agar database tetap ramping
    db.prepare('DELETE FROM soundbox_events WHERE id < (SELECT COALESCE(MAX(id), 0) - 200 FROM soundbox_events)').run();

    logger.info(`[Soundbox] Event #${res.lastInsertRowid} (${type}): ${speechText}`);
    return res.lastInsertRowid;
  } catch (err) {
    logger.error('[Soundbox] Queue error: ' + err.message);
    return null;
  }
}

/**
 * Mengambil event terbaru untuk polling browser
 */
function getLatestEvents(afterId = 0, limit = 10) {
  try {
    const after = Number(afterId || 0);
    if (after > 0) {
      return db.prepare('SELECT * FROM soundbox_events WHERE id > ? ORDER BY id ASC LIMIT ?').all(after, limit);
    } else {
      return db.prepare('SELECT * FROM soundbox_events ORDER BY id DESC LIMIT ?').all(limit).reverse();
    }
  } catch (err) {
    logger.error('[Soundbox] Fetch error: ' + err.message);
    return [];
  }
}

module.exports = {
  queueSoundboxEvent,
  getLatestEvents,
  formatRupiahSpoken
};
