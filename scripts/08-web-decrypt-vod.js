#!/usr/bin/env node
'use strict';
/*
 * 08-web-decrypt-vod.js — 旧インターフェースの互換ラッパ
 *
 * 中身はルートの nhk-dl に統合した。このファイルは調査当時のコマンドを
 * そのまま走らせたい人向けに残してある。新しい使い方:
 *
 *   nhk-dl <エピソードURL|ID>
 *
 * （pywidevine も不要になっている。Bearer トークンも自動発行する。）
 * 旧版のフル実装は git 履歴と docs/findings.md に残してある。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'nhk-dl.js');

function parseLegacyArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

const opts = parseLegacyArgs(process.argv.slice(2));

// 入力（どれでも nhk-dl の位置引数 1 つになる）
const target =
  opts.url || opts['episode-id'] || opts['descriptor-url'] || opts.master || opts['video-playlist'];

if (!target || opts.help) {
  process.stderr.write(
    [
      '08-web-decrypt-vod.js は nhk-dl の互換ラッパになりました。',
      '',
      '  新: nhk-dl <エピソードURL|ID> [--wvd device.wvd]',
      '  旧: node scripts/08-web-decrypt-vod.js --url <URL> --bearer-token <tok> --wvd <wvd> --output <mp4>',
      '',
      '使える旧フラグ: --url / --episode-id / --descriptor-url / --master / --video-playlist /',
      '                --bearer-token / --wvd / --output / --max-segments / --work-dir / --license-url',
      '',
      '詳しいオプションは nhk-dl --help を参照。',
    ].join('\n') + '\n'
  );
  process.exit(target ? 0 : 1);
}

if (opts['audio-playlist'] || opts['subtitle-playlist']) {
  process.stderr.write(
    '注意: --audio-playlist / --subtitle-playlist は廃止しました。マスタープレイリストから自動選択します。\n'
  );
}
if (opts['concat-subtitles']) {
  process.stderr.write('注意: 字幕の結合は既定動作になりました（--no-subtitles で無効化）。\n');
}

const args = [CLI, String(target)];
const passthrough = {
  'bearer-token': 'bearer-token',
  wvd: 'wvd',
  output: 'output',
  'max-segments': 'max-segments',
  'work-dir': 'work-dir',
  'license-url': 'license-url',
  quality: 'quality',
};

for (const [legacy, current] of Object.entries(passthrough)) {
  const value = opts[legacy];
  if (value === undefined) continue;
  if (value === true) args.push('--' + current);
  else args.push('--' + current, String(value));
}

// 旧版は .wvd 無しで「暗号化セグメントのダウンロードのみ」ができたが、現版は復号前提
if (!opts.wvd) {
  process.stderr.write(
    'ヒント: .wvd は --wvd / $NHK_WVD / nhk-dl config set-wvd のいずれかで指定します。\n'
  );
}
// 旧版は出力を無認可で上書きしていたので、その挙動に合わせる
args.push('--force');

process.stderr.write('→ node ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ') + '\n');

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
