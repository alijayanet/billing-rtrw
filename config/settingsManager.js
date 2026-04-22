const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

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
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
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

module.exports = {
  getSettings,
  getSettingsWithCache,
  getSetting,
  getSettingsByKeys,
  saveSettings,
  startSettingsWatcher
}; 
