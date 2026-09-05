/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, saveSettings, getNowLocal, getCurrentDateInTimezone, getCurrentTimeInfo, getNowLocalISO, formatDateLocal, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const pdfSvc = require('../services/pdfInvoiceService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const qrisUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Promo slides upload storage
const promoSlidesStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.resolve(__dirname, '..', 'public', 'uploads', 'promo_slides');
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    // Generate unique filename
    const ext = path.extname(file.originalname);
    const name = 'slide-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext;
    cb(null, name);
  }
});

const promoUpload = multer({
  storage: promoSlidesStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: function(req, file, cb) {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar (JPEG, PNG, GIF, WebP) yang diperbolehkan'), false);
    }
  }
});
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const auditSvc = require('../services/auditTrailService');
const whatsappService = require('../services/whatsappService');
const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');
const diagnosticsSvc = require('../services/diagnosticsService');
const attendanceSvc = require('../services/attendanceService');
const payrollSvc = require('../services/payrollService');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const areaSvc = require('../services/areaService');
const axios = require('axios');
const crypto = require('crypto');
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;
const jsQR = require('jsqr');
const qrisUtil = require('../utils/qrisUtil');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = require('@zxing/library');
const QRCode = require('qrcode');
const acsPortal = require('./acsPortal');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

function digiflazzCreds() {
  const username = String(getSetting('digiflazz_username', '') || '').trim();
  const apiKey = String(getSetting('digiflazz_api_key', '') || '').trim();
  return { username, apiKey };
}

function digiflazzConfigured() {
  const { username, apiKey } = digiflazzCreds();
  return Boolean(username && apiKey);
}

function digiflazzSign(refId) {
  const { username, apiKey } = digiflazzCreds();
  if (!username || !apiKey) throw new Error('Digiflazz belum dikonfigurasi');
  return crypto.createHash('md5').update(username + apiKey + String(refId || '')).digest('hex');
}

async function extractQrTextFromImageBuffer(buffer) {
  const buf = buffer && Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return '';
  return await qrisUtil.decodeQrisPayloadFromBuffer(buf);
}

async function digiflazzCekSaldo() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('depo');
  const response = await digiflazzApi.post('/cek-saldo', { cmd: 'deposit', username, sign });
  const data = response?.data?.data;
  if (data?.rc) throw new Error(String(data?.message || 'Gagal cek saldo Digiflazz'));
  return data;
}

async function digiflazzPriceListAll() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('pricelist');
  const response = await digiflazzApi.post('/price-list', { cmd: 'prepaid', username, sign });
  const data = response?.data?.data;
  if (!Array.isArray(data)) {
    const msg = response?.data?.data?.message || response?.data?.message || 'Gagal mengambil price list Digiflazz';
    throw new Error(String(msg));
  }
  return data;
}

const pppoeTrafficSamples = new Map();
function prunePppoeTrafficSamples(now) {
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || (now - v.t) > 15000) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
    if (obj[String(k).toLowerCase()] !== undefined && obj[String(k).toLowerCase()] !== null && obj[String(k).toLowerCase()] !== '') {
      const n = Number(obj[String(k).toLowerCase()]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k] !== undefined ? obj[k] : obj[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

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

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

function routerContextMiddleware(req, res, next) {
  try {
    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const activeRouters = mikrotikService.getAllRouters() || [];

    if (req.query.router_id !== undefined) {
      if (req.query.router_id === 'all' || req.query.router_id === '0' || req.query.router_id === '') {
        req.session.selected_router_id = null;
      } else {
        const rid = parseInt(req.query.router_id, 10);
        req.session.selected_router_id = isNaN(rid) ? null : rid;
      }
    }

    let selectedRouterId = req.session.selected_router_id ?? null;
    if (selectedRouterId && !activeRouters.some(r => r.id === selectedRouterId)) {
      selectedRouterId = null;
      req.session.selected_router_id = null;
    }

    res.locals.multiRouterMode = multiRouterMode;
    res.locals.allActiveRouters = activeRouters;
    res.locals.selectedRouterId = selectedRouterId;
    req.selectedRouterId = selectedRouterId;
  } catch (e) {
    res.locals.multiRouterMode = false;
    res.locals.allActiveRouters = [];
    res.locals.selectedRouterId = null;
    req.selectedRouterId = null;
  }
  next();
}

router.use(routerContextMiddleware);

router.get('/set-active-router', requireAdminSession, (req, res) => {
  const routerId = req.query.router_id;
  if (routerId === 'all' || routerId === '0' || !routerId) {
    req.session.selected_router_id = null;
  } else {
    const parsed = parseInt(routerId, 10);
    req.session.selected_router_id = isNaN(parsed) ? null : parsed;
  }
  const referer = req.headers.referer || '/admin';
  return res.redirect(referer);
});

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') return false;
    await sendWA(to, String(message || '').trim());
    return true;
  } catch {
    return false;
  }
}

async function sendPaymentSuccessWA(customerPhone, customerName, periodText, amountText, paidBy, extraOpts = {}) {
  try {
    const defaultTemplate = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;
    const template = db.getAppSetting('whatsapp_payment_success_message', defaultTemplate);
    const settings = getSettings();
    const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
    const portalUrl = appUrl ? `${appUrl}/customer` : '';

    let periodMonth = '';
    let periodYear = '';
    if (periodText && String(periodText).includes('/')) {
      const p = String(periodText).split('/');
      periodMonth = p[0];
      periodYear = p[1];
    }

    const formattedMsg = whatsappService.formatPaymentSuccessMessage({
      customerName: customerName || 'Pelanggan',
      invoiceId: extraOpts.invoiceId || '',
      customerUsername: extraOpts.username || extraOpts.customerId || '-',
      packageName: extraOpts.packageName || '-',
      periodMonth: periodMonth || periodText,
      periodYear: periodYear || '',
      amount: String(amountText || '0').replace(/[^\d]/g, ''),
      paymentMethod: paidBy || 'Kasir / Admin',
      paidAt: extraOpts.paidAt || new Date(),
      companyName: company(),
      companyPhone: settings.company_phone || '',
      portalUrl,
      customTemplate: template
    });

    return await trySendWhatsappPayment(customerPhone, formattedMsg);
  } catch (e) {
    return false;
  }
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

function safeAdminPath(rawPath, fallback = '/admin/sidebar-settings') {
  const candidate = String(rawPath || '').trim();
  if (!candidate.startsWith('/admin')) return fallback;
  if (candidate.startsWith('/admin/logout')) return fallback;
  return candidate;
}

function requireSidebarMenuAccess(menuKey) {
  return (req, res, next) => {
    const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
    if (access.allowed) return next();

    if (access.reason === 'hidden') {
      req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
      return res.redirect('/admin');
    }

    if (access.reason === 'locked') {
      req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.FEATURE_CONTACT_PHONE} untuk mendapatkan password.` };
      return res.redirect('/admin/sidebar-settings');
    }

    req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
    return res.redirect('/admin');
  };
}

function popUpdateLog(req) {
  const l = req.session._updateLog;
  delete req.session._updateLog;
  return l || '';
}

function readTextFileSafe(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function runCmd(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message || e) };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDirSync(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function getGitDefaultBranch(repoRoot) {
  let r = runCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (r.ok) {
    const ref = String(r.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  r = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (r.ok) {
    const b = String(r.stdout || '').trim();
    if (b && b !== 'HEAD') return b;
  }
  r = runCmd('git', ['rev-parse', '--verify', 'origin/main'], repoRoot);
  if (r.ok) return 'main';
  r = runCmd('git', ['rev-parse', '--verify', 'origin/master'], repoRoot);
  if (r.ok) return 'master';

  return 'main';
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const info = { localVersion, remoteVersion: '-', branch: '-', needsUpdate: false, error: '' };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    info.error = 'Folder ini belum menjadi git repository.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;

  const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Gagal git fetch: ' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  if (!remote.ok) {
    info.error = `Tidak bisa membaca version.txt dari GitHub (origin/${branch}).`;
    return info;
  }

  const remoteVersion = String(remote.stdout || '').trim() || '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = Boolean(remoteVersion && remoteVersion !== '-' && remoteVersion !== localVersion);
  return info;
}


function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Avoid starting with 0 if it's only numbers
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function createVoucherBatchAsync(batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return;

  const routerId = batch.router_id ?? null;
  const vouchers = db.prepare('SELECT id, code, profile_name FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId);

  const updateVoucher = db.prepare('UPDATE vouchers SET code=?, password=?, comment=?, status=?, created_at=created_at WHERE id=?');
  const markVoucherCreated = db.prepare('UPDATE vouchers SET status=? WHERE id=?');
  const incCreated = db.prepare("UPDATE voucher_batches SET qty_created = qty_created + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const incFailed = db.prepare("UPDATE voucher_batches SET qty_failed = qty_failed + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const setBatchStatus = db.prepare("UPDATE voucher_batches SET status=?, updated_at = (NOW_LOCAL()) WHERE id=?");

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

  const makeUniqueCode = () => {
    const prefix = String(batch.prefix || '').trim();
    const coreLen = Math.max(4, Math.min(16, (Number(batch.code_length) || 6) - prefix.length));
    const userCode = prefix + genCode(coreLen, batch.charset || 'numbers');
    
    let passCode = userCode;
    if (batch.mode === 'member') {
      passCode = genCode(coreLen, batch.charset || 'numbers');
    }
    
    return { userCode, passCode };
  };

  const poolLimit = 8;
  let idx = 0;

  const worker = async () => {
    while (idx < vouchers.length) {
      const current = vouchers[idx++];
      let generated = { userCode: current.code, passCode: current.password || current.code };
      let attempt = 0;
      while (attempt < 10) {
        attempt++;

        if (existsCode.get(routerId, generated.userCode) && generated.userCode !== current.code) {
          generated = makeUniqueCode();
          continue;
        }

        try {
          const comment = `vc-${generated.userCode}-${batch.profile_name}`;
          const userData = {
            server: 'all',
            name: generated.userCode,
            password: generated.passCode,
            profile: batch.profile_name,
            comment
          };
          if (batch.validity) userData['limit-uptime'] = batch.validity;

          await mikrotikService.addHotspotUser(userData, routerId);

          if (generated.userCode !== current.code || generated.passCode !== current.password) {
            updateVoucher.run(generated.userCode, generated.passCode, comment, 'created', current.id);
          } else {
            markVoucherCreated.run('created', current.id);
          }
          incCreated.run(batchId);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exist') || msg.toLowerCase().includes('duplicate');
          if (isDup) {
            generated = makeUniqueCode();
            continue;
          }
          markVoucherCreated.run('failed', current.id);
          incFailed.run(batchId);
          break;
        }
      }
      if (attempt >= 10) {
        markVoucherCreated.run('failed', current.id);
        incFailed.run(batchId);
      }
    }
  };

  setBatchStatus.run('creating', batchId);
  const workers = Array.from({ length: poolLimit }, () => worker());
  await Promise.all(workers);

  const final = db.prepare('SELECT qty_total, qty_created, qty_failed FROM voucher_batches WHERE id=?').get(batchId);
  if (final.qty_created >= final.qty_total && final.qty_failed === 0) setBatchStatus.run('ready', batchId);
  else if (final.qty_created > 0) setBatchStatus.run('partial', batchId);
  else setBatchStatus.run('failed', batchId);
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
  res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
  res.locals.settings = getSettings();
  res.locals.company = company();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  res.locals.getCurrentTimeInfo = getCurrentTimeInfo;
  next();
});

let loginRateLimiter = (req, res, next) => next();
try {
  const rlMod = require('../middleware/rateLimiter');
  if (rlMod && typeof rlMod.loginRateLimiter === 'function') {
    loginRateLimiter = rlMod.loginRateLimiter;
  }
} catch (e) {}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
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
    req.session.cashierUsername = cashier.username;
    return res.redirect('/admin');
  }

  res.render('admin/login', { title: 'Admin Login', company: company(), error: 'Username atau password salah' });
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ─── OLT MANAGEMENT ────────────────────────────────────────────────────────
router.get('/olts', requireAdminSession, async (req, res) => {
  const olts = oltSvc.getAllOlts();
  
  res.render('admin/olts', { 
    title: 'Manajemen OLT', 
    company: company(), 
    activePage: 'olts', 
    olts, 
    msg: flashMsg(req) 
  });
});

router.get('/olts/all/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getAllOltsStats(req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getOltStats(req.params.id, req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/reboot', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await oltSvc.rebootOnu(req.params.id, req.params.index);
    res.json({ success: true, message: 'Perintah reboot berhasil dikirim.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/rename', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) throw new Error('Nama tidak boleh kosong');
    await oltSvc.renameOnu(req.params.id, req.params.index, name);
    res.json({ success: true, message: 'Nama ONU berhasil diubah.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/authorize', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const output = await oltSvc.authorizeOnu(req.params.id, req.body);
    res.json({ success: true, message: 'Otorisasi berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/configure-wan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { method, sn } = req.body;
    let output;
    if (method === 'tr069') {
      output = await oltSvc.configureWanViaAcs(sn, req.body);
    } else {
      output = await oltSvc.configureOnuWan(req.params.id, req.body);
    }
    res.json({ success: true, message: 'Konfigurasi WAN berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.createOlt(req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.updateOlt(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    oltSvc.deleteOlt(req.params.id);
    req.session._msg = { type: 'success', text: 'OLT berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

// ─── ODP & MAP MANAGEMENT ───────────────────────────────────────────────────
router.get('/map', requireAdminSession, requireSidebarMenuAccess('map'), (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();
  
  res.render('admin/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.get('/api/customers/live-sessions', requireAdminSession, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const activeMap = await mikrotikService.getAllActiveSessionsMap(force);
    const sessionsObj = {};
    for (const [uname, session] of activeMap.entries()) {
      sessionsObj[uname] = session;
    }
    return res.json({ ok: true, sessions: sessionsObj });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.status(404).json({ ok: false, error: 'not_found' });

  const routerId = customer.router_id ? Number(customer.router_id) : null;
  const username = String(customer.pppoe_username || '').trim();

  if (!routerId || !username) {
    return res.json({ ok: true, available: false, online: false, username: username || null, rxMbps: 0, txMbps: 0 });
  }

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, available: true, online: false, username, rxMbps: 0, txMbps: 0 });
    }

    const s = sessions[0];
    let iface = strField(s, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(s, ['.id', 'id', 'sessionId', 'session-id']) || `${username}`;
    const bytesIn = numField(s, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(s, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(s, ['uptime']) || null;

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', username).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find(r => String(r.user || r['user'] || '').trim() === username);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;

    const key = `${routerId || 'default'}:${username}`;
    const prev = pppoeTrafficSamples.get(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';

    if (iface) {
      const ifMenu = conn.client.menu('/interface');
      if (ifMenu) {
        try {
          const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
          const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
          const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second', 'rx-bits-per-second']);
          const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second', 'tx-bits-per-second']);
          if (rxBps || txBps) {
            return res.json({
              ok: true,
              available: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              rxMbps: (Number(rxBps) || 0) / 1e6,
              txMbps: (Number(txBps) || 0) / 1e6
            });
          }
        } catch {}
      }
    }

    if (iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    pppoeTrafficSamples.set(key, { t: now, sessionId, rxBytes, txBytes, source });

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const rxMbps = (dIn * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dOut * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      available: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/api/customers/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path } = req.body;
    if (!id) throw new Error('ID pelanggan tidak valid');
    customerSvc.updateCustomerCablePath(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/odps', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.createOdp(req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.updateOdp(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    odpSvc.deleteOdp(req.params.id);
    req.session._msg = { type: 'success', text: 'ODP berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, requireSidebarMenuAccess('technicians'), restrictToAdmin, (req, res) => {
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
router.get('/cashiers', requireAdminSession, requireSidebarMenuAccess('cashiers'), restrictToAdmin, (req, res) => {
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

// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, requireSidebarMenuAccess('collectors'), restrictToAdmin, (req, res) => {
  const collectors = adminSvc.getAllCollectors();
  const masterAreas = areaSvc.getAllAreas();
  res.render('admin/collectors', { title: 'Manajemen Kolektor', company: company(), activePage: 'collectors', collectors, masterAreas, msg: flashMsg(req) });
});

router.post('/collectors', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCollector(req.body);
    req.session._msg = { type: 'success', text: 'Kolektor berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kolektor diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Kolektor berhasil dihapus.' };
  res.redirect('/admin/collectors');
});

// --- AREA MANAGEMENT ---
router.get('/areas', requireAdminSession, requireSidebarMenuAccess('areas'), (req, res) => {
  const areas = areaSvc.getAllAreas();
  res.render('admin/areas', { title: 'Manajemen Area', company: company(), activePage: 'areas', areas, msg: flashMsg(req) });
});

router.post('/areas', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.createArea(req.body);
    req.session._msg = { type: 'success', text: 'Area berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.updateArea(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data area berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/delete', requireAdminSession, (req, res) => {
  try {
    areaSvc.deleteArea(req.params.id);
    req.session._msg = { type: 'success', text: 'Area berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.get('/collector-payments', requireAdminSession, requireSidebarMenuAccess('collector_payments'), (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           col.name as collector_name, col.username as collector_username,
           i.period_month, i.period_year, i.amount as invoice_amount, i.status as invoice_status,
           c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.lat, c.lng
    FROM collector_payment_requests r
    JOIN collectors col ON col.id = r.collector_id
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 500
  `).all(status);

  res.render('admin/collector_payments', {
    title: 'Approval Pembayaran Kolektor',
    company: company(),
    activePage: 'collector_payments',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/collector-payments/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();

    const row = db.prepare(`
      SELECT r.*, col.name as collector_name, col.username as collector_username
      FROM collector_payment_requests r
      JOIN collectors col ON col.id = r.collector_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');

    const inv = billingSvc.getInvoiceById(row.invoice_id);
    if (!inv) throw new Error('Invoice tidak ditemukan');
    if (String(inv.status) === 'paid') {
      db.prepare(`
        UPDATE collector_payment_requests
        SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
        WHERE id=?
      `).run(req.session.isCashier ? 'cashier' : 'admin', resolvePaidByName(req, 'Admin'), 'Invoice sudah lunas', id);
      req.session._msg = { type: 'error', text: 'Invoice sudah lunas, request ditolak.' };
      return res.redirect('back');
    }

    const collectorLabel =
      (`Kolektor ${(String(row.collector_name || '').trim())}` +
        (String(row.collector_username || '').trim() ? ` (@${String(row.collector_username).trim()})` : '')).trim();

    const approver = resolvePaidByName(req, 'Admin');
    const notesParts = [
      'Via Kolektor',
      collectorLabel,
      `Approved oleh ${approver}`,
    ];
    if (row.note) notesParts.push(String(row.note));
    if (decidedNote) notesParts.push(`Approval: ${decidedNote}`);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes);

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.phone) {
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString('id-ID'),
        collectorLabel,
        {
          invoiceId: inv.id,
          username: customer.pppoe_username || customer.id,
          packageName: pkg?.name || customer.package_name || '-',
          paidAt: new Date()
        }
      );
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: 'Request disetujui dan invoice dilunasi.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});

router.post('/collector-payments/:id/reject', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();
    const row = db.prepare(`SELECT * FROM collector_payment_requests WHERE id=?`).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');
    const approver = resolvePaidByName(req, 'Admin');
    db.prepare(`
      UPDATE collector_payment_requests
      SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);
    req.session._msg = { type: 'success', text: 'Request ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});
// ─── CASHIER ATTENDANCE ──────────────────────────────────────────────────────
router.get('/cashiers/attendance', requireAdminSession, requireSidebarMenuAccess('cashier_attendance'), (req, res) => {
  try {
    const cashierId = req.session.cashierId || null;
    const cashierName = req.session.cashierName || req.session.username || 'Kasir';
    
    if (!cashierId) {
      req.session._msg = { type: 'error', text: 'Session kasir tidak valid' };
      return res.redirect('/admin');
    }

    const todayAttendance = attendanceSvc.getTodayAttendance('cashier', cashierId);
    const history = attendanceSvc.getAttendanceHistory('cashier', cashierId, 10);
    
    const now = getCurrentDateInTimezone();
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      'cashier', 
      cashierId, 
      now.getFullYear(), 
      now.getMonth() + 1
    );
    
    res.render('admin/cashier_attendance', {
      title: 'Absensi Saya',
      company: company(),
      activePage: 'cashier_attendance',
      session: req.session,
      cashierName,
      todayAttendance,
      history,
      summary,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat absensi: ' + e.message };
    res.redirect('/admin');
  }
});

router.post('/cashiers/attendance/checkin', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    const cashierName = req.session.cashierName || req.session.username;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-in wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah melakukan check-in hari ini' });
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'cashier',
      employee_id: cashierId,
      employee_name: cashierName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-in berhasil!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-in: ' + e.message });
  }
});

router.post('/cashiers/attendance/checkout', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-out wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda belum check-in hari ini' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah check-out hari ini' });
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-out berhasil!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-out: ' + e.message });
  }
});


router.get('/cashiers/reports', requireAdminSession, requireSidebarMenuAccess('cashiers_reports'), (req, res) => {
  const allCashiers = adminSvc.getAllCashiers();
  const isAdmin = Boolean(req.session?.isAdmin);
  const isCashier = Boolean(req.session?.isCashier);

  const requested = req.query.cashierId != null && String(req.query.cashierId).trim() !== ''
    ? Number(req.query.cashierId)
    : null;

  const cashierId =
    isCashier && !isAdmin
      ? Number(req.session.cashierId || 0) || null
      : requested;

  const selectedCashier = cashierId
    ? (allCashiers || []).find(c => Number(c.id) === Number(cashierId)) || null
    : null;

  const paidByExact = selectedCashier
    ? (`Kasir ${(String(selectedCashier.name || '').trim())}` + (String(selectedCashier.username || '').trim() ? ` (@${String(selectedCashier.username).trim()})` : '')).trim()
    : null;

  const invWhere = [];
  const invParams = [];
  invWhere.push(`i.status='paid'`);
  invWhere.push(`i.paid_by_name LIKE 'Kasir %'`);
  if (paidByExact) {
    invWhere.push(`i.paid_by_name = ?`);
    invParams.push(paidByExact);
  }

  const invoiceRows = db.prepare(`
    SELECT i.id as ref_id,
           i.paid_at as at,
           i.paid_by_name as actor_name,
           i.amount as amount,
           i.notes as notes,
           i.period_month,
           i.period_year,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE ${invWhere.join(' AND ')}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 500
  `).all(...invParams).map(r => ({
    kind: 'invoice',
    at: r.at,
    actor_name: r.actor_name,
    amount: Number(r.amount || 0),
    notes: r.notes || '',
    ref_id: r.ref_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || '',
    period_month: r.period_month,
    period_year: r.period_year,
    package_name: r.package_name || ''
  }));

  const topupWhere = [];
  const topupParams = [];
  topupWhere.push(`t.type='topup'`);
  topupWhere.push(`t.note LIKE 'Kasir %:%'`);
  if (paidByExact) {
    topupWhere.push(`t.note LIKE ?`);
    topupParams.push(`${paidByExact}:%`);
  }

  const topupRows = db.prepare(`
    SELECT t.id as ref_id,
           t.created_at as at,
           t.amount_buy as amount,
           t.note as notes,
           a.name as agent_name,
           a.username as agent_username
    FROM agent_transactions t
    JOIN agents a ON t.agent_id = a.id
    WHERE ${topupWhere.join(' AND ')}
    ORDER BY datetime(t.created_at) DESC, t.id DESC
    LIMIT 500
  `).all(...topupParams).map(r => {
    const rawNote = String(r.notes || '');
    const idx = rawNote.indexOf(':');
    const actor = idx > 0 ? rawNote.slice(0, idx).trim() : '';
    const rest = idx > 0 ? rawNote.slice(idx + 1).trim() : rawNote.trim();
    return {
      kind: 'agent_topup',
      at: r.at,
      actor_name: actor || 'Kasir',
      amount: Number(r.amount || 0),
      notes: rest,
      ref_id: r.ref_id,
      agent_name: r.agent_name || '',
      agent_username: r.agent_username || ''
    };
  });

  const rows = [...invoiceRows, ...topupRows].sort((a, b) => {
    const atA = a && a.at ? String(a.at) : '';
    const atB = b && b.at ? String(b.at) : '';
    if (atA !== atB) return atB.localeCompare(atA);
    return Number(b?.ref_id || 0) - Number(a?.ref_id || 0);
  }).slice(0, 800);

  const invSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(i.amount) as total
    FROM invoices i
    WHERE ${invWhere.join(' AND ')}
  `).get(...invParams);

  const topupSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(t.amount_buy) as total
    FROM agent_transactions t
    WHERE ${topupWhere.join(' AND ')}
  `).get(...topupParams);

  const safeCashiers = isAdmin
    ? allCashiers
    : selectedCashier
      ? [selectedCashier]
      : [];

  res.render('admin/cashier_reports', {
    title: 'Laporan Kasir',
    company: company(),
    activePage: 'cashiers_reports',
    cashiers: safeCashiers,
    cashierId: cashierId || '',
    paidByExact: paidByExact || '',
    rows,
    summary: {
      count: Number(invSumRow?.cnt || 0) + Number(topupSumRow?.cnt || 0),
      total: Number(invSumRow?.total || 0) + Number(topupSumRow?.total || 0),
      invoice_count: Number(invSumRow?.cnt || 0),
      invoice_total: Number(invSumRow?.total || 0),
      topup_count: Number(topupSumRow?.cnt || 0),
      topup_total: Number(topupSumRow?.total || 0)
    },
    msg: flashMsg(req)
  });
});

// --- AGENT MANAGEMENT ---
router.get('/agents', requireAdminSession, requireSidebarMenuAccess('agents'), (req, res) => {
  const agents = agentSvc.getAllAgents();
  const routers = mikrotikService.getAllRouters();
  res.render('admin/agents', {
    title: 'Manajemen Agent',
    company: company(),
    activePage: 'agents',
    agents,
    routers,
    msg: flashMsg(req)
  });
});

router.post('/agents', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.createAgent(req.body);
    req.session._msg = { type: 'success', text: 'Agent berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.updateAgent(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data agent diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    agentSvc.deleteAgent(req.params.id);
    req.session._msg = { type: 'success', text: 'Agent berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/topup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || '').trim();
    const actorName = req.session?.isCashier ? resolvePaidByName(req, 'Kasir') : (req.session.adminUser || 'Admin');
    agentSvc.topupAgent(req.params.id, amount, note, actorName);
    req.session._msg = { type: 'success', text: 'Topup saldo berhasil.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal topup: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.get('/agents/reports', requireAdminSession, requireSidebarMenuAccess('agents_reports'), restrictToAdmin, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const agentId = req.query.agentId ? Number(req.query.agentId) : null;
  const txs = agentSvc.listAgentTransactions({ agentId, limit: 500 });
  res.render('admin/agent_reports', {
    title: 'Laporan Agent',
    company: company(),
    activePage: 'agents_reports',
    agents,
    agentId,
    txs,
    msg: flashMsg(req)
  });
});

router.get('/api/agents/:id/prices', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const rows = agentSvc.getAgentPrices(Number(req.params.id));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices', requireAdmin, restrictToAdmin, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const result = agentSvc.upsertAgentHotspotPrice(agentId, req.body);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices/:priceId/delete', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const priceId = Number(req.params.priceId);
    const result = agentSvc.deleteAgentHotspotPrice(agentId, priceId);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdminSession, requireSidebarMenuAccess('dashboard'), async (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    const settings = getSettings(); // Get current settings
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing, custStats, settings
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null, settings });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null, settings });
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
router.get('/customers', requireAdminSession, requireSidebarMenuAccess('customers'), async (req, res) => {
  const { search = '', status: filterStatus = '', area: filterArea = '' } = req.query;
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const customers = customerSvc.getAllCustomers(search, selectedRouterId, filterStatus, filterArea);
  const stats = customerSvc.getCustomerStats();
  const packages = customerSvc.getAllPackages(selectedRouterId);
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const odps = odpSvc.getAllOdps();
  const collectors = adminSvc.getAllCollectors();
  const areas = customerSvc.getAllCustomerAreas();
  const masterAreas = areaSvc.getAllAreas();

  let activeSessionsMap = new Map();
  try {
    activeSessionsMap = await mikrotikService.getAllActiveSessionsMap();
  } catch (e) {
    logger.warn('[Customers] Failed to fetch active sessions map:', e.message);
  }

  res.render('admin/customers', {
    title: 'Data Pelanggan', company: company(), activePage: 'customers',
    customers, stats, packages, routers, olts, odps, collectors, areas, masterAreas, activeSessionsMap, search, filterStatus, filterArea, selectedRouterId, msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      req.body.pppoe_username = username;
      req.body.pppoe_password = password;
      req.body.pppoe_remote_address = remoteAddress;
      
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi PPPoE (fungsi isolir & profile management membutuhkan router)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      // Only validate against MikroTik if password is not provided (meaning it's from MikroTik list)
      if (!password) {
        let conn = null;
        try {
          conn = await mikrotikService.getConnection(effectiveRouterId);
          const results = await conn.client.menu('/ppp/secret')
            .where('service', 'pppoe')
            .where('name', username)
            .get();
          if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
        } finally {
          if (conn && conn.api) conn.api.close();
        }
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('Static IP tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Static IP (untuk management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? LIMIT 1').get(effectiveRouterId, staticIp);
      if (existing) throw new Error(`Static IP sudah dipakai pelanggan lain: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Hotspot (untuk user management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU dibuat ke MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    customerSvc.createCustomer(req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU create/update secret ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap ke MikroTik
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    //          Hanya CREATE (jika belum ada) atau UPDATE PROFILE (jika sudah ada)
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      // If manual input (password provided), create PPPoE secret in MikroTik
      if (password) {
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            await mikrotikService.createPppoeSecret({
              username: req.body.pppoe_username,
              password: password,
              profile: targetProfile,
              remoteAddress: remoteAddress,
              routerId: req.body.router_id
            });
            logger.info(`[Add Customer] Created PPPoE secret "${req.body.pppoe_username}" in MikroTik (RADIUS ${radiusEnabled ? 'ON' : 'OFF'})`);
          } catch (mErr) {
            logger.error('Mikrotik create PPPoE secret error:', mErr);
          }
        }
      } else {
        // If from MikroTik list (no password input), just update profile
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        if (targetProfile) {
          try {
            await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
            logger.info(`[Add Customer] Updated PPPoE profile for "${req.body.pppoe_username}" to "${targetProfile}"`);
          } catch (mErr) {
            logger.error('Mikrotik sync error (create):', mErr);
          }
        }
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
      try {
        await mikrotikService.upsertHotspotUser({
          username: String(req.body.hotspot_username || '').trim(),
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        console.error('Mikrotik sync error (create hotspot):', mErr);
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
    const customerId = Number(req.params.id);
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi PPPoE (fungsi isolir & profile management membutuhkan router)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(effectiveRouterId);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('Static IP tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Static IP (untuk management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? AND id != ? LIMIT 1').get(effectiveRouterId, staticIp, customerId);
      if (existing) throw new Error(`Static IP sudah dipakai pelanggan lain: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Hotspot (untuk user management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU ada di MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    // Get old customer data to detect username changes
    const oldCustomer = customerSvc.getCustomerById(customerId);
    
    customerSvc.updateCustomer(req.params.id, req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK SAAT EDIT - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU sync ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap sync ke MikroTik  
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    //
    // Proses:
    // 1. Cek apakah secret sudah ada di MikroTik
    // 2. Jika sudah ada: UPDATE PROFILE saja (TIDAK HAPUS!)
    // 3. Jika belum ada: CREATE secret baru (jika ada password)
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      try {
        const newUsername = String(req.body.pppoe_username || '').trim();
        const newPassword = String(req.body.pppoe_password || '').trim();
        const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
        
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            // Cek apakah secret sudah ada di MikroTik
            const secrets = await mikrotikService.getPppoeSecrets(req.body.router_id);
            const existingSecret = secrets.find(s => String(s.name || '').trim() === newUsername);
            
            if (existingSecret) {
              // Secret sudah ada, hanya update profile
              await mikrotikService.setPppoeProfile(newUsername, targetProfile, req.body.router_id);
              logger.info(`[Edit Customer] Updated PPPoE profile for "${newUsername}" to "${targetProfile}"`);
            } else if (newPassword) {
              // Secret belum ada DAN ada password, create secret baru ke MikroTik
              await mikrotikService.createPppoeSecret({
                username: newUsername,
                password: newPassword,
                profile: targetProfile,
                remoteAddress: remoteAddress,
                routerId: req.body.router_id
              });
              logger.info(`[Edit Customer] Created NEW PPPoE secret for "${newUsername}" in MikroTik`);
            } else {
              logger.warn(`[Edit Customer] Cannot create PPPoE secret for "${newUsername}" - password not provided`);
            }
          } catch (mErr) {
            logger.error('Mikrotik sync error (update PPPoE):', mErr.message);
          }
        }
      } catch (syncErr) {
        logger.warn(`[Update] MikroTik API sync skipped/failed for customer ${customerId}: ${syncErr.message}`);
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      try {
        const oldUsername = oldCustomer ? String(oldCustomer.hotspot_username || '').trim() : '';
        const newUsername = String(req.body.hotspot_username || '').trim();
        const oldRouterIdForOldUser = oldCustomer ? oldCustomer.router_id : null;
        const oldEffectiveRouterId = oldCustomer ? customerSvc.getEffectiveRouterId(oldRouterIdForOldUser) : null;
        
        // If username changed, handle old one first
        if (oldUsername && oldUsername !== newUsername && oldEffectiveRouterId) {
          try {
            logger.info(`[Update] Hotspot username changed: "${oldUsername}" → "${newUsername}" for customer ${customerId}`);
            const oldUser = await mikrotikService.getHotspotUserByName(oldUsername, oldEffectiveRouterId);
            if (oldUser && (oldUser.id || oldUser['.id'])) {
              const userId = oldUser['.id'] || oldUser.id;
              await mikrotikService.deleteHotspotUser(userId, oldEffectiveRouterId);
              logger.info(`[Update] Deleted old Hotspot user: ${oldUsername} from router ${oldEffectiveRouterId}`);
            }
          } catch (err) {
            logger.warn(`[Update] Failed to delete old Hotspot user ${oldUsername}: ${err.message}`);
          }
        }
        
        // Now handle new username
        const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
        await mikrotikService.upsertHotspotUser({
          username: newUsername,
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        logger.warn(`[Update] Mikrotik sync error (update hotspot): ${mErr.message}`);
      }
    }

    req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/disconnect', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const pppoeUser = String(customer.pppoe_username || '').trim();
    const hotspotUser = String(customer.hotspot_username || '').trim();
    const username = pppoeUser || hotspotUser || String(customer.name || '').trim();

    let kicked = false;
    if (pppoeUser) {
      kicked = await mikrotikService.kickPppoeUser(pppoeUser, customer.router_id);
    } else if (hotspotUser) {
      kicked = await mikrotikService.kickHotspotUser(hotspotUser, customer.router_id);
    } else if (username) {
      kicked = await mikrotikService.kickPppoeUser(username, customer.router_id) || await mikrotikService.kickHotspotUser(username, customer.router_id);
    }

    if (kicked) {
      req.session._msg = { type: 'success', text: `Sesi koneksi aktif untuk "${customer.name}" berhasil diputus dari MikroTik.` };
    } else {
      req.session._msg = { type: 'error', text: `Sesi aktif untuk "${customer.name}" tidak ditemukan di MikroTik atau gagal diputus.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memutus koneksi: ' + (e.message || String(e)) };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const data = customers.map(c => ({
      'ID': c.id,
      'NIK': c.nik || '',
      'Nama': c.name,
      'Telepon': c.phone,
      'Email': c.email || '',
      'Alamat': c.address,
      'Area': c.area || '',
      'Paket': c.package_name || '-',
      'Router': c.router_name || '-',
      'Tipe Koneksi': c.connection_type || 'pppoe',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'Hotspot Username': c.hotspot_username || '',
      'Static IP': c.static_ip || '',
      'Isolir Profile': c.isolir_profile,
      'Status': c.status,
      'Tanggal Pasang': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Tgl Isolir': c.isolate_day,
      'ODP': c.odp_name || '-',
      'Latitude': c.lat || '',
      'Longitude': c.lng || '',
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
    logger.info(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    const odps = odpSvc.getAllOdps();
    const routers = mikrotikService.getAllRouters();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        logger.debug('[Import] Skipping row - Name is empty.');
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);

      const odpName = cleanRow['ODP'] || cleanRow['odp'] || cleanRow['ODP Name'];
      const odp = odps.find(o => o.name === odpName);
      
      // ✅ Handle Router field
      const routerName = cleanRow['Router'] || cleanRow['router'] || cleanRow['Router Name'];
      const router = routers.find(r => r.name === routerName);
      
      // ✅ NEW: Handle Connection Type
      const connType = String(cleanRow['Tipe Koneksi'] || cleanRow['connection_type'] || cleanRow['Connection Type'] || 'pppoe').trim().toLowerCase() || 'pppoe';
      
      const data = {
        nik: cleanRow['NIK'] || cleanRow['nik'] || cleanRow['No KTP'] || cleanRow['No. KTP'] || '',
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        email: cleanRow['Email'] || cleanRow['email'] || cleanRow['email_address'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        area: cleanRow['Area'] || cleanRow['area'] || cleanRow['Wilayah'] || '',
        package_id: pkg ? pkg.id : null,
        router_id: router ? router.id : null,
        odp_id: odp ? odp.id : null,
        lat: cleanRow['Latitude'] || cleanRow['latitude'] || cleanRow['Lat'] || '',
        lng: cleanRow['Longitude'] || cleanRow['longitude'] || cleanRow['Lng'] || '',
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: connType === 'pppoe' ? (cleanRow['PPPoE Username'] || cleanRow['pppoe_username'] || '') : '',
        hotspot_username: connType === 'hotspot' ? (cleanRow['Hotspot Username'] || cleanRow['hotspot_username'] || '') : '',
        static_ip: connType === 'static' ? (cleanRow['Static IP'] || cleanRow['static_ip'] || '') : '',
        connection_type: connType,
        isolir_profile: cleanRow['Isolir Profile'] || cleanRow['isolir_profile'] || 'isolir',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Tanggal Pasang'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        logger.info(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        logger.info(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    logger.info(`[Import] Finished. Total processed: ${count}`);
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

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      req.session._msg = { type: 'success', text: `Tagihan berhasil dibuat untuk "${result.customerName}" periode ${month}/${year}.` };
    } else {
      req.session._msg = { type: 'success', text: `Tagihan sudah ada untuk "${result.customerName}" periode ${month}/${year}.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate tagihan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const r = customerSvc.resetPromoCyclesUsed(req.params.id);
    if (!r.changes) {
      req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
    } else {
      const c = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Counter promo untuk "${c ? c.name : req.params.id}" di-reset (siklus promo dihitung ulang dari awal).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    req.session._msg = {
      type: 'success',
      text: `Tagihan susulan prorata untuk "${out.customerName}" periode ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sebesar Rp ${Number(out.amount).toLocaleString('id-ID')} (${out.billableDays}/${out.daysInMonth} hari).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, months, year, paid_by_name, notes } = req.body;
    const y = parseInt(year);
    const paidBy = resolvePaidByName(req, paid_by_name);
    const customer = customerSvc.getCustomerById(req.params.id);

    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}.` };

      if (customer && customer.phone && done > 0) {
        const monthsText = (sum.paidMonths || []).join(', ');
        const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          `${monthsText} / ${sum.year}`,
          Number(total || 0).toLocaleString('id-ID'),
          paidBy,
          {
            invoiceId: '',
            username: customer.pppoe_username || customer.id,
            packageName: pkg?.name || customer.package_name || '-',
            paidAt: new Date()
          }
        );
      }
    } else {
      const m = parseInt(month);
      const result = billingSvc.payInvoiceForCustomerPeriod(req.params.id, m, y, paidBy, notes);
      if (result.alreadyPaid) {
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" sudah lunas.` };
      } else {
        const verb = result.created ? 'dibuat & dilunasi' : 'dilunasi';
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" berhasil ${verb}.` };

        if (customer && customer.phone) {
          const invs = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
          const inv = (Array.isArray(invs) ? invs : []).find(i => Number(i?.period_month) === Number(m) && Number(i?.period_year) === Number(y)) || null;
          const amount = inv ? Number(inv.amount || 0) : 0;
          const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
          await sendPaymentSuccessWA(
            customer.phone,
            customer.name,
            `${m}/${y}`,
            amount.toLocaleString('id-ID'),
            paidBy,
            {
              invoiceId: inv ? inv.id : '',
              username: customer.pppoe_username || customer.id,
              packageName: pkg?.name || customer.package_name || '-',
              paidAt: new Date()
            }
          );
        }
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar: ' + e.message };
  }
  res.redirect('back');
});

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, requireSidebarMenuAccess('packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = mikrotikService.getAllRouters();
  const packages = customerSvc.getAllPackages(selectedRouterId);
  res.render('admin/packages', {
    title: 'Paket Internet', company: company(), activePage: 'packages',
    packages, routers, selectedRouterId, msg: flashMsg(req)
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

// ─── VOUCHER PACKAGES (ON-DEMAND REAL-TIME CONFIGURATION) ────────────────────
router.get('/vouchers/packages', requireAdminSession, requireSidebarMenuAccess('voucher_packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1').all();
  res.render('admin/vouchers_packages', {
    title: 'Paket Voucher Hotspot', company: company(), activePage: 'voucher_packages',
    routers, selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/api/vouchers/packages', requireAdminSession, (req, res) => {
  try {
    const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
    let rows;
    if (selectedRouterId && selectedRouterId > 0) {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        WHERE vp.router_id = ?
        ORDER BY vp.price ASC
      `).all(selectedRouterId);
    } else {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        ORDER BY vp.price ASC
      `).all();
    }
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages', requireAdminSession, express.json(), (req, res) => {
  try {
    const { router_id, profile_name, price, validity, prefix, code_length, charset, is_active } = req.body;
    
    // VALIDATION: router_id is REQUIRED for voucher packages
    if (!router_id || Number(router_id) <= 0) return res.status(400).json({ ok: false, error: 'Router harus dipilih' });
    
    // Verify router exists
    const router = db.prepare('SELECT id FROM routers WHERE id = ? LIMIT 1').get(Number(router_id));
    if (!router) return res.status(400).json({ ok: false, error: 'Router tidak ditemukan di database' });
    
    if (!profile_name) return res.status(400).json({ ok: false, error: 'Nama profil wajib diisi' });
    if (!price || Number(price) <= 0) return res.status(400).json({ ok: false, error: 'Harga harus lebih besar dari 0' });
    if (!validity) return res.status(400).json({ ok: false, error: 'Durasi/masa aktif wajib diisi' });

    const rId = router_id ? Number(router_id) : null;
    const prc = Math.floor(Number(price));
    const len = Math.max(4, Math.min(16, Number(code_length) || 6));
    const act = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;

    const stmt = db.prepare(`
      INSERT INTO voucher_packages (router_id, profile_name, price, validity, prefix, code_length, charset, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()))
      ON CONFLICT(router_id, profile_name) DO UPDATE SET
        price=excluded.price,
        validity=excluded.validity,
        prefix=excluded.prefix,
        code_length=excluded.code_length,
        charset=excluded.charset,
        is_active=excluded.is_active,
        updated_at=(NOW_LOCAL())
    `);
    
    stmt.run(rId, profile_name, prc, String(validity).trim(), String(prefix || '').trim(), len, charset || 'mixed', act);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    db.prepare('DELETE FROM voucher_packages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── BILLING ───────────────────────────────────────────────────────────────
router.get('/billing', requireAdminSession, requireSidebarMenuAccess('billing'), (req, res) => {
  const timeInfo = getCurrentTimeInfo();
  const { month: filterMonth, year: filterYear = timeInfo.year, status: filterStatus = 'all', search = '' } = req.query;
  const summary = billingSvc.getInvoiceSummary(filterMonth || timeInfo.month, filterYear);
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

router.get('/billing/:id/print-thermal', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  res.render('collector/print_thermal', {
    invoice: inv,
    customer,
    company: settings.company_header || 'ALIJAYA DIGITAL NETWORK',
    settings,
    collectorName: req.session.adminUsername || 'Admin',
    formatDateLocal,
    formatTimeLocal,
    getNowLocal
  });
});

router.get('/billing/:id/pdf', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).send('Invoice tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);
    
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_INV-${String(inv.id).padStart(4, '0')}_${safeName}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error(`[PDF Download] Error: ${err.message}`);
    return res.status(500).send('Gagal generate PDF invoice: ' + err.message);
  }
});

router.post('/billing/:id/send-pdf-wa', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.json({ success: false, message: 'Data pelanggan tidak ditemukan' });
    if (!customer.phone) return res.json({ success: false, message: 'Nomor WhatsApp pelanggan belum terisi' });

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);

    const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
    const periodStr = `${mns[(inv.period_month || 1) - 1]} ${inv.period_year}`;
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_${inv.id}_${safeName}.pdf`;
    const statusText = inv.status === 'paid' ? 'LUNAS' : 'BELUM BAYAR';
    
    const caption = `📄 *INVOICE PEMBAYARAN INTERNET*\n\nYth. *${customer.name}*,\nBerikut kami lampirkan dokumen resmi Invoice Pembayaran Internet untuk periode *${periodStr}*.\n\n💰 *Total Tagihan:* Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}\n📌 *Status:* *${statusText}*\n\nTerima kasih telah menggunakan layanan *${settings.company_header || 'ALIJAYA NET'}*!`;

    const { sendWADocument, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') {
      return res.json({ success: false, message: 'Bot WhatsApp belum terhubung' });
    }

    const sent = await sendWADocument(customer.phone, pdfBuffer, filename, caption);
    if (sent) {
      return res.json({ success: true, message: `Invoice PDF berhasil dikirim ke WhatsApp ${customer.name} (${customer.phone})` });
    } else {
      return res.json({ success: false, message: 'Gagal mengirim dokumen PDF ke WhatsApp' });
    }
  } catch (err) {
    logger.error(`[Send PDF WA] Error: ${err.message}`);
    return res.json({ success: false, message: 'Gagal kirim PDF: ' + err.message });
  }
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

router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const paidBy = resolvePaidByName(req, paid_by_name);
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    const paidByCustomer = new Map();
    const touchedCustomerIds = new Set();
    let processed = 0;
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        processed++;
        const customerId = Number(inv.customer_id || 0);
        if (Number.isFinite(customerId) && customerId > 0) touchedCustomerIds.add(customerId);
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes);
        if (!wasPaid) {
          if (!paidByCustomer.has(customerId)) paidByCustomer.set(customerId, []);
          paidByCustomer.get(customerId).push({
            id: inv.id,
            amount: Number(inv.amount || 0),
            period_month: inv.period_month,
            period_year: inv.period_year
          });
        }
      }
    }

    const customersSnapshot = customerSvc.getAllCustomers();
    for (const customerId of touchedCustomerIds) {
      const freshCustomer = customersSnapshot.find(c => Number(c.id) === Number(customerId));
      if (freshCustomer && freshCustomer.status === 'suspended' && Number(freshCustomer.unpaid_count || 0) === 0) {
        await customerSvc.activateCustomer(customerId);
      }
    }

    for (const [customerId, paidInvoices] of paidByCustomer.entries()) {
      if (!paidInvoices || paidInvoices.length === 0) continue;
      const customer = customerSvc.getCustomerById(customerId);
      if (customer && customer.phone) {
        const total = paidInvoices.reduce((a, b) => a + Number(b.amount || 0), 0);
        const periods = paidInvoices
          .map(x => `${x.period_month}/${x.period_year}`)
          .slice(0, 10)
          .join(', ') + (paidInvoices.length > 10 ? `, +${paidInvoices.length - 10} lainnya` : '');
        const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          periods,
          Number(total || 0).toLocaleString('id-ID'),
          paidBy,
          {
            invoiceId: paidInvoices.map(x => x.id).join(', '),
            username: customer.pppoe_username || customer.id,
            packageName: pkg?.name || customer.package_name || '-',
            paidAt: new Date()
          }
        );
      }
    }

    req.session._msg = { type: 'success', text: `${processed} tagihan berhasil diproses.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { invoice_ids } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let deleted = 0;
    for (const id of clean) {
      try {
        billingSvc.deleteInvoice(id);
        deleted++;
      } catch {}
    }

    req.session._msg = { type: 'success', text: `${deleted} tagihan berhasil dihapus.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus massal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');

    const paidBy = resolvePaidByName(req, req.body.paid_by_name);
    const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
    billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);
    
    // Check if customer is currently suspended and has no more unpaid invoices
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!wasPaid && customer && customer.phone) {
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString('id-ID'),
        paidBy,
        {
          invoiceId: inv.id,
          username: customer.pppoe_username || customer.id,
          packageName: pkg?.name || customer.package_name || '-',
          paidAt: new Date()
        }
      );
    }
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

router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

    const force = String(req.query.force || '') === '1';
    const inv = db.prepare('SELECT id, status, amount, qris_amount_unique FROM invoices WHERE id=?').get(invId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

    if (!force && inv.qris_amount_unique) {
      req.session._msg = { type: 'success', text: 'Kode QRIS sudah ada untuk tagihan ini.' };
      return res.redirect('back');
    }

    const baseAmount = Number(inv.amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

    const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
    const update = db.prepare(`
      UPDATE invoices
      SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL())
      WHERE id=?
    `);

    let chosenCode = 0;
    let chosenAmount = 0;

    for (let i = 0; i < 50; i++) {
      const code = 1 + Math.floor(Math.random() * 999);
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }

    if (!chosenAmount) {
      for (let code = 1; code <= 999; code++) {
        const amount = baseAmount + code;
        if (!exists.get('unpaid', amount, invId)) {
          chosenCode = code;
          chosenAmount = amount;
          break;
        }
      }
    }

    if (!chosenAmount) throw new Error('Gagal membuat nominal unik (slot 1-999 penuh).');

    update.run(chosenCode, chosenAmount, invId);
    req.session._msg = { type: 'success', text: `Kode QRIS dibuat: Rp ${Number(chosenAmount).toLocaleString('id-ID')} (kode ${chosenCode}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Kode QRIS dihapus dari tagihan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const waEnabled = getSetting('whatsapp_enabled', false);
    const billingEnabled = getSetting('whatsapp_billing_to_customer_enabled', true);
    if (!waEnabled) throw new Error('Notifikasi WhatsApp sedang dinonaktifkan di Pengaturan.');
    if (!billingEnabled) throw new Error('Notifikasi tagihan WhatsApp ke pelanggan sedang dinonaktifkan.');

    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

    const { sendWA, sendWAImage, whatsappStatus } = await import('../services/whatsappBot.mjs');
    
    if (whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan cek status WhatsApp di menu Admin.');
    }

    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const totalTagihan = (unpaidInvoices && unpaidInvoices.length > 0)
      ? unpaidInvoices.reduce((sum, i) => sum + (Number(i.amount) || 0), 0)
      : Number(inv.amount || 0);
    const rincianBulan = (unpaidInvoices && unpaidInvoices.length > 0)
      ? unpaidInvoices.map(i => `${i.period_month}/${i.period_year}`).join(', ')
      : `${inv.period_month}/${inv.period_year}`;

    let qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    let qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();
    const qrisPayloadSetting = String(getSetting('qris_static_payload', '') || '');
    const qrisEnabledRaw = getSetting('qris_static_enabled', true);
    const qrisEnabled = !(qrisEnabledRaw === false || qrisEnabledRaw === 'false' || qrisEnabledRaw === 0 || qrisEnabledRaw === '0');
    const hasStaticQris = qrisEnabled && (!!qrisQrUrl || !!String(qrisPayloadSetting || '').trim());

    const baseAmount = totalTagihan > 0 ? totalTagihan : Number(inv.amount || 0);

    if (hasStaticQris && String(inv.status) === 'unpaid' && (!qrisAmountUnique || !qrisCode || (qrisAmountUnique - qrisCode !== baseAmount))) {
      const invId = Number(inv.id);
      if (Number.isFinite(invId) && invId > 0 && Number.isFinite(baseAmount) && baseAmount > 0) {
        const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
        const update = db.prepare(`
          UPDATE invoices
          SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL())
          WHERE id=?
        `);

        let chosenCode = qrisCode > 0 ? qrisCode : 0;
        let chosenAmount = 0;

        if (chosenCode > 0) {
          const pAmt = baseAmount + chosenCode;
          if (!exists.get('unpaid', pAmt, invId)) {
            chosenAmount = pAmt;
          }
        }

        if (!chosenAmount) {
          for (let i = 0; i < 50; i++) {
            const code = 1 + Math.floor(Math.random() * 999);
            const amount = baseAmount + code;
            if (!exists.get('unpaid', amount, invId)) {
              chosenCode = code;
              chosenAmount = amount;
              break;
            }
          }
        }
        if (!chosenAmount) {
          for (let code = 1; code <= 999; code++) {
            const amount = baseAmount + code;
            if (!exists.get('unpaid', amount, invId)) {
              chosenCode = code;
              chosenAmount = amount;
              break;
            }
          }
        }
        if (chosenAmount) {
          update.run(chosenCode, chosenAmount, invId);
          qrisAmountUnique = chosenAmount;
          qrisCode = chosenCode;
        }
      }
    }

    const normalizeQrisPayload = (raw) => {
      let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
      const idx = s.indexOf('000201');
      if (idx > 0) s = s.slice(idx);
      const lastCrc = s.lastIndexOf('6304');
      if (lastCrc >= 0 && s.length >= lastCrc + 8) {
        s = s.slice(0, lastCrc + 8);
      }
      return s;
    };
    const crc16CcittFalse = (input) => {
      const s = String(input || '');
      let crc = 0xffff;
      for (let i = 0; i < s.length; i++) {
        crc ^= (s.charCodeAt(i) & 0xff) << 8;
        for (let b = 0; b < 8; b++) {
          if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
          else crc = (crc << 1) & 0xffff;
        }
      }
      return crc & 0xffff;
    };
    const parseEmvTlvString = (input) => {
      const raw = String(input || '').replace(/[\r\n\t]+/g, '').trim();
      if (!raw) throw new Error('QRIS payload kosong');
      if (raw.length < 8) throw new Error('QRIS payload terlalu pendek');
      const items = [];
      let i = 0;
      while (i < raw.length) {
        if (i + 4 > raw.length) throw new Error('QRIS payload TLV tidak valid');
        const tag = raw.slice(i, i + 2);
        const lenStr = raw.slice(i + 2, i + 4);
        if (!/^\d{2}$/.test(lenStr)) throw new Error('QRIS payload TLV length tidak valid');
        const len = Number(lenStr);
        const start = i + 4;
        const end = start + len;
        if (end > raw.length) throw new Error('QRIS payload TLV length melebihi data');
        const value = raw.slice(start, end);
        items.push({ tag, value });
        i = end;
      }
      return items;
    };
    const buildEmvTlvString = (items) => {
      const list = Array.isArray(items) ? items : [];
      let out = '';
      for (const it of list) {
        const tag = String(it?.tag || '');
        const value = String(it?.value ?? '');
        const len = value.length;
        if (!/^\d{2}$/.test(tag)) throw new Error('Tag TLV tidak valid');
        if (len > 99) throw new Error('TLV length > 99 tidak didukung');
        out += tag + String(len).padStart(2, '0') + value;
      }
      return out;
    };
    const convertStaticQrisToDynamic = (staticPayload, amount) => {
      const amt = Math.max(0, Math.floor(Number(amount || 0) || 0));
      if (!amt) throw new Error('Nominal QRIS dinamis tidak valid');
      const source = parseEmvTlvString(staticPayload)
        .filter(x => x && x.tag)
        .map(x => ({ tag: String(x.tag), value: String(x.value ?? '') }));
      const managed = new Set(['54', '55', '56', '57', '63']);
      const result = [];
      let amountInserted = false;
      for (const el of source) {
        if (managed.has(el.tag)) continue;
        if (el.tag === '01') {
          result.push({ tag: '01', value: '12' });
          continue;
        }
        if (el.tag === '58' && !amountInserted) {
          result.push({ tag: '54', value: String(amt) });
          amountInserted = true;
        }
        result.push(el);
      }
      if (!amountInserted) result.push({ tag: '54', value: String(amt) });
      const body = buildEmvTlvString(result);
      const partial = body + '6304';
      const crc = crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
      return partial + crc;
    };

    let _decodedCache = global.__adminQrisDecodedCache || { file: '', mtimeMs: 0, payload: '' };
    const decodeQrisPayloadFromUploadedQr = async () => {
      const m = String(qrisQrUrl || '').match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (!m || !m[1]) return '';
      const safeName = path.basename(String(m[1]));
      const filePath = path.join(__dirname, '../public/uploads/qris', safeName);
      let st = null;
      try {
        st = await fs.promises.stat(filePath);
      } catch {
        return '';
      }
      if (_decodedCache.file === safeName && _decodedCache.mtimeMs === st.mtimeMs && _decodedCache.payload) {
        return _decodedCache.payload;
      }
      try {
        const buf = await fs.promises.readFile(filePath);
        const img = await Jimp.read(buf);
        const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
        const source = new RGBLuminanceSource(rgba, img.bitmap.width, img.bitmap.height);
        const bitmap = new BinaryBitmap(new HybridBinarizer(source));
        const reader = new MultiFormatReader();
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        reader.setHints(hints);
        const decoded = reader.decode(bitmap);
        const text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
        const payload = normalizeQrisPayload(text);
        if (!payload) return '';
        _decodedCache = { file: safeName, mtimeMs: st.mtimeMs, payload };
        global.__adminQrisDecodedCache = _decodedCache;
        return payload;
      } catch {
        return '';
      }
    };

    const resolveQrisStaticPayload = async () => {
      const fromSetting = normalizeQrisPayload(qrisPayloadSetting);
      if (fromSetting) return fromSetting;
      return await decodeQrisPayloadFromUploadedQr();
    };

    // Generate Link Login
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    let baseUrl = String(getSetting('app_url', '') || `${protocol}://${host}`).replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      baseUrl = parsed.origin;
    } catch {}
    const loginLink = `${baseUrl}/customer/login`;

    const comp = company();
    const defaultAutoBilling = `{Halo|Selamat Pagi|Yth.} Pelanggan {{nama}},\n\n{Ini adalah|Berikut} pengingat {sebelum tanggal jatuh tempo|pembayaran tagihan internet} Anda.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\n{Mohon|Silakan} {segera lakukan|lakukan} pembayaran melalui portal pelanggan: {{link}}\n\n{Terima kasih atas perhatian dan kerja samanya.|Terima kasih.}\nSalam,\nAdmin ${comp}`;
    
    const defaultQris = `{Halo|Selamat Pagi|Yth.} Pelanggan {{nama}},\n\n{Berikut|Ini adalah} rincian tagihan manual + Kode Bayar QRIS Anda:\n\n📦 *Paket:* {{paket}}\n📅 *Periode:* {{periode}}\n💰 *Nominal:* Rp {{qris_nominal}}\n\n{Silakan scan|Mohon scan} QRIS terlampir untuk melakukan pembayaran otomatis:\n{{qris_qr}}\n\nTerima kasih.`;

    const templateQris = db.getAppSetting('whatsapp_billing_qris_message', defaultQris);
    const template = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling);

    const isQrisCase = (qrisAmountUnique > 0 && qrisCode > 0);
    const finalNominal = qrisAmountUnique > 0 ? qrisAmountUnique : totalTagihan;
    const finalNominalStr = Number(finalNominal).toLocaleString('id-ID');

    const qrisJpgLink = `${baseUrl}/customer/qris/static.jpg?amount=${encodeURIComponent(String(finalNominal))}`;
    const qrisJpgCaption = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{periode}}/gi, rincianBulan)
          .replace(/{{rincian}}/gi, rincianBulan)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `QRIS terlampir (gambar).\n🌐 Portal Pelanggan: ${loginLink}`)
      : '';

    const formattedMsg = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{periode}}/gi, rincianBulan)
          .replace(/{{rincian}}/gi, rincianBulan)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `🔗 Link QRIS JPG: ${qrisJpgLink}\n🌐 Portal Pelanggan: ${loginLink}`)
      : template
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{periode}}/gi, rincianBulan)
          .replace(/{{rincian}}/gi, rincianBulan)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{link}}/gi, loginLink);

    let sent = false;
    if (isQrisCase) {
      try {
        const payloadNorm = await resolveQrisStaticPayload();
        if (payloadNorm) {
          const jpg = await qrisUtil.buildDynamicQrisJpgBuffer(payloadNorm, qrisAmountUnique);
          sent = await sendWAImage(customer.phone, jpg, qrisJpgCaption);
        }
      } catch (e) {
        sent = false;
      }
    }
    if (!sent) {
      sent = await sendWA(customer.phone, formattedMsg);
    }
    if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
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

router.get('/tickets', requireAdminSession, requireSidebarMenuAccess('tickets'), (req, res) => {
  const { status = 'all' } = req.query;
  const tickets = ticketSvc.getAllTickets(status);
  const stats = ticketSvc.getTicketStats();
  const customers = customerSvc.getAllCustomers();
  const techSvc = require('../services/techService');
  const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
  
  res.render('admin/tickets', {
    title: 'Keluhan & Tugas Teknisi', company: company(), activePage: 'tickets',
    tickets, stats, customers, technicians, filterStatus: status, msg: flashMsg(req)
  });
});

router.post('/tickets/create', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { customer_id, subject, message, technician_id, status } = req.body;
    if (!subject || !message) {
      req.session._msg = { type: 'error', text: 'Subjek dan Detail Pesan wajib diisi.' };
      return res.redirect('/admin/tickets');
    }

    const custId = customer_id ? parseInt(customer_id, 10) : 0;
    const techId = technician_id ? parseInt(technician_id, 10) : null;
    const ticketStatus = status || (techId ? 'in_progress' : 'open');

    const result = ticketSvc.createTicket(custId, subject, message, {
      technicianId: techId,
      status: ticketStatus
    });

    const ticketId = result.lastInsertRowid;
    req.session._msg = { type: 'success', text: 'Tiket/tugas baru berhasil dibuat!' };

    // --- WHATSAPP NOTIFICATION FOR NEW ADMIN CREATED TICKET ---
    try {
      const settings = getSettings();
      if (settings.whatsapp_enabled) {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const cust = custId ? customerSvc.getCustomerById(custId) : null;
        const techSvc = require('../services/techService');
        const tech = techId ? techSvc.getTechnicianById(techId) : null;

        const custName = cust ? cust.name : 'Tugas Umum / Maintenance Admin';
        const custPhone = cust ? cust.phone : '-';
        const custAddr = cust ? cust.address : '-';

        const waMsg = `📌 *TUGAS TEKNISI BARU DARI ADMIN*\n\n` +
                     `🎫 *ID Tiket:* #${ticketId}\n` +
                     `👤 *Pelanggan/Objek:* ${custName}\n` +
                     `📞 *Kontak:* ${custPhone}\n` +
                     `📍 *Alamat:* ${custAddr}\n` +
                     `📝 *Kendala/Tugas:* ${subject}\n` +
                     `💬 *Detail Pesan:* ${message}\n\n` +
                     `Silakan cek di portal teknisi/admin untuk menindaklanjuti.`;

        // Send to assigned technician or broadcast to all active technicians if not assigned
        if (tech && tech.phone) {
          let digits = String(tech.phone).replace(/\D/g, '');
          if (digits.startsWith('0')) digits = '62' + digits.slice(1);
          await sendWA(digits, waMsg);
        } else if (!techId) {
          const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1 && t.phone);
          for (const t of technicians) {
            let digits = String(t.phone).replace(/\D/g, '');
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            await sendWA(digits, waMsg);
          }
        }
      }
    } catch (waErr) {
      console.error(`[AdminPortal] WA Ticket Create Notification Error: ${waErr.message}`);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat tiket: ' + e.message };
  }
  res.redirect('/admin/tickets');
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status, technician_id } = req.body;
    const ticketId = req.params.id;
    const oldTicket = ticketSvc.getTicketById(ticketId);
    
    const techId = (technician_id && parseInt(technician_id, 10) > 0) ? parseInt(technician_id, 10) : null;
    ticketSvc.updateTicketStatus(ticketId, status, techId);
    req.session._msg = { type: 'success', text: 'Status & penugasan keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION IF TECHNICIAN IS ASSIGNED / CHANGED ---
    if (techId && (!oldTicket || Number(oldTicket.technician_id) !== techId)) {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const techSvc = require('../services/techService');
          const newTech = techSvc.getTechnicianById(techId);
          const updatedTicket = ticketSvc.getTicketById(ticketId);

          if (newTech && newTech.phone && updatedTicket) {
            let digits = String(newTech.phone).replace(/\D/g, '');
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            
            const waMsg = `📌 *PENUGASAN TIKET OLEH ADMIN*\n\n` +
                         `🎫 *ID Tiket:* #${updatedTicket.id}\n` +
                         `👤 *Pelanggan/Objek:* ${updatedTicket.customer_name}\n` +
                         `📞 *Kontak:* ${updatedTicket.customer_phone || '-'}\n` +
                         `📍 *Alamat:* ${updatedTicket.customer_address || '-'}\n` +
                         `📝 *Kendala/Tugas:* ${updatedTicket.subject}\n` +
                         `💬 *Detail Pesan:* ${updatedTicket.message}\n` +
                         `📊 *Status:* ${status}\n\n` +
                         `Silakan cek portal teknisi untuk memproses tugas ini.`;
            await sendWA(digits, waMsg);
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Assign Notification Error: ${waErr.message}`);
      }
    }

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Petugas:* Admin\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await sendWA(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin Numbers
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *LAPORAN TIKET SELESAI (OLEH ADMIN)*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                if (digits.startsWith('0')) digits = '62' + digits.slice(1);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------------------

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
router.get('/reports', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const now = new Date();
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const recentPayments = billingSvc.getRecentPayments(10);
  const topUnpaid = billingSvc.getTopUnpaid(5);
  const activeCustomers = customerSvc.getCustomerStats().active;

  const yStr = String(filterYear);
  const revenueYearAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ?"
  ).get(yStr);
  const revenueYearAll = Number(revenueYearAllRow?.t || 0);

  const revenueYearDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(yStr);
  const revenueYearDirect = Number(revenueYearDirectRow?.t || 0);
  const revenueYearAgent = Math.max(0, revenueYearAll - revenueYearDirect);

  const agentDepositYearRow = db.prepare(
    "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ?"
  ).get(yStr);
  const agentDepositYear = Number(agentDepositYearRow?.t || 0);

  const nowYearStr = String(now.getFullYear());
  const nowMonthStr = String(now.getMonth() + 1).padStart(2, '0');
  const revenueThisMonthAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ?"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthAll = Number(revenueThisMonthAllRow?.t || 0);

  const revenueThisMonthDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthDirect = Number(revenueThisMonthDirectRow?.t || 0);
  const revenueThisMonthAgent = Math.max(0, revenueThisMonthAll - revenueThisMonthDirect);

  const agentDepositMonthRow = db.prepare(
    "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?"
  ).get(nowYearStr, nowMonthStr);
  const agentDepositThisMonth = Number(agentDepositMonthRow?.t || 0);

  const customCashInYearRow = db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ?").get(yStr);
  const customCashInYear = Number(customCashInYearRow?.t || 0);

  const customCashInMonthRow = db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?").get(nowYearStr, nowMonthStr);
  const customCashInMonth = Number(customCashInMonthRow?.t || 0);

  const cashInYear = revenueYearDirect + agentDepositYear + customCashInYear;
  const cashInThisMonth = revenueThisMonthDirect + agentDepositThisMonth + customCashInMonth;
  const pendingAmountRow = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid'").get();
  const pendingAmount = Number(pendingAmountRow?.t || 0);

  const expensesYearRow = db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ?").get(yStr);
  const expensesRegularYear = Number(expensesYearRow?.t || 0);
  const digiflazzCostYear = Number(db.prepare("SELECT SUM(digi_price) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND strftime('%Y', created_at) = ?").get(yStr)?.t || 0);
  const expensesYear = expensesRegularYear + digiflazzCostYear;

  const expensesMonthRow = db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?").get(nowYearStr, nowMonthStr);
  const expensesRegularMonth = Number(expensesMonthRow?.t || 0);
  const digiflazzCostMonth = Number(db.prepare("SELECT SUM(digi_price) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?").get(nowYearStr, nowMonthStr)?.t || 0);
  const expensesMonth = expensesRegularMonth + digiflazzCostMonth;

  const netProfitYear = cashInYear - expensesYear;
  const netProfitMonth = cashInThisMonth - expensesMonth;

  const expensesByCategory = db.prepare("SELECT category, SUM(amount) as total FROM expenses WHERE strftime('%Y', date) = ? GROUP BY category").all(yStr);
  if (digiflazzCostYear > 0) {
    expensesByCategory.push({ category: 'Modal PPOB (Digiflazz)', total: digiflazzCostYear });
  }
  expensesByCategory.sort((a, b) => b.total - a.total);

  res.render('admin/reports', {
    title: 'Laporan Laba / Rugi', company: company(), activePage: 'reports',
    filterYear, monthlyData, chartData: monthlyData, recentPayments, topUnpaid,
    totalRevenue: revenueYearAll,
    thisMonth: revenueThisMonthAll,
    pendingAmount,
    activeCustomers,
    revenueYearAgent,
    revenueThisMonthAgent,
    agentDepositYear,
    agentDepositThisMonth,
    customCashInYear,
    customCashInMonth,
    cashInYear,
    cashInThisMonth,
    expensesYear,
    expensesMonth,
    netProfitYear,
    netProfitMonth,
    expensesByCategory
  });
});

router.get('/reports/print', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const yStr = String(filterYear);
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const settings = getSettingsWithCache();
  const activeCustomers = customerSvc.getCustomerStats().active;

  // Kalkulasi sama seperti laporan utama
  const revenueYearDirect = Number(db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')").get(yStr)?.t || 0);
  const agentDepositYear = Number(db.prepare("SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ?").get(yStr)?.t || 0);
  const customCashInYear = Number(db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ?").get(yStr)?.t || 0);
  const cashInYear = revenueYearDirect + agentDepositYear + customCashInYear;

  const expensesRegularYear = Number(db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ?").get(yStr)?.t || 0);
  const digiflazzCostYear = Number(db.prepare("SELECT SUM(digi_price) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND strftime('%Y', created_at) = ?").get(yStr)?.t || 0);
  const expensesYear = expensesRegularYear + digiflazzCostYear;
  
  const netProfitYear = cashInYear - expensesYear;

  const pendingAmountRow = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid' AND period_year = ?").get(filterYear);
  const pendingAmount = Number(pendingAmountRow?.t || 0);

  const expensesByCategory = db.prepare("SELECT category, SUM(amount) as total FROM expenses WHERE strftime('%Y', date) = ? GROUP BY category").all(yStr);
  if (digiflazzCostYear > 0) {
    expensesByCategory.push({ category: 'Modal PPOB (Digiflazz)', total: digiflazzCostYear });
  }
  expensesByCategory.sort((a, b) => b.total - a.total);

  res.render('admin/reports_print', {
    company: company(),
    settings,
    filterYear,
    cashInYear,
    expensesYear,
    netProfitYear,
    pendingAmount,
    activeCustomers,
    monthlyData,
    expensesByCategory,
    formatDateLocal,
    getNowLocal
  });
});

router.get('/reports/export-csv', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const yStr = String(filterYear);

  // Ambil data detail pengeluaran & pemasukan
  const expenses = db.prepare("SELECT date, category, amount, description FROM expenses WHERE strftime('%Y', date) = ? ORDER BY date ASC").all(yStr);
  const cashIn = db.prepare("SELECT date, category, amount, description FROM cash_in WHERE strftime('%Y', date) = ? ORDER BY date ASC").all(yStr);

  let csvContent = `Laporan Keuangan ${company()} - Tahun ${filterYear}\n\n`;
  
  csvContent += "=== DATA PENGELUARAN ===\nTanggal,Kategori,Nominal,Deskripsi\n";
  expenses.forEach(e => {
    csvContent += `${e.date},"${e.category}",${e.amount},"${(e.description||'').replace(/"/g, '""')}"\n`;
  });

  csvContent += "\n=== DATA KAS MASUK TAMBAHAN ===\nTanggal,Sumber/Kategori,Nominal,Deskripsi\n";
  cashIn.forEach(c => {
    csvContent += `${c.date},"${c.category}",${c.amount},"${(c.description||'').replace(/"/g, '""')}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="Laporan_Keuangan_${filterYear}.csv"`);
  res.send(csvContent);
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/sidebar-settings', requireAdminSession, (req, res) => {
  res.render('admin/sidebar_settings', {
    title: 'Pengaturan Sidebar',
    company: company(),
    activePage: 'sidebar_settings',
    msg: flashMsg(req),
    canManageSidebar: Boolean(req.session?.isAdmin),
    menuConfigs: sidebarMenuSvc.getConfigMenus(),
    featureContactPhone: sidebarMenuSvc.getFeatureContactPhone()
  });
});

router.post('/sidebar-settings', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const featurePassword = String(req.body.feature_password || '').trim();
    if (!sidebarMenuSvc.isFeaturePasswordValid(featurePassword)) {
      throw new Error(`Password aktivasi salah. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password yang benar.`);
    }

    const menuStates = sidebarMenuSvc.sanitizeMenuStates(req.body.menu_state || {});
    const success = sidebarMenuSvc.saveMenuStates(menuStates);
    if (!success) throw new Error('Gagal menyimpan pengaturan sidebar');

    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'UPDATE',
        entity_type: 'sidebar_settings',
        entity_id: 'global',
        actor_type: req.session?.isAdmin ? 'admin' : 'cashier',
        actor_id: String(req.session?.adminUser || req.session?.cashierUsername || ''),
        actor_name: req.session?.adminUser || req.session?.cashierName || 'Admin',
        details: { menuStates, password_verified: true },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }

    req.session._msg = { type: 'success', text: 'Pengaturan sidebar berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan sidebar: ' + e.message };
  }
  res.redirect('/admin/sidebar-settings');
});

router.get('/settings', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Pengaturan Sistem', company: company(), activePage: 'settings',
    settings, msg: flashMsg(req),
    digiflazzWebhookUrl,
    paymentWebhookUrl
  });
});

router.get('/ewallet-logs', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Log Notifikasi E-Wallet (Webhook)', company: company(), activePage: 'ewallet_logs',
    settings, msg: flashMsg(req),
    digiflazzWebhookUrl,
    paymentWebhookUrl,
    viewMode: 'ewallet_logs'
  });
});

router.post('/settings/qris-upload', requireAdminSession, qrisUpload.single('qris_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('File QRIS tidak ditemukan');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Format file tidak didukung. Gunakan PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/uploads/qris');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const name = `qris-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const fullPath = path.join(dir, name);
    fs.writeFileSync(fullPath, f.buffer);

    const url = `/uploads/qris/${name}`;
    let payload = '';
    const payloadFromClient = String(req.body?.qris_payload || '').trim();
    try {
      if (payloadFromClient) {
        payload = payloadFromClient.replace(/[\r\n\t]+/g, '').trim();
      } else {
        payload = await extractQrTextFromImageBuffer(f.buffer);
      }
      if (!payload.startsWith('000201')) payload = '';
    } catch (e) {
      payload = '';
    }

    const ok = saveSettings({ qris_static_qr_url: url, qris_static_enabled: true, ...(payload ? { qris_static_payload: payload } : {}) });
    if (!ok) throw new Error('Gagal menyimpan pengaturan QRIS');

    if (payload) {
      req.session._msg = { type: 'success', text: 'QRIS berhasil di-upload. Payload QRIS berhasil terbaca otomatis.' };
    } else {
      req.session._msg = { type: 'success', text: 'QRIS berhasil di-upload, tetapi payload QRIS tidak terbaca otomatis. Silakan isi QRIS Static Payload (String) secara manual.' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal upload QRIS: ' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.post('/settings/logo-upload', requireAdminSession, qrisUpload.single('logo_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('File logo tidak ditemukan');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Format file tidak didukung. Gunakan PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fullPath = path.join(dir, 'logo.png');
    fs.writeFileSync(fullPath, f.buffer);

    req.session._msg = { type: 'success', text: 'Logo aplikasi berhasil diperbarui!' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal upload logo: ' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.get('/digiflazz', requireAdminSession, requireSidebarMenuAccess('digiflazz'), restrictToAdmin, async (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  let digi = { configured: digiflazzConfigured(), deposit: null, error: null };
  if (digi.configured) {
    try {
      const data = await digiflazzCekSaldo();
      digi.deposit = Number(data?.deposit || 0);
    } catch (e) {
      digi.error = String(e?.message || e || '');
    }
  }

  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push('(sku LIKE ? OR product_name LIKE ? OR brand LIKE ? OR category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status === 'active') where.push('status = 1');
  if (status === 'inactive') where.push('status = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const products = db.prepare(`SELECT * FROM digiflazz_products ${whereSql} ORDER BY category, brand, price_sell LIMIT 300`).all(...params);
  const categories = db.prepare("SELECT category FROM digiflazz_products WHERE category IS NOT NULL AND TRIM(category)<>'' GROUP BY category ORDER BY category").all().map(r => r.category);
  const stats = db.prepare('SELECT COUNT(1) AS total, SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status=0 THEN 1 ELSE 0 END) AS inactive FROM digiflazz_products').get();
  const lastSync = db.prepare('SELECT * FROM digiflazz_sync_logs ORDER BY id DESC LIMIT 1').get();
  const webhookLogs = db.prepare(
    `
    SELECT id, created_at, ref_id, status, signature_ok, matched_agent_tx_id, ip
    FROM digiflazz_webhook_logs
    ORDER BY id DESC
    LIMIT 80
  `
  ).all();

  const recentPulsaTx = db.prepare(
    `
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.type = 'pulsa'
    ORDER BY t.id DESC
    LIMIT 60
  `
  ).all();

  res.render('admin/digiflazz', {
    title: 'Digiflazz',
    company: company(),
    activePage: 'digiflazz',
    msg: flashMsg(req),
    settings,
    digi,
    digiflazzWebhookUrl,
    q,
    category,
    status,
    products,
    categories,
    stats,
    lastSync,
    recentPulsaTx,
    webhookLogs
  });
});

router.post('/digiflazz/check-balance', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const data = await digiflazzCekSaldo();
    const depo = Number(data?.deposit || 0);
    req.session._msg = { type: 'success', text: `Saldo Digiflazz: Rp ${depo.toLocaleString('id-ID')}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek saldo Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/sync-products', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const markup = Math.max(0, Math.floor(Number(getSetting('digiflazz_markup', 0) || 0)));
    const list = await digiflazzPriceListAll();

    const selectOne = db.prepare('SELECT sku, product_name, category, brand, price_modal, price_sell, status FROM digiflazz_products WHERE sku = ?');
    const upsert = db.prepare(
      `
      INSERT INTO digiflazz_products (sku, product_name, category, brand, price_modal, price_sell, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()))
      ON CONFLICT(sku) DO UPDATE SET
        product_name=excluded.product_name,
        category=excluded.category,
        brand=excluded.brand,
        price_modal=excluded.price_modal,
        price_sell=excluded.price_sell,
        status=excluded.status,
        updated_at=(NOW_LOCAL())
    `
    );

    const run = db.transaction(() => {
      const summary = { total: 0, inserted: 0, updated: 0, active: 0, inactive: 0, skippedNoPrice: 0 };
      for (const p of list) {
        summary.total++;
        const sku = String(p?.buyer_sku_code || '').trim();
        if (!sku) continue;

        const priceModal = Number(p?.price ?? p?.buyer_price ?? 0) || 0;
        if (priceModal <= 0) {
          summary.skippedNoPrice++;
          continue;
        }

        const status = p?.buyer_product_status ? 1 : 0;
        if (status === 1) summary.active++;
        else summary.inactive++;

        const existing = selectOne.get(sku);
        const name = String(p?.product_name || sku).trim();
        const cat = String(p?.category || '').trim();
        const brand = String(p?.brand || '').trim();
        const priceSell = Math.floor(priceModal + markup);

        if (!existing) summary.inserted++;
        else {
          const changed =
            String(existing.product_name || '') !== name ||
            String(existing.category || '') !== cat ||
            String(existing.brand || '') !== brand ||
            Number(existing.price_modal || 0) !== Math.floor(priceModal) ||
            Number(existing.price_sell || 0) !== priceSell ||
            Number(existing.status || 0) !== status;
          if (changed) summary.updated++;
        }

        upsert.run(sku, name, cat, brand, Math.floor(priceModal), priceSell, status);
      }

      db.prepare(
        'INSERT INTO digiflazz_sync_logs (total, inserted, updated, active, inactive) VALUES (?, ?, ?, ?, ?)'
      ).run(summary.total, summary.inserted, summary.updated, summary.active, summary.inactive);

      return summary;
    });

    const s = run();
    req.session._msg = { type: 'success', text: `Sync Digiflazz OK | Total: ${s.total} | Baru: ${s.inserted} | Update: ${s.updated} | Aktif: ${s.active} | Nonaktif: ${s.inactive} | SkipNoPrice: ${s.skippedNoPrice}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal sync produk Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/products/update-price', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const priceSell = Math.max(0, Math.floor(Number(req.body.price_sell || 0) || 0));
    if (!sku) throw new Error('SKU wajib');
    const info = db.prepare('UPDATE digiflazz_products SET price_sell=?, updated_at=(NOW_LOCAL()) WHERE sku=?').run(priceSell, sku);
    if (info.changes === 0) throw new Error('SKU tidak ditemukan');
    req.session._msg = { type: 'success', text: `Harga jual diperbarui: ${sku}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update harga: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.get('/update', requireAdminSession, requireSidebarMenuAccess('update'), restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const info = getUpdateInfo(repoRoot);
  res.render('admin/update', {
    title: 'Update Aplikasi',
    company: company(),
    activePage: 'update',
    msg: flashMsg(req),
    info,
    log: popUpdateLog(req)
  });
});

router.post('/update/run', requireAdminSession, restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const log = [];
  const pushCmd = (label, r) => {
    log.push(`$ ${label}`.trim());
    if (r.stdout) log.push(String(r.stdout).trimEnd());
    if (r.stderr) log.push(String(r.stderr).trimEnd());
  };

  const versionPath = path.join(repoRoot, 'version.txt');
  const localBefore = readTextFileSafe(versionPath) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const backupRoot = path.join(os.tmpdir(), `billing-update-backup-${Date.now()}`);
  const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys').trim() || 'auth_info_baileys';
  const preservedEntries = [
    { label: 'settings.json', relativePath: 'settings.json', cleanExclude: 'settings.json' },
    { label: '.env', relativePath: '.env', cleanExclude: '.env' },
    { label: 'database', relativePath: 'database', cleanExclude: 'database' },
    { label: 'public/uploads', relativePath: 'public/uploads', cleanExclude: 'public/uploads' },
    { label: 'public/img', relativePath: 'public/img', cleanExclude: 'public/img' },
    { label: authFolder, relativePath: authFolder, cleanExclude: authFolder.replace(/\\/g, '/') },
    { label: 'data', relativePath: 'data', cleanExclude: 'data' }
  ];
  let repoChanged = false;

  const backupPreservedEntries = () => {
    const backedUp = [];
    for (const entry of preservedEntries) {
      const sourcePath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(sourcePath)) continue;
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        fs.mkdirSync(backupPath, { recursive: true });
        copyDirSync(sourcePath, backupPath);
      } else {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(sourcePath, backupPath);
      }
      backedUp.push(entry.label);
    }
    if (backedUp.length > 0) {
      log.push(`$ backup preserved files: ${backedUp.join(', ')}`);
    }
  };

  const restorePreservedFiles = (stageLabel) => {
    const restored = [];
    for (const entry of preservedEntries) {
      const targetPath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(backupPath)) continue;
      const stat = fs.statSync(backupPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(targetPath, { recursive: true });
        copyDirSync(backupPath, targetPath);
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(backupPath, targetPath);
      }
      restored.push(entry.label);
    }
    if (restored.length > 0) {
      log.push(`$ restore preserved files (${stageLabel}): ${restored.join(', ')}`);
    }
  };

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Folder ini belum menjadi git repository.');

    const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Gagal git fetch.');

    const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    if (!remote.ok) throw new Error('Tidak bisa membaca version.txt dari GitHub.');
    const remoteVersion = String(remote.stdout || '').trim() || '-';

    if (remoteVersion !== '-' && remoteVersion === localBefore) {
      req.session._msg = { type: 'success', text: 'Versi sudah terbaru: ' + localBefore };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/update');
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    backupPreservedEntries();

    const resetSettings = runCmd('git', ['checkout', '--', 'settings.json'], repoRoot);
    pushCmd('git checkout -- settings.json', resetSettings);
    const resetDb = runCmd('git', ['checkout', '--', 'database'], repoRoot);
    pushCmd('git checkout -- database', resetDb);

    const resetHard = runCmd('git', ['reset', '--hard', `origin/${branch}`], repoRoot);
    pushCmd(`git reset --hard origin/${branch}`, resetHard);
    if (!resetHard.ok) throw new Error('Gagal reset ke origin/' + branch);
    repoChanged = true;

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    const cleanExcludes = ['node_modules', 'package-lock.json', ...preservedEntries.map((entry) => entry.cleanExclude)];
    const cleanArgs = ['clean', '-fd'];
    for (const exclude of cleanExcludes) {
      cleanArgs.push('-e', exclude);
    }
    const clean = runCmd(
      'git',
      cleanArgs,
      repoRoot
    );
    pushCmd(`git ${cleanArgs.join(' ')}`, clean);

    restorePreservedFiles('post-update');

    // Cek apakah package.json berubah sebelum install
    const pkgDiff = runCmd('git', ['diff', 'HEAD@{1}', 'HEAD', '--', 'package.json'], repoRoot);
    const pkgChanged = pkgDiff.ok && String(pkgDiff.stdout || '').trim().length > 0;

    if (pkgChanged) {
      log.push('$ package.json berubah, menjalankan npm install (Low-CPU Mode)...');
      const npm = runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], repoRoot);
      pushCmd('npm install --omit=dev --no-audit --no-fund --prefer-offline', npm);
      if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');
    } else {
      log.push('$ package.json tidak berubah, npm install dilewati (Hemat CPU & Waktu!).');
    }

    const localAfter = readTextFileSafe(versionPath) || '-';
    req.session._msg = { type: 'success', text: `Update selesai. Versi: ${localBefore} → ${localAfter}. Silakan restart aplikasi.` };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    if (repoChanged) {
      try {
        restorePreservedFiles('error-recovery');
      } catch (restoreErr) {
        log.push(`$ restore preserved files failed: ${String(restoreErr?.message || restoreErr)}`);
      }
    }
    req.session._msg = { type: 'error', text: 'Gagal update: ' + (e?.message || e) };
    req.session._updateLog = log.join('\n');
  } finally {
    try {
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.redirect('/admin/update');
});

router.post('/api/telegram/sync', requireAdminSession, async (req, res) => {
  try {
    const { initTelegram } = require('../services/telegramBot');
    initTelegram();
    res.json({ success: true, message: 'Bot Telegram berhasil disinkronkan.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const newSettings = { ...req.body };
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;

    if (newSettings.qris_static_enabled === 'true') newSettings.qris_static_enabled = true;
    else if (newSettings.qris_static_enabled === 'false') newSettings.qris_static_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.xendit_enabled === 'true') newSettings.xendit_enabled = true;
    else if (newSettings.xendit_enabled === 'false') newSettings.xendit_enabled = false;

    if (newSettings.duitku_enabled === 'true') newSettings.duitku_enabled = true;
    else if (newSettings.duitku_enabled === 'false') newSettings.duitku_enabled = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = newSettings.whatsapp_admin_numbers.split(',').map(n => n.trim()).filter(Boolean);
    }
    // whatsapp_tech_numbers removed - now automatically fetched from technicians table
    if (newSettings.server_port) newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port) newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay) newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    if (newSettings.digiflazz_markup !== undefined) newSettings.digiflazz_markup = parseInt(newSettings.digiflazz_markup) || 0;
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');
    newSettings.telegram_enabled = (newSettings.telegram_enabled === 'true');
    newSettings.auto_backup_enabled = (newSettings.auto_backup_enabled === 'true');
    newSettings.use_builtin_acs = (newSettings.use_builtin_acs === 'true' || newSettings.use_builtin_acs === true);

    // Multi-Router Mode settings
    if (!newSettings.multi_router_mode) newSettings.multi_router_mode = 'disabled';
    if (newSettings.default_router_id) newSettings.default_router_id = parseInt(newSettings.default_router_id) || null;

    // ✅ NEW: Jika switching dari disabled ke active, auto-assign default router ke pelanggan NULL
    const oldMode = getSetting('multi_router_mode', 'disabled');
    if (oldMode === 'disabled' && newSettings.multi_router_mode === 'active') {
      const defaultRouterId = newSettings.default_router_id;
      if (defaultRouterId && defaultRouterId > 0) {
        // Auto-assign default router to customers with NULL router_id
        const result = db.prepare(
          "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
        ).run(defaultRouterId);
        logger.info(`[Settings] Auto-assigned router ${defaultRouterId} to ${result.changes} customers with NULL router_id`);
      } else {
        // Jika tidak ada default router, cari router pertama yang aktif
        const router = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
        if (router) {
          const result = db.prepare(
            "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
          ).run(router.id);
          logger.info(`[Settings] Auto-assigned router ${router.id} to ${result.changes} customers with NULL router_id`);
        }
      }
    }

    const success = saveSettings(newSettings);
    if (success) {
      // Re-init services if needed
      if (newSettings.telegram_enabled) {
        require('../services/telegramBot').initTelegram();
      } else {
        require('../services/telegramBot').initTelegram(); // This will stop it if it was running
      }
      req.session._msg = { type: 'success', text: 'Pengaturan berhasil disimpan.' };
    } else {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/settings');
});

// ─── BACKUP & RECOVERY ──────────────────────────────────────────────────────
router.get('/backup', requireAdminSession, requireSidebarMenuAccess('backup'), (req, res) => {
  const result = backupSvc.listBackups();
  res.render('admin/backup', {
    title: 'Backup & Recovery',
    company: company(),
    activePage: 'backup',
    msg: flashMsg(req),
    backups: result.backups || [],
    total: result.total || 0,
    getSetting
  });
});

router.get('/backup/download/:fileName', requireAdminSession, (req, res) => {
  try {
    const rawFileName = req.params.fileName;
    const fileName = path.basename(rawFileName);
    const backupDir = path.join(__dirname, '../backups');
    const filePath = path.join(backupDir, fileName);

    if (!fs.existsSync(filePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan.' };
      return res.redirect('/admin/backup');
    }

    res.download(filePath, fileName, (err) => {
      if (err && !res.headersSent) {
        logger.error(`[Backup] Error downloading file ${fileName}:`, err);
        req.session._msg = { type: 'error', text: 'Gagal mendownload file backup.' };
        res.redirect('/admin/backup');
      }
    });
  } catch (e) {
    logger.error('[Backup] Download error:', e);
    req.session._msg = { type: 'error', text: 'Gagal mendownload backup: ' + e.message };
    res.redirect('/admin/backup');
  }
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = backupSvc.backupAll();
    } else if (type === 'database') {
      result = backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipe backup tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Backup berhasil dibuat: ${result.fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal backup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipe restore tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Restore berhasil: ${fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/upload-restore', requireAdminSession, upload.single('backupFile'), (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.originalname) {
      throw new Error('File backup tidak ditemukan.');
    }

    const originalName = path.basename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const timestamp = Date.now();
    const backupDir = path.join(__dirname, '../backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    let result;
    let savedFileName = '';

    if (ext === '.db' || ext === '.sqlite' || originalName.includes('billing_db')) {
      savedFileName = `uploaded_db_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);
      result = backupSvc.restoreDatabase(savedFileName);
    } else if (ext === '.json' || originalName.includes('settings')) {
      savedFileName = `uploaded_settings_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);

      // Verify JSON validity before restoring settings
      try {
        JSON.parse(file.buffer.toString('utf8'));
      } catch (jsonErr) {
        fs.unlinkSync(savePath);
        throw new Error('Format JSON file settings tidak valid: ' + jsonErr.message);
      }

      result = backupSvc.restoreSettings(savedFileName);
    } else {
      throw new Error('Format file tidak didukung. Harap upload file .db (database) atau .json (settings).');
    }

    if (result && result.success) {
      req.session._msg = { 
        type: 'success', 
        text: `File backup "${originalName}" berhasil di-upload dan di-restore! Backup otomatis sebelum restore telah dibuat (${result.preRestoreBackup || '-'}).` 
      };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result ? result.error : 'Error tidak diketahui'}` };
    }
  } catch (e) {
    logger.error('[Backup] Upload & restore error:', e);
    req.session._msg = { type: 'error', text: 'Gagal upload & restore: ' + e.message };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    const backupFilePath = path.join(backupDir, fileName);

    if (!fs.existsSync(backupFilePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan' };
      return res.redirect('/admin/backup');
    }

    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${fileName}`);
    req.session._msg = { type: 'success', text: `Backup berhasil dihapus: ${fileName}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal menghapus: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/cleanup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { retentionDays } = req.body;
    const result = backupSvc.cleanupOldBackups(parseInt(retentionDays) || 30);

    if (result.success) {
      req.session._msg = { type: 'success', text: `Cleanup selesai: ${result.deletedCount} backup lama dihapus` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal cleanup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

// ─── INVENTORY / WAREHOUSE ──────────────────────────────────────────────────
router.get('/inventory', requireAdminSession, requireSidebarMenuAccess('inventory'), (req, res) => {
  const items = inventorySvc.getAllItems(req.query.q);
  const categories = inventorySvc.getAllCategories();
  const logs = inventorySvc.getInventoryLogs(100);

  res.render('admin/inventory', {
    title: 'Manajemen Inventaris',
    company: company(),
    activePage: 'inventory',
    msg: flashMsg(req),
    items,
    categories,
    logs
  });
});

router.post('/inventory/category/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createCategory(req.body);
    req.session._msg = { type: 'success', text: 'Kategori berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/category/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteCategory(req.params.id);
    req.session._msg = { type: 'success', text: 'Kategori berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createItem(req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateItem(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/stock/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.addStock(req.body, req.session.adminUser || 'Admin');
    req.session._msg = { type: 'success', text: 'Stok berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.get('/audit-logs', requireAdminSession, requireSidebarMenuAccess('audit_logs'), restrictToAdmin, (req, res) => {
  const filters = {
    action: req.query.action || null,
    entity_type: req.query.entity_type || null,
    limit: 100
  };
  const logs = auditSvc.getAuditTrail(filters);
  const stats = auditSvc.getAuditStats();

  res.render('admin/audit_logs', {
    title: 'Audit Trail / Log Aktivitas',
    company: company(),
    activePage: 'audit_logs',
    logs,
    stats,
    filters
  });
});

// ─── MONITORING ──────────────────────────────────────────────────────────────
router.get('/monitoring', requireAdminSession, requireSidebarMenuAccess('monitoring'), restrictToAdmin, async (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  const performanceSummary = monitoringSvc.getPerformanceSummary();
  const dependencies = await diagnosticsSvc.checkDependencies();
  const recentErrors = diagnosticsSvc.getRecentErrors(10);
  const settings = getSettings(); // Get current settings

  res.render('admin/monitoring', {
      title: 'Monitoring Sistem',
      company: company(),
      activePage: 'monitoring',
      healthStatus,
      performanceSummary,
      dependencies,
      recentErrors,
      settings // Pass settings to view
    });
});

router.get('/api/health', requireAdmin, (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  res.json(healthStatus);
});

router.get('/api/metrics', requireAdmin, (req, res) => {
  const metrics = monitoringSvc.getAllMetrics();
  res.json(metrics);
});

router.get('/api/metrics/history', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = monitoringSvc.getMetricsHistory(limit);
  res.json(history);
});

// ─── GENIEACS SETTINGS API ──────────────────────────────────────────────────
router.post('/api/genieacs/settings', requireAdmin, async (req, res) => {
  try {
    const { genieacs_timeout, genieacs_rxpower_threshold, genieacs_monitoring_interval, genieacs_monitoring_enabled } = req.body;
    
    // Validate input
    if (genieacs_timeout < 5000 || genieacs_timeout > 120000) {
      return res.json({ success: false, message: 'Timeout harus antara 5000-120000 ms' });
    }
    if (genieacs_rxpower_threshold < -40 || genieacs_rxpower_threshold > -15) {
      return res.json({ success: false, message: 'RX Power threshold harus antara -40 sampai -15 dBm' });
    }
    if (genieacs_monitoring_interval < 1 || genieacs_monitoring_interval > 24) {
      return res.json({ success: false, message: 'Monitoring interval harus antara 1-24 jam' });
    }

    // Update settings
    const currentSettings = getSettings();
    currentSettings.genieacs_timeout = parseInt(genieacs_timeout);
    currentSettings.genieacs_rxpower_threshold = parseFloat(genieacs_rxpower_threshold);
    currentSettings.genieacs_monitoring_interval = parseInt(genieacs_monitoring_interval);
    currentSettings.genieacs_monitoring_enabled = Boolean(genieacs_monitoring_enabled);

    // Save to file
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(__dirname, '../settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

    // Log audit
    try {
      if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
        auditSvc.logAuditTrail({
          action: 'UPDATE',
          entity_type: 'genieacs_settings',
          entity_id: 'settings.json',
          actor_type: req.session.isAdmin ? 'admin' : 'cashier',
          actor_id: req.session.adminUser || req.session.cashierUsername || 'admin',
          actor_name: req.session.adminUser || req.session.cashierName || 'Admin',
          details: {
            timeout: genieacs_timeout,
            rxpower_threshold: genieacs_rxpower_threshold,
            monitoring_interval: genieacs_monitoring_interval,
            monitoring_enabled: genieacs_monitoring_enabled
          },
          ip_address: req.ip || req.connection.remoteAddress,
          user_agent: req.headers['user-agent']
        });
      } else {
        logger.warn('[API] auditSvc.logAuditTrail is not available');
      }
    } catch (auditError) {
      logger.error('[API] Error logging audit trail:', auditError);
    }

    res.json({ 
      success: true, 
      message: 'Pengaturan GenieACS berhasil disimpan. Restart aplikasi untuk menerapkan perubahan timeout.' 
    });
  } catch (error) {
    logger.error('[API] Error saving GenieACS settings:', error);
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

router.get('/api/genieacs/test', requireAdmin, async (req, res) => {
  try {
    const genieacs = require('../config/genieacs');
    const devices = await genieacs.getDevices();
    
    res.json({ 
      success: true, 
      message: 'Koneksi ke GenieACS berhasil!',
      deviceCount: devices.length
    });
  } catch (error) {
    logger.error('[API] Error testing GenieACS connection:', error);
    res.json({ 
      success: false, 
      message: 'Koneksi gagal: ' + error.message 
    });
  }
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok) return res.json({ error: result.message });
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;

    devices.forEach(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const status = String(mapped.status || 'offline').toLowerCase();
      if (status === 'online') online++;
      else offline++;
    });

    res.json({ total, online, offline, warning: 0, lastUpdate: getNowLocalISO() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 999999, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok) return res.json({ error: result.message });
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    let devices = result.devices.map(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const tagsArr = Array.isArray(d._tags) ? d._tags.filter(Boolean).map(String) : [];
      return {
        id: String(d._id || ''),
        tags: tagsArr,
        serialNumber: String(mapped.serialNumber || '-'),
        lastInform: d._lastInform,
        lastInformLabel: String(mapped.lastInform || '-'),
        lastInformAgo: String(mapped.lastInformAgo || '-'),
        lastSync: d._updatedAt || mapped.lastSyncRaw || d._lastInform || '',
        lastSyncLabel: String(mapped.lastSync || '-'),
        lastSyncAgo: String(mapped.lastSyncAgo || '-'),
        syncInProgress: !!mapped.syncInProgress,
        syncPendingCount: Number(mapped.syncPendingCount || 0),
        syncStatusLabel: String(mapped.syncStatusLabel || 'Idle'),
        status: String(mapped.status || 'unknown').toLowerCase(),
        pppoeIP: String(mapped.pppoeIP || '-'),
        pppoeUsername: String(mapped.pppoeUsername || '-'),
        rxPower: String(mapped.rxPower || '-'),
        uptime: String(mapped.uptime || '-'),
        model: String(mapped.model || '-'),
        softwareVersion: String(mapped.softwareVersion || '-'),
        userConnected: mapped.totalAssociations ?? '-',
        ssid: String(mapped.ssid || '-'),
        acs_server_id: d._acs_server_id || 'legacy',
        acs_server_name: d._acs_server_name || 'Default ACS'
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        String(d.id || '').toLowerCase().includes(s) ||
        (Array.isArray(d.tags) && d.tags.some(t => String(t || '').toLowerCase().includes(s) || matchingTags.has(String(t || '').toLowerCase()))) || 
        String(d.serialNumber || '').toLowerCase().includes(s) || 
        String(d.pppoeIP || '').toLowerCase().includes(s) ||
        (String(d.pppoeUsername || '') !== 'N/A' && String(d.pppoeUsername || '').toLowerCase().includes(s)) ||
        matchingPppoes.has(String(d.pppoeUsername || '').toLowerCase())
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
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
        const msg = `📶 *PERUBAHAN SSID WIFI*\n\n` +
          `👤 *Pelanggan:* ${cust.name}\n` +
          `🕒 *Waktu:* ${now}\n\n` +
          `SSID WiFi Anda sudah diperbarui menjadi:\n` +
          `📡 *${ssid}*\n\n` +
          `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
          `⚠️ Jangan bagikan info ini ke orang lain.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif SSID via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
        const msg = `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
          `👤 *Pelanggan:* ${cust.name}\n` +
          `🕒 *Waktu:* ${now}\n\n` +
          `Password WiFi Anda sudah diperbarui menjadi:\n` +
          `🔐 *${password}*\n\n` +
          `Silakan gunakan password baru untuk terhubung.\n` +
          `⚠️ Jangan bagikan password ini ke orang lain.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif Password via WA: ' + (e.message || e)); }
  }
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
    try {
      const success = await customerDevice.updateSSID(tag, ssid);
      results.push({ tag, success });
      // Kirim notifikasi WhatsApp ke pelanggan
      if (success) {
        try {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const now = getNowLocal();
            const msg = `📶 *PERUBAHAN SSID WIFI*\n\n` +
              `👤 *Pelanggan:* ${cust.name}\n` +
              `🕒 *Waktu:* ${now}\n\n` +
              `SSID WiFi Anda sudah diperbarui menjadi:\n` +
              `📡 *${ssid}*\n\n` +
              `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
              `⚠️ Jangan bagikan info ini ke orang lain.`;
            await trySendWhatsappPayment(cust.phone, msg);
          }
        } catch (e) { /* ignore per-customer WA notification errors */ }
      }
    }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});

router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.query.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  const dbRouters = mikrotikService.getAllRouters();
  const settings = getSettings();
  const settingsRouter = {
    id: '',
    name: settings.mikrotik_host ? `MikroTik (settings.json - ${settings.mikrotik_host})` : 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const routers = dbRouters.length > 0 ? dbRouters : [settingsRouter];
  const activeRouterId = req.selectedRouterId || (routers[0] ? routers[0].id : '');

  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik',
    routers, activeRouterId, selectedRouterId: req.selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/mikrotik/display', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const settings = getSettings();
  const defaultRouter = {
    id: 'settings_json',
    name: 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const allRouters = [defaultRouter, ...routers];

  res.render('admin/mikrotik_display', {
    title: 'MikroTik NOC Display',
    company: company(),
    routers: allRouters,
    msg: flashMsg(req),
    settings
  });
});

router.get('/vouchers', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  res.render('admin/vouchers', {
    title: 'Manajemen Voucher', company: company(), activePage: 'mikrotik',
    routers, selectedRouterId, msg: flashMsg(req), settings: getSettings()
  });
});

router.get('/api/vouchers/template', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.json({
    use_template: !!settings.voucher_print_use_template,
    default_style: String(settings.voucher_print_default_style || ''),
    header: String(settings.voucher_print_template_header || ''),
    row: String(settings.voucher_print_template_row || ''),
    footer: String(settings.voucher_print_template_footer || '')
  });
});

router.post('/api/vouchers/template', requireAdminSession, restrictToAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const useTemplate = !!req.body.use_template;
    const defaultStyle = String(req.body.default_style || '').trim().toLowerCase();
    const header = String(req.body.header || '');
    const row = String(req.body.row || '');
    const footer = String(req.body.footer || '');
    saveSettings({
      voucher_print_use_template: useTemplate,
      voucher_print_default_style: defaultStyle,
      voucher_print_template_header: header,
      voucher_print_template_row: row,
      voucher_print_template_footer: footer
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/webhook/payment-notif/logs', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const service = String(req.query.service || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (service) {
      where.push('service = ?');
      params.push(service);
    }
    if (q) {
      where.push('(content LIKE ? OR service LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT id, created_at, service, content, parsed_amount, parsed_ok, matched_invoice_id, matched_voucher_order_id, matched_donation_order_id, ip
      FROM webhook_payment_notifs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);

    // Convert created_at to local timezone
    const rowsWithLocalTime = rows.map(row => ({
      ...row,
      created_at: row.created_at ? formatDateLocal(row.created_at, 'YYYY-MM-DD HH:mm:ss') : null
    }));

    res.json({ ok: true, rows: rowsWithLocalTime });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhook/payment-notif/clear', requireAdminSession, restrictToAdmin, express.json(), (req, res) => {
  try {
    db.prepare('DELETE FROM webhook_payment_notifs').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vouchers/batches/:id/print', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const settings = getSettings();
  const requestedStyle = String(req.query.style || '').trim().toLowerCase();
  const style = requestedStyle || String(settings.voucher_print_default_style || '').trim().toLowerCase() || (settings.voucher_print_use_template ? 'template' : 'cards');

  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripUnsafe = (html) => {
    let out = String(html || '');
    out = out.replace(/<\?(?:php)?[\s\S]*?\?>/gi, '');
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    return out;
  };

  const applyVars = (tpl, vars) => {
    let out = String(tpl || '');
    out = out.replace(/%([a-zA-Z0-9_#]+)%/g, (m, k) => (vars[k] != null ? vars[k] : m));
    out = out.replace(/\{\{\s*([a-zA-Z0-9_#]+)\s*\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  };

  const formatValidity = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return `${Number(mDay[1])} hari`;
    return s;
  };

  let renderedHtml = '';
  let templateError = '';
  const builtinTemplate = (name) => {
    const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
      ? ('+' + String(settings.whatsapp_admin_numbers[0]))
      : String(settings.company_phone || '');
    const companyName = settings.company_header || company();
    const timeStamp = new Date().toISOString();
    const priceNumber = Number(batch.price || 0);
    const priceText = priceNumber.toLocaleString('id-ID');
    const validityText = formatValidity(batch.validity);

    const rows = (vouchers || []).map((v, i) => {
      const credential = (String(v.code) === String(v.password))
        ? escapeHtml(String(v.code))
        : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
      return {
        idx: i + 1,
        username: escapeHtml(v.code),
        password: escapeHtml(v.password),
        credential,
        profile: escapeHtml(batch.profile_name || v.profile_name || ''),
        company: escapeHtml(companyName),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        price: escapeHtml(String(priceNumber)),
        priceText: escapeHtml(priceText),
        validity: escapeHtml(batch.validity || ''),
        validityText: escapeHtml(validityText),
      };
    });

    if (name === 'mks') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.v-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.vc{border:1px solid #0f172a;border-radius:10px;min-height:110px;padding:8px;position:relative;break-inside:avoid;overflow:hidden}
.vc:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(59,130,246,.03),rgba(16,185,129,.025))}
.vc>*{position:relative}
.vh{font-weight:900;font-size:11px;letter-spacing:.2px}
.vp{position:absolute;top:8px;right:8px;font-size:10.5px;font-weight:800;background:rgba(16,185,129,.16);border:1px solid rgba(16,185,129,.35);padding:2px 7px;border-radius:999px}
.vm{font-size:10px;color:#334155;margin-top:6px}
.vu{font-weight:950;font-size:18px;letter-spacing:1px;margin-top:8px;font-family:Consolas,monospace;line-height:1.15}
.vf{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="vc">
  <div class="vh">${r.company}</div>
  <div class="vp">${r.currency} ${r.priceText}</div>
  <div class="vm">${r.profile} • ${r.validityText}</div>
  <div class="vu">${r.credential}</div>
  <div class="vf">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="v-grid">\n${html}\n</div>`;
    }

    if (name === 'simple') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{border:1.5px solid #334155;border-radius:10px;padding:8px 8px 22px;min-height:110px;position:relative;break-inside:avoid}
.hd{font-weight:800;font-size:11px}
.code{font-weight:900;font-size:22px;letter-spacing:2px;margin-top:6px;font-family:Consolas,monospace}
.meta{font-size:10px;color:#334155;margin-top:4px}
.wa{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="card">
  <div class="hd">${r.company}</div>
  <div class="meta">${r.profile} • ${r.validityText} • ${r.currency} ${r.priceText}</div>
  <div class="code">${r.username}</div>
  <div class="meta">${r.password}</div>
  <div class="wa">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="grid">\n${html}\n</div>`;
    }

    if (name === 'minimal') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.c{border:1px dashed #334155;border-radius:8px;padding:6px 6px 18px;min-height:84px;position:relative;break-inside:avoid}
.t{font-weight:900;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{font-size:9.5px;color:#334155;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{font-weight:950;font-size:18px;letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace}
.w{position:absolute;left:6px;right:6px;bottom:5px;font-size:9px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
      const html = rows.map(r => `<div class="c">
  <div class="t">${r.company}</div>
  <div class="m">${r.profile}</div>
  <div class="k">${r.username}</div>
  <div class="w">${r.validityText} • ${r.currency} ${r.priceText} • ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="g">\n${html}\n</div>`;
    }

    return '';
  };

  if (style === 'mks' || style === 'simple' || style === 'minimal') {
    renderedHtml = builtinTemplate(style);
  } else if (style === 'template') {
    const headerTpl = String(settings.voucher_print_template_header || '');
    const rowTpl = String(settings.voucher_print_template_row || '');
    const footerTpl = String(settings.voucher_print_template_footer || '');

    if (rowTpl.trim()) {
      const looksLikePhpOnly = (tpl) => {
        const s = String(tpl || '');
        const hasHtml = /<\s*[a-zA-Z][^>]*>/.test(s);
        const phpSignals = /(\$[a-zA-Z_])|(\bif\s*\()|(\bsubstr\s*\()|(\bstrlen\s*\()|(\belse(if)?\b)|(\bforeach\b)/.test(s);
        const manyPhp = (s.match(/\$/g) || []).length >= 3;
        return !hasHtml && (phpSignals || manyPhp);
      };
      const combined = `${headerTpl}\n${rowTpl}\n${footerTpl}`;
      if (/<\?(?:php)?/i.test(combined) || looksLikePhpOnly(combined)) {
        templateError = 'Template yang dipaste masih format PHP (Mikhmon). Di sini hanya mendukung template HTML + placeholder (%username% dll).';
      }

      const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
        ? ('+' + String(settings.whatsapp_admin_numbers[0]))
        : String(settings.company_phone || '');
      const timeStamp = new Date().toISOString();
      const priceNumber = Number(batch.price || 0);
      const priceText = priceNumber.toLocaleString('id-ID');
      const validityText = formatValidity(batch.validity);

      const parts = [];
      parts.push(stripUnsafe(applyVars(headerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      vouchers.forEach((v, i) => {
        const credential = (String(v.code) === String(v.password))
          ? escapeHtml(String(v.code))
          : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
        const vars = {
          username: escapeHtml(v.code),
          password: escapeHtml(v.password),
          profile: escapeHtml(batch.profile_name || v.profile_name || ''),
          validity: escapeHtml(batch.validity || ''),
          validityText: escapeHtml(validityText),
          price: escapeHtml(String(priceNumber)),
          priceText: escapeHtml(priceText),
          currency: 'Rp',
          company: escapeHtml(settings.company_header || company()),
          phone: escapeHtml(phone),
          timeStamp: escapeHtml(timeStamp),
          '#': escapeHtml(String(i + 1)),
          credential
        };
        parts.push(stripUnsafe(applyVars(rowTpl, vars)));
      });

      parts.push(stripUnsafe(applyVars(footerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      renderedHtml = parts.join('\n');
    }
  }

  let finalStyle = style;
  if (finalStyle === 'template') {
    const s = String(renderedHtml || '').trim();
    if (!s || !/<\s*[a-zA-Z][^>]*>/.test(s) || templateError) {
      renderedHtml = '';
      finalStyle = 'cards';
    }
  }

  res.render('admin/print_vouchers', {
    title: 'Cetak Voucher',
    company: company(),
    settings,
    batch,
    vouchers,
    style: finalStyle,
    renderedHtml,
    templateError
  });
});

router.get('/vouchers/batches/:id/export.csv', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const lines = [];
  lines.push(['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at', 'used_at'].join(','));
  const createdAt = batch.created_at || '';
  const validity = batch.validity || '';
  const price = Number(batch.price || 0);
  const routerName = batch.router_name || '';
  for (const v of vouchers) {
    const row = [
      v.code,
      v.password,
      v.profile_name,
      validity,
      price,
      routerName,
      batchId,
      createdAt,
      v.used_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=vouchers_batch_${batchId}.csv`);
  res.send(lines.join('\n'));
});

router.get('/api/vouchers/batches', requireAdmin, (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const rows = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE (? IS NULL OR b.router_id = ?)
    ORDER BY b.id DESC
    LIMIT 200
  `).all(routerId, routerId);
  res.json(rows);
});

router.get('/api/vouchers/batches/:id', requireAdmin, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, status, used_at, last_seen_comment, last_seen_uptime, last_seen_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
    LIMIT 2000
  `).all(batchId);
  res.json({ batch, vouchers });
});

router.post('/api/vouchers/batches', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(5000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const priceInput = req.body.price;
    
    if (!profileName) return res.status(400).json({ error: 'Profile wajib diisi' });
    if (!qty) return res.status(400).json({ error: 'Jumlah voucher wajib diisi' });
    if (prefix.length >= codeLength) return res.status(400).json({ error: 'Prefix terlalu panjang' });

    const profiles = await mikrotikService.getHotspotUserProfiles(routerId);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) return res.status(400).json({ error: 'Profile Hotspot tidak ditemukan di MikroTik' });

    const meta = parseMikhmonOnLogin(profile.onLogin || profile['on-login']);
    if (!meta || !meta.validity) return res.status(400).json({ error: 'Profile belum memiliki metadata harga/durasi (Format Mikhmon)' });

    const createdBy = req.session?.isAdmin ? (req.session.adminUser || 'admin') : (req.session.cashierName || 'staff');
    let price = Number(meta.price || 0);
    if (priceInput !== undefined && priceInput !== null && String(priceInput).trim() !== '') {
      const p = Number(priceInput);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Harga tidak valid' });
      price = Math.floor(p);
    }

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, meta.validity || '', prefix, codeLength, createdBy, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    const exists = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(4, Math.min(16, codeLength - prefix.length));
      const userCode = prefix + genCode(coreLen, charset);
      let passCode = userCode;
      if (mode === 'member') {
        passCode = genCode(coreLen, charset);
      }
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const generated = makeCode();
      if (codes.has(generated.userCode)) continue;
      if (exists.get(routerId, generated.userCode)) continue;
      codes.add(generated.userCode);
      initialVouchers.push(generated);
    }

    const tx = db.transaction((items) => {
      for (const c of items) {
        insertVoucher.run(batchId, routerId, c.userCode, c.passCode, profileName, `vc-${c.userCode}-${profileName}`);
      }
    });
    tx(initialVouchers);

    setImmediate(() => {
      createVoucherBatchAsync(batchId).catch(e => logger.error('[VoucherBatch] Error: ' + (e?.message || e)));
    });

    res.json({ success: true, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/sync', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

    const routerId = batch.router_id ?? null;
    const users = await mikrotikService.getHotspotUsers(routerId);
    const byName = new Map();
    for (const u of users) {
      if (u?.name) byName.set(String(u.name), u);
    }

    const list = db.prepare('SELECT id, code, used_at FROM vouchers WHERE batch_id = ?').all(batchId);
    const updSeen = db.prepare("UPDATE vouchers SET last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markUsed = db.prepare("UPDATE vouchers SET used_at=(NOW_LOCAL()), status='used', last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markMissing = db.prepare("UPDATE vouchers SET status='missing', last_seen_at=(NOW_LOCAL()) WHERE id=?");

    let usedNew = 0;
    let missing = 0;

    const tx = db.transaction(() => {
      for (const v of list) {
        const u = byName.get(String(v.code));
        if (!u) {
          markMissing.run(v.id);
          missing++;
          continue;
        }
        const comment = String(u.comment || '');
        const uptime = String(u.uptime || '');
        const isUsedByComment = comment && !comment.toLowerCase().startsWith('vc') && !comment.toLowerCase().startsWith('up');
        const isUsedByUptime = uptime && uptime !== '0s' && uptime !== '0' && uptime !== '00:00:00';
        const usedNow = isUsedByComment || isUsedByUptime;
        if (usedNow && !v.used_at) {
          markUsed.run(comment, uptime, v.id);
          usedNew++;
        } else {
          updSeen.run(comment, uptime, v.id);
        }
      }
    });
    tx();

    res.json({ success: true, usedNew, missing, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/delete', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    if (!batchId) return res.status(400).json({ error: 'Batch ID tidak valid' });

    const batch = db.prepare('SELECT id, status FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
    if (String(batch.status) === 'creating') {
      return res.status(400).json({ error: 'Batch sedang diproses (creating). Silakan tunggu hingga selesai.' });
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ?) AS total,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ? AND v.used_at IS NOT NULL) AS used
    `).get(batchId, batchId);

    const del = db.prepare('DELETE FROM voucher_batches WHERE id = ?');
    del.run(batchId);

    res.json({ success: true, deletedBatchId: batchId, deletedVouchers: stats?.total || 0, usedCount: stats?.used || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeSecrets(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeSecret(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeSecret(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeSecret(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUsers(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUser(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUser(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUser(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/monitoring-display-data', requireAdmin, async (req, res) => {
  const routerId = req.query.routerId ? (req.query.routerId === 'null' || req.query.routerId === 'settings' || req.query.routerId === 'settings_json' ? 'settings_json' : Number(req.query.routerId)) : 'settings_json';
  try {
    const conn = await mikrotikService.getConnection(routerId);
    if (!conn) {
      return res.status(500).json({ error: 'Gagal terhubung ke router MikroTik.' });
    }

    // Parallel execution for performance
    const [
      resource,
      interfaces,
      activePppoe,
      secrets,
      activeHotspot,
      hotspotUsers
    ] = await Promise.all([
      // 1. Resources
      mikrotikService.getSystemResource(routerId).catch(err => {
        logger.error('[NOC Display] Error resource:', err.message);
        return null;
      }),
      // 2. Interfaces
      conn.client.menu('/interface').get().catch(err => {
        logger.error('[NOC Display] Error interfaces:', err.message);
        return [];
      }),
      // 3. Active PPPoE
      mikrotikService.getPppoeActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active PPPoE:', err.message);
        return [];
      }),
      // 4. PPPoE Secrets
      mikrotikService.getPppoeSecrets(routerId).catch(err => {
        logger.error('[NOC Display] Error secrets:', err.message);
        return [];
      }),
      // 5. Active Hotspot
      mikrotikService.getHotspotActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active Hotspot:', err.message);
        return [];
      }),
      // 6. Hotspot Users
      mikrotikService.getHotspotUsers(routerId).catch(err => {
        logger.error('[NOC Display] Error hotspot users:', err.message);
        return [];
      })
    ]);

    // Calculate PPPoE Offline
    const activePppoeNames = new Set((activePppoe || []).map(s => String(s.name).trim()));
    const offlinePppoe = (secrets || []).filter(s => {
      const isOnline = activePppoeNames.has(String(s.name).trim());
      const isDisabled = s.disabled === true || s.disabled === 'true';
      return !isOnline && !isDisabled;
    });

    // Format resources
    const resData = {
      cpu: resource ? String(resource['cpu-load'] || resource.cpuLoad || resource['cpu'] || '0') : '0',
      freeMemory: resource ? Number(resource['free-memory'] || resource.freeMemory) || 0 : 0,
      totalMemory: resource ? Number(resource['total-memory'] || resource.totalMemory) || 0 : 0,
      uptime: resource ? String(resource['uptime'] || '00:00:00') : '00:00:00',
      boardName: resource ? String(resource['board-name'] || resource.boardName || 'MikroTik') : 'MikroTik',
      version: resource ? String(resource['version'] || 'N/A') : 'N/A'
    };

    // Format interfaces (only return fields needed)
    const formattedInterfaces = (interfaces || []).map(i => {
      return {
        name: i.name,
        type: i.type,
        running: i.running === true || i.running === 'true' || i.running === 'yes',
        disabled: i.disabled === true || i.disabled === 'true' || i.disabled === 'yes',
        bytesIn: Number(i['rx-byte'] || i['rx-bytes'] || i['bytes-in']) || 0,
        bytesOut: Number(i['tx-byte'] || i['tx-bytes'] || i['bytes-out']) || 0
      };
    });

    res.json({
      ok: true,
      resources: resData,
      interfaces: formattedInterfaces,
      pppoe: {
        active: activePppoe ? activePppoe.length : 0,
        offline: offlinePppoe ? offlinePppoe.length : 0,
        total: secrets ? secrets.length : 0
      },
      hotspot: {
        active: activeHotspot ? activeHotspot.length : 0,
        total: hotspotUsers ? hotspotUsers.length : 0
      },
      timestamp: Date.now()
    });
  } catch (e) {
    logger.error('[NOC Display API] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/ip-pools', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getIpPools(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const rows = await mikrotikService.getHotspotUserProfiles(req.query.routerId);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({ ...r, id: r.id || r['.id'] })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/api/mikrotik/hotspot-user-profiles/:id', requireAdmin, async (req, res) => {
  try {
    const row = await mikrotikService.getHotspotUserProfileById(req.params.id, req.query.routerId);
    if (!row) return res.status(404).json({ error: 'Profile tidak ditemukan' });
    return res.json({ ok: true, row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUserProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUserProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup(req.query.routerId);
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
  startTime: null,
  paused: false,
  stopped: false,
  currentBatch: 0,
  messagesPerHour: 0,
  hourlyLimit: 100
};

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

// Helper: Cek apakah waktu aman untuk broadcast (hindari jam sibuk)
function isSafeTimeToBroadcast() {
  const now = new Date();
  const hour = now.getHours();
  // Hindari jam 00:00 - 06:00 (jam malam) dan jam 18:00 - 21:00 (jam sibuk)
  return hour >= 8 && hour <= 17;
}

// Helper: Hitung delay berdasarkan jam (lebih lama di jam sibuk)
function getTimeBasedDelay(baseDelayMs) {
  const now = new Date();
  const hour = now.getHours();
  
  // Jam sibuk (18:00 - 21:00): delay 2x lebih lama
  if (hour >= 18 && hour <= 21) {
    return baseDelayMs * 2;
  }
  
  // Jam malam (00:00 - 06:00): delay 3x lebih lama
  if (hour >= 0 && hour <= 6) {
    return baseDelayMs * 3;
  }
  
  // Jam normal: delay normal
  return baseDelayMs;
}

// Helper: Cek duplicate message untuk menghindari spam
function isDuplicateMessage(phone, message, messageHistory) {
  const key = `${phone}_${message.substring(0, 50)}`;
  const lastSent = messageHistory.get(key);
  if (!lastSent) return false;
  
  const timeDiff = Date.now() - lastSent;
  return timeDiff < 3600000; // 1 jam
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

// Helper: Cek apakah error adalah temporary (bisa retry)
function isTemporaryError(errorMessage) {
  const temporaryErrorPatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /rate.*limit/i,
    /too.*many/i,
    /429/i,
    /500/i,
    /502/i,
    /503/i,
    /504/i
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Global message history untuk duplicate detection
global.broadcastMessageHistory = new Map();

const waSvc = require('../services/whatsappService');

router.get('/whatsapp', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'baileys');
  const metaSettings = {
    meta_phone_number_id: getSetting('meta_phone_number_id', ''),
    meta_waba_id: getSetting('meta_waba_id', ''),
    meta_access_token: getSetting('meta_access_token', ''),
    meta_verify_token: getSetting('meta_verify_token', 'antigravity_meta_wa_secret'),
    meta_business_phone: getSetting('meta_business_phone', '')
  };
  const fonnteSettings = {
    fonnte_token: getSetting('fonnte_token', ''),
    fonnte_api_url: getSetting('fonnte_api_url', 'https://api.fonnte.com/send'),
    fonnte_country_code: getSetting('fonnte_country_code', '62')
  };

  res.render('admin/whatsapp', {
    title: 'Status WhatsApp',
    company: company(),
    activePage: 'whatsapp',
    msg: flashMsg(req),
    waGatewayType,
    metaSettings,
    fonnteSettings,
    host: req.get('host') || 'localhost:3001'
  });
});

router.post('/whatsapp/gateway-settings', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      wa_gateway_type,
      meta_phone_number_id,
      meta_waba_id,
      meta_access_token,
      meta_verify_token,
      meta_business_phone,
      fonnte_token,
      fonnte_api_url,
      fonnte_country_code
    } = req.body;

    saveSettings({
      wa_gateway_type: wa_gateway_type || 'baileys',
      meta_phone_number_id: String(meta_phone_number_id || '').trim(),
      meta_waba_id: String(meta_waba_id || '').trim(),
      meta_access_token: String(meta_access_token || '').trim(),
      meta_verify_token: String(meta_verify_token || '').trim() || 'antigravity_meta_wa_secret',
      meta_business_phone: String(meta_business_phone || '').trim(),
      fonnte_token: String(fonnte_token || '').trim(),
      fonnte_api_url: String(fonnte_api_url || 'https://api.fonnte.com/send').trim(),
      fonnte_country_code: String(fonnte_country_code || '62').trim()
    });
    req.session._msg = { type: 'success', text: 'Pengaturan WhatsApp Gateway (Baileys / Fonnte / Meta) berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/test-fonnte', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Nomor HP tujuan wajib diisi.' });

    const fonnteSvc = require('../services/fonnteWhatsappService');
    const result = await fonnteSvc.testFonnteConnection(phone, message);
    res.json({ success: true, message: 'Pesan berhasil dikirim via Fonnte Gateway!', data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// LIVE CHAT ROUTES
router.get('/whatsapp/live-chat', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'baileys');
  const customers = customerSvc.getAllCustomers();
  res.render('admin/whatsapp_live_chat', {
    title: 'Live Chat WhatsApp',
    company: company(),
    activePage: 'whatsapp_live_chat',
    msg: flashMsg(req),
    gatewayType: waGatewayType,
    customers: customers || []
  });
});

router.get('/api/whatsapp/conversations', requireAdminSession, (req, res) => {
  try {
    const list = waSvc.getRecentConversations(50);
    res.json({ ok: true, conversations: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/whatsapp/messages', requireAdminSession, (req, res) => {
  try {
    const phone = req.query.phone || '';
    const list = waSvc.getChatHistory(phone, 100);
    res.json({ ok: true, messages: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/whatsapp/send-direct', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, error: 'Nomor dan pesan tidak boleh kosong' });

    await waSvc.sendWhatsAppMessage(phone, message);
    res.json({ success: true, message: 'Pesan WhatsApp terkirim' });
  } catch (e) {
    const errorText = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    res.status(500).json({ success: false, error: errorText });
  }
});

router.get('/whatsapp/templates', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const comp = company();
  const defaultAutoBilling = `Yth. Pelanggan {{nama}},\n\nIni adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\nMohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih atas kerja samanya.\nSalam,\nAdmin ${comp}`;
  
  const defaultQris = `Yth. Pelanggan {{nama}},\n\nBerikut rincian tagihan manual + Kode Bayar QRIS Anda:\n\n📦 *Paket:* {{paket}}\n📅 *Periode:* {{periode}}\n💰 *Nominal:* Rp {{qris_nominal}}\n\nSilakan scan QRIS berikut untuk melakukan pembayaran otomatis:\n{{qris_qr}}\n\nTerima kasih.`;

  const defaultSuccess = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan lakukan pembayaran segera melalui portal pelanggan: {{link}}\n\nTerima kasih.`;

  const templates = {
    whatsapp_auto_billing_message: db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling),
    whatsapp_billing_qris_message: db.getAppSetting('whatsapp_billing_qris_message', defaultQris),
    whatsapp_payment_success_message: db.getAppSetting('whatsapp_payment_success_message', defaultSuccess),
    whatsapp_isolir_message: db.getAppSetting('whatsapp_isolir_message', defaultIsolir)
  };

  res.render('admin/whatsapp_templates', {
    title: 'Template Pesan WhatsApp',
    company: comp,
    activePage: 'whatsapp',
    msg: flashMsg(req),
    templates
  });
});

router.post('/whatsapp/templates', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      whatsapp_auto_billing_message,
      whatsapp_billing_qris_message,
      whatsapp_payment_success_message,
      whatsapp_isolir_message
    } = req.body;

    db.saveAppSetting('whatsapp_auto_billing_message', whatsapp_auto_billing_message || '');
    db.saveAppSetting('whatsapp_billing_qris_message', whatsapp_billing_qris_message || '');
    db.saveAppSetting('whatsapp_payment_success_message', whatsapp_payment_success_message || '');
    db.saveAppSetting('whatsapp_isolir_message', whatsapp_isolir_message || '');

    req.session._msg = { type: 'success', text: 'Template WhatsApp berhasil disimpan ke database.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan template: ' + e.message };
  }
  res.redirect('/admin/whatsapp/templates');
});

router.get('/whatsapp/broadcast', requireAdminSession, requireSidebarMenuAccess('broadcast'), (req, res) => {
  const comp = company();
  const defaultAutoBillingMsg =
    `Yth. Pelanggan {{nama}},\n\n` +
    `Ini adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n` +
    `📦 *Paket:* {{paket}}\n` +
    `💰 *Total Tagihan:* Rp {{tagihan}}\n` +
    `📅 *Periode:* {{rincian}}\n\n` +
    `Mohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\n` +
    `Terima kasih atas kerja samanya.\n` +
    `Salam,\nAdmin ${comp}`;
  const autoBillingMsg = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBillingMsg);

  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: comp, activePage: 'broadcast', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting, autoBillingMsg
  });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

// API: Pause Broadcast
router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = true;
  logger.info('[Broadcast] Broadcast dipause oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dipause.' });
});

// API: Resume Broadcast
router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dilanjutkan.' });
});

// API: Stop Broadcast
router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.stopped = true;
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dihentikan.' });
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    
    // Smart Rate Limit Settings
    const baseDelayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 5)) * 1000; // Default 5 detik
    const batchSize = parseInt(customBatchSize) || 15; // Default 15 pesan per batch (lebih aman)
    const batchPauseMs = 120000; // Pause 2 menit setelah setiap batch (lebih aman)
    const hourlyLimit = parseInt(customHourlyLimit) || 80; // Default 80 pesan per jam (lebih aman)
    
    if (customDelay) {
      const v = parseInt(customDelay);
      if (Number.isFinite(v) && v >= 1 && v <= 60) {
        saveSettings({ whatsapp_broadcast_delay: v });
      }
    }

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
    
    // Initialize Tracker dengan Smart Rate Limit
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date(),
      paused: false,
      stopped: false,
      currentBatch: 0,
      messagesPerHour: 0,
      hourlyLimit: hourlyLimit
    };

    const sendMessageAsync = async () => {
      let batchCount = 0;
      let windowStartTime = Date.now();
      let messagesInCurrentHour = 0;

      for (let i = 0; i < uniqueCustomers.length; i++) {
        if (global.broadcastStatus.stopped) {
          logger.info('[Broadcast] Dihentikan oleh admin.');
          break;
        }

        while (global.broadcastStatus.paused) {
          await new Promise(r => setTimeout(r, 1000));
          if (global.broadcastStatus.stopped) break;
        }
        if (global.broadcastStatus.stopped) break;

        // Rate Limiting: Cek batas per jam
        const now = Date.now();
        if (now - windowStartTime >= 3600000) {
          windowStartTime = now;
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        if (messagesInCurrentHour >= hourlyLimit) {
          const waitTimeMs = 3600000 - (now - windowStartTime);
          logger.info(`[Broadcast] Batas per jam tercapai (${hourlyLimit} pesan). Menunggu ${Math.ceil(waitTimeMs / 60000)} menit...`);
          await new Promise(r => setTimeout(r, waitTimeMs));
          windowStartTime = Date.now();
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        const cust = uniqueCustomers[i];
        let attemptCount = 0;
        const maxAttempts = 3;

        while (attemptCount < maxAttempts) {
          try {
            // Smart Random Delay
            const randomDelay = getRandomDelay(baseDelayMs, 2000);
            await new Promise(r => setTimeout(r, randomDelay));

            // Format Pesan dengan Spintax
            let formattedMsg = message.replace(/{{nama}}/gi, cust.name || 'Pelanggan');

            const { parseSpintax } = await import('../services/whatsappBot.mjs');
            formattedMsg = parseSpintax(formattedMsg);
            formattedMsg = addMessageVariation(formattedMsg, i);

            await waSvc.sendWhatsAppMessage(cust.phone, formattedMsg);
            global.broadcastStatus.sent++;
            messagesInCurrentHour++;
            global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
            batchCount++;
            
            // Batch Processing: Pause setelah N pesan
            if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
              logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
              global.broadcastStatus.currentBatch++;
              await new Promise(r => setTimeout(r, batchPauseMs));
              batchCount = 0;
            }
            
            break; // Sukses, keluar dari retry loop
          } catch (e) {
            attemptCount++;
            const errorMsg = e.message || e.toString();
            
            // Cek apakah error permanent (tidak perlu retry)
            if (isPermanentError(errorMsg)) {
              logger.warn(`[Broadcast] SKIP: Error permanent untuk ${cust.phone} - ${errorMsg}`);
              global.broadcastStatus.failed++;
              break; // Skip retry langsung ke pelanggan berikutnya
            }
            
            // Error temporary, bisa retry
            logger.error(`[Broadcast] Gagal kirim ke ${cust.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
            
            if (attemptCount >= maxAttempts) {
              logger.warn(`[Broadcast] Max attempts tercapai untuk ${cust.phone}`);
              global.broadcastStatus.failed++;
            } else {
              // Exponential backoff untuk retry
              const backoffDelay = getBackoffDelay(attemptCount);
              logger.info(`[Broadcast] Retry ke ${cust.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
              await new Promise(r => setTimeout(r, backoffDelay));
            }
          }
        }
      }
      
      global.broadcastStatus.active = false;
      logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
    };
    
    sendMessageAsync(); 

    req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${uniqueCustomers.length} pelanggan dengan smart rate limit.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? true : false;
    const billingEnabled = req.body && req.body.billing_enabled ? true : false;
    const delay = req.body && req.body.delay ? parseInt(req.body.delay) : null;
    const next = { whatsapp_auto_billing_enabled: enabled, whatsapp_billing_to_customer_enabled: billingEnabled };
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
      next.whatsapp_broadcast_delay = delay;
    }
    const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (msg) {
      db.saveAppSetting('whatsapp_auto_billing_message', msg);
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: `Pengingat tagihan otomatis ${enabled ? 'diaktifkan' : 'dimatikan'}. Notifikasi tagihan ke pelanggan ${billingEnabled ? 'diaktifkan' : 'dimatikan'}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const gatewayType = getSetting('wa_gateway_type', 'baileys');
      if (gatewayType === 'meta') {
        const phoneId = getSetting('meta_phone_number_id', '');
        const token = getSetting('meta_access_token', '');
        res.json({ connection: (phoneId && token) ? 'open' : 'connecting', gateway: 'meta' });
      } else {
        const { whatsappStatus } = await import('../services/whatsappBot.mjs');
        res.json(whatsappStatus);
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
    }
    const adminNumbers = getSetting('whatsapp_admin_numbers', []);
    const legacyNumbers = getSetting('admins', []);
    let adminPhone = '087820851413'; // fallback
    if (Array.isArray(adminNumbers) && adminNumbers.length > 0) {
      adminPhone = adminNumbers[0];
    } else if (Array.isArray(legacyNumbers) && legacyNumbers.length > 0) {
      adminPhone = legacyNumbers[0];
    }

    logger.info(`[WA Test] Mengirim test notifikasi ke nomor admin: ${adminPhone}`);
    const msg =
      `🧪 *TEST NOTIFIKASI WHATSAPP*\n\n` +
      `✅ Jika pesan ini masuk, berarti notifikasi WhatsApp dari Billing Alijaya System sudah berfungsi.\n` +
      `📅 Waktu: ${getNowLocal()}`;
    const ok = await sendWA(adminPhone, msg);
    if (!ok) throw new Error('Gagal mengirim pesan test (sendWA=false).');
    logger.info(`[WA Test] Test notifikasi sukses terkirim ke ${adminPhone}`);
    req.session._msg = { type: 'success', text: 'Test notifikasi WhatsApp berhasil dikirim ke ' + adminPhone };
  } catch (e) {
    logger.error(`[WA Test] Gagal mengirim test notifikasi: ${e.message}`);
    req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
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

// ─── ROUTERS (MULTI-ROUTER) ──────────────────────────────────────────────────
router.get('/routers', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  res.render('admin/routers', {
    title: 'Manajemen Router', company: company(), activePage: 'mikrotik',
    routers: mikrotikService.getAllRouters(), msg: flashMsg(req)
  });
});

// ─── PROMO SLIDES ─────────────────────────────────────────────────────────────
router.get('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slides = db.prepare(`
      SELECT * FROM promo_slides 
      ORDER BY sort_order ASC, id ASC
    `).all();
    
    res.render('admin/promo_slides', {
      title: 'Manajemen Promo Slides',
      company: company(),
      activePage: 'promo_slides',
      slides: slides || [],
      msg: flashMsg(req)
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    res.redirect('/admin/settings');
  }
});

router.get('/api/promo-slides/:id', requireAdminSession, (req, res) => {
  try {
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(Number(req.params.id));
    if (!slide) return res.status(404).json({ error: 'Slide tidak ditemukan' });
    res.json(slide);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    
    if (!req.file) throw new Error('Gambar harus diupload');
    
    const imagePath = `/uploads/promo_slides/${req.file.filename}`;
    
    db.prepare(`
      INSERT INTO promo_slides (title, description, image_path, url, open_in_new_tab, sort_order, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0
    );
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil ditambahkan' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/update', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    const slideId = Number(req.params.id);
    
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    if (!slide) throw new Error('Slide tidak ditemukan');
    
    let imagePath = slide.image_path;
    let oldImagePath = null;
    
    if (req.file) {
      oldImagePath = slide.image_path;
      imagePath = `/uploads/promo_slides/${req.file.filename}`;
    }
    
    db.prepare(`
      UPDATE promo_slides SET 
        title = ?, description = ?, image_path = ?, url = ?, 
        open_in_new_tab = ?, sort_order = ?, start_date = ?, end_date = ?, is_active = ?,
        updated_at = NOW_LOCAL()
      WHERE id = ?
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0,
      slideId
    );
    
    // Cleanup old image file if new one was uploaded
    if (oldImagePath && oldImagePath !== imagePath) {
      const oldFilePath = path.resolve(__dirname, '..', 'public', oldImagePath);
      try {
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
          logger.info(`[PromoSlides] Deleted old image: ${oldFilePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete old image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil diperbarui' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/delete', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slideId = Number(req.params.id);
    
    // Get slide data to retrieve image path for cleanup
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    
    // Delete from database
    db.prepare('DELETE FROM promo_slides WHERE id = ?').run(slideId);
    
    // Cleanup image file
    if (slide && slide.image_path) {
      const filePath = path.resolve(__dirname, '..', 'public', slide.image_path);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.info(`[PromoSlides] Deleted image: ${filePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil dihapus' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/routers', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.createRouter(req.body);
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Router berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    req.session._msg = { type: 'success', text: 'Router berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.get('/api/routers/:id/test', requireAdmin, async (req, res) => {
  try {
    const conn = await mikrotikService.getConnection(req.params.id);
    if (conn && conn.api) {
      conn.api.close();
      return res.json({ success: true, message: 'Koneksi ke Router Berhasil!' });
    }
    throw new Error('Gagal terhubung ke router');
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/routers/:id/details', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.id;
    const routerConfig = mikrotikService.getRouterById(routerId);
    if (!routerConfig) return res.status(404).json({ success: false, error: 'Router tidak ditemukan' });

    let liveData = {
      connected: false,
      identity: routerConfig.name || 'MikroTik',
      version: '-',
      boardName: '-',
      cpuLoad: 0,
      freeMemory: 0,
      totalMemory: 0,
      freeHdd: 0,
      totalHdd: 0,
      uptime: '-',
      architecture: '-',
      cpuCount: 1,
      cpuFrequency: 0,
      activePppoe: 0,
      activeHotspot: 0,
      customersCount: 0,
      error: null
    };

    try {
      const allRouters = mikrotikService.getAllRouters();
      const firstRouter = allRouters && allRouters.length > 0 ? allRouters[0] : null;
      let countRes;
      if (firstRouter && Number(firstRouter.id) === Number(routerId)) {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ? OR router_id IS NULL OR router_id = 0').get(routerId);
      } else {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ?').get(routerId);
      }
      liveData.customersCount = countRes ? countRes.total : 0;
    } catch (e) {
      liveData.customersCount = 0;
    }

    try {
      const resource = await mikrotikService.getSystemResource(routerId);
      if (resource) {
        liveData.connected = true;
        liveData.cpuLoad = parseInt(resource['cpu-load'] || resource.cpuLoad || 0);
        liveData.freeMemory = parseInt(resource['free-memory'] || resource.freeMemory || 0);
        liveData.totalMemory = parseInt(resource['total-memory'] || resource.totalMemory || 0);
        liveData.freeHdd = parseInt(resource['free-hdd-space'] || resource.freeHddSpace || 0);
        liveData.totalHdd = parseInt(resource['total-hdd-space'] || resource.totalHddSpace || 0);
        liveData.version = resource.version || '-';
        liveData.boardName = resource['board-name'] || resource.boardName || '-';
        liveData.uptime = resource.uptime || '-';
        liveData.architecture = resource['architecture-name'] || resource.architectureName || '-';
        liveData.cpuCount = resource['cpu-count'] || resource.cpuCount || 1;
        liveData.cpuFrequency = resource['cpu-frequency'] || resource.cpuFrequency || 0;
      }

      try {
        const identity = await mikrotikService.getSystemIdentity(routerId);
        if (identity) liveData.identity = identity;
      } catch (e) {}

      try {
        const activePpp = await mikrotikService.getPppoeActive(routerId);
        liveData.activePppoe = activePpp ? activePpp.length : 0;
        liveData.activePppoeList = Array.isArray(activePpp) ? activePpp.slice(0, 50).map(s => ({
          name: s.name || s['name'] || '-',
          address: s.address || s['address'] || '-',
          uptime: s.uptime || s['uptime'] || '-',
          callerId: s['caller-id'] || s.callerId || '-'
        })) : [];
      } catch (e) {
        liveData.activePppoeList = [];
      }

      try {
        const activeHs = await mikrotikService.getHotspotActive(routerId);
        liveData.activeHotspot = activeHs ? activeHs.length : 0;
        liveData.activeHotspotList = Array.isArray(activeHs) ? activeHs.slice(0, 50).map(h => ({
          user: h.user || h['user'] || '-',
          address: h.address || h['address'] || '-',
          mac: h['mac-address'] || h.mac || '-',
          uptime: h.uptime || h['uptime'] || '-'
        })) : [];
      } catch (e) {
        liveData.activeHotspotList = [];
      }

    } catch (e) {
      liveData.connected = false;
      liveData.error = e.message;
    }

    res.json({ success: true, router: routerConfig, live: liveData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/routers/:id/setup-firewall', requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.setupIsolirFirewall(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/isolir-portal-script', requireAdmin, async (req, res) => {
  try {
    const data = await mikrotikService.generateIsolirPortalScript();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/system/update', requireAdmin, async (req, res) => {
  const { exec } = require('child_process');
  const path = require('path');
  const projectDir = path.join(__dirname, '..');
  const isWindows = process.platform === 'win32';

  const cmd = isWindows 
    ? 'git pull origin main || git pull' 
    : 'nice -n 19 bash update.sh';

  logger.info(`[System Update] Admin initiated 1-Click System Update.`);

  exec(cmd, { cwd: projectDir, timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      logger.error(`[System Update Error]: ${error.message}`);
      return res.json({ success: false, message: 'Gagal update: ' + error.message, output: stderr || stdout });
    }
    logger.info(`[System Update Complete]: ${stdout}`);
    return res.json({ 
      success: true, 
      message: 'Pembaruan aplikasi berhasil diterapkan (Low-CPU Mode)!', 
      output: stdout || 'Git pull & reload berhasil.' 
    });
  });
});

router.get('/api/mikrotik/profiles/:routerId', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.params.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.routerId ? Number(req.params.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─── ATTENDANCE MANAGEMENT ───────────────────────────────────────────────────

// Attendance dashboard
router.get('/attendance', requireAdminSession, requireSidebarMenuAccess('attendance'), (req, res) => {
  try {
    const date = req.query.date || getNowLocal().split(' ')[0];
    const attendances = attendanceSvc.getAttendanceByDate(date);
    const stats = attendanceSvc.getAttendanceStats(date);
    const lateCheckIns = attendanceSvc.getLateCheckIns(date);
    const notCheckedOut = attendanceSvc.getNotCheckedOut(date);
    
    res.render('admin/attendance', {
      title: 'Manajemen Absensi',
      company: company(),
      activePage: 'attendance',
      session: req.session,
      attendances,
      stats,
      lateCheckIns,
      notCheckedOut,
      selectedDate: date,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat data absensi: ' + e.message };
    res.redirect('/admin');
  }
});

// Get attendance by date range (API)
router.get('/api/attendance/range', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ success: false, message: 'Start date dan end date wajib diisi' });
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    res.json({ success: true, data: attendances });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get employee attendance history
router.get('/api/attendance/employee/:type/:id', requireAdminSession, (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory(type, parseInt(id), limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get monthly summary
router.get('/api/attendance/summary/:type/:id/:year/:month', requireAdminSession, (req, res) => {
  try {
    const { type, id, year, month } = req.params;
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      type, 
      parseInt(id), 
      parseInt(year), 
      parseInt(month)
    );
    res.json({ success: true, data: summary });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Update attendance (admin correction)
router.post('/attendance/:id/update', requireAdminSession, express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { check_in_time, check_in_note, check_out_time, check_out_note } = req.body;
    
    // Calculate duration if both times provided
    let duration = 0;
    if (check_in_time && check_out_time) {
      const checkIn = parseDateInTimezone(check_in_time);
      const checkOut = parseDateInTimezone(check_out_time);
      if (checkIn && checkOut) {
        duration = Math.floor((checkOut - checkIn) / 1000 / 60);
      }
    }
    
    attendanceSvc.updateAttendance(parseInt(id), {
      check_in_time,
      check_in_note: check_in_note || '',
      check_out_time: check_out_time || null,
      check_out_note: check_out_note || '',
      work_duration_minutes: duration
    });
    
    auditSvc.log('admin', req.session.username || 'admin', 'update_attendance', `Updated attendance #${id}`);
    res.json({ success: true, message: 'Absensi berhasil diperbarui' });
  } catch (e) {
    res.json({ success: false, message: 'Gagal update absensi: ' + e.message });
  }
});

// Delete attendance
router.post('/attendance/:id/delete', requireAdminSession, (req, res) => {
  try {
    const { id } = req.params;
    attendanceSvc.deleteAttendance(parseInt(id));
    auditSvc.log('admin', req.session.username || 'admin', 'delete_attendance', `Deleted attendance #${id}`);
    req.session._msg = { type: 'success', text: 'Absensi berhasil dihapus' };
    res.redirect('/admin/attendance');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus absensi: ' + e.message };
    res.redirect('/admin/attendance');
  }
});

// Export attendance to Excel
router.get('/attendance/export', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      req.session._msg = { type: 'error', text: 'Tanggal mulai dan akhir wajib diisi' };
      return res.redirect('/admin/attendance');
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    
    // Prepare data for Excel
    const data = attendances.map(a => ({
      'ID': a.id,
      'Tipe Karyawan': a.employee_type,
      'Nama': a.employee_name,
      'Check In': a.check_in_time,
      'Lokasi Check In': a.check_in_lat && a.check_in_lng ? `${a.check_in_lat}, ${a.check_in_lng}` : '-',
      'Catatan Check In': a.check_in_note || '-',
      'Foto Check In': a.check_in_photo || '-',
      'Check Out': a.check_out_time || '-',
      'Lokasi Check Out': a.check_out_lat && a.check_out_lng ? `${a.check_out_lat}, ${a.check_out_lng}` : '-',
      'Catatan Check Out': a.check_out_note || '-',
      'Foto Check Out': a.check_out_photo || '-',
      'Durasi (menit)': a.work_duration_minutes || 0,
      'Status': a.status
    }));
    
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Absensi');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename=absensi_${startDate}_${endDate}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal export: ' + e.message };
    res.redirect('/admin/attendance');
  }
});


// ─── PAYROLL / GAJI KARYAWAN ───────────────────────────────────────────────

router.get('/payroll', requireAdmin, requireSidebarMenuAccess('payroll'), (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();

  const employees = payrollSvc.getAllEmployees();
  const slips = payrollSvc.getSlipsByPeriod(month, year);
  const summary = payrollSvc.getPayrollSummary(month, year);

  res.render('admin/payroll', {
    title: 'Gaji Karyawan',
    company: company(),
    employees,
    slips,
    summary,
    selectedMonth: month,
    selectedYear: year,
    msg: req.session._msg || null
  });
  req.session._msg = null;
});

router.post('/payroll/settings', requireAdmin, (req, res) => {
  try {
    payrollSvc.upsertPayrollSetting(req.body);
    req.session._msg = { type: 'success', text: 'Pengaturan gaji berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/payroll');
});

router.post('/payroll/generate', requireAdmin, (req, res) => {
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  if (!month || !year) {
    req.session._msg = { type: 'error', text: 'Bulan dan tahun diperlukan' };
    return res.redirect('/admin/payroll');
  }

  const result = payrollSvc.generateAllSlips(month, year);
  req.session._msg = { 
    type: 'success', 
    text: `Generate selesai: ${result.generated} berhasil, ${result.skipped} dilewati, ${result.errors.length} error.` 
  };
  res.redirect(`/admin/payroll?month=${month}&year=${year}`);
});

router.post('/payroll/slip/:id/deduction', requireAdmin, express.json(), (req, res) => {
  try {
    const { other_deduction, other_deduction_note } = req.body;
    payrollSvc.updateSlipDeductions(req.params.id, other_deduction, other_deduction_note);
    res.json({ success: true, message: 'Potongan diperbarui' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.post('/payroll/slip/:id/approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.approveSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.markSlipPaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip ditandai lunas (paid).' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/delete', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkApprove(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkMarkPaid(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip approved ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/delete-drafts', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlipsByPeriod(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.get('/payroll/slip/:id/print', requireAdmin, (req, res) => {
  const slip = payrollSvc.getSlipById(req.params.id);
  if (!slip) return res.status(404).send('Slip tidak ditemukan');
  
  res.render('admin/print_payslip', {
    company: company(),
    slip
  });
});

router.post('/payroll/slip/:id/send-wa', requireAdmin, async (req, res) => {
  try {
    const slip = payrollSvc.getSlipById(req.params.id);
    if (!slip) throw new Error('Slip tidak ditemukan');
    
    const phone = payrollSvc.getEmployeePhone(slip.employee_type, slip.employee_id);
    if (!phone) throw new Error('Nomor HP karyawan tidak diset');

    const { getSettingsWithCache } = require('../config/settingsManager');
    const settings = getSettingsWithCache();
    if (!settings.whatsapp_enabled) throw new Error('WhatsApp bot tidak aktif');

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('WhatsApp bot tidak terkoneksi');
    }

    const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    
    const msg = `🧾 *SLIP GAJI KARYAWAN*\n\n` +
      `👤 *Nama:* ${slip.employee_name}\n` +
      `📅 *Periode:* ${monthNames[slip.period_month]} ${slip.period_year}\n` +
      `🏢 *Status:* ${slip.status.toUpperCase()}\n\n` +
      `*PENDAPATAN:*\n` +
      `- Gaji Pokok: Rp ${slip.base_salary.toLocaleString('id-ID')}\n` +
      (slip.transport_allowance ? `- Tunj. Transport: Rp ${slip.transport_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.meal_allowance ? `- Tunj. Makan: Rp ${slip.meal_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.phone_allowance ? `- Tunj. Pulsa: Rp ${slip.phone_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.other_allowance ? `- Tunj. Lain: Rp ${slip.other_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.ticket_bonus ? `- Bonus Tiket: +Rp ${slip.ticket_bonus.toLocaleString('id-ID')}\n` : '') +
      (slip.collection_commission ? `- Komisi Tagihan: +Rp ${slip.collection_commission.toLocaleString('id-ID')}\n` : '') +
      (slip.overtime_bonus ? `- Lembur: +Rp ${slip.overtime_bonus.toLocaleString('id-ID')}\n` : '') +
      `*Total Pendapatan: Rp ${slip.gross_salary.toLocaleString('id-ID')}*\n\n` +
      `*POTONGAN:*\n` +
      (slip.absence_deduction ? `- Potongan Absen: -Rp ${slip.absence_deduction.toLocaleString('id-ID')}\n` : '') +
      (slip.late_deduction ? `- Potongan Terlambat: -Rp ${slip.late_deduction.toLocaleString('id-ID')}\n` : '') +
      (slip.other_deduction ? `- Potongan Lain: -Rp ${slip.other_deduction.toLocaleString('id-ID')}\n` : '') +
      `*Total Potongan: Rp ${slip.total_deductions.toLocaleString('id-ID')}*\n\n` +
      `💰 *GAJI BERSIH: Rp ${slip.net_salary.toLocaleString('id-ID')}*\n\n` +
      `Terima kasih atas kerja keras Anda! 🙏`;

    await sendWA(phone, msg);
    res.json({ success: true, message: 'Terkirim' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.use('/acs', acsPortal);

// Mount Finance Portal
router.use('/finance', require('./financePortal'));
// ─── ONU PROVISION ─────────────────────────────────────────────────────────
const onuProvisionSvc = require('../services/onuProvisionService');

router.get('/onu-provision', requireAdminSession, restrictToAdmin, (req, res) => {
  const oltConfig = {
    vendor: getSetting('olt_vendor', ''),
    host: getSetting('olt_host', ''),
    port: getSetting('olt_port', 22),
    username: getSetting('olt_username', ''),
    password: getSetting('olt_password', '')
  };
  
  res.render('admin/onu_provision', {
    title: 'ONU Provision',
    company: company(),
    activePage: 'onu_provision',
    msg: flashMsg(req),
    oltConfig,
    lang: req.session?.lang || 'id'
  });
});

router.post('/onu-provision/configure-olt', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { vendor, host, port, username, password, action } = req.body;
    
    if (action === 'test') {
      // Test connection
      const oltConfig = { vendor, host, port: parseInt(port), username, password };
      
      try {
        const conn = await onuProvisionSvc.connectSSH(oltConfig);
        conn.end();
        req.session._msg = { type: 'success', text: `Koneksi ke OLT ${vendor} berhasil!` };
      } catch (error) {
        req.session._msg = { type: 'error', text: `Gagal koneksi: ${error.message}` };
      }
    } else if (action === 'save') {
      // Save configuration
      const currentSettings = getSettings();
      const success = saveSettings({
        ...currentSettings,
        olt_vendor: vendor,
        olt_host: host,
        olt_port: parseInt(port),
        olt_username: username,
        olt_password: password
      });
      
      if (success) {
        req.session._msg = { type: 'success', text: 'Konfigurasi OLT berhasil disimpan.' };
      } else {
        req.session._msg = { type: 'error', text: 'Gagal menyimpan konfigurasi OLT.' };
      }
    }
  } catch (error) {
    req.session._msg = { type: 'error', text: 'Error: ' + error.message };
  }
  
  res.redirect('/admin/onu-provision');
});

router.post('/onu-provision/scan-unconfigured', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    if (!oltConfig.host) {
      return res.json({ success: false, error: 'OLT belum dikonfigurasi' });
    }
    
    let onus = [];
    
    if (oltConfig.vendor === 'ZTE') {
      const { pon } = req.body;
      if (!pon) {
        return res.json({ success: false, error: 'PON interface harus diisi' });
      }
      onus = await onuProvisionSvc.zteGetUnconfiguredONUs(oltConfig, pon);
    } else if (oltConfig.vendor === 'Huawei') {
      const { frame, slot, pon } = req.body;
      onus = await onuProvisionSvc.huaweiGetUnconfiguredONUs(oltConfig, frame, slot, pon);
    } else if (oltConfig.vendor === 'HSGQ' || oltConfig.vendor === 'Hioso') {
      const { pon } = req.body;
      if (!pon) {
        return res.json({ success: false, error: 'PON interface harus diisi' });
      }
      onus = await onuProvisionSvc.hsgqGetUnconfiguredONUs(oltConfig, pon);
    } else {
      return res.json({ success: false, error: 'Vendor OLT tidak didukung untuk scanning otomatis' });
    }
    
    res.json({ success: true, onus });
  } catch (error) {
    logger.error('Scan unconfigured ONUs error:', error);
    res.json({ success: false, error: error.message });
  }
});

router.post('/onu-provision/scan-configured', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const host = getSetting('olt_host', '');
    if (!host) {
      return res.json({ success: false, error: 'OLT belum dikonfigurasi di pengaturan global' });
    }
    
    const olt = db.prepare('SELECT * FROM olts WHERE host = ? LIMIT 1').get(host);
    if (!olt) {
      return res.json({ 
        success: false, 
        error: 'OLT dengan IP ' + host + ' belum didaftarkan di halaman "Manajemen OLT". Silakan daftarkan OLT Anda di sana terlebih dahulu agar sistem dapat membaca data monitoring SNMP.' 
      });
    }
    
    const oltSvc = require('../services/oltService');
    const stats = await oltSvc.getOltStats(olt.id, true);
    
    res.json({ success: true, onus: stats.onus || [], oltId: olt.id });
  } catch (error) {
    logger.error('Scan configured ONUs error:', error);
    res.json({ success: false, error: error.message });
  }
});

router.post('/onu-provision/provision', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    if (!oltConfig.host) {
      throw new Error('OLT belum dikonfigurasi');
    }
    
    const { vendor, createMikrotikPPPoE, mikrotikPppoeUsername, mikrotikPppoePassword, mikrotikProfile } = req.body;
    let result;
    let messages = [];
    
    // Check if need to create MikroTik PPPoE
    if (createMikrotikPPPoE === 'on' && mikrotikPppoeUsername && mikrotikPppoePassword) {
      // Validate PPPoE username not already in use
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const existingCustomer = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId, mikrotikPppoeUsername);
      
      if (existingCustomer) {
        throw new Error(`PPPoE Username "${mikrotikPppoeUsername}" sudah digunakan oleh pelanggan: ${existingCustomer.name}`);
      }
      
      // Use full provision with MikroTik integration
      const mikrotikConfig = {
        host: getSetting('mikrotik_host', ''),
        user: getSetting('mikrotik_user', ''),
        password: getSetting('mikrotik_password', ''),
        port: getSetting('mikrotik_port', 8728)
      };
      
      if (mikrotikConfig.host) {
        // Prepare params for full provision
        const provisionParams = {
          ...req.body,
          pppoeUsername: mikrotikPppoeUsername,
          pppoePassword: mikrotikPppoePassword,
          bandwidth: mikrotikProfile || req.body.bandwidth
        };
        
        result = await onuProvisionSvc.fullProvision(oltConfig, mikrotikConfig, provisionParams);
        
        if (result.results.onu) {
          messages.push(`✅ ONU ${req.body.name} berhasil di-provision`);
        }
        if (result.results.pppoe) {
          messages.push(`✅ PPPoE ${mikrotikPppoeUsername} berhasil dibuat di MikroTik`);
        }
        if (result.results.errors && result.results.errors.length > 0) {
          messages.push(`⚠️ ${result.results.errors.join(', ')}`);
        }
      } else {
        throw new Error('MikroTik belum dikonfigurasi di settings');
      }
    } else {
      // Standard provision (ONU only)
      if (vendor === 'ZTE') {
        result = await onuProvisionSvc.zteProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Huawei') {
        result = await onuProvisionSvc.huaweiProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Fiberhome') {
        result = await onuProvisionSvc.fiberhomeProvisionONU(oltConfig, req.body);
      } else if (vendor === 'VSOL') {
        result = await onuProvisionSvc.vsolProvisionONU(oltConfig, req.body);
      } else if (vendor === 'CData') {
        result = await onuProvisionSvc.cdataProvisionONU(oltConfig, req.body);
      } else if (vendor === 'HSGQ') {
        result = await onuProvisionSvc.hsgqProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Hioso') {
        result = await onuProvisionSvc.hiosoProvisionONU(oltConfig, req.body);
      } else {
        throw new Error('Vendor tidak didukung');
      }
      
      messages.push(`✅ ONU ${req.body.name} berhasil di-provision`);
    }
    
    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'CREATE',
        entity_type: 'onu_provision',
        entity_id: req.body.sn,
        actor_type: 'admin',
        actor_id: String(req.session?.adminUser || ''),
        actor_name: req.session?.adminUser || 'Admin',
        details: {
          vendor,
          params: req.body,
          mikrotikIntegration: createMikrotikPPPoE === 'on'
        },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }
    
    req.session._msg = { type: 'success', text: messages.join(' | ') };
  } catch (error) {
    logger.error('Provision ONU error:', error);
    req.session._msg = { type: 'error', text: 'Gagal provision ONU: ' + error.message };
  }
  
  res.redirect('/admin/onu-provision');
});

router.post('/onu-provision/delete', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    const { vendor, params } = req.body;
    const result = await onuProvisionSvc.deleteONU(oltConfig, vendor, params);
    
    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'DELETE',
        entity_type: 'onu_provision',
        entity_id: params.sn || 'unknown',
        actor_type: 'admin',
        actor_id: String(req.session?.adminUser || ''),
        actor_name: req.session?.adminUser || 'Admin',
        details: { vendor, params },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }
    
    res.json({ success: true, message: result.message });
  } catch (error) {
    logger.error('Delete ONU error:', error);
    res.json({ success: false, error: error.message });
  }
});

// --- RADIUS SERVER MANAGEMENT ---
const radiusSvc = require('../services/radiusServerService');

router.get('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const radiusStatus = radiusSvc.getStatus();
    const onlineSessions = radiusSvc.getOnlineSessions();
    const acctLogs = radiusSvc.getAccountingLogs(100);
    const nasList = db.prepare(`SELECT * FROM radius_nas ORDER BY id DESC`).all() || [];

    const todayStats = db.prepare(`
      SELECT 
        COUNT(1) as total_events,
        COALESCE(SUM(input_octets + output_octets), 0) as total_bytes
      FROM radius_accounting
      WHERE DATE(created_at) = DATE('now')
    `).get() || { total_events: 0, total_bytes: 0 };

    const todayTrafficMB = (todayStats.total_bytes / (1024 * 1024)).toFixed(1);
    const todayEvents = todayStats.total_events;

    const msg = req.session._msg || null;
    req.session._msg = null;

    res.render('admin/radius-settings', {
      title: 'Pengaturan RADIUS',
      company: company(),
      activePage: 'radius_settings',
      session: req.session,
      radiusStatus,
      onlineSessions,
      acctLogs,
      nasList,
      todayTrafficMB,
      todayEvents,
      msg
    });
  } catch (error) {
    logger.error('Error rendering RADIUS settings page:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

router.post('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const {
      radius_enabled,
      radius_secret,
      radius_auth_port,
      radius_acct_port,
      radius_isolir_action,
      radius_isolir_pool,
      radius_isolir_rate_limit,
      radius_isolir_ip_pool_enabled,
      radius_isolir_ip_pool_start,
      radius_isolir_ip_pool_end,
      radius_limit_simultaneous,
      radius_default_rate_limit,
      radius_ip_pool_enabled,
      radius_ip_pool_start,
      radius_ip_pool_end,
      radius_framed_pool
    } = req.body;

    saveSettings({
      radius_enabled: radius_enabled === '1' ? '1' : '0',
      radius_secret: String(radius_secret || 'secret123').trim(),
      radius_auth_port: String(radius_auth_port || '1812').trim(),
      radius_acct_port: String(radius_acct_port || '1813').trim(),
      radius_isolir_action: String(radius_isolir_action || 'pool').trim(),
      radius_isolir_pool: String(radius_isolir_pool || 'isolir').trim(),
      radius_isolir_rate_limit: String(radius_isolir_rate_limit || '512k/512k').trim(),
      radius_isolir_ip_pool_enabled: radius_isolir_ip_pool_enabled === '1' ? '1' : '0',
      radius_isolir_ip_pool_start: String(radius_isolir_ip_pool_start || '10.10.99.2').trim(),
      radius_isolir_ip_pool_end: String(radius_isolir_ip_pool_end || '10.10.99.254').trim(),
      radius_limit_simultaneous: radius_limit_simultaneous === '1' ? '1' : '0',
      radius_default_rate_limit: String(radius_default_rate_limit || '5M/10M').trim(),
      radius_ip_pool_enabled: radius_ip_pool_enabled === '1' ? '1' : '0',
      radius_ip_pool_start: String(radius_ip_pool_start || '10.10.10.2').trim(),
      radius_ip_pool_end: String(radius_ip_pool_end || '10.10.10.254').trim(),
      radius_framed_pool: String(radius_framed_pool || 'pool-pppoe').trim()
    });

    // Kontrol background service UDP RADIUS
    radiusSvc.stop();
    if (radius_enabled === '1') {
      radiusSvc.start();
    }

    req.session._msg = { type: 'success', text: 'Pengaturan RADIUS Server berhasil diperbarui.' };
  } catch (error) {
    logger.error('Error saving RADIUS settings:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan pengaturan: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/disconnect', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { username, session_id, nas_ip } = req.body;
    if (!username) throw new Error('Username tidak boleh kosong');

    await radiusSvc.disconnectSession(username, session_id, nas_ip);
    req.session._msg = { type: 'success', text: `Sesi aktif RADIUS untuk user "${username}" berhasil diputus.` };
  } catch (e) {
    logger.error('Error disconnecting RADIUS session:', e);
    req.session._msg = { type: 'danger', text: 'Gagal memutus sesi RADIUS: ' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/restart', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    radiusSvc.stop();
    await new Promise(r => setTimeout(r, 500));
    radiusSvc.start();
    req.session._msg = { type: 'success', text: 'Layanan RADIUS Server (UDP Port 1812/1813) berhasil direstart.' };
  } catch (e) {
    logger.error('Error restarting RADIUS service:', e);
    req.session._msg = { type: 'danger', text: 'Gagal merestart layanan RADIUS: ' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/add', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { nasname, shortname, secret, description } = req.body;
    if (!nasname || !secret) {
      throw new Error('IP NAS & Shared Secret wajib diisi.');
    }

    db.prepare(`
      INSERT INTO radius_nas (nasname, shortname, secret, description, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(nasname) DO UPDATE SET
        shortname = excluded.shortname,
        secret = excluded.secret,
        description = excluded.description,
        is_active = 1
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim()
    );

    req.session._msg = { type: 'success', text: `NAS ${nasname} berhasil ditambahkan.` };
  } catch (error) {
    logger.error('Error adding NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menambah NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/edit', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id, nasname, shortname, secret, description, is_active } = req.body;
    if (!id || !nasname || !secret) {
      throw new Error('ID, IP NAS & Shared Secret wajib diisi.');
    }

    db.prepare(`
      UPDATE radius_nas
      SET nasname = ?, shortname = ?, secret = ?, description = ?, is_active = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim(),
      is_active === '1' || is_active === 1 ? 1 : 0,
      id
    );

    req.session._msg = { type: 'success', text: `Data NAS ${nasname} berhasil diperbarui.` };
  } catch (error) {
    logger.error('Error updating NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal memperbarui NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/toggle', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    const nas = db.prepare(`SELECT id, nasname, is_active FROM radius_nas WHERE id = ?`).get(id);
    if (nas) {
      const newStatus = nas.is_active ? 0 : 1;
      db.prepare(`UPDATE radius_nas SET is_active = ?, updated_at = (NOW_LOCAL()) WHERE id = ?`).run(newStatus, id);
      req.session._msg = { type: 'success', text: `Status NAS ${nas.nasname} diubah menjadi ${newStatus ? 'Aktif' : 'Non-Aktif'}.` };
    }
  } catch (error) {
    logger.error('Error toggling NAS status:', error);
    req.session._msg = { type: 'danger', text: 'Gagal mengubah status NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/delete', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    db.prepare(`DELETE FROM radius_nas WHERE id = ?`).run(id);
    req.session._msg = { type: 'success', text: 'NAS Client berhasil dihapus.' };
  } catch (error) {
    logger.error('Error deleting NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menghapus NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

module.exports = router;
