# Alijaya NOC Display TV - Native Android TV / STB Wallboard

Aplikasi Android TV / STB mandiri (native Kotlin) khusus untuk display wallboard NOC (Network Operations Center) monitoring MikroTik secara real-time 24/7.

Aplikasi ini terkoneksi **langsung ke port API MikroTik (Port 8728/8729)** secara **read-only**, tanpa bergantung pada server billing atau web browser.

---

## 🚀 Fitur Unggulan

1. **Standalone Direct MikroTik API:**
   - Berkomunikasi langsung melalui raw TCP socket port 8728 / 8729.
   - Kompatibel penuh dengan RouterOS v6 (Challenge-Response MD5) dan RouterOS v7 (Plain Auth).
   - Auto-reconnect otomatis jika koneksi jaringan TV terputus.

2. **Liquid Real-time Traffic Throughput Wave:**
   - Grafik wave area dual-layer (Download RX & Upload TX) dengan kurva Bezier halus dan efek neon glow.
   - Auto-scaling dinamis (50M, 100M, 250M, 500M, 1G+).
   - Peak indicator line & live throughput heads-up display (HUD).

3. **Custom Donut Gauges (CPU & RAM):**
   - Donut gauge melingkar 270° modern dengan animasi rotasi sweep halus.
   - Indikator warna dinamis sesuai beban:
     - Normal: Neon Cyan / Emerald
     - Warning (> 70%): Neon Amber
     - Critical (> 85%): Neon Red
   - Sub-label detail core CPU (misal: `4 Cores @ 1400MHz`) dan RAM (`452 MB / 1024 MB`).

4. **Active Interface Matrix:**
   - Grid horizontal status port fisik (ether1..10, sfp-sfpplus, VLAN).
   - Indikator lampu status (Hijau = Running, Merah = Down, Abu-abu = Disabled).
   - Live kecepatan RX / TX pada setiap port.

5. **Pilihan 5 Tema Tampilan (Theme Engine):**
   - **Cyberpunk Neon (Default):** Obsidian dark dengan aksen Electric Cyan, Emerald, dan Magenta.
   - **Emerald Matrix:** Hitam pekat dengan aksen Matrix Green & Lime.
   - **Sapphire Blue:** Deep Midnight Navy dengan aksen Ice Blue & Electric Azure.
   - **AMOLED Pure Dark:** True Black #000000 hemat daya dengan aksen kontras tinggi.
   - **Amber Sunset:** Dark Charcoal dengan aksen Gold & Warm Amber.

6. **Desain Khusus TV Landscape 16:9 & D-Pad Remote Control:**
   - Tampilan Fullscreen Immersive `100vh` tanpa scrollbar.
   - Navigasi D-Pad remote control (fokus card, tombol menu).
   - Shortcut remote TV:
     - Tombol **[MENU]**: Buka pop-up Pengaturan.
     - Tombol angka **[1] - [5]**: Ganti tema warna secara instan.
   - **Keep Screen On:** Mencegah TV/STB masuk mode screensaver atau tidur.
   - **Auto-Boot:** Otomatis berjalan saat STB dinyalakan.

---

## 📦 Cara Pasang di STB / Android TV (ZTE B860H, Fiberhome HG680P, Mi TV, dll.)

### Metode 1: Menggunakan Flashdisk / USB OTG
1. Salin file `alijaya-noc-tv-v1.0.0.apk` ke Flashdisk.
2. Colokkan Flashdisk ke port USB STB / Android TV.
3. Buka File Manager di STB, cari file APK dan pilih **Install**.
4. Buka aplikasi **Alijaya NOC Display**.

### Metode 2: Menggunakan ADB (Android Debug Bridge)
```bash
adb connect 192.168.8.x:5555
adb install -r alijaya-noc-tv-v1.0.0.apk
```

### Metode 3: Download via Browser TV
Buka browser di STB / Android TV dan akses URL download:
`http://192.168.8.8:3000/download/noc-tv.apk`

---

## ⚙️ Konfigurasi Awal di Layar TV
1. Tekan tombol **[MENU]** pada Remote TV atau klik tombol **[⚙ PENGATURAN]**.
2. Masukkan:
   - **IP Address:** `192.168.8.1` (atau IP MikroTik router Anda)
   - **Port:** `8728`
   - **Username:** Username API (misal `admin` atau user khusus grup read)
   - **Password:** Password router MikroTik
   - **Interface WAN:** `ether1-ISP`
   - **Pilihan Tema:** Pilih tema favorit Anda
3. Klik **[⚡ TEST KONEKSI]** untuk memastikan status terhubung sukses.
4. Klik **[💾 SIMPAN & TERAPKAN]**.
