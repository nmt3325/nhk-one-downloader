'use strict';
/*
 * lib/widevine.js — Node 標準 crypto だけで動く Widevine CDM 実装
 *
 * pywidevine / Python への依存を無くすために書き起こしたもの。
 * 対応範囲:
 *   - .wvd (v1/v2) デバイスファイルの読み込み
 *   - ライセンスチャレンジ (SignedMessage/LICENSE_REQUEST) の生成
 *   - ライセンス応答の解析とコンテンツ鍵の復号
 *
 * 参考: chrome-extension/lib/widevine.js (ブラウザ用 WebCrypto 版)
 */

const fs = require('fs');
const crypto = require('crypto');

// ============================================================
// protobuf (必要最小限のエンコーダ / デコーダ)
// ============================================================

class ProtoWriter {
  constructor() {
    this.parts = [];
  }

  _varint(value) {
    let v = BigInt(value);
    if (v < 0n) throw new Error('negative varint is not supported');
    const bytes = [];
    while (v > 0x7fn) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.parts.push(Buffer.from(bytes));
  }

  _tag(field, wire) {
    this._varint((field << 3) | wire);
  }

  /** varint フィールド */
  uint(field, value) {
    this._tag(field, 0);
    this._varint(value);
    return this;
  }

  /** length-delimited フィールド (bytes / string / embedded message) */
  bytes(field, value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._tag(field, 2);
    this._varint(buf.length);
    this.parts.push(buf);
    return this;
  }

  finish() {
    return Buffer.concat(this.parts);
  }
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let o = offset;
  while (o < buf.length) {
    const b = buf[o++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  return [result, o];
}

/**
 * protobuf メッセージをフィールド配列に分解する。
 * @returns {{field:number, wire:number, value:Buffer|bigint}[]}
 */
function parseProto(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    let tag;
    [tag, o] = readVarint(buf, o);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value;
    if (wire === 0) {
      [value, o] = readVarint(buf, o);
    } else if (wire === 2) {
      let len;
      [len, o] = readVarint(buf, o);
      const n = Number(len);
      value = buf.subarray(o, o + n);
      o += n;
    } else if (wire === 1) {
      value = buf.subarray(o, o + 8);
      o += 8;
    } else if (wire === 5) {
      value = buf.subarray(o, o + 4);
      o += 4;
    } else {
      throw new Error('unsupported protobuf wire type ' + wire);
    }
    out.push({ field, wire, value });
  }
  return out;
}

function firstField(fields, field) {
  for (const f of fields) if (f.field === field) return f.value;
  return undefined;
}

// ============================================================
// AES-CMAC (RFC 4493)
// ============================================================

function ecbEncryptBlock(key, block) {
  const algo = key.length === 16 ? 'aes-128-ecb' : key.length === 24 ? 'aes-192-ecb' : 'aes-256-ecb';
  const cipher = crypto.createCipheriv(algo, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function shiftLeft1(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const v = (buf[i] << 1) | carry;
    out[i] = v & 0xff;
    carry = (v >> 8) & 1;
  }
  return { out, carry };
}

function subkey(l) {
  const { out, carry } = shiftLeft1(l);
  if (carry) out[out.length - 1] ^= 0x87;
  return out;
}

function xorBuf(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function aesCmac(key, message) {
  const L = ecbEncryptBlock(key, Buffer.alloc(16));
  const K1 = subkey(L);
  const K2 = subkey(K1);

  const n = Math.ceil(message.length / 16) || 1;
  const blocks = [];
  for (let i = 0; i < n - 1; i++) blocks.push(message.subarray(i * 16, (i + 1) * 16));
  const last = message.subarray((n - 1) * 16);
  if (last.length === 16) {
    blocks.push(xorBuf(last, K1));
  } else {
    const padded = Buffer.alloc(16);
    last.copy(padded);
    padded[last.length] = 0x80;
    blocks.push(xorBuf(padded, K2));
  }

  let x = Buffer.alloc(16);
  for (const block of blocks) x = ecbEncryptBlock(key, xorBuf(x, block));
  return x;
}

// ============================================================
// PSSH / WVD
// ============================================================

const WIDEVINE_SYSTEM_ID = Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex');

/** fMP4 / init セグメント中の Widevine PSSH ボックスをすべて返す */
function findPsshBoxes(data) {
  const results = [];
  let start = 0;
  const needle = Buffer.from('pssh');
  while (true) {
    const idx = data.indexOf(needle, start);
    if (idx === -1) break;
    start = idx + 4;
    if (idx < 4) continue;
    const size = data.readUInt32BE(idx - 4);
    if (size < 32 || size > 4096 || idx - 4 + size > data.length) continue;
    const box = data.subarray(idx - 4, idx - 4 + size);
    if (box.subarray(12, 28).equals(WIDEVINE_SYSTEM_ID)) results.push(Buffer.from(box));
  }
  return results;
}

/** PSSH ボックスから init_data (WidevinePsshData のシリアライズ) を取り出す */
function parsePsshBox(box) {
  const version = box[8];
  if (version === 0) {
    const len = box.readUInt32BE(28);
    return box.subarray(32, 32 + len);
  }
  if (version === 1) {
    const kidCount = box.readUInt32BE(28);
    const o = 32 + kidCount * 16;
    const len = box.readUInt32BE(o);
    return box.subarray(o + 4, o + 4 + len);
  }
  throw new Error('unsupported pssh version ' + version);
}

/**
 * PSSH ボックスでも init_data 単体でも受け取れるように正規化する。
 * @param {Buffer|string} input Buffer か base64 文字列
 */
function normalizeInitData(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'base64');
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'pssh') return parsePsshBox(buf);
  return buf;
}

/** pywidevine の .wvd (WVD v1/v2) を読む */
function parseWvd(data) {
  if (data.subarray(0, 3).toString('latin1') !== 'WVD') throw new Error('not a .wvd file (bad magic)');
  const version = data[3];
  const type = data[4];
  const securityLevel = data[5];
  // data[6] = flags
  let o = 7;
  const privateKeyLen = data.readUInt16BE(o);
  o += 2;
  const privateKeyDer = Buffer.from(data.subarray(o, o + privateKeyLen));
  o += privateKeyLen;
  const clientIdLen = data.readUInt16BE(o);
  o += 2;
  const clientIdBytes = Buffer.from(data.subarray(o, o + clientIdLen));
  return { version, type, securityLevel, privateKeyDer, clientIdBytes };
}

// ============================================================
// CDM
// ============================================================

const DEVICE_TYPE_NAMES = { 1: 'CHROME', 2: 'ANDROID' };

const KEY_TYPE_NAMES = {
  1: 'SIGNING',
  2: 'CONTENT',
  3: 'KEY_CONTROL',
  4: 'OPERATOR_SESSION',
  5: 'ENTITLEMENT',
};

/** Widevine の鍵導出コンテキスト (ENCRYPTION / AUTHENTICATION) */
function deriveContext(message) {
  return {
    enc: Buffer.concat([Buffer.from('ENCRYPTION\u0000', 'latin1'), message, Buffer.from([0, 0, 0, 0x80])]),
    mac: Buffer.concat([Buffer.from('AUTHENTICATION\u0000', 'latin1'), message, Buffer.from([0, 0, 0x02, 0])]),
  };
}

class WidevineDevice {
  constructor(parsed) {
    this.version = parsed.version;
    this.type = parsed.type;
    this.typeName = DEVICE_TYPE_NAMES[parsed.type] || String(parsed.type);
    this.securityLevel = parsed.securityLevel;
    this.clientIdBytes = parsed.clientIdBytes;
    this.privateKey = crypto.createPrivateKey({ key: parsed.privateKeyDer, format: 'der', type: 'pkcs1' });
  }

  static fromFile(wvdPath) {
    return new WidevineDevice(parseWvd(fs.readFileSync(wvdPath)));
  }
}

/** ライセンス取得 1 回分のセッション */
class WidevineSession {
  constructor(device, options = {}) {
    this.device = device;
    this.number = options.number || 1;
    this.licenseRequest = null;
    this.context = null;
  }

  _requestId() {
    if (this.device.type === 2) {
      // Android の OEMCrypto は「4バイトカウンタ + 8バイト乱数」を hex 文字列化した形
      const counter = this.number.toString(16).padStart(8, '0');
      const rand = crypto.randomBytes(8).toString('hex');
      return Buffer.from(counter + rand, 'latin1');
    }
    return crypto.randomBytes(16);
  }

  /**
   * ライセンスチャレンジを生成する。
   * @param {Buffer|string} pssh PSSH ボックス / init_data / base64
   * @param {'STREAMING'|'OFFLINE'} licenseType
   */
  generateChallenge(pssh, licenseType = 'STREAMING') {
    const initData = normalizeInitData(pssh);
    const typeValue = licenseType === 'OFFLINE' ? 2 : 1;

    // LicenseRequest.ContentIdentification.WidevinePsshData
    const psshData = new ProtoWriter()
      .bytes(1, initData)            // pssh_data (repeated)
      .uint(2, typeValue)            // license_type
      .bytes(3, this._requestId())   // request_id
      .finish();

    // LicenseRequest.ContentIdentification
    const contentId = new ProtoWriter().bytes(1, psshData).finish();

    // LicenseRequest
    const licenseRequest = new ProtoWriter()
      .bytes(1, this.device.clientIdBytes)      // client_id
      .bytes(2, contentId)                      // content_id
      .uint(3, 1)                               // type = NEW
      .uint(4, Math.floor(Date.now() / 1000))   // request_time
      .uint(6, 21)                              // protocol_version = VERSION_2_1
      .uint(7, crypto.randomInt(1, 2 ** 31))    // key_control_nonce
      .finish();

    const signature = crypto.sign('sha1', licenseRequest, {
      key: this.device.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 20,
    });

    this.licenseRequest = licenseRequest;
    this.context = deriveContext(licenseRequest);

    // SignedMessage
    return new ProtoWriter()
      .uint(1, 1)                 // type = LICENSE_REQUEST
      .bytes(2, licenseRequest)   // msg
      .bytes(3, signature)        // signature
      .finish();
  }

  /**
   * ライセンス応答を解析して鍵を返す。
   * @returns {{kid:string|null, key:string, type:string}[]}
   */
  parseLicense(response) {
    if (!this.licenseRequest) throw new Error('generateChallenge() must be called first');
    const buf = Buffer.isBuffer(response) ? response : Buffer.from(response);
    const signed = parseProto(buf);

    const typeField = firstField(signed, 1);
    const msgType = typeField === undefined ? 0 : Number(typeField);
    if (msgType === 3) {
      throw new Error('license server returned ERROR_RESPONSE (type 3)');
    }
    if (msgType !== 2) {
      throw new Error('expected LICENSE(2) but got message type ' + msgType);
    }

    const licenseMsg = firstField(signed, 2);
    const sessionKeyEnc = firstField(signed, 4);
    if (!licenseMsg || !sessionKeyEnc) throw new Error('license response is missing msg/session_key');

    const sessionKey = crypto.privateDecrypt(
      {
        key: this.device.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      },
      sessionKeyEnc
    );

    const encKey = aesCmac(sessionKey, Buffer.concat([Buffer.from([1]), this.context.enc]));

    const keys = [];
    for (const field of parseProto(licenseMsg)) {
      if (field.field !== 3) continue; // License.key (repeated KeyContainer)
      const container = parseProto(field.value);
      const kid = firstField(container, 1);
      const iv = firstField(container, 2);
      const encrypted = firstField(container, 3);
      const keyTypeRaw = firstField(container, 4);
      const keyType = keyTypeRaw === undefined ? 0 : Number(keyTypeRaw);
      if (!iv || !encrypted) continue;

      let plain;
      try {
        const d = crypto.createDecipheriv('aes-128-cbc', encKey, iv);
        d.setAutoPadding(true);
        plain = Buffer.concat([d.update(encrypted), d.final()]);
      } catch (e) {
        // パディング無しで鍵を返すサーバへのフォールバック
        const d2 = crypto.createDecipheriv('aes-128-cbc', encKey, iv);
        d2.setAutoPadding(false);
        plain = Buffer.concat([d2.update(encrypted), d2.final()]);
      }

      keys.push({
        kid: kid && kid.length ? Buffer.from(kid).toString('hex') : null,
        key: plain.toString('hex'),
        type: KEY_TYPE_NAMES[keyType] || String(keyType),
      });
    }
    return keys;
  }
}

/** KID からコンテンツ鍵を選ぶ (ハイフンや大文字を正規化) */
function selectKeyForKid(keys, kidHex) {
  if (!kidHex) return null;
  const norm = String(kidHex).replace(/-/g, '').toLowerCase();
  for (const k of keys) {
    if (!k.kid) continue;
    if (k.kid.replace(/-/g, '').toLowerCase() === norm) return k.key;
  }
  return null;
}

module.exports = {
  WidevineDevice,
  WidevineSession,
  findPsshBoxes,
  parsePsshBox,
  normalizeInitData,
  parseWvd,
  aesCmac,
  selectKeyForKid,
  WIDEVINE_SYSTEM_ID,
};
