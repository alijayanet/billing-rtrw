const fs = require('fs');
const path = require('path');
const jimpMod = require('jimp');
const Jimp = jimpMod.Jimp || jimpMod;
const jsQR = require('jsqr');
const QRCode = require('qrcode');
const { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, MultiFormatReader, BarcodeFormat, DecodeHintType } = require('@zxing/library');

function normalizeQrisPayload(raw) {
  let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
  const idx = s.indexOf('000201');
  if (idx > 0) s = s.slice(idx);
  const lastCrc = s.lastIndexOf('6304');
  if (lastCrc >= 0 && s.length >= lastCrc + 8) {
    s = s.slice(0, lastCrc + 8);
  }
  return s;
}

function crc16CcittFalse(input) {
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
}

function parseEmvTlvString(input) {
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
}

function buildEmvTlvString(items) {
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
}

function convertStaticQrisToDynamic(staticPayload, amount) {
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

  if (!amountInserted) {
    result.push({ tag: '54', value: String(amt) });
  }

  const body = buildEmvTlvString(result);
  const partial = body + '6304';
  const crc = crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
  return partial + crc;
}

async function decodeQrisPayloadFromBuffer(buf) {
  if (!buf || !buf.length) return '';

  // 1. Try jsQR (Fast & reliable for screenshots)
  try {
    const img = await Jimp.read(buf);
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    const data = new Uint8ClampedArray(img.bitmap.data);
    const code = jsQR(data, w, h);
    if (code && code.data) {
      const payload = normalizeQrisPayload(code.data);
      if (payload && payload.startsWith('000201')) return payload;
    }
  } catch (e) {}

  // 2. Fallback to @zxing/library
  try {
    const img = await Jimp.read(buf);
    const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
    const source = new RGBLuminanceSource(rgba, img.bitmap.width, img.bitmap.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    const decoded = reader.decode(bitmap, hints);
    const text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
    const payload = normalizeQrisPayload(text);
    if (payload && payload.startsWith('000201')) return payload;
  } catch (e) {}

  return '';
}

function extractMerchantInfo(rawPayload) {
  let merchantName = '';
  let merchantCity = '';
  let nmid = '';
  try {
    const items = parseEmvTlvString(rawPayload);
    for (const it of items) {
      if (it.tag === '59') merchantName = it.value;
      if (it.tag === '60') merchantCity = it.value;
      if (['26', '27', '28', '29', '30', '51'].includes(it.tag)) {
        try {
          const subs = parseEmvTlvString(it.value);
          const found = subs.find(s => s.tag === '02');
          if (found && found.value) nmid = found.value;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return { merchantName, merchantCity, nmid };
}

async function buildDynamicQrisJpgBuffer(staticPayload, amount, options = {}) {
  const dynamic = convertStaticQrisToDynamic(staticPayload, amount);

  try {
    const sharp = require('sharp');
    const { getSetting } = require('../config/settingsManager');

    const parsed = extractMerchantInfo(staticPayload);
    const mName = String(options.merchantName || getSetting('company_header', '') || parsed.merchantName || 'ALIJAYA NET').trim().toUpperCase();
    const mCity = String(options.merchantCity || parsed.merchantCity || 'INDRAMAYU').trim().toUpperCase();
    const nmid = String(options.nmid || parsed.nmid || '').trim();
    const nmidText = nmid ? `NMID: ${nmid} • ${mCity}` : mCity;

    const custName = String(options.customerName || '').trim();
    const invNo = String(options.invoiceNumber || '').trim();
    const nowStr = options.dateStr || (new Intl.DateTimeFormat('id-ID', {
      timeZone: getSetting('timezone', 'Asia/Jakarta'),
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date()) + ' WIB');

    const formattedAmount = 'Rp ' + Number(amount || 0).toLocaleString('id-ID');

    // Generate high-resolution QR Code
    const qrDataUrl = await QRCode.toDataURL(dynamic, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 440
    });

    const escapeXml = (unsafe) => String(unsafe || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    const svg = `
    <svg width="720" height="1100" viewBox="0 0 720 1100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="cardShadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#0f172a" flood-opacity="0.08"/>
        </filter>
      </defs>
      <!-- Background Canvas -->
      <rect width="720" height="1100" fill="#F8FAFC"/>

      <!-- Main White Card -->
      <rect x="30" y="30" width="660" height="1040" rx="32" fill="#FFFFFF" filter="url(#cardShadow)"/>

      <!-- Top Header Banner (QRIS Red) -->
      <path d="M 30,62 A 32,32 0 0,1 62,30 L 658,30 A 32,32 0 0,1 690,62 L 690,145 L 30,145 Z" fill="#D32F2F"/>
      <text x="360" y="85" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="30" font-weight="800" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">QRIS DINAMIS NASIONAL</text>
      <text x="360" y="122" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="17" font-weight="500" fill="#FFEBEE" text-anchor="middle">Satu QR Code untuk Semua Pembayaran</text>

      <!-- Merchant Info -->
      <text x="360" y="195" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="28" font-weight="800" fill="#0F172A" text-anchor="middle">${escapeXml(mName)}</text>
      <text x="360" y="228" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="17" font-weight="600" fill="#64748B" text-anchor="middle">${escapeXml(nmidText)}</text>

      <!-- Center Dynamic QR Code -->
      <image x="140" y="252" width="440" height="440" href="${qrDataUrl}"/>

      <!-- Amount Container Box -->
      <rect x="65" y="708" width="590" height="126" rx="20" fill="#F1F5F9" stroke="#E2E8F0" stroke-width="1.5"/>
      <text x="360" y="748" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="19" font-weight="700" fill="#64748B" text-anchor="middle" letter-spacing="0.5">TOTAL TAGIHAN PEMBAYARAN</text>
      <text x="360" y="805" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="44" font-weight="900" fill="#D32F2F" text-anchor="middle">${escapeXml(formattedAmount)}</text>

      <!-- Customer / Invoice Details -->
      ${custName ? `<text x="360" y="868" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="19" font-weight="700" fill="#1E293B" text-anchor="middle">Pelanggan: ${escapeXml(custName)}</text>` : ''}
      <text x="360" y="${custName ? '904' : '885'}" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="17" font-weight="500" fill="#475569" text-anchor="middle">${invNo ? `No. Invoice: ${escapeXml(invNo)}  •  ` : ''}${escapeXml(nowStr)}</text>

      <!-- Divider -->
      <line x1="80" y1="945" x2="640" y2="945" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="6,6"/>

      <!-- Footer & Badges -->
      <text x="360" y="985" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="800" fill="#0F766E" text-anchor="middle" letter-spacing="0.5">DIJAMIN OLEH BANK INDONESIA &amp; ASOSIASI SISTEM PEMBAYARAN INDONESIA</text>
      <text x="360" y="1022" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#64748B" text-anchor="middle">BCA • Mandiri • BRI • BNI • Dana • OVO • Gopay • ShopeePay • LinkAja</text>
    </svg>
    `;

    return await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  } catch (err) {
    const png = await QRCode.toBuffer(dynamic, { errorCorrectionLevel: 'M', margin: 1, width: 420, type: 'png' });
    const img = await Jimp.read(png);
    return await img.getBuffer('image/jpeg');
  }
}

module.exports = {
  normalizeQrisPayload,
  crc16CcittFalse,
  parseEmvTlvString,
  buildEmvTlvString,
  convertStaticQrisToDynamic,
  decodeQrisPayloadFromBuffer,
  extractMerchantInfo,
  buildDynamicQrisJpgBuffer
};
