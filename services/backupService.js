/**
 * Service: Backup & Recovery System
 * Melakukan backup & restore otomatis database dan settings secara aman dan andal
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { logger } = require('../config/logger');
const { getSetting, getCurrentDateInTimezone, getNowLocalISO } = require('../config/settingsManager');

const projectRoot = path.join(__dirname, '..');
const backupDir = path.join(projectRoot, 'backups');
const dbPath = path.join(projectRoot, 'database', 'billing.db');
const settingsPath = path.join(projectRoot, 'settings.json');

// Pastikan direktori backup ada
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

/**
 * Generate timestamp untuk nama file backup (YYYYMMDD_HHMMSS)
 */
function getBackupTimestamp() {
  const now = getCurrentDateInTimezone();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Backup database SQLite dengan WAL Checkpoint & Atomic Online Backup
 */
async function backupDatabase() {
  try {
    const timestamp = getBackupTimestamp();
    const backupFileName = `billing_db_${timestamp}.db`;
    const backupFilePath = path.join(backupDir, backupFileName);

    // 1. Flush transaksi yang ada di WAL (Write-Ahead Log) ke file database utama
    try {
      const db = require('../config/database');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (chkErr) {
      logger.warn('[Backup] Checkpoint WAL warning: ' + chkErr.message);
    }

    // 2. Gunakan SQLite Online Backup API bawaan better-sqlite3 jika tersedia
    const db = require('../config/database');
    if (typeof db.backup === 'function') {
      await db.backup(backupFilePath);
    } else {
      fs.copyFileSync(dbPath, backupFilePath);
    }

    const stats = fs.statSync(backupFilePath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Database backup created: ${backupFileName} (${sizeKB} KB)`);
    
    return {
      success: true,
      fileName: backupFileName,
      size: stats.size,
      timestamp: getNowLocalISO()
    };
  } catch (e) {
    logger.error(`[Backup] Failed to backup database: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Backup settings.json
 */
function backupSettings() {
  try {
    const timestamp = getBackupTimestamp();
    const backupFileName = `settings_${timestamp}.json`;
    const backupFilePath = path.join(backupDir, backupFileName);

    fs.copyFileSync(settingsPath, backupFilePath);

    const stats = fs.statSync(backupFilePath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Settings backup created: ${backupFileName} (${sizeKB} KB)`);
    
    return {
      success: true,
      fileName: backupFileName,
      size: stats.size,
      timestamp: getNowLocalISO()
    };
  } catch (e) {
    logger.error(`[Backup] Failed to backup settings: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Backup semua (database + settings)
 */
async function backupAll() {
  const dbResult = await backupDatabase();
  const settingsResult = backupSettings();

  const success = Boolean(dbResult.success && settingsResult.success);
  const fileNames = [dbResult.fileName, settingsResult.fileName].filter(Boolean).join(', ');

  return {
    success,
    database: dbResult,
    settings: settingsResult,
    fileName: fileNames,
    timestamp: getNowLocalISO(),
    error: (!success) ? [dbResult.error, settingsResult.error].filter(Boolean).join('; ') : null
  };
}

/**
 * Restore database dari backup
 */
async function restoreDatabase(backupFileName) {
  let testDb = null;
  try {
    const safeName = path.basename(backupFileName);
    const backupFilePath = path.join(backupDir, safeName);

    // Cek apakah file backup ada
    if (!fs.existsSync(backupFilePath)) {
      return {
        success: false,
        error: `File backup tidak ditemukan: ${safeName}`
      };
    }

    // 1. Verifikasi integritas SQLite database sebelum merestore
    try {
      testDb = new Database(backupFilePath, { readonly: true, fileMustExist: true });
      const check = testDb.pragma('integrity_check');
      if (!check || check.length === 0 || check[0].integrity_check !== 'ok') {
        throw new Error('Integritas SQLite gagal (file backup corrupt).');
      }
      const tableCheck = testDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name IN ('customers', 'invoices', 'users')").get();
      if (!tableCheck || tableCheck.c === 0) {
        throw new Error('Struktur database tidak cocok (tabel sistem billing tidak ditemukan).');
      }
    } catch (valErr) {
      if (testDb) { try { testDb.close(); } catch(_) {} }
      return {
        success: false,
        error: `File backup rusak / tidak valid: ${valErr.message}`
      };
    }

    // 2. Buat backup keselamatan (pre-restore backup) dari database saat ini
    const preRestoreBackup = await backupDatabase();
    if (!preRestoreBackup.success) {
      logger.warn('[Backup] Gagal membuat pre-restore backup: ' + preRestoreBackup.error);
    }

    // 3. Terapkan pemulihan menggunakan SQLite Online Backup API (Aman dari OS file lock & WAL corruption)
    let restoreSuccess = false;
    try {
      if (typeof testDb.backup === 'function') {
        await testDb.backup(dbPath);
        restoreSuccess = true;
      }
    } catch (backupApiErr) {
      logger.warn('[Backup] SQLite backup API restore gagal, mencoba fallback: ' + backupApiErr.message);
    } finally {
      if (testDb) { try { testDb.close(); } catch(_) {} }
      testDb = null;
      // Bersihkan temporary wal/shm backup jika terbentuk saat inspeksi
      try {
        if (fs.existsSync(`${backupFilePath}-wal`)) fs.unlinkSync(`${backupFilePath}-wal`);
        if (fs.existsSync(`${backupFilePath}-shm`)) fs.unlinkSync(`${backupFilePath}-shm`);
      } catch (_) {}
    }

    // Fallback jika backup API tidak tersedia
    if (!restoreSuccess) {
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(walPath)) { try { fs.unlinkSync(walPath); } catch (_) {} }
      if (fs.existsSync(shmPath)) { try { fs.unlinkSync(shmPath); } catch (_) {} }
      fs.copyFileSync(backupFilePath, dbPath);
    }

    // 4. Checkpoint WAL pada database yang baru dipulihkan
    try {
      const activeDb = require('../config/database');
      activeDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_) {}

    const stats = fs.statSync(dbPath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Database restored successfully from: ${safeName} (${sizeKB} KB)`);
    
    // 5. Jadwalkan reload PM2 otomatis jika di lingkungan server produksi
    const isPm2 = process.env.pm_id !== undefined || process.env.PM2_HOME !== undefined;
    if (isPm2) {
      logger.info('[Backup] Menjadwalkan PM2 reload dalam 1.5 detik...');
      setTimeout(() => {
        try {
          const { spawn } = require('child_process');
          spawn('pm2', ['reload', 'billing'], { detached: true, stdio: 'ignore' }).unref();
        } catch (_) {}
      }, 1500);
    }

    return {
      success: true,
      fileName: safeName,
      size: stats.size,
      timestamp: getNowLocalISO(),
      preRestoreBackup: preRestoreBackup.fileName || null,
      isPm2
    };
  } catch (e) {
    if (testDb) { try { testDb.close(); } catch(_) {} }
    logger.error(`[Backup] Failed to restore database: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Restore settings dari backup
 */
function restoreSettings(backupFileName) {
  try {
    const safeName = path.basename(backupFileName);
    const backupFilePath = path.join(backupDir, safeName);

    if (!fs.existsSync(backupFilePath)) {
      return {
        success: false,
        error: `File backup tidak ditemukan: ${safeName}`
      };
    }

    // 1. Verifikasi validitas JSON
    const content = fs.readFileSync(backupFilePath, 'utf8');
    try {
      JSON.parse(content);
    } catch (jsonErr) {
      return {
        success: false,
        error: `File settings tidak valid (JSON error: ${jsonErr.message})`
      };
    }

    // 2. Buat pre-restore backup settings
    const preRestoreBackup = backupSettings();

    // 3. Restore file
    fs.copyFileSync(backupFilePath, settingsPath);

    const stats = fs.statSync(settingsPath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Settings restored from: ${safeName} (${sizeKB} KB)`);
    
    return {
      success: true,
      fileName: safeName,
      size: stats.size,
      timestamp: getNowLocalISO(),
      preRestoreBackup: preRestoreBackup.fileName || null
    };
  } catch (e) {
    logger.error(`[Backup] Failed to restore settings: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Parse timestamp dari nama file backup secara fleksibel
 */
function parseBackupTimestamp(fileName, stats) {
  try {
    // 1. Coba format YYYYMMDD_HHMMSS (e.g. billing_db_20260813_145818.db)
    const m1 = fileName.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (m1) {
      return new Date(m1[1], m1[2] - 1, m1[3], m1[4], m1[5], m1[6]);
    }

    // 2. Coba format ISO YYYY-MM-DDTHH-mm-ss (e.g. billing_backup_2026-09-15T11-20-47.db)
    const m2 = fileName.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m2) {
      return new Date(m2[1], m2[2] - 1, m2[3], m2[4], m2[5], m2[6]);
    }

    // 3. Coba format timestamp epoch milliseconds (e.g. uploaded_db_1789234567890_...)
    const m3 = fileName.match(/_(\d{13})_/);
    if (m3) {
      return new Date(parseInt(m3[1], 10));
    }

    // 4. Fallback ke file birthtime / mtime
    return stats?.birthtime || stats?.mtime || new Date();
  } catch (e) {
    return stats?.mtime || new Date();
  }
}

/**
 * Daftar semua backup yang tersedia
 */
function listBackups() {
  try {
    if (!fs.existsSync(backupDir)) {
      return { success: true, backups: [], total: 0 };
    }

    const files = fs.readdirSync(backupDir);
    const backups = [];

    for (const file of files) {
      if (file.startsWith('.')) continue; // ignore hidden files
      const filePath = path.join(backupDir, file);
      
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      if (!stats.isFile()) continue;

      let backupType = null;
      const lower = file.toLowerCase();
      if (lower.endsWith('.db') || lower.endsWith('.sqlite')) {
        backupType = 'database';
      } else if (lower.endsWith('.json')) {
        backupType = 'settings';
      } else {
        continue; // Abaikan file non-backup
      }

      const backupDate = parseBackupTimestamp(file, stats);

      backups.push({
        fileName: file,
        type: backupType,
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
        created: backupDate || stats.birthtime || stats.mtime,
        createdDate: backupDate,
        modified: stats.mtime
      });
    }

    // Urutkan berdasarkan tanggal terbaru di atas
    backups.sort((a, b) => {
      const ta = (a.createdDate ? a.createdDate.getTime() : 0);
      const tb = (b.createdDate ? b.createdDate.getTime() : 0);
      return tb - ta;
    });

    return {
      success: true,
      backups: backups,
      total: backups.length
    };
  } catch (e) {
    logger.error(`[Backup] Failed to list backups: ${e.message}`);
    return {
      success: false,
      error: e.message,
      backups: []
    };
  }
}

/**
 * Hapus backup lama berdasarkan retention policy
 */
function cleanupOldBackups(retentionDays = 30) {
  try {
    const result = listBackups();
    if (!result.success) {
      return result;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;
    const deletedFiles = [];

    for (const backup of result.backups) {
      const fileDate = backup.createdDate || backup.created;
      if (fileDate < cutoffDate) {
        const filePath = path.join(backupDir, backup.fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deletedCount++;
          deletedFiles.push(backup.fileName);
          logger.info(`[Backup] Deleted old backup: ${backup.fileName}`);
        }
      }
    }

    return {
      success: true,
      deletedCount,
      deletedFiles,
      retentionDays
    };
  } catch (e) {
    logger.error(`[Backup] Failed to cleanup old backups: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Cek kapasitas backup dan hapus jika perlu (jaga di bawah maxSizeMB)
 */
function checkBackupCapacity(maxSizeMB = 500) {
  try {
    const result = listBackups();
    if (!result.success) {
      return result;
    }

    const totalSize = result.backups.reduce((sum, backup) => sum + backup.size, 0);
    let totalSizeMB = totalSize / (1024 * 1024);

    if (totalSizeMB > maxSizeMB) {
      logger.warn(`[Backup] Backup size (${totalSizeMB.toFixed(2)} MB) exceeds limit (${maxSizeMB} MB)`);
      
      // Hapus backup paling lama sampai kapasitas aman
      const sortedBackups = [...result.backups].sort((a, b) => {
        const ta = (a.createdDate ? a.createdDate.getTime() : 0);
        const tb = (b.createdDate ? b.createdDate.getTime() : 0);
        return ta - tb;
      });
      let deletedCount = 0;
      
      for (const backup of sortedBackups) {
        if (totalSizeMB <= maxSizeMB * 0.8) { // Hapus sampai 80% dari limit
          break;
        }
        
        const filePath = path.join(backupDir, backup.fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          totalSizeMB -= backup.size / (1024 * 1024);
          deletedCount++;
          logger.info(`[Backup] Deleted backup for capacity: ${backup.fileName}`);
        }
      }

      return {
        success: true,
        action: 'cleanup',
        deletedCount,
        totalSizeMB: totalSizeMB.toFixed(2),
        maxSizeMB
      };
    }

    return {
      success: true,
      action: 'none',
      totalSizeMB: totalSizeMB.toFixed(2),
      maxSizeMB
    };
  } catch (e) {
    logger.error(`[Backup] Failed to check backup capacity: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Jadwal backup otomatis
 */
function scheduleAutoBackup() {
  const nodeCron = require('node-cron');
  const enabled = getSetting('auto_backup_enabled', true);
  const schedule = getSetting('auto_backup_schedule', '0 2 * * *'); // Default jam 2 pagi setiap hari

  if (!enabled) {
    logger.info('[Backup] Auto backup disabled');
    return;
  }

  nodeCron.schedule(schedule, async () => {
    logger.info('[Backup] Starting scheduled backup...');
    try {
      const result = await backupAll();
      if (result.success) {
        logger.info('[Backup] Scheduled backup completed successfully: ' + result.fileName);
        checkBackupCapacity(500); // otomatis jaga kapasitas di bawah 500MB
      } else {
        logger.error('[Backup] Scheduled backup failed: ' + result.error);
      }
    } catch (cronErr) {
      logger.error('[Backup] Scheduled backup exception: ' + cronErr.message);
    }
  });

  logger.info(`[Backup] Auto backup scheduled: ${schedule}`);
}

module.exports = {
  backupDatabase,
  backupSettings,
  backupAll,
  restoreDatabase,
  restoreSettings,
  listBackups,
  cleanupOldBackups,
  checkBackupCapacity,
  scheduleAutoBackup
};
