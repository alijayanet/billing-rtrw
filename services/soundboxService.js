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

/**
 * Konversi angka nominal ke kalimat terbilang bahasa Indonesia alami
 */
function terbilang(n) {
  const bilangan = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  n = Math.floor(Number(n) || 0);
  if (n < 0) return 'minus ' + terbilang(Math.abs(n));
  if (n === 0) return 'nol';
  if (n < 12) return bilangan[n];
  if (n < 20) return terbilang(n - 10) + ' belas';
  if (n < 100) return terbilang(Math.floor(n / 10)) + ' puluh' + (n % 10 !== 0 ? ' ' + terbilang(n % 10) : '');
  if (n < 200) return 'seratus' + (n - 100 !== 0 ? ' ' + terbilang(n - 100) : '');
  if (n < 1000) return terbilang(Math.floor(n / 100)) + ' ratus' + (n % 100 !== 0 ? ' ' + terbilang(n % 100) : '');
  if (n < 2000) return 'seribu' + (n - 1000 !== 0 ? ' ' + terbilang(n - 1000) : '');
  if (n < 1000000) return terbilang(Math.floor(n / 1000)) + ' ribu' + (n % 1000 !== 0 ? ' ' + terbilang(n % 1000) : '');
  if (n < 1000000000) return (Math.floor(n / 1000000) === 1 ? 'satu juta' : terbilang(Math.floor(n / 1000000)) + ' juta') + (n % 1000000 !== 0 ? ' ' + terbilang(n % 1000000) : '');
  if (n < 1000000000000) return terbilang(Math.floor(n / 1000000000)) + ' miliar' + (n % 1000000000 !== 0 ? ' ' + terbilang(n % 1000000000) : '');
  return n.toLocaleString('id-ID');
}

/**
 * Format nominal uang untuk diucapkan lisan oleh TTS / Soundbox Kasir
 */
function formatRupiahSpoken(n) {
  const num = Math.floor(Number(n || 0));
  if (num <= 0) return 'nol rupiah';
  return terbilang(num) + ' rupiah';
}

/**
 * Memasukkan notifikasi pembayaran masuk ke antrean Soundbox
 */
function queueSoundboxEvent({ type = 'payment', title = 'Pembayaran Masuk', speechText = '', amount = 0, customerName = '' }) {
  try {
    const numAmount = Math.floor(Number(amount || 0));
    if (!speechText) {
      const hasAmount = numAmount > 0;
      const spokenAmt = hasAmount ? formatRupiahSpoken(numAmount) : '';
      const amtPhrase = hasAmount ? `sebesar ${spokenAmt} ` : '';

      if (type === 'voucher') {
        const pkgText = customerName ? `paket ${customerName} ` : '';
        speechText = `Pembayaran voucher hotspot ${pkgText}${amtPhrase}berhasil diterima.`;
      } else if (type === 'invoice') {
        const custText = customerName ? `atas nama ${customerName} ` : '';
        speechText = `Pembayaran tagihan ${custText}${amtPhrase}berhasil lunas.`;
      } else if (type === 'donation') {
        const donorText = customerName ? `dari ${customerName} ` : '';
        speechText = `Donasi masuk ${amtPhrase}${donorText}berhasil diterima.`;
      } else if (type === 'topup') {
        const custText = customerName ? `atas nama ${customerName} ` : '';
        speechText = `Top up saldo ${custText}${amtPhrase}berhasil masuk.`;
      } else {
        speechText = `Pembayaran ${amtPhrase}berhasil diterima.`;
      }
      speechText = speechText.replace(/\s+/g, ' ').trim();
    }

    const res = db.prepare(`
      INSERT INTO soundbox_events (type, title, speech_text, amount, customer_name, created_at)
      VALUES (?, ?, ?, ?, ?, (NOW_LOCAL()))
    `).run(type, title, speechText, numAmount, customerName);

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
  formatRupiahSpoken,
  terbilang
};
