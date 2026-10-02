'use strict';
/*
 * lib/auth.js — NHK ONE の Bearer トークン取得
 *
 * 最も重要な点: ブラウザを使わずに匿名 (accountless) トークンを発行できる。
 *
 *   1. consentToUse クッキーを自分でセットする
 *   2. GET https://www.web.nhk/tix/build_authorize?idp=r-alaz&profileType=anonymous&...
 *      をクッキージャー付きでリダイレクト追跷
 *   3. ジャーに入る z_at が authZ トークン (JWT, 有効期限 8 時間)
 *
 * クレーム実測値: iss=https://r.authz.ac1.nhk, profileType=anonymous,
 *                scope="get:news get:tv", exp-iat=28800
 *
 * idp の種類: r-alaz=accountless / a-alaz=abroad / d-alaz=emergency / acaz=account
 */

const fs = require('fs');
const { CookieJar, request } = require('./http');
const { TOKEN_PATH, ensureConfigDir } = require('./config');

const BFF_BASE = 'https://www.web.nhk';
const BUILD_AUTHORIZE_PATH = '/tix/build_authorize';

/** 既定のエリア（東京都千代田区）。配信にエリア制限がある場合はここを変える。 */
const DEFAULT_AREA = {
  areaId: '130',
  jisx0402: '13101',
  postal: '1000001',
  pref: '13',
};

// ============================================================
// JWT
// ============================================================

/** JWT のクレームをデコードする（署名検証なし） */
function decodeJwt(token) {
  const parts = String(token).replace(/^Bearer\s+/i, '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch (e) {
    return null;
  }
}

/** 有効期限切れ（または残り skewSeconds 未満）かどうか */
function isExpired(token, skewSeconds = 120) {
  const claims = decodeJwt(token);
  if (!claims || !claims.exp) return false; // exp が読めないものは判定不能として扱う
  return claims.exp * 1000 - skewSeconds * 1000 <= Date.now();
}

function describeToken(token) {
  const claims = decodeJwt(token);
  if (!claims) return { valid: false };
  const expiresAt = claims.exp ? new Date(claims.exp * 1000) : null;
  return {
    valid: true,
    issuer: claims.iss,
    profileType: claims.profileType,
    scope: claims.scope,
    clientId: claims.client_id,
    expiresAt,
    expiresInSeconds: claims.exp ? Math.max(0, Math.floor(claims.exp - Date.now() / 1000)) : null,
    expired: isExpired(token, 0),
  };
}

// ============================================================
// 匿名トークンの発行
// ============================================================

function consentCookieValue(area, entity) {
  return encodeURIComponent(
    JSON.stringify({
      status: 'optedin',
      entity: entity || 'none',
      area: {
        areaId: area.areaId,
        jisx0402: area.jisx0402,
        postal: area.postal,
        pref: area.pref,
      },
    })
  );
}

/**
 * ブラウザ不要で匿名 Bearer トークンを発行する。
 * @param {{area?:object, entity?:string}} [options]
 * @returns {Promise<{token:string, claims:object, cookies:object}>}
 */
async function issueAnonymousToken(options = {}) {
  const area = Object.assign({}, DEFAULT_AREA, options.area || {});
  const entity = options.entity || 'none';

  const jar = new CookieJar();
  jar.set('consentToUse', consentCookieValue(area, entity));

  const query = new URLSearchParams({
    idp: 'r-alaz',
    profileType: 'anonymous',
    redirect_uri: 'https://www.web.nhk/',
    entity,
    area: area.areaId,
    pref: area.pref,
    jisx0402: area.jisx0402,
    postal: area.postal,
  });

  const url = BFF_BASE + BUILD_AUTHORIZE_PATH + '?' + query.toString();
  const res = await request(url, { jar, followRedirects: true, retries: 1, timeout: 30000 });

  const token = jar.get('z_at');
  if (!token) {
    throw new Error(
      '匿名トークンの発行に失敗しました (HTTP ' +
        res.status +
        ', z_at クッキーが返ってきません)。\n' +
        '  日本国内からアクセスできているか、NHK 側の仕様が変わっていないかを確認してください。\n' +
        '  手動取得: nhk-token paste （Chrome の z_at クッキーを貼る）'
    );
  }

  return { token, claims: decodeJwt(token) || {}, cookies: jar.toJSON() };
}

// ============================================================
// トークンの永続化
// ============================================================

function loadStoredToken() {
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    if (!stored || !stored.token) return null;
    return stored;
  } catch (e) {
    return null;
  }
}

function saveToken(token, source) {
  ensureConfigDir();
  const claims = decodeJwt(token) || {};
  const payload = {
    token: String(token).replace(/^Bearer\s+/i, ''),
    exp: claims.exp || null,
    iat: claims.iat || null,
    profileType: claims.profileType || null,
    source: source || 'unknown',
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return TOKEN_PATH;
}

function clearToken() {
  try {
    fs.unlinkSync(TOKEN_PATH);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// 解決ロジック
// ============================================================

/**
 * Bearer トークンを解決する。
 * 優先順: 引数 → $NHK_BEARER_TOKEN → 保存済み → 匿名トークン自動発行
 * @param {{token?:string, noAuto?:boolean, forceNew?:boolean, area?:object, log?:Function}} [options]
 * @returns {Promise<{token:string, source:string}>}
 */
async function resolveBearerToken(options = {}) {
  const log = options.log || (() => {});
  const strip = (t) => String(t).replace(/^Bearer\s+/i, '').trim();

  if (!options.forceNew) {
    if (options.token) return { token: strip(options.token), source: 'argument' };
    if (process.env.NHK_BEARER_TOKEN) {
      return { token: strip(process.env.NHK_BEARER_TOKEN), source: 'NHK_BEARER_TOKEN' };
    }

    const stored = loadStoredToken();
    if (stored && !isExpired(stored.token)) {
      const info = describeToken(stored.token);
      log('保存済みトークンを使用 (有効期限 ' + (info.expiresAt ? info.expiresAt.toLocaleString('ja-JP') : '?') + ')');
      return { token: stored.token, source: 'cache' };
    }
    if (stored) log('保存済みトークンは期限切れです。再発行します。');
  }

  if (options.noAuto) {
    throw new Error('有効な Bearer トークンがありません。--bearer-token で指定するか nhk-token auto を実行してください。');
  }

  log('匿名トークンを自動発行中...');
  const issued = await issueAnonymousToken({ area: options.area });
  saveToken(issued.token, 'anonymous');
  const info = describeToken(issued.token);
  log(
    '匿名トークンを取得しました (scope=' +
      (info.scope || '?') +
      ', 有効期限 ' +
      (info.expiresAt ? info.expiresAt.toLocaleString('ja-JP') : '?') +
      ')'
  );
  return { token: issued.token, source: 'anonymous' };
}

module.exports = {
  DEFAULT_AREA,
  decodeJwt,
  isExpired,
  describeToken,
  issueAnonymousToken,
  loadStoredToken,
  saveToken,
  clearToken,
  resolveBearerToken,
};
