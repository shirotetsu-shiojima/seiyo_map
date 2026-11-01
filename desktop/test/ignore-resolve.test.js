'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isIgnored } = require('../lib/ignore');
const { resolveContentPath, mimeOf } = require('../lib/resolve');
const { safeRelPath, cmpVersion } = require('../lib/sync');

test('isIgnored: フォルダ・ファイル名・完全一致', () => {
  const pats = ['README.md', '.DS_Store', 'index_original_backup.html', 'docs/old.txt'];
  assert.equal(isIgnored('desktop/main.js', pats), true);
  assert.equal(isIgnored('.github/workflows/x.yml', pats), true);
  assert.equal(isIgnored('README.md', pats), true);
  assert.equal(isIgnored('images/.DS_Store', pats), true);
  assert.equal(isIgnored('docs/old.txt', pats), true);
  assert.equal(isIgnored('docs/new.txt', pats), false);
  assert.equal(isIgnored('index.html', pats), false);
  assert.equal(isIgnored('rail.json', pats), false);
  assert.equal(isIgnored('images/map_small1.jpg', pats), false);
  // "desktop/" はリポジトリ直下だけ(images/desktop/x は対象外)
  assert.equal(isIgnored('images/desktop/x.png', pats), false);
});

test('safeRelPath: 危険なパスを拒否', () => {
  for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', 'C:/x', '', './x', 'a/./b']) {
    assert.equal(safeRelPath(bad), false, bad);
  }
  for (const ok of ['index.html', 'images/map_small1.jpg', 'fare/hulria.txt', '日本語/ファイル.txt']) {
    assert.equal(safeRelPath(ok), true, ok);
  }
});

test('cmpVersion', () => {
  assert.equal(cmpVersion('1.2.0', '1.1.9'), 1);
  assert.equal(cmpVersion('v1.0.0', '1.0.0'), 0);
  assert.equal(cmpVersion('1.0', '1.0.1'), -1);
  assert.equal(cmpVersion('2.0.0', '10.0.0'), -1);
});

test('resolveContentPath: 更新済みが同梱より優先、外へは出られない', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seiyo-resolve-'));
  const bundled = path.join(tmp, 'bundled');
  const overlay = path.join(tmp, 'overlay');
  fs.mkdirSync(path.join(bundled, 'images'), { recursive: true });
  fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'index.html'), 'B');
  fs.writeFileSync(path.join(bundled, 'rail.json'), 'B');
  fs.writeFileSync(path.join(overlay, 'rail.json'), 'O');
  fs.writeFileSync(path.join(bundled, 'images', 'a.jpg'), 'B');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'S');
  const roots = [overlay, bundled];

  assert.equal(resolveContentPath('/', roots), path.join(bundled, 'index.html'));
  assert.equal(resolveContentPath('/rail.json', roots), path.join(overlay, 'rail.json'));
  assert.equal(resolveContentPath('/images/a.jpg', roots), path.join(bundled, 'images', 'a.jpg'));
  assert.equal(resolveContentPath('/images/', roots), null);      // フォルダ
  assert.equal(resolveContentPath('/nothing.json', roots), null);
  for (const evil of ['/../secret.txt', '/%2e%2e/secret.txt', '/images/../../secret.txt', '/..%5Csecret.txt',
    '/images%5C..%5C..%5Csecret.txt', '/C:/Windows/win.ini', '/%00', '/bad%zz']) {
    assert.equal(resolveContentPath(evil, roots), null, evil);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mimeOf', () => {
  assert.match(mimeOf('a/rail.json'), /^application\/json/);
  assert.match(mimeOf('x.TXT'), /^text\/plain/);
  assert.equal(mimeOf('map.jpg'), 'image/jpeg');
  assert.equal(mimeOf('x.unknown'), 'application/octet-stream');
});
