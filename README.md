# 🚀 RTRWNET Management & Billing System

![ISP Management Hero](public/img/hero.png)

Sistem manajemen ISP modern yang mengintegrasikan **Penagihan (Billing)**, **Manajemen ONU (GenieACS)**, **Manajemen Bandwidth (MikroTik)**, dan **Notifikasi WhatsApp** dalam satu platform terpadu.

[![GitHub license](https://img.shields.io/github/license/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/alijayanet/billing-rtrw)](https://github.com/alijayanet/billing-rtrw/stargazers)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

---

## ✨ Fitur Utama

### 💰 1. Billing & Penagihan Otomatis
- **Automated Invoicing**: Pembuatan tagihan otomatis setiap bulan untuk semua pelanggan aktif.
- **Isolir Otomatis**: Integrasi dengan MikroTik untuk memutus layanan (block) pelanggan yang menunggak dan membuka layanan (unblock) secara instan setelah pembayaran.
- **Manajemen Invoice**: Cetak invoice profesional dan kelola riwayat pembayaran.
- **Laporan Keuangan**: Statistik pendapatan bulanan, akumulasi pendapatan, dan data tunggakan.

### 📡 2. Monitoring ONU (GenieACS TR-069)
- **Real-time Dashboard**: Pantau status Online/Offline, Redaman (RX Power), Uptime, dan IP Address.
- **Remote WiFi Settings**: Ubah SSID (Nama WiFi) dan Password langsung dari panel admin atau portal pelanggan.
- **Remote Reboot**: Restart perangkat ONU pelanggan secara jarak jauh.
- **Connected Devices**: Lihat jumlah perangkat yang sedang terhubung ke WiFi pelanggan.

### 🛠️ 3. Portal Teknisi (Mobile First)
- **Responsive Interface**: Didesain khusus untuk smartphone agar memudahkan teknisi di lapangan.
- **Ticket Management**: Kelola dan selesaikan keluhan pelanggan secara efisien.
- **Field Monitoring**: Teknisi dapat memantau status sinyal ONU saat melakukan perbaikan di rumah pelanggan.

### 📲 4. Integrasi WhatsApp (Baileys API)
- **Broadcast Massal**: Kirim pengumuman atau info maintenance ke seluruh pelanggan dengan satu klik.
- **Real-time Tracker**: Pantau progres pengiriman broadcast (Berhasil/Gagal) secara langsung.
- **WhatsApp Bot Self-Service**: Pelanggan bisa cek status, cek tagihan, hingga ganti password WiFi melalui pesan WhatsApp.
- **Notifikasi Tagihan**: Pengingat otomatis untuk pelanggan yang belum membayar.

### 👥 5. Manajemen User (Role Based)
- **Super Admin**: Akses penuh ke pengaturan sistem dan manajemen user internal.
- **Kasir**: Kelola pembayaran dan data pelanggan tanpa akses ke pengaturan sensitif.
- **Teknisi**: Kelola tiket gangguan dan monitoring perangkat.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: SQLite (Better-SQLite3)
- **Templates**: EJS (Embedded JavaScript)
- **Styling**: Vanilla CSS, Bootstrap 5, Bootstrap Icons
- **Integrasi**: 
  - **GenieACS REST API** (Management ONU)
  - **MikroTik RouterOS API** (Management Bandwidth/Isolir)
  - **Baileys** (WhatsApp API)

---
Noted : gunakan nodejs v20

## 🚀 Cara Instalasi (Ubuntu / Armbian)

### 1. Persiapan
Pastikan Anda memiliki akses `root` atau `sudo`.

```bash
# Clone repository
git clone https://github.com/alijayanet/billing-rtrw.git
cd billing-rtrw
```

### 2. Jalankan Installer Package
```bash
npm install
```
### 3. Jalankan Aplikasi
```bash
npm start
```

### 3. Akses Portal
Setelah instalasi berhasil, portal dapat diakses melalui browser:
- **Admin Portal**: `http://[IP-SERVER]:3001/admin/login`
                    'User : admin Pass : admin123'
- **teknisi Portal**: `http://[IP-SERVER]:3001/tech/login`
- **Customer Portal**: `http://[IP-SERVER]:3001/login`




## ⚙️ Konfigurasi Tambahan

```bash
install pm2 -g
```
## ⚙️ Jalankan Aplikasi Menggunakan pm2

```bash
pm2 start app-customer.php --name billing-rtrw
```


## 🤝 Kontribusi

Kontribusi selalu terbuka! Silakan fork repository ini, buat branch baru, dan kirimkan Pull Request.


## 📄 Lisensi

Didistribusikan di bawah Lisensi **ISC**. Lihat `LICENSE` untuk detailnya.


🚀 **Dibuat untuk memudahkan operasional ISP Lokal & RTRW-Net.**
Managed by [Ali Jaya Net](https://github.com/alijayanet)

## info & donasi 081947215703
https://wa.me/6281947215703
