/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');

// ─── CUSTOMERS ───────────────────────────────────────────────
function getAllCustomers(search = '') {
  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.speed_down, p.speed_up,
           r.name as router_name,
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
  `;
  if (search) {
    const s = `%${search}%`;
    return db.prepare(base + ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ? ORDER BY c.name ASC`).all(s, s, s, s);
  }
  return db.prepare(base + ` ORDER BY c.name ASC`).all();
}

function getCustomerById(id) {
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price, r.name as router_name
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    WHERE c.id = ?
  `).get(id);
}

function createCustomer(data) {
  return db.prepare(`
    INSERT INTO customers (name, phone, email, address, package_id, router_id, genieacs_tag, pppoe_username, isolir_profile, status, install_date, notes, auto_isolate, isolate_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, data.phone || '', data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.genieacs_tag || '', data.pppoe_username || '', 
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10
  );
}

function updateCustomer(id, data) {
  return db.prepare(`
    UPDATE customers SET name=?, phone=?, email=?, address=?, package_id=?, router_id=?, genieacs_tag=?, pppoe_username=?, isolir_profile=?, status=?, install_date=?, notes=?, auto_isolate=?, isolate_day=?
    WHERE id=?
  `).run(
    data.name, data.phone || '', data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.genieacs_tag || '', data.pppoe_username || '', 
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    id
  );
}

function deleteCustomer(id) {
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

function getCustomerStats() {
  return {
    total:     db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    active:    db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,
    suspended: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='suspended'").get().c,
    inactive:  db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='inactive'").get().c,
  };
}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages() {
  return db.prepare(`
    SELECT p.*, COUNT(c.id) as customer_count
    FROM packages p LEFT JOIN customers c ON c.package_id = p.id
    GROUP BY p.id ORDER BY p.price ASC
  `).all();
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}

function createPackage(data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  return db.prepare(`
    INSERT INTO packages (name, price, speed_down, speed_up, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.name, parseInt(data.price) || 0, down, up, data.description || '');
}

function updatePackage(id, data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  return db.prepare(`
    UPDATE packages SET name=?, price=?, speed_down=?, speed_up=?, description=?, is_active=? WHERE id=?
  `).run(data.name, parseInt(data.price) || 0, down, up, data.description || '', data.is_active == '1' ? 1 : 0, id);
}

function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function findCustomerByAny(val) {
  if (!val) return null;
  // Try ID first if numeric
  if (/^\d+$/.test(val)) {
    const c = getCustomerById(parseInt(val));
    if (c) return c;
  }
  // Try PPPoE username
  const p = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(val);
  if (p) return getCustomerById(p.id);
  
  // Try Exact Name
  const n = db.prepare('SELECT id FROM customers WHERE name = ?').get(val);
  if (n) return getCustomerById(n.id);
  
  // Try Like Name
  const l = db.prepare('SELECT id FROM customers WHERE name LIKE ?').get(`%${val}%`);
  if (l) return getCustomerById(l.id);
  
  return null;
}

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'suspended' });
  
  if (customer.pppoe_username) {
    const mikrotikSvc = require('./mikrotikService');
    const isolirProfile = customer.isolir_profile || 'isolir';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, customer.router_id);
    await mikrotikSvc.kickPppoeUser(customer.pppoe_username, customer.router_id);
  }
  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'active' });
  
  if (customer.pppoe_username) {
    const mikrotikSvc = require('./mikrotikService');
    const pkg = getPackageById(customer.package_id);
    const targetProfile = pkg ? pkg.name : 'default';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id);
    await mikrotikSvc.kickPppoeUser(customer.pppoe_username, customer.router_id);
  }
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny
};
