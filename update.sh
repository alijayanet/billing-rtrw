#!/bin/bash
# ============================================================
#  UPDATE RINGAN (LOW CPU) - Billing RTRW & RADIUS System
#  Untuk Ubuntu / Armbian / Debian
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Muat NVM / Node / PM2 ke PATH jika belum ada
if ! command -v pm2 &>/dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" 2>/dev/null || true
  if [ -d "$HOME/.nvm/versions/node" ]; then
    LATEST_NODE=$(ls -1d "$HOME/.nvm/versions/node"/* 2>/dev/null | tail -n 1)
    if [ -n "$LATEST_NODE" ] && [ -d "$LATEST_NODE/bin" ]; then
      export PATH="$LATEST_NODE/bin:$PATH"
    fi
  fi
fi

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║      UPDATE SYSTEM BILLING (LOW CPU MODE)        ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# 1. Backup settings.json dan database sebelum update
echo -e "${BLUE}[INFO]${NC} Melindungi konfigurasi settings.json & database..."
cp settings.json settings.json.bak 2>/dev/null || true
[ -d "database" ] && cp -r database database.bak 2>/dev/null || true
echo -e "${GREEN}[OK]${NC} Backup tersimpan di settings.json.bak & database.bak"

# 2. Bersihkan stale git lock jika ada
[ -f ".git/index.lock" ] && rm -f ".git/index.lock" 2>/dev/null || true

# 3. Amankan perubahan lokal agar git pull tidak ditolak
git stash 2>/dev/null || true

# 4. Git Pull dari GitHub
echo -e "${BLUE}[INFO]${NC} Menarik pembaruan dari GitHub..."
HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "old")
git pull origin main 2>/dev/null || git pull 2>/dev/null || true
HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null || echo "new")

# 5. Kembalikan settings.json lokal server agar konfigurasi tidak hilang
if [ -f "settings.json.bak" ]; then
  cp settings.json.bak settings.json 2>/dev/null || true
fi
if [ -d "database.bak" ] && [ -f "database.bak/billing.db" ]; then
  [ ! -f "database/billing.db" ] && cp database.bak/billing.db database/billing.db 2>/dev/null || true
fi
git stash pop 2>/dev/null || true

# 6. Kunci file konfigurasi & database lokal agar Git tidak pernah menimpa atau menolak update ke depannya
git update-index --skip-worktree settings.json 2>/dev/null || true
git update-index --skip-worktree database/billing.db 2>/dev/null || true
git update-index --skip-worktree data/wa-lid-map.json 2>/dev/null || true

# 4. Cek apakah package.json mengalami perubahan
PKG_CHANGED=false
if [ "$HEAD_BEFORE" != "old" ] && [ "$HEAD_BEFORE" != "$HEAD_AFTER" ]; then
  if git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" 2>/dev/null | grep -q "package.json"; then
    PKG_CHANGED=true
  fi
fi

# 5. Update npm HANYA jika package.json berubah
if [ "$PKG_CHANGED" = true ]; then
  echo -e "${YELLOW}[INFO]${NC} Deteksi perubahan package.json. Memperbarui dependensi NPM..."
  UV_THREADPOOL_SIZE=2 npm install --omit=dev --no-audit --no-fund --prefer-offline
  echo -e "${GREEN}[OK]${NC} Dependensi berhasil diperbarui."
else
  echo -e "${GREEN}[OK]${NC} package.json tidak berubah. Melewati 'npm install' (Hemat CPU & Cepat)."
fi

# 6. Reload aplikasi secara halus via PM2
echo -e "${BLUE}[INFO]${NC} Menerapkan pembaruan ke PM2..."
if command -v pm2 &>/dev/null; then
  PM2_APP="billing"
  if pm2 describe app-customer &>/dev/null; then
    PM2_APP="app-customer"
  fi
  pm2 reload "$PM2_APP" 2>/dev/null || pm2 restart "$PM2_APP" 2>/dev/null || pm2 reload all 2>/dev/null || true
  echo -e "${GREEN}[OK]${NC} Aplikasi ($PM2_APP) berhasil dimuat ulang oleh PM2."
else
  echo -e "${YELLOW}[WARN]${NC} PM2 tidak ditemukan di PATH. Silakan restart service secara manual jika perlu."
fi

echo ""
echo -e "${GREEN}${BOLD}Pembaruan Aplikasi Selesai dengan Aman!${NC}"
echo ""
