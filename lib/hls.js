'use strict';
/*
 * lib/hls.js — HLS プレイリスト解析と fMP4 ボックス解析
 *
 * NHK ONE のマスタープレイリストの特徴:
 *   - RESOLUTION 属性が無い（解像度は init セグメントの avc1 ボックスから読む）
 *   - 音声グループは l5 (192kbps) / l2 (64kbps)、各々 main / sub (副音声)
 *   - 同じ映像バリアントが音声グループごとに重複して並んでいる
 */

const { URL } = require('url');

/** メディアプレイリスト（init + セグメント列） */
function parseMediaPlaylist(text, baseUrl) {
  let init = null;
  const segments = [];
  let totalDuration = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = new URL(m[1], baseUrl).href;
    } else if (line.startsWith('#EXTINF:')) {
      const d = parseFloat(line.slice(8));
      if (!Number.isNaN(d)) totalDuration += d;
    } else if (line.startsWith('#')) {
      continue;
    } else {
      segments.push(new URL(line, baseUrl).href);
    }
  }
  return { init, segments, totalDuration };
}

function attr(line, name) {
  const m = line.match(new RegExp(name + '="([^"]*)"'));
  if (m) return m[1];
  const bare = line.match(new RegExp(name + '=([^,\\s]+)'));
  return bare ? bare[1] : null;
}

/** URL パスの v6000 / am192 のようなティア名を抽出 */
function tierFromUri(uri) {
  const m = String(uri).match(/\/((?:v|am|as|a)\d{3,4})\//);
  return m ? m[1] : null;
}

/** マスタープレイリスト（映像バリアント / 音声 / 字幕） */
function parseMasterPlaylist(text, baseUrl) {
  const variants = [];
  const audios = [];
  const subtitles = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const type = attr(line, 'TYPE');
      const uri = attr(line, 'URI');
      if (!type || !uri) continue;
      const entry = {
        uri: new URL(uri, baseUrl).href,
        groupId: attr(line, 'GROUP-ID') || '',
        name: attr(line, 'NAME') || '',
        lang: attr(line, 'LANGUAGE') || '',
        isDefault: attr(line, 'DEFAULT') === 'YES',
      };
      entry.tier = tierFromUri(entry.uri);
      if (type === 'AUDIO') audios.push(entry);
      else if (type === 'SUBTITLES') subtitles.push(entry);
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('#')) continue;
        const resolution = attr(line, 'RESOLUTION');
        variants.push({
          uri: new URL(next, baseUrl).href,
          bandwidth: parseInt(attr(line, 'BANDWIDTH') || '0', 10),
          codecs: attr(line, 'CODECS') || '',
          frameRate: attr(line, 'FRAME-RATE') || null,
          audioGroup: attr(line, 'AUDIO') || null,
          subtitleGroup: attr(line, 'SUBTITLES') || null,
          resolution: resolution || null,
          height: resolution ? parseInt(resolution.split('x')[1], 10) : null,
          tier: tierFromUri(next),
        });
        i = j;
        break;
      }
    }
  }

  // 同じ映像 URI の重蜇を潰す（音声グループは配列として保持）
  const unique = new Map();
  for (const v of variants) {
    const existing = unique.get(v.uri);
    if (existing) {
      if (v.audioGroup && !existing.audioGroups.includes(v.audioGroup)) existing.audioGroups.push(v.audioGroup);
      continue;
    }
    unique.set(v.uri, Object.assign({}, v, { audioGroups: v.audioGroup ? [v.audioGroup] : [] }));
  }

  const deduped = [...unique.values()].sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants: deduped, audios, subtitles };
}

/**
 * 映像バリアントを選ぶ。
 * @param {Array} variants bandwidth 降順の配列
 * @param {string} [quality] 'best' | 'worst' | '1080' | '720p' | '3000k'
 */
function selectVariant(variants, quality) {
  if (!variants.length) return null;
  if (!quality || quality === 'best') return variants[0];
  if (quality === 'worst') return variants[variants.length - 1];

  const raw = String(quality).trim().toLowerCase();
  const num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
  if (Number.isNaN(num)) return variants[0];

  // ビットレート指定 (3000k / 6000kbps / v3000)
  if (/k|kbps|^v/.test(raw) || num >= 2000) {
    const target = num >= 100000 ? num : num * 1000;
    let best = variants[variants.length - 1];
    for (const v of variants) {
      if (v.bandwidth <= target * 1.1) {
        best = v;
        break;
      }
    }
    return best;
  }

  // 解像度指定。height が分かっている場合のみ正確に選ぶ。
  const withHeight = variants.filter((v) => v.height);
  if (withHeight.length) {
    const exact = withHeight.find((v) => v.height === num);
    if (exact) return exact;
    const under = withHeight.filter((v) => v.height <= num);
    if (under.length) return under[0];
    return withHeight[withHeight.length - 1];
  }
  return variants[0];
}

/**
 * 映像バリアントに対応する音声トラックを選ぶ。
 * @param {Array} audios
 * @param {object} variant
 * @param {'main'|'sub'} [kind] 副音声を取りたい場合は 'sub'
 */
function selectAudio(audios, variant, kind = 'main') {
  if (!audios.length) return null;
  const groups = (variant && variant.audioGroups && variant.audioGroups.length
    ? variant.audioGroups
    : [variant && variant.audioGroup]).filter(Boolean);

  // 高ビットレートのグループを優先（l5 > l2）
  const candidates = audios.filter((a) => !groups.length || groups.includes(a.groupId));
  const pool = candidates.length ? candidates : audios;

  const byKind = pool.filter((a) => (a.name || '').toLowerCase() === kind);
  const target = byKind.length ? byKind : pool.filter((a) => a.isDefault).length ? pool.filter((a) => a.isDefault) : pool;

  // tier の数字が大きい（= ビットレートが高い）ものを選ぶ
  return target.slice().sort((a, b) => {
    const an = parseInt((a.tier || '').replace(/[^0-9]/g, '') || '0', 10);
    const bn = parseInt((b.tier || '').replace(/[^0-9]/g, '') || '0', 10);
    return bn - an;
  })[0];
}

// ============================================================
// fMP4 ボックス
// ============================================================

/** init セグメントの tenc ボックスから default_KID を抽出 */
function parseTencKid(data) {
  const idx = data.indexOf(Buffer.from('tenc'));
  if (idx < 4) return null;
  const size = data.readUInt32BE(idx - 4);
  if (size < 32 || idx - 4 + size > data.length) return null;
  const body = data.subarray(idx + 4, idx - 4 + size);
  const version = body[0];
  const offset = version === 0 ? 8 : 10;
  if (body.length < offset + 16) return null;
  return Buffer.from(body.subarray(offset, offset + 16)).toString('hex');
}

/**
 * init セグメントの VisualSampleEntry (avc1/hvc1/...) から解像度を読む。
 * SampleEntry: 8(header) + 6(reserved) + 2(data_ref_idx)
 * VisualSampleEntry: + 2 + 2 + 12 → width(2), height(2)
 */
function parseVideoResolution(data) {
  // CENC 暗号化トラックはサンプルエントリが encv になり、元の形式は frma に入る
  for (const codec of ['encv', 'avc1', 'avc3', 'hvc1', 'hev1', 'dvh1']) {
    const idx = data.indexOf(Buffer.from(codec));
    if (idx < 4) continue;
    const boxStart = idx - 4;
    if (boxStart + 36 > data.length) continue;
    const width = data.readUInt16BE(boxStart + 32);
    const height = data.readUInt16BE(boxStart + 34);
    if (width > 0 && height > 0 && width <= 8192 && height <= 8192) {
      return { width, height, resolution: width + 'x' + height, codec: originalFormat(data, codec) };
    }
  }
  return null;
}

/** encv/enca の場合は frma ボックスから元のコーデックを読む */
function originalFormat(data, codec) {
  if (codec !== 'encv' && codec !== 'enca') return codec;
  const idx = data.indexOf(Buffer.from('frma'));
  if (idx < 0 || idx + 8 > data.length) return codec;
  return data.subarray(idx + 4, idx + 8).toString('latin1');
}

/** URL からセグメントのファイル名を取る */
function segmentName(url) {
  const pathname = new URL(url).pathname;
  return pathname.split('/').pop() || 'segment';
}

module.exports = {
  parseMediaPlaylist,
  parseMasterPlaylist,
  selectVariant,
  selectAudio,
  parseTencKid,
  parseVideoResolution,
  segmentName,
  tierFromUri,
};
