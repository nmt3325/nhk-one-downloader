#!/usr/bin/env node
'use strict';
/*
 * nhk-dl — NHK ONE 見逃し配信ダウンローダ
 *
 *   nhk-dl <エピソードURL|エピソードID> [device.wvd]
 *
 * 必要なもの: Widevine L3 の .wvd と ffmpeg。
 * Bearer トークンはブラウザ不要の匿名トークンを自動発行する。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, toInt } = require('./lib/args');
const config = require('./lib/config');
const auth = require('./lib/auth');
const nhk = require('./lib/nhk');
const hls = require('./lib/hls');
const http = require('./lib/http');
const download = require('./lib/download');
const license = require('./lib/license');

const VERSION = '1.0.0';

const SPEC = {
  booleans: [
    'info',
    'list',
    'all',
    'json',
    'quiet',
    'force',
    'subtitles',
    'keep-work',
    'keep-subtitle-tokens',
    'auto-token',
    'help',
    'version',
  ],
  aliases: {
    o: 'output',
    d: 'output-dir',
    q: 'quality',
    j: 'concurrency',
    a: 'all',
    h: 'help',
    v: 'version',
  },
};

let QUIET = false;
let JSON_MODE = false;

/** 進捗やメッセージ（stderr） */
function log(message) {
  if (QUIET || JSON_MODE) return;
  process.stderr.write(message + '\n');
}

/** 結果データ（stdout） */
function out(message) {
  if (JSON_MODE) return;
  process.stdout.write(message + '\n');
}

function usage() {
  return [
    'nhk-dl ' + VERSION + ' — NHK ONE 見逃し配信ダウンローダ',
    '',
    '使い方:',
    '  nhk-dl <URL|エピソードID> [device.wvd] [オプション]',
    '  nhk-dl config set-wvd <device.wvd>',
    '',
    'クイックスタート:',
    '  1) nhk-dl config set-wvd ./device.wvd         # .wvd を一度だけ登録',
    '  2) nhk-dl https://www.web.nhk/ep/XXXXXXXXXX   # あとは URL を渡すだけ',
    '',
    '入力に使えるもの:',
    '  エピソード URL / エピソード ID / シリーズ URL / videoinfo-*.json / master.m3u8',
    '',
    'オプション:',
    '      --wvd <path>          .wvd を指定 ($NHK_WVD / config.json / カレントも探索)',
    '  -o, --output <file>       出力ファイル名',
    '  -d, --output-dir <dir>    出力ディレクトリ (既定: カレント)',
    '  -q, --quality <q>         best(既定) / worst / 1080 / 720 / 3000k',
    '      --audio <kind>        main(既定) / sub   副音声を取る場合は sub',
    '      --no-subtitles        字幕を埋め込まない',
    '      --keep-subtitle-tokens  ARIB 制御記号をそのまま残す',
    '  -j, --concurrency <n>     セグメント並列数 (既定: 6)',
    '      --max-segments <n>    先頭 n セグメントだけ取る（動作確認用）',
    '      --info                メタデータだけ表示',
    '      --list                画質一覧を表示',
    '  -a, --all                 シリーズ URL の全エピソードを取得',
    '      --force               既存ファイルを上書き',
    '      --work-dir <dir>      作業ディレクトリ',
    '      --keep-work           作業ファイルを残す',
    '      --bearer-token <tok>  トークンを明示指定',
    '      --no-auto-token       トークンの自動発行を無効化',
    '      --license-url <url>   ライセンスサーバー URL',
    '      --ffmpeg <path>       ffmpeg のパス',
    '      --json                結果を JSON で出力',
    '      --quiet               進捗表示を抑制',
    '  -h, --help  /  -v, --version',
    '',
    'トークンは既定でブラウザ不要の匿名トークンを自動発行します。',
    '個別に扱いたい場合は同梱の nhk-token を使ってください。',
  ].join('\n');
}

// ============================================================
// config サブコマンド
// ============================================================

function runConfig(args) {
  const action = args[0];

  if (action === 'set-wvd') {
    const target = args[1];
    if (!target) throw new Error('使い方: nhk-dl config set-wvd <device.wvd>');
    const resolved = config.resolveWvd(target);
    config.updateConfig({ wvd: resolved.path });
    out('.wvd を登録しました: ' + resolved.path);
    out('設定ファイル: ' + config.CONFIG_PATH);
    return 0;
  }

  if (action === 'show' || !action) {
    const current = config.readConfig();
    out('設定ディレクトリ: ' + config.CONFIG_DIR);
    out('wvd            : ' + (current.wvd || '(未設定)'));
    const stored = auth.loadStoredToken();
    if (stored) {
      const info = auth.describeToken(stored.token);
      out(
        'token          : ' +
          (info.expired ? '期限切れ' : '有効') +
          ' (' +
          (info.expiresAt ? info.expiresAt.toLocaleString('ja-JP') : '?') +
          ', source=' +
          stored.source +
          ')'
      );
    } else {
      out('token          : (未保存)');
    }
    return 0;
  }

  throw new Error('不明なサブコマンド: config ' + action + '\n  使えるもの: set-wvd / show');
}

// ============================================================
// 入力 → マスタープレイリスト
// ============================================================

async function loadMaster(masterUrl, token) {
  const text = await http.fetchText(masterUrl, { bearerToken: token });
  const master = hls.parseMasterPlaylist(text, masterUrl);
  if (!master.variants.length) {
    throw new Error(
      '映像バリアントが見つかりません。マスタープレイリストの URL を渡してください: ' + masterUrl
    );
  }
  master.url = masterUrl;
  return master;
}

/**
 * 分類済みの入力を、メタデータ + マスタープレイリストに解決する。
 */
async function resolveTarget(target, token) {
  if (target.kind === 'episode') {
    const data = await nhk.fetchEpisode(target.value, token);
    const info = nhk.summarizeEpisode(data);
    nhk.assertPlayable(info);
    const descriptor = await nhk.fetchDescriptor(info.descriptorUrl, token);
    const manifest = nhk.selectManifest(descriptor);
    return { info, descriptor, manifest, master: await loadMaster(manifest.url, token) };
  }

  if (target.kind === 'descriptor') {
    const descriptor = await nhk.fetchDescriptor(target.value, token);
    const manifest = nhk.selectManifest(descriptor);
    const id = (target.value.match(/videoinfo-([A-Za-z0-9_-]+)/) || [])[1] || 'nhk-one';
    return {
      info: { id, episodeName: id, seriesName: '', broadcastDate: null },
      descriptor,
      manifest,
      master: await loadMaster(manifest.url, token),
    };
  }

  if (target.kind === 'playlist') {
    const master = await loadMaster(target.value, token);
    const id = (new URL(target.value).pathname.match(/\/([A-Za-z0-9_-]{6,})\//) || [])[1] || 'nhk-one';
    return {
      info: { id, episodeName: id, seriesName: '', broadcastDate: null },
      descriptor: null,
      manifest: { url: target.value },
      master,
    };
  }

  throw new Error('この入力はここでは扱えません: ' + target.kind);
}

/**
 * バリアントの init セグメントを並列取得して解像度とセグメント数を埋める。
 * マスターに RESOLUTION 属性がないため、解像度指定と --list で必要になる。
 */
async function probeVariants(variants, token) {
  await http.parallelMap(Math.min(6, variants.length), variants, async (variant) => {
    if (variant.probe) return;
    try {
      const probe = await download.probeTrack({ playlistUrl: variant.uri, bearerToken: token });
      variant.probe = probe;
      variant.segmentCount = probe.playlist.segments.length;
      variant.totalDuration = probe.playlist.totalDuration;
      if (probe.initBuffer) {
        const resolution = hls.parseVideoResolution(probe.initBuffer);
        if (resolution) {
          variant.width = resolution.width;
          variant.height = resolution.height;
          variant.resolution = resolution.resolution;
          variant.codec = resolution.codec;
        }
      }
    } catch (e) {
      variant.probeError = e.message;
    }
  });
  return variants;
}

/** 解像度指定（1080 / 720p など）かどうか */
function needsResolutionProbe(quality) {
  if (!quality || quality === 'best' || quality === 'worst') return false;
  const raw = String(quality).toLowerCase();
  if (/k|kbps|^v/.test(raw)) return false;
  const num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return !Number.isNaN(num) && num < 2000;
}

// ============================================================
// 表示
// ============================================================

function describeVariant(variant) {
  const kbps = Math.round(variant.bandwidth / 1000) + ' kbps';
  return (variant.resolution || variant.tier || '?') + ' (' + kbps + ')';
}

function printInfo(resolved) {
  const info = resolved.info;
  const seconds = nhk.parseIsoDuration(info.duration);
  out('作品    : ' + [info.seriesName, info.episodeName].filter(Boolean).join(' / '));
  if (info.id) out('ID      : ' + info.id);
  if (info.channel) out('放送局  : ' + info.channel);
  if (info.broadcastDate) out('放送日  : ' + info.broadcastDate);
  if (seconds !== null) out('長さ    : ' + nhk.formatDuration(seconds));
  if (info.expires) out('配信期限: ' + info.expires);
  if (info.description) out('概要    : ' + info.description.replace(/\s+/g, ' ').slice(0, 200));
  out('映像    : ' + resolved.master.variants.length + ' バリアント / 音声 ' + resolved.master.audios.length + ' / 字幕 ' + resolved.master.subtitles.length);
  if (resolved.manifest && resolved.manifest.url) out('master  : ' + resolved.manifest.url);
}

async function printQualityList(resolved, token) {
  await probeVariants(resolved.master.variants, token);
  out('画質一覧 (-q で指定):');
  resolved.master.variants.forEach((variant, index) => {
    const marker = index === 0 ? '*' : ' ';
    const segments = variant.segmentCount ? variant.segmentCount + ' seg' : '?';
    out(
      '  ' +
        marker +
        ' ' +
        String(variant.height || '?').padStart(5) +
        'p  ' +
        String(Math.round(variant.bandwidth / 1000)).padStart(5) +
        ' kbps  ' +
        (variant.tier || '').padEnd(6) +
        segments +
        (variant.probeError ? '  (取得失敗: ' + variant.probeError + ')' : '')
    );
  });
  const audioNames = resolved.master.audios
    .map((a) => a.groupId + '/' + (a.name || '?'))
    .join(', ');
  if (audioNames) out('音声: ' + audioNames);
  if (resolved.master.subtitles.length) {
    out('字幕: ' + resolved.master.subtitles.map((s) => s.lang || s.name || 'ja').join(', '));
  }
  out('* = 既定 (best)');
}

// ============================================================
// ダウンロード本体
// ============================================================

async function runDownload(resolved, ctx) {
  const { token, flags, wvdPath, ffmpegPath } = ctx;
  const { info, master } = resolved;

  const concurrency = toInt(flags.concurrency, 6);
  const maxSegments = toInt(flags.maxSegments, null);
  const quality = typeof flags.quality === 'string' ? flags.quality : 'best';
  const licenseUrl = typeof flags.licenseUrl === 'string' ? flags.licenseUrl : undefined;
  const showProgress = !QUIET && !JSON_MODE;

  if (needsResolutionProbe(quality)) await probeVariants(master.variants, token);

  const variant = hls.selectVariant(master.variants, quality);
  if (!variant) throw new Error('映像バリアントを選べませんでした');
  const audioKind = flags.audio === 'sub' ? 'sub' : 'main';
  const audio = hls.selectAudio(master.audios, variant, audioKind);
  if (!audio) throw new Error('音声トラックが見つかりません');
  const subtitle = flags.subtitles === false ? null : master.subtitles[0] || null;

  // 出力先
  const outputDir = typeof flags.outputDir === 'string' ? flags.outputDir : process.cwd();
  const outputPath =
    typeof flags.output === 'string'
      ? path.resolve(flags.output)
      : path.join(path.resolve(outputDir), nhk.buildFilename(info));
  if (fs.existsSync(outputPath) && flags.force !== true) {
    throw new Error(
      '出力ファイルが既にあります: ' +
        outputPath +
        '\n  上書きするなら --force、別名にするなら -o <file> を使ってください。'
    );
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const workRoot =
    typeof flags.workDir === 'string' ? path.resolve(flags.workDir) : path.join(os.tmpdir(), 'nhk-dl');
  const workDir = path.join(workRoot, (info.id || 'nhk-one') + '-' + (variant.tier || 'v'));
  fs.mkdirSync(workDir, { recursive: true });

  const title = [info.seriesName, info.episodeName].filter(Boolean).join(' ').trim() || info.id;
  log(
    '▸ ' + title + (info.broadcastDate ? '  (' + String(info.broadcastDate).slice(0, 10) + ')' : '')
  );

  // トラックの下調べ（解像度 / KID / セグメント数）
  const videoProbe =
    variant.probe || (await download.probeTrack({ playlistUrl: variant.uri, bearerToken: token }));
  variant.probe = videoProbe;
  if (!variant.resolution && videoProbe.initBuffer) {
    const resolution = hls.parseVideoResolution(videoProbe.initBuffer);
    if (resolution) {
      variant.width = resolution.width;
      variant.height = resolution.height;
      variant.resolution = resolution.resolution;
    }
  }
  const audioProbe = await download.probeTrack({ playlistUrl: audio.uri, bearerToken: token });

  const segmentTotal = videoProbe.playlist.segments.length;
  const segmentCount = maxSegments ? Math.min(maxSegments, segmentTotal) : segmentTotal;
  log(
    '  ' +
      describeVariant(variant) +
      ' ・ 音声 ' +
      (audio.name || '?') +
      (audio.tier ? ' (' + audio.tier + ')' : '') +
      ' ・ 字幕 ' +
      (subtitle ? subtitle.lang || 'ja' : 'なし')
  );
  log(
    '  ' +
      segmentCount +
      '/' +
      segmentTotal +
      ' セグメント ・ ' +
      nhk.formatDuration(Math.round(videoProbe.playlist.totalDuration))
  );

  const videoKid = videoProbe.initBuffer ? hls.parseTencKid(videoProbe.initBuffer) : null;
  const audioKid = audioProbe.initBuffer ? hls.parseTencKid(audioProbe.initBuffer) : null;

  // [1/4] 鍵（先に取っておく——失敗するならダウンロード前に失敗したい）
  log('  [1/4] 鍵を取得');
  const licenseResult = await license.fetchContentKeys({
    initBuffer: videoProbe.initBuffer,
    wvdPath,
    bearerToken: token,
    licenseUrl,
  });
  const videoPick = license.pickKey(licenseResult.keys, videoKid, 'video');
  let audioPick = audioKid ? license.pickKey(licenseResult.keys, audioKid, 'audio') : videoPick;
  if (audioKid && !audioPick.matched && audioProbe.initBuffer) {
    // 音声が別ライセンスのケースを試す
    try {
      const audioLicense = await license.fetchContentKeys({
        initBuffer: audioProbe.initBuffer,
        bearerToken: token,
        licenseUrl,
        device: licenseResult.device,
      });
      const retry = license.pickKey(audioLicense.keys, audioKid, 'audio');
      if (retry.matched) audioPick = retry;
    } catch (e) {
      log('        音声用ライセンスの再取得に失敗したので既存の鍵で続行します');
    }
  }
  log(
    '        コンテンツ鍵 ' +
      licenseResult.keys.length +
      ' 件 (映像 ' +
      (videoPick.matched ? 'KID 一致' : '先頭の鍵') +
      ' / 音声 ' +
      (audioPick.matched ? 'KID 一致' : '先頭の鍵') +
      ')'
  );

  // [2/4] 映像
  log('  [2/4] 映像');
  const videoTrack = await download.downloadTrack({
    playlistUrl: variant.uri,
    outDir: path.join(workDir, 'video'),
    bearerToken: token,
    label: '映像',
    concurrency,
    maxSegments,
    playlist: videoProbe.playlist,
    initBuffer: videoProbe.initBuffer,
    progress: showProgress,
  });

  // [3/4] 音声（と字幕）
  log('  [3/4] 音声');
  const audioTrack = await download.downloadTrack({
    playlistUrl: audio.uri,
    outDir: path.join(workDir, 'audio'),
    bearerToken: token,
    label: '音声',
    concurrency,
    maxSegments,
    playlist: audioProbe.playlist,
    initBuffer: audioProbe.initBuffer,
    progress: showProgress,
  });

  let subtitleResult = null;
  if (subtitle) {
    try {
      subtitleResult = await download.downloadSubtitles({
        playlistUrl: subtitle.uri,
        outPath: path.join(workDir, 'subtitle.vtt'),
        bearerToken: token,
        concurrency,
        maxSegments,
        keepTokens: flags.keepSubtitleTokens === true,
        progress: showProgress,
      });
      if (subtitleResult) log('        字幕 ' + subtitleResult.cueCount + ' キュー');
    } catch (e) {
      log('        字幕の取得に失敗しました（無しで続行）: ' + e.message);
    }
  }

  // [4/4] 復号・結合
  log('  [4/4] 復号・結合');
  download.decryptAndMerge({
    ffmpegPath,
    videoInit: videoTrack.initPath,
    videoFiles: videoTrack.files,
    audioInit: audioTrack.initPath,
    audioFiles: audioTrack.files,
    videoKey: videoPick.key,
    audioKey: audioPick.key,
    subtitlePath: subtitleResult ? subtitleResult.path : null,
    outputPath,
    workDir,
    title,
  });

  const size = fs.statSync(outputPath).size;
  if (flags.keepWork !== true) download.removeDir(workDir);
  else log('        作業ディレクトリ: ' + workDir);

  log('✓ 保存しました: ' + outputPath + ' (' + download.formatBytes(size) + ')');

  return {
    id: info.id,
    title,
    output: outputPath,
    bytes: size,
    resolution: variant.resolution || null,
    bandwidth: variant.bandwidth,
    audio: { name: audio.name, group: audio.groupId, tier: audio.tier },
    subtitleCues: subtitleResult ? subtitleResult.cueCount : 0,
    segments: videoTrack.segmentCount,
    videoKid,
    audioKid,
  };
}

// ============================================================
// シリーズ
// ============================================================

async function runSeries(target, ctx) {
  const { token, flags } = ctx;
  const limit = toInt(flags.limit, null);
  const episodes = await nhk.fetchSeriesEpisodes(target.value, token, limit);
  const summaries = episodes.map((episode) => nhk.summarizeEpisode(episode));
  const playable = summaries.filter((s) => s.descriptorUrl);

  if (!flags.all) {
    const seriesName = (summaries[0] && summaries[0].seriesName) || target.value;
    out(seriesName + ' — ' + summaries.length + ' 件 (配信中 ' + playable.length + ' 件)');
    summaries.forEach((s, i) => {
      out(
        '  ' +
          String(i + 1).padStart(3) +
          '. ' +
          (s.id || '?').padEnd(12) +
          ' ' +
          String(s.broadcastDate || '').slice(0, 10).padEnd(11) +
          ' ' +
          (s.descriptorUrl ? '●' : '—') +
          ' ' +
          (s.episodeName || '')
      );
    });
    out('');
    out('全部落とす: nhk-dl ' + target.value + ' --all');
    out('1 本だけ  : nhk-dl <上記の ID>');
    return { series: target.value, episodes: summaries.length, playable: playable.length };
  }

  if (!playable.length) throw new Error('このシリーズに配信中のエピソードがありません');
  log('シリーズの ' + playable.length + ' 件を順に取得します');

  const results = [];
  for (let i = 0; i < playable.length; i++) {
    const summary = playable[i];
    log('');
    log('(' + (i + 1) + '/' + playable.length + ')');
    try {
      const descriptor = await nhk.fetchDescriptor(summary.descriptorUrl, token);
      const manifest = nhk.selectManifest(descriptor);
      const master = await loadMaster(manifest.url, token);
      results.push(await runDownload({ info: summary, descriptor, manifest, master }, ctx));
    } catch (e) {
      process.stderr.write('✗ ' + (summary.id || '') + ': ' + e.message + '\n');
      results.push({ id: summary.id, error: e.message });
    }
  }
  return { series: target.value, results };
}

// ============================================================
// メイン
// ============================================================

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
  if (!positional.length) {
    process.stdout.write(usage() + '\n');
    return 1;
  }

  if (positional[0] === 'config') return runConfig(positional.slice(1));

  // 位置引数を .wvd とダウンロード対象に分ける
  const targets = [];
  let wvdArg = typeof flags.wvd === 'string' ? flags.wvd : null;
  for (const item of positional) {
    const classified = nhk.classifyInput(item);
    if (classified.kind === 'wvd') {
      wvdArg = classified.value;
      continue;
    }
    targets.push(classified);
  }

  if (!targets.length) {
    throw new Error(
      'URL またはエピソード ID を指定してください。\n' +
        '  .wvd を登録するだけなら: nhk-dl config set-wvd ' + (wvdArg || '<device.wvd>')
    );
  }

  // Bearer トークン
  const tokenResult = await auth.resolveBearerToken({
    token: typeof flags.bearerToken === 'string' ? flags.bearerToken : null,
    noAuto: flags.autoToken === false,
    log: (message) => log(message),
  });

  // 実際に落とすのか（落とすなら .wvd と ffmpeg を先に解決しておく）
  const dryRun = flags.info === true || flags.list === true;
  const willDownload =
    !dryRun && (flags.all === true || targets.some((t) => t.kind !== 'series'));

  const ctx = { token: tokenResult.token, flags, wvdPath: null, ffmpegPath: null };
  if (willDownload) {
    const wvd = config.resolveWvd(wvdArg);
    ctx.wvdPath = wvd.path;
    ctx.ffmpegPath = download.resolveFfmpeg(typeof flags.ffmpeg === 'string' ? flags.ffmpeg : null);
    log('.wvd: ' + wvd.path + ' (' + wvd.source + ')');
  }

  const results = [];
  let failures = 0;

  for (const target of targets) {
    try {
      if (target.kind === 'series') {
        results.push(await runSeries(target, ctx));
        continue;
      }

      const resolved = await resolveTarget(target, ctx.token);

      if (flags.info === true) {
        printInfo(resolved);
        results.push(resolved.info);
        continue;
      }
      if (flags.list === true) {
        await printQualityList(resolved, ctx.token);
        results.push({
          id: resolved.info.id,
          variants: resolved.master.variants.map((v) => ({
            height: v.height || null,
            bandwidth: v.bandwidth,
            tier: v.tier,
          })),
        });
        continue;
      }

      results.push(await runDownload(resolved, ctx));
    } catch (e) {
      failures++;
      process.stderr.write('✗ ' + (target.value || '') + ': ' + e.message + '\n');
    }
  }

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ ok: failures === 0, results }, null, 2) + '\n');
  }

  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((error) => {
    process.stderr.write('✗ ' + (error && error.message ? error.message : String(error)) + '\n');
    if (process.env.NHK_DEBUG && error && error.stack) process.stderr.write(error.stack + '\n');
    process.exit(1);
  });
