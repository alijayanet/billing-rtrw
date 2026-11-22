#!/usr/bin/env bash
# ==============================================================================
# ALIJAYA NET - Linux Server Security & Forensic Audit Script
# Memindai backdoor, crontab asing, kunci SSH liar, proses aneh & koneksi luar
# ==============================================================================

echo "=================================================================="
echo "🛡️  AUDIT KEAMANAN SERVER LINUX - ALIJAYA NET"
echo "🕒  Waktu Pemeriksaan: $(date)"
echo "=================================================================="

# 1. CEK CRONTAB & TIMER (Persistensi Terjadwal)
echo ""
echo "📌 [1/7] MEMERIKSA PENJADWALAN OTOMATIS (CRONTAB)..."
echo "--- Crontab User ($USER) ---"
crontab -l 2>/dev/null || echo "✅ Bersih: Tidak ada crontab aktif untuk user $USER."
echo "--- Crontab Root ---"
sudo crontab -l 2>/dev/null || echo "✅ Bersih: Tidak ada crontab aktif untuk root."
echo "--- Folder /etc/cron.* ---"
ls -la /etc/cron.d /etc/cron.daily 2>/dev/null | grep -v 'total\|^\.\|0anacron\|logrotate\|apt\|dpkg' || echo "✅ Bersih: Hanya cron standar OS."

# 2. CEK PINTU BELAKANG SSH (Authorized Keys)
echo ""
echo "📌 [2/7] MEMERIKSA KUNCI SSH ASING (AUTHORIZED KEYS)..."
if [ -f "$HOME/.ssh/authorized_keys" ]; then
  echo "⚠️ Ditemukan file ~/.ssh/authorized_keys:"
  cat "$HOME/.ssh/authorized_keys"
else
  echo "✅ Bersih: Tidak ada file ~/.ssh/authorized_keys (Login SSH berbasis password)."
fi

if sudo test -f "/root/.ssh/authorized_keys" 2>/dev/null; then
  echo "⚠️ Ditemukan file /root/.ssh/authorized_keys:"
  sudo cat "/root/.ssh/authorized_keys"
else
  echo "✅ Bersih: Tidak ada file authorized_keys pada root."
fi

# 3. CEK DAFTAR USER SISTEM
echo ""
echo "📌 [3/7] MEMERIKSA AKUN USER DI SISTEM (/etc/passwd)..."
awk -F: '($3 >= 1000 && $3 < 60000) || $3 == 0 {print "• User: " $1 " | UID: " $3 " | Home: " $6 " | Shell: " $7}' /etc/passwd

# 4. CEK FILE MENCURIGAKAN DI /tmp DAN /var/tmp
echo ""
echo "📌 [4/7] MEMERIKSA FILE SKRIP DI /tmp DAN /var/tmp..."
SUSPICIOUS_TMP=$(find /tmp /var/tmp -maxdepth 2 -type f \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "*.php" -o -name "*.pl" -o -name "*.err" -o -name "sweep*" -o -name "tipzy*" -o -name "rp*" \) 2>/dev/null)
if [ -n "$SUSPICIOUS_TMP" ]; then
  echo "⚠️ PERINGATAN: Ditemukan file mencurigakan di /tmp:"
  echo "$SUSPICIOUS_TMP"
else
  echo "✅ Bersih: Tidak ditemukan skrip asing (.sh, .py, .js, .err) di /tmp."
fi

# 5. CEK DAFTAR PROSES PM2 & SKRIP ASING
echo ""
echo "📌 [5/7] MEMERIKSA PROSES APLIKASI YANG BERJALAN..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 list
fi
echo "--- Memeriksa Proses Mencurigakan Lainnya ---"
SUSPICIOUS_PROC=$(ps aux | grep -iE 'tipzy|sweep|miner|crypto|xmrig|python.*tmp|sh.*tmp|bash.*tmp' | grep -v grep)
if [ -n "$SUSPICIOUS_PROC" ]; then
  echo "⚠️ PERINGATAN: Ditemukan proses mencurigakan:"
  echo "$SUSPICIOUS_PROC"
else
  echo "✅ Bersih: Tidak ada proses skrip mencurigakan yang aktif."
fi

# 6. CEK KONEKSI AKTIF KE INTERNET LUAR (ESTABLISHED OUTBOUND)
echo ""
echo "📌 [6/7] MEMERIKSA KONEKSI JARINGAN KE INTERNET LUAR..."
OUTBOUND=$(sudo ss -tupn state established 2>/dev/null | grep -v '192.168.8\.' | grep -v '127.0.0.1' | grep -v '::1')
if [ -n "$OUTBOUND" ]; then
  echo "ℹ️ Koneksi keluar aktif ke IP luar (Pastikan ini layanan resmi seperti Baileys/NTP):"
  echo "$OUTBOUND"
else
  echo "✅ Bersih: Tidak ada koneksi asing keluar ke internet."
fi

# 7. CEK FILE UNTRACKED / MODIFIKASI PADA FOLDER BILLING
echo ""
echo "📌 [7/7] MEMERIKSA INTEGRITAS REPOSITORY BILLING..."
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR" || exit
git status -s

echo ""
echo "=================================================================="
echo "🎯 AUDIT SELESAI. Silakan salin hasil di atas jika ada temuan."
echo "=================================================================="
