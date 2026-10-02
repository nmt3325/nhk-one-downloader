'use strict';
/*
 * lib/license.js — Widevine ライセンスサーバーとのやりとり
 *
 * 実測: 匿名 (accountless) トークンでもコンテンツ鍵が返る。
 */

const { request } = require('./http');
const { WidevineDevice, WidevineSession, findPsshBoxes, selectKeyForKid } = require('./widevine');

const LICENSE_URL = 'https://licence.hsk.st.nhk/widevine/license';

/**
 * init セグメントから PSSH を取り出してコンテンツ鍵を取得する。
 * @param {{initBuffer:Buffer, wvdPath:string, bearerToken:string, licenseUrl?:string, device?:object}} options
 * @returns {Promise<{keys:Array, pssh:Buffer}>}
 */
async function fetchContentKeys(options) {
  const { initBuffer, bearerToken } = options;
  const licenseUrl = options.licenseUrl || LICENSE_URL;

  const psshBoxes = findPsshBoxes(initBuffer);
  if (!psshBoxes.length) {
    throw new Error('init セグメントに Widevine PSSH が見つかりません（暗号化されていない可能性もあります）');
  }

  const device = options.device || WidevineDevice.fromFile(options.wvdPath);
  const session = new WidevineSession(device);
  const challenge = session.generateChallenge(psshBoxes[0]);

  const res = await request(licenseUrl, {
    method: 'POST',
    body: challenge,
    bearerToken,
    headers: { 'Content-Type': 'application/octet-stream' },
    retries: 1,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'ライセンスサーバーが HTTP ' +
        res.status +
        ' を返しました。トークンが期限切れか権限不足です。\n' +
        '  nhk-token auto で再発行してください。'
    );
  }
  if (res.status !== 200) {
    throw new Error(
      'ライセンスサーバーが HTTP ' + res.status + ' を返しました: ' + res.data.toString('utf-8').slice(0, 300)
    );
  }

  const keys = session.parseLicense(res.data);
  const contentKeys = keys.filter((k) => k.type === 'CONTENT');
  if (!contentKeys.length) {
    throw new Error('ライセンスにコンテンツ鍵が含まれていません');
  }

  return { keys: contentKeys, allKeys: keys, pssh: psshBoxes[0], device };
}

/**
 * tenc の default_KID に一致する鍵を返す。見つからなければ先頭の鍵。
 */
function pickKey(keys, kidHex, fallbackLabel) {
  const matched = selectKeyForKid(keys, kidHex);
  if (matched) return { key: matched, matched: true };
  if (!keys.length) throw new Error('使えるコンテンツ鍵がありません');
  return { key: keys[0].key, matched: false, label: fallbackLabel };
}

module.exports = {
  LICENSE_URL,
  fetchContentKeys,
  pickKey,
};
