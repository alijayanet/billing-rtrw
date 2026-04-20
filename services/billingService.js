/**
 * Service: Logika Billing & Tagihan
 */
const db = require('../config/database');

function generateMonthlyInvoices(month, year) {
  const customers = db.prepare("SELECT * FROM customers WHERE status='active' AND package_id IS NOT NULL").all();
  const existing  = db.prepare('SELECT customer_id FROM invoices WHERE period_month=? AND period_year=?').all(month, year);
  const existingIds = new Set(existing.map(e => e.customer_id));
  const insert = db.prepare(`INSERT INTO invoices (customer_id, period_month, period_year, amount) VALUES (?, ?, ?, ?)`);
  let created = 0;
  const run = db.transaction(() => {
    for (const c of customers) {
      if (existingIds.has(c.id)) continue;
      const pkg = db.prepare('SELECT price FROM packages WHERE id=?').get(c.package_id);
      if (pkg) { insert.run(c.id, month, year, pkg.price); created++; }
    }
  });
  run();
  return created;
}

function getAllInvoices({ month, year, status, search, limit = 300 } = {}) {
  let q = `
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.genieacs_tag, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (month)  { q += ' AND i.period_month=?'; params.push(parseInt(month)); }
  if (year)   { q += ' AND i.period_year=?';  params.push(parseInt(year)); }
  if (status && status !== 'all') { q += ' AND i.status=?'; params.push(status); }
  if (search) {
    q += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  q += ` ORDER BY i.period_year DESC, i.period_month DESC, c.name ASC LIMIT ${parseInt(limit)}`;
  return db.prepare(q).all(...params);
}

function getInvoiceById(id) {
  return db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address, c.genieacs_tag,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.id = ?
  `).get(id);
}

function markAsPaid(invoiceId, paidByName, notes) {
  return db.prepare(`
    UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, paid_by_name=?, notes=? WHERE id=?
  `).run(paidByName || 'Admin', notes || '', invoiceId);
}

function markAsUnpaid(invoiceId) {
  return db.prepare(`UPDATE invoices SET status='unpaid', paid_at=NULL, paid_by_name='', notes='' WHERE id=?`).run(invoiceId);
}

function deleteInvoice(id) {
  return db.prepare('DELETE FROM invoices WHERE id=?').run(id);
}

function getInvoiceSummary(month, year) {
  const total  = db.prepare('SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=?').get(month, year);
  const paid   = db.prepare("SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=? AND status='paid'").get(month, year);
  const unpaid = db.prepare("SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=? AND status='unpaid'").get(month, year);
  return { total, paid, unpaid };
}

function getMonthlyRevenue(year) {
  return db.prepare(`
    SELECT period_month as month,
           SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) as revenue,
           COUNT(*) as total_invoices,
           SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) as paid_count,
           SUM(CASE WHEN status='unpaid' THEN 1 ELSE 0 END) as unpaid_count
    FROM invoices WHERE period_year=?
    GROUP BY period_month ORDER BY period_month
  `).all(year);
}

function getDashboardStats() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const totalRevenue  = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid'").get();
  const thisMonth     = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND period_month=? AND period_year=?").get(m, y);
  const pendingAmount = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid'").get();
  const unpaidCount   = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='unpaid'").get();
  return {
    totalRevenue:  totalRevenue.t  || 0,
    thisMonth:     thisMonth.t     || 0,
    pendingAmount: pendingAmount.t || 0,
    unpaidCount:   unpaidCount.c   || 0,
  };
}

function getRecentPayments(limit = 8) {
  return db.prepare(`
    SELECT i.*, c.name as customer_name FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    WHERE i.status='paid' ORDER BY i.paid_at DESC LIMIT ?
  `).all(limit);
}

function getTopUnpaid(limit = 5) {
  return db.prepare(`
    SELECT c.name, c.phone, COUNT(*) as unpaid_count, SUM(i.amount) as total_unpaid
    FROM invoices i JOIN customers c ON i.customer_id = c.id
    WHERE i.status='unpaid'
    GROUP BY c.id ORDER BY unpaid_count DESC LIMIT ?
  `).all(limit);
}

function getInvoicesByAny(val) {
  if (!val) return [];
  const cleanVal = val.replace(/\D/g, '');
  
  // Find customer ID first using phone, pppoe, or genieacs_tag
  let customer = null;
  
  if (cleanVal.length >= 8) {
    customer = db.prepare(`SELECT id FROM customers WHERE phone LIKE ?`).get(`%${cleanVal}%`);
  }
  
  if (!customer) {
    customer = db.prepare(`SELECT id FROM customers WHERE pppoe_username = ? OR genieacs_tag = ?`).get(val, val);
  }

  if (!customer) return [];
  
  return db.prepare(`
    SELECT i.*, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.customer_id = ?
    ORDER BY i.period_year DESC, i.period_month DESC
  `).all(customer.id);
}

function getUnpaidInvoicesByCustomerId(customerId) {
  return db.prepare(`
    SELECT i.*, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.customer_id = ? AND i.status = 'unpaid'
    ORDER BY i.period_year ASC, i.period_month ASC
  `).all(customerId);
}

function getTodayRevenue() {
  return db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count 
    FROM invoices 
    WHERE status='paid' AND date(paid_at, 'localtime') = date('now', 'localtime')
  `).get();
}

function updatePaymentInfo(invoiceId, data) {
  const { 
    gateway, order_id, link, reference, payload, expires_at 
  } = data;
  
  return db.prepare(`
    UPDATE invoices SET 
      payment_gateway = ?,
      payment_order_id = ?,
      payment_link = ?,
      payment_reference = ?,
      payment_payload = ?,
      payment_expires_at = ?
    WHERE id = ?
  `).run(gateway, order_id, link, reference, payload ? JSON.stringify(payload) : null, expires_at, invoiceId);
}

module.exports = {
  getInvoicesByAny,
  getUnpaidInvoicesByCustomerId,
  generateMonthlyInvoices, getAllInvoices, getInvoiceById,
  markAsPaid, markAsUnpaid, deleteInvoice,
  getInvoiceSummary, getMonthlyRevenue,
  getDashboardStats, getRecentPayments, getTopUnpaid,
  getTodayRevenue,
  updatePaymentInfo
};
