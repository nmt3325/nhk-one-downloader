'use strict';
/*
 * lib/subtitles.js — WebVTT セグメントの結合と ARIB 字幕マークアップの整理
 *
 * NHK ONE の字幕には 2 つのくせがある:
 *   1. タイムスタンプが絶対放送時刻（例: 409:32:25.543）なので
 *      そのまま MP4 に入れると表示されない → 先頭キューを 0 に寄せる
 *   2. ARIB STD-B24 の制御列が [CS][SWF_7][APS_x_y] の形で文字列に混じる
 *      → [APS_*] は改行、その他のトークンは削除
 */

const VTT_TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
const ARIB_TOKEN_RE = /\[[^\][]*\]/g;

function parseVttTime(text) {
  const m = VTT_TIME_RE.exec(String(text).trim());
  if (!m) return null;
  const hours = parseInt(m[1] || '0', 10);
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const millis = parseInt(m[4], 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function formatVttTime(ms) {
  let rest = Math.max(0, ms);
  const hours = Math.floor(rest / 3600000);
  rest %= 3600000;
  const minutes = Math.floor(rest / 60000);
  rest %= 60000;
  const seconds = Math.floor(rest / 1000);
  const millis = rest % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2) + '.' + pad(millis, 3);
}

/** ARIB 由来のブラケットトークンを平文にする */
function sanitizeCueText(text, keepTokens) {
  if (keepTokens) return text;
  return text
    .replace(/\[APS[^\]]*\]/g, '\n')
    .replace(ARIB_TOKEN_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * VTT セグメント群を 1 つの VTT に結合する。
 * @param {string[]} segmentTexts
 * @param {{keepTokens?:boolean}} [options]
 */
function mergeVtt(segmentTexts, options = {}) {
  const cueBlocks = [];

  for (const segment of segmentTexts) {
    // CRLF と単独の CR（ARIB 字幕は行内改行に CR を使う）を LF にそろえる
    const lines = segment.replace(/\r\n?/g, '\n').split('\n');
    let start = 0;
    if (lines.length && lines[0].startsWith('WEBVTT')) start = 1;

    const body = lines.slice(start);
    body.push('');
    let block = [];
    for (const line of body) {
      const stripped = line.trim();
      if (stripped === '') {
        if (block.length) cueBlocks.push(block);
        block = [];
        continue;
      }
      if (/^(X-TIMESTAMP-MAP|NOTE|STYLE|REGION)/.test(stripped)) continue;
      block.push(line);
    }
    if (block.length) cueBlocks.push(block);
  }

  // 最も早いキューの開始時刻を 0 に寄せる
  let earliest = null;
  for (const block of cueBlocks) {
    for (const line of block) {
      if (line.includes('-->')) {
        const t = parseVttTime(line.split('-->')[0]);
        if (t !== null && (earliest === null || t < earliest)) earliest = t;
        break;
      }
    }
  }
  if (earliest === null) earliest = 0;

  const out = ['WEBVTT', ''];
  let cueCount = 0;

  for (const block of cueBlocks) {
    const rendered = [];
    const textLines = [];
    let hasTiming = false;

    for (const line of block) {
      const arrow = line.indexOf('-->');
      if (arrow >= 0) {
        const startMs = parseVttTime(line.slice(0, arrow));
        const tail = line.slice(arrow + 3).trim();
        const endMatch = VTT_TIME_RE.exec(tail);
        if (startMs !== null && endMatch) {
          const endMs = parseVttTime(tail);
          const settings = tail.slice(endMatch[0].length);
          rendered.push(formatVttTime(startMs - earliest) + ' --> ' + formatVttTime(endMs - earliest) + settings);
          hasTiming = true;
          continue;
        }
      }
      textLines.push(line);
    }

    const text = sanitizeCueText(textLines.join('\n'), options.keepTokens);
    if (!hasTiming || !text.trim()) continue;
    out.push(...rendered, ...text.split('\n'), '');
    cueCount++;
  }

  return { text: out.join('\n').replace(/\s+$/, '') + '\n', cueCount };
}

module.exports = {
  mergeVtt,
  sanitizeCueText,
  parseVttTime,
  formatVttTime,
};
