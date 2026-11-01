'use strict';
// GitHub のリポジトリから、地図データ(rail.json など)や index.html の更新を取ってくる。
//
// 仕組み:
//   1. Git Trees API で「リポジトリ内の全ファイルと、その内容のハッシュ(git blob sha)」を 1 回で取る
//   2. 手元(更新済みフォルダ → 同梱フォルダの順)のファイルのハッシュと比べる
//   3. 違うファイルだけを raw.githubusercontent.com からダウンロードし、ハッシュで中身を検証する
//   4. すべて取れたときだけ、まとめて差し替える(途中で失敗しても、古い状態のまま壊れない)
//
// 公開リポジトリなら、ログインやトークンは不要。Electron の外(普通の Node)でもテストできるよう、
// fetch は引数で差し替えられるようにしてある。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIgnored } = require('./ignore');

const DEFAULT_BASES = {
  api: 'https://api.github.com',
  raw: 'https://raw.githubusercontent.com',
};
const UA = 'seiyo-map-desktop';

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

// git が内部で使うのと同じ「blob のハッシュ」。GitHub が返す sha と同じ値になる
function gitBlobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

// リポジトリ内のパスとして安全か(.. や \ やドライブ名を含まない)
function safeRelPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.includes('\0') || p.includes('\\') || p.includes(':')) return false;
  return !p.split('/').some((s) => s === '' || s === '.' || s === '..');
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const toLocal = (root, rel) => path.join(root, ...rel.split('/'));
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { return fallback; }
}
async function writeJsonAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

function apiHeaders(extra) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
    ...extra,
  };
}

function rateLimitError(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const when = Number.isFinite(reset) && reset > 0
    ? `(${new Date(reset * 1000).toLocaleTimeString('ja-JP')} ごろに回復します)` : '';
  return new SyncError('rate-limit', `GitHub の問い合わせ回数の上限に達しました${when}。しばらくしてからもう一度お試しください。`);
}

async function fetchTree(cfg, state, f, bases) {
  const branch = cfg.branch.split('/').map(encodeURIComponent).join('/');
  const url = `${bases.api}/repos/${cfg.owner}/${cfg.repo}/git/trees/${branch}?recursive=1`;
  const headers = apiHeaders();
  if (state.etag) headers['If-None-Match'] = state.etag;
  let res;
  try {
    res = await f(url, { headers });
  } catch (e) {
    throw new SyncError('network', 'GitHub に接続できません(オフラインの可能性があります)。');
  }
  if (res.status === 304) return { notModified: true };
  if (res.status === 404) {
    throw new SyncError('not-found',
      `リポジトリ ${cfg.owner}/${cfg.repo}(ブランチ ${cfg.branch})が見つかりません。非公開リポジトリの場合、このアプリからは取得できません。`);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    throw rateLimitError(res);
  }
  if (!res.ok) throw new SyncError('http', `GitHub から応答がありません(HTTP ${res.status})。`);
  const body = await res.json();
  if (body.truncated) throw new SyncError('truncated', 'ファイル数が多すぎて一覧を取得できませんでした。');
  return { etag: res.headers.get('etag') || '', tree: Array.isArray(body.tree) ? body.tree : [] };
}

// 1 ファイルを取る。まず raw(速くて回数制限が無い)。中身のハッシュが合わなければ(CDN の古いキャッシュなど)Blob API で取り直す
async function downloadBlob(cfg, entry, f, bases) {
  const branch = cfg.branch.split('/').map(encodeURIComponent).join('/');
  const rawUrl = `${bases.raw}/${cfg.owner}/${cfg.repo}/${branch}/${encPath(entry.path)}`;
  try {
    const res = await f(rawUrl, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (gitBlobSha(buf) === entry.sha) return buf;
    }
  } catch (e) { /* 下の Blob API で取り直す */ }

  let res;
  try {
    res = await f(`${bases.api}/repos/${cfg.owner}/${cfg.repo}/git/blobs/${entry.sha}`,
      { headers: apiHeaders({ Accept: 'application/vnd.github.raw+json' }) });
  } catch (e) {
    throw new SyncError('network', `${entry.path} をダウンロードできませんでした。`);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') throw rateLimitError(res);
  if (!res.ok) throw new SyncError('http', `${entry.path} をダウンロードできませんでした(HTTP ${res.status})。`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (gitBlobSha(buf) !== entry.sha) throw new SyncError('hash', `${entry.path} の内容が GitHub 上の内容と一致しませんでした。`);
  return buf;
}

async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * GitHub と手元のデータを比べて、変わったファイルだけ取ってくる。
 * 戻り値: { status: 'updated' | 'up-to-date' | 'skipped', changed: string[], removed: string[] }
 * 失敗したときは SyncError を投げる(その場合、手元のデータは何も変わらない)。
 */
async function syncContent(opts) {
  const {
    cfg, bundledDir, overlayDir, stagingDir, statePath,
    fetchImpl, bases = DEFAULT_BASES, onProgress, concurrency = 4,
  } = opts;
  if (!cfg || !cfg.owner || !cfg.repo || !cfg.branch) return { status: 'skipped', changed: [], removed: [] };

  const f = fetchImpl;
  const state = await readJson(statePath, { etag: '', files: {} });
  if (!state.files || typeof state.files !== 'object') state.files = {};

  const t = await fetchTree(cfg, state, f, bases);
  if (t.notModified) {
    state.checkedAt = Date.now();
    await writeJsonAtomic(statePath, state);
    return { status: 'up-to-date', changed: [], removed: [] };
  }

  const maxBytes = (Number(cfg.maxFileMB) || 100) * 1024 * 1024;
  const remote = new Map();
  for (const e of t.tree) {
    if (e.type !== 'blob' || !safeRelPath(e.path)) continue;
    if (isIgnored(e.path, cfg.ignore)) continue;
    if (Number(e.size) > maxBytes) continue;
    remote.set(e.path, { path: e.path, sha: e.sha, size: e.size });
  }

  // 手元のハッシュと違うものだけを、ダウンロード対象にする
  const need = [];
  for (const e of remote.values()) {
    let local = null;
    if (state.files[e.path] && exists(toLocal(overlayDir, e.path))) {
      local = state.files[e.path];
    } else if (exists(toLocal(bundledDir, e.path))) {
      local = gitBlobSha(await fsp.readFile(toLocal(bundledDir, e.path)));
    }
    if (local !== e.sha) need.push(e);
  }

  if (need.length) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    let failure = null;
    let done = 0;
    await pool(need, concurrency, async (e) => {
      if (failure) return;
      try {
        const buf = await downloadBlob(cfg, e, f, bases);
        const dest = toLocal(stagingDir, e.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, buf);
        done += 1;
        if (onProgress) onProgress({ done, total: need.length, path: e.path });
      } catch (err) {
        failure = failure || err;
      }
    });
    if (failure) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
      throw failure instanceof SyncError ? failure : new SyncError('network', String(failure.message || failure));
    }
    // 全部そろったので、差し替える
    try {
      for (const e of need) {
        const dest = toLocal(overlayDir, e.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(toLocal(stagingDir, e.path), dest);
        state.files[e.path] = e.sha;
      }
    } finally {
      await writeJsonAtomic(statePath, state);
      await fsp.rm(stagingDir, { recursive: true, force: true });
    }
  }

  // GitHub から消えた(または同期の対象外になった)ファイルは、更新済みフォルダからも消す
  const removed = [];
  for (const rel of Object.keys(state.files)) {
    if (remote.has(rel)) continue;
    await fsp.rm(toLocal(overlayDir, rel), { force: true });
    delete state.files[rel];
    removed.push(rel);
  }

  state.etag = t.etag;
  state.checkedAt = Date.now();
  if (need.length || removed.length) state.updatedAt = Date.now();
  await writeJsonAtomic(statePath, state);

  return {
    status: need.length || removed.length ? 'updated' : 'up-to-date',
    changed: need.map((e) => e.path),
    removed,
  };
}

// 更新済みデータを捨てて、アプリに同梱されたデータに戻す
async function resetOverlay({ overlayDir, stagingDir, statePath }) {
  await fsp.rm(overlayDir, { recursive: true, force: true });
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.rm(statePath, { force: true });
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// アプリ本体(インストーラー)の新しいバージョンが GitHub Releases にあるか調べる(お知らせ用。自動では入れ替えない)
async function checkLatestRelease({ cfg, currentVersion, fetchImpl, bases = DEFAULT_BASES }) {
  if (!cfg || !cfg.owner || !cfg.repo) return { status: 'skipped' };
  let res;
  try {
    res = await fetchImpl(`${bases.api}/repos/${cfg.owner}/${cfg.repo}/releases/latest`, { headers: apiHeaders() });
  } catch (e) {
    throw new SyncError('network', 'GitHub に接続できません(オフラインの可能性があります)。');
  }
  if (res.status === 404) return { status: 'none' };
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') throw rateLimitError(res);
  if (!res.ok) throw new SyncError('http', `GitHub から応答がありません(HTTP ${res.status})。`);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/i, '');
  if (!latest) return { status: 'none' };
  return {
    status: cmpVersion(latest, currentVersion) > 0 ? 'newer' : 'current',
    latest,
    url: j.html_url || '',
  };
}

module.exports = {
  syncContent, resetOverlay, checkLatestRelease,
  gitBlobSha, safeRelPath, cmpVersion, SyncError, DEFAULT_BASES,
};
