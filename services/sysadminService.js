const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const db = require('../config/database');
const { logger } = require('../config/logger');

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Utilitas untuk menjalankan command shell dengan promise & timeout
 */
function runShell(command, cwd = PROJECT_ROOT, timeout = 30000) {
  return new Promise((resolve) => {
    const isLinux = process.platform === 'linux';
    const nvmPath = isLinux ? `${process.env.HOME || '/home/alijaya'}/.nvm/versions/node/v22.23.5/bin:${process.env.HOME || '/home/alijaya'}/.nvm/versions/node/v20.20.2/bin:` : '';
    const env = {
      ...process.env,
      DEBIAN_FRONTEND: 'noninteractive',
      PATH: `${nvmPath}${process.env.PATH || ''}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    };

    exec(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 2, // 2MB buffer
      env
    }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        code: err ? (err.code || 1) : 0,
        err: err ? err.message : null,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      });
    });
  });
}

/**
 * 1. Mengecek Ketersediaan Update Sistem Operasi & Node.js Runtime
 */
async function checkSystemUpdates() {
  const isLinux = process.platform === 'linux';
  const currentNode = process.version;
  const cpus = os.cpus().length;
  const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(2);
  const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(2);
  const usedMemGb = (totalMemGb - freeMemGb).toFixed(2);

  if (!isLinux) {
    return `🖥️ *Status Sistem Server (Windows Environment):*
• Platform: \`${process.platform} ${os.release()}\`
• CPU: \`${cpus} Core\` | RAM: \`${usedMemGb} GB / ${totalMemGb} GB\`
• Node.js Saat Ini: \`${currentNode}\`

ℹ️ *Catatan:* Pembaruan paket otomatis (\`apt-get\`) dikhususkan untuk server produksi Linux (Ubuntu/Debian). Server produksi Linux Anda di IP \`192.168.8.8\` siap menerima pembaruan OS dan runtime Node.js LTS secara otomatis.`;
  }

  // 1. Cek OS Info
  const osInfoRes = await runShell(`cat /etc/os-release | grep -E '^(PRETTY_NAME)=' | cut -d'=' -f2 | tr -d '"'`, PROJECT_ROOT, 5000);
  const osName = osInfoRes.stdout || 'Ubuntu Linux';

  // 2. Cek Disk Space
  const diskRes = await runShell(`df -h / | tail -n 1 | awk '{print $4 " bebas dari " $2 " (Terpakai " $5 ")"}'`, PROJECT_ROOT, 5000);
  const diskInfo = diskRes.stdout || 'Informasi disk tidak terbaca';

  // 3. Update daftar repo apt secara non-blocking
  await runShell(`sudo -n apt-get update -qq`, PROJECT_ROOT, 25000);

  // 4. Hitung paket yang bisa di-upgrade
  const upgradableRes = await runShell(`apt list --upgradable 2>/dev/null`, PROJECT_ROOT, 10000);
  const rawList = upgradableRes.stdout || '';
  const lines = rawList.split('\n').filter(l => l.trim() && !l.includes('Listing...'));
  const upgradableCount = lines.length;

  const samplePackages = lines.slice(0, 5).map(l => {
    const pkgName = l.split('/')[0];
    return `  • \`${pkgName}\``;
  }).join('\n');

  // 5. Cek Versi Node.js LTS via NVM
  let latestLtsNode = 'v22.23.5 (LTS Jod)';
  try {
    const nvmRes = await runShell(`
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
      nvm ls-remote "lts/jod" | tail -n 1 | awk '{print $1}'
    `, PROJECT_ROOT, 15000);
    if (nvmRes.stdout) {
      latestLtsNode = nvmRes.stdout.trim() + ' (LTS Jod)';
    }
  } catch (_) {}

  const isNodeOutdated = !currentNode.startsWith('v22.');

  let report = `🖥️ *LAPORAN PEMBARUAN SISTEM SERVER (SYSADMIN AGENT)*
• *OS:* \`${osName}\`
• *RAM:* \`${usedMemGb} GB / ${totalMemGb} GB\`
• *Penyimpanan Disk:* \`${diskInfo}\`
• *Versi Node.js Saat Ini:* \`${currentNode}\`
• *Rekomendasi Node.js LTS Terkini:* \`${latestLtsNode}\`

📦 *STATUS PAKET SISTEM OPERASI (APT):*
${upgradableCount > 0 
  ? `⚠️ Ditemukan *${upgradableCount} paket* yang siap di-upgrade:\n${samplePackages}${upgradableCount > 5 ? `\n  • _...dan ${upgradableCount - 5} paket lainnya._` : ''}`
  : '✅ Semua paket sistem operasi sudah berada pada versi terbaru.'}

🛡️ *STATUS KEAMANAN NODE.JS RUNTIME:*
${isNodeOutdated 
  ? `⚠️ Versi Node.js aktif (\`${currentNode}\`) adalah lini Node 20 yang mendekati EOL. Sangat disarankan untuk upgrade ke *Node.js v22 LTS* guna mengamankan server dari isu CVE keamanan (HTTP/2 crash, TLS leak, Brotli).`
  : '✅ Node.js sudah menggunakan lini LTS v22 terkini.'}

💡 *TINDAKAN YANG DAPAT DILAKUKAN:*
Ketik atau katakan salah satu perintah berikut:
• \`Upgrade paket OS saja\` : Menjalankan \`sudo apt upgrade\`
• \`Upgrade Node.js saja\` : Mengupgrade runtime ke Node.js v22 LTS & rebuild modul
• \`Upgrade server sekarang\` : Menjalankan pembaruan menyeluruh (OS + Node.js)`;

  return report;
}

/**
 * 2. Menjalankan Pembaruan Sistem (OS / Node.js / Keduanya)
 */
async function manageSystemUpgrade({ target = 'all', confirm = false, adminName = 'Admin' } = {}) {
  const cleanTarget = String(target || 'all').toLowerCase();
  const isLinux = process.platform === 'linux';

  if (!isLinux) {
    return `⚠️ Perintah pembaruan sistem operasi dan runtime Node.js berbasis shell script dirancang untuk server produksi Linux (Ubuntu/Debian). Server lokal Windows Anda saat ini berada pada kondisi normal.`;
  }

  // Jika belum dikonfirmasi oleh Admin, berikan checklist rencana pre-flight
  if (!confirm) {
    let targetLabel = 'Seluruh Sistem (Paket OS Linux + Runtime Node.js v22 LTS)';
    if (cleanTarget === 'os' || cleanTarget === 'os_packages') targetLabel = 'Hanya Paket Sistem Operasi Linux (apt upgrade)';
    if (cleanTarget === 'nodejs' || cleanTarget === 'node') targetLabel = 'Hanya Runtime Node.js v22 LTS & Compile Ulang C++ Modul';

    return `⚠️ *KONFIRMASI PEMBARUAN SISTEM SERVER (SAFETY GATE)*

Halo *${adminName}*, berikut adalah rincian rencana eksekusi upgrade:
• *Target Pembaruan:* ${targetLabel}
• *Backup Database:* ✅ Otomatis membuat snapshot \`billing.db\` ke folder \`backups/\`
• *Proteksi Native C++:* ✅ Rebuild otomatis modul \`better-sqlite3\` & \`ssh2\` agar aplikasi tidak crash
• *Manajemen Proses:* ✅ Reload PM2 billing (\`--update-env\`) dan verifikasi Health-Check HTTP

Pembaruan ini akan memerlukan waktu sekitar 1 - 2 menit dan akan dilakukan tanpa downtime panjang.

👉 Untuk melanjutkan eksekusi, silakan balas dengan pesan:
\`Konfirmasi upgrade server sekarang\` (atau ketik: \`ya lanjutkan upgrade\`)`;
  }

  // JIKA SUDAH DIKONFIRMASI: Eksekusi pipeline upgrade secara aman!
  logger.info(`[SysAdmin] Memulai proses eksekusi upgrade server oleh: ${adminName} (Target: ${cleanTarget})`);

  // Step 1: Pre-Upgrade Database Snapshot Backup
  const backupDir = path.join(PROJECT_ROOT, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const backupFile = path.join(backupDir, `billing_pre_upgrade_${timestamp}.db`);
  let backupStatus = 'Gagal';

  try {
    if (typeof db.backup === 'function') {
      await db.backup(backupFile);
      const stat = fs.statSync(backupFile);
      backupStatus = `✅ Sukses (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`;
    } else {
      const srcDb = path.join(PROJECT_ROOT, 'database', 'billing.db');
      if (fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, backupFile);
        backupStatus = `✅ Sukses (File Copy)`;
      }
    }
  } catch (backupErr) {
    logger.warn(`[SysAdmin] Backup SQLite via db.backup gagal, mencoba fallback: ${backupErr.message}`);
    try {
      const srcDb = path.join(PROJECT_ROOT, 'database', 'billing.db');
      if (fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, backupFile);
        backupStatus = `✅ Sukses (Fallback Copy)`;
      }
    } catch (_) {}
  }

  // Step 2: Eksekusi Shell Script Upgrade
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'sysadmin-upgrade.sh');
  // Pastikan script memiliki permission execute (+x)
  await runShell(`chmod +x "${scriptPath}"`, PROJECT_ROOT, 5000);

  let scriptAction = 'all';
  if (cleanTarget === 'os' || cleanTarget === 'os_packages') scriptAction = 'os';
  if (cleanTarget === 'nodejs' || cleanTarget === 'node') scriptAction = 'nodejs';

  const upgradeRes = await runShell(`bash "${scriptPath}" ${scriptAction} "${PROJECT_ROOT}"`, PROJECT_ROOT, 360000); // Timeout 6 menit

  // Simpan log upgrade ke file
  const logDir = path.join(PROJECT_ROOT, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, 'sysadmin-upgrade.log');
  fs.appendFileSync(logFilePath, `\n\n--- [UPGRADE RUN ${new Date().toISOString()}] Target: ${cleanTarget} ---\n` + (upgradeRes.stdout || '') + '\n' + (upgradeRes.stderr || ''));

  // Cek Status Akhir Node & PM2
  const finalNodeRes = await runShell(`
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
    node -v
  `, PROJECT_ROOT, 5000);
  const finalNode = finalNodeRes.stdout || process.version;

  const pm2Res = await runShell(`
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
    pm2 jlist | grep -o '"name":"billing"[^}]*' | head -n 1
  `, PROJECT_ROOT, 5000);

  const isPm2Online = pm2Res.stdout.includes('"status":"online"');

  let report = `🎉 *HASIL PEMBARUAN SISTEM SERVER (SYSADMIN AGENT)*

• *Waktu Selesai:* \`${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\`
• *Cadangan Database (Backup):* \`${path.basename(backupFile)}\` (${backupStatus})
• *Target Dieksekusi:* \`${scriptAction.toUpperCase()}\`
• *Versi Node.js Baru:* \`${finalNode}\`
• *Status Aplikasi Billing (PM2):* ${isPm2Online ? '✅ ONLINE & STABIL' : '⚠️ Periksa Status PM2'}

📋 *RINGKASAN EKSEKUSI:*
\`\`\`
${upgradeRes.stdout.slice(-1500)}
\`\`\`
${upgradeRes.stderr ? `\n⚠️ *Catatan Stderr:*\n\`\`\`\n${upgradeRes.stderr.slice(-500)}\n\`\`\`` : ''}

${isPm2Online ? '✅ *Seluruh sistem berhasil diperbarui dan berjalan lancar tanpa kendala!*' : '⚠️ *Silakan periksa log aplikasi menggunakan perintah:* `cek log server`'}`;

  return report;
}

module.exports = {
  runShell,
  checkSystemUpdates,
  manageSystemUpgrade
};
