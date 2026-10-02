'use strict';
/*
 * lib/nhk.js — NHK ONE の API / ディスクリプタ解決
 */

const { fetchJson, fetchText } = require('./http');

const API_BASE = 'https://api.web.nhk/r8';
const LICENSE_URL = 'https://licence.hsk.st.nhk/widevine/license';

// ============================================================
// 入力の自動判別
// ============================================================

/**
 * 位置引数 1 つで URL / エピソードID / descriptor / m3u8 を見分ける。
 * @returns {{kind:'episode'|'series'|'descriptor'|'playlist'|'wvd', value:string}}
 */
function classifyInput(input) {
  const value = String(input).trim();

  if (/\.wvd$/i.test(value)) return { kind: 'wvd', value };
  if (/videoinfo-[^/]*\.json/i.test(value)) return { kind: 'descriptor', value };
  if (/\.m3u8(\?|$)/i.test(value)) return { kind: 'playlist', value };

  const epInUrl = value.match(/\/ep\/([A-Za-z0-9]{6,})/);
  if (epInUrl) return { kind: 'episode', value: epInUrl[1] };

  const seriesInUrl = value.match(/series-tep-([A-Za-z0-9]{6,})/);
  if (seriesInUrl) return { kind: 'series', value: 'series-tep-' + seriesInUrl[1] };

  if (/^[A-Z0-9]{8,12}$/.test(value)) return { kind: 'episode', value };

  throw new Error(
    '入力を認識できませんでした: ' +
      value +
      '\n  対応形式: エピソードURL / エピソードID / シリーズURL / videoinfo-*.json / *.m3u8'
  );
}

// ============================================================
// エピソードメタデータ
// ============================================================

async function fetchEpisode(episodeId, bearerToken) {
  const url = API_BASE + '/t/tvepisode/te/' + episodeId + '.json';
  return fetchJson(url, { bearerToken });
}

async function fetchSeriesEpisodes(seriesPlaylistId, bearerToken, limit) {
  const out = [];
  let url = API_BASE + '/l/tvepisode/pl/' + seriesPlaylistId + '.json';
  while (url) {
    const page = await fetchJson(url, { bearerToken });
    for (const item of page.result || []) {
      out.push(item);
      if (limit && out.length >= limit) return out;
    }
    url = page.nextUrl || null;
  }
  return out;
}

/** エピソード JSON から必要なところを抜き出す */
function summarizeEpisode(data) {
  const ig = data.identifierGroup || {};
  const videos = (data.video || []).filter((v) => v && v.detailedVideoDescriptor);
  const primary = videos[0] || (data.video || [])[0] || null;
  const released = data.releasedEvent || {};

  return {
    id: data.id,
    episodeName: ig.tvEpisodeName || data.name || '',
    seriesName: ig.tvSeriesName || (data.partOfSeries || {}).name || '',
    seriesId: ig.tvSeriesId || null,
    seriesPlaylistId: ((data.partOfSeries || {}).identifierGroup || {}).tvSeriesPlaylistId || null,
    description: data.description || '',
    broadcastDate: released.startDate || (primary && primary.startDate) || data.dateCreated || null,
    channel: (released.publishedOn || {}).broadcastDisplayName || null,
    duration: primary ? primary.duration : null,
    expires: primary ? primary.expires : null,
    descriptorUrl: primary ? primary.detailedVideoDescriptor || null : null,
    contentStatus: primary ? (primary.detailedContentStatus || {}).contentStatus || null : null,
    url: data.url || (primary && primary.url) || null,
    availableVideoCount: videos.length,
  };
}

/** VOD 配信が切れている場合の分かりやすいメッセージ */
function assertPlayable(info) {
  if (info.descriptorUrl) return;
  const hint = info.expires
    ? '配信期限: ' + info.expires + '\n'
    : 'NHK ONE の見逃し配信は通常放送から約 1 週間です。\n';
  throw new Error(
    'このエピソードには再生可能な映像がありません (detailedVideoDescriptor なし)。\n  ' + hint
  );
}

// ============================================================
// ディスクリプタ → マスタープレイリスト
// ============================================================

async function fetchDescriptor(descriptorUrl, bearerToken) {
  return fetchJson(descriptorUrl, { bearerToken });
}

/**
 * descriptor の manifests から cenc の最高ビットレートを選ぶ。
 * bitrate_limit_type は "m6000" のような形式。
 */
function selectManifest(descriptor) {
  const manifests = descriptor.manifests || [];
  let best = null;
  let bestScore = -1;

  for (const manifest of manifests) {
    const drm = manifest.drm_type || manifest.drmType || '';
    const limitType = String(manifest.bitrate_limit_type || manifest.bitrateLimitType || '');
    const url = manifest.url || '';
    if (drm !== 'cenc' || !url) continue;
    let score = parseInt((limitType.match(/(\d+)/) || [])[1] || '0', 10);
    if (limitType.startsWith('m')) score += 10000;
    if (score > bestScore) {
      bestScore = score;
      best = manifest;
    }
  }

  if (!best) best = manifests.find((m) => m.url) || null;
  if (!best) throw new Error('descriptor に使える manifest がありません');
  return best;
}

// ============================================================
// 出力ファイル名
// ============================================================

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
}

/** フル幅英数記号を半角に寄せておく（API の video.name は全角たっぷり） */
function normalizeWidth(text) {
  return String(text)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 「シリーズ名 エピソード名 (YYYY-MM-DD).mp4」を生成する。
 */
function buildFilename(info, extension = 'mp4') {
  const series = normalizeWidth(info.seriesName || '').trim();
  let episode = normalizeWidth(info.episodeName || '').trim();

  // エピソード名がシリーズ名で始まる場合は重複を除く
  if (series && episode.startsWith(series)) {
    episode = episode.slice(series.length).replace(/^[\s\u3000　:・―-]+/, '').trim();
  }

  const date = info.broadcastDate ? new Date(info.broadcastDate) : null;
  const datePart =
    date && !Number.isNaN(date.getTime())
      ? date.getFullYear() +
        '-' +
        String(date.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(date.getDate()).padStart(2, '0')
      : null;

  const parts = [series, episode].filter(Boolean);
  let base = parts.join(' ') || info.id || 'nhk-one';
  if (datePart) base += ' (' + datePart + ')';
  return sanitizeFilename(base) + '.' + extension;
}

/** ISO8601 duration (PT44M44S) を秒に */
function parseIsoDuration(value) {
  if (!value) return null;
  const m = String(value).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!m) return null;
  return (
    (parseInt(m[1] || '0', 10) * 86400) +
    (parseInt(m[2] || '0', 10) * 3600) +
    (parseInt(m[3] || '0', 10) * 60) +
    Math.round(parseFloat(m[4] || '0'))
  );
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

module.exports = {
  API_BASE,
  LICENSE_URL,
  classifyInput,
  fetchEpisode,
  fetchSeriesEpisodes,
  summarizeEpisode,
  assertPlayable,
  fetchDescriptor,
  selectManifest,
  buildFilename,
  sanitizeFilename,
  normalizeWidth,
  parseIsoDuration,
  formatDuration,
  fetchText,
};
