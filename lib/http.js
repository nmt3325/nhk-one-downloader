'use strict';
/*
 * lib/http.js — クッキージャー付きの最小 HTTP クライアント（Node 標準ライブラリのみ）
 *
 * 注意: Authorization ヘッダは api.web.nhk / licence.hsk.st.nhk にしか付けない。
 *       CDN (archive2.hsk.st.nhk) に付けると 400 が返る。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const REFERER = 'https://www.web.nhk/';
const ORIGIN = 'https://www.web.nhk';

/** Authorization ヘッダを送ってよいホスト */
const AUTH_HOSTS = new Set(['api.web.nhk', 'licence.hsk.st.nhk']);

// ============================================================
// Cookie Jar
// ============================================================

class CookieJar {
  constructor(initial) {
    this.cookies = new Map();
    if (initial) for (const [k, v] of Object.entries(initial)) this.cookies.set(k, v);
  }

  set(name, value) {
    this.cookies.set(name, value);
    return this;
  }

  get(name) {
    return this.cookies.get(name);
  }

  /** Set-Cookie ヘッダ群を取り込む（domain/path は無視して単一ジャーに詰める） */
  ingest(setCookieHeaders) {
    if (!setCookieHeaders) return this;
    for (const raw of [].concat(setCookieHeaders)) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || value === 'deleted') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }
}

// ============================================================
// request
// ============================================================

/**
 * @param {string} url
 * @param {object} [options]
 * @param {'GET'|'POST'} [options.method]
 * @param {Buffer|string} [options.body]
 * @param {object} [options.headers]
 * @param {string} [options.bearerToken]
 * @param {CookieJar} [options.jar]
 * @param {boolean} [options.followRedirects] 既定 true
 * @param {number} [options.timeout] ms
 * @param {number} [options.retries] リトライ回数
 * @returns {Promise<{status:number, headers:object, data:Buffer, url:string}>}
 */
async function request(url, options = {}) {
  const retries = options.retries === undefined ? 2 : options.retries;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

function requestOnce(url, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const headers = Object.assign(
      {
        'User-Agent': options.userAgent || UA,
        Referer: options.referer || REFERER,
        Origin: options.origin || ORIGIN,
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      options.headers || {}
    );

    if (options.bearerToken && AUTH_HOSTS.has(parsed.hostname)) {
      const t = options.bearerToken;
      headers.Authorization = t.startsWith('Bearer ') ? t : 'Bearer ' + t;
    }
    if (options.jar) {
      const cookie = options.jar.header();
      if (cookie) headers.Cookie = cookie;
    }

    const body = options.body;
    if (body !== undefined && body !== null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = lib.request(
      url,
      { method: options.method || 'GET', headers, timeout: options.timeout || 60000 },
      (res) => {
        if (options.jar) options.jar.ingest(res.headers['set-cookie']);

        const followRedirects = options.followRedirects !== false;
        if (followRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectCount >= (options.maxRedirects || 10)) {
            return reject(new Error('too many redirects: ' + url));
          }
          const next = new URL(res.headers.location, url).href;
          // 303 / POST からの転送は GET に落とす
          const nextOptions = Object.assign({}, options, { method: 'GET', body: undefined });
          return requestOnce(next, nextOptions, redirectCount + 1).then(resolve, reject);
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks), url })
        );
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout: ' + url)));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

async function fetchBuffer(url, options) {
  const res = await request(url, options);
  if (res.status !== 200) {
    throw new HttpError('HTTP ' + res.status + ' for ' + url, res);
  }
  return res.data;
}

async function fetchText(url, options) {
  return (await fetchBuffer(url, options)).toString('utf-8');
}

async function fetchJson(url, options) {
  return JSON.parse(await fetchText(url, options));
}

class HttpError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'HttpError';
    this.status = response && response.status;
    this.response = response;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * タスクを上限付き並列で実行する。
 * @param {number} limit
 * @param {Array} items
 * @param {(item:any, index:number)=>Promise<any>} worker
 */
async function parallelMap(limit, items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  UA,
  REFERER,
  ORIGIN,
  AUTH_HOSTS,
  CookieJar,
  HttpError,
  request,
  fetchBuffer,
  fetchText,
  fetchJson,
  parallelMap,
  sleep,
};
