const db = require('../config/database');
const billingSvc = require('./billingService');
const customerSvc = require('./customerService');
const mikrotikSvc = require('./mikrotikService');
const axios = require('axios');
const crypto = require('crypto');
const { getSetting } = require('../config/settingsManager');
const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

function getDigiflazzCreds() {
  const username = String(getSetting('digiflazz_username', '') || '').trim();
  const apiKey = String(getSetting('digiflazz_api_key', '') || '').trim();
  if (!username || !apiKey) {
    throw new Error('Digiflazz belum dikonfigurasi. Isi digiflazz_username & digiflazz_api_key di settings.json');
  }
  return { username, apiKey };
}

function digiflazzSign(refId = '') {
  const { username, apiKey } = getDigiflazzCreds();
  return crypto.createHash('md5').update(username + apiKey + String(refId || '')).digest('hex');
}

async function digiflazzCheckBalance() {
  const { username, apiKey } = getDigiflazzCreds();
  const sign = crypto.createHash('md5').update(username + apiKey + 'depo').digest('hex');
  const response = await digiflazzApi.post('/cek-saldo', {
    cmd: 'deposit',
    username,
    sign
  });
  const data = response?.data?.data || {};
  const deposit = Number(data?.deposit || 0);
  if (!Number.isFinite(deposit)) throw new Error('Gagal parsing saldo Digiflazz');
  return { deposit };
}

async function digiflazzGetProductBySku(sku) {
  const { username } = getDigiflazzCreds();
  const safeSku = String(sku || '').trim();
  if (!safeSku) throw new Error('SKU tidak valid');

  const sign = digiflazzSign('pricelist');
  const response = await digiflazzApi.post('/price-list', {
    cmd: 'prepaid',
    username,
    sign,
    code: safeSku
  });

  const data = response?.data?.data;
  if (!Array.isArray(data)) {
    const msg = response?.data?.data?.message || response?.data?.message || 'Gagal mengambil price list';
    throw new Error(String(msg));
  }

  const prod = data.find(p => String(p?.buyer_sku_code || '').trim() === safeSku) || data[0];
  if (!prod) throw new Error('SKU tidak ditemukan di Digiflazz');
  return prod;
}

function normalizeDigiflazzStatus(vendorStatus) {
  const s = String(vendorStatus || '').toLowerCase();
  if (s === 'sukses' || s === 'success') return 'success';
  if (s === 'gagal' || s === 'failed') return 'failed';
  if (s === 'pending' || s === 'process' || s === 'processing') return 'pending';
  return 'pending';
}

async function digiflazzCreateTransaction({ sku, target, refId }) {
  const { username } = getDigiflazzCreds();
  const sign = digiflazzSign(refId);

  try {
    const response = await digiflazzApi.post('/transaction', {
      username,
      buyer_sku_code: String(sku || '').trim(),
      customer_no: String(target || '').trim(),
      ref_id: String(refId || '').trim(),
      sign
    });

    const data = response?.data?.data || {};
    const rc = String(data?.rc || '').trim();
    if (rc && !['00', '03'].includes(rc)) {
      const msg = data?.message || `Error Vendor (RC: ${rc})`;
      throw new Error(String(msg));
    }

    return data;
  } catch (error) {
    const isTimeout = error?.code === 'ECONNABORTED' || String(error?.message || '').toLowerCase().includes('timeout');
    if (isTimeout) {
      return {
        status: 'Pending',
        rc: '03',
        message: 'Request timeout, cek status transaksi nanti.',
        trx_id: '',
        sn: '',
        price: 0
      };
    }

    const msg = error?.response?.data?.data?.message || error?.message || String(error);
    throw new Error(String(msg));
  }
}

function getDigiflazzProductLocalBySku(sku) {
  const safeSku = String(sku || '').trim();
  if (!safeSku) return null;
  return db.prepare('SELECT * FROM digiflazz_products WHERE sku = ? AND status = 1').get(safeSku);
}

function listDigiflazzProducts({ q = '', category = '', brand = '', include_inactive = false, limit = 200 } = {}) {
  const safeQ = String(q || '').trim();
  const safeCat = String(category || '').trim();
  const safeBrand = String(brand || '').trim();

  const where = [];
  const params = [];
  if (!include_inactive) where.push('status = 1');
  if (safeQ) {
    where.push('(sku LIKE ? OR product_name LIKE ? OR brand LIKE ? OR category LIKE ?)');
    const like = `%${safeQ}%`;
    params.push(like, like, like, like);
  }
  if (safeCat) {
    where.push('category = ?');
    params.push(safeCat);
  }
  if (safeBrand) {
    where.push('brand = ?');
    params.push(safeBrand);
  }

  const lim = Math.max(20, Math.min(3000, Number(limit) || 200));
  const sql = `
    SELECT sku, product_name, category, brand, price_modal, price_sell, status, updated_at
    FROM digiflazz_products
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY category, brand, price_sell
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, lim);
}

function listDigiflazzCategories() {
  return db
    .prepare("SELECT category FROM digiflazz_products WHERE status = 1 AND category IS NOT NULL AND TRIM(category)<>'' GROUP BY category ORDER BY category")
    .all()
    .map(r => r.category);
}

function listDigiflazzBrands(category = '') {
  const safeCat = String(category || '').trim();
  if (safeCat) {
    return db
      .prepare("SELECT brand FROM digiflazz_products WHERE status = 1 AND category = ? AND brand IS NOT NULL AND TRIM(brand)<>'' GROUP BY brand ORDER BY brand")
      .all(safeCat)
      .map(r => r.brand);
  }
  return db
    .prepare("SELECT brand FROM digiflazz_products WHERE status = 1 AND brand IS NOT NULL AND TRIM(brand)<>'' GROUP BY brand ORDER BY brand")
    .all()
    .map(r => r.brand);
}

function authenticate(username, password) {
  return db
    .prepare('SELECT * FROM agents WHERE username = ? AND password = ? AND is_active = 1')
    .get(username, password);
}

function getAllAgents() {
  return db.prepare(`
    SELECT a.*, r.name AS router_name
    FROM agents a
    LEFT JOIN routers r ON r.id = a.router_id
    ORDER BY a.created_at DESC
  `).all();
}

function getAgentById(id) {
  return db.prepare(`
    SELECT a.*, r.name AS router_name
    FROM agents a
    LEFT JOIN routers r ON r.id = a.router_id
    WHERE a.id = ?
  `).get(id);
}

function normalizePhoneDigits(v) {
  let digits = String(v || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  return digits;
}

function getAgentByPhone(phone) {
  const input = normalizePhoneDigits(phone);
  if (!input) return null;
  const agents = getAllAgents();
  for (const a of (agents || [])) {
    if (!a || !a.is_active) continue;
    const ap = normalizePhoneDigits(a.phone);
    if (!ap) continue;
    if (ap === input) return a;
    if (ap.endsWith(input) || input.endsWith(ap)) return a;
  }
  return null;
}

function createAgent(data) {
  const routerId = data.router_id !== undefined && data.router_id !== null && String(data.router_id).trim() !== ''
    ? Number(data.router_id)
    : null;
  return db
    .prepare(
      'INSERT INTO agents (username, password, name, phone, balance, billing_fee, is_active, router_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
    )
    .run(
      String(data.username || '').trim(),
      String(data.password || ''),
      String(data.name || '').trim(),
      String(data.phone || '').trim(),
      Math.max(0, Number(data.balance || 0) || 0),
      Math.max(0, Number(data.billing_fee || 0) || 0),
      routerId
    );
}

function updateAgent(id, data) {
  const existing = getAgentById(id);
  if (!existing) throw new Error('Agent tidak ditemukan');

  const routerId = data.router_id !== undefined
    ? (data.router_id !== null && String(data.router_id).trim() !== '' ? Number(data.router_id) : null)
    : existing.router_id;

  const next = {
    username: String(data.username ?? existing.username).trim(),
    password: String(data.password ?? existing.password),
    name: String(data.name ?? existing.name).trim(),
    phone: String(data.phone ?? existing.phone).trim(),
    billing_fee: Math.max(0, Number(data.billing_fee ?? existing.billing_fee) || 0),
    is_active: data.is_active !== undefined ? (String(data.is_active) === '1' ? 1 : 0) : existing.is_active,
    router_id: routerId
  };

  return db
    .prepare(
      'UPDATE agents SET username=?, password=?, name=?, phone=?, billing_fee=?, is_active=?, router_id=? WHERE id=?'
    )
    .run(next.username, next.password, next.name, next.phone, next.billing_fee, next.is_active, next.router_id, id);
}

function deleteAgent(id) {
  return db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function getAgentPrices(agentId, { includeInactive = false } = {}) {
  const agent = getAgentById(agentId);
  const agentFee = Math.max(0, Number(agent?.billing_fee || 0));

  // 1. Ambil paket resmi yang aktif dari voucher_packages (dikelola admin di /admin/vouchers/packages)
  let masterPackages = [];
  try {
    if (agent && agent.router_id) {
      masterPackages = db
        .prepare(
          `
          SELECT vp.*, r.name AS router_name
          FROM voucher_packages vp
          LEFT JOIN routers r ON r.id = vp.router_id
          WHERE vp.is_active = 1 AND (vp.router_id = ? OR vp.router_id IS NULL)
          ORDER BY vp.price ASC, vp.profile_name ASC
        `
        )
        .all(agent.router_id);
    } else {
      masterPackages = db
        .prepare(
          `
          SELECT vp.*, r.name AS router_name
          FROM voucher_packages vp
          LEFT JOIN routers r ON r.id = vp.router_id
          WHERE vp.is_active = 1
          ORDER BY vp.price ASC, vp.profile_name ASC
        `
        )
        .all();
    }
  } catch (_) {}

  // 2. Ambil kustomisasi harga agen (jika ada di agent_hotspot_prices)
  const customPrices = db
    .prepare(
      `
      SELECT p.*, r.name AS router_name
      FROM agent_hotspot_prices p
      LEFT JOIN routers r ON r.id = p.router_id
      WHERE p.agent_id = ?
      ORDER BY p.is_active DESC, r.name ASC, p.profile_name ASC
    `
    )
    .all(agentId);

  const customMap = new Map();
  for (const cp of customPrices) {
    const key = `${cp.router_id ?? 'all'}__${String(cp.profile_name || '').trim().toLowerCase()}`;
    customMap.set(key, cp);
  }

  // 3. Jika ada paket di voucher_packages, sinkronkan sepenuhnya
  if (masterPackages && masterPackages.length > 0) {
    const result = [];
    for (const mp of masterPackages) {
      const key = `${mp.router_id ?? 'all'}__${String(mp.profile_name || '').trim().toLowerCase()}`;
      const custom = customMap.get(key);

      if (custom) {
        if (custom.is_active || includeInactive) {
          result.push({
            id: custom.id,
            package_id: mp.id,
            agent_id: agentId,
            router_id: mp.router_id,
            profile_name: mp.profile_name,
            validity: custom.validity || mp.validity,
            buy_price: Math.max(0, Number(custom.buy_price || 0)),
            sell_price: Math.max(0, Number(custom.sell_price || mp.price)),
            is_active: custom.is_active ? 1 : 0,
            has_custom: true,
            router_name: mp.router_name || custom.router_name || 'Hotspot',
            prefix: mp.prefix || '',
            code_length: mp.code_length || 6,
            charset: mp.charset || 'numbers'
          });
        }
      } else {
        const sellPrice = Math.max(0, Number(mp.price || 0));
        const discount = agentFee > 0 && agentFee < sellPrice ? agentFee : Math.floor(sellPrice * 0.10);
        const buyPrice = Math.max(500, sellPrice - discount);

        result.push({
          id: mp.id,
          package_id: mp.id,
          agent_id: agentId,
          router_id: mp.router_id,
          profile_name: mp.profile_name,
          validity: mp.validity || '24 Jam',
          buy_price: buyPrice,
          sell_price: sellPrice,
          is_active: 1,
          has_custom: false,
          router_name: mp.router_name || 'Hotspot',
          prefix: mp.prefix || '',
          code_length: mp.code_length || 6,
          charset: mp.charset || 'numbers'
        });
      }
    }
    return result;
  }

  // Fallback jika voucher_packages masih kosong: kembalikan customPrices yang aktif
  return (customPrices || []).filter(cp => cp && (includeInactive || cp.is_active)).map(cp => ({ ...cp, has_custom: true }));
}

function resetAgentHotspotPrices(agentId) {
  return db.prepare('DELETE FROM agent_hotspot_prices WHERE agent_id = ?').run(agentId);
}

function upsertAgentHotspotPrice(agentId, data) {
  const routerId = data.router_id !== undefined && data.router_id !== null && String(data.router_id).trim() !== ''
    ? Number(data.router_id)
    : null;
  const profileName = String(data.profile_name || '').trim();
  if (!profileName) throw new Error('Profile hotspot wajib diisi');

  const buyPrice = Math.max(0, Number(data.buy_price || 0) || 0);
  const sellPrice = Math.max(0, Number(data.sell_price || 0) || 0);
  const validity = String(data.validity || '').trim();
  const isActive = data.is_active !== undefined ? (String(data.is_active) === '1' ? 1 : 0) : 1;

  const existing = db
    .prepare(
      'SELECT id FROM agent_hotspot_prices WHERE agent_id = ? AND router_id IS ? AND profile_name = ?'
    )
    .get(agentId, routerId, profileName);

  if (existing) {
    return db
      .prepare(
        'UPDATE agent_hotspot_prices SET validity=?, buy_price=?, sell_price=?, is_active=? WHERE id=?'
      )
      .run(validity, buyPrice, sellPrice, isActive, existing.id);
  }

  return db
    .prepare(
      'INSERT INTO agent_hotspot_prices (agent_id, router_id, profile_name, validity, buy_price, sell_price, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(agentId, routerId, profileName, validity, buyPrice, sellPrice, isActive);
}

function deleteAgentHotspotPrice(agentId, priceId) {
  return db
    .prepare('DELETE FROM agent_hotspot_prices WHERE id = ? AND agent_id = ?')
    .run(priceId, agentId);
}

function listAgentTransactions({ agentId = null, limit = 300 } = {}) {
  const aId = agentId !== null && agentId !== undefined && String(agentId).trim() !== '' ? Number(agentId) : null;
  return db
    .prepare(
      `
      SELECT t.*, a.name AS agent_name, c.name AS customer_name, c.phone AS customer_phone, r.name AS router_name
      FROM agent_transactions t
      JOIN agents a ON a.id = t.agent_id
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN routers r ON r.id = t.router_id
      WHERE (? IS NULL OR t.agent_id = ?)
      ORDER BY t.id DESC
      LIMIT ?
    `
    )
    .all(aId, aId, Math.max(1, Math.min(2000, Number(limit) || 300)));
}

function getAgentTransactionById(agentId, txId) {
  const aId = Number(agentId || 0);
  const tId = Number(txId || 0);
  if (!aId || !tId) return null;
  return db
    .prepare(
      `
      SELECT t.*, a.name AS agent_name, a.username AS agent_username, r.name AS router_name
      FROM agent_transactions t
      JOIN agents a ON a.id = t.agent_id
      LEFT JOIN routers r ON r.id = t.router_id
      WHERE t.id = ? AND t.agent_id = ?
    `
    )
    .get(tId, aId);
}

function topupAgent(agentId, amount, note, actorName = 'Admin') {
  const delta = Math.floor(Number(amount) || 0);
  if (!Number.isFinite(delta) || delta <= 0) throw new Error('Nominal topup tidak valid');

  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agent tidak ditemukan');

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    const after = before + delta;

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
      ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
    `
    ).run(agentId, delta, delta, before, after, `${actorName}: ${note || 'Topup saldo'}`);

    return { before, after };
  });

  return run();
}

async function payInvoiceAsAgent(agentId, invoiceId, note = '') {
  const inv = billingSvc.getInvoiceById(invoiceId);
  if (!inv) throw new Error('Tagihan tidak ditemukan');
  if (inv.status === 'paid') throw new Error('Tagihan sudah lunas');

  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  const fee = Math.max(0, Number(agent.billing_fee || 0) || 0);
  const cost = Math.max(0, Number(inv.amount || 0) - fee);
  const safeNote = String(note || '').trim();

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    if (before < cost) throw new Error('Saldo agent tidak cukup');

    const after = before - cost;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const ins = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, invoice_id, customer_id,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (?, 'invoice_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      agentId,
      inv.id,
      inv.customer_id,
      inv.amount,
      cost,
      inv.amount,
      fee,
      before,
      after,
      safeNote
    );

    const paidByName = `Agent ${agent.name} (@${agent.username})`;
    const notesParts = [
      'Via Agent',
      `Fee: Rp ${fee.toLocaleString('id-ID')}`,
      `Potong saldo: Rp ${cost.toLocaleString('id-ID')}`
    ];
    if (safeNote) notesParts.push(safeNote);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(inv.id, paidByName, notes);

    return { id: Number(ins.lastInsertRowid), before, after, cost, fee };
  });

  const tx = run();

  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (customer && customer.status === 'suspended') {
    const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
    if (freshCustomer && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }
  }

  return { invoice: inv, agent: getAgentById(agentId), tx };
}


function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function sellVoucherAsAgent(agentId, priceId, opts = {}) {
  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  let price = null;
  let pkgMeta = null;

  // 1. Coba cari di agent_hotspot_prices
  price = db
    .prepare(
      `
      SELECT p.*, r.name AS router_name
      FROM agent_hotspot_prices p
      LEFT JOIN routers r ON r.id = p.router_id
      WHERE p.id = ? AND p.agent_id = ? AND p.is_active = 1
    `
    )
    .get(priceId, agentId);

  // 2. Jika tidak ditemukan di custom agent, cari di voucher_packages (/admin/vouchers/packages)
  if (!price) {
    const vp = db
      .prepare(
        `
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        WHERE vp.id = ? AND vp.is_active = 1
      `
      )
      .get(priceId);

    if (vp) {
      pkgMeta = vp;
      const sellPrice = Math.max(0, Number(vp.price || 0));
      const agentFee = Math.max(0, Number(agent.billing_fee || 0));
      const discount = agentFee > 0 && agentFee < sellPrice ? agentFee : Math.floor(sellPrice * 0.10);
      const buyPrice = Math.max(500, sellPrice - discount);

      price = {
        id: vp.id,
        agent_id: agentId,
        router_id: vp.router_id,
        profile_name: vp.profile_name,
        validity: vp.validity,
        buy_price: buyPrice,
        sell_price: sellPrice,
        is_active: 1,
        router_name: vp.router_name || 'Hotspot',
        prefix: vp.prefix || '',
        code_length: vp.code_length || 6,
        charset: vp.charset || 'numbers'
      };
    }
  }

  if (!price) throw new Error('Paket voucher hotspot tidak ditemukan atau belum aktif di pengaturan');

  const buyPrice = Math.max(0, Number(price.buy_price || 0) || 0);
  const sellPrice = Math.max(0, Number(price.sell_price || 0) || 0);
  if (buyPrice <= 0) throw new Error('Harga beli belum valid');

  const routerId = price.router_id ?? agent.router_id ?? null;
  const profileName = String(price.profile_name || '').trim();

  let validity = String(price.validity || '').trim();
  let profileMeta = null;
  try {
    const profiles = await mikrotikSvc.getHotspotUserProfiles(routerId);
    const prof = (profiles || []).find(p => p && p.name === profileName);
    profileMeta = parseMikhmonOnLogin(prof?.onLogin || prof?.['on-login'] || '');
    if (profileMeta?.validity) validity = profileMeta.validity;
  } catch (e) {}

  const prefix = opts.prefix || price.prefix || pkgMeta?.prefix || '';
  const charset = opts.charset || price.charset || pkgMeta?.charset || 'numbers';
  const length = Math.max(4, Math.min(16, Number(opts.code_length || price.code_length || pkgMeta?.code_length) || 6));

  let created = null;
  let attempt = 0;
  while (attempt < 10) {
    attempt++;
    const code = (prefix ? prefix : '') + genCode(length, charset);
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const agentName = String(agent.name || agent.username || 'Agent').trim().replace(/\s+/g, '_');
    const comment = `vc-${agentName}-${dd}.${mm}.${yy}`;
    const password = code; // untuk hotspot voucher, username = password = code
    const userData = { server: 'all', name: code, password, profile: profileName, comment };
    if (validity) userData['limit-uptime'] = validity;

    try {
      await mikrotikSvc.addHotspotUser(userData, routerId);
      created = { code, password, comment };
      break;
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (isDup) continue;
      throw e;
    }
  }
  if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    if (before < buyPrice) throw new Error('Saldo agent tidak cukup');

    const after = before - buyPrice;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const insertTx = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, router_id, profile_name,
        voucher_code, voucher_password,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (?, 'voucher_sale', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `
    );
    const ins = insertTx.run(
      agentId,
      routerId,
      profileName,
      created.code,
      created.password,
      buyPrice,
      sellPrice,
      Math.max(0, sellPrice - buyPrice),
      before,
      after,
      `Voucher hotspot ${profileName} (${price.router_name || 'router'})`
    );

    return { id: Number(ins.lastInsertRowid), before, after };
  });

  const tx = run();

  return {
    agent: getAgentById(agentId),
    price: { ...price, validity },
    voucher: created,
    tx,
    receipt: {
      profile: profileName,
      router: price.router_name || '',
      code: created.code,
      password: created.password,
      validity,
      sell_price: sellPrice
    }
  };
}

function genDigiflazzRefId(agentId) {
  const aId = Number(agentId || 0) || 0;
  return `AG-${aId}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function refundAgentBalance(agentId, amount, note) {
  const delta = Math.floor(Number(amount) || 0);
  if (!Number.isFinite(delta) || delta <= 0) return null;

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    if (!fresh) throw new Error('Agent tidak ditemukan');
    const before = Number(fresh.balance || 0);
    const after = before + delta;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    const ins = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
      ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
    `
    ).run(agentId, delta, delta, before, after, String(note || 'Refund'));
    return { id: Number(ins.lastInsertRowid || 0), before, after };
  });

  return run();
}

async function buyPulsaAsAgent(agentId, sku, target, opts = {}) {
  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  const safeSku = String(sku || '').trim();
  const safeTarget = String(target || '').trim().replace(/\s+/g, '');
  if (!safeSku) throw new Error('SKU wajib diisi');
  if (!safeTarget) throw new Error('Nomor tujuan wajib diisi');

  const local = getDigiflazzProductLocalBySku(safeSku);
  const prod = local
    ? {
        buyer_sku_code: local.sku,
        product_name: local.product_name,
        category: local.category,
        brand: local.brand,
        price: Number(local.price_modal || 0)
      }
    : await digiflazzGetProductBySku(safeSku);

  const buyPrice = Math.max(0, Math.floor(Number(prod?.price ?? prod?.buyer_price ?? 0) || 0));
  if (buyPrice <= 0) throw new Error('Harga produk tidak valid');

  const inputSell = Number(opts.sell_price ?? 0) || 0;
  const sellPrice = inputSell > 0
    ? Math.floor(inputSell)
    : local
      ? Math.max(0, Math.floor(Number(local.price_sell || 0) || 0))
      : (buyPrice + Math.max(0, Math.floor(Number(getSetting('digiflazz_markup', 0) || 0))));
  const fee = Math.max(0, sellPrice - buyPrice);
  const refId = genDigiflazzRefId(agentId);

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    if (before < sellPrice) throw new Error('Saldo agent tidak cukup');

    const after = before - sellPrice;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const insertTx = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, provider,
        digi_sku, digi_target, digi_ref_id, digi_status, digi_message, digi_price, digi_refunded,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (
        ?, 'pulsa', 'digiflazz',
        ?, ?, ?, 'pending', ?, ?, 0,
        0, ?, ?, ?,
        ?, ?, ?
      )
    `
    );

    const ins = insertTx.run(
      agentId,
      safeSku,
      safeTarget,
      refId,
      'Transaksi dibuat, menunggu konfirmasi provider.',
      buyPrice,
      buyPrice,
      sellPrice,
      fee,
      before,
      after,
      `Digiflazz ${safeSku} ke ${safeTarget}`
    );

    return { id: Number(ins.lastInsertRowid || 0), before, after };
  });

  const localTx = run();

  let vendor = null;
  let finalStatus = 'pending';
  let vendorMessage = '';
  try {
    vendor = await digiflazzCreateTransaction({ sku: safeSku, target: safeTarget, refId });
    finalStatus = normalizeDigiflazzStatus(vendor?.status);
    vendorMessage = String(vendor?.message || '').trim();
    const vendorPrice = Math.max(0, Math.floor(Number(vendor?.price || 0) || 0));

    db.prepare(
      `
      UPDATE agent_transactions
      SET digi_trx_id = ?, digi_sn = ?, digi_status = ?, digi_message = ?, digi_price = CASE WHEN ? > 0 THEN ? ELSE digi_price END
      WHERE id = ? AND agent_id = ?
    `
    ).run(
      String(vendor?.trx_id || ''),
      String(vendor?.sn || ''),
      finalStatus,
      vendorMessage,
      vendorPrice,
      vendorPrice,
      localTx.id,
      agentId
    );

    if (finalStatus === 'failed') {
      const refundRun = db.transaction(() => {
        const row = db.prepare('SELECT id, amount_sell, digi_refunded, digi_ref_id FROM agent_transactions WHERE id=? AND agent_id=?')
          .get(localTx.id, agentId);
        if (!row) return;
        if (Number(row.digi_refunded || 0) === 1) return;
        refundAgentBalance(agentId, Number(row.amount_sell || 0), `REFUND Digiflazz gagal (tx#${row.id} ref=${row.digi_ref_id || refId})`);
        db.prepare('UPDATE agent_transactions SET digi_refunded = 1 WHERE id = ? AND agent_id = ?').run(localTx.id, agentId);
      });
      refundRun();
    }
  } catch (e) {
    vendorMessage = String(e?.message || e || '').trim();
    db.prepare(
      `
      UPDATE agent_transactions
      SET digi_status = 'pending', digi_message = ?
      WHERE id = ? AND agent_id = ?
    `
    ).run(
      vendorMessage ? `Provider error: ${vendorMessage}` : 'Provider error',
      localTx.id,
      agentId
    );
  }

  const tx = getAgentTransactionById(agentId, localTx.id);
  return { agent: getAgentById(agentId), tx, product: prod, vendor };
}

async function checkPulsaStatusAsAgent(agentId, txId) {
  const tx = getAgentTransactionById(agentId, txId);
  if (!tx) throw new Error('Transaksi tidak ditemukan');
  if (tx.type !== 'pulsa' || String(tx.provider || '').toLowerCase() !== 'digiflazz') {
    throw new Error('Transaksi ini bukan transaksi Digiflazz');
  }
  const sku = String(tx.digi_sku || '').trim();
  const target = String(tx.digi_target || '').trim();
  const refId = String(tx.digi_ref_id || '').trim();
  if (!sku || !target || !refId) throw new Error('Data transaksi tidak lengkap');

  const vendor = await digiflazzCreateTransaction({ sku, target, refId });
  const nextStatus = normalizeDigiflazzStatus(vendor?.status);
  const nextMsg = String(vendor?.message || '').trim();
  const vendorPrice = Math.max(0, Math.floor(Number(vendor?.price || 0) || 0));

  db.prepare(
    `
    UPDATE agent_transactions
    SET digi_trx_id = ?, digi_sn = ?, digi_status = ?, digi_message = ?, digi_price = CASE WHEN ? > 0 THEN ? ELSE digi_price END
    WHERE id = ? AND agent_id = ?
  `
  ).run(
    String(vendor?.trx_id || ''),
    String(vendor?.sn || ''),
    nextStatus,
    nextMsg,
    vendorPrice,
    vendorPrice,
    tx.id,
    agentId
  );

  if (nextStatus === 'failed') {
    const refundRun = db.transaction(() => {
      const row = db.prepare('SELECT id, amount_sell, digi_refunded, digi_ref_id FROM agent_transactions WHERE id=? AND agent_id=?')
        .get(tx.id, agentId);
      if (!row) return;
      if (Number(row.digi_refunded || 0) === 1) return;
      refundAgentBalance(agentId, Number(row.amount_sell || 0), `REFUND Digiflazz gagal (tx#${row.id} ref=${row.digi_ref_id || refId})`);
      db.prepare('UPDATE agent_transactions SET digi_refunded = 1 WHERE id = ? AND agent_id = ?').run(tx.id, agentId);
    });
    refundRun();
  }

  return { agent: getAgentById(agentId), tx: getAgentTransactionById(agentId, tx.id), vendor };
}

function makeStaffRefId(prefix = 'ADM') {
  const p = String(prefix || 'ADM').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6) || 'ADM';
  return `${p}${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
}

function getDigiflazzStaffTransactionById(id) {
  const txId = Number(id || 0);
  if (!Number.isFinite(txId) || txId <= 0) return null;
  return db.prepare('SELECT * FROM digiflazz_staff_transactions WHERE id = ?').get(txId);
}

async function buyPulsaAsAdmin({ sku, target, actorPhone = '', actorName = '', refId: customRefId = '' } = {}) {
  const safeSku = String(sku || '').trim();
  const safeTarget = String(target || '').trim();
  if (!safeSku) throw new Error('SKU tidak valid');
  if (!safeTarget) throw new Error('Target tidak valid');

  const prod = getDigiflazzProductLocalBySku(safeSku) || await digiflazzGetProductBySku(safeSku);
  const refId = customRefId ? String(customRefId).trim() : makeStaffRefId('ADM');

  let vendor = null;
  let status = 'pending';
  let vendorMessage = '';
  let trxId = '';
  let sn = '';
  let vendorPrice = Math.max(0, Math.floor(Number(prod?.price || prod?.buyer_price || 0) || 0));
  try {
    vendor = await digiflazzCreateTransaction({ sku: safeSku, target: safeTarget, refId });
    status = normalizeDigiflazzStatus(vendor?.status);
    vendorMessage = String(vendor?.message || '').trim();
    trxId = String(vendor?.trx_id || '').trim();
    sn = String(vendor?.sn || '').trim();
    vendorPrice = Math.max(0, Math.floor(Number(vendor?.price || 0) || 0)) || vendorPrice;
  } catch (e) {
    vendorMessage = String(e?.message || e || '').trim();
    status = 'pending';
  }

  const ins = db.prepare(`
    INSERT INTO digiflazz_staff_transactions
    (role, actor_phone, actor_name, sku, target, ref_id, trx_id, sn, status, message, price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'admin',
    String(actorPhone || '').trim(),
    String(actorName || '').trim(),
    safeSku,
    safeTarget,
    refId,
    trxId,
    sn,
    status,
    vendorMessage ? vendorMessage : (status === 'pending' ? 'Pending' : ''),
    vendorPrice
  );

  const tx = getDigiflazzStaffTransactionById(Number(ins.lastInsertRowid || 0));
  return { tx, product: prod, vendor, refId };
}

async function checkPulsaStatusAsAdmin(txId) {
  const tx = getDigiflazzStaffTransactionById(txId);
  if (!tx) throw new Error('Transaksi tidak ditemukan');
  if (String(tx.role || '').toLowerCase() !== 'admin') throw new Error('Transaksi ini bukan transaksi admin');
  const sku = String(tx.sku || '').trim();
  const target = String(tx.target || '').trim();
  const refId = String(tx.ref_id || '').trim();
  if (!sku || !target || !refId) throw new Error('Data transaksi tidak lengkap');

  const vendor = await digiflazzCreateTransaction({ sku, target, refId });
  const nextStatus = normalizeDigiflazzStatus(vendor?.status);
  const nextMsg = String(vendor?.message || '').trim();
  const vendorPrice = Math.max(0, Math.floor(Number(vendor?.price || 0) || 0));

  db.prepare(`
    UPDATE digiflazz_staff_transactions
    SET trx_id = ?, sn = ?, status = ?, message = ?, price = CASE WHEN ? > 0 THEN ? ELSE price END
    WHERE id = ?
  `).run(
    String(vendor?.trx_id || '').trim(),
    String(vendor?.sn || '').trim(),
    nextStatus,
    nextMsg,
    vendorPrice,
    vendorPrice,
    Number(tx.id)
  );

  return { tx: getDigiflazzStaffTransactionById(tx.id), vendor };
}

module.exports = {
  authenticate,
  getAllAgents,
  getAgentById,
  getAgentByPhone,
  createAgent,
  updateAgent,
  deleteAgent,
  topupAgent,
  getAgentPrices,
  resetAgentHotspotPrices,
  upsertAgentHotspotPrice,
  deleteAgentHotspotPrice,
  listAgentTransactions,
  getAgentTransactionById,
  payInvoiceAsAgent,
  sellVoucherAsAgent,
  buyPulsaAsAgent,
  checkPulsaStatusAsAgent,
  buyPulsaAsAdmin,
  checkPulsaStatusAsAdmin,
  digiflazzCheckBalance,
  listDigiflazzProducts,
  listDigiflazzCategories,
  listDigiflazzBrands
};
