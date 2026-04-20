import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const { logger } = require('../config/logger.js');
const { getSetting } = require('../config/settingsManager.js');
const customerDevice = require('./customerDeviceService.js');
const { WaLidStore } = require('./waLidStore.js');
const billingSvc = require('./billingService.js');
const mikrotikSvc = require('./mikrotikService.js');
const customerSvc = require('./customerService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

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
      const tag = customer.genieacs_tag || customer.pppoe_username;
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

function formatInfo(data) {
  if (!data) return '❌ Data perangkat tidak ditemukan di GenieACS.';
  
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  
  const header = `📱 *INFO PERANGKAT ONU*\n${'─'.repeat(30)}\n📊 *${companyHeader}*\n${'─'.repeat(30)}\n`;
  const footer = `\n${'─'.repeat(30)}\n${footerInfo}`;
  
  const lines = [
    `🟢 *Status:* ${data.status}`,
    `📶 *SSID:* ${data.ssid}`,
    `⏱️ *Last Inform:* ${data.lastInform}`,
    `📡 *RX Power:* ${data.rxPower}`,
    `🌐 *PPPoE IP:* ${data.pppoeIP}`,
    `👤 *PPPoE User:* ${data.pppoeUsername}`,
    `⏳ *Uptime:* ${data.uptime}`,
    `📱 *User WiFi (2.4G):* ${data.totalAssociations}`,
    `🔧 *Model:* ${data.model}`,
    `🏷️ *Serial Number:* ${data.serialNumber}`,
    `💾 *Firmware:* ${data.softwareVersion}`,
    `📍 *Tag:* ${data.lokasi}`
  ];
  
  return header + lines.join('\n') + footer;
}

function formatCekTerhubung(data) {
  if (!data) return '❌ Data tidak tersedia.';
  const list = data.connectedUsers || [];
  
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const footerInfo = getSetting('footer_info', 'Internet Tanpa Batas');
  
  const header = `📱 *PERANGKAT TERHUBUNG*\n${'─'.repeat(30)}\n📊 *${companyHeader}*\n${'─'.repeat(30)}\n`;
  const footer = `\n${'─'.repeat(30)}\n${footerInfo}`;
  
  if (list.length === 0) {
    return header + `\n❌ Tidak ada entri host/perangkat terhubung di data ONU.` + footer;
  }
  
  const content = `📊 *${list.length} perangkat tercatat:*\n`;
  const rows = list.slice(0, 25).map((u, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `${num}. 📱 ${u.hostname}\n   🌐 ${u.ip} | ${u.status}`;
  }).join('\n\n');
  const tail = list.length > 25 ? `\n\n_…dan ${list.length - 25} perangkat lainnya_` : '';
  
  return header + content + rows + tail + footer;
}

function formatBillingSummary(stats) {
  const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
  const header = `💰 *RINGKASAN BILLING*\n${'─'.repeat(30)}\n🏢 *${companyHeader}*\n${'─'.repeat(30)}\n`;
  
  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
  
  return header + 
    `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
    `📅 *Bulan Ini:* ${formatter.format(stats.thisMonth)}\n` +
    `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
    `🧾 *Tagihan Belum Lunas:* ${stats.unpaidCount} invoice\n` +
    `─`.repeat(30) + `\n💡 _Ketik \`tagihan\` untuk detail_`;
}

function formatCustomerInvoices(invoices, name) {
  const header = `🧾 *STATUS TAGIHAN*\n👤 *${name}*\n${'─'.repeat(30)}\n`;
  if (!invoices || invoices.length === 0) return header + "✅ Anda tidak memiliki tagihan. Terima kasih!";
  
  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
  
  const list = invoices.map(inv => {
    const status = inv.status === 'paid' ? '✅ LUNAS' : '❌ BELUM BAYAR';
    return `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n💰 *Total:* ${formatter.format(inv.amount)}\n📌 *Status:* ${status}\n🆔 *ID:* ${inv.id}`;
  }).join('\n\n');
  
  return header + list + `\n\n${'─'.repeat(30)}\n💡 _Gunakan ID Tagihan saat konfirmasi pembayaran_`;
}

function formatActiveMikrotik(pppoe, hotspot) {
  const header = `🌐 *MIKROTIK ACTIVE*\n${'─'.repeat(30)}\n`;
  const p = `👥 *PPPoE Active:* ${pppoe.length} user\n` + pppoe.slice(0, 10).map(u => `  ◦ ${u.name} (${u.address})`).join('\n') + (pppoe.length > 10 ? '\n  _...dll_' : '');
  const h = `\n\n🔥 *Hotspot Active:* ${hotspot.length} user\n` + hotspot.slice(0, 10).map(u => `  ◦ ${u.user} (${u.address})`).join('\n') + (hotspot.length > 10 ? '\n  _...dll_' : '');
  return header + p + h;
}

function loadWhatsappAdminSet() {
  const raw = getSetting('whatsapp_admin_numbers', []);
  const list = Array.isArray(raw) ? raw : raw != null && String(raw).trim() !== '' ? [String(raw)] : [];
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
  return set;
}

/** Admin dikenali dari nomor WA (bukan @lid saja). Pakai senderPn atau remoteJid @s.whatsapp.net */
function isWhatsappAdminKey(key, adminSet) {
  if (!adminSet || adminSet.size === 0) return false;
  const nk = normalizeKey(key);
  const pnJid =
    nk.senderPn && nk.senderPn.endsWith('@s.whatsapp.net')
      ? nk.senderPn
      : nk.remoteJid && nk.remoteJid.endsWith('@s.whatsapp.net')
        ? nk.remoteJid
        : null;
  if (!pnJid) return false;
  const digits = customerDevice.phoneFromPnJid(pnJid);
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
  const cmd = parts[0].toLowerCase();
  const rest = t.slice(parts[0].length).trim();

  if (['menu', 'bantuan', 'help'].includes(cmd)) return { cmd: 'menu', rest: '' };

  if (isAdmin && ['adminmenu', 'menuadmin'].includes(cmd)) return { cmd: 'adminmenu', rest: '' };

  if (isAdmin && ['listonu', 'listdevice', 'daftarperangkat'].includes(cmd)) {
    return { cmd: 'listonu', admin: true };
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
  if (isAdmin && cmd === 'lunas' && parts.length >= 2) return { cmd: 'lunas', admin: true, targetId: parts[1] };
  if (isAdmin && cmd === 'generate' && parts.length >= 3) return { cmd: 'generate', admin: true, month: parts[1], year: parts[2] };
  if (isAdmin && cmd === 'isolir' && parts.length >= 2) return { cmd: 'isolir', admin: true, targetId: parts[1] };
  if (isAdmin && cmd === 'buka' && parts.length >= 2) return { cmd: 'buka', admin: true, targetId: parts[1] };

  if (isAdmin && cmd === 'info' && parts.length >= 2) {
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

  // Customer Commands
  if (cmd === 'cektagihan') return { cmd: 'cektagihan', rest: '' };
  if (cmd === 'info') return { cmd: 'info', rest: '' };
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
  if (cust && cust.genieacs_tag) {
    return cust.genieacs_tag;
  }
  
  // 2. Fallback: Cari langsung di GenieACS (by Tag/Serial)
  const found = await customerDevice.findDeviceWithTagVariants(tagToken);
  return found ? found.canonicalTag : null;
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
    const pppoeUsername = d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value || '-';
    const li = d._lastInform ? new Date(d._lastInform).toLocaleString('id-ID') : '-';
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
  try {
    // Cari JID pelanggan berdasarkan tag
    const customerJid = lidStore.getByTag(tag);
    if (customerJid) {
      await sock.sendMessage(customerJid, { text: message });
      return true;
    }
    // Jika tidak ditemukan di lidStore, coba kirim ke nomor tag langsung
    const phoneNumber = tag.replace(/\D/g, '');
    if (phoneNumber.length >= 10) {
      const directJid = `${phoneNumber}@s.whatsapp.net`;
      await sock.sendMessage(directJid, { text: message });
      return true;
    }
    return false;
  } catch (e) {
    logger.error('Gagal mengirim notifikasi ke pelanggan:', e.message || e);
    return false;
  }
}

const MENU_TEXT =
  `📱 *MENU PELANGGAN*
${'─'.repeat(30)}

📋 *Perintah Tersedia:*

🔹 \`menu\` — Tampilkan bantuan ini
🔹 \`info\` — Ringkasan ONU Anda
🔹 \`cektagihan\` — Lihat status tagihan
🔹 \`cekterhubung\` — Daftar host terhubung
🔹 \`gantissid\` _nama_ — Ubah nama WiFi
🔹 \`gantisandi\` _sandi_ — Ubah password
🔹 \`reboot\` — Restart ONU
🔹 \`daftar\` _tag/nomor_ — Bind nomor WA

${'─'.repeat(30)}
💡 *Contoh:* \`cektagihan\``;

const ADMIN_MENU_TEXT =
  `🛠️ *MENU ADMIN*
${'─'.repeat(30)}

📡 *MikroTik:*
🔹 \`mtactive\` — User active saat ini
🔹 \`kickuser\` _user_ — Putus session active
🔹 \`addpppoe\` _user pass profile_
🔹 \`editpppoe\` _user profile_
🔹 \`delpppoe\` _user_
🔹 \`addhotspot\` _user pass profile_
🔹 \`vcr\` _kode profile_ — User=Pass + Comment
🔹 \`delhotspot\` _user_

💰 *Billing:*
🔹 \`ringkasan\` — Statistik billing
🔹 \`lunas\` _ID_ — Tandai lunas ID tagihan
🔹 \`generate\` _bln thn_ — Generate tagihan

👥 *Pelanggan:*
🔹 \`isolir\` _ID_ — Suspend pelanggan
🔹 \`buka\` _ID_ — Aktifkan pelanggan

📱 *Device ONU:*
🔹 \`listonu\` — Daftar semua ONU
🔹 \`info\` _TAG_ — Detail ONU
🔹 \`reboot\` _TAG_ — Restart ONU

${'─'.repeat(30)}
💡 _Tanpa TAG = perintah untuk device yang terikat ke WA Anda._`;

export const whatsappStatus = {
  connection: 'connecting',
  qr: null,
  user: null,
  lastUpdate: new Date()
};

let currentSock = null;

export async function sendWA(to, text) {
  if (!currentSock) {
    logger.warn('WhatsApp: Gagal kirim pesan, bot belum terhubung.');
    return false;
  }
  try {
    let digits = to.replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    const jid = to.includes('@') ? to : `${digits}@s.whatsapp.net`;
    await currentSock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    logger.error('Gagal kirim WA:', e.message);
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

export async function startWhatsAppBot() {
  const authFolder = path.resolve(projectRoot, getSetting('whatsapp_auth_folder', 'auth_baileys'));
  const lidMapPath = path.resolve(projectRoot, getSetting('whatsapp_lid_map_file', 'data/wa-lid-map.json'));
  const lidStore = new WaLidStore(lidMapPath);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ALIJAYA WEBPORTAL', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: true,
    logger: pino({ level: 'silent' })
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    whatsappStatus.lastUpdate = new Date();
    
    if (qr) {
      whatsappStatus.qr = qr;
      whatsappStatus.connection = 'qr';
      logger.info(`[WA] QR Code Baru Dihasilkan: ${qr.slice(0, 20)}...`);
      qrcode.generate(qr, { small: true });
    }
    
    if (connection) {
      logger.info(`[WA] Connection Update: ${connection}`);
    }
    
    if (connection === 'close') {
      whatsappStatus.qr = null;
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
      whatsappStatus.connection = 'open';
      whatsappStatus.user = sock.user;
      logger.info('WhatsApp bot terhubung');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue;
        const text = getMessageText(m);
        if (!text) continue;

        const remote = m.key.remoteJid;
        if (!remote || remote.endsWith('@g.us')) continue;

        const adminSet = loadWhatsappAdminSet();
        const isAdmin = isWhatsappAdminKey(m.key, adminSet);
        const parsed = parseCommand(text, isAdmin);
        if (!parsed) continue;

        const reply = async (msg) => {
          await sock.sendMessage(remote, { text: msg }, { quoted: m });
        };

        if (parsed.cmd === 'menu') {
          let body = MENU_TEXT;
          if (isAdmin) body += '\n\n_Anda admin — ketik `adminmenu` untuk perintah kelola semua tag._';
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'adminmenu') {
          if (!isAdmin) {
            await reply('❌ Perintah ini khusus nomor admin (pengaturan whatsapp_admin_numbers).');
            continue;
          }
          await reply(ADMIN_MENU_TEXT);
          continue;
        }

        if (parsed.cmd === 'listonu' && parsed.admin) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          const res = await customerDevice.listDevicesWithTags(300);
          if (!res.ok) {
            await reply('❌ ' + (res.message || 'Gagal mengambil daftar.'));
            continue;
          }
          const body = formatListOnu(res.devices);
          const chunks = splitWaChunks(body);
          for (const ch of chunks) {
            await reply(ch);
          }
          continue;
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
          continue;
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
          continue;
        }

        if (parsed.admin && parsed.cmd === 'addpppoe') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addPppoeSecret({ name: user, password: pass, profile, service: 'pppoe' });
            await reply(`✅ PPPoE Secret *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah PPPoE: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'editpppoe') {
          try {
            const [user, profile] = parsed.args;
            await mikrotikSvc.setPppoeProfile(user, profile);
            await reply(`✅ Profile PPPoE *${user}* berhasil diubah ke *${profile}* dan session aktif telah diputus.`);
          } catch (e) {
            await reply('❌ Gagal edit PPPoE: ' + e.message);
          }
          continue;
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
          continue;
        }

        if (parsed.admin && parsed.cmd === 'addhotspot') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addHotspotUser({ name: user, password: pass, profile });
            await reply(`✅ Hotspot User *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah Hotspot: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'vcr') {
          try {
            const [code, profile] = parsed.args;
            const now = new Date();
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
          continue;
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
          continue;
        }

        // Admin Billing Logic
        if (parsed.admin && parsed.cmd === 'ringkasan') {
          const stats = billingSvc.getDashboardStats();
          await reply(formatBillingSummary(stats));
          continue;
        }

        if (parsed.admin && parsed.cmd === 'lunas') {
          try {
            let targetInvId = parsed.targetId;
            let targetInv = billingSvc.getInvoiceById(targetInvId);
            
            // If not found by ID, try find customer and their oldest unpaid invoice
            if (!targetInv) {
              const cust = customerSvc.findCustomerByAny(parsed.targetId);
              if (cust) {
                const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
                if (unpaid && unpaid.length > 0) {
                  targetInv = unpaid[0]; // Take the oldest one
                  targetInvId = targetInv.id;
                } else {
                  return await reply(`✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`);
                }
              }
            }

            if (!targetInv) return await reply(`❌ Tagihan atau Pelanggan *${parsed.targetId}* tidak ditemukan.`);
            
            billingSvc.markAsPaid(targetInvId, 'WA Bot Admin', 'Paid via WhatsApp Command');
            
            const customer = customerSvc.getCustomerById(targetInv.customer_id);
            if (customer && customer.status === 'suspended') {
              const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
              if (freshCustomer && freshCustomer.unpaid_count === 0) {
                await customerSvc.activateCustomer(targetInv.customer_id);
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. Pelanggan *${targetInv.customer_name}* otomatis diaktifkan kembali.`);
              } else {
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. (Masih ada ${freshCustomer.unpaid_count} tagihan lain, isolir tetap aktif)`);
              }
            } else {
              await reply(`✅ Invoice *#${targetInvId}* (a.n ${targetInv.customer_name}) berhasil ditandai LUNAS.`);
            }
          } catch (e) {
            await reply('❌ Gagal update status: ' + e.message);
          }
          continue;
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
          continue;
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
          continue;
        }

        if (parsed.admin && parsed.cmd === 'generate') {
          try {
            const count = billingSvc.generateMonthlyInvoices(parseInt(parsed.month), parseInt(parsed.year));
            await reply(`✅ Berhasil generate *${count}* tagihan untuk periode ${parsed.month}/${parsed.year}.`);
          } catch (e) {
            await reply('❌ Gagal generate: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.targetTag) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          const targetTag = await resolveTargetTagForAdmin(parsed.targetTag);
          if (!targetTag) {
            await reply(`❌ Tag *${parsed.targetTag}* tidak ditemukan di GenieACS.`);
            continue;
          }
          if (parsed.cmd === 'info') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatInfo(data));
            continue;
          }
          if (parsed.cmd === 'cekterhubung') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatCekTerhubung(data));
            continue;
          }
          if (parsed.cmd === 'gantissid') {
            if (!parsed.rest) {
              await reply('❌ Format salah. Gunakan: \`gantissid TAG namaSSID\`');
              continue;
            }
            const ok = await customerDevice.updateSSID(targetTag, parsed.rest);
            if (ok) {
              await reply(`✅ SSID untuk *${targetTag}* berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
              // Kirim notifikasi ke pelanggan
              const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
              const notifMsg = `📢 *NOTIFIKASI PERUBAHAN WIFI*\n\n` +
                `Yth. Pelanggan ${companyHeader},\n\n` +
                `SSID WiFi Anda telah diubah oleh admin menjadi:\n\n` +
                `📶 *${parsed.rest}*\n\n` +
                `Silakan hubungi admin jika Anda memiliki pertanyaan.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah SSID.');
            }
            continue;
          }
          if (parsed.cmd === 'gantisandi') {
            if (!parsed.rest || parsed.rest.length < 8) {
              await reply('❌ Sandi minimal 8 karakter.');
              continue;
            }
            const ok = await customerDevice.updatePassword(targetTag, parsed.rest);
            if (ok) {
              await reply('✅ Password WiFi berhasil diubah.');
              // Kirim notifikasi ke pelanggan
              const companyHeader = getSetting('company_header', 'ALIJAYA WEBPORTAL');
              const notifMsg = `📢 *NOTIFIKASI PERUBAHAN PASSWORD*\n\n` +
                `Yth. Pelanggan ${companyHeader},\n\n` +
                `Password WiFi Anda telah diubah oleh admin menjadi:\n\n` +
                `🔑 *${parsed.rest}*\n\n` +
                `Silakan gunakan password baru untuk terhubung ke WiFi.\n` +
                `Hubungi admin jika Anda memiliki pertanyaan.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah password.');
            }
            continue;
          }
          if (parsed.cmd === 'reboot') {
            const r = await customerDevice.requestReboot(targetTag);
            await reply(`🔄 *${targetTag}*\n\n${r.message}`);
            continue;
          }
        }

        if (parsed.cmd === 'daftar') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`daftar 081234567890\`\n\n(gunakan tag/nomor yang sama dengan di GenieACS)');
            continue;
          }
          const found = await customerDevice.findDeviceWithTagVariants(parsed.rest);
          if (!found) {
            await reply('❌ Tag/nomor tidak ditemukan di GenieACS. Periksa penulisan atau hubungi admin.');
            continue;
          }
          const nk = normalizeKey(m.key);
          lidStore.set(remote, found.canonicalTag);
          if (nk.senderLid) lidStore.set(nk.senderLid, found.canonicalTag);
          if (nk.senderPn) lidStore.set(nk.senderPn, found.canonicalTag);
          await reply(`✅ Berhasil! Nomor WA ini diikat ke tag:\n\n📍 *${found.canonicalTag}*\n\nSilakan gunakan perintah lain.`);
          continue;
        }

        let tag = await resolveCustomerTag(m.key, lidStore);
        if (!tag) {
          await reply(
            '❌ Nomor/tag Anda belum dikenali (sering terjadi jika WA memakai @lid).\n\n' +
              'Kirim sekali:\n\`daftar NOMORATAUTAG\`\n(sama persis dengan tag di GenieACS), lalu ulangi perintah.'
          );
          continue;
        }

        if (parsed.cmd === 'cektagihan') {
          const invoices = billingSvc.getInvoicesByAny(tag);
          await reply(formatCustomerInvoices(invoices, tag));
          continue;
        }

        if (parsed.cmd === 'info') {
          const data = await customerDevice.getCustomerDeviceData(tag);
          await reply(formatInfo(data));
          continue;
        }

        if (parsed.cmd === 'cekterhubung') {
          const data = await customerDevice.getCustomerDeviceData(tag);
          await reply(formatCekTerhubung(data));
          continue;
        }

        if (parsed.cmd === 'gantissid') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantissid NamaWiFiBaru\`');
            continue;
          }
          const ok = await customerDevice.updateSSID(tag, parsed.rest);
          await reply(ok ? `✅ SSID berhasil diubah menjadi:\n\n📶 *${parsed.rest}*` : '❌ Gagal mengubah SSID. Coba lagi atau hubungi admin.');
          continue;
        }

        if (parsed.cmd === 'gantisandi') {
          if (!parsed.rest || parsed.rest.length < 8) {
            await reply('❌ Format salah. Gunakan:\n\n\`gantisandi sandibarumin8huruf\`\n\nSandi minimal 8 karakter.');
            continue;
          }
          const ok = await customerDevice.updatePassword(tag, parsed.rest);
          await reply(ok ? '✅ Password WiFi berhasil diubah.' : '❌ Gagal mengubah password.');
          continue;
        }

        if (parsed.cmd === 'reboot') {
          const r = await customerDevice.requestReboot(tag);
          await reply(`🔄 *Reboot ONU*\n\n${r.message}`);
        }
      } catch (e) {
        logger.error('WhatsApp message handler:', e.message || e);
      }
    }
  });
}
