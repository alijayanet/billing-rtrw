const https = require('https');
const { logger } = require('../config/logger');

// Cache audio sederhana dalam memori (maks 50 entri)
const ttsCache = new Map();

/**
 * Membersihkan dan menerjemahkan format teks (markdown, emoji, simbol, istilah teknis)
 * menjadi bahasa Indonesia lisan yang santun, luwes, dan natural saat dibacakan oleh mesin suara TTS.
 */
function cleanTextForSpeech(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text;

  // 1. Hapus blok kode, backtick, link markdown, html tags
  str = str.replace(/```[\s\S]*?```/g, ' ');
  str = str.replace(/`([^`]+)`/g, '$1');
  str = str.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  str = str.replace(/<[^>]+>/g, ' ');

  // 2. Terjemahkan simbol mata uang & nomor
  str = str.replace(/\bRp\.?\s*([0-9.,]+)\b/gi, '$1 rupiah');
  str = str.replace(/\bNo\.\s*/gi, 'nomor ');
  str = str.replace(/\bNo\s+(\d+)/gi, 'nomor $1');

  // 3. Terjemahkan nilai redaman optik & tanda minus angka
  str = str.replace(/-(\d+(?:\.\d+)?)\s*(?:dBm|dbm|DBM)\b/gi, 'minus $1 desibel');
  str = str.replace(/\b(\d+(?:\.\d+)?)\s*(?:dBm|dbm|DBM)\b/gi, '$1 desibel');
  str = str.replace(/(^|\s)-(\d+(?:\.\d+)?)/g, '$1minus $2');

  // 4. Terjemahkan singkatan & istilah teknis ke bahasa percakapan santun
  str = str.replace(/\bRX\s*Power\b/gi, 'daya sinyal');
  str = str.replace(/\bTX\s*Power\b/gi, 'daya kirim');
  str = str.replace(/\bONU\b|\bONT\b/gi, 'modem');
  str = str.replace(/\bPPPoE\b/gi, 'pe pe po e');
  str = str.replace(/\bSSID\b/gi, 'nama wifi');
  str = str.replace(/\bUptime\b/gi, 'waktu aktif');
  str = str.replace(/\bIP\s*Address\b|\bIP\b/gi, 'alamat i pe');
  str = str.replace(/\bDNS\b/gi, 'de en es');
  str = str.replace(/\bAPI\b/gi, 'a pe i');
  str = str.replace(/\bWA\b/gi, 'whatsapp');
  str = str.replace(/\bQRIS\b/gi, 'kris');
  str = str.replace(/\bLOS\b/gi, 'lampu merah sinyal putus');
  str = str.replace(/\b(\d+)\s*Mbps\b/gi, '$1 mega bit per detik');
  str = str.replace(/\b(\d+)\s*Kbps\b/gi, '$1 kilo bit per detik');
  str = str.replace(/\b(\d+)\s*Gbps\b/gi, '$1 giga bit per detik');
  str = str.replace(/\b(\d+)\s*ms\b/gi, '$1 mili detik');

  // 5. Terjemahkan simbol umum
  str = str.replace(/&/g, ' dan ');
  str = str.replace(/%/g, ' persen ');
  str = str.replace(/\+/g, ' plus ');
  str = str.replace(/=/g, ' adalah ');
  str = str.replace(/@/g, ' di ');
  str = str.replace(/\//g, ' atau ');

  // 6. HAPUS SEMUA EMOJI & SIMBOL GRAFIS (lingkaran warna hijau, merah, kuning, dll.)
  str = str.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{200D}\u{20E3}]/gu, ' ');
  str = str.replace(/[🟢🔴🟡⚪⚫🟠🔵🟣🟥🟩🟦🟧🟨⭕❌✅⚠️💡🤖🧾💳📡📶🔒🔓🔄🔑👉⏱️📱🔧🏷️💾💬⚙️🛡️💰📋🙏✔️✖️◀️▶️▲▼◆■]/gu, ' ');

  // 7. Hapus markdown bullets, pembatas, dan format kaku
  str = str.replace(/^[•·▪▫➢➔★☆✓✕✖\-\*]\s+/gm, '');
  str = str.replace(/[•·▪▫➢➔★☆✓✕✖]/g, ' ');
  str = str.replace(/^[─—\-_=]{2,}\s*$/gm, '');
  str = str.replace(/[*_~#|\\^$<>\[\]{}()]/g, ' ');

  // 8. Hapus semua karakter selain huruf, angka, spasi, dan tanda jeda suara (. , ? !)
  str = str.replace(/[^\p{L}\p{N}\s,.\?!]/gu, ' ');

  // 9. Normalisasi jeda tanda baca dan spasi
  str = str.replace(/\s*([,.\?!])\s*/g, '$1 ');
  str = str.replace(/,\s*,+/g, ',');
  str = str.replace(/\.\s*\.+/g, '.');
  str = str.replace(/\s+/g, ' ').trim();

  return str;
}

/**
 * Memecah teks panjang menjadi potongan kalimat (< 180 karakter)
 * agar pas dengan batasan API TTS tanpa memotong kata di tengah.
 */
function splitTextIntoChunks(text, maxLen = 180) {
  if (!text) return [];
  const sentences = text.match(/[^.!?\n,]+[.!?\n,]*/g) || [text];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (trimmed.length > maxLen) {
      // Jika satu kalimat saja sudah lebih dari maxLen, pecah berdasarkan kata
      const words = trimmed.split(/\s+/);
      for (const word of words) {
        if ((currentChunk + ' ' + word).trim().length > maxLen) {
          if (currentChunk.trim()) chunks.push(currentChunk.trim());
          currentChunk = word;
        } else {
          currentChunk = (currentChunk + ' ' + word).trim();
        }
      }
    } else if ((currentChunk + ' ' + trimmed).trim().length > maxLen) {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk = (currentChunk + ' ' + trimmed).trim();
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Download satu potongan audio MP3 dari Google Translate TTS (Bahasa Indonesia)
 */
function fetchTtsChunk(chunkText, lang = 'id') {
  return new Promise((resolve, reject) => {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunkText)}&tl=${lang}&client=tw-ob`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`TTS gagal dengan status HTTP ${res.statusCode}`));
      }
      const data = [];
      res.on('data', d => data.push(d));
      res.on('end', () => resolve(Buffer.concat(data)));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TTS timeout setelah 10 detik'));
    });
  });
}

/**
 * Generate audio MP3 utuh dari teks bahasa Indonesia
 */
async function generateIndonesianSpeech(text) {
  const clean = cleanTextForSpeech(text);
  if (!clean) return null;

  // Cek cache
  const cacheKey = clean.toLowerCase();
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const chunks = splitTextIntoChunks(clean, 175);
  if (chunks.length === 0) return null;

  try {
    const bufferList = [];
    for (const chunk of chunks) {
      const buf = await fetchTtsChunk(chunk, 'id');
      bufferList.push(buf);
    }

    const combinedBuffer = Buffer.concat(bufferList);

    // Simpan di cache (maksimal 50 item)
    if (ttsCache.size > 50) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, combinedBuffer);

    return combinedBuffer;
  } catch (err) {
    logger.error(`[VoiceTTS] Gagal generate suara: ${err.message}`);
    throw err;
  }
}

module.exports = {
  cleanTextForSpeech,
  splitTextIntoChunks,
  generateIndonesianSpeech
};
