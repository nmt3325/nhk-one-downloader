'use strict';
/*
 * lib/args.js — 位置引数とフラグを扱う最小のパーサ
 *
 * --kebab-case は camelCase に正規化する。
 * --no-foo は foo=false として扱う。
 */

function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {string[]} argv
 * @param {{booleans?:string[], aliases?:object}} [spec]
 * @returns {{positional:string[], flags:object}}
 */
function parseArgs(argv, spec = {}) {
  const booleans = new Set((spec.booleans || []).map(toCamel));
  const aliases = spec.aliases || {};
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      let name = token.slice(2);
      let inlineValue = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      if (name.startsWith('no-')) {
        flags[toCamel(name.slice(3))] = false;
        continue;
      }

      const key = toCamel(name);
      if (inlineValue !== null) {
        flags[key] = inlineValue;
      } else if (booleans.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const short = token.slice(1);
      const name = aliases[short];
      if (!name) throw new Error('不明なオプション: ' + token);
      const key = toCamel(name);
      if (booleans.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

module.exports = { parseArgs, toCamel, toInt };
