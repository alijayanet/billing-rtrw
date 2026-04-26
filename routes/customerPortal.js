const express = require('express');
const router = express.Router();
const customerDevice = require('../services/customerDeviceService');
const { getSettingsWithCache } = require('../config/settingsManager');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const customerSvc = require('../services/customerService');
const mikrotikService = require('../services/mikrotikService');
const { logger } = require('../config/logger');
const ticketSvc = require('../services/ticketService');
const crypto = require('crypto');
const db = require('../config/database');

function dashboardNotif(message, type = 'success') {
  if (!message) return null;
  return { text: message, type };
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecodeToString(input) {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPublicToken(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyPublicToken(token, secret) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const m = String(script).match(/\",rem,.*?,(.*?),(.*?),.*?\"/);
  if (!m) return null;
  const validity = String(m[1] || '').trim();
  const price = Number(String(m[2] || '').replace(/[^\d]/g, '')) || 0;
  return { validity, price };
}

function normalizeBuyerPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length < 8) return '';
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('62')) return digits;
  return '62' + digits;
}

function genRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isEnabledFlag(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function resolvePaymentExpiresAt(gateway, result) {
  const g = String(gateway || '').toLowerCase();
  const p = result && result.payload ? result.payload : null;

  const tryDate = (v) => {
    const t = new Date(v);
    const ms = t.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return t.toISOString();
  };

  const tryUnix = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    const out = d.getTime();
    if (!Number.isFinite(out) || out <= 0) return null;
    return d.toISOString();
  };

  if (p && g === 'tripay') {
    return (
      tryUnix(p.expired_time ?? p.expiredTime) ||
      tryDate(p.expired_at ?? p.expiredAt) ||
      tryDate(p.expiry_date ?? p.expiryDate) ||
      null
    );
  }

  if (p && g === 'xendit') {
    return (
      tryDate(p.expiry_date ?? p.expiryDate) ||
      tryDate(p.expiration_date ?? p.expirationDate) ||
      null
    );
  }

  if (p && g === 'duitku') {
    return (
      tryDate(p.expiry_date ?? p.expiryDate) ||
      tryUnix(p.expired_time ?? p.expiredTime) ||
      null
    );
  }

  if (p && g === 'midtrans') {
    return (
      tryDate(p.expiry_time ?? p.expiryTime) ||
      tryDate(p.expired_at ?? p.expiredAt) ||
      null
    );
  }

  return null;
}

function gatewayDefaultExpiresAtIso(gateway, nowMs = Date.now()) {
  const g = String(gateway || '').toLowerCase();
  const base = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  if (g === 'xendit') return new Date(base + 86400 * 1000).toISOString();
  if (g === 'duitku') return new Date(base + 1440 * 60 * 1000).toISOString();
  return null;
}

const pppoeTrafficSamples = new Map();

function prunePppoeTrafficSamples(now) {
  const maxAgeMs = 3 * 60 * 1000;
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || now - v.t > maxAgeMs) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  for (const k of keys) {
    const v = obj && (obj[k] ?? obj[String(k)]);
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function strField(obj, keys) {
  for (const k of keys) {
    const v = obj && (obj[k] ?? obj[String(k)]);
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

// Route: Syarat & Ketentuan (TOS)
router.get('/tos', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('tos', { 
    settings, 
    company: settings.company_header || 'ISP Kami',
    isLoggedIn: !!req.session.phone 
  });
});

// Route: Kebijakan Privasi
router.get('/privacy', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('privacy', { 
    settings, 
    company: settings.company_header || 'ISP Kami',
    isLoggedIn: !!req.session.phone 
  });
});

// Route: Tentang Kami
router.get('/about', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('about', { 
    settings, 
    company: settings.company_header || 'ISP Kami',
    isLoggedIn: !!req.session.phone 
  });
});

// Route: Kontak Support
router.get('/contact', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('contact', { 
    settings, 
    company: settings.company_header || 'ISP Kami',
    isLoggedIn: !!req.session.phone 
  });
});

const {
  findDeviceByTag,
  findDeviceByPppoe,
  getCustomerDeviceData,
  fallbackCustomer,
  updateSSID,
  updatePassword,
  requestReboot,
  updateCustomerTag
} = customerDevice;

router.get('/login', (req, res) => {
  const settings = getSettingsWithCache();
  res.render('login', { error: null, settings });
});

router.get('/check-billing', async (req, res) => {
  const settings = getSettingsWithCache();
  const query = String(req.query.q || '').trim();
  const error = String(req.query.err || '').trim() || null;
  const info = String(req.query.info || '').trim() || null;

  let customer = null;
  let invoices = [];
  let unpaidInvoices = [];
  let invoiceTokens = {};
  let matches = [];
  let paymentChannels = [];

  if (settings.default_gateway === 'tripay' && settings.tripay_enabled) {
    try {
      paymentChannels = await paymentSvc.getTripayChannels();
      const qris = paymentChannels.find(c => String(c.code || '').toUpperCase() === 'QRIS');
      const others = paymentChannels.filter(c => String(c.code || '').toUpperCase() !== 'QRIS');
      paymentChannels = [...(qris ? [qris] : []), ...others];
    } catch {
      paymentChannels = [];
    }
  }

  if (query) {
    customer = customerSvc.findCustomerByAny(query);
    if (customer) {
      const lookup = customer.pppoe_username || customer.genieacs_tag || customer.phone || String(customer.id);
      invoices = billingSvc.getInvoicesByAny(lookup) || [];
      unpaidInvoices = invoices.filter(i => i.status === 'unpaid');

      const secret = settings.session_secret || 'rahasia-portal-pelanggan-default-ganti-ini';
      const exp = Date.now() + 15 * 60 * 1000;
      invoiceTokens = unpaidInvoices.reduce((acc, inv) => {
        acc[String(inv.id)] = signPublicToken(
          { invoiceId: Number(inv.id), customerId: Number(inv.customer_id), lookup, exp },
          secret
        );
        return acc;
      }, {});
    } else {
      const invs = billingSvc.getInvoicesByAny(query) || [];
      const unpaid = (Array.isArray(invs) ? invs : []).filter(i => i && i.status === 'unpaid');
      const map = new Map();
      for (const inv of unpaid) {
        const customerId = Number(inv.customer_id || 0);
        if (!Number.isFinite(customerId) || customerId <= 0) continue;
        const prev = map.get(customerId) || {
          customer_id: customerId,
          customer_name: inv.customer_name || '-',
          customer_phone: inv.customer_phone || '',
          unpaid_count: 0,
          total_amount: 0
        };
        prev.unpaid_count += 1;
        prev.total_amount += Number(inv.amount || 0) || 0;
        map.set(customerId, prev);
      }
      matches = Array.from(map.values()).sort((a, b) => {
        const au = Number(a.unpaid_count || 0);
        const bu = Number(b.unpaid_count || 0);
        if (au !== bu) return bu - au;
        return String(a.customer_name || '').localeCompare(String(b.customer_name || ''), 'id');
      });
    }
  }

  res.render('public_check_billing', {
    settings,
    query,
    customer,
    invoices,
    unpaidInvoices,
    invoiceTokens,
    matches,
    paymentChannels,
    error,
    info
  });
});

router.get('/voucher', async (req, res) => {
  const settings = getSettingsWithCache();
  const error = String(req.query.err || '').trim() || null;
  const info = String(req.query.info || '').trim() || null;

  let profiles = [];
  try {
    const raw = await mikrotikService.getHotspotUserProfiles(null);
    profiles = (Array.isArray(raw) ? raw : [])
      .map(p => {
        const meta = parseMikhmonOnLogin(p.onLogin || p['on-login']);
        if (!meta || !meta.validity) return null;
        const price = Number(meta.price || 0) || 0;
        if (price <= 0) return null;
        return { name: p.name, validity: meta.validity, price };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  } catch {
    profiles = [];
  }

  let paymentChannels = [];
  if (settings.default_gateway === 'tripay' && settings.tripay_enabled) {
    try {
      paymentChannels = await paymentSvc.getTripayChannels();
      const qris = paymentChannels.find(c => String(c.code || '').toUpperCase() === 'QRIS');
      const others = paymentChannels.filter(c => String(c.code || '').toUpperCase() !== 'QRIS');
      paymentChannels = [...(qris ? [qris] : []), ...others];
    } catch {
      paymentChannels = [];
    }
  }

  let order = null;
  const orderId = Number(req.query.order || 0);
  if (orderId) {
    const secret = settings.session_secret || 'rahasia-portal-pelanggan-default-ganti-ini';
    const payload = verifyPublicToken(req.query.t, secret);
    if (payload && Number(payload.voucherOrderId) === orderId) {
      order = db.prepare('SELECT * FROM public_voucher_orders WHERE id = ?').get(orderId) || null;
    }
  }

  res.render('public_voucher', {
    settings,
    profiles,
    paymentChannels,
    order,
    error,
    info
  });
});

router.post('/public/voucher/create-payment', async (req, res) => {
  const settings = getSettingsWithCache();

  const buyerPhone = normalizeBuyerPhone(req.body.buyer_phone);
  const profileName = String(req.body.profile_name || '').trim();
  const tosChecked = req.body.tos === 'on' || req.body.tos === '1' || req.body.tos === true || req.body.tos === 'true';

  if (!buyerPhone) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Nomor WhatsApp tidak valid'));
  if (!profileName) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Pilih paket voucher terlebih dahulu'));
  if (!tosChecked) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Harap centang persetujuan Syarat & Ketentuan (TOS) untuk melanjutkan.'));

  let selected = null;
  try {
    const raw = await mikrotikService.getHotspotUserProfiles(null);
    const list = Array.isArray(raw) ? raw : [];
    const found = list.find(p => String(p.name || '') === profileName);
    if (found) {
      const meta = parseMikhmonOnLogin(found.onLogin || found['on-login']);
      if (meta && meta.validity) {
        const price = Number(meta.price || 0) || 0;
        if (price > 0) {
          selected = { name: profileName, validity: meta.validity, price };
        }
      }
    }
  } catch {
    selected = null;
  }

  if (!selected) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Profile voucher tidak ditemukan'));
  if (!Number.isFinite(selected.price) || selected.price <= 0) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Harga voucher tidak valid'));

  try {
    const ins = db.prepare(`
      INSERT INTO public_voucher_orders (router_id, profile_name, validity, price, buyer_phone, status)
      VALUES (NULL, ?, ?, ?, ?, 'pending')
    `).run(selected.name, selected.validity || '', Math.floor(selected.price), buyerPhone);
    const orderId = Number(ins.lastInsertRowid);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const appUrl = settings.app_url || `${protocol}://${host}`;

    const enabled = {
      tripay: isEnabledFlag(settings.tripay_enabled),
      midtrans: isEnabledFlag(settings.midtrans_enabled),
      xendit: isEnabledFlag(settings.xendit_enabled),
      duitku: isEnabledFlag(settings.duitku_enabled)
    };
    let gateway = String(settings.default_gateway || 'tripay').toLowerCase();
    if (!enabled[gateway]) {
      gateway =
        enabled.tripay ? 'tripay' :
        enabled.midtrans ? 'midtrans' :
        enabled.xendit ? 'xendit' :
        enabled.duitku ? 'duitku' :
        'tripay';
    }

    let method = String(req.body.method || 'QRIS').trim().toUpperCase();
    if (!method) method = 'QRIS';

    if (gateway === 'tripay') {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) method = 'QRIS';
      } catch {
        method = 'QRIS';
      }
    }

    const invoiceLike = {
      id: orderId,
      amount: Math.floor(selected.price),
      item_name: `Voucher Hotspot ${selected.name} (${selected.validity})`,
      sku: `VOUCHER-${orderId}`
    };
    const buyer = { name: 'Pembeli Voucher', phone: buyerPhone, email: '' };

    const secret = settings.session_secret || 'rahasia-portal-pelanggan-default-ganti-ini';
    const token = signPublicToken({ voucherOrderId: orderId, exp: Date.now() + 24 * 60 * 60 * 1000 }, secret);
    const returnPath = `/customer/voucher?order=${encodeURIComponent(String(orderId))}&t=${encodeURIComponent(token)}`;

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(invoiceLike, buyer, 'snap', appUrl, { returnPath });
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(invoiceLike, buyer, 'xendit', appUrl, { returnPath, description: invoiceLike.item_name });
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(invoiceLike, buyer, method, appUrl, { returnPath, itemName: invoiceLike.item_name });
    } else {
      result = await paymentSvc.createTripayTransaction(invoiceLike, buyer, method, appUrl, { returnPath, itemName: invoiceLike.item_name, sku: invoiceLike.sku });
    }

    if (!result.success) throw new Error(result.message || 'Gagal membuat transaksi');

    db.prepare(`
      UPDATE public_voucher_orders SET
        payment_gateway = ?,
        payment_order_id = ?,
        payment_link = ?,
        payment_reference = ?,
        payment_payload = ?,
        payment_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      gateway,
      result.order_id || '',
      result.link || '',
      result.reference || '',
      result.payload ? JSON.stringify(result.payload) : null,
      resolvePaymentExpiresAt(gateway, result) || gatewayDefaultExpiresAtIso(gateway),
      orderId
    );

    return res.redirect(result.link);
  } catch (e) {
    logger.error('[PublicVoucher] Create payment error: ' + (e?.message || e));
    return res.redirect('/customer/voucher?err=' + encodeURIComponent('Gagal membuat pembayaran. Silakan coba lagi.'));
  }
});

// ─── REGISTRATION / PENDAFTARAN ─────────────────────────────────────────────
router.get('/register', (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  res.render('register', { error: null, success: null, settings, packages });
});

router.post('/register', async (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  const { name, phone, email, address, package_id, lat, lng } = req.body;

  try {
    if (!name || !phone || !address || !package_id) {
      throw new Error('Semua field wajib diisi.');
    }

    // Buat pelanggan dengan status inactive (menunggu survei/pemasangan)
    customerSvc.createCustomer({
      name,
      phone,
      email,
      address,
      package_id,
      lat: String(lat || '').trim(),
      lng: String(lng || '').trim(),
      status: 'inactive',
      notes: 'Pendaftar Baru via Online'
    });

    // Kirim notifikasi ke Admin
    if (settings.whatsapp_enabled && settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
      const { sendWA } = await import('../services/whatsappBot.mjs');
      const selectedPkg = packages.find(p => p.id.toString() === package_id.toString());
      const pkgName = selectedPkg ? selectedPkg.name : 'Tidak diketahui';
      
      const adminMsg = `🔔 *PENDAFTARAN BARU*\n\nAda calon pelanggan baru yang mendaftar via web:\n\n👤 *Nama:* ${name}\n📞 *WA:* ${phone}\n📍 *Alamat:* ${address}\n📦 *Paket:* ${pkgName}\n\nSilakan cek di panel Admin untuk menindaklanjuti.`;
      const latStr = String(lat || '').trim();
      const lngStr = String(lng || '').trim();
      const mapLine = (latStr && lngStr) ? `\n🗺️ *Lokasi:* https://maps.google.com/?q=${encodeURIComponent(latStr)},${encodeURIComponent(lngStr)}` : '';
      const finalAdminMsg = adminMsg + mapLine;
      
      for (const adminPhone of settings.whatsapp_admin_numbers) {
        try { await sendWA(adminPhone, finalAdminMsg); } catch(e) { /* ignore */ }
      }
    }

    res.render('register', { 
      error: null, 
      success: 'Pendaftaran berhasil! Tim kami akan segera menghubungi Anda melalui WhatsApp.', 
      settings, packages 
    });
  } catch (err) {
    res.render('register', { error: err.message, success: null, settings, packages });
  }
});

router.post('/login', async (req, res) => {
  const { phone } = req.body;
  const settings = getSettingsWithCache();

  let device = null;
  let effectiveTag = phone;

  // 1. Tahap 1: Cari Data di Billing DB
  const customer = customerSvc.findCustomerByAny(phone);
  
  if (customer) {
    logger.info(`[Login] Pelanggan ditemukan di DB (customerId=${customer.id || '-'}).`);
    
    // Kumpulkan semua token yang mungkin untuk mencari perangkat
    const searchTokens = [
      customer.genieacs_tag, 
      customer.pppoe_username, 
      customer.phone
    ].filter(Boolean);

    // Cari secara paralel untuk mempercepat proses
    const results = await Promise.all(searchTokens.map(async (token) => {
      let d = await customerDevice.findDeviceByTag(token);
      if (!d) d = await customerDevice.findDeviceByPppoe(token);
      if (!d) {
        const variants = await customerDevice.findDeviceWithTagVariants(token);
        if (variants) d = variants.device;
      }
      return d;
    }));

    device = results.find(d => d !== null);
    if (device) {
      logger.info('[Login] Perangkat terdeteksi di GenieACS (matched).');
      effectiveTag = device._id;
    }
  }

  // 2. Tahap 2: Fallback (Jika DB tidak ketemu atau perangkat belum link)
  if (!device) {
    const directResult = await customerDevice.findDeviceWithTagVariants(phone);
    if (directResult) {
      device = directResult.device;
      effectiveTag = directResult.canonicalTag;
      logger.info('[Login] Perangkat ditemukan secara langsung di GenieACS (fallback).');
    }
  }

  // 3. Tahap 3: Verifikasi Akhir
  if (!device && !customer) {
    logger.warn('[Login] Gagal: pelanggan tidak ditemukan.');
    return res.render('login', { 
      error: 'Data pelanggan tidak ditemukan. Pastikan nomor WhatsApp sudah benar.', 
      settings 
    });
  }

  if (!device) {
    logger.warn('[Login] Login dilanjutkan tanpa data ONU (device tidak ditemukan).');
  }

  // --- OTP LOGIC --- (Hanya jika perangkat ditemukan)
  if (settings.login_otp_enabled) {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 5 * 60 * 1000; // 5 menit
    
    // Simpan ke session sementara
    req.session.pending_login = {
      phone: phone,
      effectiveTag: effectiveTag,
      otp: otp,
      expiry: expiry
    };

    logger.info('[Login] OTP dibuat.');

    // Kirim via WhatsApp
    if (settings.whatsapp_enabled) {
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        
        if (whatsappStatus.connection !== 'open') {
          throw new Error('Sistem WhatsApp sedang tidak aktif. Silakan hubungi Admin.');
        }

        const msg = `🛡️ *KODE VERIFIKASI (OTP)*\n\nKode Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapapun. Kode berlaku selama 5 menit.`;
        const sent = await sendWA(phone, msg);
        
        if (!sent) {
          throw new Error('Gagal mengirim kode OTP melalui WhatsApp. Pastikan nomor Anda terdaftar di WhatsApp.');
        }

        logger.info('[Login] OTP dikirim via WhatsApp.');
      } catch (e) {
        logger.error(`[Login] Gagal kirim OTP via WhatsApp: ${e.message}`);
        return res.render('login', { error: e.message, settings });
      }
    }

    return res.redirect('/customer/login-otp');
  }

  // --- DIRECT LOGIN ---
  logger.info('[Login] Login direct berhasil.');
  req.session.phone = effectiveTag;
  return res.redirect('/customer/dashboard');
});

router.get('/login-otp', (req, res) => {
  const settings = getSettingsWithCache();
  if (!req.session.pending_login) return res.redirect('/customer/login');
  res.render('login_otp', { error: null, settings, phone: req.session.pending_login.phone });
});

router.post('/login-otp', (req, res) => {
  const { otp } = req.body;
  const settings = getSettingsWithCache();
  const pending = req.session.pending_login;

  if (!pending) return res.redirect('/customer/login');

  if (Date.now() > pending.expiry) {
    delete req.session.pending_login;
    return res.render('login', { error: 'Kode OTP telah kadaluarsa. Silakan login kembali.', settings });
  }

  if (otp === pending.otp) {
    logger.info('[Login] OTP berhasil diverifikasi.');
    req.session.phone = pending.effectiveTag;
    delete req.session.pending_login;
    return res.redirect('/customer/dashboard');
  } else {
    return res.render('login_otp', { error: 'Kode OTP salah. Silakan coba lagi.', settings, phone: pending.phone });
  }
});

router.get('/dashboard', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.redirect('/customer/login');
  
  // Flash message
  let msgNotif = null;
  if (req.session._msg) {
    msgNotif = dashboardNotif(req.session._msg.text, req.session._msg.type);
    delete req.session._msg;
  }
  
  // Data dari GenieACS
  const deviceData = await getCustomerDeviceData(loginId);
  
  // Data dari Billing DB (Coba cari pakai loginId atau pppoeUsername)
  let searchToken = loginId;
  if (deviceData && deviceData.pppoeUsername) {
    searchToken = deviceData.pppoeUsername;
  }
  
  const invoices = billingSvc.getInvoicesByAny(searchToken);
  const profile = customerSvc.getAllCustomers().find(c => {
    const cleanLogin = loginId.replace(/\D/g, '');
    const cleanDb = (c.phone || '').replace(/\D/g, '');
    return cleanDb === cleanLogin || 
           c.phone === loginId || 
           c.genieacs_tag === loginId || 
           c.pppoe_username === (deviceData ? deviceData.pppoeUsername : null);
  });
  
  // Ambil tiket keluhan pelanggan
  let tickets = [];
  if (profile) {
    tickets = ticketSvc.getTicketsByCustomerId(profile.id);
  }

  if (profile && profile.router_id) {
    req.session.router_id = Number(profile.router_id);
  }
  const pppoeFromProfile = profile && String(profile.pppoe_username || '').trim();
  const pppoeFromDevice = deviceData && String(deviceData.pppoeUsername || '').trim();
  if (pppoeFromProfile) req.session.pppoe_username = pppoeFromProfile;
  else if (pppoeFromDevice) req.session.pppoe_username = pppoeFromDevice;

  const settings = getSettingsWithCache();
  let paymentChannels = [];
  if (settings.default_gateway === 'tripay' && settings.tripay_enabled) {
    paymentChannels = await paymentSvc.getTripayChannels();
  }

  let trafficMaxDownMbps = 10;
  let trafficMaxUpMbps = 10;
  if (profile) {
    const downKbps = Number(profile.speed_down || 0);
    const upKbps = Number(profile.speed_up || 0);
    if (Number.isFinite(downKbps) && downKbps > 0) trafficMaxDownMbps = Math.max(1, Math.round(downKbps / 1000));
    if (Number.isFinite(upKbps) && upKbps > 0) trafficMaxUpMbps = Math.max(1, Math.round(upKbps / 1000));
  }

  res.render('dashboard', {
    customer: deviceData || fallbackCustomer(loginId),
    profile: profile || null,
    invoices: invoices || [],
    tickets: tickets || [],
    settings,
    paymentChannels,
    trafficMaxDownMbps,
    trafficMaxUpMbps,
    connectedUsers: deviceData ? deviceData.connectedUsers : [],
    isLoggedIn: true,
    notif: msgNotif || (deviceData ? null : dashboardNotif('Data perangkat tidak ditemukan di sistem ONU.', 'warning'))
  });
});

router.get('/api/pppoe-traffic', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  let routerId = req.session && req.session.router_id ? Number(req.session.router_id) : null;
  let username = String((req.session && req.session.pppoe_username) || '').trim();

  if (!username || !routerId) {
    const cleanLogin = String(loginId).replace(/\D/g, '');
    const profile = customerSvc.getAllCustomers().find(c => {
      const cleanDb = String(c.phone || '').replace(/\D/g, '');
      return cleanDb === cleanLogin || c.phone === loginId || c.genieacs_tag === loginId || c.pppoe_username === loginId;
    }) || null;

    if (!routerId && profile && profile.router_id) {
      routerId = Number(profile.router_id);
      req.session.router_id = routerId;
    }
    if (!username) {
      const pppoeFromProfile = profile && String(profile.pppoe_username || '').trim();
      if (pppoeFromProfile) {
        username = pppoeFromProfile;
        req.session.pppoe_username = username;
      } else if (/[a-zA-Z]/.test(String(loginId))) {
        username = String(loginId).trim();
      }
    }
  }

  if (!username) return res.json({ ok: true, available: false, online: false });

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, online: false, username, rxMbps: 0, txMbps: 0 });
    }

    const s = sessions[0];
    let iface = strField(s, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(s, ['.id', 'id', 'sessionId', 'session-id']) || `${username}`;
    const bytesIn = numField(s, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(s, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(s, ['uptime']) || null;

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', username).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find(r => String(r.user || r['user'] || '').trim() === username);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;

    const key = `${routerId || 'default'}:${username}`;
    const prev = pppoeTrafficSamples.get(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';

    if (iface) {
      const ifMenu = conn.client.menu('/interface');
      if (ifMenu) {
        try {
          const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
          const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
          const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second', 'rx-bits-per-second']);
          const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second', 'tx-bits-per-second']);
          if (rxBps || txBps) {
            return res.json({
              ok: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              rxMbps: (Number(rxBps) || 0) / 1e6,
              txMbps: (Number(txBps) || 0) / 1e6
            });
          }
        } catch {}
      }
    }

    if (iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    pppoeTrafficSamples.set(key, { t: now, sessionId, rxBytes, txBytes, source });

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const rxMbps = (dIn * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dOut * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { ssid } = req.body;
  const ok = await updateSSID(phone, ssid);
  
  req.session._msg = ok 
    ? { type: 'success', text: 'Nama WiFi (SSID) berhasil diubah.' }
    : { type: 'danger', text: 'Gagal mengubah SSID.' };
    
  res.redirect('/customer/dashboard');
});

router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  
  req.session._msg = ok
    ? { type: 'success', text: 'Password WiFi berhasil diubah.' }
    : { type: 'danger', text: 'Gagal mengubah password. Pastikan minimal 8 karakter.' };

  res.redirect('/customer/dashboard');
});

router.post('/reboot', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const r = await requestReboot(phone);
  
  req.session._msg = r.ok
    ? { type: 'success', text: 'Perangkat berhasil direboot. Silakan tunggu beberapa menit.' }
    : { type: 'danger', text: r.message || 'Gagal reboot.' };

  res.redirect('/customer/dashboard');
});

router.post('/change-tag', async (req, res) => {
  const oldTag = req.session && req.session.phone;
  const newTag = (req.body.newTag || '').trim();
  if (!oldTag) return res.redirect('/customer/login');
  const settings = getSettingsWithCache();

  if (!newTag || newTag === oldTag) {
    const data = await getCustomerDeviceData(oldTag);
    const invoices = billingSvc.getInvoicesByAny(oldTag);
    return res.render('dashboard', {
      customer: data || fallbackCustomer(oldTag),
      profile: null,
      invoices: invoices || [],
      tickets: [],
      settings,
      paymentChannels: [],
      connectedUsers: data ? data.connectedUsers : [],
      notif: dashboardNotif('ID/Tag baru tidak boleh kosong atau sama dengan yang lama.', 'warning')
    });
  }
  const tagResult = await updateCustomerTag(oldTag, newTag);
  let notif = null;
  let resolvedPhone = oldTag;
  
  if (tagResult.ok) {
    req.session.phone = newTag;
    resolvedPhone = newTag;
    notif = dashboardNotif('ID/Tag berhasil diubah.', 'success');
    
    // UPDATE DATABASE SQLITE IF MATCHING PROFILE FOUND
    const profileToUpdate = customerSvc.getAllCustomers().find(c => {
      const cleanLogin = oldTag.replace(/\D/g, '');
      const cleanDb = (c.phone || '').replace(/\D/g, '');
      return cleanDb === cleanLogin || c.phone === oldTag || c.genieacs_tag === oldTag;
    });
    
    if (profileToUpdate) {
      try {
        customerSvc.updateCustomer(profileToUpdate.id, { 
          ...profileToUpdate, 
          genieacs_tag: newTag 
        });
        logger.info(`[Portal] Database updated for tag change: ${oldTag} -> ${newTag}`);
      } catch (dbErr) {
        logger.error(`[Portal] Failed to update DB tag: ${dbErr.message}`);
      }
    }
  } else {
    notif = dashboardNotif(tagResult.message || 'Gagal mengubah ID/Tag pelanggan.', 'danger');
  }
  const deviceData = await getCustomerDeviceData(resolvedPhone);
  let searchToken = resolvedPhone;
  if (deviceData && deviceData.pppoeUsername) {
    searchToken = deviceData.pppoeUsername;
  }
  const invoices = billingSvc.getInvoicesByAny(searchToken);
  const profile = customerSvc.getAllCustomers().find(c => {
    const cleanLogin = resolvedPhone.replace(/\D/g, '');
    const cleanDb = (c.phone || '').replace(/\D/g, '');
    return cleanDb === cleanLogin || c.phone === resolvedPhone || c.pppoe_username === (deviceData ? deviceData.pppoeUsername : null);
  });
  const tickets = profile ? ticketSvc.getTicketsByCustomerId(profile.id) : [];

  res.render('dashboard', {
    customer: deviceData || fallbackCustomer(resolvedPhone),
    profile: profile || null,
    invoices: invoices || [],
    tickets,
    settings,
    paymentChannels: [],
    connectedUsers: deviceData ? deviceData.connectedUsers : [],
    notif
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});

router.post('/public/payment/create/:invoiceId', async (req, res) => {
  const settings = getSettingsWithCache();
  const secret = settings.session_secret || 'rahasia-portal-pelanggan-default-ganti-ini';
  const payload = verifyPublicToken(req.body.token, secret);

  const redirectBack = (lookup, err, info) => {
    const q = lookup ? `q=${encodeURIComponent(String(lookup))}` : '';
    const e = err ? `err=${encodeURIComponent(String(err))}` : '';
    const i = info ? `info=${encodeURIComponent(String(info))}` : '';
    const qs = [q, e, i].filter(Boolean).join('&');
    return res.redirect(`/customer/check-billing${qs ? `?${qs}` : ''}`);
  };

  if (!payload) {
    return redirectBack('', 'Link pembayaran tidak valid atau sudah kadaluarsa.');
  }

  if (String(req.params.invoiceId) !== String(payload.invoiceId)) {
    return redirectBack(payload.lookup, 'Link pembayaran tidak valid.');
  }

  const tosChecked = req.body.tos === 'on' || req.body.tos === '1' || req.body.tos === true || req.body.tos === 'true';
  if (!tosChecked) {
    return redirectBack(payload.lookup, 'Harap centang persetujuan Syarat & Ketentuan (TOS) untuk melanjutkan.');
  }

  try {
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (Number(inv.customer_id) !== Number(payload.customerId)) throw new Error('Tagihan tidak valid');
    if (inv.status === 'paid') {
      return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
    }

    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    if (!force && inv.payment_link) {
      let expiresAtMs = inv.payment_expires_at ? new Date(inv.payment_expires_at).getTime() : 0;
      let payloadExpiresAt = null;
      if (inv.payment_payload) {
        try {
          const parsedPayload = typeof inv.payment_payload === 'string' ? JSON.parse(inv.payment_payload) : inv.payment_payload;
          payloadExpiresAt = resolvePaymentExpiresAt(inv.payment_gateway, { payload: parsedPayload });
          const ms = payloadExpiresAt ? new Date(payloadExpiresAt).getTime() : 0;
          if (Number.isFinite(ms) && ms > 0) expiresAtMs = ms;
        } catch {}
      }

      if (payloadExpiresAt && payloadExpiresAt !== inv.payment_expires_at) {
        try {
          billingSvc.updatePaymentInfo(inv.id, {
            gateway: inv.payment_gateway,
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id} (public)`);
        return res.redirect(inv.payment_link);
      }
    }

    const gateway = settings.default_gateway || 'tripay';
    const rawMethod = String(req.body.method || 'QRIS').trim().toUpperCase().slice(0, 40);
    let method = rawMethod || 'QRIS';
    const cust = customerSvc.getCustomerById(inv.customer_id);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const appUrl = settings.app_url || `${protocol}://${host}`;

    if (gateway === 'tripay' && settings.tripay_enabled) {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) method = 'QRIS';
      } catch {
        method = 'QRIS';
      }
    }

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, cust, method, appUrl);
    } else {
      result = await paymentSvc.createTripayTransaction(inv, cust, method, appUrl);
    }

    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: resolvedExpiresAt
      });

      logger.info(`[Payment] New link created for INV-${inv.id} via ${gateway} (public)`);
      return res.redirect(result.link);
    }

    throw new Error(result.message || 'Gagal membuat transaksi');
  } catch (error) {
    logger.error(`[Payment] Create Error (public): ${error.message}`);
    return redirectBack(payload.lookup, 'Terjadi kesalahan saat membuat transaksi pembayaran. Silakan coba lagi.');
  }
});

// ─── TICKETS / KELUHAN ─────────────────────────────────────────────────────
router.post('/tickets/create', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.redirect('/customer/login');
  
  const { subject, message, customerId } = req.body;
  if (!subject || !message || !customerId) {
    req.session._msg = { type: 'danger', text: 'Semua field harus diisi.' };
    return res.redirect('/customer/dashboard');
  }

  try {
    const result = ticketSvc.createTicket(customerId, subject, message);
    const ticketId = result.lastInsertRowid;
    
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dikirim. Tim teknisi akan segera mengeceknya.' };

    // --- WHATSAPP NOTIFICATION FOR NEW TICKET ---
    try {
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const customer = customerSvc.getCustomerById(customerId);
        
        const waMsg = `🎫 *TIKET KELUHAN BARU*\n\n` +
                     `👤 *Pelanggan:* ${customer ? customer.name : 'Unknown'}\n` +
                     `📞 *WhatsApp:* ${customer ? customer.phone : '-'}\n` +
                     `📍 *Alamat:* ${customer ? customer.address : '-'}\n` +
                     `📝 *Subjek:* ${subject}\n` +
                     `💬 *Pesan:* ${message}\n\n` +
                     `Silakan cek di panel Admin/Teknisi untuk menindaklanjuti.`;

        // Kirim ke Admin
        if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
          for (const adminPhone of settings.whatsapp_admin_numbers) {
            await sendWA(adminPhone, waMsg);
          }
        }

        // Kirim ke semua Teknisi Aktif
        const techSvc = require('../services/techService');
        const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
        for (const tech of technicians) {
          if (tech.phone) {
            await sendWA(tech.phone, waMsg);
          }
        }
      }
    } catch (waErr) {
      logger.error(`[Ticket] WA Notification Error: ${waErr.message}`);
    }
    // --------------------------------------------

  } catch (error) {
    req.session._msg = { type: 'danger', text: 'Gagal mengirim keluhan: ' + error.message };
  }
  res.redirect('/customer/dashboard');
});

// ─── PAYMENT ROUTES ────────────────────────────────────────────────────────
router.get('/payment/create/:invoiceId', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.redirect('/customer/login');
  
  try {
    const settings = getSettingsWithCache();
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);
    
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (inv.status === 'paid') throw new Error('Tagihan ini sudah lunas.');

    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    if (!force && inv.payment_link) {
      let expiresAtMs = inv.payment_expires_at ? new Date(inv.payment_expires_at).getTime() : 0;
      let payloadExpiresAt = null;
      if (inv.payment_payload) {
        try {
          const parsedPayload = typeof inv.payment_payload === 'string' ? JSON.parse(inv.payment_payload) : inv.payment_payload;
          payloadExpiresAt = resolvePaymentExpiresAt(inv.payment_gateway, { payload: parsedPayload });
          const ms = payloadExpiresAt ? new Date(payloadExpiresAt).getTime() : 0;
          if (Number.isFinite(ms) && ms > 0) expiresAtMs = ms;
        } catch {}
      }

      if (payloadExpiresAt && payloadExpiresAt !== inv.payment_expires_at) {
        try {
          billingSvc.updatePaymentInfo(inv.id, {
            gateway: inv.payment_gateway,
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id}`);
        return res.redirect(inv.payment_link);
      }
    }

    const gateway = settings.default_gateway || 'tripay';
    const method = req.query.method || 'QRIS';
    const cust = customerSvc.getCustomerById(inv.customer_id);
    
    // Tentukan base URL aplikasi untuk callback
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const appUrl = settings.app_url || `${protocol}://${host}`;

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, cust, method, appUrl);
    } else {
      // Default ke Tripay
      result = await paymentSvc.createTripayTransaction(inv, cust, method, appUrl);
    }
    
    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      // Simpan info pembayaran ke database
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: resolvedExpiresAt
      });

      logger.info(`[Payment] New link created for INV-${inv.id} via ${gateway}`);
      res.redirect(result.link);
    } else {
      throw new Error(result.message || 'Gagal membuat transaksi');
    }
  } catch (error) {
    logger.error(`[Payment] Create Error: ${error.message}`);
    res.status(500).send(`Terjadi kesalahan: ${error.message}`);
  }
});

/**
 * Webhook Callback (Multi-Gateway)
 */
router.post('/payment/callback', express.json(), async (req, res) => {
  const settings = getSettingsWithCache();
  const tripaySignature = req.headers['x-callback-signature'];
  const midtransSignature = req.headers['x-callback-token']; // Midtrans usually uses Basic Auth or IP whitelist, but let's check payload
  
  const jsonBody = JSON.stringify(req.body);
  let gatewayOrderId = null;
  let invoiceIdCandidate = null;
  let status = null;
  let gateway = null;

  // --- DETEKSI TRIPAY ---
  if (tripaySignature) {
    if (paymentSvc.verifyTripayWebhook(jsonBody, tripaySignature, settings.tripay_private_key)) {
      const { merchant_ref, status: tpStatus } = req.body;
      const parts = String(merchant_ref || '').split('-');
      gatewayOrderId = String(merchant_ref || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = tpStatus === 'PAID' ? 'paid' : tpStatus;
      gateway = 'Tripay';
    } else {
      logger.error('[Webhook] Signature Tripay tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  } 
  // --- DETEKSI MIDTRANS ---
  else if (req.body.transaction_status && req.body.order_id) {
    const serverKey = settings.midtrans_server_key;
    if (paymentSvc.verifyMidtransWebhook(req.body, serverKey)) {
      const { order_id, transaction_status } = req.body;
      const parts = String(order_id || '').split('-');
      gatewayOrderId = String(order_id || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = (transaction_status === 'settlement' || transaction_status === 'capture') ? 'paid' : transaction_status;
      gateway = 'Midtrans';
    } else {
      logger.error('[Webhook] Signature Midtrans tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  }
  // --- DETEKSI XENDIT ---
  else if (req.body.external_id && req.body.status && !tripaySignature) {
    // Xendit callback usually includes x-callback-token in headers
    const xenditToken = req.headers['x-callback-token'];
    if (xenditToken === settings.xendit_callback_token || !settings.xendit_callback_token) {
      const { external_id, status: xStatus } = req.body;
      const parts = String(external_id || '').split('-');
      gatewayOrderId = String(external_id || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = xStatus === 'PAID' ? 'paid' : xStatus;
      gateway = 'Xendit';
    } else {
      logger.error('[Webhook] Callback Token Xendit tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
  }
  // --- DETEKSI DUITKU ---
  else if (req.body.merchantCode && req.body.merchantOrderId && req.body.resultCode) {
    if (paymentSvc.verifyDuitkuWebhook(req.body, settings.duitku_api_key)) {
      const { merchantOrderId, resultCode } = req.body;
      const parts = String(merchantOrderId || '').split('-');
      gatewayOrderId = String(merchantOrderId || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = resultCode === '00' ? 'paid' : resultCode;
      gateway = 'Duitku';
    } else {
      logger.error('[Webhook] Signature Duitku tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  }

  if (gatewayOrderId && status === 'paid') {
    const order = db.prepare('SELECT * FROM public_voucher_orders WHERE payment_order_id = ?').get(gatewayOrderId);
    if (order) {
      const orderId = Number(order.id || 0);
      if (!Number.isFinite(orderId) || orderId <= 0) return res.json({ success: true });

      logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Voucher Order ID: ${orderId}`);

      if (String(order.status) !== 'paid' && String(order.status) !== 'fulfilled') {
        db.prepare(`
          UPDATE public_voucher_orders
          SET status='paid', paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(orderId);
      }

      const fresh = db.prepare('SELECT * FROM public_voucher_orders WHERE id = ?').get(orderId);
      if (!fresh) return res.json({ success: true });
      if (String(fresh.status) === 'fulfilled' && fresh.voucher_code) return res.json({ success: true });

      try {
        let created = null;
        let attempt = 0;
        while (attempt < 10) {
          attempt++;
          const code = genRandomCode(6);
          const pass = code;
          const comment = `pub-${orderId}-${code}-${fresh.profile_name}`;
          const userData = {
            server: 'all',
            name: code,
            password: pass,
            profile: fresh.profile_name,
            comment
          };
          if (fresh.validity) userData['limit-uptime'] = fresh.validity;

          try {
            await mikrotikService.addHotspotUser(userData, fresh.router_id ?? null);
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

        db.prepare(`
          UPDATE public_voucher_orders
          SET status='fulfilled',
              fulfilled_at=CURRENT_TIMESTAMP,
              voucher_code=?,
              voucher_password=?,
              voucher_comment=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(created.code, created.pass, created.comment, orderId);

        if (settings.whatsapp_enabled) {
          try {
            const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
            if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');
            if (!fresh.buyer_phone) throw new Error('Nomor WhatsApp pembeli kosong');
            const msg =
              `🎫 *VOUCHER HOTSPOT*\n\n` +
              `✅ Pembayaran diterima via *${gateway}*\n` +
              `📦 Paket: *${fresh.profile_name}* (${fresh.validity || '-'})\n` +
              `💰 Harga: Rp ${Number(fresh.price || 0).toLocaleString('id-ID')}\n\n` +
              `👤 User: *${created.code}*\n` +
              `🔑 Pass: *${created.pass}*\n\n` +
              `Terima kasih.`;
            await sendWA(fresh.buyer_phone, msg);
            db.prepare(`
              UPDATE public_voucher_orders
              SET wa_sent=1, wa_sent_at=CURRENT_TIMESTAMP, wa_error='', updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).run(orderId);
          } catch (waErr) {
            db.prepare(`
              UPDATE public_voucher_orders
              SET wa_sent=0, wa_error=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).run(String(waErr?.message || waErr || ''), orderId);
          }
        }
      } catch (e) {
        logger.error(`[Webhook] Voucher fulfill gagal (order=${orderId}): ${e.message}`);
      }

      return res.json({ success: true });
    }

    const idNum = Number(invoiceIdCandidate || 0);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.json({ success: true });
    }

    logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Invoice ID: ${idNum}`);

    const checkInv = billingSvc.getInvoiceById(idNum);
    if (checkInv && checkInv.status !== 'paid') {
      billingSvc.markAsPaid(idNum, gateway, `Otomatis via Webhook ${gateway}`);

      const customer = customerSvc.getCustomerById(checkInv.customer_id);
      
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus.connection !== 'open') {
          throw new Error('Bot WhatsApp belum terhubung');
        }
        if (!customer.phone) {
          throw new Error('Nomor WhatsApp pelanggan kosong');
        }
        const msg = `✅ *PEMBAYARAN BERHASIL*\n\nTerima kasih Kak *${customer.name}*,\n\nPembayaran tagihan internet periode *${checkInv.period_month}/${checkInv.period_year}* telah kami terima via *${gateway}*.\n\n💰 *Total:* Rp ${checkInv.amount.toLocaleString('id-ID')}\n📅 *Waktu:* ${new Date().toLocaleString('id-ID')}\n\nStatus layanan Anda kini telah aktif. Selamat berinternet kembali! 🚀`;
        await sendWA(customer.phone, msg);
      } catch (waErr) {
        logger.error(`[Webhook] Gagal kirim notif WA: ${waErr.message}`);
      }

      if (customer && customer.status === 'suspended') {
        const unpaidCount = billingSvc.getUnpaidInvoicesByCustomerId(customer.id).length;
        if (unpaidCount === 0) {
          logger.info(`[Webhook] Mengaktifkan kembali pelanggan ${customer.name} secara otomatis.`);
          await customerSvc.activateCustomer(customer.id);
        }
      }
    }
  }

  res.json({ success: true });
});

module.exports = router;
