const express = require('express');
const router = express.Router();
const customerDevice = require('../services/customerDeviceService');
const { getSettingsWithCache } = require('../config/settingsManager');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const customerSvc = require('../services/customerService');
const mikrotikService = require('../services/mikrotikService');
const { logger } = require('../config/logger');

function dashboardNotif(message, type = 'success') {
  if (!message) return null;
  return { text: message, type };
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

// ─── REGISTRATION / PENDAFTARAN ─────────────────────────────────────────────
router.get('/register', (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  res.render('register', { error: null, success: null, settings, packages });
});

router.post('/register', async (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  const { name, phone, email, address, package_id } = req.body;

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
      status: 'inactive',
      notes: 'Pendaftar Baru via Online'
    });

    // Kirim notifikasi ke Admin
    if (settings.whatsapp_enabled && settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
      const { sendWA } = await import('../services/whatsappBot.mjs');
      const selectedPkg = packages.find(p => p.id.toString() === package_id.toString());
      const pkgName = selectedPkg ? selectedPkg.name : 'Tidak diketahui';
      
      const adminMsg = `🔔 *PENDAFTARAN BARU*\n\nAda calon pelanggan baru yang mendaftar via web:\n\n👤 *Nama:* ${name}\n📞 *WA:* ${phone}\n📍 *Alamat:* ${address}\n📦 *Paket:* ${pkgName}\n\nSilakan cek di panel Admin untuk menindaklanjuti.`;
      
      for (const adminPhone of settings.whatsapp_admin_numbers) {
        try { await sendWA(adminPhone, adminMsg); } catch(e) { /* ignore */ }
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
  
  console.log(`[Login] Attempting login for phone: ${phone}`);

  // 1. Try to find device by Tag directly (old behavior)
  let device = await findDeviceByTag(phone);
  let effectiveTag = phone;

  if (device) {
    console.log(`[Login] Device found directly by tag: ${device._id}`);
  }

  // 2. If not found, try to find in Billing DB by phone
  if (!device) {
    console.log(`[Login] Device not found by tag. Checking Billing DB...`);
    const customers = customerSvc.getAllCustomers();
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Search for customer in DB
    const customer = customers.find(c => {
      const dbPhone = (c.phone || '').replace(/\D/g, '');
      // Match if the last 10 digits are the same (common for ID numbers)
      if (cleanPhone.length >= 10 && dbPhone.length >= 10) {
        return cleanPhone.slice(-10) === dbPhone.slice(-10);
      }
      return dbPhone === cleanPhone || c.phone === phone;
    });

    if (customer) {
      console.log(`[Login] Customer found in DB: ${customer.name}, PPPoE: ${customer.pppoe_username}`);
      if (customer.pppoe_username) {
        // 3. If found in DB, try to find device by PPPoE Username in GenieACS
        device = await findDeviceByPppoe(customer.pppoe_username);
        if (device) {
          console.log(`[Login] Device found in GenieACS by PPPoE: ${device._id}`);
          effectiveTag = device._id;
        } else {
          console.log(`[Login] Device NOT found in GenieACS for PPPoE: ${customer.pppoe_username}`);
        }
      } else {
        console.log(`[Login] Customer found in DB but has no PPPoE username.`);
      }
    } else {
      console.log(`[Login] Customer NOT found in Billing DB for phone: ${phone}`);
    }
  }

  if (!device) {
    console.log(`[Login] Login failed for ${phone}`);
    return res.render('login', { error: 'Nomor telepon atau perangkat tidak ditemukan.', settings });
  }

  // --- OTP LOGIC ---
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

    console.log(`[Login] OTP Generated for ${phone}: ${otp}`);

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

        console.log(`[Login] OTP sent to ${phone} via WA`);
      } catch (e) {
        console.error(`[Login] Failed to send OTP via WA:`, e.message);
        return res.render('login', { error: e.message, settings });
      }
    }

    return res.redirect('/customer/login-otp');
  }

  // --- DIRECT LOGIN ---
  console.log(`[Login] Login successful (Direct). Using session ID: ${effectiveTag}`);
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
    console.log(`[Login] OTP verified for ${pending.phone}. Using session ID: ${pending.effectiveTag}`);
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
  let phoneForBilling = loginId;
  if (deviceData && deviceData.pppoeUsername) {
    const custByPppoe = customerSvc.getAllCustomers().find(c => c.pppoe_username === deviceData.pppoeUsername);
    if (custByPppoe) phoneForBilling = custByPppoe.phone;
  }
  
  const invoices = billingSvc.getInvoicesByPhone(phoneForBilling);
  const profile = customerSvc.getAllCustomers().find(c => {
    const cleanLogin = loginId.replace(/\D/g, '');
    const cleanDb = (c.phone || '').replace(/\D/g, '');
    return cleanDb === cleanLogin || c.phone === loginId || c.pppoe_username === (deviceData ? deviceData.pppoeUsername : null);
  });
  
  // Ambil tiket keluhan pelanggan
  let tickets = [];
  if (profile) {
    tickets = ticketSvc.getTicketsByCustomerId(profile.id);
  }

  const settings = getSettingsWithCache();
  let paymentChannels = [];
  if (settings.default_gateway === 'tripay' && settings.tripay_enabled) {
    paymentChannels = await paymentSvc.getTripayChannels();
  }

  res.render('dashboard', {
    customer: deviceData || fallbackCustomer(loginId),
    profile: profile || null,
    invoices: invoices || [],
    tickets: tickets || [],
    settings,
    paymentChannels,
    connectedUsers: deviceData ? deviceData.connectedUsers : [],
    notif: msgNotif || (deviceData ? null : dashboardNotif('Data perangkat tidak ditemukan di sistem ONU.', 'warning'))
  });
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
  if (!newTag || newTag === oldTag) {
    const data = await getCustomerDeviceData(oldTag);
    return res.render('dashboard', {
      customer: data || fallbackCustomer(oldTag),
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
  } else {
    notif = dashboardNotif(tagResult.message || 'Gagal mengubah ID/Tag pelanggan.', 'danger');
  }
  const deviceData = await getCustomerDeviceData(resolvedPhone);
  let phoneForBilling = resolvedPhone;
  if (deviceData && deviceData.pppoeUsername) {
    const custByPppoe = customerSvc.getAllCustomers().find(c => c.pppoe_username === deviceData.pppoeUsername);
    if (custByPppoe) phoneForBilling = custByPppoe.phone;
  }
  const invoices = billingSvc.getInvoicesByPhone(phoneForBilling);
  const profile = customerSvc.getAllCustomers().find(c => {
    const cleanLogin = resolvedPhone.replace(/\D/g, '');
    const cleanDb = (c.phone || '').replace(/\D/g, '');
    return cleanDb === cleanLogin || c.phone === resolvedPhone || c.pppoe_username === (deviceData ? deviceData.pppoeUsername : null);
  });

  res.render('dashboard', {
    customer: deviceData || fallbackCustomer(resolvedPhone),
    profile: profile || null,
    invoices: invoices || [],
    connectedUsers: deviceData ? deviceData.connectedUsers : [],
    notif
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/customer/login');
  });
});

const ticketSvc = require('../services/ticketService');

// ─── TICKETS / KELUHAN ─────────────────────────────────────────────────────
router.post('/tickets/create', (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.redirect('/customer/login');
  
  const { subject, message, customerId } = req.body;
  if (!subject || !message || !customerId) {
    req.session._msg = { type: 'danger', text: 'Semua field harus diisi.' };
    return res.redirect('/customer/dashboard');
  }

  try {
    ticketSvc.createTicket(customerId, subject, message);
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dikirim. Tim teknisi akan segera mengeceknya.' };
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

    // Cek apakah sudah ada link pembayaran yang aktif (belum expire)
    if (inv.payment_link && inv.payment_expires_at) {
      const expiresAt = new Date(inv.payment_expires_at).getTime();
      if (expiresAt > Date.now()) {
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
      // Simpan info pembayaran ke database
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // Default 24 jam
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
  let invoiceId = null;
  let status = null;
  let gateway = null;

  // --- DETEKSI TRIPAY ---
  if (tripaySignature) {
    if (paymentSvc.verifyTripayWebhook(jsonBody, tripaySignature, settings.tripay_private_key)) {
      const { merchant_ref, status: tpStatus } = req.body;
      const parts = merchant_ref.split('-');
      invoiceId = parts[1];
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
      const parts = order_id.split('-');
      invoiceId = parts[1];
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
      const parts = external_id.split('-');
      invoiceId = parts[1];
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
      const parts = merchantOrderId.split('-');
      invoiceId = parts[1];
      status = resultCode === '00' ? 'paid' : resultCode;
      gateway = 'Duitku';
    } else {
      logger.error('[Webhook] Signature Duitku tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  }

  if (invoiceId && status === 'paid') {
    logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Invoice ID: ${invoiceId}`);
    
    // Cek apakah sudah lunas sebelumnya
    const checkInv = billingSvc.getInvoiceById(invoiceId);
    if (checkInv && checkInv.status !== 'paid') {
      // 1. Mark as paid in DB
      billingSvc.markAsPaid(invoiceId, gateway, `Otomatis via Webhook ${gateway}`);

      // 2. Un-isolate if needed
      const customer = customerSvc.getCustomerById(checkInv.customer_id);
      
      // Kirim Notifikasi WA Lunas
      try {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const msg = `✅ *PEMBAYARAN BERHASIL*\n\nTerima kasih Kak *${customer.name}*,\n\nPembayaran tagihan internet periode *${checkInv.period_month}/${checkInv.period_year}* telah kami terima via *${gateway}*.\n\n💰 *Total:* Rp ${checkInv.amount.toLocaleString('id-ID')}\n📅 *Waktu:* ${new Date().toLocaleString('id-ID')}\n\nStatus layanan Anda kini telah aktif. Selamat berinternet kembali! 🚀`;
        await sendWA(customer.phone, msg);
      } catch (waErr) {
        logger.error(`[Webhook] Gagal kirim notif WA: ${waErr.message}`);
      }

      // Logic Re-aktivasi otomatis jika pelanggan isolir
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
