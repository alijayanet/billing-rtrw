import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const QRCodeNode = require('qrcode');
const { logger } = require('../config/logger.js');
const { getSetting, getNowLocal, formatDateLocal, getCurrentDateInTimezone } = require('../config/settingsManager.js');
const db = require('../config/database.js');
const customerDevice = require('./customerDeviceService.js');
const { WaLidStore } = require('./waLidStore.js');
const billingSvc = require('./billingService.js');
const mikrotikSvc = require('./mikrotikService.js');
const customerSvc = require('./customerService.js');
const agentSvc = require('./agentService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Cache Retry Counter untuk Baileys Signal Enkripsi (Mencegah "Waiting for this message" / Pesan tidak terbaca)
class SimpleRetryCache {
  constructor(ttlMs = 600000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }
  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.time > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return item.val;
  }
  set(key, val) {
    this.cache.set(key, { val, time: Date.now() });
  }
  del(key) {
    this.cache.delete(key);
  }
}
const msgRetryCounterCache = new SimpleRetryCache();

const sentMessageMap = new Map();
function cacheSentMessage(key, message) {
  if (!key || !key.id || !message) return;
  const storeKey = `${key.remoteJid || ''}:${key.id}`;
  sentMessageMap.set(storeKey, message);
  if (sentMessageMap.size > 2000) {
    const firstKey = sentMessageMap.keys().next().value;
    sentMessageMap.delete(firstKey);
  }
}

// Rate Limiting untuk WhatsApp Bot Self-Service
const rateLimitStore = new Map(); // Format: { phone: { count: 0, lastReset: timestamp } }
const MAX_COMMANDS_PER_MINUTE = 10;
const COMMAND_COOLDOWN_MS = 2000; // 2 detik cooldown antar perintah
const commandCooldownStore = new Map(); // Format: { phone: lastCommandTimestamp }

function checkRateLimit(phone) {
  const now = Date.now();
  const userLimit = rateLimitStore.get(phone);

  if (!userLimit) {
    rateLimitStore.set(phone, { count: 1, lastReset: now });
    return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - 1 };
  }

  // Reset counter setiap menit
  if (now - userLimit.lastReset >= 60000) {
    rateLimitStore.set(phone, { count: 1, lastReset: now });
    return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - 1 };
  }

  // Cek limit
  if (userLimit.count >= MAX_COMMANDS_PER_MINUTE) {
    const resetTime = userLimit.lastReset + 60000;
    const waitTime = Math.ceil((resetTime - now) / 1000);
    return { allowed: false, waitTime };
  }

  // Increment counter
  userLimit.count++;
  return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - userLimit.count };
}

function checkCommandCooldown(phone) {
  const now = Date.now();
  const lastCommand = commandCooldownStore.get(phone);

  if (!lastCommand) {
    commandCooldownStore.set(phone, now);
    return { allowed: true };
  }

  const elapsed = now - lastCommand;
  if (elapsed < COMMAND_COOLDOWN_MS) {
    const waitTime = Math.ceil((COMMAND_COOLDOWN_MS - elapsed) / 1000);
    return { allowed: false, waitTime };
  }

  commandCooldownStore.set(phone, now);
  return { allowed: true };
}

function getPhoneFromKey(key) {
  if (!key) return null;
  const remoteJid = key.remoteJid || key;
  if (!remoteJid) return null;

  // If remoteJid is @lid, try resolving from lidStore or senderPn
  if (typeof remoteJid === 'string' && remoteJid.endsWith('@lid')) {
    try {
      const lidStore = getDefaultLidStore();
      if (lidStore) {
        const mapped = lidStore.get(remoteJid) || lidStore.get(remoteJid.split('@')[0]);
        if (mapped) {
          let p = String(mapped).replace(/\D/g, '');
          if (p.startsWith('0')) p = '62' + p.slice(1);
          else if (!p.startsWith('62')) p = '62' + p;
          return p;
        }
      }
    } catch (_) {}
    if (key.senderPn && key.senderPn.endsWith('@s.whatsapp.net')) {
      let p = key.senderPn.split('@')[0].replace(/\D/g, '');
      if (p.startsWith('0')) p = '62' + p.slice(1);
      else if (!p.startsWith('62')) p = '62' + p;
      return p;
    }
  }

  // Extract phone number from JID
  const [user, host] = remoteJid.split('@');
  if (!user || !host) return null;

  // Remove non-digits
  const phone = user.replace(/\D/g, '');
  if (!phone) return null;

  // Convert 0 to 62
  if (phone.startsWith('0')) {
    return '62' + phone.slice(1);
  }

  return phone;
}

function waBrand() {
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  const sep = '─'.repeat(30);
  return { companyHeader, footerInfo, sep };
}

function waWrap(title, body) {
  const { companyHeader, footerInfo, sep } = waBrand();
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  const head = t ? `${t}\n${sep}\n🏢 *${companyHeader}*\n${sep}\n` : `🏢 *${companyHeader}*\n${sep}\n`;
  const foot = footerInfo ? `\n${sep}\n${footerInfo}` : '';
  return head + b + foot;
}

function waAutoWrap(text) {
  const { sep } = waBrand();
  const t = String(text || '').trim();
  if (!t) return t;
  if (t.includes(sep)) return t;
  return waWrap('', t);
}

function getMessageText(m) {
  const msg = m.message;
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  return '';
}

/** Field tambahan Baileys 6.7: senderPn = JID nomor, senderLid = JID @lid */
function normalizeKey(key) {
  if (!key) return {};
  return {
    remoteJid: key.remoteJid,
    senderPn: key.senderPn || null,
    senderLid: key.senderLid || null
  };
}

async function resolveCustomerTag(key, lidStore) {
  const { remoteJid, senderPn, senderLid } = normalizeKey(key);
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;

  const tryPnAndCache = async (pnJid, lidJid) => {
    const digits = customerDevice.phoneFromPnJid(pnJid);
    if (!digits) return null;

    // 1. Coba cari di Billing Database dulu
    const customer = customerSvc.findCustomerByAny(digits);
    if (customer && (customer.genieacs_tag || customer.pppoe_username)) {
      const tag = customer.genieacs_tag || customer.pppoe_username || digits;
      if (lidJid) lidStore.set(lidJid, tag);
      lidStore.set(pnJid, tag);
      return tag;
    }

    // 2. Fallback: Cari langsung di GenieACS (berdasarkan tag yang mirip nomor)
    const found = await customerDevice.findDeviceWithTagVariants(digits);
    if (!found) return null;
    if (lidJid) lidStore.set(lidJid, found.canonicalTag);
    lidStore.set(pnJid, found.canonicalTag);
    return found.canonicalTag;
  };

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const found = await tryPnAndCache(remoteJid, senderLid && senderLid.endsWith('@lid') ? senderLid : null);
    if (found) return found;
    return lidStore.get(remoteJid);
  }

  if (remoteJid.endsWith('@lid')) {
    const cached = lidStore.get(remoteJid);
    if (cached) return cached;
    if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
      return tryPnAndCache(senderPn, remoteJid);
    }
    return null;
  }

  return null;
}

async function resolveCustomerContext(key, lidStore) {
  const { remoteJid, senderPn, senderLid } = normalizeKey(key);
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;

  const pnDigits = senderPn && senderPn.endsWith('@s.whatsapp.net') ? customerDevice.phoneFromPnJid(senderPn) : null;
  const remoteDigits = remoteJid.endsWith('@s.whatsapp.net') ? customerDevice.phoneFromPnJid(remoteJid) : null;
  const digits = pnDigits || remoteDigits || null;

  const cached =
    (remoteJid.endsWith('@lid') && lidStore ? lidStore.get(remoteJid) : null) ||
    (senderLid && senderLid.endsWith('@lid') && lidStore ? lidStore.get(senderLid) : null) ||
    (senderPn && senderPn.endsWith('@s.whatsapp.net') && lidStore ? lidStore.get(senderPn) : null) ||
    (remoteJid.endsWith('@s.whatsapp.net') && lidStore ? lidStore.get(remoteJid) : null) ||
    null;

  let customer = null;
  if (digits) customer = customerSvc.findCustomerByAny(digits);
  if (!customer && cached) customer = customerSvc.findCustomerByAny(cached);

  let billingKey = digits || null;
  if (!billingKey && customer && customer.phone) billingKey = String(customer.phone);
  if (!billingKey && cached && /^\d+$/.test(String(cached))) billingKey = String(cached);

  let deviceKey =
    (customer && (customer.genieacs_tag || customer.pppoe_username) ? (customer.genieacs_tag || customer.pppoe_username) : null) ||
    cached ||
    digits ||
    null;

  if (!deviceKey) return null;

  if (digits && lidStore) {
    const tagToCache = (customer && (customer.genieacs_tag || customer.pppoe_username)) ? (customer.genieacs_tag || customer.pppoe_username) : deviceKey;
    const pnJid = senderPn && senderPn.endsWith('@s.whatsapp.net') ? senderPn : (remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null);
    const lidJid = remoteJid.endsWith('@lid') ? remoteJid : (senderLid && senderLid.endsWith('@lid') ? senderLid : null);
    if (pnJid) lidStore.set(pnJid, tagToCache);
    if (lidJid) lidStore.set(lidJid, tagToCache);
  }

  return { billingKey: billingKey || deviceKey, deviceKey };
}

function formatInfo(data) {
  if (!data) return waWrap('📡 *STATUS ONU*', '❌ Data perangkat tidak ditemukan di GenieACS.');

  const lines = [
    `🟢 *Status:* ${data.status}`,
    `📶 *SSID:* ${data.ssid}`,
    `⏱️ *Last Inform:* ${data.lastInform}`,
    `📡 *RX Power:* ${data.rxPower}`,
    `🌐 *PPPoE IP:* ${data.pppoeIP}`,
    `👤 *PPPoE User:* ${data.pppoeUsername}`,
    `⏳ *Uptime:* ${data.uptime}`,
    `⏳ *PPPoE Uptime:* ${data.pppoeUptime || '-'}`,
    `📱 *User WiFi (2.4G):* ${data.totalAssociations}`,
    `🔧 *Model:* ${data.model}`,
    `🏷️ *Serial Number:* ${data.serialNumber}`,
    `💾 *Firmware:* ${data.softwareVersion}`,
    `📍 *Tag:* ${data.lokasi}`
  ];
  return waWrap('📡 *STATUS ONU*', lines.join('\n'));
}

function formatCekTerhubung(data) {
  if (!data) return waWrap('👥 *PERANGKAT TERHUBUNG*', '❌ Data tidak tersedia.');
  const list = data.connectedUsers || [];

  if (list.length === 0) {
    return waWrap('👥 *PERANGKAT TERHUBUNG*', '⚠️ Tidak ada entri host/perangkat terhubung di data ONU.');
  }

  const content = `📊 *${list.length} perangkat tercatat:*\n`;
  const rows = list.slice(0, 25).map((u, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `${num}. 📱 ${u.hostname}\n   🌐 ${u.ip} | ${u.status}`;
  }).join('\n\n');
  const tail = list.length > 25 ? `\n\n_…dan ${list.length - 25} perangkat lainnya_` : '';
  return waWrap('👥 *PERANGKAT TERHUBUNG*', content + rows + tail);
}

function formatBillingSummary(stats) {
  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });

  return waWrap(
    '💰 *RINGKASAN BILLING*',
    `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
    `📅 *Bulan Ini:* ${formatter.format(stats.thisMonth)}\n` +
    `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
    `🧾 *Tagihan Belum Lunas:* ${stats.unpaidCount} invoice\n\n` +
    `💡 _Gunakan perintah lain untuk detail._`
  );
}

function formatCustomerInvoices(invoices, name) {
  const title = `🧾 *STATUS TAGIHAN*\n👤 *${name}*`;
  if (!invoices || invoices.length === 0) return waWrap(title, "✅ Tidak ada tagihan. Terima kasih!");

  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });

  const list = invoices.map(inv => {
    const status = inv.status === 'paid' ? '✅ LUNAS' : '❌ BELUM BAYAR';
    return `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n💰 *Total:* ${formatter.format(inv.amount)}\n📌 *Status:* ${status}\n🆔 *ID:* ${inv.id}`;
  }).join('\n\n');

  return waWrap(title, list + `\n\n💡 _Gunakan ID Tagihan saat konfirmasi pembayaran_`);
}

function formatActiveMikrotik(pppoe, hotspot) {
  const { sep } = waBrand();
  const p = `👥 *PPPoE Active:* ${pppoe.length} user\n` + pppoe.slice(0, 10).map(u => `  ◦ ${u.name} (${u.address})`).join('\n') + (pppoe.length > 10 ? '\n  _...dll_' : '');
  const h = `\n\n🔥 *Hotspot Active:* ${hotspot.length} user\n` + hotspot.slice(0, 10).map(u => `  ◦ ${u.user} (${u.address})`).join('\n') + (hotspot.length > 10 ? '\n  _...dll_' : '');
  return waWrap('🌐 *MIKROTIK ACTIVE*', p + h);
}

function parseNumbers(input) {
  if (Array.isArray(input)) return input.map(x => String(x).trim()).filter(Boolean);
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function getWhatsappAdminNumbers() {
  const primary = parseNumbers(getSetting('whatsapp_admin_numbers', []));
  const legacy = parseNumbers(getSetting('admins', []));
  const companyPhone = parseNumbers(getSetting('company_phone', ''));
  let dbAdmin = [];
  try {
    const raw = db.getAppSetting('whatsapp_admin_numbers', null) || db.getAppSetting('admins', null);
    if (raw) dbAdmin = parseNumbers(raw);
  } catch (e) {}

  const combined = Array.from(new Set([...primary, ...legacy, ...companyPhone, ...dbAdmin]));
  return combined;
}

function loadWhatsappAdminSet(lidStore) {
  const list = getWhatsappAdminNumbers();
  const set = new Set();
  for (const n of list) {
    const s = String(n).trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8) {
      for (const c of customerDevice.expandTagCandidates(digits)) {
        set.add(c);
      }
    } else if (s) {
      set.add(s);
    }
  }
  if (lidStore && typeof lidStore.getAll === 'function') {
    const storeMap = lidStore.getAll() || {};
    for (const [key, val] of Object.entries(storeMap)) {
      const valDigits = String(val || '').replace(/\D/g, '');
      if (valDigits) {
        for (const c of customerDevice.expandTagCandidates(valDigits)) {
          if (set.has(c)) {
            set.add(key);
            set.add(key.split('@')[0]);
          }
        }
      }
    }
  }
  return set;
}

/** Admin dikenali dari nomor WA (bukan @lid saja). Pakai senderPn atau remoteJid @s.whatsapp.net / @lid */
function isWhatsappAdminKey(key, adminSet, sock, lidStore) {
  if (sock && sock.user && sock.user.id) {
    const selfJid = sock.user.id.split(':')[0];
    const selfLid = sock.user.lid ? sock.user.lid.split('@')[0] : null;
    const nk = normalizeKey(key);
    const sender = nk.senderPn || nk.remoteJid;
    if (sender) {
      const senderUser = sender.split('@')[0];
      if (senderUser === selfJid || (selfLid && senderUser === selfLid)) {
        return true; // Pesan dari nomor bot sendiri (self-chat) selalu dianggap admin
      }
    }
  }
  if (!adminSet || adminSet.size === 0) return false;
  const nk = normalizeKey(key);
  
  // 1. Cek JID nomor HP langsung
  const pnJid =
    nk.senderPn && nk.senderPn.endsWith('@s.whatsapp.net')
      ? nk.senderPn
      : nk.remoteJid && nk.remoteJid.endsWith('@s.whatsapp.net')
        ? nk.remoteJid
        : null;

  let digits = null;
  if (pnJid) {
    digits = customerDevice.phoneFromPnJid(pnJid);
  }

  // 2. Cek jika LID JID
  if (nk.remoteJid && nk.remoteJid.endsWith('@lid')) {
    const lidUser = nk.remoteJid.split('@')[0];
    if (adminSet.has(nk.remoteJid) || adminSet.has(lidUser)) return true;
    if (lidStore) {
      const cachedTag = lidStore.get(nk.remoteJid) || lidStore.get(lidUser);
      if (cachedTag) {
        digits = String(cachedTag).replace(/\D/g, '');
      }
    }
  }

  if (!digits) return false;
  for (const c of customerDevice.expandTagCandidates(digits)) {
    if (adminSet.has(c)) return true;
  }
  return false;
}

function parseCommand(text, isAdmin) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  const rawFirst = parts[0];
  const cleanFirst = rawFirst.replace(/^[\/!#]/, '');
  const cmd = cleanFirst.toLowerCase();
  const rest = t.slice(rawFirst.length).trim();

  if (['menu', 'bantuan', 'help'].includes(cmd)) return { cmd: 'menu', rest: '' };

  if (isAdmin && ['admin', 'adminmenu', 'menuadmin'].includes(cmd)) return { cmd: 'adminmenu', rest: '' };

  if (isAdmin && ['listonu', 'listdevice', 'daftarperangkat'].includes(cmd)) {
    return { cmd: 'listonu', admin: true };
  }

  if (isAdmin && ['saldodigi', 'ceksaldodigi', 'digisaldo', 'ceksaldo.digi'].includes(cmd)) {
    return { cmd: 'digiflazz_balance', admin: true };
  }

  if (isAdmin && ['topup', 'topupagent', 'tfagent', 'transferagent', 'depositagent'].includes(cmd) && parts.length >= 3) {
    return { cmd: 'topupagent', admin: true, agentKey: parts[1], amount: parts[2], note: parts.slice(3).join(' ') };
  }

  // Admin Mikrotik
  if (isAdmin && cmd === 'mtactive') return { cmd: 'mtactive', admin: true };
  if (isAdmin && cmd === 'kickuser' && parts.length >= 2) return { cmd: 'kickuser', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'addpppoe' && parts.length >= 4) return { cmd: 'addpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'editpppoe' && parts.length >= 3) return { cmd: 'editpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'delpppoe' && parts.length >= 2) return { cmd: 'delpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'addhotspot' && parts.length >= 4) return { cmd: 'addhotspot', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'vcr' && parts.length >= 3) return { cmd: 'vcr', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'delhotspot' && parts.length >= 2) return { cmd: 'delhotspot', admin: true, args: parts.slice(1) };

  // Admin Billing & Pelanggan
  if (isAdmin && cmd === 'ringkasan') return { cmd: 'ringkasan', admin: true };
  if (isAdmin && cmd === 'lunas' && parts.length >= 2) return { cmd: 'lunas', admin: true, targetId: rest || parts.slice(1).join(' ') };
  if (isAdmin && cmd === 'generate' && parts.length >= 3) return { cmd: 'generate', admin: true, month: parts[1], year: parts[2] };
  if (isAdmin && cmd === 'isolir' && parts.length >= 2) return { cmd: 'isolir', admin: true, targetId: parts[1] };
  if (isAdmin && cmd === 'buka' && parts.length >= 2) return { cmd: 'buka', admin: true, targetId: parts[1] };

  if (isAdmin && ['info', 'cekstatus', 'cekonu', 'statusonu'].includes(cmd) && parts.length >= 2) {
    return { cmd: 'info', admin: true, targetTag: parts[1], rest: '' };
  }
  if (isAdmin && cmd === 'cekterhubung' && parts.length >= 2) {
    return { cmd: 'cekterhubung', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && (cmd === 'reboot' || cmd === 'restartonu') && parts.length >= 2) {
    return { cmd: 'reboot', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && cmd === 'gantissid' && parts.length >= 3) {
    return { cmd: 'gantissid', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }
  if (isAdmin && cmd === 'gantisandi' && parts.length >= 3) {
    return { cmd: 'gantisandi', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }

  if (['pulsa', 'belipulsa'].includes(cmd) && parts.length >= 3) {
    const sellPrice = parts.length >= 4 ? Number(String(parts[3]).replace(/[^\d]/g, '')) : 0;
    return { cmd: 'agent_pulsa', sku: parts[1], target: parts[2], sellPrice: Number.isFinite(sellPrice) ? sellPrice : 0 };
  }
  if (['cekpulsa', 'statuspulsa'].includes(cmd) && parts.length >= 2) {
    return { cmd: 'agent_pulsa_check', txId: parts[1] };
  }

  // Customer Commands
  if (['cektagihan', 'tagihan', 'cek_tagihan', 'bill', 'invoicewa'].includes(cmd)) return { cmd: 'cektagihan', rest: '' };
  if (['info', 'cekstatus', 'cekonu', 'statusonu', 'status'].includes(cmd)) return { cmd: 'info', rest: '' };
  if (cmd === 'cekterhubung') return { cmd: 'cekterhubung', rest: '' };
  if (cmd === 'gantissid') return { cmd: 'gantissid', rest };
  if (cmd === 'gantisandi') return { cmd: 'gantisandi', rest };
  if (cmd === 'daftar') return { cmd: 'daftar', rest };
  if (cmd === 'reboot' || cmd === 'restartonu') return { cmd: 'reboot', rest: '' };
  return null;
}

async function resolveTargetTagForAdmin(tagToken) {
  if (!tagToken) return null;

  // 1. Coba cari di database billing dulu (by name, pppoe, phone, etc)
  const cust = customerSvc.findCustomerByAny(tagToken);
  if (cust) return cust.genieacs_tag || cust.pppoe_username || cust.phone || tagToken;

  return tagToken;
}

function formatListOnu(devices) {
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');

  const header = `📱 *DAFTAR ONU BER-TAG*
${'─'.repeat(30)}
📊 *${companyHeader}*
${'─'.repeat(30)}
`;
  const footer = `
${'─'.repeat(30)}
${footerInfo}`;

  if (!devices || devices.length === 0) {
    return header + `❌ Tidak ada perangkat dengan tag.` + footer;
  }

  const content = `📊 *${devices.length} perangkat ditemukan:*
`;
  const lines = devices.map((d, i) => {
    const num = String(i + 1).padStart(2, '0');
    const tags = Array.isArray(d._tags) ? d._tags.join(', ') : String(d._tags || '-');
    
    let pppoeUsername = '-';
    try {
      if (d.InternetGatewayDevice?.WANDevice) {
        for (const wanKey of Object.keys(d.InternetGatewayDevice.WANDevice)) {
          if (wanKey.startsWith('_')) continue;
          const wanDev = d.InternetGatewayDevice.WANDevice[wanKey];
          if (wanDev?.WANConnectionDevice) {
            for (const connKey of Object.keys(wanDev.WANConnectionDevice)) {
              if (connKey.startsWith('_')) continue;
              const connDev = wanDev.WANConnectionDevice[connKey];
              if (connDev?.WANPPPConnection) {
                for (const pppKey of Object.keys(connDev.WANPPPConnection)) {
                  if (pppKey.startsWith('_')) continue;
                  const pppConn = connDev.WANPPPConnection[pppKey];
                  if (pppConn?.Username?._value) {
                    pppoeUsername = pppConn.Username._value;
                    break;
                  }
                }
              }
              if (pppoeUsername !== '-') break;
            }
          }
          if (pppoeUsername !== '-') break;
        }
      }
      if (pppoeUsername === '-' && d.Device?.PPP?.Interface) {
        for (const pppKey of Object.keys(d.Device.PPP.Interface)) {
          if (pppKey.startsWith('_')) continue;
          const pppInt = d.Device.PPP.Interface[pppKey];
          if (pppInt?.Username?._value) {
            pppoeUsername = pppInt.Username._value;
            break;
          }
        }
      }
    } catch (_) {}

    const li = d._lastInform ? formatDateLocal(d._lastInform) : '-';
    return `${num}. 🏷️ *${tags}*
   � PPPoE: ${pppoeUsername}
   ⏱️ Last inform: ${li}`;
  }).join('\n\n');

  return header + content + lines + footer;
}

function splitWaChunks(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

/** Kirim notifikasi ke pelanggan saat admin mengubah SSID/Password */
async function notifyCustomer(sock, lidStore, tag, message) {
  logger.info(`[WA notifyCustomer] Memulai pengiriman untuk tag: "${tag}"`);
  try {
    const text = waAutoWrap(message);
    const normalizeDigitsTo62 = (raw) => {
      let digits = String(raw || '').replace(/\D/g, '');
      if (!digits) return '';
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      else if (!digits.startsWith('62')) digits = '62' + digits;
      return digits;
    };

    // 1. Coba cari data pelanggan dari database dulu untuk mendapatkan nomor HP aslinya
    const cust = customerSvc.findCustomerByAny(tag);
    let phoneNumber = '';
    if (cust && cust.phone) {
      phoneNumber = normalizeDigitsTo62(cust.phone);
    }
    logger.info(`[WA notifyCustomer] Resolusi database tag "${tag}" -> Phone: "${phoneNumber}"`);
    
    // Jika tag itu sendiri adalah nomor HP, gunakan sebagai fallback
    if (!phoneNumber) {
      const parsedTag = normalizeDigitsTo62(tag);
      if (parsedTag.length >= 10) {
        phoneNumber = parsedTag;
      }
    }

    if (phoneNumber) {
      const sent = await sendWA(phoneNumber, text);
      if (sent) {
        logger.info(`[WA notifyCustomer] Notifikasi terkirim via gateway universal ke ${phoneNumber}`);
        return true;
      }
    }

    let targetJid = null;

    // 2. Jika ada nomor HP, tanyakan ke WhatsApp server untuk JID yang benar (LID atau PN JID)
    if (phoneNumber.length >= 10) {
      const directJid = `${phoneNumber}@s.whatsapp.net`;
      logger.info(`[WA notifyCustomer] Mengecek JID terdaftar untuk ${directJid} via onWhatsApp...`);
      try {
        const [waCheck] = await sock.onWhatsApp(directJid);
        if (waCheck && waCheck.exists) {
          targetJid = waCheck.jid || directJid || waCheck.lid;
          logger.info(`[WA notifyCustomer] JID terverifikasi dari WhatsApp server untuk nomor ${phoneNumber}: ${targetJid}`);
        } else {
          logger.info(`[WA notifyCustomer] Nomor ${phoneNumber} tidak terdaftar menurut onWhatsApp`);
        }
      } catch (err) {
        logger.error(`[WA notifyCustomer] Gagal onWhatsApp check untuk nomor ${phoneNumber}: ${err.message}`);
      }
      
      // Jika onWhatsApp gagal/error, fallback ke directJid asli
      if (!targetJid) {
        logger.info(`[WA notifyCustomer] Menggunakan fallback JID langsung: ${directJid}`);
        targetJid = directJid;
      }
    }

    // 3. Fallback: Cari JID pelanggan berdasarkan tag di lidStore jika targetJid belum terisi
    if (!targetJid) {
      const customerJid = lidStore ? lidStore.getByTag(tag) : null;
      if (customerJid) {
        logger.info(`[WA notifyCustomer] Menemukan JID dari lidStore untuk tag "${tag}": ${customerJid}`);
        targetJid = customerJid;
      }
    }

    if (targetJid) {
      logger.info(`[WA notifyCustomer] Mengirim pesan ke JID target: ${targetJid}`);
      const res = await sock.sendMessage(targetJid, { text });
      if (res && res.key && res.message) {
        cacheSentMessage(res.key, res.message);
      }
      logger.info(`[WA notifyCustomer] Pesan berhasil dikirim ke JID target: ${targetJid}`);
      return true;
    }

    logger.warn(`[WA notifyCustomer] Tidak ada tujuan valid untuk mengirim notifikasi pelanggan tag: ${tag}`);
    return false;
  } catch (e) {
    logger.error('[WA notifyCustomer] Gagal mengirim notifikasi ke pelanggan: ' + (e.message || e));
    return false;
  }
}

function getMenuText() {
  const { companyHeader, footerInfo, sep } = waBrand();
  return `📱 *MENU PELANGGAN*
${sep}
🏢 *${companyHeader}*
${sep}

📋 *Perintah Tersedia:*

🧾 \`menu\` — Tampilkan bantuan ini
📡 \`info\` / \`cekstatus\` — Status ONU Anda
💳 \`cektagihan\` — Lihat status tagihan
👥 \`cekterhubung\` — Daftar host terhubung
📶 \`gantissid\` _nama_ — Ubah nama WiFi
🔑 \`gantisandi\` _sandi_ — Ubah password
🔄 \`reboot\` — Restart ONU
🔗 \`daftar\` _tag/nomor_ — Bind nomor WA

${sep}
${footerInfo ? footerInfo : '💡 *Contoh:* `cektagihan`'}`;
}

function getAdminMenuText() {
  const { companyHeader, footerInfo, sep } = waBrand();
  return `🛠️ *MENU ADMIN*
${sep}
🏢 *${companyHeader}*
${sep}

🏦 *Digiflazz:*
💳 \`saldodigi\` — Cek saldo deposit Digiflazz

👥 *Agent:*
💸 \`topup\` _nama/username/id/nohp nominal_ — Transfer saldo ke agent

📡 *MikroTik:*
🟢 \`mtactive\` — User active saat ini
✂️ \`kickuser\` _user_ — Putus session active
➕ \`addpppoe\` _user pass profile_
📝 \`editpppoe\` _user profile_
🗑️ \`delpppoe\` _user_
➕ \`addhotspot\` _user pass profile_
🎟️ \`vcr\` _kode profile_ — User=Pass + Comment
🗑️ \`delhotspot\` _user_

💰 *Billing:*
📊 \`ringkasan\` — Statistik billing
✅ \`lunas\` _ID_ — Tandai lunas ID tagihan
🧾 \`generate\` _bln thn_ — Generate tagihan

👥 *Pelanggan:*
⛔ \`isolir\` _ID_ — Suspend pelanggan
🟢 \`buka\` _ID_ — Aktifkan pelanggan

📱 *Device ONU:*
📋 \`listonu\` — Daftar semua ONU
📡 \`info\` / \`cekstatus\` _TAG_ — Status ONU
🔄 \`reboot\` _TAG_ — Restart ONU
📶 \`gantissid\` _TAG_ _namaSSID_ — Ubah SSID ONU
🔑 \`gantisandi\` _TAG_ _password_ — Ubah password ONU (min 8)

⚡ *Digiflazz (Admin):*
⚡ \`pulsa\` _SKU TARGET_ — Transaksi pulsa/produk
🔎 \`cekpulsa\` _TXID_ — Cek status transaksi

${sep}
${footerInfo ? footerInfo : '💡 _Tanpa TAG = perintah untuk device yang terikat ke WA Anda._'}`;
}

export const whatsappStatus = {
  _connection: 'connecting',
  get connection() {
    try {
      const gw = getSetting('wa_gateway_type', 'baileys');
      if (gw === 'fonnte') {
        const token = getSetting('fonnte_token', '');
        return token ? 'open' : 'close';
      }
      if (gw === 'meta') {
        const token = getSetting('wa_meta_token', '');
        return token ? 'open' : 'close';
      }
    } catch (_) {}
    return this._connection || 'connecting';
  },
  set connection(val) {
    this._connection = val;
  },
  _user: null,
  get user() {
    try {
      const gw = getSetting('wa_gateway_type', 'baileys');
      if (gw === 'fonnte') {
        return { id: 'fonnte_gateway', name: 'Fonnte Gateway' };
      }
      if (gw === 'meta') {
        return { id: 'meta_gateway', name: 'Meta Cloud API' };
      }
    } catch (_) {}
    return this._user;
  },
  set user(val) {
    this._user = val;
  },
  _phoneNumber: null,
  get phoneNumber() {
    try {
      const gw = getSetting('wa_gateway_type', 'baileys');
      if (gw === 'fonnte') return 'Fonnte Gateway';
      if (gw === 'meta') return getSetting('meta_phone_number_id', 'Meta API');
    } catch (_) {}
    return this._phoneNumber || this.user?.id?.split(':')[0] || '-';
  },
  set phoneNumber(val) {
    this._phoneNumber = val;
  },
  _pushName: null,
  get pushName() {
    try {
      const gw = getSetting('wa_gateway_type', 'baileys');
      if (gw === 'fonnte') return 'Fonnte Gateway';
      if (gw === 'meta') return 'Meta Cloud API';
    } catch (_) {}
    return this._pushName || this.user?.name || '-';
  },
  set pushName(val) {
    this._pushName = val;
  },
  qr: null,
  qrImage: null,
  lastUpdate: getCurrentDateInTimezone()
};

let currentSock = null;
let qrShownSinceStart = false;
let notifiedAdminForQr = false;
let isStarting = false;

export function isBotRunning() {
  return !!currentSock;
}

function loadWhatsappAdminSendList() {
  const list = getWhatsappAdminNumbers();
  const out = [];
  const seen = new Set();
  for (const n of list) {
    let digits = String(n).replace(/\D/g, '');
    if (!digits) continue;
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    if (digits.length < 8) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }
  return out;
}

/**
 * Send monitoring alert to admin and technicians
 * @param {string} message - Alert message to send
 * @param {string} priority - Priority level: 'high', 'medium', 'low'
 */
export async function sendMonitoringAlert(message, priority = 'medium') {
  const gatewayType = getSetting('wa_gateway_type', 'baileys');
  if (gatewayType === 'baileys' && (!currentSock || whatsappStatus._connection !== 'open')) {
    logger.warn('[WhatsApp] Bot belum siap (koneksi belum terbuka), tidak dapat mengirim alert monitoring');
    return { success: false, message: 'Bot belum siap' };
  }

  try {
    const priorityIcon = priority === 'high' ? '🚨' : priority === 'medium' ? '⚠️' : 'ℹ️';
    const formattedMessage = `${priorityIcon} *MONITORING ALERT*\n\n${message}`;

    // Get admin numbers from settings
    const adminNumbers = getWhatsappAdminNumbers();

    // Get technician numbers from database (active technicians only)
    const techSvc = require('./techService');
    const technicians = techSvc.getAllTechnicians();
    const techNumbers = technicians
      .filter(tech => tech.is_active === 1 && tech.phone)
      .map(tech => {
        let phone = String(tech.phone || '').replace(/\D/g, '');
        // Convert 08xxx to 628xxx
        if (phone.startsWith('0')) {
          phone = '62' + phone.slice(1);
        }
        return phone;
      })
      .filter(Boolean);

    const toJid = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return '';
      if (s.includes('@')) return s;
      let digits = s.replace(/\D/g, '');
      if (!digits) return '';
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      if (digits.length < 8) return '';
      return `${digits}@s.whatsapp.net`;
    };

    const adminJids = Array.from(new Set((adminNumbers || []).map(toJid).filter(Boolean)));
    const techJids = Array.from(new Set((techNumbers || []).map(toJid).filter(Boolean)));
    const recipients = Array.from(new Set([...adminJids, ...techJids]));

    if (recipients.length === 0) {
      logger.warn('[WhatsApp] Tidak ada nomor penerima alert monitoring yang dikonfigurasi');
      return { success: false, message: 'Tidak ada penerima yang dikonfigurasi' };
    }

    logger.info(`[WhatsApp] Mengirim alert monitoring ke ${recipients.length} penerima (${adminJids.length} admin, ${techJids.length} teknisi)`);

    const results = [];
    for (const jid of recipients) {
      try {
        if (gatewayType === 'fonnte' || gatewayType === 'meta') {
          const ok = await sendWA(jid, formattedMessage);
          if (ok) {
            results.push({ jid, success: true });
            logger.info(`[WhatsApp] Alert monitoring terkirim ke ${jid}`);
          } else {
            throw new Error(`Gagal mengirim alert via ${gatewayType}`);
          }
        } else {
          const res = await currentSock.sendMessage(jid, { text: formattedMessage });
          if (res && res.key && res.message) {
            cacheSentMessage(res.key, res.message);
          }
          results.push({ jid, success: true });
          logger.info(`[WhatsApp] Alert monitoring terkirim ke ${jid}`);
        }
      } catch (error) {
        results.push({ jid, success: false, error: error.message });
        logger.error(`[WhatsApp] Gagal mengirim alert ke ${jid}: ${error.message}`);
      }
    }

    const successCount = results.filter(r => r.success).length;
    return {
      success: successCount > 0,
      message: `Alert terkirim ke ${successCount}/${recipients.length} penerima (${adminJids.length} admin, ${techJids.length} teknisi)`,
      results
    };
  } catch (error) {
    logger.error(`[WhatsApp] Error mengirim monitoring alert: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export function parseSpintax(text) {
  if (!text) return '';
  return String(text).replace(/\{([^{}]+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)];
  });
}

export async function simulateHumanTyping(sock, jid, text = '') {
  if (!sock || !jid) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    const textLen = String(text || '').length;
    const typingDuration = Math.min(Math.max(textLen * 35, 1200), 4000);
    await new Promise(resolve => setTimeout(resolve, typingDuration));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    // Non-critical, ignore presence errors
  }
}

export async function sendWA(to, text, options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys');

  let finalText = text;
  if (options.spintax !== false && typeof text === 'string' && text.includes('{') && text.includes('}')) {
    finalText = parseSpintax(text);
  }

  // Routing Gateway FONNTE (Cloud / Self-Hosted)
  if (gatewayType === 'fonnte') {
    try {
      const fonnteWAService = require('./fonnteWhatsappService');
      const res = await fonnteWAService.sendFonnteMessage(to, finalText, options);
      return !!(res && res.success);
    } catch (err) {
      logger.error('[WA Fonnte sendWA] Gagal kirim pesan:', err.message);
      return false;
    }
  }

  // Routing Gateway META OFFICIAL CLOUD API
  if (gatewayType === 'meta') {
    try {
      const metaWAService = require('./metaWhatsappService');
      if (options.templateName) {
        return await metaWAService.sendMetaTemplateMessage(
          to,
          options.templateName,
          options.langCode || 'id',
          options.parameters || []
        );
      } else {
        return await metaWAService.sendMetaTextMessage(to, finalText);
      }
    } catch (err) {
      logger.error('[WA Meta sendWA] Gagal kirim pesan:', err.message);
      return false;
    }
  }

  // Gateway BAILEYS WEB (Default)
  if (!currentSock || whatsappStatus._connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim pesan, bot belum terhubung.');
    return false;
  }
  try {
    let digits = to.replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = to.includes('@') ? to : `${digits}@s.whatsapp.net`;
    logger.info(`[WA sendWA] Mengirim ke: ${to} -> JID Awal: ${jid}`);
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const waCheck = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.length > 0 && waCheck[0].exists) {
          jid = waCheck[0].jid || waCheck[0].lid || jid;
        }
      } catch (err) {
        logger.error(`[WA sendWA] Gagal check onWhatsApp untuk ${jid}: ${err.message}`);
      }
    }

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalText);
    }

    logger.info(`[WA sendWA] Mengeksekusi sendMessage ke JID: ${jid}`);
    const result = await currentSock.sendMessage(jid, { text: finalText });
    if (result && result.key && result.message) {
      cacheSentMessage(result.key, result.message);
    }
    logger.info(`[WA sendWA] sendMessage selesai! Result JID: ${result?.key?.remoteJid || 'null'}, ID: ${result?.key?.id || 'null'}`);
    return true;
  } catch (e) {
    logger.error('[WA sendWA] Gagal kirim WA:', e.message);
    return false;
  }
}

export async function sendWAImage(to, imageBuffer, caption = '', options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys');

  let finalCaption = caption;
  if (options.spintax !== false && typeof caption === 'string' && caption.includes('{') && caption.includes('}')) {
    finalCaption = parseSpintax(caption);
  }

  if (gatewayType === 'fonnte') {
    try {
      const fonnteWAService = require('./fonnteWhatsappService');
      const res = await fonnteWAService.sendFonnteMessage(to, finalCaption, options);
      return !!(res && res.success);
    } catch (err) {
      logger.error('[WA Fonnte sendWAImage] Gagal kirim image:', err.message);
      return false;
    }
  }

  if (gatewayType === 'meta') {
    try {
      const metaWAService = require('./metaWhatsappService');
      return await metaWAService.sendMetaTextMessage(to, finalCaption);
    } catch (err) {
      logger.error('[WA Meta sendWAImage] Gagal kirim image:', err.message);
      return false;
    }
  }

  if (!currentSock || whatsappStatus._connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim pesan, bot belum terhubung.');
    return false;
  }
  try {
    let digits = String(to || '').replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = String(to || '').includes('@') ? String(to) : `${digits}@s.whatsapp.net`;
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [waCheck] = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.exists && waCheck.jid) {
          jid = waCheck.jid;
        }
      } catch (err) {
        logger.debug(`[WA] sendWAImage JID resolution failed for ${jid}: ${err.message}`);
      }
    }
    const img = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || []);
    if (!img.length) return false;

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalCaption);
    }

    const result = await currentSock.sendMessage(jid, { image: img, caption: String(finalCaption || '') });
    if (result && result.key && result.message) {
      cacheSentMessage(result.key, result.message);
    }
    return true;
  } catch (e) {
    logger.error('Gagal kirim WA image:', e.message);
    return false;
  }
}

export async function sendWADocument(to, documentBuffer, filename = 'Invoice.pdf', caption = '', mimetype = 'application/pdf', options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys');

  let finalCaption = caption;
  if (options.spintax !== false && typeof caption === 'string' && caption.includes('{') && caption.includes('}')) {
    finalCaption = parseSpintax(caption);
  }

  if (gatewayType === 'fonnte') {
    try {
      const fonnteWAService = require('./fonnteWhatsappService');
      const res = await fonnteWAService.sendFonnteMessage(to, finalCaption, { ...options, filename });
      return !!(res && res.success);
    } catch (err) {
      logger.error('[WA Fonnte sendWADocument] Gagal kirim dokumen:', err.message);
      return false;
    }
  }

  if (gatewayType === 'meta') {
    try {
      const metaWAService = require('./metaWhatsappService');
      return await metaWAService.sendMetaTextMessage(to, finalCaption);
    } catch (err) {
      logger.error('[WA Meta sendWADocument] Gagal kirim dokumen:', err.message);
      return false;
    }
  }

  if (!currentSock || whatsappStatus._connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim dokumen, bot belum terhubung.');
    return false;
  }
  try {
    let digits = String(to || '').replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = String(to || '').includes('@') ? String(to) : `${digits}@s.whatsapp.net`;
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [waCheck] = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.exists && waCheck.jid) {
          jid = waCheck.jid;
        }
      } catch (err) {
        logger.debug(`[WA] sendWADocument JID resolution failed for ${jid}: ${err.message}`);
      }
    }
    const doc = Buffer.isBuffer(documentBuffer) ? documentBuffer : Buffer.from(documentBuffer || []);
    if (!doc.length) return false;

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalCaption);
    }

    const result = await currentSock.sendMessage(jid, {
      document: doc,
      mimetype: mimetype || 'application/pdf',
      fileName: filename || 'Document.pdf',
      caption: String(finalCaption || '')
    });
    if (result && result.key && result.message) {
      cacheSentMessage(result.key, result.message);
    }
    return true;
  } catch (e) {
    logger.error('Gagal kirim WA document:', e.message);
    return false;
  }
}

export async function restartWhatsAppBot() {
  logger.info('WhatsApp: Memulai ulang bot...');
  if (currentSock) {
    try {
      currentSock.end();
    } catch (e) {
      logger.error('WhatsApp: Gagal menghentikan socket lama:', e.message);
    }
  }
  // Beri jeda sedikit agar socket lama benar-benar tertutup
  setTimeout(() => {
    startWhatsAppBot();
  }, 1000);
}

let defaultLidStore = null;
export function getDefaultLidStore() {
  if (!defaultLidStore) {
    try {
      const lidMapPath = path.resolve(projectRoot, getSetting('whatsapp_lid_map_file', 'data/wa-lid-map.json'));
      defaultLidStore = new WaLidStore(lidMapPath);
    } catch (e) {
      logger.warn('[WA] WaLidStore init warning: ' + e.message);
    }
  }
  return defaultLidStore;
}


/**
 * Universal WhatsApp Bot Command Processor
 * Dapat dipanggil oleh Baileys, Fonnte Webhook, maupun Meta Cloud API Webhook
 */
export async function processIncomingCommand({
  senderPhone,
  text,
  reply,
  senderName = '',
  key = null,
  sock = null,
  lidStore = null
}) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  let phone = String(senderPhone || '').replace(/\D/g, '');
  if (phone.startsWith('0')) {
    phone = '62' + phone.slice(1);
  }

  const msgKey = key || {
    remoteJid: phone ? `${phone}@s.whatsapp.net` : null,
    senderPn: phone ? `${phone}@s.whatsapp.net` : null
  };

  const currentLidStore = lidStore || getDefaultLidStore();
  const currentSockInstance = sock || currentSock;

  logger.info(`[WA] Pesan masuk dari ${(msgKey.remoteJid || phone)}: "${text}"`);
  const adminSet = loadWhatsappAdminSet(currentLidStore);
  const isAdmin = (phone && adminSet.has(phone)) || isWhatsappAdminKey(msgKey, adminSet, currentSockInstance, currentLidStore);
  logger.info(`[WA] Sender details: JID=${(msgKey.remoteJid || phone)}, isAdmin=${isAdmin}, adminSet=${JSON.stringify([...adminSet])}`);
  const parsed = parseCommand(text, isAdmin);
        logger.info(`[WA] Parsed command: ${JSON.stringify(parsed)}`);
        if (!parsed) return false;

        // Rate Limiting Check
        /* phone already defined */
        if (phone) {
          // Cek command cooldown (2 detik)
          const cooldownCheck = checkCommandCooldown(phone);
          if (!cooldownCheck.allowed) {
            await reply(`⏳ Mohon tunggu *${cooldownCheck.waitTime} detik* sebelum mengirim perintah lagi.`);
            logger.warn(`[WhatsApp Bot] Rate limit cooldown triggered for ${phone}`);
            return true;
          }

          // Cek rate limit per menit (10 perintah)
          const rateLimitCheck = checkRateLimit(phone);
          if (!rateLimitCheck.allowed) {
            await reply(`⚠️ Anda telah mencapai batas perintah. Tunggu *${rateLimitCheck.waitTime} detik* sebelum mencoba lagi.`);
            logger.warn(`[WhatsApp Bot] Rate limit exceeded for ${phone}`);
            return true;
          }

          // Log rate limit info
          if (rateLimitCheck.remaining <= 3) {
            logger.info(`[WhatsApp Bot] Rate limit warning for ${phone}: ${rateLimitCheck.remaining} commands remaining`);
          }
        }

        if (parsed.cmd === 'menu') {
          let body = getMenuText();
          if (isAdmin) body += '\n\n_Anda admin — ketik `admin` untuk perintah kelola semua tag._';
          /* phone already defined */
          const agent = phone ? agentSvc.getAgentByPhone(phone) : null;
          if (agent) {
            body +=
              '\n\n📱 *MENU AGENT*\n' +
              '⚡ `pulsa SKU TARGET` — Beli pulsa/produk Digiflazz\n' +
              '🔎 `cekpulsa TXID` — Cek status transaksi pulsa';
          }
          await reply(body);
          return true;
        }

        if (parsed.cmd === 'adminmenu') {
          if (!isAdmin) {
            await reply('❌ Perintah ini khusus nomor admin (pengaturan whatsapp_admin_numbers).');
            return true;
          }
          await reply(getAdminMenuText());
          return true;
        }

        if (parsed.cmd === 'listonu' && parsed.admin) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            return true;
          }
          let res = await customerDevice.listDevicesWithTags(300);
          if (!res.ok || !res.devices || res.devices.length === 0) {
            res = await customerDevice.listAllDevices(300);
          }
          if (!res.ok) {
            await reply('❌ ' + (res.message || 'Gagal mengambil daftar.'));
            return true;
          }
          const body = formatListOnu(res.devices || []);
          const chunks = splitWaChunks(body);
          for (const ch of chunks) {
            await reply(ch);
          }
          return true;
        }

        // Admin MikroTik Logic
        if (parsed.admin && parsed.cmd === 'mtactive') {
          try {
            const pppoe = await mikrotikSvc.getPppoeActive();
            const hotspot = await mikrotikSvc.getHotspotActive();
            await reply(formatActiveMikrotik(pppoe, hotspot));
          } catch (e) {
            await reply('❌ Gagal mengambil data aktif: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'kickuser') {
          try {
            const [user] = parsed.args;
            const pk = await mikrotikSvc.kickPppoeUser(user);
            const hk = await mikrotikSvc.kickHotspotUser(user);
            if (pk || hk) await reply(`✅ Session user *${user}* berhasil diputus.`);
            else await reply(`❌ User *${user}* tidak ditemukan di session aktif.`);
          } catch (e) {
            await reply('❌ Gagal kick user: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'addpppoe') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addPppoeSecret({ name: user, password: pass, profile, service: 'pppoe' });
            await reply(`✅ PPPoE Secret *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah PPPoE: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'editpppoe') {
          try {
            const [user, profile] = parsed.args;
            await mikrotikSvc.setPppoeProfile(user, profile);
            await reply(`✅ Profile PPPoE *${user}* berhasil diubah ke *${profile}* dan session aktif telah diputus.`);
          } catch (e) {
            await reply('❌ Gagal edit PPPoE: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'delpppoe') {
          try {
            const [user] = parsed.args;
            const secrets = await mikrotikSvc.getPppoeSecrets();
            const found = secrets.find(s => s.name === user);
            if (!found) return await reply(`❌ User *${user}* tidak ditemukan.`);
            await mikrotikSvc.deletePppoeSecret(found['.id'] || found.id);
            await mikrotikSvc.kickPppoeUser(user);
            await reply(`✅ PPPoE Secret *${user}* berhasil dihapus dan session aktif diputus.`);
          } catch (e) {
            await reply('❌ Gagal hapus PPPoE: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'addhotspot') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addHotspotUser({ name: user, password: pass, profile });
            await reply(`✅ Hotspot User *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah Hotspot: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'vcr') {
          try {
            const [code, profile] = parsed.args;
            const now = getCurrentDateInTimezone();
            const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
            const comment = `vc ${code} ${dateStr}`;

            await mikrotikSvc.addHotspotUser({
              name: code,
              password: code,
              profile: profile,
              comment: comment
            });

            await reply(`✅ Voucher Hotspot *${code}* berhasil dibuat.\n\n👤 User: *${code}*\n🔑 Pass: *${code}*\n🏷️ Profile: *${profile}*\n📝 Comment: *${comment}*`);
          } catch (e) {
            await reply('❌ Gagal buat voucher: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'delhotspot') {
          try {
            const [user] = parsed.args;
            const users = await mikrotikSvc.getHotspotUsers();
            const found = users.find(u => u.name === user);
            if (!found) return await reply(`❌ User Hotspot *${user}* tidak ditemukan.`);
            await mikrotikSvc.deleteHotspotUser(found['.id'] || found.id);
            await mikrotikSvc.kickHotspotUser(user);
            await reply(`✅ Hotspot User *${user}* berhasil dihapus dan session aktif diputus.`);
          } catch (e) {
            await reply('❌ Gagal hapus Hotspot: ' + e.message);
          }
          return true;
        }

        // Admin Billing Logic
        if (parsed.admin && parsed.cmd === 'ringkasan') {
          const stats = billingSvc.getDashboardStats();
          await reply(formatBillingSummary(stats));
          return true;
        }

        if (parsed.admin && parsed.cmd === 'lunas') {
          logger.info(`[WA lunas] Memulai pemrosesan lunas untuk target: "${parsed.targetId}"`);
          try {
            const keyRaw = String(parsed.targetId || '').trim();
            if (!keyRaw) {
              logger.warn(`[WA lunas] Target kosong!`);
              return await reply('❌ Format: `lunas IDTAGIHAN` atau `lunas nama/nohp/pppoe/tag`');
            }

            let targetInvId = null;
            let targetInv = null;
            const isNumeric = /^\d+$/.test(keyRaw);
            if (isNumeric) {
              targetInvId = Number(keyRaw);
              targetInv = billingSvc.getInvoiceById(targetInvId);
              logger.info(`[WA lunas] Pencarian numerik ID Invoice: ${targetInvId} -> Found: ${!!targetInv}`);
            }

            // If not found by ID, try find customer and their oldest unpaid invoice
            if (!targetInv) {
              let cust =
                (isNumeric ? customerSvc.getCustomerById(Number(keyRaw)) : null) ||
                customerSvc.findCustomerByAny(keyRaw);
              logger.info(`[WA lunas] Pencarian customer untuk key: "${keyRaw}" -> Found: ${cust ? cust.name + " (ID:" + cust.id + ")" : 'null'}`);

              if (!cust) {
                const candidates = customerSvc.getAllCustomers(keyRaw) || [];
                const unique = Array.from(new Map(candidates.map(c => [c.id, c])).values());
                logger.info(`[WA lunas] Ditemukan ${unique.length} kandidat unik`);
                if (unique.length === 1) {
                  cust = customerSvc.getCustomerById(unique[0].id);
                  logger.info(`[WA lunas] Menggunakan kandidat tunggal: ${cust.name}`);
                } else if (unique.length > 1) {
                  const top = unique.slice(0, 5).map(c =>
                    `- ID:${c.id} • ${c.name || '-'} • ${c.phone || '-'} • PPPoE:${c.pppoe_username || '-'}`
                  ).join('\n');
                  return await reply(`⚠️ Nama/ID tidak spesifik. Ditemukan ${unique.length} pelanggan:\n\n${top}\n\nKirim ulang: \`lunas IDPELANGGAN\` atau \`lunas NOHP/PPPOE/TAG\``);
                }
              }

              if (cust) {
                const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
                logger.info(`[WA lunas] Tagihan belum dibayar untuk customer ${cust.name}: ${unpaid ? unpaid.length : 0}`);
                if (unpaid && unpaid.length > 0) {
                  targetInv = unpaid[0];
                  targetInvId = targetInv.id;
                } else {
                  return await reply(`✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`);
                }
              }
            }

            if (!targetInv) {
              logger.warn(`[WA lunas] Invoice/Customer tidak ditemukan untuk: "${keyRaw}"`);
              return await reply(`❌ Tagihan atau Pelanggan *${keyRaw}* tidak ditemukan.`);
            }
            if (targetInvId != null) {
              const enriched = billingSvc.getInvoiceById(targetInvId);
              if (enriched) targetInv = enriched;
            }
            if (targetInv && targetInv.status === 'paid') {
              logger.info(`[WA lunas] Invoice #${targetInv.id} sudah paid`);
              return await reply(`✅ Invoice *#${targetInv.id}* sudah berstatus LUNAS.`);
            }

            logger.info(`[WA lunas] Menandai lunas invoice #${targetInvId}...`);
            billingSvc.markAsPaid(targetInvId, 'WA Bot Admin', 'Paid via WhatsApp Command');

            const customer = customerSvc.getCustomerById(targetInv.customer_id);
            const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
            const customerName = String(targetInv.customer_name || customer?.name || targetInv.customer_name || '-');
            const notifyTag = customer?.genieacs_tag || customer?.pppoe_username || customer?.phone || targetInv.customer_phone || targetInv.genieacs_tag || '';
            logger.info(`[WA lunas] Detail: customerName="${customerName}", notifyTag="${notifyTag}", status="${customer?.status}"`);

            if (customer && customer.status === 'suspended') {
              const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
              const unpaidCount = freshCustomer && Number.isFinite(Number(freshCustomer.unpaid_count)) ? Number(freshCustomer.unpaid_count) : 1;
              logger.info(`[WA lunas] Customer status suspended, sisa unpaidCount: ${unpaidCount}`);
              if (unpaidCount === 0) {
                logger.info(`[WA lunas] Mengaktifkan customer ID ${targetInv.customer_id}...`);
                await customerSvc.activateCustomer(targetInv.customer_id);
                logger.info(`[WA lunas] Customer berhasil diaktifkan. Mengirim notifikasi lunas...`);
                const ok = await notifyCustomer(
                  currentSockInstance,
                  currentLidStore,
                  notifyTag,
                  waWrap(
                    '✅ *PEMBAYARAN BERHASIL*',
                    `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                      `👤 *Nama:* ${customerName}\n` +
                      `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                      `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                      `🟢 Layanan internet Anda sudah aktif kembali.\n\n` +
                      `Terima kasih.`
                  )
                );
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. Pelanggan *${customerName}* otomatis diaktifkan kembali.\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
              } else {
                logger.info(`[WA lunas] Customer masih memiliki ${unpaidCount} invoice unpaid, notif dikirim...`);
                const ok = await notifyCustomer(
                  currentSockInstance,
                  currentLidStore,
                  notifyTag,
                  waWrap(
                    '✅ *PEMBAYARAN BERHASIL*',
                    `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                      `👤 *Nama:* ${customerName}\n` +
                      `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                      `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                      `⚠️ Masih ada ${unpaidCount} tagihan lain yang belum dibayar.\n\n` +
                      `Terima kasih.`
                  )
                );
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. (Masih ada ${unpaidCount} tagihan lain, isolir tetap aktif)\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
              }
            } else {
              logger.info(`[WA lunas] Customer tidak suspended atau null, mengirim notifikasi lunas...`);
              const ok = await notifyCustomer(
                currentSockInstance,
                currentLidStore,
                notifyTag,
                waWrap(
                  '✅ *PEMBAYARAN BERHASIL*',
                  `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                    `👤 *Nama:* ${customerName}\n` +
                    `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                    `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                    `Terima kasih.`
                )
              );
              await reply(`✅ Invoice *#${targetInvId}* (a.n ${customerName}) berhasil ditandai LUNAS.\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
            }
          } catch (e) {
            logger.error('[WA lunas] Gagal update status: ' + e.message);
            await reply('❌ Gagal update status: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'isolir') {
          try {
            const cust = customerSvc.findCustomerByAny(parsed.targetId);
            if (!cust) return await reply(`❌ Pelanggan *${parsed.targetId}* tidak ditemukan.`);
            await customerSvc.suspendCustomer(cust.id);
            await reply(`✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil di-isolir.`);
          } catch (e) {
            await reply('❌ Gagal isolir: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'buka') {
          try {
            const cust = customerSvc.findCustomerByAny(parsed.targetId);
            if (!cust) return await reply(`❌ Pelanggan *${parsed.targetId}* tidak ditemukan.`);
            await customerSvc.activateCustomer(cust.id);
            await reply(`✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil diaktifkan kembali.`);
          } catch (e) {
            await reply('❌ Gagal buka isolir: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'generate') {
          try {
            const count = billingSvc.generateMonthlyInvoices(parseInt(parsed.month), parseInt(parsed.year));
            await reply(`✅ Berhasil generate *${count}* tagihan untuk periode ${parsed.month}/${parsed.year}.`);
          } catch (e) {
            await reply('❌ Gagal generate: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'digiflazz_balance') {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            return true;
          }
          try {
            const r = await agentSvc.digiflazzCheckBalance();
            await reply(`🏦 *SALDO DIGIFLAZZ*\n\n💳 Deposit: Rp ${Number(r?.deposit || 0).toLocaleString('id-ID')}`);
          } catch (e) {
            await reply('❌ Gagal cek saldo Digiflazz: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.cmd === 'topupagent') {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            return true;
          }
          try {
            const agentKeyRaw = String(parsed.agentKey || '').trim();
            const amount = Number(String(parsed.amount || '').replace(/[^\d]/g, '')) || 0;
            if (!agentKeyRaw) throw new Error('Agent username/id tidak valid');
            if (!amount) throw new Error('Nominal tidak valid');

            const normalizeDigits = (v) => {
              let d = String(v || '').replace(/\D/g, '');
              if (!d) return '';
              if (d.startsWith('0')) d = '62' + d.slice(1);
              return d;
            };

            const agentKey = agentKeyRaw.startsWith('@') ? agentKeyRaw.slice(1) : agentKeyRaw;
            const agentKeyLc = agentKey.toLowerCase();
            const agentDigits = normalizeDigits(agentKey);

            const agents = agentSvc.getAllAgents();
            const candidates = [];

            const byId = /^\d+$/.test(agentKey) ? agents.find(a => Number(a?.id) === Number(agentKey)) : null;
            if (byId) candidates.push(byId);

            const byUsername = agents.find(a => String(a?.username || '').toLowerCase() === agentKeyLc) || null;
            if (byUsername) candidates.push(byUsername);

            if (agentDigits) {
              const byPhone = agents.find(a => normalizeDigits(a?.phone || '') === agentDigits) || null;
              if (byPhone) candidates.push(byPhone);
            }

            const byNameExact = agents.find(a => String(a?.name || '').trim().toLowerCase() === agentKeyLc) || null;
            if (byNameExact) candidates.push(byNameExact);

            let agent = candidates.length > 0 ? candidates[0] : null;
            if (!agent) {
              const byNameContains = agents.filter(a => String(a?.name || '').trim().toLowerCase().includes(agentKeyLc));
              if (byNameContains.length === 1) agent = byNameContains[0];
              if (!agent && byNameContains.length > 1) {
                const list = byNameContains.slice(0, 8).map(a => `- ${a.name} (@${a.username}) [ID:${a.id}]`).join('\n');
                throw new Error(`Nama agent lebih dari satu. Gunakan username/ID/nohp.\n\n${list}`);
              }
            }
            if (!agent) throw new Error('Agent tidak ditemukan');

            /* phone already defined */
            const actorName = phone ? `Admin WA (${phone})` : 'Admin WA';
            const note = String(parsed.note || '').trim() || 'Transfer saldo via WhatsApp';
            const r = agentSvc.topupAgent(agent.id, amount, note, actorName);
            await reply(
              `✅ *TOPUP AGENT BERHASIL*\n\n` +
              `👤 Agent: *${agent.name}* (@${agent.username})\n` +
              `💸 Nominal: Rp ${Number(amount || 0).toLocaleString('id-ID')}\n` +
              `💳 Saldo: Rp ${Number(r.before || 0).toLocaleString('id-ID')} ➜ Rp ${Number(r.after || 0).toLocaleString('id-ID')}\n` +
              `📝 Catatan: ${note}`
            );
          } catch (e) {
            await reply('❌ Gagal topup agent: ' + e.message);
          }
          return true;
        }

        if (parsed.cmd === 'agent_pulsa') {
          try {
            /* phone already defined */
            const agent = phone ? agentSvc.getAgentByPhone(phone) : null;

            const sku = String(parsed.sku || '').trim();
            const target = String(parsed.target || '').trim();
            const sellPrice = Math.max(0, Math.floor(Number(parsed.sellPrice || 0) || 0));

            if (agent) {
              const result = await agentSvc.buyPulsaAsAgent(agent.id, sku, target, { sell_price: sellPrice });
              const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
              const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';

              const lines = [];
              lines.push(`${icon} *TRANSAKSI PULSA*`);
              lines.push('');
              lines.push(`👤 Agent: *${agent.name}* (@${agent.username})`);
              lines.push(`📦 SKU: *${sku}*`);
              lines.push(`🎯 Target: *${target}*`);
              lines.push(`🧾 TX ID: *#${result?.tx?.id || '-'}*`);
              lines.push(`🧾 Ref ID: *${result?.tx?.digi_ref_id || '-'}*`);
              lines.push(`📡 Status: *${status.toUpperCase()}*`);
              if (result?.tx?.digi_sn) lines.push(`🔢 SN: *${result.tx.digi_sn}*`);
              if (result?.tx?.digi_message) lines.push(`💬 Pesan: ${result.tx.digi_message}`);
              lines.push(`💰 Potong Saldo: Rp ${(Number(result?.tx?.amount_sell || 0) || 0).toLocaleString('id-ID')}`);
              lines.push(`💳 Sisa Saldo: Rp ${(Number(result?.agent?.balance || 0) || 0).toLocaleString('id-ID')}`);
              if (status === 'pending') lines.push(`\nKetik: \`cekpulsa ${result?.tx?.id || ''}\` untuk cek ulang.`);
              await reply(lines.join('\n'));
              return true;
            }

            if (!isAdmin) {
              await reply('❌ Nomor ini tidak terdaftar sebagai agent.');
              return true;
            }

            const result = await agentSvc.buyPulsaAsAdmin({
              sku,
              target,
              actorPhone: phone || '',
              actorName: 'WhatsApp Admin'
            });
            const status = String(result?.tx?.status || 'pending').toLowerCase();
            const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
            const lines = [];
            lines.push(`${icon} *TRANSAKSI PULSA (ADMIN)*`);
            lines.push('');
            lines.push(`📦 SKU: *${sku}*`);
            lines.push(`🎯 Target: *${target}*`);
            lines.push(`🧾 TX ID: *#${result?.tx?.id || '-'}*`);
            lines.push(`🧾 Ref ID: *${result?.tx?.ref_id || '-'}*`);
            lines.push(`📡 Status: *${status.toUpperCase()}*`);
            if (result?.tx?.sn) lines.push(`🔢 SN: *${result.tx.sn}*`);
            if (result?.tx?.message) lines.push(`💬 Pesan: ${result.tx.message}`);
            if (Number(result?.tx?.price || 0) > 0) lines.push(`💰 Harga Vendor: Rp ${Number(result.tx.price || 0).toLocaleString('id-ID')}`);
            if (status === 'pending') lines.push(`\nKetik: \`cekpulsa ${result?.tx?.id || ''}\` untuk cek ulang.`);
            await reply(lines.join('\n'));
          } catch (e) {
            await reply('❌ Gagal transaksi pulsa: ' + e.message);
          }
          return true;
        }

        if (parsed.cmd === 'agent_pulsa_check') {
          try {
            /* phone already defined */
            const agent = phone ? agentSvc.getAgentByPhone(phone) : null;
            const txId = Number(String(parsed.txId || '').replace(/[^\d]/g, '')) || 0;
            if (!txId) {
              await reply('❌ Format salah. Gunakan: `cekpulsa TXID`');
              return true;
            }

            if (agent) {
              const result = await agentSvc.checkPulsaStatusAsAgent(agent.id, txId);
              const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
              const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
              const lines = [];
              lines.push(`${icon} *STATUS PULSA*`);
              lines.push('');
              lines.push(`🧾 TX ID: *#${txId}*`);
              lines.push(`🧾 Ref ID: *${result?.tx?.digi_ref_id || '-'}*`);
              lines.push(`📡 Status: *${status.toUpperCase()}*`);
              if (result?.tx?.digi_sn) lines.push(`🔢 SN: *${result.tx.digi_sn}*`);
              if (result?.tx?.digi_message) lines.push(`💬 Pesan: ${result.tx.digi_message}`);
              await reply(lines.join('\n'));
              return true;
            }

            if (!isAdmin) {
              await reply('❌ Nomor ini tidak terdaftar sebagai agent.');
              return true;
            }

            const result = await agentSvc.checkPulsaStatusAsAdmin(txId);
            const status = String(result?.tx?.status || 'pending').toLowerCase();
            const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
            const lines = [];
            lines.push(`${icon} *STATUS PULSA (ADMIN)*`);
            lines.push('');
            lines.push(`🧾 TX ID: *#${txId}*`);
            lines.push(`🧾 Ref ID: *${result?.tx?.ref_id || '-'}*`);
            lines.push(`📡 Status: *${status.toUpperCase()}*`);
            if (result?.tx?.sn) lines.push(`🔢 SN: *${result.tx.sn}*`);
            if (result?.tx?.message) lines.push(`💬 Pesan: ${result.tx.message}`);
            await reply(lines.join('\n'));
          } catch (e) {
            await reply('❌ Gagal cek status pulsa: ' + e.message);
          }
          return true;
        }

        if (parsed.admin && parsed.targetTag) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            return true;
          }
          const targetTag = await resolveTargetTagForAdmin(parsed.targetTag);
          const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
          if (!targetDevice) {
            await reply(`❌ Target *${parsed.targetTag}* tidak ditemukan di GenieACS.`);
            return true;
          }
          if (parsed.cmd === 'info') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatInfo(data));
            return true;
          }
          if (parsed.cmd === 'cekterhubung') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatCekTerhubung(data));
            return true;
          }
          if (parsed.cmd === 'gantissid') {
            if (!parsed.rest) {
              await reply('❌ Format salah. Gunakan: \`gantissid TAG namaSSID\`');
              return true;
            }
            const ok = await customerDevice.updateSSID(targetTag, parsed.rest);
            if (ok) {
              await reply(`✅ SSID untuk *${targetTag}* berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
              // Kirim notifikasi ke pelanggan
              const now = getNowLocal();
              const cust = customerSvc.findCustomerByAny(targetTag);
              const custName = cust?.name ? `👤 *Pelanggan:* ${cust.name}\n` : '';
              const notifMsg =
                `📶 *PERUBAHAN SSID WIFI*\n\n` +
                custName +
                `🏷️ *Tag/ID:* ${targetTag}\n` +
                `🕒 *Waktu:* ${now}\n\n` +
                `SSID WiFi Anda sudah diperbarui oleh Admin menjadi:\n` +
                `📡 *${parsed.rest}*\n\n` +
                `Jika perangkat belum tersambung, silakan pilih SSID baru di HP/laptop Anda.\n` +
                `⚠️ Jangan bagikan info ini ke orang lain.`;
              const notifSent = await notifyCustomer(currentSockInstance, currentLidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah SSID.');
            }
            return true;
          }
          if (parsed.cmd === 'gantisandi') {
            if (!parsed.rest || parsed.rest.length < 8) {
              await reply('❌ Sandi minimal 8 karakter.');
              return true;
            }
            const ok = await customerDevice.updatePassword(targetTag, parsed.rest);
            if (ok) {
              await reply('✅ Password WiFi berhasil diubah.');
              // Kirim notifikasi ke pelanggan
              const now = getNowLocal();
              const cust = customerSvc.findCustomerByAny(targetTag);
              const custName = cust?.name ? `👤 *Pelanggan:* ${cust.name}\n` : '';
              const notifMsg =
                `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
                custName +
                `🏷️ *Tag/ID:* ${targetTag}\n` +
                `🕒 *Waktu:* ${now}\n\n` +
                `Password WiFi Anda sudah diperbarui oleh Admin menjadi:\n` +
                `🔐 *${parsed.rest}*\n\n` +
                `Silakan gunakan password baru untuk terhubung.\n` +
                `⚠️ Jangan bagikan password ini ke orang lain.`;
              const notifSent = await notifyCustomer(currentSockInstance, currentLidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah password.');
            }
            return true;
          }
          if (parsed.cmd === 'reboot') {
            const r = await customerDevice.requestReboot(targetTag);
            await reply(`🔄 *${targetTag}*\n\n${r.message}`);
            return true;
          }
        }

        if (parsed.cmd === 'daftar') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`daftar 081234567890\`\n\n(gunakan tag/nomor yang sama dengan di GenieACS)');
            return true;
          }
          const dev = await customerDevice.resolveDeviceToken(parsed.rest);
          if (!dev) {
            await reply('❌ Tag/nomor tidak ditemukan di GenieACS. Periksa penulisan atau hubungi admin.');
            return true;
          }
          const nk = normalizeKey(msgKey);
          const tagKey = String(parsed.rest || '').trim();
          if (currentLidStore) {
            currentLidStore.set((msgKey.remoteJid || phone), tagKey);
            if (nk.senderLid) currentLidStore.set(nk.senderLid, tagKey);
            if (nk.senderPn) currentLidStore.set(nk.senderPn, tagKey);
          }
          await reply(`✅ Berhasil! Nomor WA ini diikat ke tag:\n\n📍 *${tagKey}*\n\nSilakan gunakan perintah lain.`);
          return true;
        }

        const ctx = await resolveCustomerContext(msgKey, currentLidStore);
        if (!ctx) {
          await reply(
            '❌ Nomor/tag Anda belum dikenali (sering terjadi jika WA memakai @lid).\n\n' +
            'Kirim sekali:\n\`daftar NOMORATAUTAG\`\n(sama persis dengan tag di GenieACS), lalu ulangi perintah.'
          );
          return true;
        }

        if (parsed.cmd === 'cektagihan') {
          const invoices = billingSvc.getInvoicesByAny(ctx.billingKey);
          await reply(formatCustomerInvoices(invoices, ctx.billingKey));
          return true;
        }

        if (parsed.cmd === 'info') {
          const data = await customerDevice.getCustomerDeviceData(ctx.deviceKey);
          await reply(formatInfo(data));
          return true;
        }

        if (parsed.cmd === 'cekterhubung') {
          const data = await customerDevice.getCustomerDeviceData(ctx.deviceKey);
          await reply(formatCekTerhubung(data));
          return true;
        }

        if (parsed.cmd === 'gantissid') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantissid NamaWiFiBaru\`');
            return true;
          }
          const ok = await customerDevice.updateSSID(ctx.deviceKey, parsed.rest);
          if (ok) {
            await reply(`✅ SSID berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
            // Kirim notifikasi konfirmasi ke pelanggan via WA
            try {
              const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
              if (cust && cust.phone) {
                const now = getNowLocal();
                const notifMsg =
                  `📶 *PERUBAHAN SSID WIFI*\n\n` +
                  `👤 *Pelanggan:* ${cust.name}\n` +
                  `🕒 *Waktu:* ${now}\n\n` +
                  `SSID WiFi Anda sudah diperbarui menjadi:\n` +
                  `📡 *${parsed.rest}*\n\n` +
                  `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
                  `⚠️ Jangan bagikan info ini ke orang lain.`;
                await notifyCustomer(currentSockInstance, currentLidStore, ctx.deviceKey, notifMsg);
              }
            } catch (e) { /* ignore notification errors */ }
          } else {
            await reply('❌ Gagal mengubah SSID. Coba lagi atau hubungi admin.');
          }
          return true;
        }

        if (parsed.cmd === 'gantisandi') {
          if (!parsed.rest || parsed.rest.length < 8) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantisandi sandibarumin8huruf\`\n\nSandi minimal 8 karakter.');
            return true;
          }
          const ok = await customerDevice.updatePassword(ctx.deviceKey, parsed.rest);
          if (ok) {
            await reply('✅ Password WiFi berhasil diubah.');
            // Kirim notifikasi konfirmasi ke pelanggan via WA
            try {
              const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
              if (cust && cust.phone) {
                const now = getNowLocal();
                const notifMsg =
                  `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
                  `👤 *Pelanggan:* ${cust.name}\n` +
                  `🕒 *Waktu:* ${now}\n\n` +
                  `Password WiFi Anda sudah diperbarui menjadi:\n` +
                  `🔐 *${parsed.rest}*\n\n` +
                  `Silakan gunakan password baru untuk terhubung.\n` +
                  `⚠️ Jangan bagikan password ini ke orang lain.`;
                await notifyCustomer(currentSockInstance, currentLidStore, ctx.deviceKey, notifMsg);
              }
            } catch (e) { /* ignore notification errors */ }
          } else {
            await reply('❌ Gagal mengubah password.');
          }
          return true;
        }

        if (parsed.cmd === 'reboot') {
          const r = await customerDevice.requestReboot(ctx.deviceKey);
          await reply(`🔄 *Reboot ONU*\n\n${r.message}`);
        }

  return true;
}

export async function startWhatsAppBot() {
  if (isStarting) {
    logger.info('WhatsApp: startWhatsAppBot sedang berjalan, melewati panggilan duplikat.');
    return;
  }
  isStarting = true;
  try {
    if (currentSock) {
      try {
        logger.info('WhatsApp: Menutup koneksi socket lama yang masih aktif sebelum reconnect...');
        currentSock.ev.removeAllListeners();
        currentSock.end();
      } catch (e) {
        logger.error('WhatsApp: Gagal menutup socket lama:', e.message);
      }
      currentSock = null;
    }

    const authFolder = path.resolve(projectRoot, getSetting('whatsapp_auth_folder', 'auth_info_baileys'));
    const lidMapPath = path.resolve(projectRoot, getSetting('whatsapp_lid_map_file', 'data/wa-lid-map.json'));
    const lidStore = getDefaultLidStore();

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    let version = [2, 3000, 1043857760]; // Fallback version terbaru
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest && latest.version) {
        version = latest.version;
      }
    } catch (err) {
      logger.warn(`WhatsApp: Gagal mengambil versi terbaru Baileys: ${err.message}. Menggunakan fallback.`);
    }

    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache,
      getMessage: async (key) => {
        if (key && key.id) {
          const storeKey = `${key.remoteJid || ''}:${key.id}`;
          const cached = sentMessageMap.get(storeKey);
          if (cached) return cached;
          const idOnly = key.id;
          for (const [k, v] of sentMessageMap.entries()) {
            if (k.endsWith(`:${idOnly}`)) return v;
          }
        }
        return undefined;
      },
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      logger: pino({ level: 'silent' })
    });

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      whatsappStatus.lastUpdate = getCurrentDateInTimezone();

      if (qr) {
        whatsappStatus.qr = qr;
        whatsappStatus.connection = 'qr';
        qrShownSinceStart = true;
        notifiedAdminForQr = false;
        logger.info(`[WA] QR Code Baru Dihasilkan: ${qr.slice(0, 20)}...`);
        qrcode.generate(qr, { small: true });
        QRCodeNode.toDataURL(qr, { margin: 2, scale: 6 })
          .then((url) => {
            whatsappStatus.qrImage = url;
          })
          .catch(() => {
            whatsappStatus.qrImage = null;
          });
      }

      if (connection) {
        logger.info(`[WA] Connection Update: ${connection}`);
      }

      if (connection === 'close') {
        whatsappStatus.qr = null;
        whatsappStatus.qrImage = null;
        whatsappStatus.user = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        whatsappStatus.connection = code === DisconnectReason.loggedOut ? 'loggedOut' : 'connecting';

        logger.warn(
          `WhatsApp terputus (kode ${code}). ` +
          (code === DisconnectReason.loggedOut
            ? 'Sesi logout — hapus folder auth dan pindai QR lagi.'
            : 'Mencoba reconnect dalam 3 detik...')
        );
        if (shouldReconnect) {
          setTimeout(() => startWhatsAppBot(), 3000);
        }
      } else if (connection === 'open') {
        whatsappStatus.qr = null;
        whatsappStatus.qrImage = null;
        whatsappStatus.connection = 'open';
        whatsappStatus.user = sock.user;
        logger.info('WhatsApp bot terhubung. Akun Bot JID: ' + (sock.user?.id || 'unknown') + ', Name: ' + (sock.user?.name || 'unknown'));

        // Pre-resolve admin LIDs
        (async () => {
          try {
            const adminList = getWhatsappAdminNumbers();
            for (const n of adminList) {
              const digits = String(n).replace(/\D/g, '');
              if (digits.length >= 8) {
                const formatted = digits.startsWith('0') ? '62' + digits.slice(1) : digits.startsWith('62') ? digits : '62' + digits;
                const jid = `${formatted}@s.whatsapp.net`;
                const waCheck = await sock.onWhatsApp(jid).catch(() => []);
                if (waCheck && waCheck.length > 0 && waCheck[0].exists && waCheck[0].lid) {
                  const lidJid = waCheck[0].lid;
                  const lidUser = lidJid.split('@')[0];
                  lidStore.set(lidJid, formatted);
                  lidStore.set(lidUser, formatted);
                  logger.info(`[WA Admin Pre-resolve] Nomor admin ${formatted} terpetakan ke LID: ${lidJid}`);
                }
              }
            }
          } catch (e) {
            logger.warn(`[WA Admin Pre-resolve] Pre-resolve error: ${e.message}`);
          }
        })();

        if (qrShownSinceStart && !notifiedAdminForQr) {
          notifiedAdminForQr = true;
          const toList = loadWhatsappAdminSendList();
          if (toList.length > 0) {
            const wid = sock.user?.id ? String(sock.user.id).split(':')[0] : '-';
            const body =
              `✅ QR berhasil dipindai dan bot sudah aktif.\n\n` +
              `Nomor Bot: ${wid}\n` +
              `Waktu: ${getNowLocal()}\n\n` +
              `Silakan gunakan menu Admin untuk fitur billing, notifikasi, dan broadcast.\n\n` +
              `🙏 Jika aplikasi ini bermanfaat dan Anda ingin mendukung pengembangan, Anda dapat berdonasi secara sukarela ke nomor: 081947215703.\n` +
              `Terima kasih atas dukungannya.`;
            const msg = waWrap('🤖 *WHATSAPP BOT AKTIF*', body);
            for (const digits of toList) {
              const jid = `${digits}@s.whatsapp.net`;
              sock.sendMessage(jid, { text: msg }).then(res => {
                if (res && res.key && res.message) cacheSentMessage(res.key, res.message);
              }).catch(() => { });
            }
          }
          qrShownSinceStart = false;
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (m.key && m.message) {
            cacheSentMessage(m.key, m.message);
          }
          const selfPn = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
          const selfLid = sock.user && sock.user.lid ? sock.user.lid.split('@')[0] : null;
          const remoteUser = m.key.remoteJid ? m.key.remoteJid.split('@')[0] : null;
          const isSelf = m.key.fromMe && (remoteUser === selfPn || (selfLid && remoteUser === selfLid));
          if (m.key.fromMe && !isSelf) continue;
          const text = getMessageText(m);
          if (!text) continue;

          const remote = m.key.remoteJid;
          if (!remote || remote.endsWith('@g.us')) continue;

          const reply = async (msg) => {
            logger.info(`[WA reply] Menyiapkan balasan ke ${remote}: "${msg.substring(0, 60)}..."`);
            try {
              const targetJid = remote;
              logger.info(`[WA reply] Mengirim balasan ke JID target: ${targetJid}`);
              const result = await sock.sendMessage(targetJid, { text: waAutoWrap(msg) }, { quoted: m });
              if (result && result.key && result.message) {
                cacheSentMessage(result.key, result.message);
              }
              logger.info(`[WA reply] Balasan berhasil dikirim ke JID target: ${targetJid}`);
            } catch (sendErr) {
              logger.error('[WA reply] Gagal mengirim balasan: ' + sendErr.message);
            }
          };

          const phone = getPhoneFromKey(m.key);
          await processIncomingCommand({
            senderPhone: phone,
            text: text,
            reply: reply,
            senderName: m.pushName || '',
            key: m.key,
            sock: sock,
            lidStore: lidStore
          });
        } catch (e) {
          logger.error('WhatsApp message handler:', e.message || e);
        }
      }
    });
  } catch (err) {
    logger.error('Gagal inisialisasi Baileys WhatsApp bot:', err);
    throw err;
  } finally {
    isStarting = false;
  }
}
