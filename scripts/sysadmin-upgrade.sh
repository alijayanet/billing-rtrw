#!/usr/bin/env bash
# RTRWNET AI SysAdmin Upgrade Script
# Safely handles Linux OS updates and Node.js LTS runtime upgrades with native C++ module recompilation
# Author: ALIJAYA NET SysAdmin AI Agent

set -e

ACTION="${1:-all}" # os | nodejs | all
APP_DIR="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
export DEBIAN_FRONTEND=noninteractive

echo "=========================================================="
echo "⚡ RTRWNET AI SYSADMIN UPGRADE PIPELINE"
echo "• Time: $(date)"
echo "• Action Target: $ACTION"
echo "• Project Directory: $APP_DIR"
echo "=========================================================="

# 1. Pastikan NVM ter-load jika tersedia
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
fi

# 2. Database Pre-Upgrade Safety Backup
DB_FILE="$APP_DIR/database/billing.db"
BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"

if [ -n "$SKIP_SCRIPT_BACKUP" ]; then
  echo "ℹ️ Snapshot backup database sudah dibuat sebelumnya oleh sysadminService, melewati backup script."
elif [ -f "$DB_FILE" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  BACKUP_FILE="$BACKUP_DIR/billing_pre_upgrade_${TIMESTAMP}.db"
  echo "📦 Menjalankan snapshot backup database ke: $BACKUP_FILE ..."
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
    cp "$DB_FILE" "$BACKUP_FILE"
  else
    cp "$DB_FILE" "$BACKUP_FILE"
  fi
  echo "✅ Backup database selesai! (Ukuran: $(du -h "$BACKUP_FILE" | cut -f1))"
else
  echo "ℹ️ Database $DB_FILE tidak ditemukan, lewati backup."
fi

# 3. OS Packages Update & Upgrade (apt-get)
if [ "$ACTION" = "os" ] || [ "$ACTION" = "all" ]; then
  echo ""
  echo "📦 [1/2] Memperbarui Paket Sistem Operasi Linux (apt update & upgrade)..."
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n apt-get update -qq
    sudo -n apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" --autoremove
    echo "✅ Pembaruan paket OS berhasil diselesaikan!"
  else
    echo "⚠️ Sudo tanpa password belum terkonfigurasi atau perintah sudo tidak tersedia. Melewati apt upgrade."
  fi
fi

# 4. Node.js LTS Runtime Upgrade & Native Module Recompilation
if [ "$ACTION" = "nodejs" ] || [ "$ACTION" = "all" ]; then
  echo ""
  echo "🚀 [2/2] Memeriksa & Mengupgrade Runtime Node.js LTS..."
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    CURRENT_NODE=$(node -v || echo "none")
    echo "• Versi Node.js saat ini: $CURRENT_NODE"
    
    echo "• Mengunduh & memasang Node.js LTS Jod (Node 22)..."
    nvm install --lts=jod
    nvm alias default 'lts/jod'
    nvm use 'lts/jod'
    NEW_NODE=$(node -v)
    echo "• Versi Node.js aktif sekarang: $NEW_NODE"
    
    echo "• Memastikan PM2 terpasang pada Node.js $NEW_NODE..."
    npm install -g pm2
    
    echo "• Melakukan compile ulang modul native C++ (better-sqlite3 & ssh2) untuk ABI $NEW_NODE..."
    cd "$APP_DIR"
    npm rebuild better-sqlite3 ssh2
    
    echo "• Memperbarui environment proses PM2 billing..."
    pm2 reload billing --update-env || pm2 restart billing --update-env
    pm2 save
    
    echo "• Menguji kestabilan server (Health Check)..."
    sleep 3
    if command -v curl >/dev/null 2>&1; then
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/login || echo "000")
      echo "• Status HTTP endpoint /login: $HTTP_STATUS"
      if [ "$HTTP_STATUS" -eq 200 ] || [ "$HTTP_STATUS" -eq 302 ] || [ "$HTTP_STATUS" -eq 401 ]; then
        echo "✅ SERVER ONLINE & SEHAT! Express Web Server merespon dengan kode HTTP $HTTP_STATUS."
      else
        echo "⚠️ Peringatan: Health check HTTP menghasilkan kode tidak terduga ($HTTP_STATUS). Cek log PM2!"
      fi
    fi
  else
    echo "⚠️ NVM tidak terpasang di $NVM_DIR, lewati upgrade Node.js."
  fi
fi

echo ""
echo "=========================================================="
echo "🎉 PROSES UPGRADE SYSADMIN SELESAI PADA: $(date)"
echo "=========================================================="
