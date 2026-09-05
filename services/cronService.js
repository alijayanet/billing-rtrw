/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const mikrotikService = require('./mikrotikService');
const usageSvc = require('./usageService');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');
const qrisUtil = require('../utils/qrisUtil');

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

function startCronJobs() {
  // 1. Generate Tagihan Otomatis setiap tanggal 1 jam 00:01
  cron.schedule('1 0 1 * *', () => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    
    logger.info(`[CRON] Menjalankan generate tagihan otomatis untuk ${month}/${year}`);
    try {
      const count = billingSvc.generateMonthlyInvoices(month, year);
      logger.info(`[CRON] Berhasil generate ${count} tagihan otomatis.`);
    } catch (error) {
      logger.error(`[CRON] Gagal generate tagihan otomatis: ${error.message}`);
    }
  });

  // 2. Isolir Otomatis setiap hari jam 02:00
  cron.schedule('0 2 * * *', async () => {
    const now = new Date();
    const today = now.getDate();
    logger.info(`[CRON] Menjalankan pengecekan isolir otomatis harian (Tanggal ${today})`);

    let isolatedCount = 0;
    const BATCH_SIZE = 100;
    let offset = 0;

    while (true) {
      const batch = db.prepare(
        `SELECT c.*, p.billing_type AS package_billing_type
         FROM customers c LEFT JOIN packages p ON c.package_id = p.id
         WHERE c.status = 'active'
         LIMIT ? OFFSET ?`
      ).all(BATCH_SIZE, offset);

      if (batch.length === 0) break;

      for (const c of batch) {
        const isAutoIsolateEnabled = c.auto_isolate !== 0;
        if (!isAutoIsolateEnabled) continue;

        const isPrepaid = c.package_billing_type === 'prepaid';

        if (isPrepaid) {
          if (c.expired_at) {
            const expDate = new Date(c.expired_at);
            if (!isNaN(expDate.getTime()) && now >= expDate) {
              try {
                logger.info(`[CRON] Isolir otomatis PRABAYAR: ${c.name} (${c.pppoe_username || c.hotspot_username || '-'}) - Berakhir: ${c.expired_at}`);
                await customerSvc.suspendCustomer(c.id);
                isolatedCount++;
              } catch (err) {
                logger.error(`[CRON] Gagal isolir prabayar ${c.name}: ${err.message}`);
              }
            }
          }
        } else {
          const customerIsolirDay = c.isolate_day || 10;
          const unpaidCount = db.prepare('SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status=?').get(c.id, 'unpaid')?.cnt || 0;
          if (today >= customerIsolirDay && unpaidCount > 0) {
            try {
              logger.info(`[CRON] Isolir otomatis PASCABAYAR: ${c.name} (${c.pppoe_username || c.hotspot_username || '-'}) - Tgl Isolir: ${customerIsolirDay}`);
              await customerSvc.suspendCustomer(c.id);
              isolatedCount++;
            } catch (err) {
              logger.error(`[CRON] Gagal isolir pascabayar ${c.name}: ${err.message}`);
            }
          }
        }
      }

      offset += BATCH_SIZE;
      if (batch.length === BATCH_SIZE) {
        await new Promise(r => setTimeout(r, 300)); // Jeda 300ms antar batch
      }
    }

    logger.info(`[CRON] Selesai pengecekan isolir. Total ${isolatedCount} pelanggan baru di-isolir.`);
  });

  cron.schedule('0 9 * * *', async () => {
    const enabled = getSetting('whatsapp_auto_billing_enabled', false);
    const waEnabled = getSetting('whatsapp_enabled', false);
    const billingEnabled = getSetting('whatsapp_billing_to_customer_enabled', true);
    if (!enabled || !waEnabled || !billingEnabled) return;

    const gatewayType = getSetting('wa_gateway_type', 'baileys');
    const waSvc = require('./whatsappService');
    
    if (gatewayType === 'meta') {
      const phoneId = getSetting('meta_phone_number_id', '');
      const token = getSetting('meta_access_token', '');
      if (!phoneId || !token) {
        logger.warn('[CRON] Kredensial Meta API belum diisi, pengingat tagihan otomatis dilewati.');
        return;
      }
    } else if (gatewayType === 'fonnte') {
      const token = getSetting('fonnte_token', '');
      if (!token) {
        logger.warn('[CRON] Token Fonnte belum diisi, pengingat tagihan otomatis dilewati.');
        return;
      }
    } else {
      let whatsappStatus;
      try {
        const mod = await import('./whatsappBot.mjs');
        whatsappStatus = mod.whatsappStatus;
      } catch (e) {
        logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
        return;
      }

      if (!whatsappStatus || whatsappStatus.connection !== 'open') {
        logger.warn('[CRON] WhatsApp bot belum terhubung, pengingat tagihan otomatis dilewati.');
        return;
      }
    }

    const resolveBaseUrl = () => {
      const explicit = String(getSetting('public_base_url', '') || '').trim();
      if (explicit) return explicit.replace(/\/+$/, '');

      const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
      const port = Number(getSetting('server_port', 3001) || 3001);
      const hasProto = /^https?:\/\//i.test(hostRaw);
      const proto = port === 443 ? 'https' : 'http';
      const host = hasProto ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
      const withPort = (port === 80 || port === 443) ? host : `${host}:${port}`;
      return withPort.replace(/\/+$/, '');
    };

    const loginLink = `${resolveBaseUrl()}/customer/login`;
    const baseDelayMs = (Number(getSetting('whatsapp_broadcast_delay', 5) || 5) * 1000); // Default 5 detik
    const batchSize = 15; // 15 pesan per batch (dari 20)
    const batchPauseMs = 120000; // Pause 2 menit setelah batch (dari 1 menit)

    const today = new Date();
    const day = today.getDate();

    const customers = customerSvc.getAllCustomers();
    let targetCount = 0;
    let sent = 0;
    let failed = 0;
    let batchCount = 0;

    const defaultTemplate =
      `Yth. Pelanggan {{nama}},\n\n` +
      `Ini adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n` +
      `📦 *Paket:* {{paket}}\n` +
      `💰 *Total Tagihan:* Rp {{tagihan}}\n` +
      `📅 *Periode:* {{rincian}}\n\n` +
      `Mohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\n` +
      `Terima kasih atas kerja samanya.\n` +
      `Salam,\nAdmin ${getSetting('company_header', 'ISP')}`;
    const template = String(db.getAppSetting('whatsapp_auto_billing_message', defaultTemplate) || defaultTemplate);

    // Filter pelanggan yang perlu diingatkan
    const targetCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      const phone = c.phone ? String(c.phone).trim() : '';
      if (!phone || phone.length < 9) continue;
      let digits = phone.replace(/\D/g, '');
      if (!digits) continue;
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      if (seenPhones.has(digits)) continue;

      const isPrepaid = c.package_billing_type === 'prepaid';
      let shouldSend = false;

      if (isPrepaid) {
        if (c.expired_at) {
          const expDate = new Date(c.expired_at);
          if (!isNaN(expDate.getTime())) {
            const diffMs = expDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            if (diffDays === 1 || diffDays === 2) {
              shouldSend = true;
            }
          }
        }
      } else {
        const unpaidCount = Number(c.unpaid_count || 0) || 0;
        if (unpaidCount > 0) {
          const dueDay = Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 10) || 10) || 10;
          const remind1 = dueDay - 1;
          shouldSend = (remind1 >= 1 && day === remind1);
        }
      }

      if (!shouldSend) continue;

      seenPhones.add(digits);
      targetCustomers.push(c);
    }

    if (targetCustomers.length === 0) {
      logger.info('[CRON] Tidak ada pelanggan yang perlu diingatkan hari ini.');
      return;
    }

    logger.info(`[CRON] Memulai pengingat tagihan otomatis untuk ${targetCustomers.length} pelanggan dengan smart rate limit.`);

    // Kirim pesan dengan smart rate limit
    for (let i = 0; i < targetCustomers.length; i++) {
      const c = targetCustomers[i];
      let attemptCount = 0;
      const maxAttempts = 3;

      while (attemptCount < maxAttempts) {
        try {
          // Smart Random Delay
          const randomDelay = getRandomDelay(baseDelayMs, 2000);
          await new Promise(r => setTimeout(r, randomDelay));

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
          const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
          const rincianBulan = unpaidInvoices.map(inv => `${inv.period_month}/${inv.period_year}`).join(', ');

          // Process Dynamic QRIS if enabled & available
          let qrisImageBuffer = null;
          let finalTagihanStr = totalTagihan.toLocaleString('id-ID');

          if (unpaidInvoices.length > 0) {
            try {
              const inv = unpaidInvoices[0];
              let code = Number(inv.qris_unique_code || 0) || 0;
              let amt = Number(inv.qris_amount_unique || 0) || 0;
              const invId = Number(inv.id);
              const baseAmount = totalTagihan > 0 ? totalTagihan : Number(inv.amount || 0);

              // Jika amt tidak ada atau amt tidak cocok dengan akumulasi total tagihan + kode, buat/perbarui nominal unik
              if ((!code || !amt || (amt - code !== baseAmount)) && invId > 0 && baseAmount > 0) {
                const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
                const custId = Number(c?.id || inv?.customer_id || 0);
                let tryCode = 0;
                let tryAmt = 0;

                if (code > 0) {
                  const pAmt = baseAmount + code;
                  if (!exists.get('unpaid', pAmt, invId)) {
                    tryCode = code;
                    tryAmt = pAmt;
                  }
                }

                if (!tryAmt && custId > 0) {
                  const prefCode = (custId % 499 === 0) ? 499 : (custId % 499);
                  const pAmt = baseAmount + prefCode;
                  if (!exists.get('unpaid', pAmt, invId)) {
                    tryCode = prefCode;
                    tryAmt = pAmt;
                  }
                }

                if (!tryAmt) {
                  for (let randCode = 1; randCode <= 499; randCode++) {
                    const pAmt = baseAmount + randCode;
                    if (!exists.get('unpaid', pAmt, invId)) {
                      tryCode = randCode;
                      tryAmt = pAmt;
                      break;
                    }
                  }
                }

                if (tryAmt > 0) {
                  code = tryCode;
                  amt = tryAmt;
                  db.prepare('UPDATE invoices SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL()) WHERE id=?').run(code, amt, invId);
                }
              }

              if (amt > 0) {
                finalTagihanStr = amt.toLocaleString('id-ID');
                const qrisPayload = String(getSetting('qris_static_payload', '') || '').trim();
                const qrisEnabledRaw = getSetting('qris_static_enabled', true);
                const qrisEnabled = !(qrisEnabledRaw === false || qrisEnabledRaw === 'false' || qrisEnabledRaw === 0 || qrisEnabledRaw === '0');

                if (qrisEnabled && qrisPayload && typeof qrisUtil.buildDynamicQrisJpgBuffer === 'function') {
                  qrisImageBuffer = await qrisUtil.buildDynamicQrisJpgBuffer(qrisPayload, amt);
                }
              }
            } catch (qrisErr) {
              logger.warn(`[CRON] Gagal generate QRIS dinamis untuk ${c.name}: ${qrisErr.message}`);
            }
          }

          // Format pesan dengan Spintax & variation untuk anti-spam
          let formattedMsg = template
            .replace(/{{nama}}/gi, c.name || 'Pelanggan')
            .replace(/{{tagihan}}/gi, finalTagihanStr)
            .replace(/{{rincian}}/gi, rincianBulan || '-')
            .replace(/{{paket}}/gi, c.package_name || '-')
            .replace(/{{link}}/gi, loginLink);

          const { parseSpintax } = await import('./whatsappBot.mjs');
          formattedMsg = parseSpintax(formattedMsg);

          // Add subtle variation untuk menghindari spam detection
          formattedMsg = addMessageVariation(formattedMsg, i);

          await waSvc.sendWhatsAppMessage(c.phone, formattedMsg);
          const ok = true;
          if (ok) {
            sent++;
            targetCount++;
            batchCount++;
          } else {
            throw new Error('Gagal kirim pesan');
          }

          // Batch Processing: Pause setelah N pesan
          if (batchCount >= batchSize && i < targetCustomers.length - 1) {
            logger.info(`[CRON] Selesai batch ${Math.floor(i / batchSize) + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
            await new Promise(r => setTimeout(r, batchPauseMs));
            batchCount = 0;
          }

          break; // Sukses, keluar dari retry loop
        } catch (e) {
          attemptCount++;
          const errorMsg = e.message || e.toString();

          // Cek apakah error permanent (tidak perlu retry)
          if (isPermanentError(errorMsg)) {
            logger.warn(`[CRON] SKIP: Error permanent untuk ${c.phone} - ${errorMsg}`);
            failed++;
            break; // Skip retry langsung ke pelanggan berikutnya
          }

          // Error temporary, bisa retry
          logger.error(`[CRON] Gagal kirim ke ${c.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);

          if (attemptCount >= maxAttempts) {
            logger.warn(`[CRON] Max attempts tercapai untuk ${c.phone}`);
            failed++;
          } else {
            // Exponential backoff untuk retry
            const backoffDelay = getBackoffDelay(attemptCount);
            logger.info(`[CRON] Retry ke ${c.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
            await new Promise(r => setTimeout(r, backoffDelay));
          }
        }
      }
    }

    logger.info(`[CRON] Pengingat tagihan otomatis selesai: target=${targetCount}, terkirim=${sent}, gagal=${failed}`);
  });

  // 4. Jam Kalong (Night Speed) Start - Jam 00:00
  cron.schedule('0 0 * * *', async () => {
    logger.info('[CRON] Memulai Jam Kalong (Night Speed) - Ganti Profile...');
    try {
      let count = 0;
      const BATCH_SIZE = 100;
      let offset = 0;

      while (true) {
        const batch = db.prepare(
          `SELECT c.id, c.name, c.pppoe_username, c.router_id, c.package_id,
                  p.use_night_speed, p.night_profile_name
           FROM customers c
           JOIN packages p ON c.package_id = p.id
           WHERE c.pppoe_username IS NOT NULL AND c.pppoe_username != ''
             AND p.use_night_speed = 1 AND p.night_profile_name IS NOT NULL AND p.night_profile_name != ''
           LIMIT ? OFFSET ?`
        ).all(BATCH_SIZE, offset);

        if (batch.length === 0) break;

        for (const c of batch) {
          try {
            logger.info(`[CRON] Switching ${c.name} to Night Profile: ${c.night_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, c.night_profile_name, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal switch Jam Kalong untuk ${c.name}: ${err.message}`);
          }
        }

        offset += BATCH_SIZE;
        if (batch.length === BATCH_SIZE) await new Promise(r => setTimeout(r, 200));
      }
      logger.info(`[CRON] Jam Kalong aktif untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong Start: ${e.message}`);
    }
  });

  // 5. Jam Kalong (Night Speed) End - Jam 06:00
  cron.schedule('0 6 * * *', async () => {
    logger.info('[CRON] Mengakhiri Jam Kalong (Night Speed) - Kembali ke Profile Normal...');
    try {
      let count = 0;
      const BATCH_SIZE = 100;
      let offset = 0;

      while (true) {
        const batch = db.prepare(
          `SELECT c.id, c.name, c.pppoe_username, c.router_id, c.package_id,
                  p.use_night_speed, p.name AS normal_profile
           FROM customers c
           JOIN packages p ON c.package_id = p.id
           WHERE c.pppoe_username IS NOT NULL AND c.pppoe_username != ''
             AND p.use_night_speed = 1
           LIMIT ? OFFSET ?`
        ).all(BATCH_SIZE, offset);

        if (batch.length === 0) break;

        for (const c of batch) {
          try {
            logger.info(`[CRON] Restoring ${c.name} to Normal Profile: ${c.normal_profile}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, c.normal_profile, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal restore profil normal untuk ${c.name}: ${err.message}`);
          }
        }

        offset += BATCH_SIZE;
        if (batch.length === BATCH_SIZE) await new Promise(r => setTimeout(r, 200));
      }
      logger.info(`[CRON] Profil normal dikembalikan untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong End: ${e.message}`);
    }
  });

  // 6. Track Usage Pelanggan (Data Traffic) - Setiap 10 Menit
  cron.schedule('*/10 * * * *', async () => {
    const enabled = getSetting('usage_tracking_enabled', true);
    if (!enabled) return;

    try {
      const routers = mikrotikService.getAllRouters();
      // Hanya load pelanggan yang punya pppoe_username (lebih efisien)
      const customers = db.prepare(
        `SELECT c.id, c.pppoe_username FROM customers c
         WHERE c.pppoe_username IS NOT NULL AND c.pppoe_username != '' AND c.status = 'active'`
      ).all();
      const customerMap = new Map();
      customers.forEach(c => customerMap.set(c.pppoe_username, c));

      for (const r of routers) {
        try {
          const actives = await mikrotikService.getPppoeActive(r.id);
          for (const s of actives) {
            const username = s.name;
            const cust = customerMap.get(username);
            if (!cust) continue;

            const totalIn = parseInt(s['bytes-in']) || 0;
            const totalOut = parseInt(s['bytes-out']) || 0;

            const now = new Date();
            const currentUsage = usageSvc.getUsage(cust.id, now.getMonth()+1, now.getFullYear());

            let deltaIn = 0;
            let deltaOut = 0;

            if (currentUsage) {
              if (totalIn < currentUsage.last_total_bytes_in || totalOut < currentUsage.last_total_bytes_out) {
                deltaIn = totalIn;
                deltaOut = totalOut;
              } else {
                deltaIn = totalIn - currentUsage.last_total_bytes_in;
                deltaOut = totalOut - currentUsage.last_total_bytes_out;
              }
            } else {
              deltaIn = totalIn;
              deltaOut = totalOut;
            }

            if (deltaIn > 0 || deltaOut > 0) {
              usageSvc.updateUsage(cust.id, deltaIn, deltaOut, totalIn, totalOut);
            }
          }
        } catch (err) {
          logger.error(`[CRON] Gagal track usage di router ${r.name}: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error Usage Tracking: ${e.message}`);
    }
  });

  // 7. FUP (Fair Usage Policy) Check - Setiap Jam
  cron.schedule('0 * * * *', async () => {
    logger.info('[CRON] Mengecek FUP Pelanggan...');
    try {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const BATCH_SIZE = 100;
      let offset = 0;
      let fupCount = 0;

      while (true) {
        // Hanya ambil pelanggan yang paketnya punya FUP aktif
        const batch = db.prepare(
          `SELECT c.id, c.name, c.pppoe_username, c.router_id,
                  p.fup_limit_gb, p.fup_profile_name
           FROM customers c
           JOIN packages p ON c.package_id = p.id
           WHERE c.pppoe_username IS NOT NULL AND c.pppoe_username != ''
             AND p.use_fup = 1 AND p.fup_limit_gb > 0
             AND p.fup_profile_name IS NOT NULL AND p.fup_profile_name != ''
           LIMIT ? OFFSET ?`
        ).all(BATCH_SIZE, offset);

        if (batch.length === 0) break;

        for (const c of batch) {
          const usage = usageSvc.getUsage(c.id, month, year);
          if (!usage) continue;

          const totalGB = (usage.bytes_in + usage.bytes_out) / (1024 * 1024 * 1024);
          if (totalGB >= c.fup_limit_gb) {
            logger.warn(`[CRON] FUP: ${c.name} (${totalGB.toFixed(2)} GB / ${c.fup_limit_gb} GB). Turunkan kecepatan...`);
            try {
              await mikrotikService.setPppoeProfile(c.pppoe_username, c.fup_profile_name, c.router_id);
              fupCount++;
            } catch (err) {
              logger.error(`[CRON] Gagal apply FUP untuk ${c.name}: ${err.message}`);
            }
          }
        }

        offset += BATCH_SIZE;
        if (batch.length === BATCH_SIZE) await new Promise(r => setTimeout(r, 200));
      }
      logger.info(`[CRON] FUP check selesai. ${fupCount} pelanggan di-throttle.`);
    } catch (e) {
      logger.error(`[CRON] Error FUP Check: ${e.message}`);
    }
  });

  // 8. Auto-Refresh ACS Devices & Sync IPs - Setiap 5 Menit
  cron.schedule('*/5 * * * *', async () => {
    const enabled = getSetting('use_builtin_acs', false) === true || getSetting('use_builtin_acs', false) === 'true';
    if (!enabled) return;

    logger.info('[CRON] Menjalankan sinkronisasi dan auto-refresh ACS Devices...');
    try {
      const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap();
      const acsDevices = db.prepare('SELECT id, ip_address, connection_request_url, params, last_inform FROM acs_devices').all();

      const acsServerService = require('./acsServerService');
      let triggeredCount = 0;
      let ipUpdatedCount = 0;

      for (const dev of acsDevices) {
        let params = {};
        try { params = JSON.parse(dev.params || '{}'); } catch (_) {}

        // Extract PPPoE user
        let pppoeUser = '';
        const pppoeUserKeys = [
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
          'Device.PPP.Interface.1.Username',
          'VirtualParameters.pppoeUsername',
          'VirtualParameters.pppUsername'
        ];
        for (const key of pppoeUserKeys) {
          if (params[key] && params[key] !== '-') {
            pppoeUser = params[key];
            break;
          }
        }
        
        if (!pppoeUser) {
          for (const key of Object.keys(params)) {
            if (key.toLowerCase().includes('wanpppconnection') && key.toLowerCase().endsWith('.username') && params[key]) {
              pppoeUser = params[key];
              break;
            }
          }
        }

        if (!pppoeUser || pppoeUser === '-') continue;

        const activeSession = activeSessionsMap.get(pppoeUser.toLowerCase());
        if (activeSession) {
          const currentIp = activeSession.ip;
          
          if (currentIp && currentIp !== dev.ip_address) {
            logger.info(`[ACS-Sync] IP address changed for device ${dev.id} (${pppoeUser}): ${dev.ip_address} -> ${currentIp}`);
            
            let newCrUrl = dev.connection_request_url || '';
            if (newCrUrl) {
              try {
                if (newCrUrl.startsWith('http')) {
                  const urlObj = new URL(newCrUrl);
                  urlObj.hostname = currentIp;
                  newCrUrl = urlObj.toString();
                } else {
                  newCrUrl = newCrUrl.replace(/(https?:\/\/)([^:/]+)(.*)/, `$1${currentIp}$3`);
                }
              } catch (e) {
                newCrUrl = newCrUrl.replace(/(https?:\/\/)([^:/]+)(.*)/, `$1${currentIp}$3`);
              }
            } else {
              newCrUrl = `http://${currentIp}:58000/`;
            }

            const now = new Date().toISOString();
            db.prepare('UPDATE acs_devices SET ip_address = ?, connection_request_url = ?, updated_at = ? WHERE id = ?')
              .run(currentIp, newCrUrl, now, dev.id);
            
            ipUpdatedCount++;
            
            dev.ip_address = currentIp;
            dev.connection_request_url = newCrUrl;
          }

          const lastInformTime = dev.last_inform ? new Date(dev.last_inform).getTime() : 0;
          const isStale = (Date.now() - lastInformTime) > 15 * 60 * 1000;

          if (isStale) {
            logger.info(`[ACS-Sync] Device ${dev.id} (${pppoeUser}) is active on MikroTik but offline/stale in ACS. Triggering connection request to refresh data.`);
            acsServerService.triggerConnectionRequest(dev.id).catch(err => {
              logger.warn(`[ACS-Sync] Failed to trigger connection request for ${dev.id}: ${err.message}`);
            });
            triggeredCount++;
          }
        }
      }

      logger.info(`[CRON] Selesai sinkronisasi ACS. IP diperbarui: ${ipUpdatedCount}, Connection requests dipicu: ${triggeredCount}`);
    } catch (e) {
      logger.error(`[CRON] Error Auto-Refresh ACS: ${e.message}`);
    }
  });

  logger.info('[CRON] Semua tugas penjadwalan telah aktif.');
}

module.exports = { startCronJobs };
