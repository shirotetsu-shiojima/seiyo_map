'use strict';
// 画面(index.html)に渡す、ごく小さな橋渡し。Node.js の機能は渡さない。
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let info = {};
try { info = ipcRenderer.sendSync('seiyo:get-info') || {}; } catch (e) { /* 取れなくても動く */ }

// 画面側から「デスクトップ版で動いているか」を調べたいとき用: window.seiyoDesktop
contextBridge.exposeInMainWorld('seiyoDesktop', Object.freeze({
  isDesktop: true,
  version: String(info.version || ''),
  platform: process.platform,
  publicUrl: String(info.publicUrl || ''),
  fetchLocalApi: (url) => ipcRenderer.invoke('seiyo:fetch-local-api', String(url)),
}));

// 「リンクをコピー」で、app://seiyo/#v=... のような他の人が開けないアドレスがコピーされないよう、
// クリップボードに書く直前に、公開ページ(GitHub Pages)のアドレスへ置き換える
if (info.publicUrl) {
  const base = JSON.stringify(String(info.publicUrl));
  webFrame.executeJavaScript(`(() => {
    try {
      const c = navigator.clipboard;
      if (!c || !c.writeText) return;
      const orig = c.writeText.bind(c);
      const base = ${base};
      c.writeText = (t) => orig(typeof t === 'string' ? t.replace(/^app:\\/\\/seiyo\\/(?:index\\.html)?/, base) : t);
    } catch (e) { /* 置き換えできなくても、コピー自体は動く */ }
  })();`).catch(() => {});
}
