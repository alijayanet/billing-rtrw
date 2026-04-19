/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// ─── AUTH ──────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey && providedKey === adminKey) return next();
  return res.status(401).json({ error: 'Unauthorized - Admin/Staff access required' });
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  return res.redirect('/admin/login');
}

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat mengakses halaman ini.' };
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  if (username === getSetting('admin_username', 'admin') && password === getSetting('admin_password', 'admin123')) {
    req.session.isAdmin = true;
    req.session.adminUser = username;
    return res.redirect('/admin');
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    req.session.isCashier = true;
    req.session.cashierId = cashier.id;
    req.session.cashierName = cashier.name;
    return res.redirect('/admin');
  }

  res.render('admin/login', { title: 'Admin Login', company: company(), error: 'Username atau password salah' });
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, restrictToAdmin, (req, res) => {
  const technicians = adminSvc.getAllTechnicians();
  res.render('admin/technicians', { title: 'Manajemen Teknisi', company: company(), activePage: 'technicians', technicians, msg: flashMsg(req) });
});

router.post('/technicians', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createTechnician(req.body);
    req.session._msg = { type: 'success', text: 'Teknisi berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data teknisi diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  req.session._msg = { type: 'success', text: 'Teknisi berhasil dihapus.' };
  res.redirect('/admin/technicians');
});

// --- CASHIER MANAGEMENT ---
router.get('/cashiers', requireAdminSession, restrictToAdmin, (req, res) => {
  const cashiers = adminSvc.getAllCashiers();
  res.render('admin/cashiers', { title: 'Manajemen Kasir', company: company(), activePage: 'cashiers', cashiers, msg: flashMsg(req) });
});

router.post('/cashiers', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCashier(req.body);
    req.session._msg = { type: 'success', text: 'Kasir berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kasir diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  req.session._msg = { type: 'success', text: 'Kasir berhasil dihapus.' };
  res.redirect('/admin/cashiers');
});

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdminSession, async (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing, custStats
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null });
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
router.get('/customers', requireAdminSession, (req, res) => {
  const { search = '', status: filterStatus = '' } = req.query;
  let customers = customerSvc.getAllCustomers(search);
  if (filterStatus) customers = customers.filter(c => c.status === filterStatus);
  res.render('admin/customers', {
    title: 'Pelanggan', company: company(), activePage: 'customers',
    customers, packages: customerSvc.getAllPackages(), stats: customerSvc.getCustomerStats(),
    search, filterStatus, msg: flashMsg(req)
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    customerSvc.createCustomer(req.body);
    
    // Sync to MikroTik if username provided
    if (req.body.pppoe_username) {
      let targetProfile = '';
      if (req.body.status === 'suspended') {
        targetProfile = req.body.isolir_profile || 'isolir';
      } else if (req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile);
        } catch (mErr) {
          console.error('Mikrotik sync error (create):', mErr);
        }
      }
    }

    req.session._msg = { type: 'success', text: `Pelanggan "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    customerSvc.updateCustomer(req.params.id, req.body);
    
    // Sync to MikroTik if username provided
    if (req.body.pppoe_username) {
      let targetProfile = '';
      if (req.body.status === 'suspended') {
        targetProfile = req.body.isolir_profile || 'isolir';
      } else if (req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile);
        } catch (mErr) {
          console.error('Mikrotik sync error (update):', mErr);
        }
      }
    }

    req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, (req, res) => {
  try {
    customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus: ' + e.message };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const data = customers.map(c => ({
      'ID': c.id,
      'Nama': c.name,
      'Telepon': c.phone,
      'Alamat': c.address,
      'Paket': c.package_name || '-',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'Isolir Profile': c.isolir_profile,
      'Status': c.status,
      'Tanggal Pasang': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Tgl Isolir': c.isolate_day,
      'Catatan': c.notes
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('Gagal export data.');
  }
});

router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('File tidak ditemukan');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    console.log(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        console.log(`[Import] Skipping row - Name is empty:`, cleanRow);
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);
      
      const data = {
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        package_id: pkg ? pkg.id : null,
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: cleanRow['PPPoE Username'] || cleanRow['pppoe_username'],
        isolir_profile: cleanRow['Isolir Profile'] || cleanRow['isolir_profile'] || 'isolir',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Tanggal Pasang'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        console.log(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        console.log(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    console.log(`[Import] Finished. Total processed: ${count}`);
    req.session._msg = { type: 'success', text: `Berhasil mengimpor ${count} data pelanggan.` };
  } catch (e) {
    logger.error('Import error:', e);
    req.session._msg = { type: 'error', text: 'Gagal impor: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Pelanggan "${customer.name}" berhasil di-isolir manual.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.activateCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Layanan pelanggan "${customer.name}" berhasil diaktifkan kembali.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
  }
  res.redirect('back');
});

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, (req, res) => {
  res.render('admin/packages', {
    title: 'Paket Internet', company: company(), activePage: 'packages',
    packages: customerSvc.getAllPackages(), msg: flashMsg(req)
  });
});

router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.createPackage(req.body);
    req.session._msg = { type: 'success', text: `Paket "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.updatePackage(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Paket berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    customerSvc.deletePackage(req.params.id);
    req.session._msg = { type: 'success', text: 'Paket berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

// ─── BILLING ───────────────────────────────────────────────────────────────
router.get('/billing', requireAdminSession, (req, res) => {
  const { month: filterMonth, year: filterYear = new Date().getFullYear(), status: filterStatus = 'all', search = '' } = req.query;
  const summary = billingSvc.getInvoiceSummary(filterMonth || new Date().getMonth()+1, filterYear);
  const invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search });
  res.render('admin/billing', {
    title: 'Tagihan', company: company(), activePage: 'billing',
    invoices, summary, filterMonth, filterYear: parseInt(filterYear), filterStatus, search, msg: flashMsg(req)
  });
});

router.get('/billing/:id/print', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    company: settings.company_header || 'ALIJAYA DIGITAL NETWORK',
    settings
  });
});

router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const count = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    req.session._msg = { type: 'success', text: `${count} tagihan baru berhasil digenerate untuk periode ${month}/${year}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate: ' + e.message };
  }
  res.redirect('/admin/billing');
});

router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
  try {
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let customerId = null;
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        customerId = inv.customer_id;
        billingSvc.markAsPaid(id, paid_by_name, notes);
      }
    }

    // Un-isolate logic
    if (customerId) {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === customerId);
      if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
        customerSvc.updateCustomer(customerId, { ...freshCustomer, status: 'active' });
        if (freshCustomer.pppoe_username) {
          const pkg = customerSvc.getPackageById(freshCustomer.package_id);
          await mikrotikService.setPppoeProfile(freshCustomer.pppoe_username, pkg ? pkg.name : 'default');
        }
      }
    }

    req.session._msg = { type: 'success', text: `${ids.length} tagihan berhasil dilunasi.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');

    billingSvc.markAsPaid(req.params.id, req.body.paid_by_name, req.body.notes);
    
    // Check if customer is currently suspended and has no more unpaid invoices
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.status === 'suspended') {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
      if (freshCustomer && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: 'Tagihan berhasil ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
  try {
    billingSvc.markAsUnpaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
  try {
    billingSvc.deleteInvoice(req.params.id);
    req.session._msg = { type: 'success', text: 'Tagihan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

// ─── TICKETS ───────────────────────────────────────────────────────────────
const ticketSvc = require('../services/ticketService');

router.get('/tickets', requireAdminSession, (req, res) => {
  const { status = 'all' } = req.query;
  const tickets = ticketSvc.getAllTickets(status);
  const stats = ticketSvc.getTicketStats();
  res.render('admin/tickets', {
    title: 'Keluhan Pelanggan', company: company(), activePage: 'tickets',
    tickets, stats, filterStatus: status, msg: flashMsg(req)
  });
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { status } = req.body;
    ticketSvc.updateTicketStatus(req.params.id, status);
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/tickets/:id/delete', requireAdminSession, (req, res) => {
  try {
    ticketSvc.deleteTicket(req.params.id);
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus keluhan: ' + e.message };
  }
  res.redirect('back');
});

// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports', requireAdminSession, (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const now = new Date();
  const billing = billingSvc.getDashboardStats();
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const recentPayments = billingSvc.getRecentPayments(10);
  const topUnpaid = billingSvc.getTopUnpaid(5);
  const activeCustomers = customerSvc.getCustomerStats().active;

  res.render('admin/reports', {
    title: 'Laporan Keuangan', company: company(), activePage: 'reports',
    filterYear, monthlyData, chartData: monthlyData, recentPayments, topUnpaid,
    totalRevenue: billing.totalRevenue, thisMonth: billing.thisMonth,
    pendingAmount: billing.pendingAmount, activeCustomers
  });
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', requireAdminSession, (req, res) => {
  res.render('admin/settings', {
    title: 'Pengaturan Sistem', company: company(), activePage: 'settings',
    settings: getSettings(), msg: flashMsg(req)
  });
});

router.post('/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const newSettings = { ...req.body };
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = newSettings.whatsapp_admin_numbers.split(',').map(n => n.trim()).filter(Boolean);
    }
    if (newSettings.server_port) newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port) newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay) newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');

    const success = saveSettings(newSettings);
    if (success) {
      req.session._msg = { type: 'success', text: 'Pengaturan berhasil disimpan!' };
    } else {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/settings');
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;
    const now = Date.now();
    devices.forEach(d => {
      if (d._lastInform && (now - new Date(d._lastInform).getTime()) < 15 * 60 * 1000) online++;
      else offline++;
    });
    res.json({ total, online, offline, warning: 0, lastUpdate: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 100, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    let devices = result.devices.map(d => {
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id);
      return {
        id: d._id, tags: d._tags || [],
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s) || matchingTags.has(t.toLowerCase())) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeIP && d.pppoeIP.toLowerCase().includes(s)) ||
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.pppoeUsername && matchingPppoes.has(d.pppoeUsername.toLowerCase()))
      ); 
    }
    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    const total = devices.length;
    const paginated = devices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devices: paginated, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get devices', detail: e.message });
  }
});

router.get('/api/device/:tag', requireAdmin, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireAdmin, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireAdmin, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

router.post('/api/bulk/ssid', requireAdmin, express.json(), async (req, res) => {
  const { tags, ssid } = req.body;
  if (!Array.isArray(tags) || !ssid) return res.status(400).json({ error: 'Tags and SSID required' });
  const results = [];
  for (const tag of tags) {
    try { results.push({ tag, success: await customerDevice.updateSSID(tag, ssid) }); }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});

router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  const profiles = await mikrotikService.getPppoeProfiles();
  res.json(profiles);
});

router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  const users = await mikrotikService.getPppoeUsers();
  res.json(users);
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, (req, res) => {
  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik', msg: flashMsg(req)
  });
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeSecrets()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeSecret(req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeSecret(req.params.id, req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeSecret(req.params.id); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUsers()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUser(req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUser(req.params.id, req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUser(req.params.id); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeActive()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotActive()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeProfile(req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeProfile(req.params.id, req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeProfile(req.params.id); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUserProfiles()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUserProfile(req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUserProfile(req.params.id, req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUserProfile(req.params.id); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup();
    res.setHeader('Content-disposition', 'attachment; filename=mikrotik_backup_' + new Date().toISOString().slice(0,10) + '.rsc');
    res.setHeader('Content-type', 'text/plain');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
// Global Broadcast Tracker
global.broadcastStatus = {
  active: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null
};

router.get('/whatsapp', requireAdminSession, async (req, res) => {
  res.render('admin/whatsapp', {
    title: 'Status WhatsApp', company: company(), activePage: 'whatsapp', msg: flashMsg(req)
  });
});

router.get('/whatsapp/broadcast', requireAdminSession, (req, res) => {
  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: company(), activePage: 'broadcast', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting
  });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    const delayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 2)) * 1000;

    if (global.broadcastStatus.active) {
      throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
    }

    let customers = [];
    const allCust = customerSvc.getAllCustomers();
    
    if (target === 'all') {
      customers = allCust;
    } else if (target === 'active') {
      customers = allCust.filter(c => c.status === 'active');
    } else if (target === 'suspended') {
      customers = allCust.filter(c => c.status === 'suspended');
    } else if (target === 'unpaid') {
      customers = allCust.filter(c => c.unpaid_count > 0);
    }

    // Ambil pelanggan unik berdasarkan nomor HP
    const uniqueCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      if (c.phone && c.phone.length > 8 && !seenPhones.has(c.phone)) {
        uniqueCustomers.push(c);
        seenPhones.add(c.phone);
      }
    }

    if (uniqueCustomers.length === 0) {
      throw new Error('Tidak ada nomor pelanggan yang valid untuk target tersebut.');
    }

    const { sendWA } = await import('../services/whatsappBot.mjs');
    
    // Initialize Tracker
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date()
    };

    const sendMessageAsync = async () => {
      for (const cust of uniqueCustomers) {
        try {
          await new Promise(r => setTimeout(r, delayMs)); 
          
          // Hitung Tagihan
          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
          const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + inv.amount, 0);
          const rincianBulan = unpaidInvoices.map(inv => `${inv.period_month}/${inv.period_year}`).join(', ');
          
          // Generate Link Login
          const protocol = req.protocol;
          const host = req.get('host');
          const loginLink = `${protocol}://${host}/customer/login`;

          // Format Pesan
          let formattedMsg = message
            .replace(/{{nama}}/gi, cust.name || 'Pelanggan')
            .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
            .replace(/{{rincian}}/gi, rincianBulan || '-')
            .replace(/{{paket}}/gi, cust.package_name || '-')
            .replace(/{{link}}/gi, loginLink);

          await sendWA(cust.phone, formattedMsg);
          global.broadcastStatus.sent++;
        } catch (e) {
          logger.error(`[Broadcast] Gagal kirim ke ${cust.phone}: ${e.message}`);
          global.broadcastStatus.failed++;
        }
      }
      global.broadcastStatus.active = false;
    };
    
    sendMessageAsync(); 

    req.session._msg = { 
      type: 'success', 
      text: `Proses broadcast ke ${targetNumbers.length} nomor telah dimulai.` 
    };

    req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${targetNumbers.length} pelanggan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const { whatsappStatus } = await import('../services/whatsappBot.mjs');
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
    const folderPath = path.resolve(__dirname, '..', authFolder);
    
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);
      
      // Trigger restart bot secara asinkron
      import('../services/whatsappBot.mjs').then(m => m.restartWhatsAppBot()).catch(e => {
        logger.error('Failed to trigger WA restart:', e.message);
      });

      req.session._msg = { text: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang, silakan tunggu QR Code muncul.', type: 'success' };
    } else {
      req.session._msg = { text: 'Folder sesi tidak ditemukan atau sudah dihapus.', type: 'warning' };
    }
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to reset WA session:', e.message);
    req.session._msg = { text: 'Gagal menghapus sesi: ' + e.message + '. (Kemungkinan file sedang digunakan, silakan matikan aplikasi dulu lalu hapus folder ' + getSetting('whatsapp_auth_folder', 'auth_info_baileys') + ' secara manual)', type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

module.exports = router;
