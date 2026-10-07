/**
 * Encoder & Decoder RADIUS Protocol (RFC 2865 & RFC 2866)
 * Zero-dependency, menggunakan modul bawaan Node.js (crypto & buffer)
 */
const crypto = require('crypto');

const CODES = {
  ACCESS_REQUEST: 1,
  ACCESS_ACCEPT: 2,
  ACCESS_REJECT: 3,
  ACCOUNTING_REQUEST: 4,
  ACCOUNTING_RESPONSE: 5,
  ACCESS_CHALLENGE: 11
};

const ATTR_TYPES = {
  USER_NAME: 1,
  USER_PASSWORD: 2,
  CHAP_PASSWORD: 3,
  NAS_IP_ADDRESS: 4,
  NAS_PORT: 5,
  SERVICE_TYPE: 6,
  FRAMED_PROTOCOL: 7,
  FRAMED_IP_ADDRESS: 8,
  FRAMED_IP_NETMASK: 9,
  FILTER_ID: 11,
  FRAMED_MTU: 12,
  STATE: 24,
  CLASS: 25,
  VENDOR_SPECIFIC: 26,
  SESSION_TIMEOUT: 27,
  IDLE_TIMEOUT: 28,
  TERMINATE_ACTION: 29,
  CALLED_STATION_ID: 30,
  CALLING_STATION_ID: 31,
  NAS_IDENTIFIER: 32,
  ACCT_STATUS_TYPE: 40,
  ACCT_DELAY_TIME: 41,
  ACCT_INPUT_OCTETS: 42,
  ACCT_OUTPUT_OCTETS: 43,
  ACCT_SESSION_ID: 44,
  ACCT_AUTHENTIC: 45,
  ACCT_SESSION_TIME: 46,
  ACCT_INPUT_PACKETS: 47,
  ACCT_OUTPUT_PACKETS: 48,
  ACCT_TERMINATE_CAUSE: 49,
  ACCT_INPUT_GIGAWORDS: 52,
  ACCT_OUTPUT_GIGAWORDS: 53,
  CHAP_CHALLENGE: 60,
  FRAMED_POOL: 88
};

const MIKROTIK_VENDOR_ID = 14988;
const MIKROTIK_VSAS = {
  RECV_LIMIT: 1,
  XMIT_LIMIT: 2,
  GROUP: 7,
  RATE_LIMIT: 8,
  REALM: 9
};

function parseIp(buf) {
  if (!buf || buf.length < 4) return '';
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function encodeIp(ipStr) {
  const parts = String(ipStr || '0.0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  return Buffer.from([parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0]);
}

/**
 * Decode paket RADIUS dari Buffer
 */
function decodePacket(buffer, secret) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    throw new Error('Paket RADIUS terlalu pendek (minimal 20 byte)');
  }

  const code = buffer.readUInt8(0);
  const identifier = buffer.readUInt8(1);
  const length = buffer.readUInt16BE(2);

  if (buffer.length < length) {
    throw new Error(`Paket RADIUS terpotong: diharapkan ${length} byte, diterima ${buffer.length} byte`);
  }

  const authenticator = buffer.slice(4, 20);
  const attributes = [];
  let offset = 20;

  while (offset < length) {
    if (offset + 2 > length) break;
    const type = buffer.readUInt8(offset);
    const attrLen = buffer.readUInt8(offset + 1);
    if (attrLen < 2 || offset + attrLen > length) break;

    const attrValBuf = buffer.slice(offset + 2, offset + attrLen);
    attributes.push({ type, length: attrLen, value: attrValBuf });
    offset += attrLen;
  }

  const parsedAttrs = {};
  for (const attr of attributes) {
    const { type, value } = attr;
    if (type === ATTR_TYPES.USER_NAME) {
      parsedAttrs.username = value.toString('utf8');
    } else if (type === ATTR_TYPES.USER_PASSWORD && secret) {
      parsedAttrs.password = decryptPapPassword(value, authenticator, secret);
    } else if (type === ATTR_TYPES.CHAP_PASSWORD) {
      parsedAttrs.chapPassword = value;
    } else if (type === ATTR_TYPES.CHAP_CHALLENGE) {
      parsedAttrs.chapChallenge = value;
    } else if (type === ATTR_TYPES.NAS_IP_ADDRESS) {
      parsedAttrs.nasIp = parseIp(value);
    } else if (type === ATTR_TYPES.NAS_PORT) {
      parsedAttrs.nasPort = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.NAS_IDENTIFIER) {
      parsedAttrs.nasIdentifier = value.toString('utf8');
    } else if (type === ATTR_TYPES.FRAMED_IP_ADDRESS) {
      parsedAttrs.framedIp = parseIp(value);
    } else if (type === ATTR_TYPES.ACCT_STATUS_TYPE) {
      parsedAttrs.acctStatusType = value.length >= 4 ? value.readUInt32BE(0) : value.readUInt8(0);
    } else if (type === ATTR_TYPES.ACCT_SESSION_ID) {
      parsedAttrs.acctSessionId = value.toString('utf8');
    } else if (type === ATTR_TYPES.ACCT_INPUT_OCTETS) {
      parsedAttrs.acctInputOctets = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.ACCT_OUTPUT_OCTETS) {
      parsedAttrs.acctOutputOctets = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.ACCT_SESSION_TIME) {
      parsedAttrs.acctSessionTime = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.ACCT_INPUT_GIGAWORDS) {
      parsedAttrs.acctInputGigawords = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.ACCT_OUTPUT_GIGAWORDS) {
      parsedAttrs.acctOutputGigawords = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.ACCT_TERMINATE_CAUSE) {
      parsedAttrs.acctTerminateCause = value.length >= 4 ? value.readUInt32BE(0) : 0;
    } else if (type === ATTR_TYPES.CALLING_STATION_ID) {
      parsedAttrs.callingStationId = value.toString('utf8');
    } else if (type === ATTR_TYPES.CALLED_STATION_ID) {
      parsedAttrs.calledStationId = value.toString('utf8');
    }
  }

  return {
    code,
    identifier,
    length,
    authenticator,
    attributes,
    parsedAttrs
  };
}

/**
 * Dekripsi Password PAP RADIUS
 */
function decryptPapPassword(encryptedBuf, authenticator, secret) {
  if (!encryptedBuf || encryptedBuf.length === 0) return '';
  const secretBuf = Buffer.from(secret, 'utf8');
  let lastBlock = authenticator;
  let decrypted = Buffer.alloc(0);

  for (let i = 0; i < encryptedBuf.length; i += 16) {
    const hash = crypto.createHash('md5').update(secretBuf).update(lastBlock).digest();
    const encChunk = encryptedBuf.slice(i, i + 16);
    const decChunk = Buffer.alloc(encChunk.length);
    for (let j = 0; j < encChunk.length; j++) {
      decChunk[j] = encChunk[j] ^ hash[j];
    }
    decrypted = Buffer.concat([decrypted, decChunk]);
    lastBlock = encChunk;
  }

  // Hilangkan NULL padding (0x00)
  let nullIdx = decrypted.indexOf(0x00);
  if (nullIdx !== -1) {
    decrypted = decrypted.slice(0, nullIdx);
  }
  return decrypted.toString('utf8');
}

/**
 * Encode paket balasan RADIUS (Access-Accept, Access-Reject, Accounting-Response)
 */
function encodeResponsePacket({ code, identifier, requestAuthenticator, attributes = [], secret }) {
  const secretBuf = Buffer.from(secret, 'utf8');

  // Hitung total panjang atribut
  let attrBufList = [];
  for (const attr of attributes) {
    if (attr.type === ATTR_TYPES.VENDOR_SPECIFIC && attr.vendorId === MIKROTIK_VENDOR_ID) {
      // Encode MikroTik VSA
      const vsaValBuf = Buffer.from(attr.value);
      const vsaHeader = Buffer.alloc(6);
      vsaHeader.writeUInt32BE(MIKROTIK_VENDOR_ID, 0);
      vsaHeader.writeUInt8(attr.vendorType, 4);
      vsaHeader.writeUInt8(vsaValBuf.length + 2, 5);

      const fullVsa = Buffer.concat([vsaHeader, vsaValBuf]);
      const attrHeader = Buffer.alloc(2);
      attrHeader.writeUInt8(ATTR_TYPES.VENDOR_SPECIFIC, 0);
      attrHeader.writeUInt8(fullVsa.length + 2, 1);
      attrBufList.push(Buffer.concat([attrHeader, fullVsa]));
    } else {
      let valBuf;
      if (Buffer.isBuffer(attr.value)) {
        valBuf = attr.value;
      } else if (typeof attr.value === 'number') {
        valBuf = Buffer.alloc(4);
        valBuf.writeUInt32BE(attr.value, 0);
      } else if (typeof attr.value === 'string' && attr.isIp) {
        valBuf = encodeIp(attr.value);
      } else {
        valBuf = Buffer.from(String(attr.value || ''), 'utf8');
      }

      const attrHeader = Buffer.alloc(2);
      attrHeader.writeUInt8(attr.type, 0);
      attrHeader.writeUInt8(valBuf.length + 2, 1);
      attrBufList.push(Buffer.concat([attrHeader, valBuf]));
    }
  }

  const allAttrsBuf = Buffer.concat(attrBufList);
  const packetLen = 20 + allAttrsBuf.length;

  const headerBuf = Buffer.alloc(20);
  headerBuf.writeUInt8(code, 0);
  headerBuf.writeUInt8(identifier, 1);
  headerBuf.writeUInt16BE(packetLen, 2);
  requestAuthenticator.copy(headerBuf, 4, 0, 16);

  // MD5 Authenticator = MD5(Code + Id + Length + RequestAuth + Attributes + Secret)
  const md5Hash = crypto.createHash('md5')
    .update(headerBuf)
    .update(allAttrsBuf)
    .update(secretBuf)
    .digest();

  md5Hash.copy(headerBuf, 4, 0, 16);
  return Buffer.concat([headerBuf, allAttrsBuf]);
}

/**
 * Verifikasi Password CHAP RFC 2865
 * @param {Buffer} chapPasswordBuf - 17 bytes (1 byte ident + 16 bytes MD5 hash response)
 * @param {string} userSecret - Password plaintext pelanggan/pengguna
 * @param {Buffer} challengeBuf - Buffer challenge (dari atribut CHAP-Challenge atau request authenticator)
 * @returns {boolean}
 */
function verifyChapPassword(chapPasswordBuf, userSecret, challengeBuf) {
  if (!Buffer.isBuffer(chapPasswordBuf) || chapPasswordBuf.length < 17) {
    return false;
  }
  if (!Buffer.isBuffer(challengeBuf) || challengeBuf.length === 0) {
    return false;
  }

  const chapIdent = chapPasswordBuf[0];
  const chapResponse = chapPasswordBuf.slice(1, 17);

  // MD5(ident + userSecret + challenge)
  const hash = crypto.createHash('md5')
    .update(Buffer.from([chapIdent]))
    .update(Buffer.from(String(userSecret || ''), 'utf8'))
    .update(challengeBuf)
    .digest();

  try {
    return crypto.timingSafeEqual(chapResponse, hash);
  } catch (e) {
    return false;
  }
}

module.exports = {
  CODES,
  ATTR_TYPES,
  MIKROTIK_VENDOR_ID,
  MIKROTIK_VSAS,
  decodePacket,
  encodeResponsePacket,
  verifyChapPassword
};

