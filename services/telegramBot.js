const TelegramBot = require('node-telegram-bot-api');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikSvc = require('./mikrotikService');

let bot = null;

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

  bot = new TelegramBot(token, { polling: true });
  
  // Clear webhook to ensure polling works (Sync)
  bot.deleteWebHook().then(() => {
    bot.getMe().then(me => {
      logger.info(`Telegram Bot: Terhubung sebagai @${me.username}`);
    }).catch(e => logger.error('Telegram Bot Error (getMe):', e.message));
  }).catch(e => logger.error('Telegram Bot Error (deleteWebHook):', e.message));

  // Middleware Admin Check (Fetch latest ID every time)
  const isAdmin = (msg) => {
    const currentAdminId = getSetting('telegram_admin_id', '').toString();
    return msg.from.id.toString() === currentAdminId;
  };

  // Helper Mikhmon Parser
  const parseMikhmon = (script) => {
    if (!script) return null;
    // Format: :put (",rem,ID,VALIDITY,PRICE,MODE,")
    const match = script.match(/",rem,.*?,(.*?),(.*?),.*?"/);
    if (match) {
      return {
        validity: match[1],
        price: match[2]
      };
    }
    return null;
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
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, `Maaf, Anda tidak memiliki akses admin.\nChat ID Anda: ${msg.from.id}`);
    bot.sendMessage(msg.chat.id, '🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', { parse_mode: 'Markdown', ...mainMenu });
  });

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;
    const text = msg.text;
    if (text === '/start' || text === '/menu') return; // Handled by onText
    
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
        const secrets = await mikrotikSvc.getPppoeSecrets();
        const active = await mikrotikSvc.getPppoeActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        const activeNames = active.map(a => a.name);
        
        const offline = secrets.filter(s => !activeNames.includes(s.name) && s.disabled === false);
        
        let txt = `*🔴 USER PPPoE OFFLINE*\n`;
        txt += `============================\n`;
        txt += `📅 *${new Date().toLocaleString('id-ID')}*\n`;
        txt += `============================\n\n`;
        
        txt += `📋 *RINGKASAN:*\n`;
        txt += `• Total Secret: ${secrets.length}\n`;
        txt += `• Total Aktif: ${active.length}\n`;
        txt += `• *Terputus: ${offline.length}*\n\n`;
        
        txt += `👤 *DAFTAR USER OFFLINE:*\n`;
        if (offline.length === 0) {
          txt += `✅ Semua user online.\n`;
        } else {
          offline.slice(0, 25).forEach(s => {
            const sc = scripts.find(scr => scr.name === s.name);
            const failCount = sc ? (sc.source || '0') : '0';
            txt += `• \`${s.name}\` [⚡${failCount}x]\n`;
          });
          if (offline.length > 25) txt += `\n_...dan ${offline.length - 25} lainnya._\n`;
        }
        
        txt += `\n============================\n`;
        txt += `_Powered by Admin Portal_`;
        
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
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

  bot.on('polling_error', (error) => {
    logger.error('Telegram Polling Error:', error.message);
  });
}

// Export for manual re-init from settings
module.exports = { initTelegram };
