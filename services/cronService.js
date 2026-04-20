/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const mikrotikService = require('./mikrotikService');
const { getSetting } = require('../config/settingsManager');

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
    const today = new Date().getDate();
    // Kita cek semua pelanggan setiap hari untuk isolir otomatis
    logger.info(`[CRON] Menjalankan pengecekan isolir otomatis harian (Tanggal ${today})`);
    
    const customers = customerSvc.getAllCustomers();
    let isolatedCount = 0;

    for (const c of customers) {
      // Cek apakah isolir otomatis aktif untuk user ini dan hari ini adalah tanggal isolirnya
      const customerIsolirDay = c.isolate_day || 10;
      const isAutoIsolateEnabled = c.auto_isolate !== 0; // default aktif jika null/1

      if (isAutoIsolateEnabled && today >= customerIsolirDay) {
        // Jika pelanggan aktif tapi punya tagihan belum bayar
        if (c.status === 'active' && c.unpaid_count > 0) {
          try {
            logger.info(`[CRON] Isolir otomatis pelanggan: ${c.name} (${c.pppoe_username}) - Tanggal Tagihan: ${customerIsolirDay}`);
            
            // Gunakan fungsi terpusat untuk isolir
            await customerSvc.suspendCustomer(c.id);
            
            isolatedCount++;
          } catch (err) {
            logger.error(`[CRON] Gagal isolir ${c.name}: ${err.message}`);
          }
        }
      }
    }
    logger.info(`[CRON] Selesai pengecekan isolir. Total ${isolatedCount} pelanggan baru di-isolir.`);
  });

  logger.info('[CRON] Semua tugas penjadwalan telah aktif.');
}

module.exports = { startCronJobs };
