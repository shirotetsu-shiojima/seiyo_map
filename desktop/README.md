# 星陽マップ デスクトップ版(Windows / Mac)

ブラウザを使わずに開ける、星陽マップのアプリ版です。作りは [Electron](https://www.electronjs.org/) で、
いまのサイト(`index.html` と各データ)をそのまま包んでいます。**サイト側のコードは書き換えていません。**

## できること

- Windows(.exe インストーラー)と Mac(.dmg。Apple シリコン用と Intel 用)で、ふつうのアプリとして起動
- 地図データ・画像・`index.html` を**アプリに同梱**(オフラインでも起動します)
- 起動のたびに GitHub を確認し、**変わったファイルだけ**をダウンロードして更新(メニュー「ファイル → データの更新を確認」でも手動で確認可)
- 「リンクをコピー」は、他の人が開ける GitHub Pages のアドレスでコピーされます

## 作り方(手元に Node.js は不要。GitHub が作ってくれます)

1. この zip の **`desktop` フォルダ** と **`.github` フォルダ** を、リポジトリの直下(`index.html` と同じ場所)に入れて、コミット → プッシュ
2. GitHub のリポジトリ → **Actions** → **desktop-release** → **Run workflow**(試しのビルド)
   - 10〜15 分ほどで、実行結果ページの **Artifacts** に Windows 用と Mac 用ができます
3. 配るときは、バージョン名のタグを付けてプッシュ
   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```
   → **Releases** に `.exe` と `.dmg` が自動で公開されます

> `desktop` を置いても、GitHub Pages の公開には影響しません(`desktop` の中身は更新対象・同梱対象から外してあります)。

## はじめて開くときの警告(署名なしのため)

| OS | 表示 | 開き方 |
|---|---|---|
| Windows | 「WindowsによってPCが保護されました」 | **詳細情報 → 実行** |
| Mac | 「開発元を検証できません」など | システム設定 → プライバシーとセキュリティ → **このまま開く**(OS のバージョンで手順が少し違います)。ターミナルなら `xattr -dr com.apple.quarantine /Applications/星陽マップ.app` |

一度開けば、次からは出ません。警告を無くすには、Apple Developer Program(有料)/ Windows のコード署名証明書(有料)が必要です。

## 更新のしくみ

- アプリの中身は 2 層です。**アプリ本体(Electron)** と **サイトのファイル(index.html・データ・画像)** で、更新されるのは後者です
- Windows は起動 4 秒後、Mac はメニューから手動で更新確認したときに GitHub の **ファイル一覧(Git Trees API)** を 1 回取得し、手元のファイルと**内容のハッシュ**を比べ、違うものだけを `raw.githubusercontent.com` からダウンロードします。ダウンロードした中身もハッシュで検証します(Mac の起動直後のクラッシュを避けるため、自動確認は行いません)
- 全ファイルがそろったときだけ差し替えます(途中で失敗しても、古いデータのまま壊れません)
- 更新データの置き場所: Windows `%APPDATA%\seiyo-map\content`、Mac `~/Library/Application Support/seiyo-map/content`
  (メニュー「ファイル → 更新データの保存場所を開く」で開けます。「同梱データに戻す」で破棄もできます)
- **アプリ本体の新バージョン**(Releases に新しいタグ)があるときは、お知らせだけ出します。入れ替えは、新しいインストーラーを手動で上書きインストールしてください

### 制限

- **公開リポジトリ**のみ対応です(非公開だと、ログインなしでは取れません)
- 未ログインの GitHub API は **1 時間 60 回 / IP** まで。通常は 1 回の確認で 1 回しか使わず、変更が無いときの応答(304)は回数に数えられません
- `index.html` も更新対象です。HTML を直せば、アプリ版にも次回の更新で反映されます(アプリ本体の作り直しは不要)
- 更新を止めたいファイルは、`app-config.json` の `ignore` に書きます

## 設定(`app-config.json`)

ふつうは**触らなくて大丈夫**です。更新元のリポジトリは、ビルドしたリポジトリから自動で決まります。

| 項目 | 意味 |
|---|---|
| `owner` / `repo` / `branch` | 更新元。空なら自動。別のリポジトリを見たいときだけ書く |
| `publicUrl` | 「リンクをコピー」で使うアドレス。空なら `https://<owner>.github.io/<repo>/`。独自ドメインのときは書く |
| `ignore` | アプリに同梱・同期しないファイル |

## 手元で試す・作る(Node.js 22 以上)

```
cd desktop
npm install
npm test           # 更新ロジックのテスト
npm start          # アプリを起動(リポジトリ直下のファイルを同梱して起動)
npm run dist:win   # Windows 用(Windows 上で)
npm run dist:mac   # Mac 用(Mac 上で)
```

## 知っておくこと

- Google Fonts(Zen Kaku Gothic New)は今までどおりネットから読みます。オフラインでは OS の日本語フォントで表示されます
- 列車の位置と時刻表(`http://localhost:8765/api/...`)は、アプリ版では Electron のメインプロセス経由で取得します。Chromium の CORS / ローカルネットワーク許可に左右されず、`localhost` の列車 API と時刻表 API だけに接続します
- アイコンは仮のものです。差し替えるときは `desktop/build/icon.png`(1024×1024 の PNG)を置き換えてください
