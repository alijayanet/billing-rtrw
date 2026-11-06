const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const { getSetting, getNowLocal } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikSvc = require('./mikrotikService');
const agentSvc = require('./agentService');
const customerDevice = require('./customerDeviceService');
const whatsappService = require('./whatsappService');
const db = require('../config/database');
const telegramAi = require('./telegramAiService');

let bot = null;
let botMe = null;

function initTelegram() {
  const enabled = getSetting('telegram_enabled', false);
  const token = getSetting('telegram_bot_token', '');

  if (!enabled || !token) {
    if (bot) {
      bot.stopPolling();
      bot = null;
      logger.info('Telegram Bot: Dihentikan (Nonaktif)');
    }
    return;
  }

  // Jika token berubah, kita harus stop bot lama dan buat baru
  if (bot && bot.token !== token) {
    bot.stopPolling();
    bot = null;
    logger.info('Telegram Bot: Token berubah, me-restart bot...');
  }

  if (bot) {
    logger.info('Telegram Bot: Sudah berjalan, melewati inisialisasi.');
    return; 
  }

  bot = new TelegramBot(token, {
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10
      }
    },
    request: {
      family: 4
    }
  });
  
  bot.getMe().then(me => {
    botMe = me;
    logger.info(`Telegram Bot: Terhubung sebagai @${me.username} (ID: ${me.id})`);
  }).catch(e => logger.warn(`Telegram Bot getMe warn: ${e.message}`));

  bot.deleteWebHook().catch(() => {});

  // Middleware Admin Check (Fetch latest ID every time, dukung multiple ID dipisah koma)
  const isAdmin = (msg) => {
    if (!msg) return false;
    const rawSetting = String(getSetting('telegram_admin_id', '') || getSetting('telegram_admin_chat_id', '') || '');
    const adminIds = rawSetting.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const fromId = msg.from && msg.from.id != null ? String(msg.from.id).trim() : '';
    const chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id).trim() : '';
    return (fromId && adminIds.includes(fromId)) || (chatId && adminIds.includes(chatId));
  };

  // Helper Mikhmon Parser
  const parseMikhmon = (script) => {
    if (!script) return null;
    const s = String(script).trim();
    
    // Cari pattern :put (",rem, ... , ... , ...
    // Updated regex untuk support format: :put (",rem,4000,2d,5000,,Disable,");
    const putMatch = s.match(/:\s*put\s*\(\s*[",]rem[",]?\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)/i);
    if (putMatch) {
      const cost = String(putMatch[1] || '').trim();
      const validity = String(putMatch[2] || '').trim();
      const priceStr = String(putMatch[3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    // Fallback: split by comma
    const parts = s.split(',').map(p => String(p).trim());
    let remIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('rem')) {
        remIdx = i;
        break;
      }
    }
    
    if (remIdx >= 0 && remIdx + 3 < parts.length) {
      const cost = String(parts[remIdx + 1] || '').trim();
      const validity = String(parts[remIdx + 2] || '').trim();
      const priceStr = String(parts[remIdx + 3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    return null;
  };

  const isTruthy = (value) => {
    if (value === true || value === 1) return true;
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'on';
  };

  const formatGangguanCount = (scriptRow) => {
    const raw = scriptRow && scriptRow.source != null ? String(scriptRow.source) : '0';
    const count = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  };

  const loadPppoeSnapshot = async () => {
    const [secrets, active, scripts] = await Promise.all([
      mikrotikSvc.getPppoeSecrets(),
      mikrotikSvc.getPppoeActive(),
      mikrotikSvc.getSystemScripts()
    ]);
    const customers = customerSvc.getAllCustomers();

    const activeMap = new Map();
    (active || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) activeMap.set(name, row);
    });

    const scriptMap = new Map();
    (scripts || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) scriptMap.set(name, row);
    });

    const customerMap = new Map();
    (customers || []).forEach((row) => {
      const username = String(row && row.pppoe_username ? row.pppoe_username : '').trim();
      if (username) customerMap.set(username, row);
    });

    return {
      secrets: Array.isArray(secrets) ? secrets : [],
      active: Array.isArray(active) ? active : [],
      activeMap,
      scriptMap,
      customerMap
    };
  };

  const buildOfflineEntries = (snapshot) => {
    return snapshot.secrets
      .filter((secret) => {
        const username = String(secret && secret.name ? secret.name : '').trim();
        if (!username) return false;
        if (isTruthy(secret && secret.disabled)) return false;
        return !snapshot.activeMap.has(username);
      })
      .map((secret) => {
        const username = String(secret.name || '').trim();
        const customer = snapshot.customerMap.get(username) || null;
        const script = snapshot.scriptMap.get(username) || null;
        return {
          username,
          customerName: customer && customer.name ? customer.name : '-',
          phone: customer && customer.phone ? customer.phone : '-',
          profile: secret && secret.profile ? secret.profile : '-',
          service: secret && secret.service ? secret.service : '-',
          password: secret && secret.password ? secret.password : '-',
          failCount: formatGangguanCount(script)
        };
      })
      .sort((a, b) => {
        if (b.failCount !== a.failCount) return b.failCount - a.failCount;
        return a.username.localeCompare(b.username, 'id');
      });
  };

  const buildOfflineTelegramText = (snapshot) => {
    const now = getNowLocal();
    const offline = buildOfflineEntries(snapshot);
    const lines = [];
    lines.push('USER PPPoE OFFLINE');
    lines.push('============================');
    lines.push(`Waktu : ${now}`);
    lines.push('============================');
    lines.push('');
    lines.push('RINGKASAN');
    lines.push(`Total Secret : ${snapshot.secrets.length}`);
    lines.push(`Total Aktif  : ${snapshot.active.length}`);
    lines.push(`Total Offline: ${offline.length}`);
    lines.push('');
    lines.push('DAFTAR USER OFFLINE');

    if (offline.length === 0) {
      lines.push('Semua user sedang online.');
    } else {
      offline.slice(0, 20).forEach((row, index) => {
        lines.push(`${index + 1}. ${row.username}`);
        lines.push(`   Pelanggan : ${row.customerName}`);
        lines.push(`   WA        : ${row.phone}`);
        lines.push(`   Paket     : ${row.profile}`);
        lines.push(`   Gangguan  : ${row.failCount}x`);
      });
      if (offline.length > 20) {
        lines.push(`...dan ${offline.length - 20} user offline lainnya.`);
      }
    }

    lines.push('');
    lines.push('Cek detail 1 user: /cekpppoe username');
    lines.push('Contoh: /cekpppoe budi001');
    return lines.join('\n');
  };

  const buildPppoeUserDetailText = async (username) => {
    const target = String(username || '').trim();
    if (!target) throw new Error('Username PPPoE wajib diisi');

    const snapshot = await loadPppoeSnapshot();
    const secret = snapshot.secrets.find((row) => String(row && row.name ? row.name : '').trim() === target);
    if (!secret) {
      throw new Error(`PPPoE user "${target}" tidak ditemukan`);
    }

    const activeRow = snapshot.activeMap.get(target) || null;
    const customer = snapshot.customerMap.get(target) || null;
    const script = snapshot.scriptMap.get(target) || null;
    const offline = buildOfflineEntries(snapshot);

    const date = getNowLocal();
    const online = !!activeRow;
    const lines = [];
    lines.push('DETAIL CEK PPPoE');
    lines.push('============================');
    lines.push(`Waktu     : ${date}`);
    lines.push(`Status    : ${online ? 'ONLINE' : 'OFFLINE'}`);
    lines.push('============================');
    lines.push('INFO LAYANAN');
    lines.push(`Pelanggan : ${customer && customer.name ? customer.name : '-'}`);
    lines.push(`No. WA    : ${customer && customer.phone ? customer.phone : '-'}`);
    lines.push(`Username  : ${secret.name || '-'}`);
    lines.push(`Password  : ${secret.password || '-'}`);
    lines.push(`Service   : ${secret.service || '-'}`);
    lines.push(`Profile   : ${secret.profile || '-'}`);
    lines.push('');
    lines.push('INFO PERANGKAT');
    lines.push(`IP Aktif   : ${activeRow && activeRow.address ? activeRow.address : '-'}`);
    lines.push(`MAC/Caller : ${activeRow && (activeRow.callerId || activeRow['caller-id']) ? (activeRow.callerId || activeRow['caller-id']) : '-'}`);
    lines.push('');
    lines.push('STATUS GANGGUAN');
    lines.push(`Jumlah Gangguan : ${formatGangguanCount(script)}x Terputus`);
    lines.push(`Total Secret    : ${snapshot.secrets.length}`);
    lines.push(`Total Active    : ${snapshot.active.length}`);
    lines.push(`Total Offline   : ${offline.length}`);

    if (!online && offline.length) {
      lines.push('');
      lines.push('User Offline Lain');
      offline.slice(0, 10).forEach((row) => {
        lines.push(`- ${row.username} (${row.failCount}x)`);
      });
      if (offline.length > 10) lines.push(`...dan ${offline.length - 10} lainnya.`);
    }

    return lines.join('\n');
  };

  // Main Menu (Inline Keyboard for better visibility)
  const mainMenu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Statistik', callback_data: 'menu_stats' }, { text: '👥 Pelanggan', callback_data: 'menu_cust' }],
        [{ text: '🎫 Voucher', callback_data: 'menu_vouch' }, { text: '💰 Tagihan', callback_data: 'menu_bill' }],
        [{ text: '⚙️ MikroTik Status', callback_data: 'menu_mt' }],
        [{ text: '🔄 Refresh', callback_data: 'menu_main' }]
      ]
    }
  };

  bot.onText(/\/start|\/menu/i, (msg) => {
    if (isAdmin(msg)) {
      return bot.sendMessage(msg.chat.id, '🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', { parse_mode: 'Markdown', ...mainMenu });
    }
    
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      const helpText = `👋 Halo *${msg.from.first_name || 'Rekan'}*! Saya adalah Bot Asisten *RTRWNET Management & Billing System*.\n\n` +
        `💡 *Perintah Tersedia di Grup:*\n` +
        `• \`/tanya <pertanyaan>\` : Tanya jawab seputar fitur sistem\n` +
        `• Mention saya (@${botMe?.username || 'bot'}) untuk bertanya langsung\n` +
        `• \`/fitur\` : Ringkasan modul & fitur aplikasi\n` +
        `• \`/dns <domain>\` : Cek record DNS publik\n` +
        `• \`/ping <host>\` : Cek koneksi & latensi host\n` +
        `• \`/bantuan\` : Petunjuk penggunaan bot`;
      return bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    } else {
      return bot.sendMessage(msg.chat.id,
        `👋 Halo *${msg.from.first_name || ''}*!\n\n` +
        `Saya adalah Bot Asisten *RTRWNET Management & Billing System*.\n` +
        `Untuk akses menu admin penuh, pastikan ID Telegram Anda sudah terdaftar di Web Admin Settings.\n\n` +
        `🆔 *Chat ID Anda:* \`${msg.from.id}\`\n\n` +
        `💡 Anda juga bisa berkonsultasi seputar fitur aplikasi di sini: ketik \`/tanya <pertanyaan>\` atau ketik pertanyaan langsung!`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.on('message', async (msg) => {
    const fromId = msg.from ? msg.from.id : null;
    const fromName = msg.from ? (msg.from.first_name || msg.from.username || msg.from.id) : 'unknown';
    const chatType = msg.chat ? msg.chat.type : 'unknown';
    logger.info(`[TelegramBot] Pesan masuk dari ${fromName} (${fromId}) [chat: ${msg.chat?.id}, type: ${chatType}, isAdmin: ${isAdmin(msg)}]: "${(msg.text || '').slice(0, 60)}"`);

    // Helper kirim aman ber-chunking dan fallback jika markdown gagal
    const safeSendMessage = async (chatId, text, options = {}) => {
      if (!bot || !chatId || !text) return false;
      const str = String(text);
      const maxLen = 4000;
      const chunks = [];
      if (str.length <= maxLen) {
        chunks.push(str);
      } else {
        for (let i = 0; i < str.length; i += maxLen) {
          chunks.push(str.slice(i, i + maxLen));
        }
      }

      for (const chunk of chunks) {
        try {
          await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', ...options });
        } catch (mdErr) {
          await bot.sendMessage(chatId, chunk, { ...options }).catch((err2) => {
            logger.error(`[TelegramBot] Gagal kirim pesan ke ${chatId}: ${err2.message}`);
          });
        }
      }
      return true;
    };

    // 1. Sambutan Member Baru di Grup
    if (msg.new_chat_members && msg.new_chat_members.length > 0) {
      const isWelcomeOn = getSetting('telegram_welcome_enabled', true);
      if (isWelcomeOn) {
        const newcomers = msg.new_chat_members.filter(m => !botMe || m.id !== botMe.id);
        if (newcomers.length > 0) {
          const names = newcomers.map(u => u.first_name || 'Member').join(', ');
          const customMsg = getSetting('telegram_welcome_msg', '');
          const welcomeText = customMsg
            ? customMsg.replace(/\{nama\}/gi, names).replace(/\{bot\}/gi, botMe ? `@${botMe.username}` : 'bot')
            : `👋 Selamat datang *${names}* di grup diskusi *RTRWNET Management & Billing System*!\n\n` +
              `💡 Butuh info seputar fitur, billing, MikroTik, GenieACS, atau OLT? Tag @${botMe?.username || 'bot'} atau ketik \`/tanya <pertanyaan>\`.\n` +
              `Ketik \`/fitur\` untuk melihat rangkuman modul aplikasi.`;
          bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
      return;
    }

    const text = msg.text || '';
    if (!text || text === '/start' || text === '/menu') return;

    // Konfirmasi penghapusan pelanggan oleh Admin di Telegram Private Chat
    if (msg.chat.type === 'private' && isAdmin(msg) && /^ya\s+hapus\s+(\d+)[.!]?$/i.test(text.trim())) {
      const match = text.trim().match(/^ya\s+hapus\s+(\d+)[.!]?$/i);
      const custId = parseInt(match[1], 10);
      const cust = customerSvc.getCustomerById(custId);
      if (!cust) {
        return bot.sendMessage(msg.chat.id, `❌ Pelanggan dengan ID #${custId} tidak ditemukan atau sudah dihapus.`, { reply_to_message_id: msg.message_id });
      }
      try {
        await customerSvc.deleteCustomer(custId);
        return bot.sendMessage(msg.chat.id, `🗑️ *PELANGGAN BERHASIL DIHAPUS*\n\nData pelanggan *${cust.name}* (ID: #${custId}, No HP: ${cust.phone || '-'}) telah dihapus dari sistem billing.`, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
      } catch (err) {
        logger.error(`[TelegramBot] Gagal menghapus pelanggan #${custId}: ${err.message}`);
        return bot.sendMessage(msg.chat.id, `❌ Gagal menghapus pelanggan #${custId}: ${err.message}`, { reply_to_message_id: msg.message_id });
      }
    }

    // 2. Deteksi Pertanyaan untuk AI Asisten (di Grup atau Private Chat)
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const botUsername = botMe ? botMe.username.toLowerCase() : '';
    const lowerText = text.toLowerCase();

    const isMentioned = botUsername && lowerText.includes(`@${botUsername}`);
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && botMe && msg.reply_to_message.from.id === botMe.id;
    const isAskCommand = /^\/(?:tanya|ask|ai)(?:@\w+)?(?:\s+|$)/i.test(text);
    const isPrivAdmin = !isGroup && isAdmin(msg);
    const isGroupTrigger = isGroup && (isMentioned || isReplyToBot || isAskCommand);
    const isPrivateTrigger = isPrivAdmin && (!text.startsWith('/') || isAskCommand);

    if (isPrivAdmin && isPrivateTrigger) {
      // 1. Jalur Full Agentic AI untuk Admin di Private Chat (Selalu Aktif & Responsif Bebas Prefix)
      let cleanQuestion = text
        .replace(/^\/(?:tanya|ask|ai)(?:@\w+)?\s*/i, '')
        .trim();

      if (!cleanQuestion) {
        return bot.sendMessage(msg.chat.id, 'Halo Admin! Ada yang bisa saya bantu atau periksa di server hari ini?', {
          parse_mode: 'Markdown',
          reply_to_message_id: msg.message_id
        });
      }

      bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

      try {
        const answer = await telegramAi.askAi({
          question: cleanQuestion,
          senderName: msg.from.first_name || 'Admin',
          isAdmin: true,
          extraContext: {
            contextSource: 'telegram_admin',
            chatId: msg.chat.id
          }
        });

        await safeSendMessage(msg.chat.id, answer, {
          reply_to_message_id: msg.message_id
        });
      } catch (err) {
        logger.error(`[TelegramBot] Error AI response: ${err.message}`);
        safeSendMessage(msg.chat.id, `⚠️ Maaf, sedang terjadi kendala memproses instruksi: ${err.message}`, { reply_to_message_id: msg.message_id });
      }
      return;
    } else if (isGroupTrigger) {
      // 2. Jalur Grup / Anggota Umum
      const isAiEnabled = getSetting('telegram_group_ai_enabled', true);
      if (!isAiEnabled) {
        if (isAskCommand || isMentioned) {
          bot.sendMessage(msg.chat.id, 'Fitur Asisten AI grup sedang dinonaktifkan di pengaturan.', { reply_to_message_id: msg.message_id }).catch(() => {});
        }
        return;
      }

      let cleanQuestion = text
        .replace(new RegExp(`@${botUsername}`, 'gi'), '')
        .replace(/^\/(?:tanya|ask|ai)(?:@\w+)?\s*/i, '')
        .trim();

      if (!cleanQuestion) {
        return bot.sendMessage(msg.chat.id, 'Silakan tulis pertanyaan setelah perintah. Contoh: `/tanya bagaimana cara bayar tagihan?`', {
          parse_mode: 'Markdown',
          reply_to_message_id: msg.message_id
        });
      }

      bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

      try {
        const answer = await telegramAi.askAi({
          question: cleanQuestion,
          senderName: msg.from.first_name || 'Rekan',
          isAdmin: false,
          extraContext: {
            contextSource: 'telegram_group'
          }
        });

        await safeSendMessage(msg.chat.id, answer, {
          reply_to_message_id: msg.message_id
        });
      } catch (err) {
        logger.error(`[TelegramBot] Error AI response: ${err.message}`);
        safeSendMessage(msg.chat.id, '❌ Maaf, sedang terjadi kendala memproses jawaban. Silakan coba kembali.', { reply_to_message_id: msg.message_id });
      }
      return;
    }

    // 3. Khusus Pesan Manual Admin (Pertahankan logika asli)
    if (!isAdmin(msg)) return;
    // Logika handle text manual jika diperlukan (misal untuk perintah kick/edit)
  });

  // Callback Query Handling
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: 'Akses Ditolak' });

    if (data === 'menu_main') {
      bot.editMessageText('🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...mainMenu
      });
    }

    else if (data === 'menu_stats') {
      const stats = customerSvc.getCustomerStats();
      const billing = billingSvc.getDashboardStats();
      let res = `*📊 STATISTIK SISTEM*\n\n`;
      res += `👥 Pelanggan: ${stats.total}\n`;
      res += `✅ Aktif: ${stats.active}\n`;
      res += `🚫 Terisolir: ${stats.suspended}\n\n`;
      res += `💰 Pendapatan Bulan Ini: Rp ${billing.thisMonth.toLocaleString('id-ID')}\n`;
      res += `⏳ Belum Dibayar: ${billing.unpaidCount} Tagihan`;
      
      bot.sendMessage(chatId, res, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_main' }]] }
      });
    }

    else if (data === 'menu_cust') {
      bot.sendMessage(chatId, '👥 *MANAJEMEN PELANGGAN*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Cari Pelanggan', callback_data: 'cust_search' }],
            [{ text: '🚫 Daftar Terisolir', callback_data: 'cust_suspended' }],
            [{ text: '📡 List ONU (GenieACS)', callback_data: 'cust_listonu' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_bill') {
      bot.sendMessage(chatId, '💰 *MANAJEMEN TAGIHAN*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏳ Tagihan Belum Bayar', callback_data: 'bill_unpaid' }],
            [{ text: '📈 Pendapatan Hari Ini', callback_data: 'bill_today' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_vouch') {
      bot.sendMessage(chatId, '🎫 *MANAJEMEN VOUCHER*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Buat Voucher Baru', callback_data: 'vouch_create' }],
            [{ text: '📜 Daftar Hotspot Profile', callback_data: 'vouch_profiles' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }
    
    else if (data === 'menu_mt') {
      bot.sendMessage(chatId, '⚙️ *STATUS MIKROTIK*\nPilih data:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Resource System', callback_data: 'mt_resource' }],
            [{ text: '🟢 User Aktif (PPPoE/HS)', callback_data: 'mt_active' }],
            [{ text: '🔴 User Offline (PPPoE)', callback_data: 'mt_offline' }],
            [{ text: '🔑 List PPPoE Secrets', callback_data: 'mt_pppoe' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'mt_resource') {
      try {
        const res = await mikrotikSvc.getSystemResource();
        let txt = `*⚙️ MIKROTIK STATUS*\n\n`;
        txt += `Model: ${res.boardName || res['board-name'] || '-'}\n`;
        txt += `CPU: ${res.cpuLoad || res['cpu-load'] || '0'}%\n`;
        txt += `Uptime: ${res.uptime}\n`;
        txt += `Version: ${res.version}`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal mengambil data MikroTik: ' + e.message);
      }
    }

    else if (data === 'mt_active') {
      try {
        const pppoe = await mikrotikSvc.getPppoeActive();
        const hs = await mikrotikSvc.getHotspotActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        
        let txt = `*🟢 USER AKTIF*\n\n`;
        txt += `🌐 *PPPoE (${pppoe.length}):*\n`;
        pppoe.slice(0, 15).forEach(a => {
          const s = scripts.find(sc => sc.name === a.name);
          const failCount = s ? (s.source || '0') : '0';
          txt += `• \`${a.name}\` (${a.address}) [⚡${failCount}]\n`;
        });
        
        txt += `\n📶 *Hotspot (${hs.length}):*\n`;
        hs.slice(0, 5).forEach(h => {
          txt += `• \`${h.user}\` (${h.address})\n`;
        });
        
        txt += `\n_⚡ = Jumlah Gangguan Terdeteksi_`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_offline') {
      try {
        const snapshot = await loadPppoeSnapshot();
        bot.sendMessage(chatId, buildOfflineTelegramText(snapshot));
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_pppoe') {
      try {
        const secrets = await mikrotikSvc.getPppoeSecrets();
        let txt = `*🔑 PPPoE SECRETS (${secrets.length})*\n\n`;
        secrets.slice(0, 20).forEach(s => {
          txt += `• \`${s.name}\` (${s.profile})\n`;
        });
        if (secrets.length > 20) txt += `\n_Menampilkan 20 dari ${secrets.length}..._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'cust_search') {
      bot.sendMessage(chatId, '🔍 *CARI PELANGGAN*\nKetik perintah `/cari [nama/wa]`\n\nContoh: `/cari budi` atau `/cari 0812`', { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_listonu') {
      const customerDevice = require('./customerDeviceService');
      let res = await customerDevice.listDevicesWithTags(30);
      
      // Jika kosong, coba ambil semua perangkat
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(30);
      }

      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 Tidak ada perangkat ONU yang terdeteksi di GenieACS.');
      }

      let txt = `*📡 DAFTAR ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_suspended') {
      const customers = customerSvc.getAllCustomers().filter(c => c.status === 'suspended');
      if (customers.length === 0) return bot.sendMessage(chatId, '✅ Tidak ada pelanggan yang terisolir.');
      let txt = `*🚫 PELANGGAN TERISOLIR (${customers.length})*\n\n`;
      customers.slice(0, 15).forEach(c => {
        txt += `• *${c.name}* (${c.phone})\n`;
      });
      if (customers.length > 15) txt += `\n_...dan ${customers.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_unpaid') {
      const invoices = billingSvc.getAllInvoices().filter(i => i.status === 'unpaid');
      if (invoices.length === 0) return bot.sendMessage(chatId, '✅ Semua tagihan sudah lunas!');
      let txt = `*⏳ TAGIHAN BELUM BAYAR (${invoices.length})*\n\n`;
      invoices.slice(0, 15).forEach(i => {
        const c = customerSvc.getCustomerById(i.customer_id);
        txt += `• ${c ? c.name : 'Unknown'} - Rp ${i.amount.toLocaleString('id-ID')}\n`;
      });
      if (invoices.length > 15) txt += `\n_...dan ${invoices.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_today') {
      try {
        const stats = billingSvc.getTodayRevenue();
        const total = stats.total || 0;
        const count = stats.count || 0;
        
        let txt = `*📈 PENDAPATAN HARI INI*\n\n`;
        txt += `💰 Total: *Rp ${total.toLocaleString('id-ID')}*\n`;
        txt += `🧾 Jumlah: ${count} Transaksi\n\n`;
        txt += `_Data berdasarkan pembayaran yang diverifikasi hari ini (Waktu Lokal)._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'vouch_profiles') {
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const buttons = [];
        
        // Filter profiles that have Mikhmon Price
        const filtered = profiles.filter(p => parseMikhmon(p.onLogin));

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, '⚠️ Tidak ditemukan paket yang memiliki harga jual (Format Mikhmon).');
        }

        filtered.forEach((p, index) => {
          const meta = parseMikhmon(p.onLogin);
          if (index % 2 === 0) buttons.push([]);
          buttons[buttons.length - 1].push({ text: `🎫 ${p.name} (Rp ${meta.price})`, callback_data: `vouch_gen:${p.name}` });
        });
        buttons.push([{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]);
        
        bot.sendMessage(chatId, '*📜 PILIH PAKET VOUCHER*\nSilakan klik paket untuk langsung membuat PIN:', { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }
    
    else if (data.startsWith('vouch_gen:')) {
      const profileName = data.split(':')[1];
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const profile = profiles.find(p => p.name === profileName);
        if (!profile) throw new Error('Profil tidak ditemukan');

        const meta = parseMikhmon(profile.onLogin);
        if (!meta) throw new Error('Data harga/durasi profil tidak ditemukan (Format Mikhmon)');

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        
        await mikrotikSvc.addHotspotUser({
          server: 'all',
          name: pin,
          password: pin,
          profile: profileName,
          'limit-uptime': meta.validity,
          comment: `vc-${pin}-${profileName}`
        });
        
        let res = `*🎫 VOUCHER BERHASIL (INSTAN)*\n\n`;
        res += `🎫 KODE VOUCHER: \`${pin}\`\n`;
        res += `💰 Harga: Rp ${meta.price}\n`;
        res += `⏳ Durasi: ${meta.validity}\n`;
        res += `📦 Paket: ${profileName}\n`;
        res += `\n_Silakan masukkan kode di atas pada halaman login hotspot._`;
        
        bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal: ' + e.message);
      }
    }
    
    bot.answerCallbackQuery(query.id);
  });

  // Custom Commands
  bot.onText(/\/vouch (\S+) (\S+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const [_, profile, limit, comment] = match;
    try {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      await mikrotikSvc.addHotspotUser({
        server: 'all', name: pin, password: pin, profile, 'limit-uptime': limit, comment
      });
      bot.sendMessage(msg.chat.id, `*🎫 VOUCHER BERHASIL*\n\n🎫 KODE VOUCHER: \`${pin}\`\n📦 Paket: ${profile}\n⏳ Limit: ${limit}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/vcr\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const code = match[1];
    const profile = match[2];
    try {
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      const comment = `vc ${code} ${dateStr}`;

      await mikrotikSvc.addHotspotUser({
        name: code,
        password: code,
        profile: profile,
        comment: comment
      });

      bot.sendMessage(chatId, `✅ Voucher Hotspot *${code}* berhasil dibuat.\n\n👤 User: \`${code}\`\n🔑 Pass: \`${code}\`\n📦 Profile: *${profile}*\n📝 Comment: *${comment}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal buat voucher: ' + e.message);
    }
  });

  bot.onText(/\/kick (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const user = match[1];
      await mikrotikSvc.kickPppoeUser(user);
      await mikrotikSvc.kickHotspotUser(user);
      bot.sendMessage(msg.chat.id, `✅ Session *${user}* berhasil diputus.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/editpppoe (\S+) (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const [_, user, profile] = match;
      await mikrotikSvc.setPppoeProfile(user, profile);
      bot.sendMessage(msg.chat.id, `✅ Profile *${user}* diubah ke *${profile}*.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/cekpppoe (\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const username = match[1];
      const detail = await buildPppoeUserDetailText(username);
      bot.sendMessage(msg.chat.id, detail);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal cek PPPoE: ' + e.message);
    }
  });

  bot.onText(/\/cari (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const query = match[1].toLowerCase();
    const customers = customerSvc.getAllCustomers().filter(c => 
      c.name.toLowerCase().includes(query) || c.phone.includes(query)
    );
    
    if (customers.length === 0) return bot.sendMessage(msg.chat.id, `❌ Pelanggan dengan keyword "${query}" tidak ditemukan.`);
    
    let res = `*🔍 HASIL PENCARIAN (${customers.length})*\n\n`;
    customers.slice(0, 10).forEach(c => {
      res += `👤 *${c.name}*\n📞 ${c.phone}\n🚦 Status: ${c.status === 'active' ? '✅ Aktif' : '🚫 Terisolir'}\n\n`;
    });
    if (customers.length > 10) res += `_...dan ${customers.length - 10} lainnya._`;
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/ringkasan/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      const stats = billingSvc.getDashboardStats();
      const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      let res = `💰 *RINGKASAN BILLING*\n\n` +
        `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
        `📅 *Bulan Ini:* ${formatter.format(stats.thisMonth)}\n` +
        `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
        `🧾 *Tagihan Belum Lunas:* ${stats.unpaidCount} invoice\n\n` +
        `💡 _Gunakan perintah lain untuk detail._`;
      bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal mengambil ringkasan billing: ' + e.message);
    }
  });

  bot.onText(/\/lunas(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const keyRaw = String(match[1] || '').trim();
    if (!keyRaw) return bot.sendMessage(chatId, '❌ Format: `/lunas IDTAGIHAN` atau `/lunas nama/nohp/pppoe/tag`', { parse_mode: 'Markdown' });

    try {
      let targetInvId = null;
      let targetInv = null;
      const isNumeric = /^\d+$/.test(keyRaw);
      if (isNumeric) {
        targetInvId = Number(keyRaw);
        targetInv = billingSvc.getInvoiceById(targetInvId);
      }

      if (!targetInv) {
        let cust =
          (isNumeric ? customerSvc.getCustomerById(Number(keyRaw)) : null) ||
          customerSvc.findCustomerByAny(keyRaw);

        if (!cust) {
          const candidates = customerSvc.getAllCustomers(keyRaw) || [];
          const unique = Array.from(new Map(candidates.map(c => [c.id, c])).values());
          if (unique.length === 1) {
            cust = customerSvc.getCustomerById(unique[0].id);
          } else if (unique.length > 1) {
            const top = unique.slice(0, 5).map(c =>
              `- ID:${c.id} • ${c.name || '-'} • ${c.phone || '-'} • PPPoE:${c.pppoe_username || '-'}`
            ).join('\n');
            return bot.sendMessage(chatId, `⚠️ Nama/ID tidak spesifik. Ditemukan ${unique.length} pelanggan:\n\n${top}\n\nKirim ulang: \`/lunas IDPELANGGAN\``);
          }
        }

        if (cust) {
          const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
          if (unpaid && unpaid.length > 0) {
            targetInv = unpaid[0];
            targetInvId = targetInv.id;
          } else {
            return bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`, { parse_mode: 'Markdown' });
          }
        }
      }

      if (!targetInv) return bot.sendMessage(chatId, `❌ Tagihan atau Pelanggan *${keyRaw}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      if (targetInvId != null) {
        const enriched = billingSvc.getInvoiceById(targetInvId);
        if (enriched) targetInv = enriched;
      }
      if (targetInv && targetInv.status === 'paid') {
        return bot.sendMessage(chatId, `✅ Invoice *#${targetInv.id}* sudah berstatus LUNAS.`, { parse_mode: 'Markdown' });
      }

      billingSvc.markAsPaid(targetInvId, 'Telegram Bot Admin', 'Paid via Telegram Command');

      const customer = customerSvc.getCustomerById(targetInv.customer_id);
      const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      const customerName = String(targetInv.customer_name || customer?.name || targetInv.customer_name || '-');
      const notifyTag = customer?.genieacs_tag || customer?.pppoe_username || customer?.phone || targetInv.customer_phone || targetInv.genieacs_tag || '';
      
      const appUrl = (getSetting('public_base_url', '') || '').replace(/\/$/, '');
      const portalUrl = appUrl ? `${appUrl}/customer` : '';
      const template = db.getAppSetting('whatsapp_payment_success_message', '');

      const waMessage = whatsappService.formatPaymentSuccessMessage({
        customerName,
        invoiceId: targetInvId,
        customerUsername: customer?.pppoe_username || customer?.id || '-',
        packageName: targetInv.package_name || '-',
        periodMonth: targetInv.period_month,
        periodYear: targetInv.period_year,
        amount: targetInv.amount,
        paymentMethod: 'Telegram Admin / Kasir',
        paidAt: new Date(),
        companyName: getSetting('company_header', 'ALIJAYA NET'),
        companyPhone: getSetting('company_phone', ''),
        portalUrl,
        customTemplate: template
      });
      
      // Dynamic import of whatsappBot
      const waBot = await import('./whatsappBot.mjs').catch(() => null);
      let waNotifStatus = 'tidak dikirim (WA offline)';

      if (customer && customer.status === 'suspended') {
        const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
        const unpaidCount = freshCustomer && Number.isFinite(Number(freshCustomer.unpaid_count)) ? Number(freshCustomer.unpaid_count) : 1;
        if (unpaidCount === 0) {
          await customerSvc.activateCustomer(targetInv.customer_id);
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n🟢 Layanan internet Anda sudah aktif kembali.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* LUNAS. Pelanggan *${customerName}* otomatis diaktifkan kembali.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
        } else {
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n⚠️ Masih ada ${unpaidCount} tagihan lain yang belum dibayar.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* LUNAS. Masih ada ${unpaidCount} tagihan lain.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
        }
      } else {
        if (waBot && waBot.currentSock) {
          const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage);
          waNotifStatus = ok ? 'terkirim' : 'gagal';
        }
        await bot.sendMessage(chatId, `✅ Invoice *#${targetInvId}* (a.n ${customerName}) berhasil ditandai LUNAS.\n📩 Notif WA pelanggan: ${waNotifStatus}`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal update status: ' + e.message);
    }
  });

  bot.onText(/\/generate\s+(\d+)\s+(\d+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const month = Number(match[1]);
    const year = Number(match[2]);
    try {
      const res = billingSvc.generateMonthlyInvoices(month, year);
      bot.sendMessage(chatId, `✅ Berhasil generate tagihan untuk periode *${month}/${year}*.\n🧾 Jumlah: ${res.generatedCount} tagihan baru.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal generate tagihan: ' + e.message);
    }
  });

  bot.onText(/\/isolir(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Format: `/isolir ID/Nama/PPPoE/NoHP`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ Pelanggan *${targetId}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      await customerSvc.suspendCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil di-isolir.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal isolir: ' + e.message);
    }
  });

  bot.onText(/\/buka(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Format: `/buka ID/Nama/PPPoE/NoHP`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ Pelanggan *${targetId}* tidak ditemukan.`, { parse_mode: 'Markdown' });
      await customerSvc.activateCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil diaktifkan kembali.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal mengaktifkan pelanggan: ' + e.message);
    }
  });

  bot.onText(/\/saldodigi/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      const r = await agentSvc.digiflazzCheckBalance();
      bot.sendMessage(chatId, `💳 *SALDO DIGIFLAZZ*\n\n💰 Deposit: Rp ${Number(r?.deposit || 0).toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal cek saldo Digiflazz: ' + e.message);
    }
  });

  bot.onText(/\/topup\s+(\S+)\s+(\d+)(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const agentKeyRaw = String(match[1] || '').trim();
    const amount = Number(match[2]) || 0;
    const note = String(match[3] || 'Topup via Telegram').trim();

    try {
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

      const agent = agentSvc.getAllAgents().find(a => 
        String(a.id) === agentKey ||
        String(a.username || '').toLowerCase() === agentKeyLc ||
        (a.phone && normalizeDigits(a.phone) === agentDigits) ||
        String(a.name || '').toLowerCase() === agentKeyLc
      );

      if (!agent) throw new Error(`Agent "${agentKeyRaw}" tidak ditemukan`);

      const actorName = msg.from.first_name || 'Telegram Admin';
      const r = agentSvc.topupAgent(agent.id, amount, note, actorName);
      
      bot.sendMessage(chatId, 
        `💸 *TOPUP AGENT BERHASIL*\n\n` +
        `👤 Agent: *${agent.name}* (@${agent.username || '-'})\n` +
        `💰 Nominal: Rp ${Number(amount || 0).toLocaleString('id-ID')}\n` +
        `📈 Saldo: Rp ${Number(r.before || 0).toLocaleString('id-ID')} ➜ Rp ${Number(r.after || 0).toLocaleString('id-ID')}\n` +
        `📝 Catatan: ${note}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal topup agent: ' + e.message);
    }
  });

  bot.onText(/\/listonu/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      let res = await customerDevice.listDevicesWithTags(50);
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(50);
      }
      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 Tidak ada perangkat ONU terdeteksi di GenieACS.');
      }
      let txt = `*📡 DAFTAR ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal list ONU: ' + e.message);
    }
  });

  bot.onText(/\/(?:info|cekstatus)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;
      
      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }
      
      const data = await customerDevice.getCustomerDeviceData(targetTag);
      let t = `*📡 DETAIL ONU: ${data.lokasi || targetTag}*\n\n`;
      t += `🟢 Status: ${data.status || '-'}\n`;
      t += `📶 SSID: ${data.ssid || '-'}\n`;
      t += `⏱️ Last Inform: ${data.lastInform || '-'}\n`;
      t += `📡 RX Power: ${data.rxPower || '-'}\n`;
      t += `🌐 PPPoE IP: ${data.pppoeIP || '-'}\n`;
      t += `👤 PPPoE User: ${data.pppoeUsername || '-'}\n`;
      t += `⏳ Uptime: ${data.uptime || '-'}\n`;
      t += `⏳ PPPoE Uptime: ${data.pppoeUptime || '-'}\n`;
      t += `📱 User WiFi: ${data.totalAssociations || '0'}\n`;
      t += `🔧 Model: ${data.model || '-'}\n`;
      t += `🏷️ Serial Number: ${data.serialNumber || '-'}\n`;
      t += `💾 Firmware: ${data.softwareVersion || '-'}`;
      bot.sendMessage(chatId, t, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal cek status ONU: ' + e.message);
    }
  });

  bot.onText(/\/reboot\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Mencoba me-reboot ONU *${targetTag}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.rebootDevice(targetTag);
      if (ok) {
        bot.sendMessage(chatId, `✅ ONU *${targetTag}* berhasil diperintahkan untuk reboot.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal reboot ONU *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal reboot ONU: ' + e.message);
    }
  });

  bot.onText(/\/gantissid\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newSSID = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Mengubah SSID untuk *${targetTag}* menjadi *${newSSID}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.updateSSID(targetTag, newSSID);
      if (ok) {
        bot.sendMessage(chatId, `✅ SSID untuk *${targetTag}* berhasil diubah menjadi *${newSSID}*.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal mengubah SSID untuk *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal ganti SSID: ' + e.message);
    }
  });

  bot.onText(/\/gantisandi\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newPass = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ Target *${inputTag}* tidak ditemukan di GenieACS.`);
      }

      if (newPass.length < 8) {
        return bot.sendMessage(chatId, `⚠️ Password WiFi minimal harus 8 karakter.`);
      }

      await bot.sendMessage(chatId, `⏳ Mengubah sandi WiFi untuk *${targetTag}*...`);
      const ok = await customerDevice.updatePassword(targetTag, newPass);
      if (ok) {
        bot.sendMessage(chatId, `✅ Sandi WiFi untuk *${targetTag}* berhasil diubah menjadi: \`${newPass}\``, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ Gagal mengubah sandi WiFi untuk *${targetTag}*.`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal ganti sandi WiFi: ' + e.message);
    }
  });

  // --- Perintah Asisten Grup & Utilitas Jaringan (Dapat diakses oleh Member Grup & Admin) ---
  
  bot.onText(/\/fitur(?:@\w+)?/i, async (msg) => {
    try {
      const summary = telegramAi.getOfflineAnswer('menu_overview');
      bot.sendMessage(msg.chat.id, summary, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => {});
    } catch (e) {
      logger.error('Telegram /fitur error:', e.message);
    }
  });

  bot.onText(/\/dns(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?/i, async (msg, match) => {
    const domain = match[1];
    const type = match[2] || 'A';
    if (!domain) {
      return bot.sendMessage(msg.chat.id, '💡 Format cek DNS: `/dns <domain> [record]`\nContoh: `/dns google.com A` atau `/dns cloudflare.com MX`', {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
      });
    }

    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const res = await telegramAi.checkDns(domain, type);
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => {});
  });

  bot.onText(/\/ping(?:@\w+)?(?:\s+(\S+))?/i, async (msg, match) => {
    const host = match[1];
    if (!host) {
      return bot.sendMessage(msg.chat.id, '💡 Format ping: `/ping <domain/IP>`\nContoh: `/ping google.com` atau `/ping 1.1.1.1`', {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
      });
    }

    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const res = await telegramAi.checkPing(host);
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => {});
  });

  bot.onText(/\/(?:bantuan|help)(?:@\w+)?/i, async (msg) => {
    const helpText = `🤖 *PANDUAN ASISTEN GRUP RTRW-NET*\n\n` +
      `*Konsultasi Fitur Aplikasi:*\n` +
      `• Ketik \`/tanya <pertanyaan>\`\n` +
      `• Mention @${botMe?.username || 'bot'} diikuti pertanyaan Anda\n` +
      `• Atau reply salah satu pesan bot\n\n` +
      `*Perintah Utilitas Jaringan:*\n` +
      `• \`/dns <domain> [tipe]\` : Cek record DNS (A, MX, TXT, NS)\n` +
      `• \`/ping <host>\` : Cek latensi dan status koneksi host\n` +
      `• \`/fitur\` : Rangkuman modul sistem aplikasi\n\n` +
      `_Catatan: Perintah manajemen router & ONU (reboot, isolir, ganti wifi) khusus untuk Admin resmi._`;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }).catch(() => {});
  });

  bot.on('polling_error', (error) => {
    logger.error('Telegram Polling Error:', error.message);
  });
}

/**
 * Konversi angka ke kalimat terbilang bahasa Indonesia
 */
function terbilang(n) {
  const bilangan = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  n = Math.floor(Number(n) || 0);
  if (n < 12) return bilangan[n];
  if (n < 20) return terbilang(n - 10) + ' belas';
  if (n < 100) return terbilang(Math.floor(n / 10)) + ' puluh' + (n % 10 !== 0 ? ' ' + terbilang(n % 10) : '');
  if (n < 200) return 'seratus' + (n - 100 !== 0 ? ' ' + terbilang(n - 100) : '');
  if (n < 1000) return terbilang(Math.floor(n / 100)) + ' ratus' + (n % 100 !== 0 ? ' ' + terbilang(n % 100) : '');
  if (n < 2000) return 'seribu' + (n - 1000 !== 0 ? ' ' + terbilang(n - 1000) : '');
  if (n < 1000000) return terbilang(Math.floor(n / 1000)) + ' ribu' + (n % 1000 !== 0 ? ' ' + terbilang(n % 1000) : '');
  if (n < 1000000000) return terbilang(Math.floor(n / 1000000)) + ' juta' + (n % 1000000 !== 0 ? ' ' + terbilang(n % 1000000) : '');
  return n.toLocaleString('id-ID');
}

/**
 * Generate audio buffer MP3 dari Google TTS Bahasa Indonesia
 */
function generateTtsAudio(text) {
  return new Promise((resolve, reject) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) return resolve(Buffer.alloc(0));
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(cleanText) + '&tl=id&client=tw-ob';
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('TTS status code ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/**
 * Kirim Pesan Suara (Voice Note / Audio) ke Telegram Admin (Dukung multiple ID dipisah koma)
 */
async function sendAdminVoiceNotification(text, caption = '') {
  try {
    const raw = String(getSetting('telegram_admin_id', '') || getSetting('telegram_admin_chat_id', '') || '');
    const targets = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (targets.length === 0) return false;

    let activeBot = bot;
    if (!activeBot) {
      const token = getSetting('telegram_bot_token', '');
      if (token) {
        activeBot = new TelegramBot(token, { request: { family: 4 } });
      }
    }
    if (!activeBot) return false;

    const audioBuf = await generateTtsAudio(text);
    if (!audioBuf || audioBuf.length === 0) return false;

    const formattedCaption = caption || `🔔 *NOTIFIKASI TRANSAKSI MASUK*\n\n💬 _${text}_`;

    for (const target of targets) {
      try {
        await activeBot.sendVoice(target, audioBuf, {
          caption: formattedCaption,
          parse_mode: 'Markdown'
        }, {
          filename: 'notif_dana.ogg',
          contentType: 'audio/ogg'
        });
        logger.info(`[Telegram TTS] Voice note berhasil dikirim ke Admin (${target}): "${text}"`);
      } catch (voiceErr) {
        logger.warn('[Telegram TTS] sendVoice fallback to sendAudio: ' + voiceErr.message);
        await activeBot.sendAudio(target, audioBuf, {
          caption: formattedCaption,
          title: 'Notifikasi Transaksi Masuk',
          performer: getSetting('company_header', 'Billing RTRW'),
          parse_mode: 'Markdown'
        }, {
          filename: 'notif_transaksi.mp3',
          contentType: 'audio/mpeg'
        }).catch(() => {});
      }
    }
    return true;
  } catch (err) {
    logger.error('[Telegram TTS] Gagal mengirim notifikasi suara: ' + err.message);
    return false;
  }
}

/**
 * Kirim Pesan Teks Siaga / Notifikasi Langsung ke Telegram Admin (Dukung multiple ID dipisah koma)
 */
async function sendAdminMessage(text, options = {}) {
  try {
    const raw = String(getSetting('telegram_admin_id', '') || getSetting('telegram_admin_chat_id', '') || getSetting('telegram_chat_id', '') || '');
    const targets = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (targets.length === 0) return false;

    let activeBot = bot;
    if (!activeBot) {
      const token = getSetting('telegram_bot_token', '');
      if (token) {
        activeBot = new TelegramBot(token, { request: { family: 4 } });
      }
    }
    if (!activeBot) return false;

    const str = String(text || '');
    const maxLen = 4000;
    const chunks = [];
    if (str.length <= maxLen) {
      chunks.push(str);
    } else {
      for (let i = 0; i < str.length; i += maxLen) {
        chunks.push(str.slice(i, i + maxLen));
      }
    }

    for (const target of targets) {
      for (const chunk of chunks) {
        try {
          await activeBot.sendMessage(target, chunk, {
            parse_mode: 'Markdown',
            ...options
          });
        } catch (e) {
          await activeBot.sendMessage(target, chunk, { ...options }).catch((err2) => {
            logger.warn(`[TelegramBot] Gagal kirim ke ${target}: ${err2.message}`);
          });
        }
      }
    }
    return true;
  } catch (err) {
    logger.warn('[TelegramBot] sendAdminMessage error: ' + err.message);
    return false;
  }
}

// Export for manual re-init from settings & external triggers
module.exports = {
  initTelegram,
  sendAdminVoiceNotification,
  sendAdminMessage,
  generateTtsAudio,
  terbilang
};
