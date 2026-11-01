'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

// app://seiyo/<pathname> の pathname を、roots(優先順)の中の実ファイルに対応づける。
// roots の外へ出るパス(.. や \ や ドライブ名)は null を返す。見つからなければ null。
function resolveContentPath(pathname, roots) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (rel.includes('\0') || rel.includes('\\') || rel.includes(':')) return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '..' || s === '.' )) return null;
  for (const root of roots) {
    if (!root) continue;
    const full = path.join(root, ...segs);
    const back = path.relative(root, full);
    if (back === '' || back.startsWith('..') || path.isAbsolute(back)) continue;
    if (isFile(full)) return full;
  }
  return null;
}

module.exports = { resolveContentPath, mimeOf };
