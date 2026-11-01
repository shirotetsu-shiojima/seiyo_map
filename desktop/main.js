'use strict';
// 星陽マップ デスクトップ版 — メインプロセス
//
// やること:
//   ・index.html などを、独自のアドレス app://seiyo/ で配る(file:// のままだと、データの fetch が拒否されるため)
//     配る場所は「更新済みデータ(userData/content)」→「アプリ同梱データ(resources/content)」の順
//   ・起動後に GitHub を確認して、更新があれば取ってくる(メニューからも手動で確認できる)

const { app, BrowserWindow, Menu, dialog, shell, protocol, session, ipcMain, screen, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { resolveContentPath, mimeOf } = require('./lib/resolve');
const { syncContent, resetOverlay, checkLatestRelease } = require('./lib/sync');

const SCHEME = 'app';
const HOST = 'seiyo';
const ORIGIN = `${SCHEME}://${HOST}`;
const APP_NAME = '星陽マップ';
const isMac = process.platform === 'darwin';

// 独自スキームは、app が ready になる前に登録しておく必要がある
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 保存場所を固定(アプリ名が変わっても、設定や更新データが迷子にならないように)
app.setPath('userData', path.join(app.getPath('appData'), 'seiyo-map'));

const userData = app.getPath('userData');
const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'content') : path.join(__dirname, 'content');
const overlayDir = path.join(userData, 'content');
const stagingDir = path.join(userData, 'content-staging');
const statePath = path.join(userData, 'content-state.json');
const windowStatePath = path.join(userData, 'window-state.json');
const settingsPath = path.join(userData, 'settings.json');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeJsonSafe(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) { /* 保存できなくても動く */ }
}

// ---- 設定(app-config.json の値が優先。空なら、ビルド時に決まった build-info.json の値) ----
function loadConfig() {
  const cfg = readJsonSafe(path.join(__dirname, 'app-config.json')) || {};
  const info = readJsonSafe(path.join(__dirname, 'build-info.json')) || {};
  const pick = (k) => cfg[k] || info[k] || '';
  const out = {
    owner: pick('owner'),
    repo: pick('repo'),
    branch: pick('branch') || 'main',
    ignore: Array.isArray(cfg.ignore) ? cfg.ignore : [],
    maxFileMB: cfg.maxFileMB || 100,
  };
  const hasRepo = Boolean(out.owner && out.repo);
  let pages = cfg.publicUrl || '';
  if (!pages && hasRepo) {
    const userSite = `${out.owner}.github.io`.toLowerCase() === out.repo.toLowerCase();
    pages = `https://${out.owner}.github.io/${userSite ? '' : `${out.repo}/`}`;
  }
  if (pages && !pages.endsWith('/')) pages += '/';
  out.publicUrl = pages;
  out.repoUrl = hasRepo ? `https://github.com/${out.owner}/${out.repo}` : '';
  return out;
}
const cfg = loadConfig();

// ---- ウィンドウ ----
let win = null;

function loadWindowState() {
  const s = readJsonSafe(windowStatePath) || {};
  const out = { width: 1280, height: 820, maximized: Boolean(s.maximized) };
  if (Number.isFinite(s.width) && Number.isFinite(s.height)) { out.width = s.width; out.height = s.height; }
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width && s.x + out.width > a.x && s.y < a.y + a.height && s.y + out.height > a.y;
    });
    if (visible) { out.x = s.x; out.y = s.y; }
  }
  return out;
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  writeJsonSafe(windowStatePath, { ...b, maximized: win.isMaximized() });
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(u.toString());
  } catch (e) { /* 無効な URL は無視 */ }
}

function createWindow() {
  const st = loadWindowState();
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: '#e9edf2',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  // 地図アプリの外へ移動しようとしたら、ふだんのブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) { event.preventDefault(); openExternalSafe(url); }
  });

  win.loadURL(`${ORIGIN}/`);
}

// ---- app:// で、更新済みデータ → 同梱データの順にファイルを返す ----
function installProtocol() {
  protocol.handle(SCHEME, async (request) => {
    let url;
    try { url = new URL(request.url); } catch (e) { return new Response('Bad request', { status: 400 }); }
    const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (url.host !== HOST) return notFound();
    const file = resolveContentPath(url.pathname, [overlayDir, bundledDir]);
    if (!file) return notFound();
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { status: 200, headers: { 'content-type': mimeOf(file), 'cache-control': 'no-store' } });
    } catch (e) {
      return new Response('Read error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  });
}

// 列車の位置を返すローカル API が、CORS のヘッダーを付けない場合の保険。
// このアプリからの fetch に対してだけ、ヘッダーが無いときに限って付ける(すでにあれば何もしない)
function installCorsHelper() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const fromApp = typeof details.referrer === 'string' && details.referrer.startsWith(ORIGIN);
    if (!fromApp || details.resourceType !== 'xhr') { callback({}); return; }
    const headers = { ...(details.responseHeaders || {}) };
    const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    if (!has('access-control-allow-origin')) headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

// ---- 更新の確認(地図データ・アプリ本体のお知らせ) ----
let checking = false;

// Electron の net.fetch は、OS のプロキシ設定に従う(学校・職場のネットワークでも通りやすい)
const netFetch = (url, init) => net.fetch(url, init);

function box(options) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function reloadApp() {
  await session.defaultSession.clearCache();
  if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
}

async function checkForUpdates({ manual }) {
  if (checking) {
    if (manual) await box({ type: 'info', message: 'いま確認中です。しばらくお待ちください。' });
    return;
  }
  if (!cfg.owner || !cfg.repo) {
    if (manual) {
      await box({
        type: 'info',
        message: '更新元の GitHub リポジトリが設定されていません',
        detail: 'desktop/app-config.json に owner と repo を書いて、アプリを作り直してください。',
      });
    }
    return;
  }
  checking = true;
  const lines = [];
  let content = null;
  let release = null;
  try {
    try {
      content = await syncContent({ cfg, bundledDir, overlayDir, stagingDir, statePath, fetchImpl: netFetch });
      if (content.status === 'updated') {
        const n = content.changed.length;
        lines.push(`地図データ: ${n} 個のファイルを更新しました`);
      } else {
        lines.push('地図データ: 最新です');
      }
    } catch (e) {
      lines.push(`地図データ: 確認できませんでした\n  ${e.message}`);
      console.warn('[update] content:', e.message);
    }
    try {
      release = await checkLatestRelease({ cfg, currentVersion: app.getVersion(), fetchImpl: netFetch });
      if (release.status === 'newer') lines.push(`アプリ本体: 新しいバージョン v${release.latest} があります(いまは v${app.getVersion()})`);
      else if (release.status === 'current') lines.push(`アプリ本体: 最新です(v${app.getVersion()})`);
    } catch (e) {
      console.warn('[update] release:', e.message);
    }
  } finally {
    checking = false;
  }

  const settings = readJsonSafe(settingsPath) || {};
  const newerApp = release && release.status === 'newer' ? release : null;
  const announceApp = newerApp && (manual || settings.notifiedVersion !== newerApp.latest);

  if (content && content.status === 'updated') {
    const buttons = ['今すぐ再読み込み', 'あとで'];
    const r = await box({
      type: 'info',
      buttons,
      defaultId: 0,
      cancelId: 1,
      message: '地図データが更新されました',
      detail: `${lines.join('\n')}\n\n再読み込みすると、新しいデータが表示されます。`,
    });
    if (r.response === 0) await reloadApp();
  }
  if (announceApp) {
    writeJsonSafe(settingsPath, { ...settings, notifiedVersion: newerApp.latest });
    const r = await box({
      type: 'info',
      buttons: ['ダウンロードページを開く', '閉じる'],
      defaultId: 0,
      cancelId: 1,
      message: `アプリの新しいバージョン v${newerApp.latest} があります`,
      detail: `${lines.join('\n')}\n\nインストーラーをダウンロードして、上書きインストールしてください(地図データの更新だけなら、これは不要です)。`,
    });
    if (r.response === 0 && newerApp.url) openExternalSafe(newerApp.url);
  }
  if (manual && !(content && content.status === 'updated') && !announceApp) {
    await box({ type: 'info', message: '更新の確認結果', detail: lines.join('\n') || '確認できませんでした。' });
  }
}

async function resetData() {
  const r = await box({
    type: 'question',
    buttons: ['元に戻す', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: 'GitHub から取得した更新データを破棄しますか?',
    detail: 'アプリに同梱されているデータに戻ります。',
  });
  if (r.response !== 0) return;
  await resetOverlay({ overlayDir, stagingDir, statePath });
  await reloadApp();
}

function showAbout() {
  box({
    type: 'info',
    message: APP_NAME,
    detail: `バージョン ${app.getVersion()}\n${cfg.repoUrl ? `更新元: ${cfg.repoUrl}\n` : ''}`,
  });
}

// ---- メニュー ----
function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { label: `${APP_NAME}について`, click: showAbout },
        { type: 'separator' },
        { role: 'hide', label: `${APP_NAME}を隠す` },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: `${APP_NAME}を終了` },
      ],
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: 'データの更新を確認…', accelerator: 'CmdOrCtrl+Shift+U', click: () => checkForUpdates({ manual: true }) },
        { label: '更新データを破棄して、同梱データに戻す…', click: resetData },
        { label: '更新データの保存場所を開く', click: () => { fs.mkdirSync(overlayDir, { recursive: true }); shell.openPath(overlayDir); } },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'ウィンドウを閉じる' } : { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'forceReload', label: 'キャッシュを無視して再読み込み' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全画面表示' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '開発者ツール' },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        ...(cfg.repoUrl ? [{ label: 'GitHub のリポジトリを開く', click: () => openExternalSafe(cfg.repoUrl) }] : []),
        ...(cfg.publicUrl ? [{ label: '公開ページをブラウザで開く', click: () => openExternalSafe(cfg.publicUrl) }] : []),
        ...(isMac ? [] : [{ type: 'separator' }, { label: `${APP_NAME}について`, click: showAbout }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- 起動 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on('seiyo:get-info', (event) => {
    event.returnValue = { version: app.getVersion(), publicUrl: cfg.publicUrl };
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(() => {
    installProtocol();
    installCorsHelper();
    buildMenu();
    createWindow();
    // 画面が出て、地図画像の読み込みが落ち着いてから、更新を確認する
    setTimeout(() => { checkForUpdates({ manual: false }).catch((e) => console.warn('[update]', e)); }, 4000);

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
