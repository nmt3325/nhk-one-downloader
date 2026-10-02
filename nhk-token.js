#!/usr/bin/env node
'use strict';
/*
 * nhk-token — NHK ONE の Bearer トークンを用意する補助ツール
 *
 *   nhk-token auto    ブラウザ不要で匿名トークンを発行（既定）
 *   nhk-token show    保存済みトークンの状態
 *   nhk-token paste   手元のトークン / z_at クッキーを登録
 *   nhk-token clear   保存済みトークンを削除
 *
 * nhk-dl はトークンを自動発行するので、通常はこのツールを使わなくてもよい。
 * 自動発行が通らない環境（海外回線など）や、アカウント付きトークンを
 * 使いたいときのためのツール。
 */

const { parseArgs } = require('./lib/args');
const auth = require('./lib/auth');
const config = require('./lib/config');

const VERSION = '1.0.0';

const SPEC = {
  booleans: ['print', 'quiet', 'json', 'help', 'version'],
  aliases: { p: 'print', h: 'help', v: 'version' },
};

function usage() {
  return [
    'nhk-token ' + VERSION + ' — NHK ONE の Bearer トークン管理',
    '',
    '使い方:',
    '  nhk-token [auto]        匿名トークンを発行して保存（ブラウザ不要）',
    '  nhk-token show          保存済みトークンの有効期限などを表示',
    '  nhk-token paste [tok]   トークンを登録（引数省略で標準入力から読む）',
    '  nhk-token clear         保存済みトークンを削除',
    '',
    'オプション:',
    '  -p, --print           トークン文字列そのものを標準出力に出す',
    '      --json            JSON で出力',
    '      --area <id>       エリア ID (既定: 130 = 東京)',
    '      --pref <code>     都道府県コード (既定: 13)',
    '      --jisx0402 <code> 市区町村コード (既定: 13101)',
    '      --postal <code>   郵便番号 (既定: 1000001)',
    '      --quiet           メッセージを抑制',
    '  -h, --help  /  -v, --version',
    '',
    '環境変数 NHK_BEARER_TOKEN を設定している場合はそれが最優先で使われます。',
    '手動で取る場合: NHK ONE を開いて DevTools の Console で',
    "  document.cookie.match(/z_at=([^;]+)/)[1]",
    'を実行し、結果を nhk-token paste に渡します。',
  ].join('\n');
}

let QUIET = false;
let JSON_MODE = false;

function log(message) {
  if (QUIET || JSON_MODE) return;
  process.stderr.write(message + '\n');
}

function emit(payload, lines) {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  for (const line of lines) process.stdout.write(line + '\n');
}

function tokenSummary(token, source) {
  const info = auth.describeToken(token);
  return {
    source: source || null,
    valid: info.valid === true && !info.expired,
    expired: info.expired === true,
    profileType: info.profileType || null,
    scope: info.scope || null,
    issuer: info.issuer || null,
    clientId: info.clientId || null,
    expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
    expiresInSeconds: info.expiresInSeconds,
  };
}

function summaryLines(summary) {
  const remain =
    summary.expiresInSeconds === null || summary.expiresInSeconds === undefined
      ? '?'
      : Math.floor(summary.expiresInSeconds / 60) + ' 分';
  return [
    '状態      : ' + (summary.expired ? '期限切れ' : summary.valid ? '有効' : '不明'),
    'profile   : ' + (summary.profileType || '?'),
    'scope     : ' + (summary.scope || '?'),
    'issuer    : ' + (summary.issuer || '?'),
    '有効期限  : ' + (summary.expiresAt ? new Date(summary.expiresAt).toLocaleString('ja-JP') : '?') + ' (残り ' + remain + ')',
    '保存先    : ' + config.TOKEN_PATH,
  ];
}

function areaFromFlags(flags) {
  const area = {};
  if (typeof flags.area === 'string') area.areaId = flags.area;
  if (typeof flags.pref === 'string') area.pref = flags.pref;
  if (typeof flags.jisx0402 === 'string') area.jisx0402 = flags.jisx0402;
  if (typeof flags.postal === 'string') area.postal = flags.postal;
  return Object.keys(area).length ? area : undefined;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      process.stderr.write('トークンまたは z_at クッキーを貼り付けて Enter:\n');
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (process.stdin.isTTY && data.includes('\n')) {
        process.stdin.pause();
        resolve(data);
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** 生 JWT / "z_at=..." / "Authorization: Bearer ..." のいずれでも受け付ける */
function extractToken(text) {
  const raw = String(text).trim();
  const cookie = raw.match(/z_at=([^;\s"']+)/);
  if (cookie) return decodeURIComponent(cookie[1]);
  const jwt = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwt) return jwt[0];
  return raw.replace(/^Bearer\s+/i, '').trim();
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), SPEC);

  QUIET = flags.quiet === true;
  JSON_MODE = flags.json === true;

  if (flags.version === true) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (flags.help === true) {
    process.stdout.write(usage() + '\n');
    return 0;
  }

  const command = positional[0] || 'auto';

  if (command === 'auto') {
    log('匿名トークンを発行中...');
    const issued = await auth.issueAnonymousToken({ area: areaFromFlags(flags) });
    auth.saveToken(issued.token, 'anonymous');
    const summary = tokenSummary(issued.token, 'anonymous');
    if (flags.print === true) {
      process.stdout.write(issued.token + '\n');
      return 0;
    }
    emit(Object.assign({ token: undefined }, summary), ['匿名トークンを保存しました。'].concat(summaryLines(summary)));
    return 0;
  }

  if (command === 'show') {
    const envToken = process.env.NHK_BEARER_TOKEN;
    const stored = auth.loadStoredToken();
    const token = envToken || (stored && stored.token);
    if (!token) {
      if (JSON_MODE) process.stdout.write(JSON.stringify({ valid: false, source: null }, null, 2) + '\n');
      else process.stdout.write('トークンはまだありません。nhk-token auto で発行してください。\n');
      return 1;
    }
    if (flags.print === true) {
      process.stdout.write(token + '\n');
      return 0;
    }
    const summary = tokenSummary(token, envToken ? 'NHK_BEARER_TOKEN' : (stored && stored.source) || 'cache');
    emit(summary, ['source    : ' + summary.source].concat(summaryLines(summary)));
    return summary.expired ? 1 : 0;
  }

  if (command === 'paste') {
    const input = positional[1] || (await readStdin());
    const token = extractToken(input);
    if (!token) throw new Error('トークンを読み取れませんでした。');
    const claims = auth.decodeJwt(token);
    if (!claims) {
      throw new Error(
        'JWT として解釈できません。z_at クッキーの値か Bearer トークンを渡してください。'
      );
    }
    auth.saveToken(token, 'manual');
    const summary = tokenSummary(token, 'manual');
    if (summary.expired) log('注意: このトークンはすでに期限切れです。');
    emit(summary, ['トークンを保存しました。'].concat(summaryLines(summary)));
    return 0;
  }

  if (command === 'clear') {
    const removed = auth.clearToken();
    if (JSON_MODE) process.stdout.write(JSON.stringify({ removed }, null, 2) + '\n');
    else process.stdout.write((removed ? '削除しました: ' : '保存済みトークンはありません: ') + config.TOKEN_PATH + '\n');
    return 0;
  }

  throw new Error('不明なコマンド: ' + command + '\n  使えるもの: auto / show / paste / clear');
}

main()
  .then((code) => process.exit(code || 0))
  .catch((error) => {
    process.stderr.write('✗ ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exit(1);
  });
