/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getCurrentDateInTimezone, getSetting } = require('../config/settingsManager');

// ─── HELPER FUNCTIONS ─────────────────────────────────────────
/**
 * Get effective router_id for a customer
 * Respects multi-router mode setting:
 * - If mode is 'active': returns customer's router_id if set.
 *   For legacy single-router customers with NULL router_id, it falls back to
 *   explicit default_router_id or the only active router (if exactly one exists).
 * - If mode is 'disabled': returns customer's router_id if set, else auto-detect
 *   - First tries explicit default_router_id setting
 *   - If not set, auto-detects first (smallest ID) available router
 */
function getEffectiveRouterId(customerRouterId) {
  const mode = getSetting('multi_router_mode', 'disabled');

  if (customerRouterId && customerRouterId > 0) {
    return customerRouterId;
  }

  const explicitDefault = getSetting('default_router_id', null);
  if (explicitDefault) {
    const parsed = parseInt(explicitDefault, 10);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  try {
    if (mode === 'active') {
      // In multi-router mode, only fall back automatically if there is exactly one active router.
      const routers = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 2').all();
      if (routers.length === 1 && routers[0].id > 0) {
        logger.warn(`[getEffectiveRouterId] router_id pelanggan kosong saat multi-router aktif. Fallback ke satu-satunya router aktif: ${routers[0].id}`);
        return routers[0].id;
      }
      return null;
    }

    // Mode: disabled (single router with fallback) - auto-detect first active router
    const router = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    if (router && router.id > 0) {
      return router.id;
    }
  }

  catch (e) {
    // Ignore if routers table doesn't exist or query fails
  }

  return null;
}

// ─── CUSTOMERS ───────────────────────────────────────────────
function calculateExpiredAt(startDateStr, durationDays = 30) {
  const d = startDateStr ? new Date(startDateStr) : new Date();
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (parseInt(durationDays, 10) || 30));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day} 23:59:59`;
}

function getAllCustomers(search = '', routerId = null, filterStatus = '', filterArea = '') {
  const now = getCurrentDateInTimezone();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.billing_type as package_billing_type, p.duration_days as package_duration_days,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name,
           o.name as olt_name,
           odp.name as odp_name,
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count,
           u.bytes_in, u.bytes_out
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
  `;

  const whereClauses = [];
  const params = [];

  if (search) {
    const s = `%${search}%`;
    whereClauses.push(`(c.name LIKE ? OR c.phone LIKE ? OR c.nik LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ? OR c.area LIKE ? OR c.pppoe_username LIKE ? OR c.static_ip LIKE ? OR c.hotspot_username LIKE ?)`);
    params.push(s, s, s, s, s, s, s, s, s);
  }

  const rId = routerId ? Number(routerId) : null;
  if (rId && rId > 0) {
    whereClauses.push(`c.router_id = ?`);
    params.push(rId);
  }

  if (filterStatus) {
    whereClauses.push(`c.status = ?`);
    params.push(filterStatus);
  }

  if (filterArea) {
    whereClauses.push(`LOWER(TRIM(c.area)) = LOWER(TRIM(?))`);
    params.push(filterArea);
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ` + whereClauses.join(' AND ') : '';
  return db.prepare(base + whereSql + ` ORDER BY c.name ASC`).all(...params);
}

function getAllCustomerAreas() {
  try {
    const hasCustArea = db.prepare("PRAGMA table_info(customers)").all().some(c => c.name === 'area');
    const hasColArea = db.prepare("PRAGMA table_info(collectors)").all().some(c => c.name === 'area');
    const hasTechArea = db.prepare("PRAGMA table_info(technicians)").all().some(c => c.name === 'area');

    const queries = [];
    if (hasCustArea) queries.push("SELECT area FROM customers WHERE area IS NOT NULL AND TRIM(area) != ''");
    if (hasColArea) queries.push("SELECT area FROM collectors WHERE area IS NOT NULL AND TRIM(area) != ''");
    if (hasTechArea) queries.push("SELECT area FROM technicians WHERE area IS NOT NULL AND TRIM(area) != ''");

    if (queries.length === 0) return [];

    const unionSql = `SELECT DISTINCT TRIM(area) as area FROM (` + queries.join(' UNION ') + `) ORDER BY area ASC`;
    const rows = db.prepare(unionSql).all();
    return rows.map(r => r.area).filter(Boolean);
  } catch (e) {
    logger.warn('[CustomerService] getAllCustomerAreas error:', e.message);
    return [];
  }
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function getCustomerById(id) {
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.billing_type as package_billing_type, p.duration_days as package_duration_days,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           r.name as router_name, o.name as olt_name, odp.name as odp_name
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    WHERE c.id = ?
  `).get(id);
}

function createCustomer(data) {
  let expiredAt = data.expired_at || null;
  if (!expiredAt && data.package_id) {
    const pkg = db.prepare('SELECT billing_type, duration_days FROM packages WHERE id=?').get(data.package_id);
    if (pkg && pkg.billing_type === 'prepaid') {
      const baseDate = data.install_date || new Date().toISOString().slice(0, 10);
      expiredAt = calculateExpiredAt(baseDate, pkg.duration_days || 30);
    }
  }

  return db.prepare(`
    INSERT INTO customers (nik, name, phone, email, address, area, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, pppoe_password, pppoe_remote_address, isolir_profile, status, install_date, expired_at, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address, hotspot_username, hotspot_password, hotspot_profile, collector_id, is_radius)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.nik ? String(data.nik).trim() : '',
    data.name, data.phone || '', data.email || '', data.address || '',
    data.area ? String(data.area).trim() : '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null,
    expiredAt,
    data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null,
    data.is_radius !== undefined ? parseInt(data.is_radius) : 1
  );
}

function updateCustomer(id, data) {
  const prev = db.prepare('SELECT package_id, expired_at, install_date FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);

  let expiredAt = data.expired_at !== undefined ? data.expired_at : (prev ? prev.expired_at : null);
  if (!expiredAt && newPkgId) {
    const pkg = db.prepare('SELECT billing_type, duration_days FROM packages WHERE id=?').get(newPkgId);
    if (pkg && pkg.billing_type === 'prepaid') {
      const baseDate = data.install_date || (prev ? prev.install_date : null) || new Date().toISOString().slice(0, 10);
      expiredAt = calculateExpiredAt(baseDate, pkg.duration_days || 30);
    }
  }

  const result = db.prepare(`
    UPDATE customers SET nik=?, name=?, phone=?, email=?, address=?, area=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, pppoe_password=?, pppoe_remote_address=?, isolir_profile=?, status=?, install_date=?, expired_at=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?, hotspot_username=?, hotspot_password=?, hotspot_profile=?, collector_id=?, is_radius=?
    WHERE id=?
  `).run(
    data.nik !== undefined ? (data.nik ? String(data.nik).trim() : '') : (prev.nik || ''),
    data.name, data.phone || '', data.email || '', data.address || '',
    data.area ? String(data.area).trim() : '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null,
    expiredAt,
    data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.cable_path || null,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null,
    data.is_radius !== undefined ? parseInt(data.is_radius) : 1,
    id
  );

  if (pkgChanged) {
    db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
  }

  return result;
}

function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

async function deleteCustomer(id) {
  const customer = getCustomerById(id);
  const mikrotikSvc = require('./mikrotikService');
  
  // WARNING: Check if customer has MikroTik connections without router_id
  const hasMikrotikConnection = customer && (
    customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username
  );
  
  if (hasMikrotikConnection && !customer.router_id) {
    logger.warn(`[deleteCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL. Akun tidak akan dihapus dari MikroTik.`);
  }
  
  // Remove static IP if connection type is static
  if (customer && customer.connection_type === 'static' && customer.static_ip && customer.router_id) {
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  
  // CATATAN: Sesuai permintaan, akun/secret PPPoE di MikroTik TIDAK dihapus saat pelanggan dihapus
  // agar data user PPPoE di MikroTik tetap aman dan tidak terhapus.
  if (customer && customer.connection_type === 'pppoe' && customer.pppoe_username) {
    logger.info(`[deleteCustomer] Pelanggan "${customer.name}" dihapus dari billing. Akun PPPoE "${customer.pppoe_username}" di MikroTik dipertahankan.`);
  }

  // Remove Hotspot user if connection type is hotspot and username exists
  if (customer && customer.connection_type === 'hotspot' && customer.hotspot_username && customer.router_id) {
    try {
      // Get hotspot user to find the ID
      const hotspotUser = await mikrotikSvc.getHotspotUserByName(customer.hotspot_username, customer.router_id);
      
      if (hotspotUser && hotspotUser.id) {
        await mikrotikSvc.deleteHotspotUser(hotspotUser.id, customer.router_id);
        console.log(`Successfully removed Hotspot user ${customer.hotspot_username} from MikroTik`);
      } else {
        console.warn(`Hotspot user ${customer.hotspot_username} not found in MikroTik`);
      }
    } catch (e) {
      console.error('Failed to remove Hotspot user from MikroTik during customer deletion:', e);
    }
  }
  
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

async function bulkDeleteCustomers(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  let deleted = 0;
  for (const id of ids) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) continue;
    try {
      await deleteCustomer(numId);
      deleted++;
    } catch (e) {
      logger.error(`[bulkDeleteCustomers] Gagal menghapus pelanggan ${numId}: ${e.message}`);
    }
  }
  return deleted;
}

function getCustomerStats() {
  return {
    total:        db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    active:       db.prepare("SELECT COUNT(*) as c FROM customers WHERE status IN ('active', 'ditangguhkan')").get().c,
    ditangguhkan: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='ditangguhkan'").get().c,
    suspended:    db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='suspended'").get().c,
    inactive:     db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='inactive'").get().c,
  };
}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages(routerId = null) {
  const rId = routerId ? Number(routerId) : null;
  try {
    if (rId && rId > 0) {
      return db.prepare(`
        SELECT p.*, r.name as router_name, COUNT(c.id) as customer_count
        FROM packages p 
        LEFT JOIN customers c ON c.package_id = p.id
        LEFT JOIN routers r ON p.router_id = r.id
        WHERE p.router_id IS NULL OR p.router_id = ?
        GROUP BY p.id ORDER BY p.price ASC
      `).all(rId);
    }
    return db.prepare(`
      SELECT p.*, r.name as router_name, COUNT(c.id) as customer_count
      FROM packages p 
      LEFT JOIN customers c ON c.package_id = p.id
      LEFT JOIN routers r ON p.router_id = r.id
      GROUP BY p.id ORDER BY p.price ASC
    `).all();
  } catch (e) {
    if (String(e?.message || '').includes('no such column')) {
      return db.prepare(`
        SELECT p.*, NULL as router_name, COUNT(c.id) as customer_count
        FROM packages p 
        LEFT JOIN customers c ON c.package_id = p.id
        GROUP BY p.id ORDER BY p.price ASC
      `).all();
    }
    throw e;
  }
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}

function createPackage(data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const down_upto = Math.round(parseFloat(data.speed_down_upto || 0) * 1000);
  const up_upto = Math.round(parseFloat(data.speed_up_upto || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);

  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);
  const routerId = data.router_id ? parseInt(data.router_id, 10) : null;
  const billingType = (data.billing_type === 'prepaid') ? 'prepaid' : 'postpaid';
  const durationDays = Math.max(1, parseInt(data.duration_days, 10) || 30);

  return db.prepare(`
    INSERT INTO packages (
      name, price, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, speed_down_upto, speed_up_upto,
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description,
      billing_type, duration_days,
      use_ppn, ppn_percentage, use_uso, uso_percentage, router_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up, down_upto, up_upto,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '',
    billingType, durationDays,
    usePpn, ppnPercentage, useUso, usoPercentage, routerId
  );
}

function parsePromoPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updatePackage(id, data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const down_upto = Math.round(parseFloat(data.speed_down_upto || 0) * 1000);
  const up_upto = Math.round(parseFloat(data.speed_up_upto || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);
  const routerId = data.router_id ? parseInt(data.router_id, 10) : null;
  const billingType = (data.billing_type === 'prepaid') ? 'prepaid' : 'postpaid';
  const durationDays = Math.max(1, parseInt(data.duration_days, 10) || 30);

  return db.prepare(`
    UPDATE packages 
    SET name=?, price=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, speed_down_upto=?, speed_up_upto=?,
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=?,
        billing_type=?, duration_days=?,
        use_ppn=?, ppn_percentage=?, use_uso=?, uso_percentage=?, router_id=?
    WHERE id=?
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up, down_upto, up_upto,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0,
    billingType, durationDays,
    usePpn, ppnPercentage, useUso, usoPercentage, routerId,
    id
  );
}

function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function findCustomerByAny(val) {
  if (!val) return null;
  const cleanVal = val.toString().trim();
  
  // 1. Try Phone (Priority for Login)
  const phoneDigits = cleanVal.replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    // Cari yang 8-10 digit terakhirnya sama (lebih akurat untuk 08 vs 62)
    const suffix = phoneDigits.slice(-9);
    const p1 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${suffix}`);
    if (p1) return getCustomerById(p1.id);
  }

  // 2. Try GenieACS Tag (Exact Match)
  const byTag = db.prepare('SELECT id FROM customers WHERE genieacs_tag = ?').get(cleanVal);
  if (byTag) return getCustomerById(byTag.id);

  // 3. Try PPPoE Username (Exact Match)
  const byPppoe = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanVal);
  if (byPppoe) return getCustomerById(byPppoe.id);

  // 4. Try MAC Address (Exact Match or Partial Match for ONU MAC format)
  // Handle ONU MAC format like: F4B5AA-ZXHN%20F477-01FFFFFFFF011FFF23F4B5AA7D806FBA
  const byMac = db.prepare('SELECT id FROM customers WHERE mac_address = ?').get(cleanVal);
  if (byMac) return getCustomerById(byMac.id);
  
  // Try partial MAC match (first part before dash for ONU format)
  if (cleanVal.includes('-')) {
    const macPrefix = cleanVal.split('-')[0];
    if (macPrefix.length >= 6) {
      const byMacPrefix = db.prepare('SELECT id FROM customers WHERE mac_address LIKE ?').get(`${macPrefix}%`);
      if (byMacPrefix) return getCustomerById(byMacPrefix.id);
    }
  }

  // 5. Try ID if numeric
  if (/^\d+$/.test(cleanVal) && cleanVal.length < 8) {
    const c = getCustomerById(parseInt(cleanVal));
    if (c) return c;
  }
  
  return null;
}

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  const mikrotikSvc = require('./mikrotikService');

  // Get effective router_id (respects multi-router mode setting)
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  // Validate router_id is present if customer has MikroTik connection
  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[suspendCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL dan tidak ada default router. Isolir lokal hanya, MikroTik tidak diupdate.`);
    updateCustomer(id, { ...customer, status: 'suspended' });
    return;
  }

  // UPDATE MIKROTIK DULU sebelum update database status (priority: network change)
  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: customer.name,
        limit: limit,
        isolate: true
      }, effectiveRouterId);
    } else if (customer.pppoe_username) {
      const isolirProfile = customer.isolir_profile || 'isolir';
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, effectiveRouterId);
      if (effectiveRouterId) {
        try {
          await mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, effectiveRouterId);
        } catch (e) {
          logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${effectiveRouterId}: ${e.message}`);
        }
      }
    } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
      await mikrotikSvc.setHotspotUserDisabled(customer.hotspot_username, true, effectiveRouterId);
    }
  } catch (mikrotikErr) {
    logger.error(`[suspendCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
    // Continue execution - update database status despite MikroTik error (graceful degradation)
  }

  // Update database status SETELAH MikroTik berhasil (atau gagal tapi continue)
  updateCustomer(id, { ...customer, status: 'suspended' });

  // WhatsApp Notification
  if (customer.phone) {
    try {
      const { getSetting } = require('../config/settingsManager');
      if (getSetting('whatsapp_enabled', false)) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan lakukan pembayaran segera melalui portal pelanggan: {{link}}\n\nTerima kasih.`;
          const template = db.getAppSetting('whatsapp_isolir_message', defaultIsolir);

          // Get unpaid invoices & calculate total amount
          const billingSvc = require('./billingService');
          const { formatUnpaidInvoicesSummary } = require('./whatsappService');
          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
          const summary = formatUnpaidInvoicesSummary(unpaidInvoices);
          const totalTagihan = summary.totalAmount;
          const displayPeriode = summary.isMultiple
            ? `${summary.periodText}\n\n📋 *Rincian Tunggakan:*\n${summary.breakdownText}`
            : summary.periodText;

          // Generate Login Link
          const explicitBaseUrl = String(getSetting('public_base_url', '') || '').trim();
          let baseUrl = explicitBaseUrl.replace(/\/+$/, '');
          if (!baseUrl) {
            const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
            const port = Number(getSetting('server_port', 3001) || 3001);
            const proto = port === 443 ? 'https' : 'http';
            const host = /^https?:\/\//i.test(hostRaw) ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
            baseUrl = (port === 80 || port === 443) ? host : `${host}:${port}`;
          }
          const loginLink = `${baseUrl}/customer/login`;

          let formattedMsg = template
            .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
            .replace(/{{paket}}/gi, customer.package_name || '-')
            .replace(/{{tagihan}}/gi, summary.totalAmountStr || totalTagihan.toLocaleString('id-ID'))
            .replace(/{{rincian_detail}}/gi, summary.isMultiple ? `📋 *Rincian Tunggakan:*\n${summary.breakdownText}` : '')
            .replace(/{{rincian}}/gi, displayPeriode || '-')
            .replace(/{{periode}}/gi, displayPeriode || '-')
            .replace(/{{link}}/gi, loginLink);

          if (summary.isMultiple && !template.includes('{{periode}}') && !template.includes('{{rincian}}')) {
            const extraInfo = `\n\n📌 *Periode Tunggakan:* ${summary.periodText}\n📋 *Rincian Tunggakan:*\n${summary.breakdownText}`;
            if (formattedMsg.includes('Silakan lakukan pembayaran')) {
              formattedMsg = formattedMsg.replace('Silakan lakukan pembayaran', `${extraInfo}\n\nSilakan lakukan pembayaran`);
            } else {
              formattedMsg += extraInfo;
            }
          }

          await sendWA(customer.phone, formattedMsg);
        }
      }
    } catch (waErr) {
      logger.error(`[suspendCustomer] Gagal kirim notif WhatsApp isolir: ${waErr.message}`);
    }
  }

  return true;
}

function _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus) {
  if (wasSuspended && (targetStatus === 'active' || targetStatus === 'ditangguhkan') && customer.package_id) {
    try {
      const now = new Date();
      const curMonth = now.getMonth() + 1;
      const curYear = now.getFullYear();
      const existingCurInv = db.prepare('SELECT id FROM invoices WHERE customer_id = ? AND period_month = ? AND period_year = ? LIMIT 1').get(id, curMonth, curYear);
      if (!existingCurInv) {
        const billingSvc = require('./billingService');
        billingSvc.generateInvoiceForCustomer(id, curMonth, curYear);
        logger.info(`[activateCustomer] Pelanggan "${customer.name}" (ID: ${id}) dibuka dari isolir (status: ${targetStatus}). Tagihan periode berjalan ${curMonth}/${curYear} otomatis diterbitkan.`);
      }
    } catch (invErr) {
      logger.error(`[activateCustomer] Gagal generate tagihan periode berjalan untuk pelanggan "${customer.name}" (ID: ${id}): ${invErr.message}`);
    }
  }
}

async function activateCustomer(id, targetStatus = 'active') {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  const wasSuspended = (customer.status === 'suspended' || customer.status === 'isolated');

  // Get effective router_id (respects multi-router mode setting)
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  // Validate router_id is present if customer has MikroTik connection
  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[activateCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL dan tidak ada default router. Aktivasi lokal hanya, MikroTik tidak diupdate.`);
    updateCustomer(id, { ...customer, status: targetStatus });
    _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus);
    return;
  }

  const mikrotikSvc = require('./mikrotikService');

  // UPDATE MIKROTIK DULU sebelum update database status (priority: network change)
  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: customer.name,
        limit: limit,
        isolate: false
      }, effectiveRouterId);
    } else if (customer.pppoe_username) {
      const pkg = getPackageById(customer.package_id);
      const targetProfile = pkg ? pkg.name : 'default';
      
      // Validasi profile tidak kosong
      if (!targetProfile || String(targetProfile).trim() === '') {
        logger.warn(`[activateCustomer] Profile kosong untuk PPPoE user "${customer.pppoe_username}". Gunakan profile 'default'.`);
      }
      
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, effectiveRouterId);
    } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
      const pkg = getPackageById(customer.package_id);
      const targetProfile = String(customer.hotspot_profile || '').trim() || (pkg ? pkg.name : '');
      await mikrotikSvc.upsertHotspotUser({
        username: String(customer.hotspot_username || '').trim(),
        password: String(customer.hotspot_password || '').trim(),
        profile: targetProfile,
        macAddress: String(customer.mac_address || '').trim(),
        disabled: false
      }, effectiveRouterId);
    }
  } catch (mikrotikErr) {
    logger.error(`[activateCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
    // Continue execution - update database status despite MikroTik error (graceful degradation)
  }

  // Update database status SETELAH MikroTik berhasil (atau gagal tapi continue)
  updateCustomer(id, { ...customer, status: targetStatus });
  _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus);
  return true;
}

/**
 * Top-up / Deposit or Adjust Customer Balance manually by Admin/Cashier
 * @param {number|string} customerId 
 * @param {number} amount - positive number
 * @param {string} note - memo or payment source
 * @param {string} actorName - admin or cashier name
 * @param {'add'|'deduct'} actionType - 'add' or 'deduct'
 * @param {boolean} sendWhatsApp - whether to send WA notification
 */
async function topupCustomerBalance(customerId, amount, note = '', actorName = 'Admin', actionType = 'add', sendWhatsApp = true) {
  const cid = Number(customerId);
  const amt = Math.abs(Number(amount) || 0);
  if (!cid || amt <= 0) {
    throw new Error('ID Pelanggan dan nominal valid wajib diisi.');
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
  if (!customer) {
    throw new Error('Pelanggan tidak ditemukan.');
  }

  const isDeduct = actionType === 'deduct';
  const delta = isDeduct ? -amt : amt;
  const before = Number(customer.balance || 0);
  const after = Math.max(0, before + delta);

  // Execute in SQLite transaction
  db.transaction(() => {
    db.prepare('UPDATE customers SET balance = ? WHERE id = ?').run(after, cid);

    const orderId = `MANUAL-${Date.now()}`;
    const desc = note ? note.trim() : (isDeduct ? `Penyesuaian/Pemotongan Saldo oleh ${actorName}` : `Deposit Manual oleh ${actorName}`);
    
    try {
      db.prepare(`
        INSERT INTO customer_topup_requests (
          customer_id, amount, payment_gateway, payment_order_id, payment_reference, payment_payload, status, paid_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'paid', (NOW_LOCAL()), (NOW_LOCAL()), (NOW_LOCAL()))
      `).run(
        cid,
        delta,
        'MANUAL_ADMIN',
        orderId,
        desc,
        JSON.stringify({ actorName, actionType, note: desc, before, after, timestamp: new Date().toISOString() })
      );
    } catch (tblErr) {
      logger.warn('[topupCustomerBalance] customer_topup_requests insert error: ' + tblErr.message);
    }
  })();

  // WhatsApp Notification
  if (sendWhatsApp && customer.phone) {
    try {
      const { getSettings } = require('../config/settingsManager');
      const settings = getSettings();
      if (settings.whatsapp_enabled) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const waMsg = !isDeduct
            ? `✅ *DEPOSIT SALDO BERHASIL*\n\n` +
              `Halo *${customer.name}*,\n` +
              `Deposit saldo dompet Anda telah berhasil ditambahkan oleh pihak admin/kasir.\n\n` +
              `💰 *Nominal:* Rp ${amt.toLocaleString('id-ID')}\n` +
              `💳 *Total Saldo Sekarang:* Rp ${after.toLocaleString('id-ID')}\n` +
              `📝 *Keterangan:* ${note || 'Setor Tunai / Manual'}\n` +
              `👤 *Diterima oleh:* ${actorName}\n\n` +
              `Saldo dapat langsung digunakan untuk pembelian pulsa, paket data, voucher, atau token PLN di portal/aplikasi Alijaya. Terima kasih!`
            : `⚠️ *PENYESUAIAN SALDO DOMPET*\n\n` +
              `Halo *${customer.name}*,\n` +
              `Terdapat penyesuaian/pemotongan saldo dompet Anda oleh pihak admin.\n\n` +
              `🔻 *Nominal:* -Rp ${amt.toLocaleString('id-ID')}\n` +
              `💳 *Sisa Saldo:* Rp ${after.toLocaleString('id-ID')}\n` +
              `📝 *Keterangan:* ${note || 'Penyesuaian Saldo'}\n` +
              `👤 *Petugas:* ${actorName}`;

          await sendWA(customer.phone, waMsg);
        }
      }
    } catch (waErr) {
      logger.error('[topupCustomerBalance] WA notification error: ' + waErr.message);
    }
  }

  return {
    success: true,
    customerId: cid,
    customer,
    before,
    after,
    delta,
    actionType
  };
}

module.exports = {
  getAllCustomers, getAllCustomerAreas, getCustomerById, createCustomer, updateCustomer, deleteCustomer, bulkDeleteCustomers, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed, getEffectiveRouterId, topupCustomerBalance
};
