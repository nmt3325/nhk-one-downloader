'use strict';
/*
 * lib/download.js — セグメントの並列ダウンロードと ffmpeg での復号 / 結合
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { request, fetchText, parallelMap } = require('./http');
const hls = require('./hls');
const { mergeVtt } = require('./subtitles');

// ============================================================
// 進捗表示（1 行を書き換える）
// ============================================================

class Progress {
  constructor(label, total, enabled) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.enabled = enabled !== false && process.stderr.isTTY;
    this.lastRender = 0;
  }

  tick(bytes) {
    this.done++;
    this.bytes += bytes || 0;
    const now = Date.now();
    if (now - this.lastRender < 120 && this.done < this.total) return;
    this.lastRender = now;
    this.render();
  }

  render() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const pct = this.total ? Math.floor((this.done / this.total) * 100) : 0;
    const speed = elapsed > 0 ? this.bytes / elapsed / 1024 / 1024 : 0;
    const eta = this.done > 0 ? Math.round((elapsed / this.done) * (this.total - this.done)) : 0;
    const line =
      '  ' +
      this.label.padEnd(8) +
      ' ' +
      String(pct).padStart(3) +
      '%  ' +
      this.done +
      '/' +
      this.total +
      '  ' +
      speed.toFixed(1) +
      ' MB/s  ETA ' +
      formatEta(eta);
    if (this.enabled) process.stderr.write('\r' + line.padEnd(72));
    else if (this.done === this.total) process.stderr.write(line + '\n');
  }

  finish() {
    if (this.enabled) {
      this.render();
      process.stderr.write('\n');
    }
  }
}

function formatEta(seconds) {
  if (!seconds || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ============================================================
// ffmpeg
// ============================================================

function resolveFfmpeg(explicit) {
  const candidates = [explicit, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error(
    'ffmpeg が見つかりません。復号と結合に必要です。\n' +
      '  macOS  : brew install ffmpeg\n' +
      '  Ubuntu : sudo apt install ffmpeg\n' +
      '  Windows: winget install Gyan.FFmpeg\n' +
      '  パスを直接指定する場合は --ffmpeg /path/to/ffmpeg または $FFMPEG'
  );
}

// ============================================================
// トラックのダウンロード
// ============================================================

/**
 * メディアプレイリスト 1 つ分の init + セグメントを落とす。
 * 既にサイズ > 0 のファイルがあればスキップする（レジューム）。
 */
async function downloadTrack(options) {
  const { playlistUrl, outDir, bearerToken, label } = options;
  const concurrency = options.concurrency || 6;
  const maxSegments = options.maxSegments || null;

  const playlist =
    options.playlist ||
    hls.parseMediaPlaylist(await fetchText(playlistUrl, { bearerToken }), playlistUrl);
  const segments = maxSegments ? playlist.segments.slice(0, maxSegments) : playlist.segments;

  fs.mkdirSync(outDir, { recursive: true });

  let initPath = null;
  if (playlist.init) {
    initPath = path.join(outDir, 'init.mp4');
    if (!existsNonEmpty(initPath)) {
      let data = options.initBuffer;
      if (!data) {
        const res = await request(playlist.init, { bearerToken, retries: 3 });
        if (res.status !== 200) throw new Error('init segment HTTP ' + res.status);
        data = res.data;
      }
      writeAtomic(initPath, data);
    }
  }

  const targets = segments.map((url, i) => ({
    url,
    file: path.join(outDir, String(i).padStart(6, '0') + '.m4s'),
  }));

  const progress = new Progress(label || 'segments', targets.length, options.progress);
  let skipped = 0;

  await parallelMap(concurrency, targets, async (target) => {
    if (existsNonEmpty(target.file)) {
      skipped++;
      progress.tick(fs.statSync(target.file).size);
      return;
    }
    const res = await request(target.url, { bearerToken, retries: 3 });
    if (res.status !== 200) throw new Error('segment HTTP ' + res.status + ' ' + target.url);
    writeAtomic(target.file, res.data);
    progress.tick(res.data.length);
  });

  progress.finish();

  return {
    initPath,
    files: targets.map((t) => t.file),
    segmentCount: targets.length,
    skipped,
    totalDuration: playlist.totalDuration,
    bytes: progress.bytes,
  };
}

/**
 * トラックのプレイリストと init セグメントを先に取得する。
 * ダウンロード前に解像度 / KID / セグメント数を知るために使う。
 */
async function probeTrack(options) {
  const { playlistUrl, bearerToken } = options;
  const text = await fetchText(playlistUrl, { bearerToken });
  const playlist = hls.parseMediaPlaylist(text, playlistUrl);
  let initBuffer = null;
  if (playlist.init) {
    const res = await request(playlist.init, { bearerToken, retries: 3 });
    if (res.status !== 200) throw new Error('init segment HTTP ' + res.status);
    initBuffer = res.data;
  }
  return { playlist, initBuffer };
}

/** 字幕トラック（WebVTT）を落として 1 ファイルに結合 */
async function downloadSubtitles(options) {
  const { playlistUrl, outPath, bearerToken } = options;
  const concurrency = options.concurrency || 8;
  const maxSegments = options.maxSegments || null;

  const text = await fetchText(playlistUrl, { bearerToken });
  const playlist = hls.parseMediaPlaylist(text, playlistUrl);
  const segments = maxSegments ? playlist.segments.slice(0, maxSegments) : playlist.segments;
  if (!segments.length) return null;

  const progress = new Progress('subtitle', segments.length, options.progress);
  const texts = await parallelMap(concurrency, segments, async (url) => {
    const res = await request(url, { bearerToken, retries: 3 });
    progress.tick(res.data.length);
    return res.status === 200 ? res.data.toString('utf-8') : '';
  });
  progress.finish();

  const merged = mergeVtt(texts, { keepTokens: options.keepTokens });
  if (!merged.cueCount) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, merged.text, 'utf-8');
  return { path: outPath, cueCount: merged.cueCount };
}

// ============================================================
// 結合と復号
// ============================================================

function concatFiles(files, outPath) {
  const fd = fs.openSync(outPath, 'w');
  try {
    for (const file of files) {
      const buf = fs.readFileSync(file);
      fs.writeSync(fd, buf, 0, buf.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  return outPath;
}

/**
 * ffmpeg の -decryption_key で CENC を解いて MP4 にまとめる。
 * 映像と音声は KID が別なので入力ごとに鍵を指定する。
 */
function decryptAndMerge(options) {
  const {
    ffmpegPath,
    videoInit,
    videoFiles,
    audioInit,
    audioFiles,
    videoKey,
    audioKey,
    subtitlePath,
    outputPath,
    workDir,
    title,
  } = options;

  const videoConcat = path.join(workDir, 'video.mp4');
  const audioConcat = path.join(workDir, 'audio.mp4');
  concatFiles([videoInit, ...videoFiles].filter(Boolean), videoConcat);
  concatFiles([audioInit, ...audioFiles].filter(Boolean), audioConcat);

  const args = ['-y', '-loglevel', 'error', '-stats'];
  args.push('-decryption_key', videoKey, '-i', videoConcat);
  args.push('-decryption_key', audioKey, '-i', audioConcat);

  const hasSubtitle = subtitlePath && fs.existsSync(subtitlePath);
  if (hasSubtitle) args.push('-i', subtitlePath);

  args.push('-map', '0:v:0', '-map', '1:a:0');
  if (hasSubtitle) args.push('-map', '2:s:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=jpn');
  args.push('-c:v', 'copy', '-c:a', 'copy');
  args.push('-metadata:s:a:0', 'language=jpn');
  if (title) args.push('-metadata', 'title=' + title);
  args.push('-movflags', '+faststart', outputPath);

  const result = spawnSync(ffmpegPath, args, { encoding: 'utf-8', timeout: 3600000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').slice(-1200);
    throw new Error('ffmpeg が失敗しました (exit ' + result.status + ')\n' + stderr);
  }
  return outputPath;
}

// ============================================================
// 小さなヘルパ
// ============================================================

function existsNonEmpty(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch (e) {
    return false;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.part';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  Progress,
  resolveFfmpeg,
  downloadTrack,
  probeTrack,
  downloadSubtitles,
  concatFiles,
  decryptAndMerge,
  removeDir,
  formatBytes,
};
