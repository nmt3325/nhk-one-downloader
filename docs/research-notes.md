# NHK ONE / NHKプラス 配信・DRM 調査記録（旧 README）

> ツールの使い方はリポジトリ直下の [README](../README.md) を参照。ここは調査当時の記録。

NHK ONE（旧 NHKプラス）の配信メタデータ、Androidアプリの通信経路、HLS暗号化シグナリングを検証した記録です。

## 結論

| 項目 | 確認結果 |
| --- | --- |
| GeoIP制限 | 日本国外ではアプリが地域制限を表示し、ライブ配信ディスクリプタはHTTP 403。日本経由ではHTTP 200 |
| Androidライブ配信 | G1・G2・E1・E3の`videoinfo.json`と最終HLS URLを確認 |
| Android VOD再生 | コンテンツ固有descriptor、CENC/CBCS HLS、暗号化映像・音声・WebVTT字幕の実再生／取得を確認 |
| 配信形式 | HLS + fragmented MP4（`.m4s`）、AVC/H.264 + AAC |
| Widevine経路 | `cenc`、`SAMPLE-AES-CTR`、Widevine UUID/PSSHを確認 |
| FairPlay経路 | `cbcs`、`SAMPLE-AES`、`com.apple.streamingkeydelivery`を確認 |
| Widevineライセンス先 | `https://licence.hsk.st.nhk/widevine/license` |
| Androidエミュレーター | Widevine L3、CDM `18.0.0@340720000` |

## レポート

- [Androidアプリ静的・動的解析（ライブ配信URL／暗号化）](docs/android-app-analysis.md)
- [Web/VODに関する先行調査](docs/findings.md)
- [ライブ計測結果](evidence/android-live-manifest-summary.json)
- [VOD動的解析結果](evidence/vod-dynamic-analysis.json)

## 再計測

日本国内で正規に利用可能なネットワークから、次を実行します。

```bash
python3 scripts/04-live-manifest-probe.py \
  --output android-live-manifest-summary.json
```

## 暗号化されたままの動画ダウンロード

VODのメディアプレイリストURLを指定すると、initセグメントと`.m4s`セグメントを復号せずそのまま保存できます。`--concat`で連結した単一fMP4（暗号化されたまま）も出力できます。字幕プレイリスト（WebVTT）も同時に取得・1ファイルへ結合できます。

```bash
# 映像（CENC/v1500）を暗号化されたまま取得し、連結fMP4を出力
python3 scripts/05-download-encrypted-vod.py \
  --playlist 'https://archive2.hsk.st.nhk/npd4/.../cenc/v1500/playlist.m3u8' \
  --output out/cenc-v1500 --concat out/cenc-v1500.mp4

# 字幕（WebVTT）も一緒に取得して1ファイルに結合
python3 scripts/05-download-encrypted-vod.py \
  --playlist '<media-playlist-url>' --output out/cenc-v1500 --concat out/cenc-v1500.mp4 \
  --subtitle-playlist '<subtitle-playlist-url>' --concat-subtitles out/subtitles.vtt

# 試験用に先頭数セグメントのみ（字幕も同じ件数に制限）
python3 scripts/05-download-encrypted-vod.py \
  --playlist '<media-playlist-url>' --output out/test --max-segments 2 \
  --subtitle-playlist '<subtitle-playlist-url>' --concat-subtitles out/test.vtt

# マスタープレイリストから全バリアントを一括取得（字幕は自動検出。--no-subtitlesで無効化）
python3 scripts/05-download-encrypted-vod.py \
  --master '<master-playlist-url>' --output out/all
```

字幕URLはマスタープレイリストの`#EXT-X-MEDIA:TYPE=SUBTITLES`の`URI`です。結合後の`.vtt`は先頭に1つの`WEBVTT`ヘッダーを持ち、各セグメントの`X-TIMESTAMP-MAP`を保持します。

出力は`ftyp`/`encv`/`schm=cenc`/`tenc`/`pssh`を含む暗号化fMP4であり、メディアセグメントは`styp`/`moof`/`senc`構造のままです（復号は行いません）。

## WVDファイルを使った復号ダウンロード

Widevine L3 CDMデバイスファイル（`.wvd`）とBearerトークンがあれば、暗号化セグメントをダウンロードして復号し、再生可能なMP4を出力できます。

```bash
pip install pywidevine  # 必須

# 番組ページURLから自動解決してダウンロード＋復号
python3 scripts/06-decrypt-vod.py \
  --url 'https://www.web.nhk/tv/pl/series-tep-XXXX/ep/YYYY' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output output.mp4

# descriptor URLを直接指定
python3 scripts/06-decrypt-vod.py \
  --descriptor-url 'https://archive2.hsk.st.nhk/npd4/.../videoinfo-XXX.json' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output output.mp4

# マスタープレイリストから自動選択してダウンロード＋復号
python3 scripts/06-decrypt-vod.py \
  --master '<master-playlist-url>' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output output.mp4

# 映像・音声プレイリストを個別指定
python3 scripts/06-decrypt-vod.py \
  --video-playlist '<video-playlist-url>' \
  --audio-playlist '<audio-playlist-url>' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output output.mp4

# 字幕も一緒に取得してMP4へ mux
python3 scripts/06-decrypt-vod.py \
  --master '<master-playlist-url>' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output output.mp4 \
  --concat-subtitles subtitles.vtt

# 番組中盤のセグメントを取得（先頭200セグメントをスキップ）
python3 scripts/06-decrypt-vod.py \
  --master '<master-playlist-url>' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output test.mp4 \
  --skip-segments 200 --max-segments 3

# テスト用に先頭3セグメントのみ
python3 scripts/06-decrypt-vod.py \
  --master '<master-playlist-url>' \
  --wvd device.wvd \
  --bearer-token '<token>' \
  --output test.mp4 \
  --max-segments 3
```

### bearer-tokenの取得方法

`--bearer-token`にはNHK ONEアプリが発行するアクセストークン（JWT）を指定します。匿名アカウントでも発行されます。有効期限は約8時間です。

**方法: Fridaで実行中のアプリから取得**

```bash
# アプリを起動した状態で、Fridaでトークンを抽出
frida -U -p <nhk_app_pid> --runtime=v8 -l scripts/07-extract-token.js

# またはアプリをspawnする場合
frida -U -f nhk.app.tep --runtime=v8 -l scripts/07-extract-token.js
```

出力される `Bearer eyJ...` 形式の文字列をそのまま `--bearer-token` に渡してください（`Bearer ` プレフィックスも含めて指定可能です）。

**方法: ブラウザのDevToolsコンソールから取得（Web版・最も簡単）**

1. ChromeでNHK ONEのエピソードページを開き、再生ボタンを押す
2. F12 → Console タブを開き、`scripts/09-get-token-console.js` の内容を全てペーストして Enter
   （初回は「allow pasting」と入力してペーストを許可）
3. `Bearer eyJ...` がクリップボードにコピーされ、有効期限も表示される

トークンはHttpOnlyでない `z_at` Cookieに格納されているため、`document.cookie`から直接読めます。手動で取る場合: Network タブで `api.web.nhk` へのリクエストの Request Headers にある `Authorization: Bearer eyJ...` をコピー、または Application → Cookies → `z_at` の値を使用。

### 入力ソースの解決フロー

1. **`--url`**: 番組ページURLからエピソードIDを抽出し、`api.web.nhk/r8/t/tvepisode/te/{id}.json`でエピソード情報を取得。`video[0].detailedVideoDescriptor`からdescriptor URLを取得する。このフィールドは認証が必要な場合がある
2. **`--descriptor-url`**: video descriptor JSONを直接指定。`manifests[]`から最適なCENC manifestを自動選択
3. **`--master`**: HLSマスタープレイリストを直接指定。最高ビットレートの映像・主音声・字幕を自動検出
4. **`--video-playlist` + `--audio-playlist`**: メディアプレイリストを個別指定

フロー: initセグメントからWidevine PSSHを抽出 → pywidevineでライセンスチャレンジを生成 → NHKのライセンスサーバーへPOST → 鍵を取得 → FFmpegの`-decryption_key`で復号・映像音声をマージ。`--master`指定時は映像・音声・字幕プレイリストを自動検出します。

字幕はARIB STD-B24由来の制御トークン（`[CS]`, `[COL_4]`, `[APS_x_y]`等）を自動で除去・改行変換し、0秒起点にリベースしてmuxします（VLC等でそのまま表示可能）。生の制御トークンを保持したい場合は`--keep-subtitle-tokens`を指定してください。

デフォルトではプレーンテキスト字幕（制御トークン除去・0秒起点リベース済み）がMP4に埋め込まれます。位置・色・サイズを保持したASS字幕（`<output名>.ass`）が必要な場合は`--ass`を指定してください（実TS抜きツールのCaption2Assやarib-ts2assと同じ手法。VLCは同名の`.ass`を自動で読み込みます）。

## Web版スクリプト（Playwright不要の純CLI）

`scripts/08-web-decrypt-vod.js`は`06-decrypt-vod.py`のWeb版で、AndroidエミュレーターやFridaなしで動作します。Node.jsの標準ライブラリのみ使用（npm install不要）。BearerトークンはブラウザのF12から手動取得します。

```bash
# エピソードURLから自動解決してダウンロード＋復号
node scripts/08-web-decrypt-vod.js \
  --url 'https://www.web.nhk/tv/pl/series-tep-XXX/ep/YYY' \
  --bearer-token 'eyJ...' \
  --wvd device.wvd --output output.mp4

# F12でコピーしたマスタープレイリストURLを直接指定
node scripts/08-web-decrypt-vod.js \
  --master 'https://archive2.hsk.st.nhk/.../cenc/manifest_m6000.m3u8' \
  --bearer-token 'eyJ...' --wvd device.wvd --output output.mp4

# ダウンロードのみ（復号しない場合はトークン不要）
node scripts/08-web-decrypt-vod.js \
  --master 'https://archive2.hsk.st.nhk/.../cenc/manifest_m6000.m3u8' \
  --max-segments 3
```

認証まわりの仕様（2026-08-26時点の実測）:

- `api.web.nhk`: 有効なBearerトークン付きでのみ`detailedVideoDescriptor`フィールドを返す（認証なしでも200だが同フィールドなし）
- CDN（`archive2.hsk.st.nhk`）: セグメント・マニフェストは認証なしで配信される。無効なトークンを送ると400で拒否されるため、CDNリクエストにはAuthorizationを付けない
- ライセンスサーバー（`licence.hsk.st.nhk`）: Bearerトークン必須


## 注意

- URLやAPI構造は検証時点（2026-08-26）のものです。
- 配信の利用はサービスの利用条件、権利、地域制限に従ってください。
