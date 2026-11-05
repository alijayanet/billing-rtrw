/**
 * Voucher Cache Warmer Service
 * Melakukan pre-warming cache untuk voucher profiles dan payment channels
 * agar halaman voucher selalu cepat diakses
 */

const { logger } = require('../config/logger');
const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');

// Flag untuk mencegah multiple warming berjalan bersamaan
let isWarming = false;
let warmingInterval = null;

/**
 * Warm up voucher cache
 * Dipanggil secara berkala untuk memastikan cache selalu fresh
 */
async function warmVoucherCache() {
  if (isWarming) {
    logger.debug('[VoucherCacheWarmer] Already warming, skip');
    return;
  }

  isWarming = true;
  const startTime = Date.now();

  try {
    // Import di dalam fungsi untuk menghindari circular dependency
    const mikrotikService = require('./mikrotikService');
    const paymentSvc = require('./paymentService');
    const { getSettingsWithCache } = require('../config/settingsManager');
    const db = require('../config/database');

    logger.info('[VoucherCacheWarmer] Starting cache warming...');

    // Get settings
    const settings = getSettingsWithCache();

    // 1. Warm voucher profiles cache
    const CACHE_KEY = 'voucher_profiles_cache';
    const routers = mikrotikService.getAllRouters().filter(r => r.is_active);
    const routerList = routers.length > 0 ? routers : [{ id: null, name: '' }];

    // Query database dan MikroTik secara parallel
    const [configuredPricesMap, mikrotikResults] = await Promise.all([
      (async () => {
        const map = new Map();
        try {
          const rows = db.prepare(`
            SELECT router_id, profile_name, price, validity
            FROM voucher_batches
            WHERE price > 0
            GROUP BY router_id, profile_name
            HAVING id = MAX(id)
          `).all();
          for (const row of rows) {
            const key = `${row.router_id}_${row.profile_name}`;
            map.set(key, { price: row.price, validity: row.validity });
          }
        } catch (e) {
          logger.error('[VoucherCacheWarmer] Error loading configured prices: ' + e.message);
        }
        return map;
      })(),
      (async () => {
        try {
          // Query semua router secara parallel dengan timeout per router
          const results = await Promise.allSettled(
            routerList.map(r =>
              Promise.race([
                mikrotikService.getHotspotUserProfiles(r.id),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`Timeout for router ${r.name || r.id}`)), 4000)
                )
              ])
            )
          );
          return results;
        } catch (e) {
          logger.error('[VoucherCacheWarmer] Error querying MikroTik: ' + e.message);
          return [];
        }
      })()
    ]);

    // Process profiles
    const allRows = [];
    if (Array.isArray(mikrotikResults)) {
      for (let i = 0; i < mikrotikResults.length; i++) {
        const result = mikrotikResults[i];
        const router = routerList[i];
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
          logger.warn(`[VoucherCacheWarmer] Router ${router.name || router.id} query failed or returned invalid data`);
          continue;
        }
        for (const p of result.value) {
          allRows.push({
            routerId: router.id ?? null,
            name: p?.name,
            onLogin: p?.onLogin ?? p?.['on-login']
          });
        }
      }
    }

    logger.info(`[VoucherCacheWarmer] Found ${allRows.length} profiles from MikroTik`);

    const bestByName = new Map();
    let skippedCount = 0;
    for (const row of allRows) {
      const name = String(row.name || '').trim();
      if (!name) continue;

      // Parse Mikhmon metadata (gunakan shared parser agar konsisten dengan route handler)
      const onLogin = String(row.onLogin || '').trim();
      const meta = parseMikhmonOnLogin(onLogin);
      let price = Number(meta?.price || 0) || 0;
      let validity = String(meta?.validity || '').trim();
      
      if (price <= 0 || !validity) {
        const key = `${row.routerId}_${name}`;
        const configured = configuredPricesMap.get(key);
        if (configured) {
          price = Number(configured.price || 0) || 0;
          validity = String(configured.validity || '').trim();
        }
      }
      
      if (price <= 0) {
        skippedCount++;
        logger.debug(`[VoucherCacheWarmer] Skipped profile "${name}" - no price (onLogin: ${onLogin || 'empty'})`);
        continue;
      }
      if (!validity) validity = '-';

      const existing = bestByName.get(name);
      if (!existing || Number(price) < Number(existing.price || 0)) {
        bestByName.set(name, { name, validity, price, router_id: row.routerId });
      }
    }
    
    if (skippedCount > 0) {
      logger.warn(`[VoucherCacheWarmer] Skipped ${skippedCount} profiles without price metadata. Add Mikhmon metadata (e.g., $10000^1d) to profile's on-login script or configure price in voucher_batches table.`);
    }

    const profiles = Array.from(bestByName.values()).sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    
    // Save to cache
    global[CACHE_KEY] = {
      data: profiles,
      timestamp: Date.now()
    };

    logger.info(`[VoucherCacheWarmer] Profiles cached: ${profiles.length} profiles`);

    // 2. Warm payment channels cache
    const gateway = settings.default_gateway || 'tripay';
    if (!gateway || gateway === 'qris_static') {
      // QRIS Statis: Hanya gunakan QRIS Nominal Unik, tanpa Virtual Account tambahan
      return;
    }

    const gatewayEnabled = {
      tripay: settings.tripay_enabled && settings.tripay_api_key,
      midtrans: settings.midtrans_enabled && settings.midtrans_server_key,
      xendit: settings.xendit_enabled && settings.xendit_api_key,
      duitku: settings.duitku_enabled && settings.duitku_api_key
    };

    if (gatewayEnabled[gateway]) {
      const PAYMENT_CACHE_KEY = `voucher_payment_channels_cache_${gateway}`;
      let channels = [];

      if (gateway === 'tripay') {
        try {
          channels = await Promise.race([
            paymentSvc.getTripayChannels(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
          ]);
        } catch (e) {
          logger.warn('[VoucherCacheWarmer] Tripay channels fetch failed: ' + e.message);
          channels = [];
        }
      } else if (gateway === 'midtrans') {
        channels = [{ code: 'SNAP', name: 'Semua Metode (Snap)', group: 'E-Wallet', active: true }];
      } else if (gateway === 'xendit') {
        channels = [{ code: 'XENDIT', name: 'Semua Metode', group: 'E-Wallet', active: true }];
      } else if (gateway === 'duitku') {
        channels = [{ code: 'DUITKU', name: 'Semua Metode', group: 'E-Wallet', active: true }];
      } else {
        channels = [];
      }

      global[PAYMENT_CACHE_KEY] = {
        data: channels,
        timestamp: Date.now()
      };

      logger.info(`[VoucherCacheWarmer] Payment channels cached: ${channels.length} channels`);
    }

    const duration = Date.now() - startTime;
    logger.info(`[VoucherCacheWarmer] Cache warming completed in ${duration}ms`);

  } catch (error) {
    logger.error('[VoucherCacheWarmer] Error warming cache:', error.message);
  } finally {
    isWarming = false;
  }
}

/**
 * Start background cache warming
 * Warm cache setiap 8 menit (sebelum cache 10 menit expired)
 */
function startCacheWarming() {
  if (warmingInterval) {
    logger.warn('[VoucherCacheWarmer] Already started');
    return;
  }

  // Warm immediately on start (500ms delay agar app sudah siap)
  setTimeout(() => {
    warmVoucherCache().catch(err => {
      logger.error('[VoucherCacheWarmer] Initial warming failed:', err.message);
    });
  }, 500); // 500ms setelah aplikasi start (lebih cepat siap)

  // Then warm every 8 minutes
  warmingInterval = setInterval(() => {
    warmVoucherCache().catch(err => {
      logger.error('[VoucherCacheWarmer] Periodic warming failed:', err.message);
    });
  }, 3 * 60 * 1000); // 3 menit (agar profile selalu up-to-date)

  logger.info('[VoucherCacheWarmer] Background cache warming started (every 3 minutes)');
}

/**
 * Stop background cache warming
 */
function stopCacheWarming() {
  if (warmingInterval) {
    clearInterval(warmingInterval);
    warmingInterval = null;
    logger.info('[VoucherCacheWarmer] Background cache warming stopped');
  }
}

module.exports = {
  warmVoucherCache,
  startCacheWarming,
  stopCacheWarming
};

// Made with Bob
