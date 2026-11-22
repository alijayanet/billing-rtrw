/**
 * Token utility untuk public payment tokens
 * Digunakan untuk polling status pembayaran tanpa memerlukan session login
 */
const crypto = require('crypto');

let runtimeTokenSecret = null;

/**
 * Memastikan secret yang digunakan kuat dan bukan default publik
 */
function resolveSecureSecret(secret) {
  const s = String(secret || '').trim();
  const insecure = new Set([
    '',
    'default-secret',
    'change-this-to-random-secret-key',
    'rahasia-portal-pelanggan-default-ganti-ini',
    'rahasia-api-pelanggan-alijaya-default',
    'your-session-secret',
    'secret'
  ]);

  if (!s || insecure.has(s)) {
    if (!runtimeTokenSecret) {
      runtimeTokenSecret = crypto.randomBytes(32).toString('hex');
    }
    return runtimeTokenSecret;
  }
  return s;
}

/**
 * Sign public token untuk payment (HMAC-SHA256)
 * @param {Object} payload - Data: {invoiceId, customerId, lookup, exp}
 * @param {string} secret - Session secret
 * @returns {string} Base64-encoded token
 */
function signPublicToken(payload, secret) {
  try {
    const effectiveSecret = resolveSecureSecret(secret);
    const json = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', effectiveSecret)
      .update(json)
      .digest('hex');
    
    const tokenData = {
      data: json,
      sig: signature
    };
    
    return Buffer.from(JSON.stringify(tokenData)).toString('base64');
  } catch (e) {
    console.error('[signPublicToken] Error:', e.message);
    return '';
  }
}

/**
 * Verify public token dengan proteksi Constant-Time (Timing Attack Safe)
 * @param {string} token - Base64-encoded token
 * @param {string} secret - Session secret
 * @returns {Object|null} Payload if valid, null if invalid/expired
 */
function verifyPublicToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const effectiveSecret = resolveSecureSecret(secret);
    
    // Normalisasi base64 dan url-safe base64
    let base64Str = token.trim().replace(/-/g, '+').replace(/_/g, '/');
    while (base64Str.length % 4) {
      base64Str += '=';
    }
    
    const decoded = Buffer.from(base64Str, 'base64').toString('utf8');
    const tokenData = JSON.parse(decoded);
    
    const { data, sig } = tokenData;
    if (!data || !sig || typeof sig !== 'string') {
      return null;
    }

    const expectedSig = crypto
      .createHmac('sha256', effectiveSecret)
      .update(data)
      .digest('hex');
    
    // Constant-time comparison untuk mencegah Timing Attack
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expectedBuf.length) {
      return null;
    }
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    
    const payload = JSON.parse(data);
    
    // Check expiry
    if (payload.exp && Date.now() > Number(payload.exp)) {
      return null;
    }
    
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = {
  signPublicToken,
  verifyPublicToken
};
