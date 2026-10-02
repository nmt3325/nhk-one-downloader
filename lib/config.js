'use strict';
/*
 * lib/config.js — 設定ファイルと .wvd の解決
 *
 * 設定場所: $NHK_ONE_HOME または ~/.nhk-one/
 *   config.json  { "wvd": "/path/to/device.wvd", "outputDir": "..." }
 *   token.json   { "token": "eyJ...", "exp": 1730000000, ... }  (mode 600)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.NHK_ONE_HOME || path.join(os.homedir(), '.nhk-one');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  return CONFIG_DIR;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return CONFIG_PATH;
}

function updateConfig(patch) {
  const config = Object.assign(readConfig(), patch);
  writeConfig(config);
  return config;
}

/** ディレクトリ直下の *.wvd を列挙 */
function listWvdIn(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.wvd'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch (e) {
    return [];
  }
}

/**
 * .wvd の場所を解決する。
 * 優先順: 引数 → $NHK_WVD → config.json → カレントディレクトリ → ~/.nhk-one/
 * @param {string} [explicit]
 * @returns {{path:string, source:string}}
 */
function resolveWvd(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('.wvd が見つかりません: ' + explicit);
    return { path: path.resolve(explicit), source: 'argument' };
  }

  if (process.env.NHK_WVD) {
    if (!fs.existsSync(process.env.NHK_WVD)) {
      throw new Error('$NHK_WVD が指すファイルがありません: ' + process.env.NHK_WVD);
    }
    return { path: path.resolve(process.env.NHK_WVD), source: 'NHK_WVD' };
  }

  const configured = readConfig().wvd;
  if (configured && fs.existsSync(configured)) {
    return { path: path.resolve(configured), source: 'config.json' };
  }

  for (const [dir, source] of [
    [process.cwd(), 'current directory'],
    [CONFIG_DIR, CONFIG_DIR],
  ]) {
    const found = listWvdIn(dir);
    if (found.length === 1) return { path: found[0], source };
    if (found.length > 1) {
      throw new Error(
        '.wvd が複数見つかりました。--wvd で指定してください:\n  ' + found.join('\n  ')
      );
    }
  }

  throw new Error(
    '.wvd ファイルが見つかりません。\n' +
      '  指定方法: nhk-dl <URL> /path/to/device.wvd\n' +
      '          nhk-dl --wvd /path/to/device.wvd <URL>\n' +
      '          export NHK_WVD=/path/to/device.wvd\n' +
      '  恒久登録: nhk-dl config set-wvd /path/to/device.wvd\n' +
      '          (または ' + CONFIG_DIR + '/ に device.wvd を置く)'
  );
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  TOKEN_PATH,
  ensureConfigDir,
  readConfig,
  writeConfig,
  updateConfig,
  resolveWvd,
  listWvdIn,
};
