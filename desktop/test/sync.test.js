'use strict';
// GitHub の API を真似た小さなサーバーを立てて、更新ロジック(lib/sync.js)を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncContent, resetOverlay, checkLatestRelease, gitBlobSha, SyncError } = require('../lib/sync');

const OWNER = 'octo';
const REPO = 'seiyo_map';

function startMock() {
  const m = {
    files: new Map(),         // path -> Buffer(リモートの内容)
    staleRaw: new Map(),      // path -> Buffer(raw だけ古い内容を返す = CDN の遅れ)
    failPaths: new Set(),     // raw も blobs も 500 を返すパス
    rev: 1,
    mode: '',                 // '', 'ratelimit', 'notfound'
    release: null,
    hits: { tree: 0, tree304: 0, raw: [], blobs: [] },
  };
  const etag = () => `"rev${m.rev}"`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };

    if (p === `/repos/${OWNER}/${REPO}/git/trees/main`) {
      if (m.mode === 'ratelimit') return send(403, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
      if (m.mode === 'notfound') return send(404, '{}');
      m.hits.tree += 1;
      if (req.headers['if-none-match'] === etag()) { m.hits.tree304 += 1; return send(304, '', { etag: etag() }); }
      const tree = [{ path: 'images', type: 'tree', sha: 'x' }];
      for (const [fp, buf] of m.files) tree.push({ path: fp, type: 'blob', sha: gitBlobSha(buf), size: buf.length });
      tree.push({ path: '../evil.txt', type: 'blob', sha: gitBlobSha(Buffer.from('e')), size: 1 });
      return send(200, JSON.stringify({ sha: 'tree', tree, truncated: false }), { etag: etag(), 'content-type': 'application/json' });
    }
    if (p.startsWith(`/${OWNER}/${REPO}/main/`)) {
      const fp = p.slice(`/${OWNER}/${REPO}/main/`.length);
      m.hits.raw.push(fp);
      if (m.failPaths.has(fp)) return send(500, 'x');
      const buf = m.staleRaw.get(fp) || m.files.get(fp);
      return buf ? send(200, buf) : send(404, 'nf');
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]{40})$/.exec(p);
    if (blob) {
      m.hits.blobs.push(blob[1]);
      for (const [fp, buf] of m.files) {
        if (gitBlobSha(buf) === blob[1] && !m.failPaths.has(fp)) return send(200, buf);
      }
      return send(500, 'x');
    }
    if (p === `/repos/${OWNER}/${REPO}/releases/latest`) {
      return m.release ? send(200, JSON.stringify(m.release)) : send(404, '{}');
    }
    return send(404, 'nf');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ m, server, bases: { api: base, raw: base } });
  }));
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seiyo-sync-'));
  const dirs = {
    bundledDir: path.join(tmp, 'bundled'),
    overlayDir: path.join(tmp, 'ud', 'content'),
    stagingDir: path.join(tmp, 'ud', 'staging'),
    statePath: path.join(tmp, 'ud', 'state.json'),
  };
  fs.mkdirSync(dirs.bundledDir, { recursive: true });
  return { tmp, ...dirs };
}
const put = (root, rel, content) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const cfg = { owner: OWNER, repo: REPO, branch: 'main', ignore: ['README.md'], maxFileMB: 100 };
const run = (env, extra = {}) => syncContent({ cfg, ...env.dirs, fetchImpl: fetch, bases: env.bases, ...extra });

async function fixture() {
  const mock = await startMock();
  const s = setup();
  const initial = {
    'index.html': 'v1-index', 'rail.json': 'v1-rail', 'images/a.jpg': 'JPEG-A',
    'README.md': 'readme', 'desktop/main.js': 'shell', '.github/workflows/x.yml': 'ci',
  };
  for (const [k, v] of Object.entries(initial)) mock.m.files.set(k, Buffer.from(v));
  // 同梱データ = 初期状態のうち、同期対象のもの
  for (const k of ['index.html', 'rail.json', 'images/a.jpg']) put(s.bundledDir, k, initial[k]);
  const env = { dirs: { bundledDir: s.bundledDir, overlayDir: s.overlayDir, stagingDir: s.stagingDir, statePath: s.statePath }, bases: mock.bases };
  const done = () => { mock.server.close(); fs.rmSync(s.tmp, { recursive: true, force: true }); };
  return { ...mock, s, env, done };
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

test('同梱と同じなら何もダウンロードしない。2 回目は 304 で API 回数を使わない', async () => {
  const t = await fixture();
  try {
    const r1 = await run(t.env);
    assert.equal(r1.status, 'up-to-date');
    assert.deepEqual(t.m.hits.raw, []);
    assert.equal(fs.existsSync(t.s.overlayDir), false);
    const r2 = await run(t.env);
    assert.equal(r2.status, 'up-to-date');
    assert.equal(t.m.hits.tree304, 1);
  } finally { t.done(); }
});

test('変わったファイルと新しいファイルだけ取る(対象外・危険なパスは取らない)', async () => {
  const t = await fixture();
  try {
    await run(t.env);
    t.m.files.set('rail.json', Buffer.from('v2-rail'));
    t.m.files.set('fare/new.txt', Buffer.from('fare'));
    t.m.files.set('README.md', Buffer.from('readme v2'));
    t.m.rev += 1;
    t.m.hits.raw.length = 0;
    const progress = [];
    const r = await run(t.env, { onProgress: (p) => progress.push(p.done) });
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.changed.sort(), ['fare/new.txt', 'rail.json']);
    assert.deepEqual(t.m.hits.raw.sort(), ['fare/new.txt', 'rail.json']);
    assert.equal(read(t.s.overlayDir, 'rail.json'), 'v2-rail');
    assert.equal(read(t.s.overlayDir, 'fare/new.txt'), 'fare');
    assert.equal(fs.existsSync(path.join(t.s.overlayDir, 'index.html')), false);
    assert.equal(fs.existsSync(t.s.stagingDir), false);
    assert.equal(progress.length, 2);
    // 変更が無ければ、次は取りに行かない
    t.m.hits.raw.length = 0;
    const r2 = await run(t.env);
    assert.equal(r2.status, 'up-to-date');
    assert.deepEqual(t.m.hits.raw, []);
  } finally { t.done(); }
});

test('rawが古い内容を返したら Blob API で取り直す', async () => {
  const t = await fixture();
  try {
    t.m.files.set('rail.json', Buffer.from('v2-rail'));
    t.m.staleRaw.set('rail.json', Buffer.from('v1-rail'));
    t.m.rev += 1;
    const r = await run(t.env);
    assert.equal(r.status, 'updated');
    assert.equal(read(t.s.overlayDir, 'rail.json'), 'v2-rail');
    assert.equal(t.m.hits.blobs.length, 1);
  } finally { t.done(); }
});

test('途中で失敗したら、手元のデータは何も変わらず、次回やり直せる', async () => {
  const t = await fixture();
  try {
    await run(t.env);
    t.m.files.set('rail.json', Buffer.from('v2-rail'));
    t.m.files.set('index.html', Buffer.from('v2-index'));
    t.m.failPaths.add('index.html');
    t.m.rev += 1;
    await assert.rejects(run(t.env), (e) => e instanceof SyncError);
    assert.equal(fs.existsSync(path.join(t.s.overlayDir, 'rail.json')), false);
    assert.equal(fs.existsSync(t.s.stagingDir), false);
    // 直ったら、次の確認で更新される(失敗時に etag を保存していない証拠)
    t.m.failPaths.clear();
    const r = await run(t.env);
    assert.equal(r.status, 'updated');
    assert.equal(read(t.s.overlayDir, 'index.html'), 'v2-index');
    assert.equal(read(t.s.overlayDir, 'rail.json'), 'v2-rail');
  } finally { t.done(); }
});

test('GitHub から消えたファイルは、更新済みフォルダからも消える', async () => {
  const t = await fixture();
  try {
    t.m.files.set('fare/new.txt', Buffer.from('fare'));
    t.m.rev += 1;
    await run(t.env);
    assert.equal(read(t.s.overlayDir, 'fare/new.txt'), 'fare');
    t.m.files.delete('fare/new.txt');
    t.m.rev += 1;
    const r = await run(t.env);
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.removed, ['fare/new.txt']);
    assert.equal(fs.existsSync(path.join(t.s.overlayDir, 'fare/new.txt')), false);
  } finally { t.done(); }
});

test('エラーの種類: 上限・見つからない・オフライン', async () => {
  const t = await fixture();
  try {
    t.m.mode = 'ratelimit';
    await assert.rejects(run(t.env), (e) => e.code === 'rate-limit');
    t.m.mode = 'notfound';
    await assert.rejects(run(t.env), (e) => e.code === 'not-found');
    t.m.mode = '';
    await assert.rejects(run(t.env, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), (e) => e.code === 'network');
    const skipped = await syncContent({ cfg: { owner: '', repo: '', branch: 'main' }, ...t.env.dirs, fetchImpl: fetch, bases: t.bases });
    assert.equal(skipped.status, 'skipped');
  } finally { t.done(); }
});

test('resetOverlay: 更新データを捨てる', async () => {
  const t = await fixture();
  try {
    t.m.files.set('rail.json', Buffer.from('v2-rail'));
    t.m.rev += 1;
    await run(t.env);
    assert.equal(fs.existsSync(t.s.overlayDir), true);
    await resetOverlay(t.env.dirs);
    assert.equal(fs.existsSync(t.s.overlayDir), false);
    assert.equal(fs.existsSync(t.s.statePath), false);
  } finally { t.done(); }
});

test('checkLatestRelease', async () => {
  const t = await fixture();
  try {
    const args = { cfg, fetchImpl: fetch, bases: t.bases };
    assert.equal((await checkLatestRelease({ ...args, currentVersion: '1.0.0' })).status, 'none');
    t.m.release = { tag_name: 'v1.2.0', html_url: 'https://example.com/r' };
    const newer = await checkLatestRelease({ ...args, currentVersion: '1.0.0' });
    assert.equal(newer.status, 'newer');
    assert.equal(newer.latest, '1.2.0');
    assert.equal((await checkLatestRelease({ ...args, currentVersion: '1.2.0' })).status, 'current');
  } finally { t.done(); }
});
