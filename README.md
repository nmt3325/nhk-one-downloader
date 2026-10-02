# nhk-one-downloader

NHK ONE（旧 NHK プラス）の見逃し配信を、**URL と `.wvd` を渡すだけ** で MP4 に保存する CLI。

- 依存パッケージなし（Node 18+ の標準ライブラリのみ）。**pywidevine 不要**——Widevine CDM を Node の `crypto` で実装している
- **Bearer トークンはブラウザ不要で自動発行**（匿名トークン。F12 でコピーする必要がない）
- 映像 + 音声 + 字幕（ARIB 制御記号を整理）を 1 つの MP4 に mux
- 画質 / 副音声の選択、中断後のレジューム、シリーズ一括取得

## 必要なもの

| もの | 補足 |
| --- | --- |
| Node.js 18 以上 | 標準ライブラリのみ使用 |
| ffmpeg | CENC 復号と mux。`--ffmpeg` または `$FFMPEG` でパス指定可 |
| Widevine L3 の `.wvd` | 端末から取得したもの |
| 日本国内の回線 | API / CDN が GeoIP 制御。国外からは 403 |

## クイックスタート

```bash
git clone https://github.com/nmt3325/nhk-one-downloader
cd nhk-one-downloader

# .wvd を一度だけ登録（~/.nhk-one/config.json に保存）
node nhk-dl.js config set-wvd ./device.wvd

# あとは URL を渡すだけ
node nhk-dl.js 'https://www.web.nhk/tv/pl/series-tep-XXXX/ep/YYYYYYYYYY'
```

```
▸ SONGS 80年代名曲集▽20年の歴史から厳選したパフォーマンス!  (2026-10-01)
  1920x1080 (6192 kbps) ・ 音声 main (am192) ・ 字幕 ja
  447/447 セグメント ・ 44:44
  [1/4] 鍵を取得
        コンテンツ鍵 3 件 (映像 KID 一致 / 音声 KID 一致)
  [2/4] 映像
  [3/4] 音声
  [4/4] 復号・結合
✓ 保存しました: ./SONGS 80年代名曲集... (2026-10-01).mp4 (2.1 GB)
```

`npm link`（または `npm i -g .`）すれば `nhk-dl` / `nhk-token` コマンドとして使える。

## 使い方

```bash
# エピソード ID だけでもよい
nhk-dl 35SWR3WU5L

# .wvd をその場で渡す（位置引数で .wvd を認識する）
nhk-dl 35SWR3WU5L ./device.wvd

# メタデータと画質一覧を見る
nhk-dl 35SWR3WU5L --info
nhk-dl 35SWR3WU5L --list

# 720p、副音声、字幕なし、並列 8
nhk-dl 35SWR3WU5L -q 720 --audio sub --no-subtitles -j 8

# 出力先を指定
nhk-dl 35SWR3WU5L -d ~/Movies
nhk-dl 35SWR3WU5L -o ~/Movies/songs.mp4

# シリーズの一覧 → 配信中の全部
nhk-dl 'https://www.web.nhk/pl/series-tep-7QRYY2G3VN'
nhk-dl 'https://www.web.nhk/pl/series-tep-7QRYY2G3VN' --all

# 複数まとめて
nhk-dl 35SWR3WU5L LG67P7LXNN MJ253291K1

# 動作確認（先頭 6 セグメントだけ）
nhk-dl 35SWR3WU5L --max-segments 6 -q worst

# F12 で拾った URL を直接渡してもよい
nhk-dl 'https://archive2.hsk.st.nhk/.../videoinfo-xxxx.json'
nhk-dl 'https://archive2.hsk.st.nhk/.../cenc/manifest_m6000.m3u8'
```

出力名は「シリーズ名 エピソード名 (放送日).mp4」。途中で落とした分は作業ディレクトリに残るので、
`--work-dir` を固定しておけば同じコマンドの再実行でレジュームする。

## 主なオプション

| オプション | 意味 |
| --- | --- |
| `--wvd <path>` | `.wvd` を指定。指定がなければ `$NHK_WVD` → `config.json` → カレント → `~/.nhk-one/` を探す |
| `-o, --output <file>` / `-d, --output-dir <dir>` | 出力先 |
| `-q, --quality <q>` | `best`（既定）/ `worst` / `1080` / `720` / `3000k` |
| `--audio main\|sub` | 副音声は `sub` |
| `--no-subtitles` / `--keep-subtitle-tokens` | 字幕を入れない / ARIB 制御記号を残す |
| `-j, --concurrency <n>` | セグメント並列数（既定 6） |
| `--max-segments <n>` | 先頭 n セグメントだけ（動作確認用） |
| `--info` / `--list` / `-a, --all` | メタデータ / 画質一覧 / シリーズ全件 |
| `--work-dir <dir>` / `--keep-work` | 作業ディレクトリ（既定 `$TMPDIR/nhk-dl/<ID>-<tier>`） |
| `--bearer-token <tok>` / `--no-auto-token` | トークンを明示指定 / 自動発行を止める |
| `--json` / `--quiet` / `--force` | JSON 出力 / 進捗抑制 / 上書き |

環境変数: `NHK_WVD` / `NHK_BEARER_TOKEN` / `FFMPEG` / `NHK_ONE_HOME`（設定ディレクトリ）。

## nhk-token（付随ツール）

通常は `nhk-dl` が自動発行するので使わなくてよい。手動で扱いたいとき用。

```bash
nhk-token              # 匿名トークンを発行して ~/.nhk-one/token.json に保存
nhk-token show         # 有効期限・scope・profileType を表示
nhk-token show -p      # トークン文字列をそのまま出力
nhk-token paste        # 自分のアカウントの z_at / Bearer を登録（stdin も可）
nhk-token clear        # 保存済みトークンを削除
```

エリアは既定で東京。変える場合は `--area 130 --pref 13 --jisx0402 13101 --postal 1000001`。

## 仕組み

1. **匿名トークン**: `consentToUse` クッキーを自分でセットして
   `GET https://www.web.nhk/tix/build_authorize?idp=r-alaz&profileType=anonymous&...` をリダイレクト追跡
   → `z_at`（JWT / `scope: get:news get:tv` / 有効 8 時間）がクッキージャーに入る
2. **メタデータ**: `https://api.web.nhk/r8/t/tvepisode/te/<ID>.json` → `video[].detailedVideoDescriptor`
3. **descriptor**: `manifests[]` の `drm_type: cenc` から最高ビットレートの master m3u8
4. **master m3u8**: RESOLUTION 属性がないので、init セグメントの `encv`（元形式は `frma`）から解像度を読む。
   音声はグループ `l5`(192k) / `l2`(64k) の main / sub、字幕は `subtl/playlist.m3u8`
5. **ライセンス**: init の `pssh` から challenge を組み立てて
   `https://licence.hsk.st.nhk/widevine/license` に POST → コンテンツ鍵
6. **復号**: `tenc` の default_KID に一致する鍵を ffmpeg の `-decryption_key` に渡して結合

Authorization ヘッダは `api.web.nhk` と `licence.hsk.st.nhk` にのみ付ける（CDN に付けると 400）。
詳細は [docs/anonymous-token.md](docs/anonymous-token.md)。

## ファイル構成

```
nhk-dl.js        メイン CLI
nhk-token.js     トークン管理
lib/
  widevine.js    Widevine CDM（protobuf / AES-CMAC / RSA-PSS / 鍵導出）
  auth.js        匿名トークン発行と保存
  license.js     ライセンスサーバー通信
  nhk.js         入力判別 / API / descriptor / 出力名
  hls.js         m3u8 解析、tenc / 解像度のボックス解析
  download.js    並列 DL、レジューム、ffmpeg 復号・mux
  subtitles.js   WebVTT 結合と ARIB トークン整理
  http.js        クッキージャー付き HTTP、リトライ、並列制御
  config.js      ~/.nhk-one の設定と .wvd 解決
  args.js        引数パーサ
```

## つまずいたとき

| メッセージ | 対処 |
| --- | --- |
| `.wvd ファイルが見つかりません` | `nhk-dl config set-wvd <path>` か `--wvd` |
| `ライセンスサーバーが HTTP 401 / 403` | `nhk-token auto` で再発行。国外回線でも起きる |
| `このエピソードには再生可能な映像がありません` | 配信期限切れ（通常放送から約 1 週間） |
| `匿名トークンの発行に失敗` | 日本国内からアクセスしているか確認。`nhk-token paste` で手動登録も可 |
| `ffmpeg が見つかりません` | `brew install ffmpeg` / `apt install ffmpeg` / `winget install Gyan.FFmpeg` |
| セグメントが 403 | CDN に Authorization を付けると落とせない。`-j` を下げて再試行 |

## 調査記録

このリポジトリはもともと NHK ONE の配信・DRM の調査記録。当時の資料はそのまま残してある。

- [docs/anonymous-token.md](docs/anonymous-token.md) — 匿名トークン発行と純 Node 版 CDM の実装メモ
- [docs/research-notes.md](docs/research-notes.md) — 旧 README（Android アプリ解析、Frida 手順、旧スクリプトの使い方）
- [docs/findings.md](docs/findings.md) / [docs/android-app-analysis.md](docs/android-app-analysis.md)
- `scripts/` — 調査当時のスクリプト群。`08-web-decrypt-vod.js` は `nhk-dl` への互換ラッパ
- `evidence/` — 実測した API レスポンス
- `chrome-extension/` — ブラウザ内 CDM の実験（WebCrypto 版。未修正のパッディング問題あり）
