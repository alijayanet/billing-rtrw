const https = require('https');
const { logger } = require('../config/logger');

// Cache audio sederhana dalam memori (maks 50 entri)
const ttsCache = new Map();

/**
 * Membersihkan format teks (markdown, emoji, simbol khusus)
 * agar nyaman dan natural saat dibacakan oleh mesin suara TTS.
 */
function cleanTextForSpeech(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text;

  // Hapus blok kode / backtick
  str = str.replace(/```[\s\S]*?```/g, ' ');
  str = str.replace(/`([^`]+)`/g, '$1');

  // Hapus link markdown [Teks](url) -> Teks
  str = str.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Hapus simbol markdown * atau _
  str = str.replace(/[*_~#]/g, ' ');

  // Hapus bullet point dan garis pemisah
  str = str.replace(/^[•\-\*]\s+/gm, '');
  str = str.replace(/^[─—\-_=]{2,}\s*$/gm, '');

  // Hapus emoji umum dan simbol grafis
  str = str.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, ' ');

  // Ubah format mata uang agar lebih natural dibaca: "Rp 3.000" -> "3.000 rupiah"
  str = str.replace(/\bRp\s?([\d.,]+)\b/gi, '$1 rupiah');
  // Ubah "No. " -> "nomor "
  str = str.replace(/\bNo\.\s*/gi, 'nomor ');
  str = str.replace(/\bNo\s+(\d+)/gi, 'nomor $1');
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
