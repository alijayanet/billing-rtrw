const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

let runtimeSessionSecret = null;
function getSecureSessionSecretFallback() {
  if (!runtimeSessionSecret) {
    runtimeSessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return runtimeSessionSecret;
}

// Cache untuk settings dengan timestamp
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_DURATION = 2000; // 2 detik

// File system watcher untuk auto-reload settings
const settingsPath = path.join(__dirname, '../settings.json');
let watcher = null;

// Helper untuk baca settings.json secara dinamis
function getSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) || {};
    
    // Secure fallback for session_secret
    const insecureSecrets = new Set([
      '',
      'change-this-to-random-secret-key',
      'rahasia-portal-pelanggan-default-ganti-ini',
      'rahasia-api-pelanggan-alijaya-default',
      'your-session-secret',
      'secret',
      'session-secret'
    ]);
    if (!settings.session_secret || insecureSecrets.has(String(settings.session_secret).trim())) {
      settings.session_secret = getSecureSessionSecretFallback();
    }

    // Sanitasi QRIS Payload secara real-time (Cegah pembajakan QRIS oleh penyerang)
    const authenticQrisPayload = '00020101021126570011ID.DANA.WWW011893600915346519740402094651974040303UMI51440014ID.CO.QRIS.WWW0215ID10232708012520303UMI5204549953033605802ID5907ALIJAYA6014Kab. Indramayu6105452576304E962';
    const rawQris = String(settings.qris_static_payload || '');
    if (rawQris.includes('Boku Labs') || rawQris.includes('ID1026517082354') || rawQris.includes('COM.GO-JEK.WWW') || rawQris.includes('G563443239') || rawQris.toLowerCase().includes('tipzy')) {
      settings.qris_static_payload = authenticQrisPayload;
      try {
        const diskSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        diskSettings.qris_static_payload = authenticQrisPayload;
        fs.writeFileSync(settingsPath, JSON.stringify(diskSettings, null, 2), 'utf-8');
      } catch (_) {}
    }

    const fallbackTz = 'Asia/Jakarta';
    const tz = typeof settings.timezone === 'string' ? settings.timezone.trim() : '';

    if (!tz) {
      settings.timezone = fallbackTz;
      return settings;
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      settings.timezone = tz;
    } catch (e) {
      settings.timezone = fallbackTz;
    }

    return settings;
  } catch (error) {
    logger.error(`[settings] Error reading settings.json: ${error.message}`);
    return {};
  }
}

// Helper untuk baca settings.json dengan cache
function getSettingsWithCache() {
  const now = Date.now();
  if (!settingsCache || (now - settingsCacheTime) > CACHE_DURATION) {
    settingsCache = getSettings();
    settingsCacheTime = now;
  }
  return settingsCache;
}

// Helper untuk mendapatkan nilai setting dengan fallback
function getSetting(key, defaultValue = null) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

// Helper untuk mendapatkan multiple settings
function getSettingsByKeys(keys) {
  const settings = getSettingsWithCache();
  const result = {};
  keys.forEach(key => {
    result[key] = settings[key];
  });
  return result;
}

// File system watcher untuk auto-reload settings
function startSettingsWatcher() {
  try {
    // Hapus watcher lama jika ada
    if (watcher) {
      watcher.close();
    }
    
    // Buat watcher baru
    watcher = fs.watch(settingsPath, (eventType, filename) => {
      if (eventType !== 'change') return;
      // Di Windows `filename` sering null; hanya abaikan jika jelas bukan settings.json
      if (filename != null && filename !== 'settings.json') return;

      settingsCache = null;
      settingsCacheTime = 0;

      try {
        const s = getSettingsWithCache();
        const port = s.server_port ?? 4555;
        const host = s.server_host || 'localhost';
        const gurl = s.genieacs_url || '(tidak diatur)';
        const company = s.company_header || '(default)';
        logger.info(`[settings] settings.json dimuat ulang — port ${port}, host ${host}, company: ${company}, GenieACS: ${gurl}`);
      } catch (error) {
        logger.error(`[settings] Gagal memuat ulang settings.json: ${error.message}`);
      }
    });

    logger.info('[settings] Memantau perubahan settings.json');
  } catch (error) {
    logger.error(`[settings] Error starting settings watcher: ${error.message}`);
  }
}

// Mulai watcher saat modul dimuat
startSettingsWatcher();

// Menyimpan pengaturan ke settings.json
function saveSettings(newSettings) {
  try {
    const currentSettings = getSettings();
    const updatedSettings = { ...currentSettings, ...newSettings };
    fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2), 'utf-8');
    settingsCache = updatedSettings;
    settingsCacheTime = Date.now();
    return true;
  } catch (error) {
    logger.error(`[settings] Error saving settings.json: ${error.message}`);
    return false;
  }
}

/**
 * Helper untuk mendapatkan waktu sekarang dalam format lokal
 * sesuai timezone yang diatur di settings.json
 */
function getNowLocal() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  const options = {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23' // 💡 Paksa format jam 00-23 (mencegah bug '24' di tengah malam)
  };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Helper untuk mendapatkan objek Date yang sudah disesuaikan dengan timezone di settings.
 * Mengembalikan objek Date yang "angkanya" sudah sesuai dengan waktu lokal.
 */
function getCurrentDateInTimezone() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  
  // Ambil string format ISO lokal
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' // 💡 Paksa format jam 00-23 (mencegah bug '24' di tengah malam)
  });
  
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  
  // Buat objek Date baru dengan nilai lokal tersebut
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

/**
 * Mendapatkan info waktu sekarang (year, month, day, dll) dalam timezone yang diatur.
 */
function getCurrentTimeInfo() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23' // 💡 Paksa format jam 00-23 (mencegah bug '24' di tengah malam)
  });

  
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  
  return {
    year: parseInt(p.year),
    month: parseInt(p.month),
    day: parseInt(p.day),
    hour: parseInt(p.hour),
    minute: parseInt(p.minute),
    second: parseInt(p.second)
  };
}

/**
 * Mendapatkan string ISO-like tapi dalam waktu lokal (bukan UTC).
 * Berguna untuk timestamp log/backup.
 */
function getNowLocalISO() {
  const info = getCurrentTimeInfo();
  const pad = (n) => String(n).padStart(2, '0');
  return `${info.year}-${pad(info.month)}-${pad(info.day)}T${pad(info.hour)}:${pad(info.minute)}:${pad(info.second)}`;
}

/**
 * Memparse string tanggal (YYYY-MM-DD HH:mm:ss) menjadi objek Date
 * dengan asumsi string tersebut adalah waktu lokal sesuai setting timezone.
 */
function parseDateInTimezone(dateStr) {
  if (!dateStr) return null;
  const tz = getSetting('timezone', 'Asia/Jakarta');
  
  const date = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(date.getTime())) return null;

  const localDateStr = date.toLocaleString('en-US', { timeZone: tz, hourCycle: 'h23' });
  const localDate = new Date(localDateStr);
  const diff = localDate.getTime() - date.getTime();
  
  return new Date(date.getTime() - diff);
}

function formatDateLocal(date) {
  if (!date) return '-';
  const tz = getSetting('timezone', 'Asia/Jakarta');
  let d;
  if (typeof date === 'string') {
    d = parseDateInTimezone(date);
  } else {
    d = typeof date === 'number' ? new Date(date) : date;
  }
  if (!d || isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { timeZone: tz });
}

/**
 * Helper untuk memformat objek Date menjadi string waktu lokal (hanya Jam:Menit)
 */
function formatTimeLocal(date) {
  if (!date) return '-';
  const tz = getSetting('timezone', 'Asia/Jakarta');
  let d;
  if (typeof date === 'string') {
    d = parseDateInTimezone(date);
  } else {
    d = typeof date === 'number' ? new Date(date) : date;
  }
  if (!d || isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/**
 * Memastikan semua setting wajib ada di settings.json dengan default value.
 * Dijalankan saat startup aplikasi untuk migrasi/inisialisasi setting baru.
 */
function ensureDefaultSettings() {
  try {
    const currentSettings = getSettings();
    let needsSave = false;
    
    // Default settings yang wajib ada
    const defaultSettings = {
      // RADIUS Server settings (ditambahkan untuk update dari GitHub)
      radius_enabled: '0',
      radius_secret: 'secret123',
      radius_auth_port: '1812',
      radius_acct_port: '1813',
      radius_isolir_action: 'pool',
      radius_isolir_pool: 'isolir',
      radius_limit_simultaneous: '1',
      radius_default_rate_limit: '5M/10M',
      radius_isolir_rate_limit: '512k/512k',
      radius_isolir_ip_pool_enabled: '1',
      radius_isolir_ip_pool_start: '10.10.99.2',
      radius_isolir_ip_pool_end: '10.10.99.254',
      radius_ip_pool_enabled: '1',
      radius_ip_pool_start: '10.10.10.2',
      radius_ip_pool_end: '10.10.10.254',
      radius_framed_pool: 'pool-pppoe',
      radius_send_group: '0',
      telegram_group_ai_enabled: true,
      telegram_welcome_enabled: true,
      ai_provider: 'gemini',
      gemini_api_key: '',
      openai_api_key: '',
      openai_model: 'gpt-4o-mini',
      deepseek_api_key: '',
      deepseek_model: 'deepseek-chat',
      groq_api_key: '',
      groq_model: 'llama-3.3-70b-versatile',
      openrouter_api_key: '',
      openrouter_model: 'meta-llama/llama-3.3-70b-instruct',
      custom_ai_api_key: '',
      custom_ai_base_url: '',
      custom_ai_model: '',
      telegram_welcome_msg: '',
      whatsapp_ai_enabled: true
    };
    
    // Cek dan tambahkan setting yang belum ada
    for (const [key, defaultValue] of Object.entries(defaultSettings)) {
      if (currentSettings[key] === undefined) {
        currentSettings[key] = defaultValue;
        needsSave = true;
        logger.info(`[settings] Added missing setting: ${key} = ${defaultValue}`);
      }
    }

    // Security Hardening: Otomatis buat webhook_secret acak jika masih kosong atau default bocor
    if (!currentSettings.webhook_secret || currentSettings.webhook_secret === 'billing-rtrw-secret-key') {
      const crypto = require('crypto');
      currentSettings.webhook_secret = crypto.randomBytes(16).toString('hex');
      needsSave = true;
      logger.info('[settings] Auto-generated secure random webhook_secret for security hardening');
    }

    // Security Hardening: Otomatis buat session_secret acak (64-char hex) jika default/bocor/lemah
    const insecureSessionSecrets = new Set([
      '',
      'change-this-to-random-secret-key',
      'rahasia-portal-pelanggan-default-ganti-ini',
      'rahasia-api-pelanggan-alijaya-default',
      'your-session-secret',
      'secret',
      'session-secret'
    ]);
    if (!currentSettings.session_secret || insecureSessionSecrets.has(String(currentSettings.session_secret).trim())) {
      const crypto = require('crypto');
      currentSettings.session_secret = crypto.randomBytes(32).toString('hex');
      needsSave = true;
      logger.info('[settings] Auto-generated secure random 64-char hex session_secret for security hardening');
    }

    // Security Hardening: Deteksi dan bersihkan QRIS palsu penyerang (Boku Labs / GoPay / Tipzy / ID1026517082354)
    const authenticQrisPayload = '00020101021126570011ID.DANA.WWW011893600915346519740402094651974040303UMI51440014ID.CO.QRIS.WWW0215ID10232708012520303UMI5204549953033605802ID5907ALIJAYA6014Kab. Indramayu6105452576304E962';
    const rawPayload = String(currentSettings.qris_static_payload || '');
    if (rawPayload.includes('Boku Labs') || rawPayload.includes('ID1026517082354') || rawPayload.includes('COM.GO-JEK.WWW') || rawPayload.includes('G563443239') || rawPayload.toLowerCase().includes('tipzy')) {
      currentSettings.qris_static_payload = authenticQrisPayload;
      needsSave = true;
      logger.warn('[Security] Terdeteksi QRIS palsu penyerang (Boku Labs / Tipzy)! Otomatis dikembalikan ke QRIS resmi ALIJAYA NET.');
    }
    
    // Simpan jika ada perubahan
    if (needsSave) {
      fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf-8');
      settingsCache = currentSettings;
      settingsCacheTime = Date.now();
      logger.info('[settings] settings.json updated with default RADIUS settings');
    }
    
    return needsSave;
  } catch (error) {
    logger.error(`[settings] Error ensuring default settings: ${error.message}`);
    return false;
  }
}

module.exports = {
  getSettings,
  getSettingsWithCache,
  getSetting,
  getSettingsByKeys,
  saveSettings,
  getNowLocal,
  formatDateLocal,
  formatTimeLocal,
  getCurrentDateInTimezone,
  getCurrentTimeInfo,
  getNowLocalISO,
  parseDateInTimezone,
  startSettingsWatcher,
  ensureDefaultSettings
};
