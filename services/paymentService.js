/**
 * Service: Integrasi Payment Gateway (Multi-Gateway)
 * Diadaptasi dari alur gembok-simple
 */
const axios = require('axios');
const crypto = require('crypto');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');

/**
 * Generate fallback email based on phone number
 */
function getFallbackEmail(phone) {
  const digits = phone.replace(/\D/g, '');
  return `cust${digits}@alijaya.net`;
}

/**
 * Normalize phone number for Payment Gateway
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (!digits.startsWith('62')) {
    digits = '62' + digits;
  }
  return digits;
}

/**
 * Tripay: Membuat Transaksi
 */
async function createTripayTransaction(invoice, customer, method = 'QRIS', appUrl = '') {
  const settings = getSettingsWithCache();
  const apiKey = settings.tripay_api_key;
  const privateKey = settings.tripay_private_key;
  const merchantCode = settings.tripay_merchant_code;
  const isLive = settings.tripay_mode === 'live' || settings.tripay_mode === 'production';
  
  const baseUrl = isLive 
    ? 'https://tripay.co.id/api/transaction/create' 
    : 'https://tripay.co.id/api-sandbox/transaction/create';

  const merchantRef = `INV-${invoice.id}-${Date.now()}`;
  const amount = invoice.amount;

  const signature = crypto.createHmac('sha256', privateKey)
    .update(merchantCode + merchantRef + amount)
    .digest('hex');

  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);

  const payload = {
    method: method,
    merchant_ref: merchantRef,
    amount: amount,
    customer_name: customer.name || 'Pelanggan',
    customer_email: email,
    customer_phone: phone,
    order_items: [
      {
        sku: 'INTERNET-' + invoice.id,
        name: `Tagihan Internet Periode ${invoice.period_month}/${invoice.period_year}`,
        price: amount,
        quantity: 1
      }
    ],
    signature: signature,
    callback_url: finalAppUrl ? `${finalAppUrl}/customer/payment/callback` : undefined,
    return_url: finalAppUrl ? `${finalAppUrl}/customer/dashboard` : undefined
  };

  try {
    const res = await axios.post(baseUrl, payload, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    
    if (res.data && res.data.success) {
      return {
        success: true,
        link: res.data.data.checkout_url,
        reference: res.data.data.reference,
        order_id: merchantRef,
        payload: res.data.data
      };
    }
    throw new Error(res.data.message || 'Gagal membuat transaksi');
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Tripay] Error:', msg);
    throw new Error('Tripay Error: ' + msg);
  }
}

/**
 * Midtrans: Membuat Transaksi (Snap)
 */
async function createMidtransTransaction(invoice, customer, method = 'snap', appUrl = '') {
  const settings = getSettingsWithCache();
  const serverKey = settings.midtrans_server_key;
  const isLive = settings.midtrans_mode === 'live' || settings.midtrans_mode === 'production';
  
  if (!serverKey) {
    throw new Error('Midtrans Server Key belum diatur di pengaturan.');
  }

  const baseUrl = isLive
    ? 'https://app.midtrans.com/snap/v1/transactions'
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

  const orderId = `INV-${invoice.id}-${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);
  
  const payload = {
    transaction_details: {
      order_id: orderId,
      gross_amount: invoice.amount
    },
    customer_details: {
      first_name: customer.name,
      email: email,
      phone: phone
    },
    item_details: [{
      id: 'INV-' + invoice.id,
      price: invoice.amount,
      quantity: 1,
      name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`
    }]
  };

  // Jika method bukan 'snap', kita batasi pembayarannya
  if (method !== 'snap') {
    const methodMap = {
      'QRIS': ['gopay', 'qris'],
      'MANDIRIVA': ['echannel'],
      'BRIVA': ['bri_va'],
      'BNIVA': ['bni_va'],
      'BCAVA': ['bca_va'],
      'PERMATAVA': ['permata_va']
    };
    if (methodMap[method]) {
      payload.enabled_payments = methodMap[method];
    }
  }

  if (finalAppUrl) {
    payload.callbacks = {
      finish: `${finalAppUrl}/customer/dashboard`,
      error: `${finalAppUrl}/customer/dashboard`,
      pending: `${finalAppUrl}/customer/dashboard`
    };
  }

  const auth = Buffer.from(serverKey + ':').toString('base64');

  try {
    const res = await axios.post(baseUrl, payload, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });

    return {
      success: true,
      link: res.data.redirect_url,
      reference: res.data.token,
      order_id: orderId,
      payload: res.data
    };
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Midtrans] Error:', msg);
    throw new Error('Midtrans Error: ' + msg);
  }
}

/**
 * Xendit: Membuat Invoice (Checkout Link)
 */
async function createXenditTransaction(invoice, customer, method = 'xendit', appUrl = '') {
  const settings = getSettingsWithCache();
  const apiKey = settings.xendit_api_key;
  
  if (!apiKey) {
    throw new Error('Xendit API Key belum diatur di pengaturan.');
  }

  const orderId = `INV-${invoice.id}-${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);

  const payload = {
    external_id: orderId,
    amount: invoice.amount,
    description: `Tagihan Internet Periode ${invoice.period_month}/${invoice.period_year}`,
    invoice_duration: 86400, // 24 jam
    customer: {
      given_names: customer.name,
      email: email,
      mobile_number: phone
    },
    success_redirect_url: `${finalAppUrl}/customer/dashboard`,
    failure_redirect_url: `${finalAppUrl}/customer/dashboard`,
    currency: 'IDR',
    items: [{
      name: `Internet ${invoice.period_month}/${invoice.period_year}`,
      quantity: 1,
      price: invoice.amount
    }]
  };

  // Jika user memilih metode spesifik di Xendit
  if (method !== 'xendit') {
    const methodMap = {
      'QRIS': ['QRIS'],
      'MANDIRIVA': ['MANDIRI'],
      'BRIVA': ['BRI'],
      'BNIVA': ['BNI'],
      'BCAVA': ['BCA'],
      'PERMATAVA': ['PERMATA']
    };
    if (methodMap[method]) {
      payload.payment_methods = methodMap[method];
    }
  }

  const auth = Buffer.from(apiKey + ':').toString('base64');

  try {
    const res = await axios.post('https://api.xendit.co/v2/invoices', payload, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      link: res.data.invoice_url,
      reference: res.data.id,
      order_id: orderId,
      payload: res.data
    };
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Xendit] Error:', msg);
    throw new Error('Xendit Error: ' + msg);
  }
}

/**
 * Duitku: Membuat Transaksi (Checkout Link via Inquiry)
 */
async function createDuitkuTransaction(invoice, customer, method = 'duitku', appUrl = '') {
  const settings = getSettingsWithCache();
  const merchantCode = settings.duitku_merchant_code;
  const apiKey = settings.duitku_api_key;
  const isLive = settings.duitku_mode === 'live' || settings.duitku_mode === 'production';
  
  if (!merchantCode || !apiKey) {
    throw new Error('Duitku Merchant Code atau API Key belum diatur.');
  }

  const baseUrl = isLive 
    ? 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry'
    : 'https://passport-sandbox.duitku.com/webapi/api/merchant/v2/inquiry';

  const orderId = `INV-${invoice.id}-${Date.now()}`;
  const amount = invoice.amount;
  const finalAppUrl = appUrl || settings.app_url || '';

  // Signature: md5(merchantCode + merchantOrderId + paymentAmount + apiKey)
  const signature = crypto.createHash('md5')
    .update(merchantCode + orderId + amount + apiKey)
    .digest('hex');

  const payload = {
    merchantCode,
    paymentAmount: amount,
    merchantOrderId: orderId,
    productDetails: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`,
    email: customer.email || getFallbackEmail(customer.phone),
    phoneNumber: normalizePhone(customer.phone),
    customerVaName: customer.name,
    callbackUrl: `${finalAppUrl}/customer/payment/callback`,
    returnUrl: `${finalAppUrl}/customer/dashboard`,
    signature,
    expiryPeriod: 1440 // 24 jam
  };

  // Jika user memilih metode spesifik di Duitku
  if (method !== 'duitku') {
    const methodMap = {
      'QRIS': 'DQ',
      'MANDIRIVA': 'M2',
      'BRIVA': 'BR',
      'BNIVA': 'I1',
      'BCAVA': 'BC',
      'PERMATAVA': 'BT'
    };
    if (methodMap[method]) {
      payload.paymentMethod = methodMap[method];
    }
  }

  try {
    const res = await axios.post(baseUrl, payload);
    if (res.data && res.data.paymentUrl) {
      return {
        success: true,
        link: res.data.paymentUrl,
        reference: res.data.reference || orderId,
        order_id: orderId,
        payload: res.data
      };
    }
    throw new Error(res.data.statusMessage || 'Gagal mendapatkan payment URL dari Duitku');
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Duitku] Error:', msg);
    throw new Error('Duitku Error: ' + msg);
  }
}

/**
 * Verifikasi Webhook Signature (Tripay)
 */
function verifyTripayWebhook(jsonBody, signature, privateKey) {
  const callbackSignature = crypto.createHmac('sha256', privateKey)
    .update(jsonBody)
    .digest('hex');
  return callbackSignature === signature;
}

/**
 * Verifikasi Webhook Signature (Midtrans)
 */
function verifyMidtransWebhook(body, serverKey) {
  const { order_id, status_code, gross_amount, signature_key } = body;
  const hash = crypto.createHash('sha512')
    .update(order_id + status_code + gross_amount + serverKey)
    .digest('hex');
  return hash === signature_key;
}

/**
 * Verifikasi Webhook Signature (Duitku)
 */
function verifyDuitkuWebhook(body, apiKey) {
  const { merchantCode, amount, merchantOrderId, signature } = body;
  const hash = crypto.createHash('md5')
    .update(merchantCode + amount + merchantOrderId + apiKey)
    .digest('hex');
  return hash === signature;
}

/**
 * Tripay: Mendapatkan Daftar Metode Pembayaran Aktif
 */
async function getTripayChannels() {
  const settings = getSettingsWithCache();
  const apiKey = settings.tripay_api_key;
  const isLive = settings.tripay_mode === 'live' || settings.tripay_mode === 'production';
  
  const baseUrl = isLive 
    ? 'https://tripay.co.id/api/merchant/payment-channel' 
    : 'https://tripay.co.id/api-sandbox/merchant/payment-channel';

  try {
    const res = await axios.get(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return res.data.success ? res.data.data : [];
  } catch (error) {
    logger.error('[Tripay] Gagal ambil channel:', error.message);
    return [];
  }
}

module.exports = {
  createTripayTransaction,
  createMidtransTransaction,
  createXenditTransaction,
  createDuitkuTransaction,
  getTripayChannels,
  verifyTripayWebhook,
  verifyMidtransWebhook,
  verifyDuitkuWebhook,
  getFallbackEmail
};
