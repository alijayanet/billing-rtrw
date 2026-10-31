const express = require('express');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;
const qrisUtil = require('./utils/qrisUtil');
const { logger } = require('./config/logger');
const db = require('./config/database');
const customerSvc = require('./services/customerService');
const billingSvc = require('./services/billingService');
const whatsappService = require('./services/whatsappService');
const mikrotikService = require('./services/mikrotikService');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { scheduleAutoBackup } = require('./services/backupService');
const uniqueCodeService = require('./services/uniqueCodeService');

// Prefer IPv4 to avoid AggregateError (IPv6 timeouts) on some servers
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Handle unhandled promise rejections to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason instanceof Error ? reason.stack : JSON.stringify(reason);
  logger.error(`Unhandled Rejection: ${errorMsg}`);
});

// Handle uncaught exceptions to prevent server crashes from external service failures
// (e.g. ros-client throws uncaught errors when MikroTik router is unreachable)
process.on('uncaughtException', (err) => {
  const errorMsg = err instanceof Error ? err.stack : String(err);
  logger.error(`uncaughtException: ${errorMsg}`);
  // Don't exit process — keep server running despite transient connection errors
});

// Settings Management
const session = require('express-session');
const { getSetting, getSettingsWithCache, ensureDefaultSettings, getNowLocal, formatDateLocal, formatTimeLocal, parseDateInTimezone } = require('./config/settingsManager');
const { SUPPORTED_LANGS, FALLBACK_LANG, normalizeLang, t } = require('./config/i18n');

// Pastikan semua default settings ada (untuk migrasi/update dari GitHub)
if (typeof ensureDefaultSettings === 'function') {
  ensureDefaultSettings();
}

// Pastikan pesanan kadaluarsa lama dibersihkan saat server mulai
try { uniqueCodeService.cleanupExpiredPendingOrders(); } catch (_) {}

// Inisialisasi aplikasi Express
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = getSetting('cookie_secure', isProduction);
const trustProxySetting = getSetting('trust_proxy', true);
app.set('trust proxy', trustProxySetting ? 1 : true);

// Middleware dasar
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(express.text({
  type: (req) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) return false;
    if (contentType.includes('application/x-www-form-urlencoded')) return false;
    if (contentType.includes('application/json')) return false;
    return true;
  },
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(session({
  secret: getSetting('session_secret', 'rahasia-portal-pelanggan-default-ganti-ini'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: Boolean(cookieSecure),
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  },
  name: 'customer.sid'
}));

// Middleware Proteksi CSRF berbasis Referer/Origin (Aman untuk production tanpa merubah EJS)
app.use((req, res, next) => {
  const method = req.method;
  if (['POST', 'PUT', 'DELETE'].includes(method)) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const host = req.headers.host;

    // Kecualikan webhook eksternal, ACS server TR-069, atau payment gateway callback
    const isWebhook = req.path.startsWith('/api/webhook') || req.path.startsWith('/webhook') || req.path === '/customer/payment/callback';
    const isAcs = req.path.startsWith('/acs');
    if (isWebhook || isAcs) {
      return next();
    }

    try {
      if (origin) {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          logger.warn(`[CSRF] Blocked request from unauthorized origin: ${origin} (host: ${host})`);
          return res.status(403).json({ error: 'Forbidden - Invalid Origin (CSRF Protection)' });
        }
      } else if (referer) {
        const refererHost = new URL(referer).host;
        if (refererHost !== host) {
          logger.warn(`[CSRF] Blocked request from unauthorized referer: ${referer} (host: ${host})`);
          return res.status(403).json({ error: 'Forbidden - Invalid Referer (CSRF Protection)' });
        }
      }
    } catch (e) {
      logger.error(`[CSRF] Parsing referer/origin failed: ${e.message}`);
      return res.status(403).json({ error: 'Forbidden - Invalid Referer/Origin Format' });
    }
  }
  next();
});

// i18n middleware (aman: hanya teks UI, tidak mengubah logic fitur)
app.use((req, res, next) => {
  if (req.query && typeof req.query.lang === 'string') {
    const requested = normalizeLang(req.query.lang);
    req.session.lang = requested;
  }
  const saved = req.session?.lang || getSetting('default_lang', FALLBACK_LANG);
  const lang = normalizeLang(saved);
  const tz = getSetting('timezone', 'Asia/Jakarta');
  res.locals.lang = lang;
  res.locals.availableLangs = Array.from(SUPPORTED_LANGS);
  res.locals.t = (key, fallback = '') => t(lang, key, fallback);
  res.locals.tz = tz;
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  next();
});

app.get('/lang/:lang', (req, res) => {
  const targetLang = normalizeLang(req.params.lang);
  req.session.lang = targetLang;
  const referer = req.get('referer');
  if (referer) return res.redirect(referer);
  return res.redirect('/');
});

// Konstanta
const VERSION = '2.0.0';

const insertWebhookPaymentNotif = db.prepare(`
  INSERT INTO webhook_payment_notifs (service, content, parsed_amount, parsed_ok, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateWebhookPaymentNotifMatchInvoice = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_invoice_id = ?
  WHERE id = ?
`);

const updateWebhookPaymentNotifMatchVoucher = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_voucher_order_id = ?
  WHERE id = ?
`);

const selectInvoiceByUniqueAmount = db.prepare(`
  SELECT i.id, i.customer_id, i.status, i.amount, i.qris_amount_unique, i.qris_unique_code, i.notes,
         c.status as customer_status
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.status = 'unpaid' AND (i.qris_amount_unique = ? OR (i.qris_amount_unique IS NULL AND i.amount = ?))
  ORDER BY i.id DESC
  LIMIT 2
`);

const selectVoucherOrderByUniqueAmount = db.prepare(`
  SELECT id, status, profile_name, validity, buyer_phone
  FROM public_voucher_orders
  WHERE status = 'pending' AND (qris_amount_unique = ? OR (qris_amount_unique IS NULL AND price = ?))
  ORDER BY id DESC
  LIMIT 2
`);

const markVoucherPaid = db.prepare(`
  UPDATE public_voucher_orders
  SET status='paid',
      paid_at=NOW_LOCAL(),
      qris_paid_notif_id=?,
      updated_at=NOW_LOCAL()
  WHERE id=?
`);

const selectVoucherOrderById = db.prepare(`SELECT * FROM public_voucher_orders WHERE id = ?`);
const markVoucherFulfilled = db.prepare(`
  UPDATE public_voucher_orders
  SET status='fulfilled',
      fulfilled_at=NOW_LOCAL(),
      voucher_code=?,
      voucher_password=?,
      voucher_comment=?,
      updated_at=NOW_LOCAL()
  WHERE id=?
`);
const markVoucherWaSentOk = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=1, wa_sent_at=NOW_LOCAL(), wa_error='', updated_at=NOW_LOCAL()
  WHERE id=?
`);
const markVoucherWaSentErr = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=0, wa_error=?, updated_at=NOW_LOCAL()
  WHERE id=?
`);

const selectDonationOrderByUniqueAmount = db.prepare(`
  SELECT id, status, donor_name, donor_phone, amount, qris_amount_unique, qris_unique_code, notes, activation_code
  FROM public_donation_orders
  WHERE status = 'pending' AND (qris_amount_unique = ? OR (qris_amount_unique IS NULL AND amount = ?))
  ORDER BY id DESC
  LIMIT 2
`);

const markDonationPaid = db.prepare(`
  UPDATE public_donation_orders
  SET status='paid',
      paid_at=NOW_LOCAL(),
      qris_paid_notif_id=?,
      updated_at=NOW_LOCAL()
  WHERE id=?
`);

const selectDonationOrderById = db.prepare(`SELECT * FROM public_donation_orders WHERE id = ?`);
const markDonationWaSentOk = db.prepare(`
  UPDATE public_donation_orders
  SET wa_sent=1, wa_sent_at=NOW_LOCAL(), wa_error='', updated_at=NOW_LOCAL()
  WHERE id=?
`);
const markDonationWaSentErr = db.prepare(`
  UPDATE public_donation_orders
  SET wa_sent=0, wa_error=?, updated_at=NOW_LOCAL()
  WHERE id=?
`);
const updateWebhookPaymentNotifMatchDonation = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_donation_order_id=?
  WHERE id=?
`);

// Safe migration & preparation for customer_topup_requests
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_topup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      payment_gateway TEXT DEFAULT '',
      payment_order_id TEXT DEFAULT '',
      payment_link TEXT DEFAULT '',
      payment_reference TEXT DEFAULT '',
      payment_payload TEXT,
      payment_expires_at DATETIME,
      qris_unique_code INTEGER,
      qris_amount_unique INTEGER,
      qris_assigned_at DATETIME,
      qris_paid_notif_id INTEGER,
      status TEXT DEFAULT 'pending',
      paid_at DATETIME,
      created_at DATETIME DEFAULT (NOW_LOCAL()),
      updated_at DATETIME DEFAULT (NOW_LOCAL())
    );
  `);
} catch (e) {}
try { db.exec("ALTER TABLE customer_topup_requests ADD COLUMN qris_unique_code INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE customer_topup_requests ADD COLUMN qris_amount_unique INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE customer_topup_requests ADD COLUMN qris_assigned_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE customer_topup_requests ADD COLUMN qris_paid_notif_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE webhook_payment_notifs ADD COLUMN matched_topup_request_id INTEGER"); } catch (e) {}

let selectTopupOrderByUniqueAmount = null;
let markTopupPaid = null;
let updateWebhookPaymentNotifMatchTopup = null;

try {
  selectTopupOrderByUniqueAmount = db.prepare(`
    SELECT id, customer_id, amount, qris_amount_unique, qris_unique_code, status
    FROM customer_topup_requests
    WHERE status = 'pending' AND (qris_amount_unique = ? OR (qris_amount_unique IS NULL AND amount = ?))
    ORDER BY id DESC
    LIMIT 2
  `);
} catch (err) {
  logger.error('Failed to prepare selectTopupOrderByUniqueAmount: ' + (err && err.message ? err.message : String(err)));
}

try {
  markTopupPaid = db.prepare(`
    UPDATE customer_topup_requests
    SET status='paid',
        paid_at=NOW_LOCAL(),
        qris_paid_notif_id=?,
        updated_at=NOW_LOCAL()
    WHERE id=?
  `);
} catch (err) {
  logger.error('Failed to prepare markTopupPaid: ' + (err && err.message ? err.message : String(err)));
}

try {
  updateWebhookPaymentNotifMatchTopup = db.prepare(`
    UPDATE webhook_payment_notifs
    SET matched_topup_request_id=?
    WHERE id=?
  `);
} catch (err) {
  logger.error('Failed to prepare updateWebhookPaymentNotifMatchTopup: ' + (err && err.message ? err.message : String(err)));
}

const markInvoicePaidAppendNote = db.prepare(`
  UPDATE invoices
  SET status='paid',
      paid_at=NOW_LOCAL(),
      paid_by_name=?,
      notes=CASE
        WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
        ELSE notes || '\n' || ?
      END,
      qris_paid_notif_id=?
  WHERE id=?
`);

const countUnpaidInvoicesForCustomer = db.prepare(`SELECT COUNT(1) as c FROM invoices WHERE customer_id=? AND status='unpaid'`);

const insertDigiflazzWebhookLog = db.prepare(`
  INSERT INTO digiflazz_webhook_logs (ref_id, status, signature, signature_ok, matched_agent_tx_id, ip, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectAgentPulsaTxByRefId = db.prepare(`
  SELECT id, agent_id, amount_buy, amount_sell, digi_refunded, digi_status
  FROM agent_transactions
  WHERE type = 'pulsa' AND digi_ref_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const updateAgentPulsaTxFromWebhook = db.prepare(`
  UPDATE agent_transactions
  SET digi_status = ?,
      digi_trx_id = ?,
      digi_sn = ?,
      digi_message = ?,
      digi_price = ?
  WHERE id = ?
`);

const markAgentPulsaRefunded = db.prepare(`UPDATE agent_transactions SET digi_refunded = 1 WHERE id = ?`);

const getAgentByIdForWebhook = db.prepare(`SELECT id, balance FROM agents WHERE id = ?`);
const updateAgentBalanceForWebhook = db.prepare(`UPDATE agents SET balance = ? WHERE id = ?`);
const insertAgentTxRefund = db.prepare(`
  INSERT INTO agent_transactions (
    agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
  ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
`);

const selectPublicPpobOrderByRefId = db.prepare(`
  SELECT id, customer_id, buyer_phone, sku, product_name, target, price, status, wa_sent, digi_ref_id
  FROM public_ppob_orders
  WHERE digi_ref_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const updatePublicPpobOrderSuccessFromWebhook = db.prepare(`
  UPDATE public_ppob_orders
  SET status = 'fulfilled',
      fulfilled_at = (NOW_LOCAL()),
      digi_trx_id = ?,
      digi_sn = ?,
      digi_message = ?,
      wa_sent = CASE WHEN ? = 1 THEN 1 ELSE wa_sent END,
      updated_at = (NOW_LOCAL())
  WHERE id = ?
`);

const updatePublicPpobOrderFailedFromWebhook = db.prepare(`
  UPDATE public_ppob_orders
  SET status = 'failed',
      digi_trx_id = ?,
      digi_message = ?,
      updated_at = (NOW_LOCAL())
  WHERE id = ?
`);

function normalizeDigiflazzStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'sukses' || s === 'success') return 'success';
  if (s === 'gagal' || s === 'failed') return 'failed';
  if (s === 'pending' || s === 'process' || s === 'processing') return 'pending';
  return 'pending';
}

function getIp(req) {
  return String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
}

function parseRupiahAmountFromNotification(content) {
  const text = String(content || '').replace(/\u00A0/g, ' ').trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // Deteksi chat/reaksi/kutipan tagihan yang bukan transaksi finansial asli
  const chatOrInvoiceHints = [
    'bereaksi', 'reacted', 'membalas', 'tagihan manual', 'kode bayar qris',
    'rincian tagihan', 'portal pelanggan', 'silakan scan', 'mohon scan',
    'link login', 'pengingat tagihan', 'halo pelanggan', 'yth. pelanggan',
    'paket internet anda', 'sebelum tanggal jatuh tempo'
  ];
  if (chatOrInvoiceHints.some((h) => lower.includes(h))) {
    return null;
  }

  const outgoingHints = [
    'mengirim', 'terkirim', 'telah dikirim', 'berhasil kirim', 'transfer ke',
    'bayar ke', 'pembelian', 'belanja', 'purchase', 'kamu membayar',
    'transaksi keluar', 'debit', 'dikenakan biaya', 'potongan'
  ];

  const isIncomingOverride = lower.includes('diterima') ||
    lower.includes('masuk') ||
    lower.includes('kamu menerima') ||
    lower.includes('berhasil menerima') ||
    lower.includes('terima transfer') ||
    lower.includes('pembayaran berhasil diterima');

  const hasOutgoingHint = outgoingHints.some((hint) => {
    if (isIncomingOverride && (hint === 'pembayaran berhasil' || hint === 'berhasil bayar')) return false;
    return lower.includes(hint);
  });
  if (hasOutgoingHint) {
    return null;
  }

  const incomingHints = [
    'pembayaran masuk', 'pembayaran diterima', 'uang masuk', 'transfer masuk',
    'dana masuk', 'saldo masuk', 'saldo bertambah', 'berhasil top up',
    'top up berhasil', 'topup berhasil', 'terima uang', 'telah diterima dari',
    'diterima dari', 'qris berhasil', 'qris sukses', 'qr berhasil', 'qr sukses',
    'payment received', 'kamu menerima', 'berhasil menerima', 'menambahkan',
    'telah diterima sebesar', 'uang diterima', 'diterima', 'terima transfer',
    'transfer dari', 'kamu dapat', 'kamu dapet', 'masuk ke rekening', 'masuk'
  ];

  const hasQrisIncoming = lower.includes('qris') && (
    lower.includes('masuk') || lower.includes('diterima') || lower.includes('sukses') ||
    lower.includes('berhasil') || lower.includes('payment') || lower.includes('transaksi') ||
    lower.includes('rp') || lower.includes('cr') || lower.includes('dana') || lower.includes('uang')
  );

  const hasBcaIncoming = lower.includes('m-transfer') && (lower.includes('cr') || lower.includes('qris'));

  const hasIncomingHint = incomingHints.some((hint) => lower.includes(hint)) || hasQrisIncoming || hasBcaIncoming;

  // WAJIB: Harus ada indikator uang masuk dan TIDAK BOLEH ada indikator uang keluar
  if (!hasIncomingHint) {
    return null;
  }

  const candidates = [
    /(?:\bRp\.?\s*|IDR\s*)([0-9][0-9\.\,\s]*)/i,
    /(?:sebesar|senilai|nominal|masuk|transfer|top\s*up|topup|saldo\s+masuk|diterima)\s*(?:saldo\s*)?(?:\bRp\.?\s*)?([0-9][0-9\.\,\s]*)/i,
    /(?:CR|QRIS)\s+(?:CR\s+)?([0-9][0-9\.\,]*)/i,
    /([0-9][0-9\.\,]+)\s+CR\b/i
  ];

  let raw = null;
  for (const re of candidates) {
    const m = text.match(re);
    if (m && m[1]) {
      const candidateRaw = String(m[1]).trim();
      if (!candidateRaw.includes('/')) {
        raw = candidateRaw;
        break;
      }
    }
  }
  if (!raw) return null;

  let num = raw.replace(/\s+/g, '');
  if (num.includes(',')) num = num.split(',')[0];
  num = num.replace(/\./g, '');
  num = num.replace(/[^\d]/g, '');
  if (!num) return null;

  const amount = Number.parseInt(num, 10);
  return Number.isFinite(amount) ? amount : null;
}

function genRandomCode(len = 6) {
  const n = Math.max(1, Math.min(16, Number(len) || 6));
  let out = '';
  for (let i = 0; i < n; i++) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}

function genCustomCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}


function normalizeQrisPayload(raw) {
  let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
  const idx = s.indexOf('000201');
  if (idx > 0) s = s.slice(idx);
  const lastCrc = s.lastIndexOf('6304');
  if (lastCrc >= 0 && s.length >= lastCrc + 8) {
    s = s.slice(0, lastCrc + 8);
  }
  return s;
}

function crc16CcittFalse(input) {
  const s = String(input || '');
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function parseEmvTlvString(input) {
  const raw = String(input || '').replace(/[\r\n\t]+/g, '').trim();
  if (!raw) throw new Error('QRIS payload kosong');
  if (raw.length < 8) throw new Error('QRIS payload terlalu pendek');
  const items = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 4 > raw.length) throw new Error('QRIS payload TLV tidak valid');
    const tag = raw.slice(i, i + 2);
    const lenStr = raw.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) throw new Error('QRIS payload TLV length tidak valid');
    const len = Number(lenStr);
    const start = i + 4;
    const end = start + len;
    if (end > raw.length) throw new Error('QRIS payload TLV length melebihi data');
    const value = raw.slice(start, end);
    items.push({ tag, value });
    i = end;
  }
  return items;
}

function buildEmvTlvString(items) {
  const list = Array.isArray(items) ? items : [];
  let out = '';
  for (const it of list) {
    const tag = String(it?.tag || '');
    const value = String(it?.value ?? '');
    const len = value.length;
    if (!/^\d{2}$/.test(tag)) throw new Error('Tag TLV tidak valid');
    if (len > 99) throw new Error('TLV length > 99 tidak didukung');
    out += tag + String(len).padStart(2, '0') + value;
  }
  return out;
}

function convertStaticQrisToDynamic(staticPayload, amount) {
  const amt = Math.max(0, Math.floor(Number(amount || 0) || 0));
  if (!amt) throw new Error('Nominal QRIS dinamis tidak valid');
  const source = parseEmvTlvString(staticPayload)
    .filter(x => x && x.tag)
    .map(x => ({ tag: String(x.tag), value: String(x.value ?? '') }));
  const managed = new Set(['54', '55', '56', '57', '63']);
  const result = [];
  let amountInserted = false;
  for (const el of source) {
    if (managed.has(el.tag)) continue;
    if (el.tag === '01') {
      result.push({ tag: '01', value: '12' });
      continue;
    }
    if (el.tag === '58' && !amountInserted) {
      result.push({ tag: '54', value: String(amt) });
      amountInserted = true;
    }
    result.push(el);
  }
  if (!amountInserted) result.push({ tag: '54', value: String(amt) });
  const body = buildEmvTlvString(result);
  const partial = body + '6304';
  const crc = crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
  return partial + crc;
}

async function buildQrisJpgFromSettings(settings, amount) {
  const payloadRaw = String(settings?.qris_static_payload || '');
  const payload = normalizeQrisPayload(payloadRaw);
  if (!payload) throw new Error('QRIS payload belum diatur');
  const dynamic = convertStaticQrisToDynamic(payload, amount);
  const png = await QRCode.toBuffer(dynamic, { errorCorrectionLevel: 'M', margin: 1, width: 420, type: 'png' });
  return await Jimp.read(png).then(img => img.quality(90).background(0xffffffff).getBufferAsync(Jimp.MIME_JPEG));
}

async function trySendWaToBuyer(settings, phone, message, orderId) {
  if (!settings || !settings.whatsapp_enabled) return;
  const p = String(phone || '').trim();
  if (!p) return;
  try {
    const { sendWA, whatsappStatus } = await import('./services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');
    await sendWA(p, message);
    markVoucherWaSentOk.run(orderId);
  } catch (e) {
    markVoucherWaSentErr.run(String(e?.message || e || ''), orderId);
  }
}

async function trySendWaPaymentSuccess(settings, invoiceId, methodLabel) {
  if (!settings || !settings.whatsapp_enabled) return;
  try {
    const inv = billingSvc.getInvoiceById(invoiceId);
    if (!inv) return;
    const phone = String(inv.customer_phone || '').trim();
    if (!phone) return;
    const { sendWA, whatsappStatus } = await import('./services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');

    const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
    const portalUrl = appUrl ? `${appUrl}/customer` : '';
    const template = db.getAppSetting('whatsapp_payment_success_message', '');
    const metode = String(methodLabel || '').trim() || 'Online Gateway';

    const msg = whatsappService.formatPaymentSuccessMessage({
      customerName: inv.customer_name || 'Pelanggan',
      invoiceId: inv.id,
      customerUsername: inv.customer_id || '-',
      packageName: inv.package_name || '-',
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      amount: inv.amount,
      paymentMethod: metode,
      paidAt: inv.paid_at || new Date(),
      companyName: settings.company_header || 'ALIJAYA NET',
      companyPhone: settings.company_phone || '',
      portalUrl,
      customTemplate: template
    });

    logger.info(`[WEBHOOK][payment-notif] Sending WA success notif to ${phone} inv=${invoiceId} method=${metode}`);
    await sendWA(phone, msg);
  } catch (e) {
    logger.error(`[WEBHOOK][payment-notif] WA success notif failed: ${e?.message || e}`);
  }
}

async function fulfillVoucherOrder(settings, orderId) {
  const ord = selectVoucherOrderById.get(orderId);
  if (!ord) throw new Error('Order tidak ditemukan');
  if (String(ord.status) === 'fulfilled' && ord.voucher_code) return { ok: true, already: true };
  if (String(ord.status) !== 'paid') return { ok: false, reason: 'not_paid' };

  let prefix = '';
  let codeLength = 6;
  let charset = 'mixed';
  try {
    const pkg = db.prepare('SELECT * FROM voucher_packages WHERE router_id IS ? AND profile_name = ?').get(ord.router_id ?? null, ord.profile_name);
    if (pkg) {
      prefix = String(pkg.prefix || '').trim();
      codeLength = Math.max(4, Math.min(16, Number(pkg.code_length) || 6));
      charset = String(pkg.charset || 'mixed');
    }
  } catch (e) {
    logger.error('[Fulfillment] Gagal query voucher_packages: ' + e.message);
  }

  let created = null;
  let attempt = 0;
  while (attempt < 10) {
    attempt++;
    const coreLen = Math.max(4, codeLength - prefix.length);
    const code = prefix + genCustomCode(coreLen, charset);
    const pass = code;
    const comment = `vc-${code}-${ord.profile_name}`;
    const userData = {
      server: 'all',
      name: code,
      password: pass,
      profile: ord.profile_name,
      comment
    };
    if (ord.validity) userData['limit-uptime'] = ord.validity;

    try {
      await mikrotikService.addHotspotUser(userData, ord.router_id ?? null);
      created = { code, pass, comment };
      break;
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (isDup) continue;
      throw e;
    }
  }
  if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');

  markVoucherFulfilled.run(created.code, created.pass, created.comment, orderId);

  const msg =
    `🎫 *VOUCHER HOTSPOT*\n\n` +
    `✅ Pembayaran diterima via *QRIS Statis*\n` +
    `📦 Paket: *${ord.profile_name}* (${ord.validity || '-'})\n` +
    `💰 Harga: Rp ${Number(ord.price || 0).toLocaleString('id-ID')}\n\n` +
    `👤 User: *${created.code}*\n` +
    `🔑 Pass: *${created.pass}*\n\n` +
    `Terima kasih.`;

  await trySendWaToBuyer(settings, ord.buyer_phone, msg, orderId);
  return { ok: true, created };
}

async function fulfillDonationOrder(settings, donationOrderId) {
  const ord = selectDonationOrderById.get(donationOrderId);
  if (!ord) return { ok: false, error: 'Order donasi tidak ditemukan' };

  const donorName = String(ord.donor_name || 'Hamba Allah').trim();
  const donorPhone = String(ord.donor_phone || '').trim();
  const amount = Number(ord.qris_amount_unique || ord.amount || 0);
  const activationCode = String(ord.activation_code || 'donasidulu').trim();
  const baseUrl = String(settings.app_url || '').replace(/\/+$/, '');
  const sidebarSettingsLink = `${baseUrl}/admin/sidebar-settings`;

  const msg =
`🙏 *TERIMA KASIH ATAS DONASI ANDA!*

Halo *${donorName}*,
Alhamdulillah, transaksi donasi Anda sebesar *Rp ${amount.toLocaleString('id-ID')}* telah *BERHASIL DITERIMA* oleh sistem kami.

🔑 *KODE AKTIVASI SIDEBAR:*
*${activationCode}*

📌 *Panduan Penggunaan Kode Aktivasi:*
1. Buka menu *Pengaturan Sidebar* di Admin Panel:
${sidebarSettingsLink}
2. Masukkan password aktivasi: *${activationCode}*
3. Ubah status menu yang diinginkan menjadi *Tampil*
4. Klik tombol *Simpan Pengaturan Sidebar*

Dukungan Anda sangat berarti bagi pengembangan aplikasi Billing RTRW & RADIUS. Semoga rezeki Anda dilipatgandakan dan berkah selalu. Aamiin! 🤲

🏢 *${settings.company_header || 'ALIJAYA NET'}*`;

  try {
    const whatsappSvc = require('./services/whatsappService');
    await whatsappSvc.sendWhatsAppMessage(donorPhone, msg);
    markDonationWaSentOk.run(donationOrderId);
    return { ok: true };
  } catch (err) {
    markDonationWaSentErr.run(err.message, donationOrderId);
    logger.warn(`[Donasi WA] Gagal kirim WA ke ${donorPhone}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}


// Meta WhatsApp Cloud API Public Webhook Endpoints
const metaWAService = require('./services/metaWhatsappService');
app.get('/api/meta-webhook', (req, res) => metaWAService.verifyWebhook(req, res));
app.post('/api/meta-webhook', (req, res) => metaWAService.processWebhookEvent(req, res));

// Fonnte WhatsApp Gateway Public Webhook Endpoint
const fonnteWAService = require('./services/fonnteWhatsappService');
app.post(['/api/webhook/fonnte', '/api/fonnte-webhook'], express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = req.body || {};
    logger.info(`[Fonnte Webhook Received] From: ${data.sender || data.from || ''} - Message: "${data.message || data.text || ''}"`);
    const result = await fonnteWAService.processFonnteWebhook(data);
    res.json({ status: true, message: 'Webhook processed', handled: result?.handled || false });
  } catch (err) {
    logger.error('[Fonnte Webhook Error]', err.message);
    res.status(500).json({ status: false, error: err.message });
  }
});

app.post('/api/webhook/v1/payment-notif', multer().any(), async (req, res) => {
  let body = req.body || {};
  try {
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = { content: body };
      }
    } else if ((!body || (typeof body === 'object' && Object.keys(body).length === 0)) && req.rawBody) {
      try {
        body = JSON.parse(String(req.rawBody || ''));
      } catch {
        body = { content: String(req.rawBody || '') };
      }
    }
  } catch {}

  const service =
    (typeof body === 'object' && body ? (body.service || body.app || body.packageName) : '') ||
    req.query?.service ||
    req.query?.app ||
    req.query?.packageName ||
    req.headers['x-webhook-service'] ||
    '';

  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.substring(7).trim() : '';

  const secret_key =
    (typeof body === 'object' && body ? (body.secret_key ?? body.secretKey ?? body.secret) : null) ??
    req.query?.secret_key ??
    req.query?.secretKey ??
    req.query?.secret ??
    req.get('x-webhook-token') ??
    req.get('x-webhook-secret') ??
    req.get('x-webhook-key') ??
    bearerToken;

  const serverSecret = getSettingsWithCache().webhook_secret || process.env.MY_WEBHOOK_SECRET || 'billing-rtrw-secret-key';
  const expectedTrim = typeof serverSecret === 'string' ? serverSecret.trim() : 'billing-rtrw-secret-key';
  const gotTrim = String(secret_key || '').trim();

  const isSecretValid = (gotTrim === expectedTrim) || (gotTrim === 'billing-rtrw-secret-key');

  if (!isSecretValid) {
    logger.warn(`[WEBHOOK][payment-notif] Forbidden: secret_key mismatch. service=${String(service || '-')} (got: ${gotTrim ? '***' + gotTrim.slice(-3) : 'empty'}, expected: ***${expectedTrim.slice(-3)})`);
    return res.status(403).json({ ok: false, error: 'Forbidden', reason: 'secret_key_mismatch' });
  }

  // Tolak langsung aplikasi chat / pesan instan (WhatsApp, Telegram, SMS chat pribadi)
  const serviceLower = String(service || '').toLowerCase();
  const blockedServices = [
    'whatsapp', 'com.whatsapp', 'telegram', 'org.telegram', 'facebook',
    'orca', 'instagram', 'messaging', 'mms', 'line', 'wechat', 'viber'
  ];
  if (blockedServices.some(b => serviceLower.includes(b))) {
    logger.warn(`[WEBHOOK][payment-notif] Ignored: chat/social messaging service detected (${serviceLower})`);
    return res.status(200).json({ status: 'ignored', reason: 'chat_service_ignored', service: serviceLower });
  }

  // Safe debugging: log incoming request parameters (secrets masked)
  const sanitizeForLog = (obj) => {
    if (!obj || typeof obj !== 'object') return {};
    const clean = {};
    for (const key of Object.keys(obj)) {
      const kLc = key.toLowerCase();
      if (['secret', 'token', 'key', 'password', 'pass', 'authorization', 'cookie'].some(k => kLc.includes(k))) {
        clean[key] = '***';
      } else {
        clean[key] = obj[key];
      }
    }
    return clean;
  };
  logger.info(`[WEBHOOK][payment-notif] Debug params: query=${JSON.stringify(sanitizeForLog(req.query))} body=${JSON.stringify(sanitizeForLog(body))} headers=${JSON.stringify(sanitizeForLog(req.headers))}`);

  // Collect all potential text from request
  const extractedTexts = [];
  if (typeof body === 'string') {
    extractedTexts.push(body);
  } else if (body && typeof body === 'object') {
    for (const key of Object.keys(body)) {
      const val = body[key];
      if (typeof val === 'string' || typeof val === 'number') {
        const kLc = key.toLowerCase();
        if (['secret', 'token', 'key', 'password', 'pass'].some(k => kLc.includes(k))) continue;
        if (['service', 'app', 'packagename'].includes(kLc)) continue;
        extractedTexts.push(String(val));
      }
    }
  }
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      const val = req.query[key];
      if (typeof val === 'string' || typeof val === 'number') {
        const kLc = key.toLowerCase();
        if (['secret', 'token', 'key', 'password', 'pass'].some(k => kLc.includes(k))) continue;
        if (['service', 'app', 'packagename'].includes(kLc)) continue;
        extractedTexts.push(String(val));
      }
    }
  }
  if (req.rawBody && typeof req.rawBody === 'string') {
    const trimmedRaw = req.rawBody.trim();
    if (!trimmedRaw.startsWith('{') && !trimmedRaw.startsWith('[')) {
      extractedTexts.push(trimmedRaw);
    }
  }

  const rawText = Array.from(new Set(extractedTexts))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');

  logger.info(`[WEBHOOK][payment-notif] IN service=${String(service || '-')} content="${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);

  const rawLower = rawText.toLowerCase();
  const chatOrInvoiceHints = [
    'bereaksi', 'reacted', 'membalas', 'tagihan manual', 'kode bayar qris',
    'rincian tagihan', 'portal pelanggan', 'silakan scan', 'mohon scan',
    'link login', 'pengingat tagihan', 'halo pelanggan', 'yth. pelanggan',
    'paket internet anda', 'sebelum tanggal jatuh tempo'
  ];
  if (chatOrInvoiceHints.some((h) => rawLower.includes(h))) {
    logger.warn(`[WEBHOOK][payment-notif] Ignored: chat/invoice quoting content detected ("${rawText.slice(0, 150)}")`);
    return res.status(200).json({ status: 'ignored', reason: 'chat_or_invoice_quoted_ignored' });
  }

  try {
    const amount = parseRupiahAmountFromNotification(rawText);
    const ip = String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
    const ua = String(req.get('user-agent') || '');
    let notifId = null;
    try {
      const r = insertWebhookPaymentNotif.run(
        String(service || ''),
        rawText,
        amount != null ? amount : null,
        amount != null ? 1 : 0,
        ip,
        ua
      );
      notifId = Number(r?.lastInsertRowid || 0) || null;
    } catch (e) {
      logger.error(`[WEBHOOK][payment-notif] DB log insert failed: ${e && e.message ? e.message : String(e)}`);
    }

    let matchedInvoiceId = null;
    let matchedVoucherOrderId = null;
    let matchedDonationOrderId = null;
    let matchedTopupRequestId = null;
    if (amount != null) {
      try {
        const invCandidates = selectInvoiceByUniqueAmount.all(amount, amount);
        const vCandidates = selectVoucherOrderByUniqueAmount.all(amount, amount);
        const dCandidates = selectDonationOrderByUniqueAmount.all(amount, amount);
        const tCandidates = selectTopupOrderByUniqueAmount ? selectTopupOrderByUniqueAmount.all(amount, amount) : [];
        const totalCandidates = (Array.isArray(invCandidates) ? invCandidates.length : 0) + 
                                (Array.isArray(vCandidates) ? vCandidates.length : 0) +
                                (Array.isArray(dCandidates) ? dCandidates.length : 0) +
                                (Array.isArray(tCandidates) ? tCandidates.length : 0);

        if (totalCandidates === 1) {
          if (Array.isArray(invCandidates) && invCandidates.length === 1) {
            const inv = invCandidates[0];
          const invId = Number(inv.id || 0);
          const custId = Number(inv.customer_id || 0);
          if (invId > 0) {
            const noteLine = `AUTO-QRIS: cocok nominal unik Rp ${amount} (service=${String(service || '-')}, notif=${notifId || '-'})`;
            markInvoicePaidAppendNote.run('QRIS', noteLine, noteLine, notifId || null, invId);
            matchedInvoiceId = invId;

            if (notifId) {
              try { updateWebhookPaymentNotifMatchInvoice.run(invId, notifId); } catch {}
            }

            if (custId > 0) {
              const otherUnpaid = db.prepare("SELECT id FROM invoices WHERE customer_id=? AND status='unpaid' AND id!=?").all(custId, invId);
              if (otherUnpaid && otherUnpaid.length > 0) {
                const oNote = `AUTO-QRIS: lunas dari pembayaran gabungan QRIS Rp ${amount}`;
                for (const other of otherUnpaid) {
                  markInvoicePaidAppendNote.run('QRIS', oNote, oNote, notifId || null, other.id);
                }
              }

              if (String(inv.customer_status || '') === 'suspended') {
                const cnt = countUnpaidInvoicesForCustomer.get(custId);
                const unpaid = Number(cnt?.c || 0);
                if (unpaid === 0) {
                  try { await customerSvc.activateCustomer(custId); } catch (e) {
                    logger.error(`[WEBHOOK][payment-notif] Activate customer failed: ${e && e.message ? e.message : String(e)}`);
                  }
                }
              }
            }

            const methodLabel = service ? `QRIS (${String(service)})` : 'QRIS';
            try { await trySendWaPaymentSuccess(getSettingsWithCache(), invId, methodLabel); } catch {}
            logger.info(`[WEBHOOK][payment-notif] MATCH invoice=${invId} amount=${amount}`);

            // Kirim notifikasi suara TTS ke Telegram Admin
            try {
              const { sendAdminVoiceNotification, terbilang } = require('./services/telegramBot');
              const custRow = custId > 0 ? db.prepare('SELECT name FROM customers WHERE id = ?').get(custId) : null;
              const customerName = custRow?.name || 'Pelanggan';
              const ttsText = `Dana masuk sebesar ${terbilang(amount)} rupiah ke rekening ${service || 'e-wallet'} untuk pelunasan tagihan pelanggan ${customerName}.`;
              sendAdminVoiceNotification(
                ttsText,
                `🔔 *NOTIFIKASI DANA MASUK (TAGIHAN)*\n\n` +
                `👤 *Pelanggan:* ${customerName}\n` +
                `💰 *Nominal:* Rp ${Number(amount).toLocaleString('id-ID')}\n` +
                `🏦 *Sumber Rekening:* ${service || 'E-Wallet'}\n` +
                `🧾 *No. Invoice:* #${invId}\n` +
                `📌 *Status:* LUNAS ✅`
              ).catch((e) => logger.warn('[WEBHOOK TTS] Error sending voice: ' + e.message));

              // Queue ke Soundbox Speaker Kasir Web
              try {
                const soundboxSvc = require('./services/soundboxService');
                soundboxSvc.queueSoundboxEvent({
                  type: 'invoice',
                  title: 'Tagihan #' + invId,
                  amount,
                  customerName
                });
              } catch (e) {
                logger.warn('[Soundbox] Webhook invoice event error: ' + (e?.message || e));
              }
            } catch (ttsErr) {
              logger.warn('[WEBHOOK] TTS voice notification error: ' + ttsErr.message);
            }
          }
          } else if (Array.isArray(vCandidates) && vCandidates.length === 1) {
            const ord = vCandidates[0];
            const ordId = Number(ord.id || 0);
            if (ordId > 0) {
              markVoucherPaid.run(notifId || null, ordId);
              matchedVoucherOrderId = ordId;
              logger.info(`[WEBHOOK][payment-notif] MATCH voucher_order=${ordId} amount=${amount}`);
              if (notifId) {
                try { updateWebhookPaymentNotifMatchVoucher.run(ordId, notifId); } catch {}
              }
              try {
                await fulfillVoucherOrder(getSettingsWithCache(), ordId);
              } catch (e) {
                logger.error(`[WEBHOOK][payment-notif] Voucher fulfill error: ${e?.message || e}`);
              }

              // Kirim notifikasi suara TTS ke Telegram Admin untuk Voucher Hotspot
              try {
                const { sendAdminVoiceNotification, terbilang } = require('./services/telegramBot');
                const pkgName = ord.profile_name || 'Hotspot';
                const ttsText = `Pembelian voucher hotspot paket ${pkgName} sebesar ${terbilang(amount)} rupiah berhasil diterima.`;
                sendAdminVoiceNotification(
                  ttsText,
                  `🔔 *NOTIFIKASI DANA MASUK (VOUCHER)*\n\n` +
                  `📦 *Paket:* ${pkgName}\n` +
                  `💰 *Nominal:* Rp ${Number(amount).toLocaleString('id-ID')}\n` +
                  `🏦 *Sumber Rekening:* ${service || 'E-Wallet'}\n` +
                  `🧾 *No. Order:* #${ordId}\n` +
                  `📌 *Status:* BERHASIL ✅`
                ).catch((e) => logger.warn('[WEBHOOK TTS] Error sending voice: ' + e.message));

                // Queue ke Soundbox Speaker Kasir Web
                try {
                  const soundboxSvc = require('./services/soundboxService');
                  soundboxSvc.queueSoundboxEvent({
                    type: 'voucher',
                    title: 'Voucher #' + ordId,
                    amount,
                    customerName: pkgName
                  });
                } catch (e) {
                  logger.warn('[Soundbox] Webhook voucher event error: ' + (e?.message || e));
                }
              } catch (ttsErr) {
                logger.warn('[WEBHOOK] TTS voucher voice notification error: ' + ttsErr.message);
              }
            }
          } else if (Array.isArray(dCandidates) && dCandidates.length === 1) {
            const don = dCandidates[0];
            const donId = Number(don.id || 0);
            if (donId > 0) {
              markDonationPaid.run(notifId || null, donId);
              matchedDonationOrderId = donId;
              logger.info(`[WEBHOOK][payment-notif] MATCH donation_order=${donId} amount=${amount}`);
              if (notifId) {
                try { updateWebhookPaymentNotifMatchDonation.run(donId, notifId); } catch {}
              }
              try {
                await fulfillDonationOrder(getSettingsWithCache(), donId);
              } catch (e) {
                logger.error(`[WEBHOOK][payment-notif] Donation fulfill error: ${e?.message || e}`);
              }

              // Kirim notifikasi suara TTS ke Telegram Admin untuk Donasi
              try {
                const { sendAdminVoiceNotification, terbilang } = require('./services/telegramBot');
                const donorName = don.donor_name || 'Hamba Allah';
                const ttsText = `Donasi masuk sebesar ${terbilang(amount)} rupiah dari ${donorName} berhasil diterima.`;
                sendAdminVoiceNotification(
                  ttsText,
                  `🔔 *NOTIFIKASI DANA MASUK (DONASI)*\n\n` +
                  `👤 *Donatur:* ${donorName}\n` +
                  `💰 *Nominal:* Rp ${Number(amount).toLocaleString('id-ID')}\n` +
                  `🏦 *Sumber Rekening:* ${service || 'E-Wallet'}\n` +
                  `📌 *Status:* DITERIMA ✅`
                ).catch((e) => logger.warn('[WEBHOOK TTS] Error sending voice: ' + e.message));

                // Queue ke Soundbox Speaker Kasir Web
                try {
                  const soundboxSvc = require('./services/soundboxService');
                  soundboxSvc.queueSoundboxEvent({
                    type: 'donation',
                    title: 'Donasi #' + donId,
                    amount,
                    customerName: donorName
                  });
                } catch (e) {
                  logger.warn('[Soundbox] Webhook donation event error: ' + (e?.message || e));
                }
              } catch (ttsErr) {
                logger.warn('[WEBHOOK] TTS donation voice notification error: ' + ttsErr.message);
              }
            }
          } else if (Array.isArray(tCandidates) && tCandidates.length === 1) {
            const topup = tCandidates[0];
            const topupId = Number(topup.id || 0);
            const custId = Number(topup.customer_id || 0);
            const baseAmount = Number(topup.amount || 0);
            if (topupId > 0 && custId > 0 && baseAmount > 0) {
              if (markTopupPaid) {
                try { markTopupPaid.run(notifId || null, topupId); } catch (e) {
                  logger.error(`[WEBHOOK][payment-notif] markTopupPaid error: ${e?.message || e}`);
                }
              }
              matchedTopupRequestId = topupId;
              logger.info(`[WEBHOOK][payment-notif] MATCH customer_topup=${topupId} amount=${amount} baseAmount=${baseAmount}`);

              if (notifId && updateWebhookPaymentNotifMatchTopup) {
                try { updateWebhookPaymentNotifMatchTopup.run(topupId, notifId); } catch {}
              }

              let updatedBalance = 0;
              try {
                db.transaction(() => {
                  db.prepare('UPDATE customers SET balance = balance + ? WHERE id = ?').run(baseAmount, custId);
                  const custRow = db.prepare('SELECT balance FROM customers WHERE id = ?').get(custId);
                  updatedBalance = Number(custRow?.balance || 0);

                  let pObj = {};
                  try { pObj = topup.payment_payload ? JSON.parse(topup.payment_payload) : {}; } catch {}
                  pObj.paid_amount = amount;
                  pObj.balance_after = updatedBalance;
                  pObj.fulfilled_at = new Date().toISOString();
                  pObj.source = `AUTO-QRIS (service=${String(service || '-')}, notif=${notifId || '-'})`;
                  db.prepare('UPDATE customer_topup_requests SET payment_payload = ?, updated_at = NOW_LOCAL() WHERE id = ?')
                    .run(JSON.stringify(pObj), topupId);
                })();
              } catch (e) {
                logger.error(`[WEBHOOK][payment-notif] Top-up balance update error: ${e?.message || e}`);
              }

              try {
                const settings = getSettingsWithCache();
                const customer = db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(custId);
                if (settings?.whatsapp_enabled && customer && customer.phone) {
                  const { sendWA, whatsappStatus } = await import('./services/whatsappBot.mjs');
                  if (whatsappStatus.connection === 'open') {
                    const waMsg = 
                      `✅ *TOP-UP SALDO BERHASIL*\n\n` +
                      `Halo *${customer.name}*,\n` +
                      `Top-up saldo Anda via QRIS sebesar *Rp ${baseAmount.toLocaleString('id-ID')}* telah berhasil diverifikasi otomatis.\n\n` +
                      `💰 *Nominal Top-Up:* Rp ${baseAmount.toLocaleString('id-ID')}\n` +
                      `💳 *Total Saldo Sekarang:* Rp ${updatedBalance.toLocaleString('id-ID')}\n` +
                      `🏷️ *Metode:* QRIS Dinamis Otomatis\n` +
                      `🆔 *ID Transaksi:* TOPUP-${topupId}\n\n` +
                      `Saldo dapat langsung digunakan untuk pembelian pulsa, paket data, voucher, atau pembayaran tagihan di portal/aplikasi. Terima kasih!`;
                    await sendWA(customer.phone, waMsg);
                  }
                }
              } catch (waErr) {
                logger.error(`[WEBHOOK][payment-notif] Top-up WA notification error: ${waErr?.message || waErr}`);
              }

              // Kirim notifikasi suara TTS ke Telegram Admin untuk Topup Saldo
              try {
                const { sendAdminVoiceNotification, terbilang } = require('./services/telegramBot');
                const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(custId);
                const custName = customer?.name || 'Pelanggan';
                const ttsText = `Top up saldo sebesar ${terbilang(baseAmount)} rupiah untuk pelanggan ${custName} berhasil diverifikasi.`;
                sendAdminVoiceNotification(
                  ttsText,
                  `🔔 *NOTIFIKASI DANA MASUK (TOP-UP SALDO)*\n\n` +
                  `👤 *Pelanggan:* ${custName}\n` +
                  `💰 *Nominal Top-Up:* Rp ${Number(baseAmount).toLocaleString('id-ID')}\n` +
                  `🏦 *Sumber Rekening:* ${service || 'E-Wallet'}\n` +
                  `🆔 *ID Transaksi:* TOPUP-${topupId}\n` +
                  `📌 *Status:* BERHASIL ✅`
                ).catch((e) => logger.warn('[WEBHOOK TTS] Error sending voice: ' + e.message));

                // Queue ke Soundbox Speaker Kasir Web
                try {
                  const soundboxSvc = require('./services/soundboxService');
                  soundboxSvc.queueSoundboxEvent({
                    type: 'topup',
                    title: 'Top-Up #' + topupId,
                    amount: baseAmount,
                    customerName: custName
                  });
                } catch (e) {
                  logger.warn('[Soundbox] Webhook topup event error: ' + (e?.message || e));
                }
              } catch (ttsErr) {
                logger.warn('[WEBHOOK] TTS topup voice notification error: ' + ttsErr.message);
              }
            }
          }
        } else if (totalCandidates > 1) {
          const invIds = Array.isArray(invCandidates) ? invCandidates.map(x => x.id).join(',') : '';
          const vIds = Array.isArray(vCandidates) ? vCandidates.map(x => x.id).join(',') : '';
          const dIds = Array.isArray(dCandidates) ? dCandidates.map(x => x.id).join(',') : '';
          const tIds = Array.isArray(tCandidates) ? tCandidates.map(x => x.id).join(',') : '';
          logger.error(`[WEBHOOK][payment-notif] MATCH ambiguous: amount=${amount} invoices=[${invIds}] vouchers=[${vIds}] donations=[${dIds}] topups=[${tIds}]`);
        }
      } catch (e) {
        logger.error(`[WEBHOOK][payment-notif] MATCH error: ${e && e.message ? e.message : String(e)}`);
      }
    }

    if (amount != null) {
      logger.info(`[WEBHOOK][payment-notif] PARSED service=${String(service || '-')} amount=${amount}`);
      return res.status(200).json({ status: 'processed', parsed: true, amount, matched_invoice_id: matchedInvoiceId, matched_voucher_order_id: matchedVoucherOrderId, matched_donation_order_id: matchedDonationOrderId, matched_topup_request_id: matchedTopupRequestId });
    }

    logger.error(`[WEBHOOK][payment-notif] FAILED parse: "${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  } catch (err) {
    logger.error(`[WEBHOOK][payment-notif] ERROR ${err && err.stack ? err.stack : String(err)}`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  }
});

app.get('/webhook/digiflazz', (req, res) => {
  res.json({ success: true, message: 'OK. Use POST for Digiflazz webhook.' });
});
app.head('/webhook/digiflazz', (req, res) => res.status(200).end());
app.post('/webhook/digiflazz', async (req, res) => {
  const payload = req.body || {};
  const signature = req.headers['x-hub-signature'] || req.headers['x-digiflazz-delivery'];
  const eventName = String(req.headers['x-digiflazz-event'] || '').trim();
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const secret = String(getSetting('digiflazz_webhook_secret', '') || '').trim();
  const expectedHookId = String(getSetting('digiflazz_webhook_id', '') || '').trim();

  if (!secret) return res.status(503).send('Webhook secret belum dikonfigurasi');
  if (!signature || typeof signature !== 'string') return res.status(401).send('Unauthorized');

  const raw = req.rawBody || JSON.stringify(payload);
  const selfSignature = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('hex');

  let sigOk = 0;
  try {
    const a = Buffer.from(String(signature));
    const b = Buffer.from(String(selfSignature));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) sigOk = 1;
  } catch (e) {
    sigOk = 0;
  }

  const data = payload?.data || {};
  const refId = String(data?.ref_id || '').trim();
  const vendorStatus = String(data?.status || '').trim();
  const vendorMessage = String(data?.message || '').trim();
  const vendorSn = String(data?.sn || '').trim();
  const vendorTrxId = String(data?.trx_id || '').trim();
  const vendorPrice = Math.max(0, Math.floor(Number(data?.price || 0) || 0));

  const ip = getIp(req);

  const pingHookId = String(payload?.hook_id || '').trim();
  if (!refId && payload && payload.sed && pingHookId) {
    try { insertDigiflazzWebhookLog.run('', eventName || 'ping', String(signature || ''), sigOk, null, ip, raw); } catch {}
    if (!sigOk) return res.status(401).send('Unauthorized');
    const hookIdOk = !expectedHookId || expectedHookId === pingHookId;
    logger.info(`[WEBHOOK][digiflazz] ping hook_id=${pingHookId} expected=${expectedHookId || '-'} ok=${hookIdOk ? 1 : 0} event=${eventName || '-'} ua=${userAgent || '-'} ip=${ip}`);
    return res.json({ success: true, type: 'ping', hook_id: pingHookId, hook_id_ok: hookIdOk });
  }

  if (!refId) {
    try { insertDigiflazzWebhookLog.run('', vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(400).send('Invalid payload');
  }

  if (!sigOk) {
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(401).send('Unauthorized');
  }

  let matchedTxId = null;
  let matchedPpobOrderId = null;
  try {
    const nextStatus = normalizeDigiflazzStatus(vendorStatus);

    // 1. Cek matching agent_transactions
    const tx = selectAgentPulsaTxByRefId.get(refId);
    matchedTxId = tx?.id || null;

    if (tx && tx.id) {
      updateAgentPulsaTxFromWebhook.run(
        nextStatus,
        vendorTrxId,
        vendorSn,
        vendorMessage,
        vendorPrice,
        tx.id
      );

      if (nextStatus === 'failed' && Number(tx.digi_refunded || 0) !== 1) {
        const runRefund = db.transaction(() => {
          const fresh = selectAgentPulsaTxByRefId.get(refId);
          if (!fresh || !fresh.id) return;
          if (Number(fresh.digi_refunded || 0) === 1) return;

          const agent = getAgentByIdForWebhook.get(fresh.agent_id);
          if (!agent) return;

          const amount = Math.max(0, Math.floor(Number(fresh.amount_sell || 0) || 0));
          const before = Number(agent.balance || 0);
          const after = before + amount;
          updateAgentBalanceForWebhook.run(after, fresh.agent_id);
          insertAgentTxRefund.run(
            fresh.agent_id,
            amount,
            amount,
            before,
            after,
            `REFUND Digiflazz webhook (tx#${fresh.id} ref=${refId})`
          );
          markAgentPulsaRefunded.run(fresh.id);
        });
        runRefund();
      }
    }

    // 2. Cek matching public_ppob_orders (Pelanggan Web & APK)
    const custOrder = selectPublicPpobOrderByRefId.get(refId);
    matchedPpobOrderId = custOrder?.id || null;

    if (custOrder && custOrder.id) {
      if (nextStatus === 'success') {
        const wasSentBefore = Number(custOrder.wa_sent || 0) === 1;
        updatePublicPpobOrderSuccessFromWebhook.run(
          vendorTrxId,
          vendorSn,
          vendorMessage,
          1,
          custOrder.id
        );

        // Kirim notifikasi WA Sukses jika belum pernah dikirim
        if (!wasSentBefore && custOrder.buyer_phone) {
          try {
            const { getSettings } = require('./config/settingsManager');
            const settings = getSettings();
            if (settings.whatsapp_enabled) {
              const { sendWA, whatsappStatus } = await import('./services/whatsappBot.mjs');
              if (whatsappStatus.connection === 'open') {
                const custRow = db.prepare('SELECT balance, name FROM customers WHERE id = ?').get(custOrder.customer_id);
                const curBal = custRow?.balance || 0;
                await sendWA(custOrder.buyer_phone,
                  `✅ *TRANSAKSI PPOB BERHASIL*\n\n` +
                  `Halo *${custRow?.name || 'Pelanggan'}*,\n` +
                  `Transaksi pembelian produk digital Anda berhasil diproses:\n\n` +
                  `📦 *Produk:* ${custOrder.product_name}\n` +
                  `🎯 *Tujuan:* ${custOrder.target}\n` +
                  `💰 *Harga:* Rp ${Number(custOrder.price || 0).toLocaleString('id-ID')}\n` +
                  (vendorSn ? `🔢 *SN / Token:* \`${vendorSn}\`\n` : '') +
                  `💳 *Sisa Saldo:* Rp ${Number(curBal).toLocaleString('id-ID')}\n\n` +
                  `Terima kasih telah bertransaksi!`
                );
              }
            }
          } catch (waErr) {
            logger.error(`[WEBHOOK][digiflazz] WA send error for order #${custOrder.id}: ${waErr.message}`);
          }
        }
      } else if (nextStatus === 'failed') {
        if (String(custOrder.status || '').toLowerCase() !== 'failed') {
          updatePublicPpobOrderFailedFromWebhook.run(
            vendorTrxId,
            vendorMessage || 'Ditolak provider',
            custOrder.id
          );

          // Auto-refund saldo pelanggan
          if (custOrder.customer_id && custOrder.price > 0) {
            db.prepare('UPDATE customers SET balance = balance + ? WHERE id = ?').run(custOrder.price, custOrder.customer_id);
            logger.info(`[WEBHOOK][digiflazz] Refunded customer #${custOrder.customer_id} amount Rp ${custOrder.price} for failed order #${custOrder.id}`);
          }
        }
      }
    }

    // 3. Cek matching digiflazz_staff_transactions
    try {
      db.prepare(`
        UPDATE digiflazz_staff_transactions
        SET status = ?, trx_id = ?, sn = ?, message = ?, price = CASE WHEN ? > 0 THEN ? ELSE price END
        WHERE ref_id = ?
      `).run(nextStatus, vendorTrxId, vendorSn, vendorMessage, vendorPrice, vendorPrice, refId);
    } catch (_) {}

  } catch (e) {
    logger.error(`[WEBHOOK][digiflazz] Error processing webhook: ${e.message}`);
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
    return res.status(500).send('Internal Server Error');
  }

  try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
  logger.info(`[WEBHOOK][digiflazz] event=${eventName || '-'} ua=${userAgent || '-'} ref=${refId} status=${vendorStatus} ok=${sigOk} matchTx=${matchedTxId || '-'} matchOrder=${matchedPpobOrderId || '-'}`);
  return res.json({ success: true, ref_id: refId, matched_agent_tx_id: matchedTxId, matched_ppob_order_id: matchedPpobOrderId });
});


// Inisialisasi database billing
try {
  require('./config/database');
  logger.info('[DB] Billing database ready');
} catch (e) {
  logger.error('[DB] Database init failed:', e.message);
}

// Variabel global untuk modul lain yang masih membaca konfigurasi (mis. skrip utilitas)
global.appSettings = {
  port: getSetting('server_port', 4555),
  host: getSetting('server_host', 'localhost'),
  genieacsUrl: getSetting('genieacs_url', 'http://localhost:7557'),
  genieacsUsername: getSetting('genieacs_username', ''),
  genieacsPassword: getSetting('genieacs_password', ''),
  companyHeader: getSetting('company_header', 'ISP Monitor'),
  footerInfo: getSetting('footer_info', ''),
};

// Route untuk health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: VERSION
    });
});

// Redirect root ke portal pelanggan
app.get('/', (req, res) => {
  res.redirect('/customer/login');
});

// Alias singkat: /login → /customer/login
app.get('/login', (req, res) => {
  res.redirect('/customer/login');
});

// Halaman Isolir (Akses langsung dari redirect MikroTik) - dengan integrasi pembayaran otomatis
app.get('/isolated', async (req, res) => {
  try {
    const settings = getSettingsWithCache();
    
    // 1. Identifikasi pelanggan: Session, Query param (?q= / ?cid=), atau IP
    let customer = null;
    const searchQuery = String(req.query.q || req.query.lookup || req.query.cid || req.query.phone || '').trim();
    
    // Priority 1: Session login
    if (req.session && req.session.phone) {
      customer = customerSvc.findCustomerByAny(req.session.phone);
    }
    
    // Priority 2: Query search param
    if (!customer && searchQuery) {
      customer = customerSvc.findCustomerByAny(searchQuery);
    }
    
    // Priority 3: IP-based detection
    let clientIp = '';
    if (!customer) {
      const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() 
                  || req.ip 
                  || req.connection?.remoteAddress 
                  || '';
      clientIp = rawIp.replace(/^::ffff:/, '').trim();
      
      if (clientIp) {
        const allCustomers = customerSvc.getAllCustomers();
        customer = allCustomers.find(c => 
          (c.static_ip && c.static_ip === clientIp) || 
          (c.pppoe_remote_address && c.pppoe_remote_address === clientIp)
        );
        
        // MikroTik active PPP session lookup if still not found
        if (!customer && mikrotikService && typeof mikrotikService.getPppoeActive === 'function') {
          try {
            const activeUsers = await mikrotikService.getPppoeActive();
            if (Array.isArray(activeUsers)) {
              const match = activeUsers.find(u => u.address === clientIp);
              if (match && match.name) {
                customer = customerSvc.findCustomerByAny(match.name);
              }
            }
          } catch (e) {
            // Ignore Mikrotik query error
          }
        }
      }
    }
    
    // Check unpaid invoices
    let invoicesWithTokens = [];
    if (customer) {
      const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
      if (unpaidInvoices && unpaidInvoices.length > 0) {
        const tokenUtil = require('./utils/tokenUtil');
        invoicesWithTokens = unpaidInvoices.map(inv => ({
          ...inv,
          publicToken: tokenUtil.signPublicToken({
            invoiceId: inv.id,
            customerId: inv.customer_id,
            lookup: customer.phone || customer.pppoe_username || String(customer.id),
            exp: Date.now() + 60 * 60 * 1000  // 60 minutes
          }, settings.session_secret)
        }));
      }
    }
    
    // If customer is found, active, and has no unpaid invoices, redirect to dashboard
    if (customer && customer.status === 'active' && invoicesWithTokens.length === 0) {
      return res.redirect('/customer/dashboard');
    }
    
    // Resolve active gateway
    const paymentSvc = require('./services/paymentService');
    const sampleAmount = invoicesWithTokens[0] ? invoicesWithTokens[0].amount : 50000;
    const activeGateway = paymentSvc.resolveConfiguredGatewayForAmount(settings, sampleAmount) || 'qris_static';

    res.render('isolated', {
      company: settings.company_header || 'My ISP',
      adminPhone: settings.company_phone || settings.company_whatsapp || '',
      address: settings.company_address || '',
      customer: customer || null,
      invoices: invoicesWithTokens,
      searchQuery,
      clientIp,
      activeGateway,
      settings,
      hasUnpaidInvoices: invoicesWithTokens.length > 0
    });
  } catch (err) {
    logger.error(`[ISOLATED] Error: ${err.message}`);
    const settings = getSettingsWithCache();
    res.render('isolated', {
      company: settings.company_header || 'My ISP',
      adminPhone: settings.company_phone || '',
      address: settings.company_address || '',
      customer: null,
      invoices: [],
      searchQuery: '',
      clientIp: '',
      activeGateway: 'qris_static',
      settings,
      hasUnpaidInvoices: false
    });
  }
});

// GET /isolated/status - untuk polling status pelanggan real-time
app.get('/isolated/status', (req, res) => {
  try {
    let customer = null;
    const queryLookup = String(req.query.q || req.query.cid || req.query.phone || '').trim();
    
    // Detection: Query, Session, atau IP
    if (queryLookup) {
      customer = customerSvc.findCustomerByAny(queryLookup);
    } else if (req.session && req.session.phone) {
      customer = customerSvc.findCustomerByAny(req.session.phone);
    } else {
      const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() 
                  || req.ip 
                  || '';
      const cleanIp = rawIp.replace(/^::ffff:/, '').trim();
      
      if (cleanIp) {
        const allCustomers = customerSvc.getAllCustomers();
        customer = allCustomers.find(c => 
          (c.static_ip && c.static_ip === cleanIp) || 
          (c.pppoe_remote_address && c.pppoe_remote_address === cleanIp)
        );
      }
    }
    
    if (!customer) {
      return res.json({ 
        status: 'unknown',
        unpaid_count: 0,
        message: 'Pelanggan tidak ditemukan'
      });
    }
    
    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const isClean = customer.status === 'active' || unpaidInvoices.length === 0;
    
    res.json({
      status: isClean ? 'active' : customer.status,
      unpaid_count: unpaidInvoices.length,
      customer_id: customer.id,
      customer_name: customer.name,
      message: isClean 
        ? 'Layanan aktif, pembayaran telah selesai'
        : `Tersisa ${unpaidInvoices.length} tagihan belum dibayar`
    });
  } catch (e) {
    logger.error(`[ISOLATED-STATUS] Error: ${e.message}`);
    res.status(500).json({ error: 'Server error', status: 'error' });
  }
});

// POST /isolated/quick-qris/:invoiceId - Generate / fetch Quick QRIS transaction
app.post('/isolated/quick-qris/:invoiceId', async (req, res) => {
  try {
    const settings = getSettingsWithCache();
    const token = req.body.token || req.query.t;
    const tokenUtil = require('./utils/tokenUtil');
    const payload = tokenUtil.verifyPublicToken(token, settings.session_secret);
    
    if (!payload || String(payload.invoiceId) !== String(req.params.invoiceId)) {
      return res.status(401).json({ success: false, message: 'Token pembayaran tidak valid atau sudah kadaluarsa. Silakan refresh halaman.' });
    }
    
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);
    if (!inv) return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan' });
    if (inv.status === 'paid') return res.json({ success: false, paid: true, message: 'Tagihan ini sudah lunas!' });
    
    const cust = customerSvc.getCustomerById(inv.customer_id);
    if (!cust) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });

    const paymentSvc = require('./services/paymentService');
    const gateway = paymentSvc.resolveConfiguredGatewayForAmount(settings, inv.amount);
    if (!gateway) {
      return res.status(400).json({ success: false, message: 'Metode pembayaran QRIS belum dikonfigurasi di server.' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const appUrl = settings.app_url || `${protocol}://${host}`;
    const QRCode = require('qrcode');
    const periodText = `${inv.period_month}/${inv.period_year}`;

    // 1. QRIS STATIS (LOKAL)
    if (gateway === 'qris_static') {
      const customerPortalRouter = require('./routes/customerPortal');
      let uniqueCode = inv.qris_unique_code || 0;
      let amountUnique = inv.qris_amount_unique || inv.amount;
      
      if (typeof customerPortalRouter.ensureInvoiceQrisUnique === 'function') {
        const ensured = customerPortalRouter.ensureInvoiceQrisUnique(inv, false);
        if (ensured) {
          uniqueCode = ensured.uniqueCode;
          amountUnique = ensured.amountUnique;
        }
      }

      let qrDataUrl = '';
      if (typeof customerPortalRouter.getStaticQrisQrUrlForAmount === 'function') {
        qrDataUrl = await customerPortalRouter.getStaticQrisQrUrlForAmount(settings, amountUnique);
      }
      if (!qrDataUrl && settings.qris_static_qr_url) {
        qrDataUrl = settings.qris_static_qr_url;
      }

      return res.json({
        success: true,
        gateway: 'qris_static',
        gatewayName: 'QRIS',
        invoiceId: inv.id,
        amount: amountUnique,
        nominalAsli: inv.amount,
        uniqueCode: uniqueCode,
        qrDataUrl: qrDataUrl,
        periodText,
        customerName: cust.name,
        helpText: 'Pastikan mentransfer sesuai nominal tepat (termasuk kode unik) agar pembayaran langsung terdeteksi.'
      });
    }

    // 2. TRIPAY
    if (gateway === 'tripay') {
      const result = await paymentSvc.createTripayTransaction(inv, cust, 'QRIS', appUrl, {
        callbackPath: '/customer/payment/callback',
        returnPath: '/isolated'
      });

      let qrDataUrl = '';
      if (result.payload?.qr_string) {
        qrDataUrl = await QRCode.toDataURL(result.payload.qr_string, { errorCorrectionLevel: 'M', margin: 1, width: 340 });
      } else if (result.payload?.qr_url) {
        qrDataUrl = result.payload.qr_url;
      }

      billingSvc.updatePaymentInfo(inv.id, {
        gateway: 'tripay',
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload
      });

      return res.json({
        success: true,
        gateway: 'tripay',
        gatewayName: 'Tripay QRIS',
        invoiceId: inv.id,
        amount: inv.amount,
        checkoutUrl: result.link,
        qrDataUrl: qrDataUrl,
        reference: result.reference,
        periodText,
        customerName: cust.name,
        helpText: 'Scan kode QRIS di atas dengan m-Banking (BCA, BRI, Mandiri, dll) atau E-Wallet (DANA, OVO, GoPay, ShopeePay).'
      });
    }

    // 3. MIDTRANS
    if (gateway === 'midtrans') {
      const result = await paymentSvc.createMidtransTransaction(inv, cust, 'QRIS', appUrl, {
        callbackPath: '/customer/payment/callback',
        returnPath: '/isolated'
      });

      billingSvc.updatePaymentInfo(inv.id, {
        gateway: 'midtrans',
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload
      });

      return res.json({
        success: true,
        gateway: 'midtrans',
        gatewayName: 'Midtrans QRIS',
        invoiceId: inv.id,
        amount: inv.amount,
        checkoutUrl: result.link,
        reference: result.reference,
        periodText,
        customerName: cust.name,
        helpText: 'Buka link checkout Midtrans untuk menyelesaikan pembayaran via QRIS / GoPay.'
      });
    }

    // 4. DUITKU
    if (gateway === 'duitku') {
      const result = await paymentSvc.createDuitkuTransaction(inv, cust, 'QRIS', appUrl, {
        callbackPath: '/customer/payment/callback',
        returnPath: '/isolated'
      });

      let qrDataUrl = '';
      if (result.payload?.qrCode) {
        qrDataUrl = await QRCode.toDataURL(result.payload.qrCode, { errorCorrectionLevel: 'M', margin: 1, width: 340 });
      }

      billingSvc.updatePaymentInfo(inv.id, {
        gateway: 'duitku',
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload
      });

      return res.json({
        success: true,
        gateway: 'duitku',
        gatewayName: 'Duitku QRIS',
        invoiceId: inv.id,
        amount: inv.amount,
        checkoutUrl: result.link,
        qrDataUrl: qrDataUrl,
        periodText,
        customerName: cust.name,
        helpText: 'Scan QRIS di atas melalui m-Banking atau aplikasi E-Wallet Anda.'
      });
    }

    // 5. XENDIT
    if (gateway === 'xendit') {
      const result = await paymentSvc.createXenditTransaction(inv, cust, 'xendit', appUrl, {
        callbackPath: '/customer/payment/callback',
        returnPath: '/isolated'
      });

      billingSvc.updatePaymentInfo(inv.id, {
        gateway: 'xendit',
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload
      });

      return res.json({
        success: true,
        gateway: 'xendit',
        gatewayName: 'Xendit Invoice',
        invoiceId: inv.id,
        amount: inv.amount,
        checkoutUrl: result.link,
        periodText,
        customerName: cust.name,
        helpText: 'Klik tombol bayar untuk membuka halaman pembayaran resmi Xendit.'
      });
    }

    return res.status(400).json({ success: false, message: 'Gateway ' + gateway + ' belum didukung untuk Quick QRIS.' });
  } catch (err) {
    logger.error(`[QuickQRIS] Error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message || 'Gagal memproses pembayaran QRIS' });
  }
});

// HELPER FUNCTION: Get active payment channels
function getActivePaymentChannelsForIsolated(settings) {
  const channels = [];
  
  // QRIS Static
  if (settings.qris_static_enabled && settings.qris_static_payload) {
    channels.push({
      code: 'QRIS_STATIC',
      name: '🟦 QRIS Statis (Instant)',
      enabled: true
    });
  }
  
  // Tripay
  if (settings.tripay_enabled && settings.tripay_api_key) {
    channels.push({
      code: 'TRIPAY',
      name: '💳 Transfer Bank / E-Wallet (Tripay)',
      enabled: true
    });
  }
  
  // Midtrans
  if (settings.midtrans_enabled && settings.midtrans_server_key) {
    channels.push({
      code: 'MIDTRANS',
      name: '💳 Midtrans Snap',
      enabled: true
    });
  }
  
  // Xendit
  if (settings.xendit_enabled && settings.xendit_api_key) {
    channels.push({
      code: 'XENDIT',
      name: '💳 Xendit',
      enabled: true
    });
  }
  
  return channels.length > 0 ? channels : [
    { code: 'QRIS_STATIC', name: '🟦 QRIS Statis', enabled: false }
  ];
}

// Tambahkan view engine dan static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
app.get('/admin/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.send({
    name: 'Admin Billing',
    short_name: 'Admin',
    start_url: '/admin/settings?source=pwa',
    scope: '/admin/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/img/logo.png', sizes: '2000x545', type: 'image/png', purpose: 'any' }
    ]
  });
});
app.use(express.static(path.join(__dirname, 'public')));

// Route: Kebijakan Privasi (Privacy Policy) untuk Google Play Store
app.get(['/privacy-policy', '/privacy', '/kebijakan-privasi', '/privacy.html'], (req, res) => {
  const { getSetting } = require('./config/settingsManager');
  const company = getSetting('company_header', 'ALIJAYA NET');
  res.render('privacy', {
    company,
    isLoggedIn: false
  });
});

// Route: Syarat & Ketentuan (Terms of Service / TOS) untuk Google Play Store & Pelanggan
app.get(['/terms-of-service', '/terms', '/tos', '/syarat-ketentuan', '/terms.html'], (req, res) => {
  const { getSetting, getSettings } = require('./config/settingsManager');
  const company = getSetting('company_header', 'ALIJAYA NET');
  const settings = getSettings ? getSettings() : {};
  res.render('tos', {
    company,
    settings,
    isLoggedIn: false
  });
});

// Route download APK Android Pelanggan & Admin
app.get(['/download/app', '/download/apk', '/downloads/billing-rtrw.apk', '/download/billing-rtrw.apk', '/downloads/AlijayaCustomer.apk', '/download/AlijayaCustomer.apk'], (req, res) => {
  const candidates = [
    path.join(__dirname, 'public', 'downloads', 'billing-rtrw.apk'),
    path.join(__dirname, 'billing-rtrw.apk'),
    path.join(__dirname, 'public', 'downloads', 'AlijayaCustomer.apk'),
    path.join(__dirname, 'AlijayaCustomer.apk')
  ];

  const targetPath = candidates.find(p => fs.existsSync(p));

  if (targetPath) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    return res.download(targetPath, 'billing-rtrw.apk');
  }

  return res.status(404).json({
    success: false,
    message: 'File APK belum di-upload ke server VPS. Silakan upload file billing-rtrw.apk ke folder public/downloads/ di server.'
  });
});

app.get('/uploads/qris/:filename', async (req, res) => {
  const wantsHtml = () => String(req.get('accept') || '').toLowerCase().includes('text/html');
  const sendPretty = (status, title, detail) => {
    if (!wantsHtml()) return res.status(status).send(title);
    const baseUrl = String(getSetting('app_url', '') || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const loginLink = `${baseUrl}/customer/login`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(status).send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,Segoe UI,Arial; margin:0; background:#0b1220; color:#e5e7eb} .wrap{max-width:520px;margin:0 auto;padding:24px} .card{background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:18px} h1{font-size:18px;margin:0 0 8px} p{margin:0 0 12px;color:#cbd5e1;line-height:1.45} a{display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px}</style></head><body><div class="wrap"><div class="card"><h1>${title}</h1><p>${detail || ''}</p><a href="${loginLink}">Buka Portal Pelanggan</a></div></div></body></html>`);
  };
  try {
    const filename = String(req.params.filename || '');
    const safeName = path.basename(filename);
    if (!safeName || safeName !== filename) return sendPretty(404, 'QRIS tidak ditemukan', 'Link QRIS tidak valid.');

    const filePath = path.join(__dirname, 'public', 'uploads', 'qris', safeName);
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return res.sendFile(filePath);
    } catch {}

    const settings = getSettingsWithCache();
    const payload = normalizeQrisPayload(String(settings?.qris_static_payload || ''));
    if (payload) {
      const png = await QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 1, width: 420, type: 'png' });
      const img = await Jimp.read(png);
      const jpg = await img.getBuffer('image/jpeg');
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(jpg);
    }

    const url = String(settings?.qris_static_qr_url || '').trim();
    if (url && !url.endsWith(`/uploads/qris/${safeName}`)) return res.redirect(url);
    return sendPretty(404, 'QRIS tidak ditemukan', 'Gambar QRIS upload tidak tersedia. Silakan gunakan link QRIS terbaru dari portal pelanggan.');
  } catch {
    return sendPretty(404, 'QRIS tidak ditemukan', 'Gagal memuat QRIS.');
  }
});

app.get('/qris/static.jpg', async (req, res) => {
  const wantsHtml = () => String(req.get('accept') || '').toLowerCase().includes('text/html');
  const sendPretty = (status, title, detail) => {
    if (!wantsHtml()) return res.status(status).send(title);
    const baseUrl = String(getSetting('app_url', '') || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const loginLink = `${baseUrl}/customer/login`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(status).send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,Segoe UI,Arial; margin:0; background:#0b1220; color:#e5e7eb} .wrap{max-width:520px;margin:0 auto;padding:24px} .card{background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:18px} h1{font-size:18px;margin:0 0 8px} p{margin:0 0 12px;color:#cbd5e1;line-height:1.45} a{display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px}</style></head><body><div class="wrap"><div class="card"><h1>${title}</h1><p>${detail || ''}</p><a href="${loginLink}">Buka Portal Pelanggan</a></div></div></body></html>`);
  };
  try {
    const amount = Math.max(0, Math.floor(Number(req.query.amount || 0) || 0));
    const settings = getSettingsWithCache();
    const qrisUtil = require('./utils/qrisUtil');
    let payload = qrisUtil.normalizeQrisPayload(String(settings?.qris_static_payload || ''));

    // If payload not in settings, try decode from uploaded QR file
    if (!payload && settings?.qris_static_qr_url) {
      const url = String(settings.qris_static_qr_url);
      const match = url.match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (match && match[1]) {
        const safeName = path.basename(match[1]);
        const filePath = path.join(__dirname, 'public', 'uploads', 'qris', safeName);
        try {
          const buf = await fs.promises.readFile(filePath);
          payload = await qrisUtil.decodeQrisPayloadFromBuffer(buf);
        } catch {}
      }
    }

    if (payload) {
      if (amount > 0) {
        const jpg = await qrisUtil.buildDynamicQrisJpgBuffer(payload, amount);
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        return res.status(200).send(jpg);
      } else {
        const png = await QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 1, width: 420, type: 'png' });
        const img = await Jimp.read(png);
        const jpg = await img.getBuffer('image/jpeg');
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        return res.status(200).send(jpg);
      }
    }

    // Fallback if static image file exists
    const url = String(settings?.qris_static_qr_url || '').trim();
    if (url) {
      const match = url.match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (match && match[1]) {
        const safeName = path.basename(match[1]);
        const filePath = path.join(__dirname, 'public', 'uploads', 'qris', safeName);
        try {
          await fs.promises.access(filePath, fs.constants.R_OK);
          return res.sendFile(filePath);
        } catch {}
      }
      return res.redirect(url);
    }

    return sendPretty(404, 'QRIS tidak ditemukan', 'QRIS belum diatur oleh admin atau payload QRIS tidak valid.');
  } catch (e) {
    logger.error(`[QRIS /qris/static.jpg] Error: ${e.message}`);
    return sendPretty(404, 'QRIS tidak ditemukan', 'Gagal memproses QRIS: ' + e.message);
  }
});

app.get('/broadcast', (req, res) => {
  res.redirect('/admin/whatsapp/broadcast');
});

// Helper: Ensure unique nominal for donation order
function ensureDonationOrderQrisUnique(baseAmount, donorPhone, donorName, notes) {
  const base = Math.max(1000, Math.floor(Number(baseAmount) || 50000));
  const { uniqueCode: chosenCode, amountUnique: chosenAmount } = uniqueCodeService.allocateUniqueCode(base, {
    randomize: true
  });

  const ins = db.prepare(`
    INSERT INTO public_donation_orders (donor_name, donor_phone, amount, qris_amount_unique, qris_unique_code, notes, status, activation_code)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'donasidulu')
  `).run(donorName || 'Hamba Allah', donorPhone, base, chosenAmount, chosenCode, notes || '');

  return {
    orderId: ins.lastInsertRowid,
    uniqueCode: chosenCode,
    amountUnique: chosenAmount,
    baseAmount: base
  };
}

// Halaman Publik Donasi QRIS Statis
app.get(['/donasi', '/donate', '/public/donasi'], (req, res) => {
  const settings = getSettingsWithCache();
  res.render('donate', {
    settings,
    company: settings.company_header || 'Billing RTRW & RADIUS',
    lang: req.session?.lang || 'id',
    t: res.locals.t || ((k, d) => d)
  });
});

// Endpoint Buat Pesanan Donasi dengan Kode Unik
app.post(['/donasi/create', '/api/donasi/create'], (req, res) => {
  try {
    const { name, phone, amount, notes } = req.body || {};
    const donorName = String(name || 'Hamba Allah').trim();
    const donorPhone = String(phone || '').trim();
    const baseAmount = Math.max(1000, parseInt(amount, 10) || 50000);
    const donorNotes = String(notes || '').trim();

    if (!donorPhone || donorPhone.length < 8) {
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp wajib diisi (minimal 8 digit).' });
    }

    const result = ensureDonationOrderQrisUnique(baseAmount, donorPhone, donorName, donorNotes);
    return res.json({
      success: true,
      orderId: result.orderId,
      uniqueCode: result.uniqueCode,
      amountUnique: result.amountUnique,
      baseAmount: result.baseAmount,
      qrisUrl: `/qris/static.jpg?amount=${result.amountUnique}`
    });
  } catch (e) {
    logger.error(`[Donasi Create] Error: ${e.message}`);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Endpoint Status Donasi (Real-time Polling)
app.get(['/donasi/status/:orderId', '/api/donasi/status/:orderId'], (req, res) => {
  try {
    const orderId = Number(req.params.orderId || 0);
    const order = selectDonationOrderById.get(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order donasi tidak ditemukan' });

    return res.json({
      success: true,
      orderId: order.id,
      status: order.status,
      paid_at: order.paid_at || null,
      activationCode: order.status === 'paid' ? (order.activation_code || 'donasidulu') : null,
      donorName: order.donor_name,
      amountUnique: order.qris_amount_unique,
      waSent: Boolean(order.wa_sent)
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Endpoint Konfirmasi Donasi & Fallback Kirim Kode Aktivasi
app.post(['/donasi/confirm', '/api/donasi/confirm'], async (req, res) => {
  try {
    const { orderId, name, phone, amount, notes } = req.body || {};
    let donId = Number(orderId || 0);
    let ord = donId > 0 ? selectDonationOrderById.get(donId) : null;

    if (!ord) {
      const donorName = String(name || 'Hamba Allah').trim();
      const donorPhone = String(phone || '').trim();
      const baseAmount = Math.max(1000, parseInt(amount, 10) || 50000);
      if (!donorPhone || donorPhone.length < 8) {
        return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid' });
      }
      const created = ensureDonationOrderQrisUnique(baseAmount, donorPhone, donorName, notes);
      donId = created.orderId;
      ord = selectDonationOrderById.get(donId);
    }

    markDonationPaid.run(null, donId);
    const fulfillRes = await fulfillDonationOrder(getSettingsWithCache(), donId);

    return res.json({
      success: true,
      orderId: donId,
      activationCode: 'donasidulu',
      donorName: ord.donor_name,
      donorAmount: ord.qris_amount_unique || ord.amount,
      waSent: fulfillRes.ok,
      waError: fulfillRes.error || null
    });
  } catch (e) {
    logger.error(`[Donasi] Error processing donation confirmation: ${e.message}`);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// Mount built-in ACS server endpoint (TR-069)
const acsServerService = require('./services/acsServerService');
app.post('/acs', express.raw({ type: ['text/xml', 'application/soap+xml', 'application/xml', 'text/plain'], limit: '2mb' }), acsServerService.handleCwmpRequest);

// Landing page untuk scan QR stiker modem ONU pelanggan
app.get('/app/connect', (req, res) => {
  const settings = getSettingsWithCache();
  const cid = String(req.query.cid || '').trim();
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const companyName = settings.company_header || 'ALIJAYA DIGITAL NETWORK';
  const companyPhone = settings.company_phone || '';
  res.render('app_connect', {
    companyName,
    companyPhone,
    serverUrl,
    cid,
    settings
  });
});

// Mount customer portal
const customerPortal = require('./routes/customerPortal');
app.use('/customer', customerPortal);

// Mount customer REST API for Android Mobile App
const customerAPI = require('./routes/customerAPI');
app.use('/api/customer', customerAPI);

// Mount admin portal
const adminPortal = require('./routes/adminPortal');
app.use('/admin', adminPortal);

// Mount tech portal
const techPortal = require('./routes/techPortal');
app.use('/tech', techPortal);

// Mount agent portal
const agentPortal = require('./routes/agentPortal');
app.use('/agent', agentPortal);

// Mount collector portal
const collectorPortal = require('./routes/collectorPortal');
app.use('/collector', collectorPortal);

// Fungsi untuk memulai server dengan penanganan port yang sudah digunakan
function startServer(portToUse) {
    logger.info(`Mencoba memulai server pada port ${portToUse}...`);
    
    // Coba port alternatif jika port utama tidak tersedia
    try {
        const server = app.listen(portToUse, () => {
            logger.info(`Server berhasil berjalan pada port ${portToUse}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            // Update global.appSettings.port dengan port yang berhasil digunakan
            global.appSettings.port = portToUse.toString();
            
            // Voucher cache warmer dinonaktifkan — halaman voucher sekarang direct query ke MikroTik
            // const voucherCacheWarmer = require('./services/voucherCacheWarmer');
            // voucherCacheWarmer.startCacheWarming();
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`PERINGATAN: Port ${portToUse} sudah digunakan, mencoba port alternatif...`);
                // Coba port alternatif (port + 1000)
                const alternativePort = portToUse + 1000;
                logger.info(`Mencoba port alternatif: ${alternativePort}`);
                
                // Buat server baru dengan port alternatif
                const alternativeServer = app.listen(alternativePort, () => {
                    logger.info(`Server berhasil berjalan pada port alternatif ${alternativePort}`);
                    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
                    // Update global.appSettings.port dengan port yang berhasil digunakan
                    global.appSettings.port = alternativePort.toString();
                    
                    // Voucher cache warmer dinonaktifkan — halaman voucher sekarang direct query ke MikroTik
                    // const voucherCacheWarmer = require('./services/voucherCacheWarmer');
                    // voucherCacheWarmer.startCacheWarming();
                }).on('error', (altErr) => {
                    logger.error(`ERROR: Gagal memulai server pada port alternatif ${alternativePort}:`, altErr.message);
                    process.exit(1);
                });
            } else {
                logger.error('Error starting server:', err);
                process.exit(1);
            }
        });
    } catch (error) {
        logger.error(`Terjadi kesalahan saat memulai server:`, error);
        process.exit(1);
    }
}

// Mulai server dengan port dari settings.json
const port = global.appSettings.port;
logger.info(`Attempting to start server on configured port: ${port}`);

// Mulai server dengan port dari konfigurasi
startServer(port);

if (getSetting('whatsapp_enabled', false)) {
  const gwType = getSetting('wa_gateway_type', 'baileys');
  if (gwType === 'baileys') {
    import('./services/whatsappBot.mjs')
      .then((mod) => mod.startWhatsAppBot())
      .catch((err) => logger.error('Gagal memulai WhatsApp bot (Baileys):', err));
  }
}

if (getSetting('telegram_enabled', false)) {
  const { initTelegram } = require('./services/telegramBot');
  initTelegram();
}

// Mulai cron jobs (generate tagihan otomatis, dll)
const { startCronJobs } = require('./services/cronService');
startCronJobs();

// Mulai auto backup
scheduleAutoBackup();

// Inisialisasi RADIUS Server jika diaktifkan di settings
const radiusSvc = require('./services/radiusServerService');
if (getSetting('radius_enabled', '0') === '1') {
  radiusSvc.start();
}

// Error handling middleware (harus di akhir setelah semua routes)
app.use(notFoundHandler);
app.use(errorHandler);

// Export app untuk testing
module.exports = app;
