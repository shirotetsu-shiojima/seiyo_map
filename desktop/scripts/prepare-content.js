'use strict';
// アプリに同梱する「地図サイトのファイル」を、リポジトリ直下から desktop/content/ にコピーする。
// あわせて、どの GitHub リポジトリから更新を取るかを build-info.json に書く。
//
//   npm run prepare-content      (npm start / npm run dist の前に自動で実行されます)

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { isIgnored } = require('../lib/ignore');

const desktopDir = path.resolve(__dirname, '..');
const siteDir = path.resolve(desktopDir, '..');          // リポジトリ直下(index.html がある場所)
const outDir = path.join(desktopDir, 'content');
const config = JSON.parse(fs.readFileSync(path.join(desktopDir, 'app-config.json'), 'utf8'));

if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
  console.error(`index.html が見つかりません: ${siteDir}\n` +
    'desktop フォルダを、地図サイトのリポジトリ直下(index.html と同じ階層)に置いてください。');
  process.exit(1);
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: siteDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { return ''; }
}

// 更新元の GitHub リポジトリを決める(Actions の環境変数 → git の remote の順)
function detectRepo() {
  let owner = '';
  let repo = '';
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes('/')) {
    [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  } else {
    const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(git('config --get remote.origin.url'));
    if (m) [, owner, repo] = m;
  }
  const branch = process.env.DEFAULT_BRANCH || git('rev-parse --abbrev-ref HEAD').replace(/^HEAD$/, '') || 'main';
  return { owner, repo, branch };
}

const detected = detectRepo();
const info = {
  owner: config.owner || detected.owner,
  repo: config.repo || detected.repo,
  branch: config.branch || detected.branch || 'main',
};

fs.rmSync(outDir, { recursive: true, force: true });
let count = 0;
let bytes = 0;
(function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (isIgnored(`${r}/`, config.ignore)) continue;
      walk(path.join(dir, ent.name), r);
    } else if (ent.isFile()) {
      if (isIgnored(r, config.ignore)) continue;
      const dest = path.join(outDir, ...r.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(dir, ent.name), dest);
      count += 1;
      bytes += fs.statSync(dest).size;
    }
  }
})(siteDir, '');

fs.writeFileSync(path.join(desktopDir, 'build-info.json'), JSON.stringify({ ...info, builtAt: new Date().toISOString() }, null, 2));

console.log(`同梱ファイル: ${count} 個 / ${(bytes / 1024 / 1024).toFixed(1)} MB → ${path.relative(process.cwd(), outDir) || outDir}`);
console.log(info.owner && info.repo
  ? `更新元: github.com/${info.owner}/${info.repo} (${info.branch})`
  : '更新元の GitHub リポジトリを特定できませんでした(自動更新は無効になります)。desktop/app-config.json に owner と repo を書くと有効になります。');
