'use strict';

// リポジトリ内のパス(例: "images/map_small1.jpg")が、アプリに同梱・同期する対象から外れるかを判定する。
// ビルド時(prepare-content)と、起動後の更新(sync)で同じ規則を使う。
//
// パターンの書き方:
//   "desktop/"   末尾が / … リポジトリ直下のそのフォルダ以下すべて
//   ".DS_Store"  / を含まない … どの階層でも、その名前のファイル
//   "a/b.txt"    / を含む … そのパスのファイルだけ
const ALWAYS = ['.git/', '.github/', 'desktop/', 'node_modules/'];

function isIgnored(relPath, patterns) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const base = p.slice(p.lastIndexOf('/') + 1);
  for (const pat of [...ALWAYS, ...(patterns || [])]) {
    if (!pat) continue;
    if (pat.endsWith('/')) {
      if (p.startsWith(pat)) return true;
    } else if (!pat.includes('/')) {
      if (base === pat) return true;
    } else if (p === pat) {
      return true;
    }
  }
  return false;
}

module.exports = { isIgnored };
